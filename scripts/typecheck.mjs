#!/usr/bin/env node
// Type-check the plugin: `tsc --noEmit -p <repository>`. The repository root is the plugin package.
// With no .ts/.tsx files yet it passes with a note (tsc itself would fail with TS18003).
// Sources without a tsconfig.json fail.
//
// Usage: node scripts/typecheck.mjs [--root <repository>]
// Exit: 0 clean, 1 type errors or a missing tsconfig.json, 2 setup problem.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKIP_DIRS = new Set(["node_modules", ".git"]);

export function parseArgs(argv) {
  const options = { root: DEFAULT_ROOT };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--root" && argv[i + 1]) options.root = resolve(argv[(i += 1)]);
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  return options;
}

/** TypeScript source files under a folder (declaration files included), skipping node_modules and .git. */
export function typeScriptFiles(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(ts|tsx|mts|cts)$/.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((path) => !path.slice(dir.length).split(/[\\/]/).some((part) => SKIP_DIRS.has(part)));
}

function tscPath(root) {
  try {
    return createRequire(join(root, "package.json")).resolve("typescript/bin/tsc");
  } catch {
    throw new Error("typescript is not installed; run npm install");
  }
}

export function run({ root }) {
  const files = typeScriptFiles(root);
  if (files.length === 0) return { ok: true, note: "no TypeScript sources yet, nothing to check" };
  if (!existsSync(join(root, "tsconfig.json"))) return { ok: false, note: `${files.length} TypeScript file(s) but no tsconfig.json` };
  const out = spawnSync(process.execPath, [tscPath(root), "--noEmit", "-p", root], { cwd: root, encoding: "utf8" });
  return { ok: out.status === 0, note: `${files.length} file(s)`, output: `${out.stdout ?? ""}${out.stderr ?? ""}`.trim() };
}

function main() {
  let result;
  try {
    result = run(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(`typecheck: ${error.message}`);
    return 2;
  }
  console.log(`typecheck: ${result.ok ? "ok" : "FAILED"} (${result.note})`);
  if (result.output) console.log(result.output);
  return result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
