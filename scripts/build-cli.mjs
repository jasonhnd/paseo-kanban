#!/usr/bin/env node
// Bundle command entries as ESM for Node, with the pinned public SDK supplied by dependencies.
// No runtime TypeScript loader or development dependency is needed in an unpacked npm package.
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const ENTRIES = ["cli", "local-decisions", "migrate", "check-missing-cwd"];
export const FLEET_ENTRIES = { roles: "server/roles-cli.ts", doctor: "server/doctor-cli.ts", migrate: "server/migrate-command.ts", coupon: "bin/coupon.ts" };

export const COMBINED_ENTRIES = { ...Object.fromEntries(ENTRIES.map(name => [name, `server/${name}.ts`])), "fleet-roles": "server/fleet/roles-cli.ts", "fleet-doctor": "server/fleet/doctor-cli.ts", "fleet-coupon": "server/fleet/coupon-cli.ts", "fleet-leader": "server/fleet/leader-cli.ts" };

export async function buildCli(root = ROOT) {
  root = realpathSync(root);
  const fleet = existsSync(join(root, FLEET_ENTRIES.roles));
  const combined = existsSync(join(root, COMBINED_ENTRIES["fleet-roles"]));
  const sources = combined ? COMBINED_ENTRIES : fleet ? FLEET_ENTRIES : Object.fromEntries(ENTRIES.map(name => [name, `server/${name}.ts`]));
  const present = Object.keys(sources).filter(name => existsSync(join(root, sources[name])));
  if (!fleet && !present.includes("cli")) {
    console.error("build:cli: no command sources yet, nothing to build");
    return;
  }
  if (present.length !== Object.keys(sources).length) throw new Error("incomplete CLI source set");
  // Build in memory so a failed compilation cannot leave a partially updated bundle set.
  const results = await Promise.all(Object.entries(sources).map(([name, source]) => build({
    absWorkingDir: root,
    entryPoints: [join(root, source)],
    outfile: join(root, "bin", `${name}.bundle.mjs`),
    // Keep policy literals at their canonical package path: public approvals are bound to exact source lines.
    external: ["@getpaseo/client", "@getpaseo/protocol", "@getpaseo/relay", "../shared/privacy-rules.mjs"],
    minifyIdentifiers: true,
    minifyWhitespace: true,
    legalComments: "none",
    bundle: true, platform: "node", format: "esm", target: "node22.5", write: false,
    // Bundling gives every module the command's import.meta.url. Disable command-only
    // guards in imported modules, otherwise importing one CLI can run another CLI's main.
    plugins: [{ name: "entry-guards", setup(builder) {
      builder.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, args => {
        const text = readFileSync(args.path, "utf8");
        // Zod's named namespace alias retains every export in esbuild, including unused
        // locales and JSON converters. A real namespace import preserves static member
        // access and lets the bundler omit unused library code, including in host types.
        let contents = text.replace(/import\s*\{\s*z\s*\}\s*from\s*(["'])zod\1/g, 'import * as z from "zod"');
        if (args.path !== join(root, source) && args.path.startsWith(join(root, "server") + sep)) {
          contents = contents.replace(/if\s*\(\s*import\.meta\.url\s*===\s*invoked\s*\)/g, "if (false)");
        }
        if (contents === text) return;
        return { contents, loader: /\.tsx?$/.test(args.path) ? (args.path.endsWith(".tsx") ? "tsx" : "ts") : "js" };
      });
    } }],
    // Bundled CommonJS dependencies may use require() for Node built-ins.
    banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
  })));
  mkdirSync(join(root, "bin"), { recursive: true });
  for (const result of results) for (const file of result.outputFiles) writeFileSync(file.path, file.contents);
  console.error(`build:cli: ${results.length} standalone Node bundles`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await buildCli(); }
  catch (error) { console.error(`build:cli: ${error.message}`); process.exitCode = 1; }
}
