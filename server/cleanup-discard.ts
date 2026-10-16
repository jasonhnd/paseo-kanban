import { t } from "../shared/i18n";
import { cleanupGeneration, currentCleanupSql, tryHoldCleanupCard } from "./cleanup-state";
import { getDb } from "./db";
import { KanbanError } from "./errors";
import { headRef, isProtectedBranch, originRef, refOk, runGit, type GitRunner } from "./git";
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
  /** Optional for grants recorded before upstream-aware discard auditing. baseOid still guards the local base. */
  comparisonBase?: { ref: string; oid: string; behind: number };
  commits: Array<{ sha: string; subject: string }>;
}

/** Read only locally available refs: origin/base first, then the configured upstream, then the local base. */
async function comparisonBase(owned: OwnedWorktree, baseOid: string): Promise<NonNullable<DiscardAuthorization["comparisonBase"]>> {
  const local = headRef(owned.base);
  let ref = originRef(owned.base);
  let exists = await runGit(owned.root, ["show-ref", "--verify", "--quiet", ref]);
  if (exists.code !== 0 && exists.code !== 1) throw new KanbanError("invalid", t("cleanupDiscard.unreadable"));
  if (exists.code === 1) {
    const upstream = await runGit(owned.root, ["for-each-ref", "--format=%(upstream)", local]);
    if (upstream.code !== 0) throw new KanbanError("invalid", t("cleanupDiscard.unreadable"));
    ref = upstream.stdout.trim();
    if (!ref || ref === headRef(owned.branch)) return { ref: local, oid: baseOid, behind: 0 };
    exists = await runGit(owned.root, ["show-ref", "--verify", "--quiet", ref]);
    if (exists.code === 1) return { ref: local, oid: baseOid, behind: 0 };
    if (exists.code !== 0) throw new KanbanError("invalid", t("cleanupDiscard.unreadable"));
  }
  const tip = await runGit(owned.root, ["rev-parse", "--verify", `${ref}^{commit}`]);
  if (tip.code !== 0) throw new KanbanError("invalid", t("cleanupDiscard.unreadable"));
  const behind = await runGit(owned.root, ["rev-list", "--count", `${baseOid}..${tip.stdout.trim()}`, "--"]);
  if (behind.code !== 0 || !/^\d+$/.test(behind.stdout.trim())) throw new KanbanError("invalid", t("cleanupDiscard.unreadable"));
  return { ref, oid: tip.stdout.trim(), behind: Number(behind.stdout.trim()) };
}

function eligible(task: TaskRow, owned: OwnedWorktree): boolean {
  return (task.status === "done" || task.status === "archived") && isTempWorkspace(task.id) && !tempCleaned(task.id) &&
    !pendingLand(task.id) && !owned.readOnly && refOk(owned.base) && refOk(owned.branch) &&
    owned.branch !== owned.base && !isProtectedBranch(owned.branch) && samePath(task.workspace_path, owned.directory);
}

