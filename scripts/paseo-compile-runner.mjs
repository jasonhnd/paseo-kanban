#!/usr/bin/env node
// Child process of `scripts/paseo-build-check.mjs`: compile one plugin with Paseo's own plugin
// compiler, exactly as the daemon does on load and reload.
//
// Usage: paseo-compile-runner.mjs <compiler.js> <plugin-dir> <out-dir>
//
// When the compiler lives inside the desktop app's app.asar, this file must be run by the app's
// Electron binary with ELECTRON_RUN_AS_NODE=1: only Electron can import modules from an asar
// archive. Prints one JSON line on success; any compile error goes to stderr with exit code 1.
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

// Same entry names the daemon looks for (plugins/runtime.js, resolveEntryPaths).
const CLIENT_ENTRIES = ["index.client.ts", "index.client.tsx"];
const SERVER_ENTRIES = ["index.server.ts", "index.server.tsx"];

const findEntry = (dir, names) => names.map((name) => join(dir, name)).find((file) => existsSync(file)) ?? null;

/** Version of the @getpaseo/server package that ships the compiler, or null. */
async function serverPackageVersion(compilerPath) {
  for (let dir = dirname(compilerPath); dirname(dir) !== dir; dir = dirname(dir)) {
    const manifest = join(dir, "package.json");
    if (!existsSync(manifest)) continue;
    try {
      const pkg = JSON.parse(await readFile(manifest, "utf8"));
      if (pkg.name === "@getpaseo/server") return pkg.version ?? null;
    } catch {
      return null;
    }
  }
  return null;
}

async function main() {
  const [compilerPath, pluginDir, outDir] = process.argv.slice(2);
  if (!compilerPath || !pluginDir || !outDir) {
    process.stderr.write("usage: paseo-compile-runner.mjs <compiler.js> <plugin-dir> <out-dir>\n");
    return 2;
  }
  const entries = { client: findEntry(pluginDir, CLIENT_ENTRIES), server: findEntry(pluginDir, SERVER_ENTRIES) };
  if (!entries.client && !entries.server) {
    process.stderr.write(`no plugin entry (index.client.ts[x] / index.server.ts[x]) in ${pluginDir}\n`);
    return 1;
  }
  const { compilePlugin } = await import(pathToFileURL(compilerPath).href);
  const { clientBundle, serverBundle } = await compilePlugin(entries);
  await mkdir(outDir, { recursive: true });
  const bundles = {};
  for (const [target, code] of [["client", clientBundle], ["server", serverBundle]]) {
    if (code === null || code === undefined) continue;
    await writeFile(join(outDir, `${target}.bundle.js`), code);
    bundles[target] = Buffer.byteLength(code);
  }
  const paseoServer = await serverPackageVersion(compilerPath);
  process.stdout.write(`${JSON.stringify({ ok: true, paseoServer, bundles })}\n`);
  return 0;
}

main().then(
  (code) => { process.exitCode = code; },
  (error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
