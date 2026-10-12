#!/usr/bin/env node
// Run the plugin's own tests: every *.test.ts and *.test.tsx under client/, server/, shared/ and test/.
// With no plugin tests yet it passes with a note.
//
// Usage: node scripts/test-plugin.mjs [--root <repository>]
// Exit: the node --test exit code, 0 when there is nothing to run, 2 setup problem.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const TEST_DIRS = ["client", "server", "shared", "test"];
const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function parseArgs(argv) {
  const options = { root: DEFAULT_ROOT };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--root" && argv[i + 1]) options.root = resolve(argv[(i += 1)]);
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  return options;
}

/** Repository-relative test files, sorted; node_modules is skipped. */
export function pluginTests(root) {
  const files = [];
  for (const dir of TEST_DIRS) {
    const base = join(root, dir);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !/\.test\.tsx?$/.test(entry.name)) continue;
      const path = relative(root, join(entry.parentPath, entry.name)).split(sep);
      if (!path.includes("node_modules")) files.push(path.join("/"));
    }
  }
  return files.sort();
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`test-plugin: ${error.message}`);
    return 2;
  }
  const files = pluginTests(options.root);
  if (files.length === 0) {
    console.log("test-plugin: no plugin tests yet, nothing to run");
    return 0;
  }
  console.log(`test-plugin: ${files.length} test file(s)`);
  const phasesHelper = join(options.root, "test/helpers/test-phases.mjs");
  const tmpHelper = join(options.root, "test/helpers/test-tmp.mjs");
  // Preserve the imported suite's required performance files, preload, signal handling,
  // and private temporary/data directories. Include tests from every public source directory.
  if (existsSync(phasesHelper) && existsSync(tmpHelper)) {
    const { testPhases } = await import(pathToFileURL(phasesHelper).href);
    const { runPhasesInPrivateTmp } = await import(pathToFileURL(tmpHelper).href);
    const phases = testPhases();
    const included = new Set(phases.flatMap(([, ...paths]) => paths.map(path => resolve(options.root, path))));
    phases[0].push(...files.map(path => resolve(options.root, path)).filter(path => !included.has(path)));
    delete process.env.NODE_TEST_CONTEXT;
    return runPhasesInPrivateTmp(phases, { cwd: options.root, logPrefix: "test-plugin" });
  }
  // A parent node --test (this script's own tests) sets NODE_TEST_CONTEXT; the child must report on its own.
  const { NODE_TEST_CONTEXT: _parent, ...env } = process.env;
  const out = spawnSync(process.execPath, ["--import", createRequire(join(DEFAULT_ROOT, "package.json")).resolve("tsx"), "--test", ...files], { cwd: options.root, env, stdio: ["ignore", "inherit", "inherit"] });
  return out.status ?? 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
