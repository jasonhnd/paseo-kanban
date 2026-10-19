/// <reference types="node" />
/**
 * DEMO_0001 review R1: a reclaimed agent's raw commands and messages can hold credentials (Authorization headers,
 * curl -u, JSON api_key fields, …), so they are never stored or quoted. Only operations that matter for "do not
 * do it twice" are recognised, and each is rebuilt from an allowlist: the tool and subcommand, a few known flags,
 * branch / tag names that pass a strict pattern, and PR / issue numbers. Every other argument is dropped.
 */
import { t } from "../shared/i18n";

/** A branch, tag, or remote name worth showing. Anything with ':', '@', '=', quotes, or a key-like blob fails. */
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;
/** Known token prefixes; checked before anything else, a commit id included (DEMO_0001). */
const KEY_PREFIX = /^(?:gh[pousr]_|github_pat_|sk-|xox[abpr]-|AKIA)/;
const LONG_BLOB = /[A-Za-z0-9+/_-]{32,}/;
/** A git object id as git prints it. A classic 40-hex token looks the same, so it is only shown where a commit is expected. */
const SHA = /^[0-9a-f]{7,40}$/;

/**
 * `commit: true` only where git takes a commit (the source side of a refspec, merge / rebase / checkout targets).
 * Branch, tag and remote names and a refspec's destination are never a bare hex string, so one there is hidden.
 */
function safeRef(token: string | undefined, { commit = false }: { commit?: boolean } = {}): string | null {
  if (!token || token.startsWith("-") || KEY_PREFIX.test(token)) return null;
  if (SHA.test(token)) return commit ? token : null;
  return SAFE_REF.test(token) && !LONG_BLOB.test(token) ? token : null;
}

/** A PR or issue number, also from a GitHub URL. */
function itemNumber(token: string | undefined): string | null {
  if (!token) return null;
  const plain = /^#?(\d{1,7})$/.exec(token);
  if (plain) return plain[1]!;
  const url = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(?:pull|issues)\/(\d{1,7})(?:[/?#].*)?$/.exec(token);
  return url ? url[1]! : null;
}

/** Shell words, quotes stripped. Good enough to find the tool and its plain arguments. */
function words(segment: string): string[] {
  const out: string[] = [];
  const pattern = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  for (let match = pattern.exec(segment); match; match = pattern.exec(segment)) out.push(match[1] ?? match[2] ?? match[3] ?? "");
  return out;
}

/** Drop leading `VAR=value` assignments and wrappers that only change how the tool runs. */
function toolWords(segment: string): string[] {
  const all = words(segment.trim());
  let start = 0;
  while (start < all.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(all[start]!) || ["env", "command", "time", "sudo", "npx"].includes(all[start]!))) start += 1;
  return all.slice(start);
}

/** Plain (non-flag) arguments after skipping flags; flags that take a value consume it. */
function positionals(args: string[], valued: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--") continue;
    if (arg.startsWith("-")) {
      if (!arg.includes("=") && valued.includes(arg)) i += 1;
      continue;
    }
    out.push(arg);
  }
  return out;
}

/** Read-only patterns for flags in a reclaimed agent's command; the board never passes these to git itself. */
const FORCE_FLAG = /^(?:-f|--force(?:-with-lease)?(?:=\S*)?)$/;
const DELETE_FLAG = /^(?:-d|--delete)$/i;
const CREATE_FLAGS = new Set(["-b", "-B", "-c", "-C", "--create", "--force-create"]);

