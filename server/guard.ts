/// <reference types="node" />
import { getDb } from "./db";
import { appendEvent } from "./task-record";
import { t } from "../shared/i18n";

/** Longest the scheduler waits for one call that leaves the process (Paseo RPC, wake delivery, agent lookup). */
export const EXTERNAL_CALL_TIMEOUT_MS = 12_000;
/** The same card and the same error is written to the events table at most once per window. */
export const CARD_ERROR_WINDOW_MS = 60 * 60_000;

let externalTimeoutMs = EXTERNAL_CALL_TIMEOUT_MS;

/** Tests shorten the wait. Pass null to restore the default. */
export function setExternalTimeoutForTests(ms: number | null): void {
  externalTimeoutMs = ms ?? EXTERNAL_CALL_TIMEOUT_MS;
}

export class ExternalTimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(t("guard.timeout", { label, seconds: Math.round(ms / 1000) }));
    this.name = "ExternalTimeoutError";
  }
}

/**
 * Race a call that leaves the process against a timer. The timer is always cleared.
 * The losing call is not cancelled; it can only be abandoned.
 */
export function withTimeout<T>(call: () => Promise<T> | T, label: string, ms = externalTimeoutMs): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    // Stay referenced. An unref'd timer never fires when this await is the only
    // handle, so the call hangs and the test runner cancels the rest of the file.
    const timer = setTimeout(() => reject(new ExternalTimeoutError(label, ms)), ms);
    Promise.resolve()
      .then(call)
      .then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err: unknown) => {
          clearTimeout(timer);
          reject(err);
        },
      );
  });
}

/** Parse stored JSON. Anything unreadable, or not a JSON object, is null. Never throws. */
export function safeParse<T extends object = Record<string, unknown>>(text: string | null | undefined): T | null {
  if (typeof text !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" ? (parsed as T) : null;
  } catch {
    return null;
  }
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function recentCardError(taskId: number, message: string, sinceIso: string): boolean {
  const row = getDb()
    .prepare(
      `SELECT id FROM events WHERE task_id = ? AND kind = 'card_error' AND at >= ?
       AND json_extract(data_json, '$.message') = ? LIMIT 1`,
    )
    .get(taskId, sinceIso, message);
  return Boolean(row);
}

/** A failure that belongs to one card: log it, and leave one `card_error` event per hour per distinct error (whatever phase hit it). */
export function noteCardError(taskId: number, stage: string, err: unknown, now = new Date()): void {
  const message = errorMessage(err);
  console.error(`[paseo-kanban] ${stage} card=${taskId}`, message);
  try {
    if (recentCardError(taskId, message, new Date(now.getTime() - CARD_ERROR_WINDOW_MS).toISOString())) return;
    appendEvent(taskId, "card_error", null, null, "scheduler", { stage, message }, now.toISOString());
  } catch (inner) {
    console.error(`[paseo-kanban] ${stage} card=${taskId} recording failed`, errorMessage(inner));
  }
}

/** Run one card's step. A throw is recorded against the card and the next card still runs. */
export async function guardCard<T>(taskId: number, stage: string, fn: () => Promise<T> | T, now?: Date): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    noteCardError(taskId, stage, err, now);
    return undefined;
  }
}

/** Synchronous twin of guardCard for per-card loops that are not async. */
export function guardCardSync<T>(taskId: number, stage: string, fn: () => T, now?: Date): T | undefined {
  try {
    return fn();
  } catch (err) {
    noteCardError(taskId, stage, err, now);
    return undefined;
  }
}

const loggedStageErrors = new Map<string, number>();

export function resetGuardForTests(): void {
  loggedStageErrors.clear();
  externalTimeoutMs = EXTERNAL_CALL_TIMEOUT_MS;
}

/**
 * Run one scheduler phase. A throw is logged (once per hour per distinct message) and returned,
 * so the phases after it still run. The caller reports the failures at the end of the round.
 */
export async function guardStage(name: string, errors: string[], fn: () => Promise<unknown> | unknown, nowMs = Date.now()): Promise<void> {
  try {
    await fn();
  } catch (err) {
    const message = t("guard.stageError", { name, message: errorMessage(err) });
    errors.push(message);
    const last = loggedStageErrors.get(message);
    if (last == null || nowMs - last >= CARD_ERROR_WINDOW_MS) {
      loggedStageErrors.set(message, nowMs);
      console.error("[paseo-kanban] tick stage", message);
    }
  }
}
