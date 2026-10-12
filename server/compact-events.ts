/// <reference types="node" />
import { DatabaseSync } from "node:sqlite";
import { planBackupPruneAfterNewBackup } from "./backup-retention";
import { backupKanbanDbDetailed, getDb, openReadonlyDb } from "./db";
import { KanbanError } from "./errors";
import { resolveCompactIdentity } from "./identity";
import { t } from "../shared/i18n";

/** Events newer than this many days are never touched. `--days` overrides it. */
export const DEFAULT_RETENTION_DAYS = 30;

/** Summary-style flow kinds (DEMO_0001) expire sooner: they carry no state once the card is finished. `--days` below this narrows them further. */
export const SHORT_RETENTION_DAYS = 7;
export const SHORT_RETENTION_KINDS: readonly string[] = ["native_session_skipped", "native_session_project_dir_removed", "tmp_cleaned"];

/**
 * Bookkeeping kinds that may be deleted once they are older than the retention period.
 * Each one was checked against its readers: nothing reads it for a finished card, so a card
 * that is done or archived loses nothing it still needs. Everything else is kept: created,
 * started, status changes, complete, approve, request_changes, accept, rework, pass, comment,
 * and every kind that cleanup, native-session retirement, audit or wake de-duplication
 * reads as state (all `cleanup` rows other than repeated verify_agent, cleanup_finished,
 * temp_workspace_cleaned, agent_purged, native_session_identified/archived/ready/..., wake_parent_merge,
 * wake_land, wake_missing_pr, wake_prerequisite, board_wake and so on).
 * Only an explicit entry here makes a kind deletable. Events that carry a `commentId` are never deleted.
 */
export const EXPIRING_EVENT_KINDS: readonly string[] = [
  "held",
  "downstream_dispatched",
  "stall_nudge",
  "nudge",
  "nudge_reset",
  ...SHORT_RETENTION_KINDS,
  "native_session_archive_failed",
  "native_session_claimed",
  "native_session_claim_released",
  "wake_acceptance",
  "wake_acceptance_repeat",
  "wake_blocked",
  "wake_children",
  "wake_review_hold",
];

/** Only cards that are finished may lose events; a running or waiting card keeps its whole trail. */
const FINISHED_STATUSES = ["done", "archived"];

export interface CompactEventsResult {
  dryRun: boolean;
  /** verify_agent rows before this run. */
  before: number;
  /** Rows deleted (dry-run: to be deleted): repeated verify_agent rows plus expired whitelist rows. */
  remove: number;
  /** Of `remove`, repeated verify_agent rows that are older than the retention period (not the earliest or latest for that card and agent). */
  duplicateVerify: number;
  /** Of `remove`, whitelist rows older than the retention period on a finished card. */
  expired: number;
  /** Expired rows per kind, most first. */
  expiredByKind: Array<{ kind: string; count: number }>;
  /** Write-audit rows in the read-only plan or apply snapshot. */
  writeAuditsBefore: number;
  /** Deleted audit rows, counted separately from events. */
  expiredWriteAudits: number;
  /** Live remaining audit rows; dry-run reports the unchanged count. */
  writeAuditsAfter: number;
  retentionDays: number;
  /** verify_agent rows that remain. A dry-run reports the current count. */
  after: number;
  /** Distinct card + agent pairs that have at least one verify_agent. */
  agents: number;
  /** Set only after --apply copies the database, before migration and deletes. */
  backup: string | null;
  /** Old kanban.db.bak-* files deleted (apply) or that apply would delete (dry-run). */
  prunedBackups: string[];
  text: string;
}

const VERIFY = `kind = 'cleanup' AND json_extract(data_json, '$.action') = 'verify_agent'`;

const RANKED = `
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY task_id, IFNULL(json_extract(data_json, '$.agentId'), '')
           ORDER BY id
         ) AS rn,
         COUNT(*) OVER (
           PARTITION BY task_id, IFNULL(json_extract(data_json, '$.agentId'), '')
         ) AS cnt
  FROM events
  WHERE ${VERIFY}
`;

function sqlQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** An event that points at a comment is never deleted, by any branch: the final DELETE applies this too. */
const NO_COMMENT_LINK = `json_extract(data_json, '$.commentId') IS NULL`;

const FINISHED_TASKS = `task_id IN (SELECT id FROM tasks WHERE status IN (${FINISHED_STATUSES.map(sqlQuote).join(", ")}))`;

const KIND_LIST = (kinds: readonly string[]): string => kinds.map(sqlQuote).join(", ");

