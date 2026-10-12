// Read-only gate for reviewer agents whose provider asks Paseo to approve every tool call.
// Reads, searches and a narrow set of read-only shell commands are approved; everything else is refused.
// Logic copied from Agent Fleet Cockpit's server/readonly.ts. Do not import that plugin.
import type { AgentPermissionRequest } from "@getpaseo/protocol/agent-types";
import { t } from "../shared/i18n";

export type Verdict = { allow: true } | { allow: false; reason: string };

const SIMPLE = new Set(["cat", "head", "tail", "ls", "wc", "grep", "rg", "pwd", "stat", "jq", "cut", "diff", "basename", "dirname", "realpath", "echo"]);
const GIT = new Set(["status", "diff", "log", "show", "rev-parse", "ls-files", "grep", "blame", "cat-file", "shortlog", "describe", "merge-base", "ls-tree"]);
const GH: Record<string, Set<string>> = {
  pr: new Set(["view", "diff", "list", "checks", "status"]),
  issue: new Set(["view", "list", "status"]),
  repo: new Set(["view"]),
  run: new Set(["view", "list"]),
};

// Shell quotes are parsed, never stripped by a regexp: e.g. grep '-Owriter'
// is an option too. Expansions/escapes/operators are rejected by readOnlyShell.
function tokens(segment: string): string[] {
  const parts: string[] = []; let token = ""; let quote = ""; let started = false;
  for (const char of segment) {
    if (quote) { if (char === quote) quote = ""; else token += char; started = true; }
    else if (char === "'" || char === '"') { quote = char; started = true; }
    else if (/\s/.test(char)) { if (started) parts.push(token); token = ""; started = false; }
    else { token += char; started = true; }
  }
  if (quote) return [];
  if (started) parts.push(token);
  return parts;
}

/** Known option grammar; unknown options and abbreviations fail closed. */
function readOptions(args: string[], flags: Set<string>, values: Set<string>, shortFlags: string, shortValues = "", attachedShortValues = true): string[] | null {
  const operands: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") { operands.push(...args.slice(i + 1)); break; }
    if (arg === "-" || !arg.startsWith("-")) { operands.push(arg); continue; }
    if (flags.has(arg)) continue;
    const eq = arg.indexOf("=");
    if (values.has(eq > 0 ? arg.slice(0, eq) : arg)) {
      if (eq > 0 ? !arg.slice(eq + 1) : args[++i] === undefined) return null;
      continue;
    }
    if (arg.startsWith("--")) return null;
    for (let j = 1; j < arg.length; j++) {
      if (shortFlags.includes(arg[j])) continue;
      if (!shortValues.includes(arg[j])) return null;
      // Some tools (notably tree) keep interpreting letters after a value
      // option instead of consuming them as its value. Require the option to
      // be last in this token and consume the next argv in that grammar.
      if (!attachedShortValues && j !== arg.length - 1) return null;
      if (j === arg.length - 1 && args[++i] === undefined) return null;
      break;
    }
  }
  return operands;
}

function treeAllowed(args: string[]): boolean {
  // -o/--output and platform-specific extension options are deliberately absent.
  return readOptions(args, new Set(["--help", "--version", "--dirsfirst", "--noreport", "--prune", "--du", "--inodes", "--device"]),
    new Set(["--sort", "--timefmt", "--filelimit", "--charset"]), "adfilpqsuDFrntxACJS", "LPI", false) !== null;
}

function fileAllowed(args: string[]): boolean {
  // Compile (-C), decompressor execution (-z/-Z), special-device reads and
  // unknown options are absent. Keep ordinary classification and magic reads.
  return readOptions(args, new Set(["--brief", "--mime", "--mime-type", "--mime-encoding", "--dereference", "--no-dereference", "--help", "--version"]),
    new Set(["--magic-file", "--exclude"]), "biILh", "me", false) !== null;
}

function uniqAllowed(args: string[]): boolean {
  const operands = readOptions(args, new Set(["--count", "--repeated", "--unique", "--ignore-case", "--zero-terminated", "--help", "--version"]),
    new Set(["--skip-fields", "--skip-chars", "--check-chars"]), "cduiz", "fsw");
  // uniq [INPUT [OUTPUT]]: the second positional argument is a write target.
  return operands !== null && operands.length <= 1;
}

function findAllowed(args: string[]): boolean {
  const switches = new Set(["-H", "-L", "-P"]);
  const zero = new Set(["-print", "-print0", "-true", "-false", "-empty", "-readable", "-writable", "-executable", "-prune", "-quit", "-depth", "-xdev", "-mount", "-and", "-or", "-not", "-a", "-o"]);
  const one = new Set(["-name", "-iname", "-path", "-ipath", "-wholename", "-iwholename", "-regex", "-iregex", "-type", "-size", "-user", "-group", "-uid", "-gid", "-perm", "-mtime", "-mmin", "-atime", "-amin", "-ctime", "-cmin", "-newer", "-maxdepth", "-mindepth", "-regextype"]);
  let i = 0;
  while (switches.has(args[i])) i++;
  while (i < args.length && !args[i].startsWith("-")) i++;
  for (; i < args.length; i++) {
    if (zero.has(args[i])) continue;
    if (one.has(args[i]) && args[++i] !== undefined) continue;
    // No -exec*, -ok*, -fprint*, -fprintf, -fls, -delete, or unknown predicates.
    return false;
  }
  return true;
}