function gitAction(args: string[]): string | null {
  // `git -C dir …` and `git -c k=v …` come before the subcommand.
  let i = 0;
  while (i < args.length && args[i]!.startsWith("-")) i += args[i] === "-C" || args[i] === "-c" ? 2 : 1;
  const sub = args[i];
  const rest = args.slice(i + 1);
  switch (sub) {
    case "push": {
      const [remote, refspec] = positionals(rest, ["-o", "--push-option", "--repo", "--receive-pack", "--exec"]);
      // `src:dst` names a commit then a branch; a lone `name` is both, so it is a branch name.
      const sides = (refspec ?? "").replace(/^\+/, "").split(":");
      const parts = sides.map((part, n) => safeRef(part, { commit: sides.length > 1 && n === 0 }) ?? "");
      const target = parts.filter(Boolean).join(" → ");
      const force = rest.some((arg) => FORCE_FLAG.test(arg)) || (refspec ?? "").startsWith("+") ? t("reclaimActions.git.force") : "";
      return `git push ${safeRef(remote) ?? t("reclaimActions.git.remote")}${target ? ` ${target}` : ""}${force}`;
    }
    case "commit":
      return rest.includes("--amend") ? "git commit --amend" : "git commit";
    case "merge":
    case "rebase":
    case "cherry-pick":
    case "revert": {
      const [ref] = positionals(rest, ["-m", "-F", "-s", "-X", "--onto", "--strategy", "--strategy-option", "--message", "--file", "--into-name", "--mainline"]);
      return `git ${sub}${safeRef(ref, { commit: true }) ? ` ${ref}` : ""}`;
    }
    case "switch":
    case "checkout": {
      const at = rest.findIndex((arg) => CREATE_FLAGS.has(arg));
      const ref = at >= 0 ? rest[at + 1] : positionals(rest, ["--track", "--conflict"])[0];
      return `git ${sub}${at >= 0 ? t("reclaimActions.git.create") : ""}${safeRef(ref, { commit: at < 0 }) ? ` ${ref}` : ""}`;
    }
    case "reset":
      return rest.includes("--hard") ? "git reset --hard" : null;
    case "tag": {
      const [name] = positionals(rest, ["-m", "-F", "-u", "--message", "--file", "--local-user", "--cleanup", "--sort", "--format", "--contains", "--no-contains", "--merged", "--no-merged", "--points-at"]);
      return name ? `git tag${safeRef(name) ? ` ${name}` : ""}` : null;
    }
    case "branch":
      return rest.some((arg) => DELETE_FLAG.test(arg)) ? t("reclaimActions.git.branchDelete") : null;
    default:
      return null;
  }
}

const GH_WRITES: Record<string, readonly string[]> = {
  pr: ["merge", "create", "close", "reopen", "comment", "review", "edit", "ready"],
  issue: ["create", "close", "reopen", "comment", "edit", "delete", "transfer"],
  release: ["create", "delete", "edit", "upload"],
};
const GH_MERGE_FLAGS = new Set(["--squash", "--merge", "--rebase", "--auto", "--admin", "--delete-branch", "-d", "-s", "-m", "-r"]);

/**
 * DEMO_0001 <leader> ruling: gh flags glue (`-dp`), take `=`, and grow with each release, so no flag table can say
 * which word is a tag or branch. gh is therefore recorded as its subcommand plus a plain PR / issue number only;
 * release tags and branch names are never taken from gh (branches come from git commands).
 * A number counts when nothing before it could be asking for a value: it is first, follows a plain word or a
 * `--flag=value`, or follows a switch that never takes a value in that command. Anything else is dropped, so an
 * unknown flag costs at most the number.
 */
const GH_SWITCHES = ["--delete-branch", "--undo", "-y", "--yes", "--draft", "-w", "--web", "--approve", "--request-changes", "--remove-parent", "--remove-type", "--remove-milestone", "--disable-auto"];
const GH_VERB_SWITCHES: Record<string, ReadonlySet<string>> = {
  "pr merge": new Set([...GH_SWITCHES, ...GH_MERGE_FLAGS]),
  "pr review": new Set([...GH_SWITCHES, "-a", "-c", "-r", "--comment"]),
};
const GH_DEFAULT_SWITCHES: ReadonlySet<string> = new Set(GH_SWITCHES);