/** Expired whitelist rows. The first `?` is the cutoff, the second the (shorter or equal) cutoff for SHORT_RETENTION_KINDS. */
const EXPIRED = `
  SELECT id, kind FROM events
  WHERE ((at < ? AND kind IN (${KIND_LIST(EXPIRING_EVENT_KINDS.filter((kind) => !SHORT_RETENTION_KINDS.includes(kind)))}))
      OR (at < ? AND kind IN (${KIND_LIST(SHORT_RETENTION_KINDS)})))
    AND ${NO_COMMENT_LINK}
    AND ${FINISHED_TASKS}
`;

/** Repeated verify_agent rows (neither first nor last per card and agent) that are also expired. `?` is the cutoff. */
const EXPIRED_DUPLICATES = `
  SELECT r.id FROM (${RANKED}) r JOIN events e ON e.id = r.id
  WHERE r.rn > 1 AND r.rn < r.cnt AND e.at < ? AND e.${FINISHED_TASKS}
    AND json_extract(e.data_json, '$.commentId') IS NULL
`;

function count(db: DatabaseSync, sql: string): number {
  return (db.prepare(sql).get() as { n: number }).n;
}

interface Plan {
  before: number;
  agents: number;
  duplicateIds: number[];
  expiredRows: Array<{ id: number; kind: string }>;
  writeAuditsBefore: number;
  auditIds: number[];
}

function planDeletion(db: DatabaseSync, cutoff: string, shortCutoff: string): Plan {
  const before = count(db, `SELECT COUNT(*) AS n FROM events WHERE ${VERIFY}`);
  const agents = count(
    db,
    `SELECT COUNT(*) AS n FROM (
       SELECT task_id, IFNULL(json_extract(data_json, '$.agentId'), '') AS agent
       FROM events WHERE ${VERIFY} GROUP BY task_id, agent
     )`,
  );
  const duplicateIds = (db.prepare(EXPIRED_DUPLICATES).all(cutoff) as Array<{ id: number }>).map((row) => row.id);
  const expiredRows = db.prepare(EXPIRED).all(cutoff, shortCutoff) as Array<{ id: number; kind: string }>;
  // Dry-run and pre-migration backups must also work on schemas predating audits.
  const hasAudits = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'write_audits'").get();
  const writeAuditsBefore = hasAudits ? count(db, "SELECT COUNT(*) AS n FROM write_audits") : 0;
  const auditIds = hasAudits
    ? (db.prepare("SELECT id FROM write_audits WHERE at < ?").all(cutoff) as Array<{ id: number }>).map(row => row.id)
    : [];
  return { before, agents, duplicateIds, expiredRows, writeAuditsBefore, auditIds };
}

function summarize(plan: Plan): { ids: number[]; duplicateVerify: number; expired: number; expiredByKind: Array<{ kind: string; count: number }> } {
  const duplicate = new Set(plan.duplicateIds);
  const expiredOnly = plan.expiredRows.filter((row) => !duplicate.has(row.id));
  const byKind = new Map<string, number>();
  for (const row of expiredOnly) byKind.set(row.kind, (byKind.get(row.kind) ?? 0) + 1);
  return {
    ids: [...duplicate, ...expiredOnly.map((row) => row.id)],
    duplicateVerify: duplicate.size,
    expired: expiredOnly.length,
    expiredByKind: [...byKind.entries()].map(([kind, n]) => ({ kind, count: n })).sort((a, b) => b.count - a.count || (a.kind < b.kind ? -1 : 1)),
  };
}

function kindText(items: Array<{ kind: string; count: number }>): string {
  return items.length === 0 ? "" : t("compactEvents.kindList", { items: items.map((item) => `${item.kind} ${item.count}`).join(t("common.listSep")) });
}

function removeText(sum: ReturnType<typeof summarize>, days: number, deleted: boolean): string {
  const verb = deleted ? t("compactEvents.verb.deleted") : t("compactEvents.verb.planned");
  const total = sum.duplicateVerify + sum.expired;
  return t("compactEvents.remove", {
    verb,
    total,
    days,
    duplicate: sum.duplicateVerify,
    shortKinds: SHORT_RETENTION_KINDS.join(t("common.listSep")),
    shortDays: Math.min(days, SHORT_RETENTION_DAYS),
    expired: sum.expired,
    kinds: kindText(sum.expiredByKind),
  });
}

function auditText(rows: number, days: number, deleted: boolean): string {
  return t("writeSource.retention", { verb: deleted ? t("compactEvents.verb.deleted") : t("compactEvents.verb.planned"), days, rows });
}

/**
 * Drop repeated verify_agent rows (keep the earliest and latest per card and agent) and
 * whitelisted bookkeeping events older than `retentionDays` on finished cards.
 * Identity-only audits expire after the same period regardless of card status.
 * Default is a dry-run on a read-only connection: no migration, no indexes, no token.
 * `--apply` writes a consistent snapshot first and checks it, then migrates and deletes,
 * then keeps only the newest two kanban.db.bak-* files.
 */
