/// <reference types="node" />
import { t } from "../shared/i18n";
import { judgedWorktree } from "./branch-observed";
import { getDb } from "./db";
import { KanbanError } from "./errors";
import { headRef, refOk, runGit, runGitSync, type GitRunner } from "./git";
import { pendingLand, type PendingLand } from "./land-pending";
import { directoryState } from "./missing-cwd";
import { appendEvent, getTask, type TaskRow } from "./store";
import { createdWorktree, ownedWorktree, type OwnedWorktree } from "./worktree-gc";

export type MissingLandInspection =
  | { kind: "present"; head: string }
  | { kind: "error"; detail: string }
  | { kind: "missing"; head: string | null; retainedBy: string | null; retainedOid: string | null;
      commits: Array<{ sha: string; subject: string }>; detail: string; copy: string };

/** Only the owned generation and the exact queued branch/base may close this queue. */
export function missingLandTarget(task: TaskRow, pending: PendingLand): OwnedWorktree | null {
  const owned = ownedWorktree(task.id, createdWorktree(task.id));
  if (!owned || owned.readOnly || !refOk(pending.branch) || !refOk(pending.base)) return null;
  const judged = judgedWorktree(task.id, owned);
  return judged.branch === pending.branch && judged.base === pending.base ? judged : null;
}

/** Read local refs only. A missing or unreadable historical tip is never guessed from the creation base. */
export async function inspectMissingLand(owned: OwnedWorktree, pending: PendingLand, run: GitRunner = runGit): Promise<MissingLandInspection> {
  const exists = await run(owned.root, ["show-ref", "--verify", "--quiet", headRef(owned.branch)]);
  if (exists.code === 0) {
    const tip = await run(owned.root, ["rev-parse", "--verify", `${headRef(owned.branch)}^{commit}`]);
    return tip.code === 0 ? { kind: "present", head: tip.stdout.trim() } : { kind: "error", detail: t("missingLand.unreadable") };
  }
  if (exists.code !== 1) return { kind: "error", detail: exists.stderr.trim() || t("missingLand.unreadable") };
  const missing: Extract<MissingLandInspection, { kind: "missing" }> = {
    kind: "missing", head: pending.head ?? null, retainedBy: null, retainedOid: null, commits: [],
    detail: t("missingLand.unknownTip"), copy: directoryState(owned.directory),
  };
  if (missing.copy === "present") {
    const status = await run(owned.directory, ["status", "--porcelain"]);
    const tip = await run(owned.directory, ["rev-parse", "--verify", "HEAD^{commit}"]);
    // A surviving copy can contain later work or a broken symbolic HEAD. Keep it for inspection.
    if (status.code !== 0 || status.stdout.trim() || tip.code !== 0 || tip.stdout.trim() !== missing.head) {
      missing.detail = t("missingLand.copyUnproven");
      return missing;
    }
  } else if (missing.copy !== "missing") {
    missing.detail = t("missingLand.copyUnproven");
    return missing;
  }
  if (!missing.head || !/^[0-9a-f]{40,64}$/i.test(missing.head)) return missing;
  const commit = await run(owned.root, ["rev-parse", "--verify", `${missing.head}^{commit}`]);
  if (commit.code !== 0 || commit.stdout.trim() !== missing.head) return missing;
  const refs = await run(owned.root, ["for-each-ref", `--contains=${missing.head}`, "--format=%(refname)", "refs/heads", "refs/remotes", "refs/tags"]);
  if (refs.code !== 0) { missing.detail = t("missingLand.unreadable"); return missing; }
  const retainedBy = refs.stdout.split(/\r?\n/).find(ref => ref.startsWith("refs/") && ref !== headRef(owned.branch));
  if (retainedBy) {
    const oid = await run(owned.root, ["rev-parse", "--verify", `${retainedBy}^{commit}`]);
    if (oid.code !== 0) { missing.detail = t("missingLand.unreadable"); return missing; }
    // Recheck the resolved OID, so a concurrently moving ref is not invented proof.
    const contained = await run(owned.root, ["merge-base", "--is-ancestor", missing.head, oid.stdout.trim()]);
    if (contained.code !== 0) { missing.detail = t("missingLand.unreadable"); return missing; }
    return { ...missing, retainedBy, retainedOid: oid.stdout.trim(), detail: t("missingLand.retained", { ref: retainedBy }) };
  }
  const commits = await run(owned.root, ["log", "--format=%H%x09%s", missing.head, "--not", "--branches", "--remotes", "--tags", "--"]);
  if (commits.code !== 0) { missing.detail = t("missingLand.unreadable"); return missing; }
  missing.commits = commits.stdout.split(/\r?\n/).filter(Boolean).map(line => {
    const tab = line.indexOf("\t");
    return { sha: line.slice(0, tab), subject: line.slice(tab + 1) };
  });
  missing.detail = t("missingLand.unretained", { count: missing.commits.length });
  return missing;
}

