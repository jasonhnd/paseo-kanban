#!/usr/bin/env node
// Keep the fleet-quota contract that the two plugin repositories share in step.
// Fleet Cockpit's repository is the source; Kanban's repository keeps a vendored copy. Both hold:
//   shared/contract/         zod schemas only (Paseo bundles shared/ into the client: no node:* imports)
//   server/contract/         data directory paths, atomic writes and the read state machine
//   contract.manifest.json   { "contract": "fleet-quota/v1", "files": { "<path>": "<sha256>" } }
//
// Usage: node scripts/sync-contract.mjs [--check] [--source <repository>] [--write-manifest] [--root <repository>]
//   (none), --check    read-only: the contract files must match this repository's manifest, and with a source
//                      ($FLEET_CONTRACT_SOURCE, or --source together with --check) the source must carry the same
//                      contract version and identical files. Nothing is written. An empty manifest passes.
//   --source <repo>    copy: only a source given on the command line (without --check) is copied here. Its
//                      contract folders and manifest are mirrored: files copied over, files only here removed.
//   --write-manifest   rewrite this repository's manifest from its contract files, keeping the version
//                      (run it in the source repository after changing the contract).
// Exit: 0 in step, 1 differences, 2 setup problem.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const CONTRACT_DIRS = ["shared/contract", "server/contract"];
export const MANIFEST = "contract.manifest.json";
const DEFAULT_VERSION = "fleet-quota/v1";
const VERSION = /^fleet-quota\/v[1-9][0-9]*$/;
const SHA256 = /^[0-9a-f]{64}$/;
const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const USAGE = "usage: node scripts/sync-contract.mjs [--check] [--source <repository>] [--write-manifest] [--root <repository>]";

export class SetupError extends Error {}

export function parseArgs(argv, env = process.env) {
  const options = { root: DEFAULT_ROOT, check: false, writeManifest: false, copy: false, source: env.FLEET_CONTRACT_SOURCE?.trim() || null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--check") options.check = true;
    else if (arg === "--write-manifest") options.writeManifest = true;
    else if (arg === "--root" || arg === "--source") {
      if (!argv[i + 1]) throw new SetupError(`${arg} needs a directory`);
      options[arg.slice(2)] = argv[(i += 1)];
      if (arg === "--source") options.copy = true;
    } else throw new SetupError(`unknown argument ${arg}\n${USAGE}`);
  }
  if (options.writeManifest && options.check) throw new SetupError("--write-manifest and --check cannot be combined");
  if (options.writeManifest && options.copy) throw new SetupError("--write-manifest and --source cannot be combined");
  // Copying needs an explicit --source; the environment variable only widens the read-only check.
  if (options.check) options.copy = false;
  options.root = resolve(options.root);
  if (options.source) options.source = resolve(options.source);
  return options;
}

/** Repository-relative paths of every file in the contract folders, sorted. */
export async function contractFiles(root) {
  const files = [];
  for (const dir of CONTRACT_DIRS) {
    const base = join(root, dir);
    if (!existsSync(base)) continue;
    const entries = await readdir(base, { recursive: true, withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile()) files.push(relative(root, join(entry.parentPath, entry.name)).split(sep).join("/"));
    }
  }
  return files.sort();
}

const digest = async (file) => createHash("sha256").update(await readFile(file)).digest("hex");

/** { path: sha256 } for the contract files on disk. */
export async function hashFiles(root) {
  const hashes = {};
  for (const file of await contractFiles(root)) hashes[file] = await digest(join(root, file));
  return hashes;
}

/** The parsed manifest; a missing or malformed manifest is a setup problem. */
export async function readManifest(root) {
  const path = join(root, MANIFEST);
  if (!existsSync(path)) throw new SetupError(`${path} is missing`);
  let json;
  try {
    json = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new SetupError(`${path} is not valid JSON: ${error.message}`);
  }
  if (typeof json?.contract !== "string" || !VERSION.test(json.contract)) throw new SetupError(`${path}: "contract" must look like fleet-quota/v1`);
  const files = json.files ?? {};
  if (typeof files !== "object" || Array.isArray(files)) throw new SetupError(`${path}: "files" must be an object`);
  for (const [file, hash] of Object.entries(files)) {
    if (!CONTRACT_DIRS.some((dir) => file.startsWith(`${dir}/`))) throw new SetupError(`${path}: ${file} is outside ${CONTRACT_DIRS.join(" and ")}`);
    if (typeof hash !== "string" || !SHA256.test(hash)) throw new SetupError(`${path}: ${file} needs a sha256 hex digest`);
  }
  return { contract: json.contract, files };
}