export function compactVerifyEvents(options: {
  apply: boolean;
  env?: NodeJS.ProcessEnv;
  retentionDays?: number;
  now?: Date;
}): CompactEventsResult {
  const env = options.env ?? process.env;
  const days = options.retentionDays ?? DEFAULT_RETENTION_DAYS;
  if (!Number.isInteger(days) || days < 1) throw new KanbanError("invalid", t("compactEvents.error.days"));
  const nowMs = (options.now ?? new Date()).getTime();
  const cutoff = new Date(nowMs - days * 86_400_000).toISOString();
  const shortCutoff = new Date(nowMs - Math.min(days, SHORT_RETENTION_DAYS) * 86_400_000).toISOString();
  const readonly = openReadonlyDb();
  let plan: Plan;
  try {
    const identity = resolveCompactIdentity(env, readonly);
    if (identity.role !== "supervisor") throw new KanbanError("forbidden", t("compactEvents.error.forbidden"));
    plan = planDeletion(readonly, cutoff, shortCutoff);
  } finally {
    readonly.close();
  }
  if (!options.apply) {
    const sum = summarize(plan);
    const stale = planBackupPruneAfterNewBackup().map((file) => file.path);
    const backups =
      stale.length === 0
        ? t("compactEvents.dryRun.noBackups")
        : t("compactEvents.dryRun.backups", { count: stale.length, files: stale.join(t("common.listSep")) });
    const text = t("compactEvents.dryRun.text", { before: plan.before, agents: plan.agents, remove: removeText(sum, days, false), audits: auditText(plan.auditIds.length, days, false), backups });
    return {
      dryRun: true, before: plan.before, remove: sum.ids.length, duplicateVerify: sum.duplicateVerify, expired: sum.expired,
      expiredByKind: sum.expiredByKind, retentionDays: days, after: plan.before, agents: plan.agents, backup: null, prunedBackups: stale, text,
      writeAuditsBefore: plan.writeAuditsBefore, expiredWriteAudits: plan.auditIds.length, writeAuditsAfter: plan.writeAuditsBefore,
    };
  }
  const { backup, pruned, pruneFailed } = backupKanbanDbDetailed();
  const snapshot = new DatabaseSync(backup, { readOnly: true });
  let snap: Plan;
  try {
    // The backup is the authority for both the report and the deletion set.
    // Appends committed after VACUUM INTO belong to the next run.
    snap = planDeletion(snapshot, cutoff, shortCutoff);
  } finally {
    snapshot.close();
  }
  const sum = summarize(snap);
  const db = getDb();
  let after: number;
  let removed: number;
  let removedAudits: number;
  let auditsAfter: number;
  db.exec("BEGIN");
  try {
    // json_each avoids SQLite's parameter limit for large snapshots.
    // Every branch only picks candidate ids; this is the one place that deletes, and it re-applies the comment guard.
    const deleted = db
      .prepare(`DELETE FROM events WHERE id IN (SELECT value FROM json_each(?)) AND ${NO_COMMENT_LINK}`)
      .run(JSON.stringify(sum.ids));
    removed = Number(deleted.changes);
    // Snapshot IDs spare calls inserted after backup, even with an old timestamp.
    removedAudits = Number(db.prepare("DELETE FROM write_audits WHERE id IN (SELECT value FROM json_each(?)) AND at < ?")
      .run(JSON.stringify(snap.auditIds), cutoff).changes);
    auditsAfter = count(db, "SELECT COUNT(*) AS n FROM write_audits");
    after = count(db, `SELECT COUNT(*) AS n FROM events WHERE ${VERIFY}`);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  const prunedText = pruned.length === 0 ? "" : t("compactEvents.apply.pruned", { count: pruned.length });
  const failedText = pruneFailed.length === 0 ? "" : t("compactEvents.apply.pruneFailed", { count: pruneFailed.length, errors: pruneFailed.join(t("common.semicolon")) });
  const body =
    removed === 0
      ? t("compactEvents.apply.nothing", { after, agents: snap.agents })
      : t("compactEvents.apply.removed", { remove: removeText({ ...sum, duplicateVerify: sum.duplicateVerify, expired: sum.expired }, days, true), after, agents: snap.agents });
  // English pieces end with a space before the next sentence; Chinese ones never do.
  const text = t("compactEvents.apply.text", { body, audits: auditText(removedAudits, days, true), backup, pruned: prunedText, failed: failedText }).trimEnd();
  return {
    dryRun: false, before: snap.before, remove: removed, duplicateVerify: sum.duplicateVerify, expired: sum.expired,
    expiredByKind: sum.expiredByKind, retentionDays: days, after, agents: snap.agents, backup, prunedBackups: pruned, text,
    writeAuditsBefore: snap.writeAuditsBefore, expiredWriteAudits: removedAudits, writeAuditsAfter: auditsAfter,
  };
}