function gitGrepAllowed(args: string[]): boolean {
  return readOptions(args, new Set(["--cached", "--no-index", "--untracked", "--no-exclude-standard", "--exclude-standard", "--text", "--ignore-case", "--word-regexp", "--invert-match", "--full-name", "--line-number", "--column", "--files-with-matches", "--files-without-match", "--count", "--quiet", "--all-match", "--fixed-strings", "--extended-regexp", "--basic-regexp", "--perl-regexp", "--no-color", "--no-textconv", "--and", "--or", "--not", "--break", "--heading"]),
    new Set(["--max-count", "--after-context", "--before-context", "--context", "--threads", "--color"]),
    "aIiwnlhLczqvFEGPo", "efABCm") !== null;
}

function gitLogAllowed(args: string[]): boolean {
  const flags = new Set(["--no-ext-diff", "--no-textconv", "--no-show-signature", "--oneline", "--all", "--patch", "--no-patch", "--patch-with-raw", "--patch-with-stat", "--raw", "--numstat", "--shortstat", "--name-only", "--name-status", "--check", "--summary", "--cc", "--combined-all-paths", "--function-context", "--text", "--binary", "--no-renames", "--relative", "--reverse", "--first-parent", "--no-merges", "--merges", "--boundary", "--full-history", "--simplify-merges", "--topo-order", "--date-order", "--author-date-order", "--follow", "--abbrev-commit", "--no-abbrev-commit", "--full-diff", "--no-decorate", "--no-color", "--no-notes", "--ignore-all-space", "--ignore-space-change", "--ignore-space-at-eol", "--ignore-blank-lines"]);
  const values = new Set(["--max-count", "--skip", "--since", "--until", "--after", "--before", "--author", "--committer", "--grep", "--date", "--format", "--pretty", "--encoding", "--abbrev", "--unified", "--word-diff-regex", "--diff-filter", "--diff-algorithm"]);
  const optional = new Set(["--stat", "--dirstat", "--decorate", "--color", "--word-diff", "--find-renames", "--find-copies", "--branches", "--tags", "--remotes", "--unified", "--abbrev", "--pretty"]);
  const formats = new Set(["oneline", "short", "medium", "full", "fuller", "reference", "email", "raw"]);
  let noExtDiff = false, noTextconv = false, noSignature = false, explicitFormat = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") break;
    if (!arg.startsWith("-") || arg === "-") continue;
    if (flags.has(arg)) {
      if (arg === "--no-ext-diff") noExtDiff = true;
      if (arg === "--no-textconv") noTextconv = true;
      if (arg === "--no-show-signature") noSignature = true;
      if (arg === "--oneline") explicitFormat = true;
      continue;
    }
    const eq = arg.indexOf("="); const option = eq > 0 ? arg.slice(0, eq) : arg;
    // Signature format placeholders can verify signatures independently of
    // --no-show-signature. Repository log.showSignature also needs overriding.
    if (["--format", "--pretty"].includes(option)) {
      const value = eq > 0 ? arg.slice(eq + 1) : "";
      // Defaults and named pretty aliases may come from repository config.
      if (!value || value.includes("%G") || !(formats.has(value) || value.includes("%") || /^(?:t?format):/.test(value))) return false;
      explicitFormat = true; continue;
    }
    if (optional.has(option)) { if (eq > 0 && !arg.slice(eq + 1)) return false; continue; }
    // Explicit = values avoid Git's mixed optional/required long-option
    // grammars swallowing a guard or concealing a later helper override.
    if (values.has(option)) { if (eq <= 0 || !arg.slice(eq + 1)) return false; continue; }
    if (/^-\d+$/.test(arg)) continue;
    if (arg.startsWith("--")) return false; // Includes abbreviations and re-enabling helpers.
    for (let j = 1; j < arg.length; j++) {
      if ("pucWabwmrz".includes(arg[j])) continue;
      if (arg[j] === "U") break; // Optional context count must be attached, e.g. -U3.
      if (!"nSG".includes(arg[j])) return false;
      if (j === arg.length - 1) {
        const value = args[++i];
        if (value === undefined || value === "--") return false;
      }
      break;
    }
  }
  return noExtDiff && noTextconv && noSignature && explicitFormat;
}

