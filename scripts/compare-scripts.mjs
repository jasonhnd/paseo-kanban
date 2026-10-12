#!/usr/bin/env node
// The two plugin repositories (paseo-fleet and paseo-kanban) carry the same gates byte for byte: every file
// under scripts/, .githooks/ and .github/workflows/. This compares them with the sibling repository's copy.
//
// Usage: node scripts/compare-scripts.mjs [--sibling <repository>] [--root <repository>]
//   --sibling   the other repository's checkout (default $PASEO_FLEET_SIBLING). Without one there is nothing
//               to compare and the check passes with a note.
// Exit: 0 identical (or no sibling), 1 differences, 2 setup problem.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const SHARED_DIRS = ["scripts", ".githooks", ".github/workflows"];
const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function parseArgs(argv, env = process.env) {
  const options = { root: DEFAULT_ROOT, sibling: env.PASEO_FLEET_SIBLING?.trim() || null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if ((arg === "--sibling" || arg === "--root") && argv[i + 1]) options[arg.slice(2)] = argv[(i += 1)];
    else throw new Error(`unknown argument ${arg}`);
  }
  options.root = resolve(options.root);
  if (options.sibling) options.sibling = resolve(options.sibling);
  return options;
}

/** { path: sha256 } for every file in the shared folders of one repository. */
export function sharedFiles(root) {
  const hashes = {};
  for (const dir of SHARED_DIRS) {
    const base = join(root, dir);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const path = join(entry.parentPath, entry.name);
      hashes[relative(root, path).split(sep).join("/")] = createHash("sha256").update(readFileSync(path)).digest("hex");
    }
  }
  return hashes;
}

/** Lines for every file that is missing on one side or differs. */
export function compareTrees(here, there) {
  const lines = [];
  for (const file of [...new Set([...Object.keys(here), ...Object.keys(there)])].sort()) {
    if (!(file in there)) lines.push(`only here     ${file}`);
    else if (!(file in here)) lines.push(`only sibling  ${file}`);
    else if (here[file] !== there[file]) lines.push(`differs       ${file}`);
  }
  return lines;
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
    if (!options.sibling) throw new Error("a public sibling source is required (--sibling or PASEO_FLEET_SIBLING); no comparison was performed");
    if (!existsSync(join(options.sibling, "scripts", "compare-scripts.mjs"))) throw new Error(`${options.sibling} has no scripts/compare-scripts.mjs`);
  } catch (error) {
    console.error(`compare-scripts: ${error.message}`);
    return 2;
  }
  const here = sharedFiles(options.root);
  const lines = compareTrees(here, sharedFiles(options.sibling));
  if (lines.length === 0) {
    console.log(`compare-scripts: ${Object.keys(here).length} shared file(s), identical in both repositories`);
    return 0;
  }
  console.log(`compare-scripts: ${lines.length} difference(s) with the sibling repository:\n${lines.join("\n")}`);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