function ghItemNumber(key: string, rest: string[]): string | null {
  const switches = GH_VERB_SWITCHES[key] ?? GH_DEFAULT_SWITCHES;
  for (let i = 0; i < rest.length; i += 1) {
    const before = rest[i - 1];
    const free = before === undefined || !before.startsWith("-") || before.includes("=") || switches.has(before);
    if (free && !rest[i]!.startsWith("-")) return itemNumber(rest[i]);
  }
  return null;
}

function ghAction(args: string[]): string | null {
  const [area, verb, ...rest] = args;
  if (area === "api") {
    const method = rest.find((_, n) => rest[n - 1] === "-X" || rest[n - 1] === "--method") ?? (rest.some((arg) => /^-[fF]$|^--(?:raw-)?field$|^--input$/.test(arg)) ? "POST" : "GET");
    return /^(?:POST|PUT|PATCH|DELETE)$/i.test(method) ? t("reclaimActions.gh.api", { method: method.toUpperCase() }) : null;
  }
  if (!area || !verb || !GH_WRITES[area]?.includes(verb)) return null;
  if (area === "release") return t("reclaimActions.gh.release", { verb });
  const number = ghItemNumber(`${area} ${verb}`, rest);
  const parts = [`gh ${area} ${verb}`, ...(number ? [`#${number}`] : [])];
  if (area === "pr" && verb === "merge") parts.push(...rest.filter((arg) => GH_MERGE_FLAGS.has(arg)));
  return parts.join(" ");
}

/** Tools whose arguments are never shown but whose use matters: they may have written something outside the repo. */
const WRITE_TOOLS: ReadonlySet<string> = new Set([
  // Retain the retired CLI name only to recognize historical operations; arguments stay hidden.
  "prisma", "supabase", "vercel", "cf", "wrangler", "netlify", "firebase", "fly", "flyctl", "aws", "gcloud",
  "kubectl", "terraform", "slack", "sendmail",
]);
/** Database clients; shown as "database command <name>". */
const DATABASE_TOOLS: ReadonlySet<string> = new Set(["psql", "mysql", "sqlite3", "mongosh", "redis-cli"]);

function writeToolLabel(name: string): string | null {
  if (DATABASE_TOOLS.has(name)) return t("reclaimActions.tool.database", { tool: name });
  return WRITE_TOOLS.has(name) ? name : null;
}

function writeTool(tool: string, args: string[]): string | null {
  const name = tool.split("/").pop() ?? tool;
  if (name === "curl" || name === "wget") {
    const method = args.find((_, n) => args[n - 1] === "-X" || args[n - 1] === "--request");
    const sends = args.some((arg) => /^-(?:d|F|T)$|^--(?:data(?:-\w+)?|form|upload-file|json)$/.test(arg));
    const verb = method && /^(?:POST|PUT|PATCH|DELETE)$/i.test(method) ? method.toUpperCase() : sends ? "POST" : null;
    return verb ? t("reclaimActions.tool.http", { tool: name, verb }) : null;
  }
  if (name === "npm" && (args[0] === "publish" || args[0] === "unpublish")) return `npm ${args[0]}`;
  const label = writeToolLabel(name);
  return label ? t("reclaimActions.tool.args", { label }) : null;
}

/** The safe description of one command segment, or null when it is not an operation worth repeating a warning about. */
function segmentAction(segment: string): string | null {
  const [tool, ...args] = toolWords(segment);
  if (!tool) return null;
  const name = tool.split("/").pop() ?? tool;
  if (name === "git") return gitAction(args);
  if (name === "gh") return ghAction(args);
  return writeTool(tool, args);
}

/**
 * Operations in one shell command, safe to store and quote. Splits on `&&`, `||`, `;`, `|` and newlines;
 * quoted separators are rare in these commands and only cost a missed or partial match.
 */
export function shellActions(command: string): string[] {
  return command
    .split(/&&|\|\||[;\n|]/)
    .map(segmentAction)
    .filter((action): action is string => action !== null);
}
