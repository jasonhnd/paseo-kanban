/// <reference types="node" />
import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { t } from "../shared/i18n";
import { cardMarkOf } from "./card-ref";
import { cardTmpGeneration } from "./card-tmp";
import { preparedCardTmpDir } from "./card-tmp-record";
import { getDb } from "./db";
import { KanbanError } from "./errors";
import { resumePersistedWaits } from "./scheduled-wait";
import { appendEvent, getTask, type TaskRow } from "./store";
import type { Identity } from "./tokens";

interface BackgroundWait {
  agentId: string;
  root: string;
  generation: string | null;
  marker: string;
  log: string | null;
}

function inside(root: string, path: string): boolean {
  const part = relative(root, path);
  return part !== "" && part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part);
}

/** Resolve parents on every read as well as at registration; a replaced symlink cannot escape. */
function checkedPath(root: string, path: string): string {
  if (!isAbsolute(path) || !inside(root, resolve(path)) || !inside(root, resolve(realpathSync(dirname(path)), path.slice(path.lastIndexOf(sep) + 1)))) {
    throw new KanbanError("invalid", t("background.error.path"));
  }
  return resolve(path);
}

/** A marker is an atomically renamed file containing a decimal shell exit code, not just a PID. */
export function registerBackgroundWait(id: number, marker: string, log: string | undefined, identity: Identity): TaskRow {
  const task = getTask(id);
  if (!identity.agentId || identity.agentId !== task.agent_id || (identity.taskId != null && identity.taskId !== id)) {
    throw new KanbanError("forbidden", t("background.error.owner"));
  }
  if (task.status !== "running" && task.status !== "reviewing") throw new KanbanError("illegal_transition", t("background.error.active"));
  const prepared = preparedCardTmpDir(id, cardMarkOf(task));
  if (!prepared) throw new KanbanError("invalid", t("background.error.tmp"));
  const root = realpathSync(prepared);
  const wait: BackgroundWait = { agentId: identity.agentId, root, generation: cardTmpGeneration(root), marker: checkedPath(root, marker), log: log ? checkedPath(root, log) : null };
  if (wait.log === wait.marker) throw new KanbanError("invalid", t("background.error.path"));
  const ts = new Date().toISOString();
  const result = getDb().prepare(`UPDATE tasks SET status = 'blocked', blocked_kind = 'background', blocked_from = ?,
    blocked_at = ?, blocked_reason = ?, hold_reason = ?, background_wait_json = ?, updated_at = ?,
    scheduled_until = NULL, scheduled_wake_id = ?, scheduled_wake_text = NULL, scheduled_claim_id = NULL, scheduled_claim_until = NULL
    WHERE id = ? AND status = ? AND agent_id = ?`).run(task.status, ts, t("background.label"), t("background.label"),
      JSON.stringify(wait), ts, randomUUID(), id, task.status, identity.agentId);
  if (result.changes !== 1) throw new KanbanError("conflict", t("background.error.active"));
  appendEvent(id, "background_wait", task.status, "blocked", identity.role, { agentId: identity.agentId, marker: wait.marker, log: wait.log });
  return getTask(id);
}

/** Never read a whole deployment log into memory, or block the board on a FIFO. */
function readBounded(root: string, path: string, limit: number, tail = false): string {
  checkedPath(root, path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || (!tail && stat.size > limit)) throw new Error(t("background.error.marker"));
    const bytes = Buffer.alloc(Math.min(stat.size, limit));
    const size = readSync(fd, bytes, 0, bytes.length, tail ? Math.max(0, stat.size - bytes.length) : 0);
    return bytes.subarray(0, size).toString("utf8");
  } finally { closeSync(fd); }
}

function completionText(task: TaskRow): string | null {
  try {
    const wait = JSON.parse(task.background_wait_json ?? "null") as BackgroundWait | null;
    if (!wait || typeof wait.root !== "string" || typeof wait.marker !== "string") throw new Error(t("background.error.marker"));
    if (wait.agentId !== task.agent_id) return null;
    if (task.scheduled_wake_text) return task.scheduled_wake_text;
    if (cardTmpGeneration(wait.root) !== wait.generation) throw new Error(t("background.error.generation"));
    let marker: string;
    try { marker = readBounded(wait.root, wait.marker, 128).trim(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    if (!/^\d{1,3}$/.test(marker) || Number(marker) > 255) throw new Error(t("background.error.marker"));
    let tail = "";
    if (wait.log) {
      try { tail = readBounded(wait.root, wait.log, 8192, true); }
      catch (error) { tail = t("background.logUnavailable", { reason: error instanceof Error ? error.message : String(error) }); }
    }
    return t("background.wake", { code: Number(marker), tail });
  } catch (error) {
    return t("background.failed", { reason: error instanceof Error ? error.message : String(error) });
  }
}

/** Only the server polls. No progress messages, agent calls or turn wakeups before completion. */
export function resumeBackgroundWaits(now: Date, send?: Parameters<typeof resumePersistedWaits>[2]): Promise<void> {
  return resumePersistedWaits("background", now, send, completionText);
}
