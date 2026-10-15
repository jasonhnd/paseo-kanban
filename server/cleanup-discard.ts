import { t } from "../shared/i18n";
import { cleanupGeneration, currentCleanupSql, tryHoldCleanupCard } from "./cleanup-state";
import { getDb } from "./db";
import { KanbanError } from "./errors";
import { headRef, isProtectedBranch, refOk, runGit, type GitRunner } from "./git";
import { directoryState } from "./missing-cwd";
import { pendingLand } from "./land-pending";
import { samePath } from "./placement";
import { lstatSync } from "./perf-fs";
import { appendEvent, getTask, type TaskRow } from "./store";
import { isTempWorkspace, tempCleaned } from "./temp-mark";
import { createdWorktree, ownedWorktree, type OwnedWorktree } from "./worktree-gc";

export interface DiscardAuthorization extends OwnedWorktree {
  authorizationId?: number;
  cleanupGeneration: number;
  workspaceId: string | null;
  actor: string;
  head: string;
  baseOid: string;
  commits: Array<{ sha: string; subject: string }>;
}

function eligible(task: TaskRow, owned: OwnedWorktree): boolean {
  return (task.status === "done" || task.status === "archived") && isTempWorkspace(task.id) && !tempCleaned(task.id) &&
    !pendingLand(task.id) && !owned.readOnly && refOk(owned.base) && refOk(owned.branch) &&
    owned.branch !== owned.base && !isProtectedBranch(owned.branch) && samePath(task.workspace_path, owned.directory);
}

/** A grant is limited to one cleanup generation, owned copy and exact branch/base tips. */
export function discardAuthorization(task: TaskRow, owned: OwnedWorktree): DiscardAuthorization | null {
  const row = getDb().prepare(`SELECT id, actor, data_json FROM events c WHERE c.task_id = ?
    AND c.kind = 'cleanup_discard_authorized' AND ${currentCleanupSql("c", "c.task_id")} ORDER BY c.id DESC LIMIT 1`)
    .get(task.id) as { id: number; actor: string; data_json: string } | undefined;
  if (!row) return null;
  const grant = JSON.parse(row.data_json) as DiscardAuthorization;
  return grant.cleanupGeneration === cleanupGeneration(task.id) && grant.branch === owned.branch && grant.base === owned.base &&
    samePath(grant.root, owned.root) && samePath(grant.directory, owned.directory) && grant.workspaceId === task.paseo_workspace_id
    ? { ...grant, actor: row.actor, authorizationId: row.id } : null;
}

function discardCompleted(taskId: number, grant: DiscardAuthorization): boolean {
  return !!getDb().prepare(`SELECT 1 FROM events c WHERE c.task_id = ? AND c.kind = 'cleanup_discarded'
    AND ${currentCleanupSql("c", "c.task_id")} AND json_extract(c.data_json, '$.head') = ?
    AND json_extract(c.data_json, '$.branch') = ? AND json_extract(c.data_json, '$.directory') = ? LIMIT 1`)
    .get(taskId, grant.head, grant.branch, grant.directory);
}

function directoryMissing(directory: string): boolean {
  try { lstatSync(directory); } catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
  return false;
}