/** Lines describing how `actual` differs from `expected` ({ path: hash } maps). */
export function compare(expected, actual, label) {
  const lines = [];
  for (const file of Object.keys(expected).sort()) {
    if (!(file in actual)) lines.push(`missing  ${file} (${label})`);
    else if (expected[file] !== actual[file]) lines.push(`changed  ${file} (${label})`);
  }
  for (const file of Object.keys(actual).sort()) if (!(file in expected)) lines.push(`extra    ${file} (${label})`);
  return lines;
}

/** Every difference: this repository against its manifest, and (with a source) against the source. */
export async function check({ root, source }) {
  const manifest = await readManifest(root);
  const local = await hashFiles(root);
  const lines = compare(manifest.files, local, "not as in contract.manifest.json");
  if (source) {
    const theirs = await readManifest(source);
    const sourceFiles = await hashFiles(source);
    lines.push(...compare(theirs.files, sourceFiles, "the source does not match its own manifest"));
    if (theirs.contract !== manifest.contract) lines.push(`version  here ${manifest.contract}, source ${theirs.contract}`);
    lines.push(...compare(sourceFiles, local, "copy differs from the source"));
  }
  return { contract: manifest.contract, count: Object.keys(local).length, lines };
}

const manifestText = (contract, files) =>
  `${JSON.stringify({ contract, files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) }, null, 2)}\n`;

export async function writeManifest({ root }) {
  const contract = existsSync(join(root, MANIFEST)) ? (await readManifest(root)).contract : DEFAULT_VERSION;
  const files = await hashFiles(root);
  await writeFile(join(root, MANIFEST), manifestText(contract, files), "utf8");
  return { contract, count: Object.keys(files).length };
}

/** Mirror the source's contract folders and manifest into this repository. */
export async function sync({ root, source }) {
  const theirs = await readManifest(source);
  const sourceFiles = await hashFiles(source);
  const inconsistent = compare(theirs.files, sourceFiles, "the source does not match its own manifest");
  if (inconsistent.length > 0) throw new SetupError(`refusing to copy from a source that fails its own check:\n${inconsistent.join("\n")}`);
  const local = await hashFiles(root);
  if (Object.keys(sourceFiles).length === 0 && Object.keys(local).length > 0) {
    throw new SetupError("the source has no contract files; refusing to delete the copy here");
  }
  const lines = compare(sourceFiles, local, "copied");
  for (const file of Object.keys(sourceFiles)) {
    if (local[file] === sourceFiles[file]) continue;
    await mkdir(dirname(join(root, file)), { recursive: true });
    await copyFile(join(source, file), join(root, file));
  }
  for (const file of Object.keys(local)) if (!(file in sourceFiles)) await rm(join(root, file));
  await writeFile(join(root, MANIFEST), manifestText(theirs.contract, sourceFiles), "utf8");
  return { contract: theirs.contract, count: Object.keys(sourceFiles).length, lines };
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.writeManifest) {
      const result = await writeManifest(options);
      process.stdout.write(`manifest written (${result.contract}, ${result.count} file(s))\n`);
      return 0;
    }
    if (options.copy) {
      const result = await sync(options);
      process.stdout.write(`synced from the source (${result.contract}, ${result.count} file(s))${result.lines.length ? `:\n${result.lines.join("\n")}` : ", nothing changed"}\n`);
      return 0;
    }
    const result = await check(options);
    const scope = `${result.contract}, ${result.count} file(s), ${options.source ? "checked against the source" : "manifest only (no source given)"}`;
    if (result.lines.length === 0) {
      process.stdout.write(`contract in sync (${scope})\n`);
      return 0;
    }
    process.stdout.write(`contract differs (${scope}):\n${result.lines.join("\n")}\n`);
    return 1;
  } catch (error) {
    process.stderr.write(`sync-contract: ${error.message}\n`);
    return 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
