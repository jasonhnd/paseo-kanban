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
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { identifierSpans } from "./private-identifiers.mjs";
import { historyObjects } from "./git-objects.mjs";
import { parseDenylist } from "../shared/privacy-denylist.mjs";
export { parseDenylist };

const RULES_FILE = join(dirname(fileURLToPath(import.meta.url)), "private-scan.rules.json");
const CONTEXT = 40;
const MAX_BUFFER = 64 * 1024 * 1024;
export const EXIT = { clean: 0, hits: 1, setup: 2 };

export class SetupError extends Error {}

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


const regex = (source, flags = "") => new RegExp(source, flags);

export function defaultListPath(env = process.env, home = homedir()) {
  return env.FLEET_PRIVATE_DENYLIST?.trim() || join(home, ".config", "paseo-fleet", "private-denylist.txt");
}

/** Compile the generic rules file. */
export function compileRules(json) {
  const list = (items) => (items ?? []).map((source) => regex(source));
  return {
    // Reviewed public-name collisions are bound to the exact match, path and line.
    // These fingerprints never exempt another rule, another match or a changed line.
    publicOccurrenceLiterals: (json.publicOccurrenceLiterals ?? []).map(value => {
      if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) throw new SetupError("invalid public occurrence literal");
      return value;
    }),
    usedPublicOccurrences: new Set(),
    publicOccurrenceFingerprints: new Set((json.publicOccurrenceFingerprints ?? []).map(value => {
      if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new SetupError("invalid public occurrence fingerprint");
      return value;
    })),
    privateIdentifierExceptions: (json.privateIdentifierExceptions ?? []).map(item => {
      if (!Array.isArray(item.termParts) || !item.termParts.length
          || item.termParts.some(part => typeof part !== "string" || !part)
          || typeof item.path !== "string" || !item.path.startsWith("^") || !item.path.endsWith("$")
          || typeof item.function !== "string" || !item.function) throw new SetupError("invalid private identifier exception");
      const term = item.termParts.join("");
      if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(term)) throw new SetupError("identifier exception needs an exact identifier");
      return { term, path: regex(item.path), function: item.function };
    }),
    ignore: list(json.ignorePaths),
    forbidden: list(json.forbiddenPaths?.patterns),
    neverPublic: list(json.neverPublicPaths),
    forbiddenAllow: list(json.forbiddenPaths?.allow),
    rules: (json.rules ?? []).map((rule) => ({
      id: rule.id,
      pattern: regex(rule.pattern, "g"),
      allow: list(rule.allow),
      onlyPaths: rule.onlyPaths ? list(rule.onlyPaths) : null,
    })),
  };
}

export function loadRules() {
  return compileRules(JSON.parse(readFileSync(RULES_FILE, "utf8")));
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

export const anyMatch = (patterns, text) => patterns.some((pattern) => pattern.test(text));

/** The line around a hit, with the hit itself masked. */
export function masked(line, index, length) {
  const start = Math.max(0, index - CONTEXT);
  const end = Math.min(line.length, index + length + CONTEXT);
  return `${line.slice(start, index)}***${line.slice(index + length, end)}`.trim();
}

/** True when a path name alone is refused (real data files, private folders). */
export function isForbiddenPath(path, compiled) {
  return anyMatch(compiled.neverPublic ?? [], path)
    || (anyMatch(compiled.forbidden, path) && !anyMatch(compiled.forbiddenAllow, path));
}

export function occurrenceFingerprint(path, line, match, literal) {
  return createHash("sha256").update(JSON.stringify([path, line, match.index, match[0], literal.toLowerCase()])).digest("hex");
}

function reviewedPublicMatch(compiled, path, line, match, rule) {
  if (typeof rule.literal !== "string") return false; // Regex rules are never exempted.
  const fingerprint = occurrenceFingerprint(path, line, match, rule.literal);
  if (!compiled.publicOccurrenceFingerprints?.has(fingerprint)) return false;
  compiled.usedPublicOccurrences.add(fingerprint);
  return true;
}

export function unusedPublicOccurrences(compiled) {
  return [...compiled.publicOccurrenceFingerprints].filter(value => !compiled.usedPublicOccurrences.has(value));
}

/** Hits for one file. `text` is null for binary files, which are judged by path only. */
export function scanFile(path, text, compiled, privateRules = []) {
  const hits = [];
  // A file name can leak as much as its content, so private terms are checked on every path, ignored ones too.
  for (const rule of privateRules) {
    for (const match of path.matchAll(rule.pattern)) {
      if (!reviewedPublicMatch(compiled, path, null, match, rule)) hits.push({ path, line: 0, rule: rule.id, snippet: masked(path, match.index, match[0].length) });
    }
  }
  if (isForbiddenPath(path, compiled)) hits.push({ path, line: 0, rule: "forbidden-path", snippet: path });
  // Ignoring file content never exempts a prohibited path, including images and other binary files.
  if (anyMatch(compiled.ignore, path)) return hits;
  if (text === null) return hits;
  const identifiers = identifierSpans(path, text, compiled.privateIdentifierExceptions ?? [], privateRules);
  const rules = [...compiled.rules.filter((rule) => !rule.onlyPaths || anyMatch(rule.onlyPaths, path)), ...privateRules];
  let offset = 0;
  text.split("\n").forEach((line, index) => {
    for (const rule of rules) {
      for (const match of line.matchAll(rule.pattern)) {
        if (anyMatch(rule.allow, match[0])) continue;
        if (rule.id === "private" && reviewedPublicMatch(compiled, path, line, match, rule)) continue;
        if (rule.id === "private" && identifiers.has(`${offset + match.index}:${match[0].length}`)) continue;
        hits.push({ path, line: index + 1, rule: rule.id, snippet: masked(line, match.index, match[0].length) });
      }
    }
    offset += line.length + 1;
  });
  return hits;
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
