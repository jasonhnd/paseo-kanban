/// <reference types="node" />
import { existsSync } from "./perf-fs";
import { getDb } from "./db";
import { headRef, isProtectedBranch, originRef, refOk, runGitSync } from "./git";
import { samePath } from "./placement";
import { appendEvent, type TaskRow } from "./store";
import { readWorktreeCreated } from "./worktree-record";
import type { OwnedWorktree } from "./worktree-gc";

export interface BranchObserved {
  branch: string;
  head: string;
  pushed: boolean;
}

/** Latest checkout the executor reported by completing in the card directory. */
export function readBranchObserved(taskId: number): BranchObserved | null {
  const row = getDb()
    .prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'branch_observed' ORDER BY id DESC LIMIT 1")
    .get(taskId) as { data_json: string } | undefined;
  if (!row) return null;
  try {
    const data = JSON.parse(row.data_json) as { branch?: unknown; head?: unknown; pushed?: unknown };
    if (typeof data.branch !== "string" || !data.branch.trim()) return null;
    return {
      branch: data.branch.trim(),
      head: typeof data.head === "string" ? data.head.trim() : "",
      pushed: data.pushed === true,
    };
  } catch {
    return null;
  }
}

/**
 * Branch land and cleanup should judge.
 * The recorded kanban branch still identifies the worktree. A different checkout
 * is used only when the name is a normal feature branch.
 */
export function judgedWorktree(taskId: number, owned: OwnedWorktree): OwnedWorktree {
  const observed = readBranchObserved(taskId);
  if (!observed || observed.branch === owned.branch) return owned;
  if (!refOk(observed.branch) || observed.branch === owned.base || isProtectedBranch(observed.branch)) return owned;
  return { ...owned, branch: observed.branch };
}

function pushedSync(directory: string, branch: string, head: string): boolean {
  const upstream = runGitSync(directory, ["rev-parse", "--symbolic-full-name", `${headRef(branch)}@{upstream}`]);
  if (upstream.code === 0) {
    const name = upstream.stdout.trim();
    if (name.startsWith("refs/")) return runGitSync(directory, ["merge-base", "--is-ancestor", head, name]).code === 0;
  }
  if (!refOk(branch)) return false;
  const remote = originRef(branch);
  if (runGitSync(directory, ["rev-parse", "--verify", "--quiet", remote]).code !== 0) return false;
  return runGitSync(directory, ["merge-base", "--is-ancestor", head, remote]).code === 0;
}

/**
 * On executor complete, remember the worktree's current branch when it is not
 * the branch the board created. A later complete that is back on the created
 * branch records that too, so the older checkout stops being the actual branch.
 * Failure to read git does not block the complete.
 */
export function noteObservedBranch(task: TaskRow, actor: string): void {
  if (actor !== "executor") return;
  try {
    const created = readWorktreeCreated(task.id);
    if (!created?.directory || !created.branch || !created.root) return;
    if (samePath(created.directory, created.root)) return;
    if (!existsSync(created.directory)) return;
    const current = runGitSync(created.directory, ["branch", "--show-current"]);
    const head = runGitSync(created.directory, ["rev-parse", "HEAD"]);
    if (current.code !== 0 || head.code !== 0) return;
    const branch = current.stdout.trim();
    const sha = head.stdout.trim();
    if (!branch || !refOk(branch) || !/^[0-9a-f]{7,40}$/i.test(sha)) return;
    const previous = readBranchObserved(task.id);
    const changed = branch !== created.branch;
    if (!changed && (!previous || previous.branch === created.branch)) return;
    const pushed = pushedSync(created.directory, branch, sha);
    if (previous && previous.branch === branch && previous.head === sha && previous.pushed === pushed) return;
    appendEvent(task.id, "branch_observed", null, null, actor, { branch, head: sha, pushed });
  } catch (err) {
    console.error("[paseo-kanban] branch_observed", err instanceof Error ? err.message : err);
  }
}