/** Fail closed after any awaited read. Directory removal uses the ordinary clean-worktree path. */
export async function discardStillValid(task: TaskRow, owned: OwnedWorktree, grant: DiscardAuthorization, run: GitRunner): Promise<boolean> {
  const current = getTask(task.id);
  if (!eligible(current, owned) || grant.cleanupGeneration !== cleanupGeneration(task.id) ||
      grant.workspaceId !== current.paseo_workspace_id) return false;
  const head = await run(owned.root, ["rev-parse", "--verify", headRef(owned.branch)]);
  const base = await run(owned.root, ["rev-parse", "--verify", headRef(owned.base)]);
  if (head.code !== 0 && discardCompleted(task.id, grant) && directoryMissing(owned.directory)) {
    const missing = await run(owned.root, ["show-ref", "--verify", "--quiet", headRef(owned.branch)]);
    return missing.code === 1;
  }
  if (head.code !== 0 || base.code !== 0 || head.stdout.trim() !== grant.head || base.stdout.trim() !== grant.baseOid) return false;
  const state = directoryState(owned.directory);
  if (state === "missing") {
    // existsSync also hides read failures. Only ENOENT proves a prior removal.
    return directoryMissing(owned.directory);
  }
  if (state !== "present") return false;
  const top = await run(owned.directory, ["rev-parse", "--show-toplevel"]);
  const branch = await run(owned.directory, ["branch", "--show-current"]);
  const tip = await run(owned.directory, ["rev-parse", "--verify", "HEAD"]);
  const status = await run(owned.directory, ["status", "--porcelain", "--untracked-files=all"]);
  return top.code === 0 && samePath(top.stdout.trim(), owned.directory) && branch.code === 0 && branch.stdout.trim() === owned.branch &&
    tip.code === 0 && tip.stdout.trim() === grant.head && status.code === 0 && !status.stdout.trim();
}

/** Called only after the CLI's strict registered-leader check. No physical cleanup runs here. */
export async function authorizeDiscard(taskId: number, actor: string): Promise<DiscardAuthorization> {
  const release = tryHoldCleanupCard(taskId);
  if (!release) throw new KanbanError("invalid", t("cleanupDiscard.busy"));
  try {
    const task = getTask(taskId);
    const owned = ownedWorktree(taskId, createdWorktree(taskId));
    if (!owned || !eligible(task, owned) || directoryState(owned.directory) !== "present") {
      throw new KanbanError("invalid", t("cleanupDiscard.ineligible"));
    }
    const head = await runGit(owned.root, ["rev-parse", "--verify", headRef(owned.branch)]);
    const base = await runGit(owned.root, ["rev-parse", "--verify", headRef(owned.base)]);
    if (head.code !== 0 || base.code !== 0) throw new KanbanError("invalid", t("cleanupDiscard.unreadable"));
    const log = await runGit(owned.root, ["log", "--format=%H%x00%s", `${base.stdout.trim()}..${head.stdout.trim()}`, "--"]);
    if (log.code !== 0) throw new KanbanError("invalid", t("cleanupDiscard.unreadable"));
    const commits = log.stdout.trimEnd().split("\n").filter(Boolean).map(line => {
      const [sha, subject] = line.split("\0");
      if (!/^[0-9a-f]{40,64}$/.test(sha) || subject === undefined) throw new KanbanError("invalid", t("cleanupDiscard.unreadable"));
      return { sha, subject };
    });
    const grant: DiscardAuthorization = { ...owned, cleanupGeneration: cleanupGeneration(taskId), workspaceId: task.paseo_workspace_id,
      actor, head: head.stdout.trim(), baseOid: base.stdout.trim(), commits };
    if (!(await discardStillValid(task, owned, grant, runGit))) throw new KanbanError("invalid", t("cleanupDiscard.changed"));
    appendEvent(taskId, "cleanup_discard_authorized", null, null, actor, { ...grant });
    return grant;
  } finally { release(); }
}

/** Compare-and-delete only the audited tip, after normal workspace/worktree retirement. */
export async function deleteDiscardedBranch(task: TaskRow, owned: OwnedWorktree, grant: DiscardAuthorization, run: GitRunner): Promise<boolean> {
  if (!(await discardStillValid(task, owned, grant, run))) return false;
  if (discardCompleted(task.id, grant)) return true;
  const listed = await run(owned.root, ["worktree", "list", "--porcelain"]);
  if (listed.code !== 0 || listed.stdout.split("\n").includes(`branch ${headRef(owned.branch)}`)) return false;
  const deleted = await run(owned.root, ["update-ref", "-d", headRef(owned.branch), grant.head]);
  if (deleted.code !== 0) return false;
  appendEvent(task.id, "cleanup_discarded", null, null, grant.actor, { ...grant });
  return true;
}
