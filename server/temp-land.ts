/// <reference types="node" />
import { resolve } from "node:path";
import { t } from "../shared/i18n";
import { cardMark } from "./card-ref";
import { getDb } from "./db";
import { headRef, runGit, type GitRunner } from "./git";
import { directoryState } from "./missing-cwd";
import { readContract } from "./pr";
import { openPendingLandIds, pendingLand, recordLandPending } from "./land-pending";
import { addComment, appendEvent, getTask, type TaskRow } from "./store";
import { notifyLandConflict } from "./wake";
import { isTempWorkspace } from "./temp-mark";
import { judgedWorktree } from "./branch-observed";
import { createdWorktree, ownedWorktree, worktreeOwnershipError, type OwnedWorktree } from "./worktree-gc";

function failure(result: { stderr: string; stdout: string }, fallback: string): string {
  return (result.stderr || result.stdout || fallback).trim();
}

function lines(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export type LandPlan =
  | { kind: "none" }
  | { kind: "note"; reason: string }
  | { kind: "refuse"; message: string }
  | { kind: "land"; owned: OwnedWorktree };

/**
 * Whether accept should merge this card.
 * A temp mark with no worktree record is reported, not merged.
 * A record that fails the ownership checks is refused, so the card cannot be marked done with the branch left behind.
 */
export function landPlan(task: TaskRow): LandPlan {
  if (!isTempWorkspace(task.id)) return { kind: "none" };
  const inspection = createdWorktree(task.id);
  if (inspection?.readOnly === true) {
    const problem = worktreeOwnershipError(task.id, inspection);
    return problem ? { kind: "refuse", message: problem } : { kind: "none" };
  }
  const contract = readContract(task.contract_json);
  if (contract.pr) return { kind: "note", reason: t("tempLand.note.viaPr") };
  if (contract.kind === "github") return { kind: "note", reason: t("tempLand.note.viaGithub") };
  const created = createdWorktree(task.id);
  if (!created) return { kind: "note", reason: t("tempLand.note.noWorktree") };
  const problem = worktreeOwnershipError(task.id, created);
  if (problem) return { kind: "refuse", message: problem };
  const owned = ownedWorktree(task.id, created);
  if (!owned) return { kind: "refuse", message: t("tempLand.refuse.notOwned") };
  return { kind: "land", owned: judgedWorktree(task.id, owned) };
}

export type LandResult =
  | { kind: "skip"; message: string }
  | { kind: "merged"; commits: string[] }
  | { kind: "refuse"; message: string }
  | { kind: "conflict"; message: string; files: string[]; other: string | null; base: string }
  | { kind: "pending"; reason: string; branch: string; base: string };

function otherCard(task: TaskRow, files: string[]): string | null {
  const wanted = new Set(files);
  const rows = getDb()
    .prepare(
      `SELECT e.task_id AS task_id, e.data_json AS data_json FROM events e
       JOIN tasks t ON t.id = e.task_id
       WHERE e.kind = 'landed' AND t.project = ? AND e.task_id != ?
       ORDER BY e.id DESC`,
    )
    .all(task.project, task.id) as Array<{ task_id: number; data_json: string }>;
  for (const row of rows) {
    try {
      const data = JSON.parse(row.data_json) as { files?: unknown };
      const theirs = Array.isArray(data.files) ? data.files.filter((file): file is string => typeof file === "string") : [];
      if (theirs.some((file) => wanted.has(file))) return cardMark(row.task_id);
    } catch {
      continue;
    }
  }
  return null;
}

const landChains = new Map<string, Promise<void>>();

function withRepoLock<T>(root: string, run: () => Promise<T>): Promise<T> {
  const key = resolve(root);
  const previous = landChains.get(key) ?? Promise.resolve();
  const result = previous.then(run, run);
  landChains.set(
    key,
    result.then(
      () => undefined,
      () => undefined,
    ),
  );
  return result;
}

/**
 * Fast-forward the card branch onto the local base.
 * When that cannot move forward, rebase inside the temporary workspace and fast-forward again.
 * A rebase conflict does not accept the card.
 * Two accepts on the same repository wait, so they do not fight over HEAD.
 */
export async function landLocalBranch(task: TaskRow, owned: OwnedWorktree, actor: string, run: GitRunner = (cwd, args) => runGit(cwd, args)): Promise<LandResult> {
  return withRepoLock(owned.root, () => landLocalBranchInner(task, owned, actor, run));
}

async function landLocalBranchInner(task: TaskRow, owned: OwnedWorktree, actor: string, run: GitRunner): Promise<LandResult> {
  const remotes = await run(owned.root, ["remote"]);
  if (remotes.code !== 0) return { kind: "refuse", message: failure(remotes, t("tempLand.gitFailed", { command: "git remote" })) };
  if (lines(remotes.stdout).includes("origin")) return { kind: "skip", message: t("tempLand.skip.hasRemote") };
  const status = await run(owned.root, ["status", "--porcelain"]);
  if (status.code !== 0) return { kind: "refuse", message: failure(status, t("tempLand.gitFailed", { command: "git status" })) };
  if (status.stdout.trim()) {
    return { kind: "pending", reason: dirtyReason(owned, status.stdout), branch: owned.branch, base: owned.base };
  }
  const head = await run(owned.root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (head.code !== 0) return { kind: "refuse", message: failure(head, t("tempLand.gitFailed", { command: "git rev-parse" })) };
  if (head.stdout.trim() !== owned.base) {
    return { kind: "refuse", message: t("tempLand.refuse.mainOnOtherBranch", { head: head.stdout.trim(), base: owned.base }) };
  }
  const before = await run(owned.root, ["rev-parse", "HEAD"]);
  if (before.code !== 0) return { kind: "refuse", message: failure(before, t("tempLand.gitFailed", { command: "git rev-parse" })) };
  const merged = await fastForward(owned, run);
  if (merged.kind === "ok") return finish(task, owned, actor, before.stdout.trim(), run);
  if (merged.kind === "refuse") return merged;
  if (directoryState(owned.directory) !== "present") return { kind: "refuse", message: t("tempLand.refuse.directoryGone") };
  const ready = await onJudgedBranch(owned, run);
  if (ready.kind === "refuse") return ready;
  const rebase = await run(owned.directory, ["rebase", headRef(owned.base)]);
  if (rebase.code !== 0) {
    const unmerged = await run(owned.directory, ["diff", "--name-only", "--diff-filter=U"]);
    await run(owned.directory, ["rebase", "--abort"]);
    const files = lines(unmerged.stdout);
    if (files.length === 0) return { kind: "refuse", message: failure(rebase, t("tempLand.gitFailed", { command: "git rebase" })) };
    const other = otherCard(task, files);
    const where = files.join(t("common.listSep"));
    const message = other
      ? t("tempLand.conflict.withCard", { other })
      : t("tempLand.conflict.withMain", { files: where });
    return { kind: "conflict", message, files, other, base: owned.base };
  }
  const again = await fastForward(owned, run);
  if (again.kind !== "ok") return { kind: "refuse", message: again.kind === "refuse" ? again.message : t("tempLand.refuse.noFastForward") };
  return finish(task, owned, actor, before.stdout.trim(), run);
}

/** Rebase has to run on the branch being landed. A dirty tree is left untouched. */
async function onJudgedBranch(owned: OwnedWorktree, run: GitRunner): Promise<{ kind: "ok" } | { kind: "refuse"; message: string }> {
  const here = await run(owned.directory, ["branch", "--show-current"]);
  if (here.code !== 0) return { kind: "refuse", message: failure(here, t("tempLand.gitFailed", { command: "git branch" })) };
  if (here.stdout.trim() === owned.branch) return { kind: "ok" };
  const dirty = await run(owned.directory, ["status", "--porcelain"]);
  if (dirty.code !== 0) return { kind: "refuse", message: failure(dirty, t("tempLand.gitFailed", { command: "git status" })) };
  if (dirty.stdout.trim()) return { kind: "refuse", message: t("tempLand.refuse.tempDirty") };
  const switched = await run(owned.directory, ["checkout", owned.branch]);
  if (switched.code !== 0) return { kind: "refuse", message: failure(switched, t("tempLand.gitFailed", { command: "git checkout" })) };
  return { kind: "ok" };
}

async function fastForward(owned: OwnedWorktree, run: GitRunner): Promise<{ kind: "ok" } | { kind: "retry" } | { kind: "refuse"; message: string }> {
  const branch = headRef(owned.branch);
  const base = headRef(owned.base);
  const contained = await run(owned.root, ["merge-base", "--is-ancestor", branch, base]);
  if (contained.code === 0) return { kind: "ok" };
  const baseBehind = await run(owned.root, ["merge-base", "--is-ancestor", base, branch]);
  if (baseBehind.code === 0) {
    const merged = await run(owned.root, ["merge", "--ff-only", branch]);
    if (merged.code === 0) return { kind: "ok" };
    return { kind: "refuse", message: failure(merged, t("tempLand.gitFailed", { command: "git merge --ff-only" })) };
  }
  if (contained.code === 1 && baseBehind.code === 1) return { kind: "retry" };
  const failed = contained.code === 1 ? baseBehind : contained;
  return { kind: "refuse", message: failure(failed, t("tempLand.gitFailed", { command: "git merge-base" })) };
}

async function finish(task: TaskRow, owned: OwnedWorktree, actor: string, before: string, run: GitRunner): Promise<LandResult> {
  const listed = await run(owned.root, ["log", "--format=%h %s", `${before}..HEAD`]);
  if (listed.code !== 0) return { kind: "refuse", message: failure(listed, t("tempLand.gitFailed", { command: "git log" })) };
  const files = await run(owned.root, ["diff", "--name-only", before, "HEAD"]);
  if (files.code !== 0) return { kind: "refuse", message: failure(files, t("tempLand.gitFailed", { command: "git diff" })) };
  const commits = lines(listed.stdout);
  const already = getDb().prepare("SELECT id FROM events WHERE task_id = ? AND kind = 'landed' LIMIT 1").get(task.id);
  if (!already) {
    appendEvent(task.id, "landed", null, task.status, actor, {
      files: lines(files.stdout),
      commits,
      branch: owned.branch,
      base: owned.base,
    });
  }
  getDb().prepare("UPDATE tasks SET land_conflict_count = 0 WHERE id = ?").run(task.id);
  return { kind: "merged", commits };
}

function dirtyReason(owned: OwnedWorktree, stdout: string): string {
  const dirty = lines(stdout);
  const shown = dirty.slice(0, 6).join(t("common.listSep"));
  const extra = dirty.length > 6 ? t("tempLand.dirty.more", { count: dirty.length }) : "";
  const list = [shown, extra].filter(Boolean).join(t("common.comma"));
  return t("tempLand.dirty.mainDirty", { branch: owned.branch, base: owned.base, list: list ? t("common.paren", { text: list }) : "" });
}

/** A conflict someone is already editing must not be rebased again. */
async function conflictEditInProgress(directory: string, conflict: boolean): Promise<boolean> {
  if (!conflict || directoryState(directory) !== "present") return false;
  const status = await runGit(directory, ["status", "--porcelain"]);
  if (status.code !== 0) return true;
  return Boolean(status.stdout.trim());
}

function conflictDetail(message: string, files: string[]): string {
  if (files.length === 0) return message;
  const where = files.join(t("common.listSep"));
  if (message.includes(where)) return message;
  return t("tempLand.conflict.detail", { message, files: where });
}

/**
 * Land cards that were accepted while the main directory was dirty.
 * A conflict is recorded and the project leader is woken once. The worktree stays.
 */
export async function resumePendingLands(actor = "scheduler"): Promise<void> {
  for (const id of openPendingLandIds()) {
    try {
      await resumeOne(id, actor);
    } catch (err) {
      console.error("[paseo-kanban] land", err instanceof Error ? err.message : err);
    }
  }
}

async function resumeOne(id: number, actor: string): Promise<void> {
  const task = getTask(id);
  if (task.status !== "done" && task.status !== "archived") return;
  const plan = landPlan(task);
  if (plan.kind !== "land") {
    if (plan.kind === "none") return;
    const reason = plan.kind === "refuse" ? plan.message : plan.reason;
    recordLandPending(task.id, task.status, actor, { reason, branch: "", base: "" });
    return;
  }
  const pending = pendingLand(task.id);
  if (await conflictEditInProgress(plan.owned.directory, pending?.conflict === true)) return;
  const landed = await landLocalBranch(task, plan.owned, actor);
  if (landed.kind === "pending") {
    recordLandPending(task.id, task.status, actor, { reason: landed.reason, branch: landed.branch, base: landed.base });
    return;
  }
  if (landed.kind === "merged") {
    const lines = landed.commits.length ? landed.commits.map((line) => t("tempLand.landed.commit", { commit: line })).join("\n") : t("tempLand.landed.noCommits");
    addComment(task.id, actor, t("tempLand.landed.comment", { base: plan.owned.base, lines }));
    return;
  }
  if (landed.kind === "conflict") {
    const reason = conflictDetail(landed.message, landed.files);
    const wrote = recordLandPending(task.id, task.status, actor, {
      reason,
      branch: plan.owned.branch,
      base: plan.owned.base,
      conflict: true,
      files: landed.files,
    });
    if (wrote) addComment(task.id, actor, t("tempLand.conflict.notLanded", { reason }));
    notifyLandConflict(task.id, t("tempLand.conflict.notLanded", { reason }));
    return;
  }
  recordLandPending(task.id, task.status, actor, {
    reason: landed.message,
    branch: plan.owned.branch,
    base: plan.owned.base,
  });
}
