#!/usr/bin/env node
// Refuse personal data in the repository: home paths, e-mail addresses, ids, card numbers, keys, and
// text outside the locale files; plus every term in the author's private denylist (kept outside all repos).
//
// Usage: node scripts/check-private.mjs [--all | --tree <rev> | --history <rev>] [--no-private-list] [--list <path>] [--quiet] [<path prefix>...]
//   default      staged files, as they are in the index (what the next commit will contain)
//   --all        every tracked or new, not ignored file, as it is in the working tree
//   --tree       every file of a commit (pre-push checks what is about to leave the machine)
//   --history    every reachable tree, commit message and selected annotated tag; no path narrowing
//   <prefix>     only files under these repository-relative prefixes
//   --list       private denylist (default $FLEET_PRIVATE_DENYLIST, else ~/.config/paseo-fleet/private-denylist.txt)
//   --no-private-list   generic rules only (CI; the private list never leaves the author's machine)
// Exit: 0 clean, 1 hits, 2 setup problem (missing denylist, unreadable rules, not a git checkout).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { identifierSpans } from "./private-identifiers.mjs";
import { historyObjects } from "./git-objects.mjs";
import { parseDenylist } from "../shared/privacy-denylist.mjs";
export { parseDenylist };

const MAX_BUFFER = 64 * 1024 * 1024;
export const EXIT = { clean: 0, hits: 1, setup: 2 };

import privacyRules from "../shared/privacy-rules.mjs";
import { SetupError, compileRules, scanFile as sharedScanFile, unusedPublicOccurrences } from "../server/privacy-scanner.mjs";
export { SetupError, compileRules, anyMatch, masked, isForbiddenPath, occurrenceFingerprint, unusedPublicOccurrences } from "../server/privacy-scanner.mjs";
export const scanFile = (path, text, compiled, privateRules = []) => sharedScanFile(path, text, compiled, privateRules, identifierSpans);

export function defaultListPath(env = process.env, home = homedir()) {
  return env.FLEET_PRIVATE_DENYLIST?.trim() || join(home, ".config", "paseo-fleet", "private-denylist.txt");
}