function segmentAllowed(segment: string): boolean {
  let parts = tokens(segment);
  if (parts.length === 0) return false;
  // Do not run an arbitrary script called /tmp/cat or ./git.
  if (parts[0].includes("/") && !/^\/(usr\/)?bin\/[a-z-]+$/.test(parts[0])) return false;
  const cmd = parts[0].replace(/^.*\//, "");
  // sort may create temp files or invoke --compress-program even with stdout output.
  if (cmd === "sort") return false;
  if (cmd === "rg" && parts.slice(1).some(p => /^--(pre|hostname-bin)/.test(p))) return false;
  if (cmd === "tree") return treeAllowed(parts.slice(1));
  if (cmd === "file") return fileAllowed(parts.slice(1));
  if (cmd === "uniq") return uniqAllowed(parts.slice(1));
  if (SIMPLE.has(cmd)) return true;
  if (cmd === "find") return findAllowed(parts.slice(1));
  // Only the existing line-print form, no e/w scripts or arbitrary script files.
  if (cmd === "sed") return parts[1] === "-n" && /^['"]?\d+(,\d+)?p['"]?$/.test(parts[2] ?? "") && !parts.slice(3).some(p => p.startsWith("-"));
  if (cmd === "git") {
    parts = parts.slice(1);
    let noPager = false;
    let noMonitor = false;
    while (parts[0] === "-C" || parts[0] === "--no-pager" || parts[0] === "-c") {
      if (parts[0] === "--no-pager") { noPager = true; parts = parts.slice(1); }
      else if (parts[0] === "-c") {
        // One fixed override closes repository-provided fsmonitor programs. No
        // other config, pager, alias, helper or environment override is allowed.
        if (parts[1] !== "core.fsmonitor=false") return false;
        noMonitor = true; parts = parts.slice(2);
      } else parts = parts.slice(2);
    }
    if (!noPager || !noMonitor) return false;
    const sub = parts[0] ?? "";
    if (parts.some(p => /^--(output|ext-diff|textconv|filters|show-signature|open-files-in-pager|exec-path|config-env)/.test(p))) return false;
    if (["diff", "show"].includes(sub) && !(parts.includes("--no-ext-diff") && parts.includes("--no-textconv"))) return false;
    if (sub === "log") return gitLogAllowed(parts.slice(1));
    if (sub === "grep") return gitGrepAllowed(parts.slice(1));
    if (GIT.has(sub)) return true;
    if (sub === "branch") return parts.length === 1 || (parts.some(p => p === "--list") && parts.slice(1).every(p => !p.startsWith("-") || /^(-a|-r|-v|-vv|--list|--all|--remotes)$/.test(p))) || (parts.length === 2 && parts[1] === "--show-current");
    if (sub === "remote") return parts.length === 1 || parts[1] === "-v" || parts[1] === "get-url";
    return false;
  }
  if (cmd === "gh") {
    if (parts.some(p => /^--(web|browser)/.test(p))) return false;
    const [group, action] = [parts[1] ?? "", parts[2] ?? ""];
    // API flags can change method implicitly (fields), write caches, or run
    // transforms. No API request is part of this reviewer's shell contract.
    if (group === "api") return false;
    return GH[group]?.has(action) ?? false;
  }
  return false;
}

export function readOnlyShell(command: string): boolean {
  if (/[;&<>`\r\n$\\(){}!]/.test(command)) return false;
  return command.split("|").every(segmentAllowed);
}

/**
 * Cursor's shell permission has no rawInput. The command is the tool title,
 * wrapped in backticks (`git log`). Paseo copies that title into detail.command
 * when it has not already seen a tool card with rawInput.command.
 * Internal backticks are escaped as \`.
 */
function cursorShellCommand(command: string | undefined): string {
  const raw = command?.trim() || "";
  if (raw.length >= 2 && raw.startsWith("`") && raw.endsWith("`")) {
    return raw.slice(1, -1).replace(/\\`/g, "`");
  }
  return raw;
}

export function judgeReadOnly(request: AgentPermissionRequest, options = { shell: true }): Verdict {
  const detail = request.detail as { type?: string; command?: string; filePath?: string; query?: string; url?: string; newString?: unknown; oldString?: unknown } | undefined;
  if (request.kind !== "tool") return { allow: false, reason: t("readonly.reviewerReadOnly", { action: request.title ?? request.name }) };
  if (detail?.type !== "shell" && (detail?.command !== undefined || detail?.newString !== undefined || detail?.oldString !== undefined || /^(write|edit|delete|execute|shell|bash|switch_mode)$/i.test(request.name))) {
    return { allow: false, reason: t("readonly.reviewerReadOnly", { action: request.title ?? request.name }) };
  }
  switch (detail?.type) {
    case "read":
      if (typeof detail.filePath !== "string" || !detail.filePath.trim()) break;
      return { allow: true };
    case "search":
      if (typeof detail.query !== "string") break;
      return { allow: true };
    case "fetch":
      if (typeof detail.url !== "string" || !/^https?:\/\//.test(detail.url)) break;
      return { allow: true };
    case "shell": {
      const command = cursorShellCommand(detail.command);
      return options.shell && command && readOnlyShell(command)
        ? { allow: true }
        : { allow: false, reason: t("readonly.shellNotAllowed", { command: command.slice(0, 120) }) + (options.shell && /^(?:\/(?:usr\/)?bin\/)?git\s/.test(command) ? t("readonly.gitGuard") : "") };
    }
    default: break;
  }
  return { allow: false, reason: t("readonly.reviewerReadOnly", { action: request.title ?? request.name }) };
}
