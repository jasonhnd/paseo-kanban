#!/usr/bin/env node
// Refuse commits whose author or committer identity could identify a person.
//
// Usage: node scripts/check-identity.mjs [--range <revs> | --history] [--no-private-list] [--list <path>]
//   default     the identity the next commit will use (git var GIT_AUTHOR_IDENT / GIT_COMMITTER_IDENT);
//               the repository must also set its own user.name and user.email (git config --local)
//   --range     every commit in a git log range, e.g. origin/main..HEAD, or one revision and its ancestors
//   --history   every commit reachable from HEAD (CI)
//   --list      private denylist (same default as check-private.mjs); when it exists, no name or e-mail
//               may contain one of its terms. --no-private-list skips it.
// Exit: 0 clean, 1 refused identities, 2 setup problem.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { defaultListPath, EXIT, loadDenylist, SetupError } from "./check-private.mjs";

/** The only e-mail addresses a commit may carry: the placeholder, GitHub noreply users and bots, GitHub's own web flow. */
export const ALLOWED_EMAIL = /^(noreply@example\.invalid|[^@\s]+@users\.noreply\.github\.com|noreply@github\.com)$/;

export function parseArgs(argv) {
  const options = { range: null, history: false, privateList: true, list: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--history") options.history = true;
    else if (arg === "--no-private-list") options.privateList = false;
    else if (arg === "--range" || arg === "--list") {
      if (!argv[i + 1]) throw new SetupError(`${arg} needs a value`);
      options[arg.slice(2)] = argv[(i += 1)];
    } else throw new SetupError(`unknown argument ${arg}`);
  }
  if (options.range && options.history) throw new SetupError("--range and --history cannot be combined");
  return options;
}

/** Problems with one identity: an e-mail outside the allow list, or a name or e-mail holding a private term. */
export function judge({ where, name, email }, privateRules = []) {
  const problems = [];
  if (!ALLOWED_EMAIL.test(email)) problems.push(`${where}: e-mail is not a placeholder or GitHub noreply address`);
  for (const [field, value] of [["name", name], ["e-mail", email]]) {
    if (privateRules.some((rule) => value.match(rule.pattern))) problems.push(`${where}: ${field} contains a term from the private denylist`);
  }
  return problems;
}

/** `Name <mail> 1700000000 +0000` (git var output) to { name, email }. */
export function parseIdent(text) {
  const match = /^(.*?)\s*<([^>]*)>/.exec(text.trim());
  if (!match) throw new SetupError(`cannot read the git identity: ${text.trim()}`);
  return { name: match[1], email: match[2] };
}

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}

function tryGit(args, cwd) {
  try {
    return git(args, cwd).trim();
  } catch {
    return null;
  }
}

/** The identities the next commit will use, plus the repository-level settings it must have. */
function nextCommit(cwd) {
  const problems = [];
  for (const key of ["user.name", "user.email"]) {
    if (!tryGit(["config", "--local", key], cwd)) problems.push(`repository: git config --local ${key} is not set (a global identity must never reach a commit)`);
  }
  const identities = ["GIT_AUTHOR_IDENT", "GIT_COMMITTER_IDENT"].map((variable) => {
    const text = tryGit(["var", variable], cwd);
    if (text === null) throw new SetupError(`git var ${variable} failed; set user.name and user.email for this repository`);
    return { where: variable === "GIT_AUTHOR_IDENT" ? "author" : "committer", ...parseIdent(text) };
  });
  return { identities, problems };
}

/** Author and committer of every commit in a range (or of everything reachable from HEAD). */
function commits(cwd, range) {
  if (range === "HEAD" && tryGit(["rev-parse", "--verify", "-q", "HEAD"], cwd) === null) return { identities: [], count: 0 };
  let out;
  try {
    out = git(["log", "--format=%H%x00%an%x00%ae%x00%cn%x00%ce", range, "--"], cwd);
  } catch (error) {
    throw new SetupError(`git log ${range} failed: ${String(error.stderr ?? error).trim()}`);
  }
  const lines = out.split("\n").filter(Boolean);
  const identities = lines.flatMap((line) => {
    const [sha, an, ae, cn, ce] = line.split("\0");
    const short = sha.slice(0, 12);
    return [
      { where: `${short} author`, name: an, email: ae },
      { where: `${short} committer`, name: cn, email: ce },
    ];
  });
  return { identities, count: lines.length };
}

export function run(argv, env = process.env, cwd = process.cwd()) {
  const options = parseArgs(argv);
  if (tryGit(["rev-parse", "--show-toplevel"], cwd) === null) throw new SetupError("not inside a git checkout");
  const listPath = options.list ?? defaultListPath(env);
  // The denylist is optional here (CI has none); check-private.mjs already insists on it for local commits.
  const privateRules = options.privateList && (options.list || existsSync(listPath)) ? loadDenylist(listPath) : [];
  const scope = options.history || options.range ? commits(cwd, options.range ?? "HEAD") : { ...nextCommit(cwd), count: null };
  const problems = [...(scope.problems ?? []), ...scope.identities.flatMap((identity) => judge(identity, privateRules))];
  return { commits: scope.count, identities: scope.identities.length, problems, privateList: privateRules.length > 0 };
}

function main() {
  let result;
  try {
    result = run(process.argv.slice(2));
  } catch (error) {
    console.error(`check-identity: ${error instanceof SetupError ? error.message : String(error)}`);
    return EXIT.setup;
  }
  for (const problem of result.problems) console.error(`check-identity: ${problem}`);
  const scope = result.commits === null ? "next commit" : `${result.commits} commit(s)`;
  const list = result.privateList ? "with" : "without";
  console.log(`check-identity: ${scope}, ${result.identities} identit(ies) checked ${list} the private denylist, ${result.problems.length} problem(s)`);
  if (result.problems.length > 0) {
    console.error("check-identity: use git config user.name \"paseo-fleet contributors\" and git config user.email noreply@example.invalid (or your GitHub noreply address)");
  }
  return result.problems.length > 0 ? EXIT.hits : EXIT.clean;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
