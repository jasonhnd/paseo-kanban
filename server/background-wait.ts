/// <reference types="node" />
import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { t } from "../shared/i18n";
import { cardMarkOf } from "./card-ref";
import { cardTmpGeneration } from "./card-tmp";
import { preparedCardTmpDir } from "./card-tmp-record";
import { getDb } from "./db";
import { loadConfig } from "./config";
import { authorizeBackgroundProcess, backgroundProcesses, backgroundProcessStatus, type BackgroundProcess } from "./background-process";
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
  process: BackgroundProcess;
  startedAt: number;
  maxWaitMs: number;
  unknownChecks?: number;
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

export const DEFAULT_BACKGROUND_UNKNOWN_LIMIT = 5;
export const DEFAULT_BACKGROUND_WAIT_MS = 3 * 60 * 60 * 1000;

/** The tracked PID is the shell responsible for atomically writing the exit-code marker. */
export function registerBackgroundWait(id: number, marker: string, log: string | undefined, identity: Identity, options: { pid?: string; timeoutMs?: string } = {}): TaskRow {
  const task = getTask(id);
  if (!identity.agentId || identity.agentId !== task.agent_id || (identity.taskId != null && identity.taskId !== id)) {
    throw new KanbanError("forbidden", t("background.error.owner"));
  }
  if (task.status !== "running" && task.status !== "reviewing") throw new KanbanError("illegal_transition", t("background.error.active"));
  const prepared = preparedCardTmpDir(id, cardMarkOf(task));
  if (!prepared) throw new KanbanError("invalid", t("background.error.tmp"));
  const root = realpathSync(prepared);
  if (!options.pid || !/^[1-9]\d*$/.test(options.pid)) throw new KanbanError("invalid", t("background.error.pid"));
  const rows = backgroundProcesses();
  let worker: BackgroundProcess;
  try { worker = authorizeBackgroundProcess(Number(options.pid), process.pid, process.getuid!(), rows); }
  catch { worker = authorizeBackgroundProcess(Number(options.pid), process.ppid, process.getuid!(), rows); }
  const config = loadConfig();
  const maxWaitMs = options.timeoutMs === undefined
    ? config.projects?.[task.project]?.backgroundWaitMaxMs ?? config.backgroundWaitMaxMs ?? DEFAULT_BACKGROUND_WAIT_MS
    : Number(options.timeoutMs);
  if ((options.timeoutMs !== undefined && !/^[1-9]\d*$/.test(options.timeoutMs)) || !Number.isSafeInteger(maxWaitMs) || maxWaitMs <= 0) {
    throw new KanbanError("invalid", t("background.error.timeout"));
  }
  const wait: BackgroundWait = { process: worker, startedAt: Date.now(), maxWaitMs, agentId: identity.agentId, root, generation: cardTmpGeneration(root), marker: checkedPath(root, marker), log: log ? checkedPath(root, log) : null };
  if (wait.log === wait.marker) throw new KanbanError("invalid", t("background.error.path"));
  const ts = new Date(wait.startedAt).toISOString();
  const result = getDb().prepare(`UPDATE tasks SET status = 'blocked', blocked_kind = 'background', blocked_from = ?,
    blocked_at = ?, blocked_reason = ?, hold_reason = ?, background_wait_json = ?, updated_at = ?,
    scheduled_until = NULL, scheduled_wake_id = ?, scheduled_wake_text = NULL, scheduled_claim_id = NULL, scheduled_claim_until = NULL
    WHERE id = ? AND status = ? AND agent_id = ?`).run(task.status, ts, t("background.label"), t("background.label"),
      JSON.stringify(wait), ts, randomUUID(), id, task.status, identity.agentId);
  if (result.changes !== 1) throw new KanbanError("conflict", t("background.error.active"));
  appendEvent(id, "background_wait", task.status, "blocked", identity.role, { agentId: identity.agentId, marker: wait.marker, log: wait.log, process: worker, maxWaitMs });
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
    let text = bytes.subarray(0, size).toString("utf8");
    // Invalid UTF-8 can expand into replacement characters; bound the delivered tail too.
    if (tail && Buffer.byteLength(text) > limit) {
      const chars = Array.from(text);
      let length = 0;
      let start = chars.length;
      while (start > 0 && length + Buffer.byteLength(chars[start - 1]) <= limit) {
        length += Buffer.byteLength(chars[--start]);
      }
      text = chars.slice(start).join("");
    }
    return text;
  } finally { closeSync(fd); }
}

