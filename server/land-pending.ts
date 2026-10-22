/// <reference types="node" />
import { getDb } from "./db";
import { t } from "../shared/i18n";

export interface PendingLand {
  reason: string;
  branch: string;
  base: string;
  conflict: boolean;
  files: string[];
  /** Exact branch tip captured when this queue was last observed. */
  head?: string;
  missingBranch?: boolean;
  mainDirty?: boolean;
  eventId?: number;
}

function readPending(dataJson: string): PendingLand | null {
  try {
    const data = JSON.parse(dataJson) as {
      reason?: unknown;
      branch?: unknown;
      base?: unknown;
      conflict?: unknown;
      files?: unknown;
      head?: unknown;
      missingBranch?: unknown;
      mainDirty?: unknown;
    };
    if (typeof data.reason !== "string" || !data.reason.trim()) return null;
    const files = Array.isArray(data.files) ? data.files.filter((file): file is string => typeof file === "string") : [];
    return {
      reason: data.reason,
      branch: typeof data.branch === "string" ? data.branch : "",
      base: typeof data.base === "string" ? data.base : "",
      conflict: data.conflict === true,
      files,
      ...(typeof data.head === "string" && /^[0-9a-f]{40,64}$/i.test(data.head) ? { head: data.head } : {}),
      ...(data.missingBranch === true ? { missingBranch: true } : {}),
      ...(data.mainDirty === true ? { mainDirty: true } : {}),
    };
  } catch {
    return null;
  }
}

/** Reason shown on the card and in audit. Conflict files are named even when the stored reason omitted them. */
export function describePendingLand(pending: PendingLand): string {
  if (!pending.conflict || pending.files.length === 0) return pending.reason;
  const missing = pending.files.filter((file) => file.length > 0 && !pending.reason.includes(file));
  if (missing.length === 0) return pending.reason;
  return t("landPending.conflictFiles", { reason: pending.reason, files: missing.join(t("common.listSep")) });
}

/** The latest queued land, or null after that queue has been merged or explicitly settled. */
export function pendingLand(taskId: number): PendingLand | null {
  const row = getDb()
    .prepare("SELECT id, data_json FROM events WHERE task_id = ? AND kind = 'land_pending' ORDER BY id DESC LIMIT 1")
    .get(taskId) as { id: number; data_json: string } | undefined;
  if (!row) return null;
  if (getDb().prepare("SELECT 1 FROM events WHERE task_id = ? AND id > ? AND kind IN ('landed', 'land_settled') LIMIT 1").get(taskId, row.id)) return null;
  const pending = readPending(row.data_json);
  return pending ? { ...pending, eventId: row.id } : null;
}

export function openPendingLandIds(): number[] {
  const rows = getDb().prepare("SELECT DISTINCT task_id AS id FROM events WHERE kind = 'land_pending' ORDER BY task_id").all() as Array<{
    id: number;
  }>;
  return rows.map((row) => row.id).filter((id) => pendingLand(id) != null);
}

/** True when this Paseo workspace is still waiting to land, so cleanup and audit leave it alone. */
export function workspaceHeldForLand(workspaceId: string): boolean {
  const rows = getDb().prepare("SELECT id FROM tasks WHERE paseo_workspace_id = ?").all(workspaceId) as Array<{ id: number }>;
  return rows.some((row) => pendingLand(row.id) != null);
}

/** Write only changed evidence. Scheduler writes may be fenced to the queue they inspected. */
export function recordLandPending(
  taskId: number, status: string | null, actor: string,
  input: Parameters<typeof writeLandPending>[3], expectedEventId?: number,
): boolean {
  if (expectedEventId === undefined) return writeLandPending(taskId, status, actor, input);
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    if (pendingLand(taskId)?.eventId !== expectedEventId) {
      db.exec("ROLLBACK");
      return false;
    }
    const wrote = writeLandPending(taskId, status, actor, input);
    db.exec("COMMIT");
    return wrote;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function writeLandPending(
  taskId: number,
  status: string | null,
  actor: string,
  input: { reason: string; branch: string; base: string; conflict?: boolean; files?: string[]; head?: string; missingBranch?: boolean; mainDirty?: boolean },
): boolean {
  const conflict = input.conflict === true;
  const files = input.files ?? [];
  const current = pendingLand(taskId);
  const head = input.head ?? (current?.branch === input.branch && current?.base === input.base ? current.head : undefined);
  if (
    current &&
    current.reason === input.reason &&
    current.branch === input.branch &&
    current.base === input.base &&
    current.conflict === conflict &&
    current.head === head &&
    Boolean(current.missingBranch) === Boolean(input.missingBranch) &&
    Boolean(current.mainDirty) === Boolean(input.mainDirty) &&
    current.files.join("\0") === files.join("\0")
  ) {
    return false;
  }
  getDb()
    .prepare("INSERT INTO events (task_id, at, kind, from_status, to_status, actor, data_json) VALUES (?, ?, 'land_pending', NULL, ?, ?, ?)")
    .run(
      taskId,
      new Date().toISOString(),
      status,
      actor,
      JSON.stringify({
        reason: input.reason,
        branch: input.branch,
        base: input.base,
        ...(head ? { head } : {}),
        ...(input.missingBranch ? { missingBranch: true } : {}),
        ...(input.mainDirty ? { mainDirty: true } : {}),
        ...(conflict ? { conflict: true, files } : {}),
      }),
    );
  return true;
}