export function parseArgs(argv) {
  const options = { all: false, tree: null, history: null, privateList: true, list: null, quiet: false, prefixes: [] };
  const value = (i, name) => {
    if (!argv[i + 1]) throw new SetupError(`${name} needs a value`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--all") options.all = true;
    else if (arg === "--no-private-list") options.privateList = false;
    else if (arg === "--quiet") options.quiet = true;
    else if (arg === "--list") options.list = value(i++, "--list");
    else if (arg === "--tree") options.tree = value(i++, "--tree");
    else if (arg === "--history") options.history = value(i++, "--history");
    else if (arg.startsWith("--")) throw new SetupError(`unknown option ${arg}`);
    else options.prefixes.push(arg.replace(/^\.\//, ""));
  }
  if ([options.all, options.tree, options.history].filter(Boolean).length > 1) throw new SetupError("--all, --tree and --history cannot be combined");
  if (options.history && options.prefixes.length) throw new SetupError("history scanning cannot be narrowed by path prefixes");
  return options;
}



export function loadRules() {
  return compileRules(privacyRules);
}


/** Read the private denylist; a missing file is a setup error so a local commit never runs without it. */
export function loadDenylist(listPath) {
  let text;
  try {
    text = readFileSync(listPath, "utf8");
  } catch {
    throw new SetupError(`private denylist not found: ${listPath} (create it from scripts/private-denylist.example.txt, or pass --list <path>)`);
  }
  return parseDenylist(text);
}


function git(root, args, encoding = "utf8") {
  return execFileSync("git", ["-C", root, ...args], { encoding, maxBuffer: MAX_BUFFER, stdio: ["ignore", "pipe", "pipe"] });
}

/** The files to scan and how to read each one: index blobs, a commit's blobs, or the working tree. */
function source(root, options) {
  if (options.tree) {
    let commit;
    try {
      commit = git(root, ["rev-parse", "--verify", `${options.tree}^{commit}`]).trim();
    } catch {
      throw new SetupError(`not a commit: ${options.tree}`);
    }
    return { args: ["ls-tree", "-r", "-z", "--name-only", commit], read: (path) => git(root, ["cat-file", "blob", `${commit}:${path}`], "buffer") };
  }
  if (options.all) {
    return { args: ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], read: (path) => readFileSync(join(root, path)) };
  }
  return { args: ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"], read: (path) => git(root, ["cat-file", "blob", `:${path}`], "buffer") };
}

const asText = (buffer) => (buffer.includes(0) ? null : buffer.toString("utf8"));

export function run(argv, env = process.env, cwd = process.cwd()) {
  const options = parseArgs(argv);
  let root;
  try {
    root = git(cwd, ["rev-parse", "--show-toplevel"]).trim();
  } catch {
    throw new SetupError("not inside a git checkout");
  }
  const compiled = loadRules();
  const privateRules = options.privateList ? loadDenylist(options.list ?? defaultListPath(env)) : [];
  if (options.history) {
    const objects = historyObjects(root, options.history);
    const hits = [];
    for (const entry of objects.files) {
      hits.push(...scanFile(entry.path, asText(objects.blobs.get(entry.id).data), compiled, privateRules)
        .map(hit => ({ ...hit, object: entry.id })));
    }
    for (const [id, object] of [...objects.commits, ...objects.tags]) {
      hits.push(...scanFile(`${object.type}-object/${id}`, object.data.toString("utf8"), compiled, privateRules)
        .map(hit => ({ ...hit, object: id })));
    }
    return { files: objects.files.length, hits, scope: { tip: objects.tip, commit: objects.commit,
      commits: objects.commits.size, tags: objects.tags.size, trees: objects.trees.length, blobs: objects.blobs.size } };
  }
  const inScope = (path) => options.prefixes.length === 0 || options.prefixes.some((prefix) => path === prefix || path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`));
  const { args, read } = source(root, options);
  const files = [...new Set(git(root, args).split("\0").filter(Boolean))].sort().filter(inScope);
  const hits = [];
  for (const path of files) {
    let buffer;
    try {
      buffer = read(path);
    } catch (error) {
      if (options.all && error.code === "ENOENT") continue; // a tracked deletion in the working tree
      throw new SetupError(`cannot read scan input: ${path}`);
    }
    hits.push(...scanFile(path, asText(buffer), compiled, privateRules));
  }
  return { files: files.length, hits, unusedPublicOccurrences: unusedPublicOccurrences(compiled) };
}

export function summarize(hits) {
  const byRule = new Map();
  for (const hit of hits) byRule.set(hit.rule, (byRule.get(hit.rule) ?? 0) + 1);
  return [...byRule.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/** Public history findings disclose paths/types/counts, never identifiers locating refused metadata. */
export function summarizeHistoryFindings(hits) {
  const groups = new Map();
  for (const hit of hits) {
    const metadata = /^(commit|tag)-object\/[0-9a-f]{40,64}$/.exec(hit.path);
    const path = metadata ? `${metadata[1]}-metadata` : hit.path;
    const key = JSON.stringify([path, hit.rule]);
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  return [...groups].map(([key, count]) => {
    const [path, rule] = JSON.parse(key);
    return { path, rule, count };
  }).sort((a, b) => a.path.localeCompare(b.path) || a.rule.localeCompare(b.rule));
}

function main() {
  let result;
  try {
    result = run(process.argv.slice(2));
  } catch (error) {
    console.error(`check-private: ${error instanceof SetupError ? error.message : String(error)}`);
    return EXIT.setup;
  }
  const quiet = process.argv.includes("--quiet");
  if (!quiet) {
    if (result.scope) for (const hit of summarizeHistoryFindings(result.hits)) console.log(`check-private history: ${hit.path}:${hit.rule} (${hit.count})`);
    else for (const hit of result.hits) console.log(`${hit.path}:${hit.line}:${hit.rule}: ${hit.snippet}`);
  }
  const files = new Set(result.hits.map((hit) => hit.path)).size;
  const counts = summarize(result.hits).map(([rule, count]) => `${rule} ${count}`).join(", ");
  console.log(`check-private: ${result.files} file(s) scanned, ${result.hits.length} hit(s) in ${files} file(s)${counts ? `: ${counts}` : ""}`);
  if (result.scope) console.log(`check-private history: ${JSON.stringify(result.scope)}`);
  return result.hits.length > 0 ? EXIT.hits : EXIT.clean;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
