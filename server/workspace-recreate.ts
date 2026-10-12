/// <reference types="node" />
import { t } from "../shared/i18n";
import { basename, join } from "node:path";
import { existsSync, statSync } from "./perf-fs";
import { getDb } from "./db";
import type { AgentLauncher } from "./dispatch";
import { KanbanError } from "./errors";
import { headRef, isProtectedBranch, resolveWorktreeBase, runGit, type GitRunner } from "./git";
import { directoryState } from "./missing-cwd";
import { pickWorkspace, samePath } from "./placement";
import { readOnlyBranchName } from "./readonly-worktree";
import { appendEvent, getTask, type TaskRow } from "./store";
import { isTempWorkspace } from "./temp-mark";
import { cardMark } from "./card-ref";
import { branchOwnedByCard } from "./workspace";
import { commitWorktree, discardRecordedWorktree, readWorktreeCreated, type WorktreeRecord } from "./worktree-record";

import { holdCleanupCard } from "./cleanup-state";
import { DEFAULT_ARCHIVE_TIMEOUT_MS, loadConfig } from "./config";

export const RECREATE_FAILED = "workspace_recreate_failed";

export interface RecreatedPlacement {
  cwd: string;
  workspaceId?: string;
  name?: string | null;
}

/**
 * True when the card's recorded worktree directory is gone, or only a patrol placeholder is left.
 * A directory with a `.git` entry is a live checkout even if the repository tracks a file named like the placeholder.
 */
export function worktreeDirectoryLost(saved: { directory?: string } | null | undefined): boolean {
  if (!saved?.directory) return false;
  if (existsSync(saved.directory) && statSync(saved.directory).isDirectory() && existsSync(join(saved.directory, ".git"))) return false;
  return directoryState(saved.directory) !== "present" || !statSync(saved.directory).isDirectory();
}

/** Paseo cuts a longer worktree slug at a hyphen (`MAX_SLUG_LENGTH` in @getpaseo/protocol/branch-slug), which could drop the rebuild number. */
const PASEO_SLUG_LIMIT = 50;

/** Paseo's slug shape: lowercase letters, digits and single hyphens. */
function slugText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * Directory name for a rebuilt copy: the old name plus `-r<n>`, never a name this card used before.
 * Paseo's auto-archive-on-merge remembers per path that it saw the card's PR open, and a new workspace
 * at the same path is archived again within seconds once that PR is merged (DEMO_0001, 2026-10-06).
 */
export function rebuildSlug(taskId: number, oldDirectory: string): string {
  const rows = getDb()
    .prepare(`SELECT kind, json_extract(data_json, '$.directory') AS directory FROM events
      WHERE task_id = ? AND kind IN ('worktree_created', 'temp_workspace_recreated')`)
    .all(taskId) as Array<{ kind: string; directory: unknown }>;
  const used = new Set(rows.map((row) => (typeof row.directory === "string" ? basename(row.directory) : "")).concat(basename(oldDirectory)));
  const stem = slugText(basename(oldDirectory).replace(/-r\d+(?:-\d+)?$/, "")) || "kanban";
  for (let n = rows.filter((row) => row.kind === "temp_workspace_recreated").length + 1; ; n += 1) {
    const suffix = `-r${n}`;
    const slug = `${stem.slice(0, PASEO_SLUG_LIMIT - suffix.length).replace(/-+$/, "")}${suffix}`;
    if (!used.has(slug)) return slug;
  }
}

