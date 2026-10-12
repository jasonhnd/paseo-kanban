import { t } from "./i18n";

/** Show the board banner after this long with no scheduler tick. */
export const TICK_BANNER_MS = 3 * 60 * 1000;
/** Wake the Kanban supervisor, and fail compat, after this long with no tick. */
export const TICK_WAKE_MS = 5 * 60 * 1000;

export function formatTickTime(at: string | null): string {
  if (!at) return t("scheduler.none");
  const ms = Date.parse(at);
  if (!Number.isFinite(ms)) return t("scheduler.none");
  return `${new Date(ms).toISOString().replace("T", " ").slice(0, 19)}Z`;
}

/**
 * Null while the last tick is still within 3 minutes.
 * Missing `at` means it has never ticked. Pass `ageMs` when a fresh process should
 * count from boot instead of treating a missing tick as already idle.
 */
export function schedulerIdleNote(at: string | null, now: number, ageMs = tickAgeMs(at, now)): string | null {
  if (ageMs <= TICK_BANNER_MS) return null;
  return t("scheduler.idle", { at: formatTickTime(at) });
}

export function tickAgeMs(at: string | null, now: number): number {
  if (at == null) return Number.POSITIVE_INFINITY;
  const age = now - Date.parse(at);
  return Number.isFinite(age) ? age : Number.POSITIVE_INFINITY;
}
