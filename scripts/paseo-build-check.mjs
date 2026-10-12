#!/usr/bin/env node
// `npm run build:check` (also the first step of `npm run compat`): compile this plugin with the
// plugin compiler of the locally installed Paseo, the same code the daemon runs on load and
// reload. It catches what tsc and the static tests cannot, e.g. a node: import anywhere under
// shared/ ("Node module cannot be imported into the plugin shared bundle").
//
// Usage: node scripts/paseo-build-check.mjs [--plugin <dir>] [--keep] [--strict]
//   --plugin  plugin directory to compile (default: this repository)
//   --keep    keep the compiled bundles in the temporary output directory
//   --strict  exit 2 when no compiler is found (default: report SKIPPED and exit 0)
//
// Compiler lookup, first hit wins:
//   1. PASEO_PLUGIN_COMPILER: path to compiler.js (inside app.asar is fine)
//   2. node_modules/@getpaseo/server of the plugin
//   3. PASEO_SERVER_DIR: an explicitly installed standalone @getpaseo/server package
//   4. the desktop app: PASEO_APP (a Paseo.app or resources directory), the `paseo` command on
//      PATH, then the standard install locations
// A compiler inside app.asar runs under the app's own Electron binary (ELECTRON_RUN_AS_NODE=1),
// because plain Node cannot import from an asar archive.
import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDir, "..");
const RUNNER = join(scriptDir, "paseo-compile-runner.mjs");
const COMPILE_TIMEOUT_MS = 180_000;

/** Path of the compiler inside an installed @getpaseo/server package (0.11.x layout). */
export const COMPILER_IN_PACKAGE = ["@getpaseo", "server", "dist", "server", "server", "plugins", "compiler.js"];

/** Resources directory of a desktop install, given a Paseo.app bundle or the resources directory itself. */
function resourcesDirOf(appPath, exists) {
  const macResources = join(appPath, "Contents", "Resources");
  return exists(join(macResources, "app.asar")) ? macResources : appPath;
}

/** Electron binary that can run Node scripts for the desktop install whose resources directory is given. */
export function appRuntime(resources, platform = process.platform, exists = existsSync) {
  const candidates = platform === "darwin"
    ? [join(resources, "..", "Frameworks", "Paseo Helper.app", "Contents", "MacOS", "Paseo Helper")]
    : [join(resources, "..", "Paseo.bin"), join(resources, "..", "Paseo"), join(resources, "..", "Paseo.exe")];
  return candidates.find((file) => exists(file)) ?? null;
}