/** Branch names reach git as separate arguments, so only flag-like or revision-like shapes are refused. */
function branchSafe(branch: string): boolean {
  return branch.length > 0 && !branch.startsWith("-") && !/[\s\u0000-\u001f~^:?*[\\]|\.\./.test(branch);
}

function fail(message: string): never {
  throw new KanbanError(RECREATE_FAILED, message);
}

/** Why this rebuild may not free the branch name: only the card's own branch, never a protected or base name. */
function branchRefusal(taskId: number, branch: string, readOnly: boolean, base: string): string | null {
  if (isProtectedBranch(branch) || branch === base) return t("workspaceRecreate.protectedBranch", { branch });
  const own = readOnly ? branch === readOnlyBranchName(taskId) : branchOwnedByCard(taskId, branch);
  return own ? null : t("workspaceRecreate.foreignBranch", { branch });
}

/** The only `update-ref -d` the board runs: the card's own branch, at the exact tip it just read. */
function releaseArgs(taskId: number, branch: string, tip: string, readOnly: boolean, base: string): string[] {
  const refused = branchRefusal(taskId, branch, readOnly, base);
  if (refused) fail(refused);
  return ["update-ref", "-d", headRef(branch), tip];
}

async function branchTip(root: string, branch: string, run: GitRunner): Promise<string | null> {
  if (!branchSafe(branch)) return null;
  const result = await run(root, ["rev-parse", "--verify", "--quiet", `${headRef(branch)}^{commit}`]);
  return result.code === 0 && result.stdout.trim() ? result.stdout.trim() : null;
}

/** A branch still checked out in a live directory cannot move to a new worktree. */
async function checkedOutElsewhere(root: string, branch: string, run: GitRunner): Promise<string | null> {
  const listed = await run(root, ["worktree", "list", "--porcelain"]);
  if (listed.code !== 0) return null;
  let current = "";
  for (const line of listed.stdout.split("\n")) {
    if (line.startsWith("worktree ")) current = line.slice("worktree ".length).trim();
    if (line.trim() === `branch ${headRef(branch)}` && current && existsSync(current)) return current;
  }
  return null;
}

/**
 * The card's temporary workspace directory is gone (Paseo's auto-archive-on-merge, a manual delete, a crash).
 * Rebuild it so the card can start or resume instead of sticking in blocked:
 * - the card branch still exists: a new worktree on that branch, same tip;
 * - the branch is gone: a new worktree from the card base, as at card creation.
 * The copy goes to a path the card has not used (`rebuildSlug`), so Paseo's merge auto-archive does not take it again.
 * The old Paseo workspace record is archived first so two do not stay open.
 * Any failure throws RECREATE_FAILED; the caller blocks the card as needs_human with that message.
 */
export async function recreateWorkspace(input: {
  task: TaskRow;
  launcher: AgentLauncher;
  claimToken: string;
  actor: string;
  reason: string;
  /** A borrowed copy's record (independent review): the card has none of its own, so build a read-only copy from it. */
  synthetic?: WorktreeRecord;
  run?: GitRunner;
}): Promise<RecreatedPlacement> {
  const release = await holdCleanupCard(input.task.id, 2 * (loadConfig().archiveTimeoutMs ?? DEFAULT_ARCHIVE_TIMEOUT_MS), input.claimToken);
  if (!release) throw new KanbanError("not_ready", t("cleanup.error.busy"));
  try { return await recreateWorkspaceLocked({ ...input, task: getTask(input.task.id) }); }
  finally { release(); }
}

async function recreateWorkspaceLocked(input: Parameters<typeof recreateWorkspace>[0]): Promise<RecreatedPlacement> {
  const { task, launcher, claimToken, actor, reason } = input;
  const run = input.run ?? runGit;
  const saved: WorktreeRecord | null = input.synthetic ?? readWorktreeCreated(task.id);
  if (!saved?.directory) fail(t("workspaceRecreate.noRecord"));
  const root = saved.root || task.workspace_path || "";
  if (!root || !existsSync(root) || !statSync(root).isDirectory()) fail(t("workspaceRecreate.noRepo", { path: root || t("workspaceRecreate.notFilled") }));
  if (!launcher.createWorktree) fail(t("workspaceRecreate.noCreateWorktree"));
  const readOnly = saved.readOnly === true;
  const temp = input.synthetic ? true : isTempWorkspace(task.id);
  const code = cardMark(task.id);
  const branch = readOnly ? readOnlyBranchName(task.id) : (saved.branch ?? "");
  if (!branchSafe(branch)) fail(t("workspaceRecreate.badBranch", { branch: saved.branch ?? t("workspaceRecreate.notRecorded") }));
  const base = saved.base || task.workspace_base || "main";
  // Checked before any side effect, so a foreign record archives nothing and frees nothing.
  const refused = branchRefusal(task.id, branch, readOnly, base);
  if (refused) fail(refused);
  const listed = launcher.listWorkspaces ? await launcher.listWorkspaces() : [];
  const main = pickWorkspace(listed, root);
  const projectId = main?.projectId;

  const tip = await branchTip(root, branch, run);
  let startRef: string;
  let usedRef: "branch" | "base";
  if (tip) {
    startRef = tip;
    usedRef = "branch";
  } else if (readOnly && saved.head) {
    startRef = saved.head;
    usedRef = "base";
  } else {
    const resolved = await resolveWorktreeBase(root, base, run);
    if ("error" in resolved) fail(t("workspaceRecreate.baseFailed", { base, error: resolved.error }));
    startRef = resolved.ref;
    usedRef = "base";
  }

  const oldWorkspaceId = saved.workspaceId ?? null;
  let archivedOld = false;
  let archiveError: string | undefined;
  if (oldWorkspaceId && oldWorkspaceId !== main?.id && launcher.archiveWorkspace) {
    try {
      await launcher.archiveWorkspace(oldWorkspaceId);
      archivedOld = true;
    } catch (err) {
      // An already-archived record answers with an error too; the new workspace below still goes ahead.
      archiveError = err instanceof Error ? err.message : String(err);
    }
  }
  const pruned = await run(root, ["worktree", "prune"]);
  if (pruned.code !== 0) fail(t("workspaceRecreate.pruneFailed", { error: (pruned.stderr || pruned.stdout).trim() }));
  if (tip) {
    const elsewhere = await checkedOutElsewhere(root, branch, run);
    if (elsewhere) fail(t("workspaceRecreate.branchElsewhere", { branch, path: elsewhere }));
    // Free the name for the new worktree. The exact-tip guard keeps this from losing a moved branch; the tip is the start ref below.
    const dropped = await run(root, releaseArgs(task.id, branch, tip, readOnly, base));
    if (dropped.code !== 0) fail(t("workspaceRecreate.releaseFailed", { branch, error: (dropped.stderr || dropped.stdout).trim() }));
  }
  const restore = async (): Promise<void> => {
    if (tip) await run(root, ["update-ref", headRef(branch), tip]);
  };

  // A borrowed record is another card's path; the review copy keeps Paseo's name from its read-only branch.
  const worktreeSlug = input.synthetic ? undefined : rebuildSlug(task.id, saved.directory);
  let created: Awaited<ReturnType<NonNullable<AgentLauncher["createWorktree"]>>>;
  try {
    created = await launcher.createWorktree({
      cwd: root,
      branchName: branch,
      baseBranch: startRef,
      projectId,
      ...(temp ? { title: code } : {}),
      ...(readOnly ? { readOnly: true } : {}),
      ...(worktreeSlug ? { worktreeSlug } : {}),
    });
  } catch (err) {
    await restore();
    fail(t("workspaceRecreate.createFailed", { error: err instanceof Error ? err.message : String(err) }));
  }
  const directory = created.directory;
  if (!directory || !existsSync(directory) || !statSync(directory).isDirectory()) {
    await restore();
    fail(t("workspaceRecreate.createdNoDirectory", { path: directory ?? t("workspaceRecreate.noDirectoryReturned") }));
  }
  if (launcher.listWorkspaces && !created.workspaceId) {
    await restore();
    fail(t("workspaceRecreate.noWorkspaceId"));
  }
  if (main && created.workspaceId === main.id) {
    await restore();
    fail(t("workspaceRecreate.isMain"));
  }

  // The old record must stop counting before the new one is written, or it would look like a rival copy.
  discardRecordedWorktree(task.id, saved.directory);
  const recorded = commitWorktree({
    taskId: task.id,
    token: claimToken,
    directory,
    data: {
      directory,
      branch,
      base,
      ref: startRef,
      root,
      workspaceId: created.workspaceId ?? null,
      name: temp ? code : (created.name ?? null),
      projectId: projectId ?? null,
      recreated: true,
      ...(temp ? { temp: true } : {}),
      ...(readOnly ? { readOnly: true, head: created.head ?? saved.head } : {}),
    },
    temp: temp ? { base, actor, holderId: null, code, root, directory } : null,
  });
  if (!recorded.ok) fail(t("workspaceRecreate.claimLost"));
  appendEvent(task.id, "temp_workspace_recreated", null, null, actor, {
    reason,
    oldDirectory: saved.directory,
    directory,
    branch,
    usedRef,
    ref: startRef,
    oldWorkspaceId,
    workspaceId: created.workspaceId ?? null,
    archivedOld,
    ...(archiveError ? { archiveError } : {}),
    ...(worktreeSlug ? { worktreeSlug } : {}),
    // False means Paseo put the copy back on the old path, where its merge auto-archive may strike again.
    freshPath: !samePath(directory, saved.directory),
  });
  return { cwd: directory, workspaceId: created.workspaceId, name: temp ? code : (created.name ?? directory) };
}

/**
 * An independent review borrows the reviewed card's copy. When that directory is gone or only a placeholder,
 * build the review card its own read-only copy: the reviewed branch tip, else the recorded head, else the base.
 * A copy this review card already built is reused (or rebuilt) first.
 */
export async function recreateReviewCopy(input: {
  task: TaskRow;
  original: TaskRow;
  lostDirectory: string;
  launcher: AgentLauncher;
  claimToken: string;
  actor: string;
  run?: GitRunner;
}): Promise<RecreatedPlacement> {
  const { task, original, lostDirectory, launcher, claimToken, actor } = input;
  const own = readWorktreeCreated(task.id);
  if (own?.directory) {
    if (!worktreeDirectoryLost(own)) {
      return { cwd: own.directory, workspaceId: own.workspaceId ?? undefined, name: own.name ?? own.directory };
    }
    return recreateWorkspace({ task, launcher, claimToken, actor, reason: t("workspaceRecreate.reviewCopyMissing", { path: own.directory }), run: input.run });
  }
  const theirs = readWorktreeCreated(original.id);
  const root = theirs?.root || original.workspace_path || "";
  const tip = theirs?.branch ? await branchTip(root, theirs.branch, input.run ?? runGit) : null;
  return recreateWorkspace({
    task,
    launcher,
    claimToken,
    actor,
    reason: t("workspaceRecreate.reviewedCopyMissing", { path: lostDirectory }),
    synthetic: {
      directory: lostDirectory,
      root,
      base: theirs?.base || original.workspace_base || "main",
      branch: readOnlyBranchName(task.id),
      workspaceId: null,
      readOnly: true,
      head: tip ?? theirs?.head,
    },
    run: input.run,
  });
}