function completionText(task: TaskRow, now: Date, processes: () => BackgroundProcess[]): string | null {
  try {
    const wait = JSON.parse(task.background_wait_json ?? "null") as BackgroundWait | null;
    if (!wait || typeof wait.root !== "string" || typeof wait.marker !== "string") throw new Error(t("background.error.marker"));
    if (wait.agentId !== task.agent_id) return null;
    if (task.scheduled_wake_text) return task.scheduled_wake_text;
    if (cardTmpGeneration(wait.root) !== wait.generation) throw new Error(t("background.error.generation"));
    const readMarker = (): string | undefined => {
      try { return readBounded(wait.root, wait.marker, 128).trim(); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    };
    let marker = readMarker();
    let reason: string | undefined;
    if (marker === undefined) {
      // Pre-upgrade waits have no trustworthy PID. Wake for re-registration instead of hanging.
      if (!wait.process || !Number.isSafeInteger(wait.startedAt) || !Number.isSafeInteger(wait.maxWaitMs) || wait.maxWaitMs <= 0) {
        reason = t("background.error.legacy");
      } else if (Math.max(now.getTime(), Date.now()) - wait.startedAt >= wait.maxWaitMs) {
        reason = t("background.timeout", { ms: wait.maxWaitMs });
      } else {
        const status = backgroundProcessStatus(wait.process, processes);
        const previous = Number.isSafeInteger(wait.unknownChecks) && wait.unknownChecks! > 0 ? wait.unknownChecks! : 0;
        wait.unknownChecks = status === "unknown" ? previous + 1 : 0;
        // Persist consecutive failures across service restarts, under the per-card tick guard.
        if (status === "unknown" || previous > 0) getDb().prepare(`UPDATE tasks SET background_wait_json = ? WHERE id = ? AND status = 'blocked'
          AND blocked_kind = 'background' AND background_wait_json = ? AND scheduled_wake_id = ?`)
          .run(JSON.stringify(wait), task.id, task.background_wait_json, task.scheduled_wake_id);
        if (status === "exited") reason = t("background.exited");
        else if (status === "unknown" && wait.unknownChecks >= (loadConfig().backgroundWaitUnknownLimit ?? DEFAULT_BACKGROUND_UNKNOWN_LIMIT)) {
          reason = t("background.unknown");
        } else return null;
      }
      // The writer can rename its marker and exit between our first read and process lookup.
      marker = readMarker();
    }
    if (marker !== undefined) {
      if (!/^\d{1,3}$/.test(marker) || Number(marker) > 255) throw new Error(t("background.error.marker"));
      reason = undefined;
    }
    let tail = "";
    if (wait.log) {
      try { tail = readBounded(wait.root, wait.log, 8192, true); }
      catch (error) { tail = t("background.logUnavailable", { reason: error instanceof Error ? error.message : String(error) }); }
    }
    return reason ? t("background.wakeFailure", { reason, tail }) : t("background.wake", { code: Number(marker), tail });
  } catch (error) {
    return t("background.failed", { reason: error instanceof Error ? error.message : String(error) });
  }
}

/** Only the server polls. No progress messages, agent calls or turn wakeups before completion. */
export function resumeBackgroundWaits(
  now: Date, send?: Parameters<typeof resumePersistedWaits>[2], readProcesses = backgroundProcesses,
): Promise<void> {
  let rows: BackgroundProcess[] | null | undefined;
  const processes = (): BackgroundProcess[] => {
    if (rows === undefined) {
      try { rows = readProcesses(); }
      catch { rows = null; }
    }
    if (rows === null) throw new Error(t("background.error.processCheck"));
    return rows;
  };
  return resumePersistedWaits("background", now, send, task => completionText(task, now, processes));
}