/** Resources directory of the app that owns `paseo` on PATH (the CLI ships as <resources>/bin/paseo). */
function resourcesFromPath(env, exists) {
  for (const dir of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const command = join(dir, "paseo");
    if (!exists(command)) continue;
    try {
      return dirname(dirname(realpathSync(command)));
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Find a Paseo plugin compiler. Returns { compiler, command, env, source } to run it, or
 * { skip } with every place that was tried.
 */
export function locateCompiler({ pluginDir = root, env = process.env, home = homedir(), platform = process.platform, exists = existsSync } = {}) {
  const tried = [];
  const viaApp = (resources, source) => {
    const asar = join(resources, "app.asar");
    tried.push(`${source}: ${asar}`);
    if (!exists(asar)) return null;
    const command = appRuntime(resources, platform, exists);
    if (!command) {
      tried.push(`${source}: no Electron runtime next to ${resources}`);
      return null;
    }
    return { compiler: join(asar, "node_modules", ...COMPILER_IN_PACKAGE), command, env: { ELECTRON_RUN_AS_NODE: "1" }, source };
  };

  const explicit = env.PASEO_PLUGIN_COMPILER?.trim();
  if (explicit) {
    const marker = `app.asar${explicit.includes("\\") ? "\\" : "/"}`;
    const at = explicit.indexOf(marker);
    if (at !== -1) {
      const found = viaApp(explicit.slice(0, at - 1), "PASEO_PLUGIN_COMPILER");
      if (found) return { ...found, compiler: explicit };
    } else if (exists(explicit)) {
      return { compiler: explicit, command: process.execPath, env: {}, source: "PASEO_PLUGIN_COMPILER" };
    } else tried.push(`PASEO_PLUGIN_COMPILER: ${explicit}`);
    return { skip: `PASEO_PLUGIN_COMPILER is set but unusable (${tried.join("; ")})` };
  }

  const local = join(pluginDir, "node_modules", ...COMPILER_IN_PACKAGE);
  tried.push(`node_modules: ${local}`);
  if (exists(local)) return { compiler: local, command: process.execPath, env: {}, source: "node_modules" };

  // The standalone Node server is supported on Linux; it need not live in an Electron app.
  if (env.PASEO_SERVER_DIR?.trim()) {
    const compiler = join(env.PASEO_SERVER_DIR.trim(), ...COMPILER_IN_PACKAGE.slice(2));
    tried.push(`PASEO_SERVER_DIR: ${compiler}`);
    if (exists(compiler)) return { compiler, command: process.execPath, env: {}, source: "PASEO_SERVER_DIR" };
    return { skip: `PASEO_SERVER_DIR is set but unusable (${tried.join("; ")})` };
  }

  const apps = [];
  if (env.PASEO_APP?.trim()) apps.push([resourcesDirOf(env.PASEO_APP.trim(), exists), "PASEO_APP"]);
  const fromPath = resourcesFromPath(env, exists);
  if (fromPath) apps.push([fromPath, "paseo on PATH"]);
  if (platform === "darwin") {
    apps.push([resourcesDirOf("/Applications/Paseo.app", exists), "/Applications"]);
    apps.push([resourcesDirOf(join(home, "Applications", "Paseo.app"), exists), "~/Applications"]);
  }
  for (const [resources, source] of apps) {
    const found = viaApp(resources, source);
    if (found) return found;
  }
  return { skip: `no Paseo plugin compiler found (tried ${tried.join("; ")})` };
}

function parseArgs(argv) {
  const options = { pluginDir: root, keep: false, strict: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--keep") options.keep = true;
    else if (arg === "--strict") options.strict = true;
    else if (arg === "--plugin" && argv[index + 1]) options.pluginDir = resolve(argv[(index += 1)]);
    else throw new Error(`unknown argument ${arg}`);
  }
  return options;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`build:check: ${error.message}\n`);
    return 2;
  }
  if (!["index.client.ts", "index.client.tsx", "index.server.ts", "index.server.tsx"].some(name => existsSync(join(options.pluginDir, name)))) {
    console.log("build:check: no plugin entries yet, nothing to compile");
    return 0;
  }
  const found = locateCompiler({ pluginDir: options.pluginDir });
  if (found.skip) {
    process.stdout.write(`build:check SKIPPED (not a pass): ${found.skip}\n`);
    return options.strict ? 2 : 0;
  }
  const outDir = await mkdtemp(join(tmpdir(), "paseo-build-check-"));
  try {
    process.stdout.write(`build:check: compiling ${options.pluginDir} with ${found.compiler} (${found.source})\n`);
    const result = spawnSync(found.command, [RUNNER, found.compiler, options.pluginDir, outDir], {
      cwd: options.pluginDir,
      env: { ...process.env, ...found.env },
      encoding: "utf8",
      timeout: COMPILE_TIMEOUT_MS,
    });
    if (result.error) {
      process.stdout.write(`build:check FAILED: could not run the compiler: ${result.error.message}\n`);
      return 1;
    }
    if (result.status !== 0) {
      const detail = `${result.stderr ?? ""}${result.stdout ?? ""}`.trim() || `exit ${result.status ?? result.signal}`;
      process.stdout.write(`build:check FAILED: Paseo could not compile the plugin:\n${detail}\n`);
      return 1;
    }
    const report = JSON.parse(result.stdout.trim().split("\n").pop());
    const sizes = Object.entries(report.bundles).map(([target, bytes]) => `${target} ${bytes} bytes`).join(", ");
    process.stdout.write(`build:check passed: @getpaseo/server ${report.paseoServer ?? "unknown"} compiled ${sizes}` +
      (options.keep ? `; bundles in ${outDir}\n` : "\n"));
    return 0;
  } finally {
    if (!options.keep) await rm(outDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
