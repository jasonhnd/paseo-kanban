/// <reference types="node" />
import { t } from "../shared/i18n";
import { randomUUID } from "node:crypto";
import { getDb } from "./db";

/** Returned to the process that lost the cross-process start race. */
export function alreadyStarting(): string {
  return t("startClaim.alreadyStarting");
}

/** A live pid older than this can be taken. Covers a reused pid and a starter that never released. */
export const START_CLAIM_TTL_MS = 5 * 60 * 1000;

/** A missing process is ESRCH. EPERM means the pid exists but is not ours. */
function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function claimCurrent(at: string, now: number): boolean {
  const then = Date.parse(at);
  return !Number.isNaN(then) && now - then < START_CLAIM_TTL_MS;
}

/**
 * One live process may start this card. The row is the claim; status stays put until
 * the normal transition. A row whose pid has exited, or whose timestamp is past the
 * limit, can be taken. The transaction is only the insert, never the worktree create.
 */
export function acquireStartClaim(taskId: number, pid = process.pid, now = Date.now()): string | null {
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db.prepare("SELECT token, pid, at FROM start_claims WHERE task_id = ?").get(taskId) as
      | { token: string; pid: number; at: string }
      | undefined;
    if (row && pidAlive(Number(row.pid)) && claimCurrent(row.at, now)) {
      db.exec("ROLLBACK");
      return null;
    }
    if (row) db.prepare("DELETE FROM start_claims WHERE task_id = ?").run(taskId);
    const token = randomUUID();
    db.prepare("INSERT INTO start_claims (task_id, token, pid, at) VALUES (?, ?, ?, ?)").run(taskId, token, pid, new Date().toISOString());
    db.exec("COMMIT");
    return token;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // The transaction is already closed.
    }
    throw err;
  }
}

export function holdsStartClaim(taskId: number, token: string): boolean {
  const row = getDb().prepare("SELECT token FROM start_claims WHERE task_id = ?").get(taskId) as { token: string } | undefined;
  return row?.token === token;
}

/** Drop our claim. A token we no longer hold is left for whoever has it. */
export function releaseStartClaim(taskId: number, token: string): void {
  getDb().prepare("DELETE FROM start_claims WHERE task_id = ? AND token = ?").run(taskId, token);
}