/** This closes a queue, not a merge or a discard grant. Normal cleanup keeps all its own safety checks. */
export function recordMissingLandSettlement(task: TaskRow, expected: PendingLand, owned: OwnedWorktree,
  inspection: Extract<MissingLandInspection, { kind: "missing" }>, actor: string, reason?: string): boolean {
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    const current = getTask(task.id);
    const pending = pendingLand(task.id);
    const target = pending && missingLandTarget(current, pending);
    const copyStatus = inspection.copy === "present" ? runGitSync(owned.directory, ["status", "--porcelain"]) : null;
    const copyTip = inspection.copy === "present" ? runGitSync(owned.directory, ["rev-parse", "--verify", "HEAD^{commit}"]) : null;
    const copyUnchanged = directoryState(owned.directory) === inspection.copy && (inspection.copy === "missing" ||
      (copyStatus?.code === 0 && !copyStatus.stdout.trim() && copyTip?.code === 0 && copyTip.stdout.trim() === inspection.head));
    const retained = reason || (copyUnchanged && inspection.retainedBy && inspection.retainedOid &&
      runGitSync(owned.root, ["rev-parse", "--verify", `${inspection.retainedBy}^{commit}`]).stdout.trim() === inspection.retainedOid);
    if ((current.status !== "done" && current.status !== "archived") || current.paseo_workspace_id !== task.paseo_workspace_id || !pending || pending.eventId !== expected.eventId ||
        !retained || !target || target.root !== owned.root || target.directory !== owned.directory ||
        runGitSync(owned.root, ["show-ref", "--verify", "--quiet", headRef(owned.branch)]).code !== 1) {
      db.exec("ROLLBACK");
      return false;
    }
    appendEvent(task.id, "land_settled", null, current.status, actor, {
      mode: reason ? "leader" : "retained", reason: reason ?? inspection.detail, pendingEventId: expected.eventId,
      ...owned, head: inspection.head, retainedBy: inspection.retainedBy, retainedOid: inspection.retainedOid,
      commits: inspection.commits, evidence: inspection.detail, copy: inspection.copy,
    });
    db.exec("COMMIT");
    return true;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** Caller enforces registered leader identity. A reason is mandatory even when containment is provable. */
export async function settleMissingLand(taskId: number, actor: string, reason: string): Promise<void> {
  const task = getTask(taskId);
  const pending = pendingLand(taskId);
  const owned = pending && missingLandTarget(task, pending);
  if (!reason.trim() || (task.status !== "done" && task.status !== "archived") || !pending || !owned) {
    throw new KanbanError("invalid", t("missingLand.ineligible"));
  }
  const inspection = await inspectMissingLand(owned, pending);
  if (inspection.kind !== "missing" || !recordMissingLandSettlement(task, pending, owned, inspection, actor, reason.trim())) {
    throw new KanbanError("invalid", t("missingLand.ineligible"));
  }
}