/** A grant is limited to one cleanup generation and owned copy; a revoked latest grant never falls back to an older one. */
export function discardAuthorization(task: TaskRow, owned: OwnedWorktree): DiscardAuthorization | null {
  const row = getDb().prepare(`SELECT id, actor, data_json FROM events c WHERE c.task_id = ?
    AND c.kind = 'cleanup_discard_authorized' AND ${currentCleanupSql("c", "c.task_id")} ORDER BY c.id DESC LIMIT 1`)
    .get(task.id) as { id: number; actor: string; data_json: string } | undefined;
  if (!row) return null;
  if (getDb().prepare(`SELECT 1 FROM events c WHERE c.task_id = ? AND c.kind = 'cleanup_discard_revoked'
    AND ${currentCleanupSql("c", "c.task_id")} AND json_extract(c.data_json, '$.authorizationId') = ? LIMIT 1`)
    .get(task.id, row.id)) return null;
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

export function discardCopyMissing(directory: string): boolean {
  try { lstatSync(directory); } catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
  return false;
}

function targetStillValid(task: TaskRow, owned: OwnedWorktree, grant: DiscardAuthorization): boolean {
  return eligible(task, owned) && grant.cleanupGeneration === cleanupGeneration(task.id) && grant.workspaceId === task.paseo_workspace_id;
}

export function revokeDiscardAuthorization(task: TaskRow, grant: DiscardAuthorization, reason: string): void {
  appendEvent(task.id, "cleanup_discard_revoked", null, null, "kanban", { ...grant, reason, authorizedBy: grant.actor });
}

/** Fail closed after any awaited read. Directory removal uses the ordinary clean-worktree path. */
export async function discardStillValid(task: TaskRow, owned: OwnedWorktree, grant: DiscardAuthorization, run: GitRunner): Promise<boolean> {
  const current = getTask(task.id);
  if (!targetStillValid(current, owned, grant)) return false;
  const head = await run(owned.root, ["rev-parse", "--verify", headRef(owned.branch)]);
  if (discardCopyMissing(owned.directory)) {
    // The copy is retired. Its audited tip remains the deletion boundary even when base advances.
    if (head.code === 0) return head.stdout.trim() === grant.head;
    if (discardCompleted(task.id, grant)) {
      const missing = await run(owned.root, ["show-ref", "--verify", "--quiet", headRef(owned.branch)]);
      return missing.code === 1;
    }
    return false;
  }
  const base = await run(owned.root, ["rev-parse", "--verify", headRef(owned.base)]);
  if (head.code !== 0 || base.code !== 0 || head.stdout.trim() !== grant.head || base.stdout.trim() !== grant.baseOid) return false;
  if (grant.comparisonBase) {
    const comparison = await run(owned.root, ["rev-parse", "--verify", `${grant.comparisonBase.ref}^{commit}`]);
    if (comparison.code !== 0 || comparison.stdout.trim() !== grant.comparisonBase.oid) return false;
  }
  const state = directoryState(owned.directory);
  if (state === "missing") {
    // existsSync also hides read failures. Only ENOENT proves a prior removal.
    return discardCopyMissing(owned.directory);
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
    const comparison = await comparisonBase(owned, base.stdout.trim());
    // Enumerate surviving ref namespaces only. --all would also include the retiring worktree's HEAD.
    // --exclude applies to --branches only; a remote branch or tag with the same name must still protect its commits.
    const log = await runGit(owned.root, ["log", "--format=%H%x00%s", head.stdout.trim(), "--not",
      `--exclude=${owned.branch}`, "--branches", "--remotes", "--tags", "--"]);
    if (log.code !== 0) throw new KanbanError("invalid", t("cleanupDiscard.unreadable"));
    const commits = log.stdout.trimEnd().split("\n").filter(Boolean).map(line => {
      const [sha, subject] = line.split("\0");
      if (!/^[0-9a-f]{40,64}$/.test(sha) || subject === undefined) throw new KanbanError("invalid", t("cleanupDiscard.unreadable"));
      return { sha, subject };
    });
    const grant: DiscardAuthorization = { ...owned, cleanupGeneration: cleanupGeneration(taskId), workspaceId: task.paseo_workspace_id,
      actor, head: head.stdout.trim(), baseOid: base.stdout.trim(), comparisonBase: comparison, commits };
    if (!(await discardStillValid(task, owned, grant, runGit))) throw new KanbanError("invalid", t("cleanupDiscard.changed"));
    appendEvent(taskId, "cleanup_discard_authorized", null, null, actor, { ...grant });
    return grant;
  } finally { release(); }
}

/** Compare-and-delete only the audited tip after retirement. Changed tips are kept; I/O failures use the normal bounded retry. */
export async function deleteDiscardedBranch(task: TaskRow, owned: OwnedWorktree, grant: DiscardAuthorization, run: GitRunner):
Promise<{ ok: true; basis: string; kept?: boolean } | { ok: false; error: string }> {
  if (!targetStillValid(getTask(task.id), owned, grant) || !discardCopyMissing(owned.directory) ||
      discardAuthorization(getTask(task.id), owned)?.authorizationId !== grant.authorizationId) {
    return { ok: false, error: t("cleanupDiscard.changed") };
  }
  const head = await run(owned.root, ["rev-parse", "--verify", headRef(owned.branch)]);
  if (head.code !== 0) {
    const missing = await run(owned.root, ["show-ref", "--verify", "--quiet", headRef(owned.branch)]);
    return missing.code === 1 ? { ok: true, basis: t("worktreeGc.basis.branchGone") }
      : { ok: false, error: (head.stderr || head.stdout || t("cleanupDiscard.unreadable")).trim() };
  }
  if (discardCompleted(task.id, grant)) return { ok: true, kept: true, basis: t("cleanupDiscard.recreatedKept", { branch: owned.branch }) };
  if (head.stdout.trim() !== grant.head) return { ok: true, kept: true,
    basis: t("cleanupDiscard.tipChangedKept", { branch: owned.branch, approved: grant.head, actual: head.stdout.trim() }) };
  const listed = await run(owned.root, ["worktree", "list", "--porcelain"]);
  if (listed.code !== 0) return { ok: false, error: (listed.stderr || listed.stdout || t("cleanupDiscard.unreadable")).trim() };
  if (listed.stdout.split("\n").includes(`branch ${headRef(owned.branch)}`)) {
    return { ok: true, kept: true, basis: t("cleanupDiscard.checkedOutKept", { branch: owned.branch }) };
  }
  const deleted = await run(owned.root, ["update-ref", "-d", headRef(owned.branch), grant.head]);
  if (deleted.code !== 0) return { ok: false, error: (deleted.stderr || deleted.stdout || t("tempWorkspace.branch.notDeleted")).trim() };
  appendEvent(task.id, "cleanup_discarded", null, null, grant.actor, { ...grant });
  return { ok: true, basis: "discard_unmerged" };
}
