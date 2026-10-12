/// <reference types="node" />
import { execFile, execFileSync } from "node:child_process";
import { branchOwnedByCard } from "./workspace";
import { t } from "../shared/i18n";

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type GitRunner = (cwd: string, args: string[]) => Promise<GitResult>;

const SAFE_REF = /^[\w./-]+$/;

export function refOk(value: string): boolean {
  return SAFE_REF.test(value) && !value.startsWith("-") && !value.includes("..");
}

/** Local branch tip. A short name can resolve to a tag of the same name. */
export function headRef(branch: string): string {
  return `refs/heads/${branch}`;
}

/** Remote-tracking tip. A short origin/<base> can also be ambiguous. */
export function originRef(base: string): string {
  return `refs/remotes/origin/${base}`;
}

/**
 * Refuse a forced delete or a push. Callers only remove a merged local branch.
 * The one exception is deleteSquashedBranch below, which never passes through here.
 */
export function assertSafeGit(args: string[]): void {
  if (args.includes("--force") || args.includes("-D") || args.includes("push") || args[0] === "push") {
    throw new Error(t("git.refused.args", { args: args.join(" ") }));
  }
}

function execGit(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, maxBuffer: 1_000_000 }, (err, stdout, stderr) => {
      if (!err) {
        resolve({ code: 0, stdout: String(stdout), stderr: String(stderr) });
        return;
      }
      const raw = err as { code?: unknown };
      const exit = typeof raw.code === "number" ? raw.code : 1;
      resolve({ code: exit, stdout: String(stdout ?? ""), stderr: String(stderr || err.message) });
    });
  });
}

function realGit(cwd: string, args: string[]): Promise<GitResult> {
  assertSafeGit(args);
  return execGit(cwd, args);
}

/** A card branch git can take as one ref: no spaces, no revision punctuation, not a flag. */
function deletableBranch(branch: string): boolean {
  return branch.length > 0 && !branch.startsWith("-") && !/[\s\u0000-\u001f~^:?*[\\]|\.\./.test(branch);
}

/**
 * The only `git branch -D` the board runs, after the caller has a basis that
 * deleting loses nothing. This checks the shape once more: exactly
 * `branch -D kanban/<taskId>-…` or `kanban/<card number>-…`, nothing else.
 */
export function squashDeleteArgs(taskId: number, branch: string): string[] {
  if (!Number.isInteger(taskId) || taskId <= 0 || !deletableBranch(branch) || !branchOwnedByCard(taskId, branch)) {
    throw new Error(t("git.refused.deleteBranch", { branch }));
  }
  return ["branch", "-D", branch];
}

export function deleteSquashedBranch(cwd: string, taskId: number, branch: string, run: GitRunner = execGit): Promise<GitResult> {
  return run(cwd, squashDeleteArgs(taskId, branch));
}

/**
 * The only worktree removal that passes --force. It bypasses assertSafeGit, same as
 * deleteSquashedBranch. The directory must already be the card's read-only copy.
 */
export function readOnlyRemoveArgs(directory: string): string[] {
  if (!directory.startsWith("/") || directory.startsWith("-") || /[\0\r\n]/.test(directory)) {
    throw new Error(t("git.refused.removeWorktree", { directory }));
  }
  return ["worktree", "remove", "--force", directory];
}

export function removeReadOnlyWorktree(root: string, directory: string, run: GitRunner = execGit): Promise<GitResult> {
  return run(root, readOnlyRemoveArgs(directory));
}

export function runGit(cwd: string, args: string[], run: GitRunner = realGit): Promise<GitResult> {
  assertSafeGit(args);
  return run(cwd, args);
}

/** A blocking git read. Non-zero exits are results, not thrown errors. */
export function runGitSync(cwd: string, args: string[]): GitResult {
  assertSafeGit(args);
  try {
    const stdout = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 1_000_000,
    });
    return { code: 0, stdout: String(stdout), stderr: "" };
  } catch (err) {
    const raw = err as { status?: unknown; stdout?: unknown; stderr?: unknown; message?: string };
    const code = typeof raw.status === "number" ? raw.status : 1;
    return { code, stdout: String(raw.stdout ?? ""), stderr: String(raw.stderr || raw.message || "") };
  }
}

/** Branches the board must never delete or auto-commit onto, even if a card's checkout was moved there. */
const PROTECTED_BRANCHES = new Set(["main", "master", "pre", "preview", "develop", "release", "HEAD"]);

export function isProtectedBranch(branch: string): boolean {
  return PROTECTED_BRANCHES.has(branch);
}

function remoteNames(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * Branch from origin/<base> after fetching it. No remote (or not a git repo) uses the local base.
 * A failed fetch does not invent a ref: the caller must not start the card.
 */
export async function resolveWorktreeBase(
  root: string,
  base: string,
  run: GitRunner = realGit,
): Promise<{ ref: string } | { error: string }> {
  if (!refOk(base)) return { error: t("git.base.invalid", { base }) };
  const remotes = await run(root, ["remote"]);
  if (remotes.code !== 0) return { ref: base };
  if (!remoteNames(remotes.stdout).includes("origin")) return { ref: base };
  const fetched = await run(root, ["fetch", "origin", base]);
  if (fetched.code !== 0) {
    const detail = (fetched.stderr || fetched.stdout || t("git.fetch.failedDefault")).trim();
    return { error: t("git.fetch.failed", { base, detail }) };
  }
  return { ref: `origin/${base}` };
}
