import { t } from "./i18n";

/** A reset countdown, recomputed on the panel's existing refresh cadence. */
export function antigravityCountdown(resetsAt: string | null, now: number): string {
  const end = resetsAt === null ? NaN : Date.parse(resetsAt);
  if (!Number.isFinite(end)) return t("quota.antigravity.resetUnknown");
  if (end <= now) return t("quota.antigravity.resetDue");
  const total = Math.ceil((end - now) / 60_000);
  const days = Math.floor(total / 1440);
  const hours = Math.floor(total / 60) % 24;
  const minutes = total % 60;
  return days > 0 ? t("quota.antigravity.countdownDays", { days, hours, minutes })
    : total >= 60 ? t("quota.antigravity.countdownHours", { hours, minutes })
    : t("quota.antigravity.countdownMinutes", { minutes });
}

export function antigravityLeft(remainingPct: number | null): string {
  return remainingPct === null || !Number.isFinite(remainingPct) ? t("quota.antigravity.leftUnknown")
    : t("quota.antigravity.left", { pct: Math.round(Math.max(0, Math.min(100, remainingPct))) });
}

/** A cached live card must age into a stale sample even when the next server publication is unavailable. */
export function antigravityRowStale(row: { readingState?: string; readingExpiresAt?: string | null }, now: number): boolean {
  return row.readingState === "stale" || (row.readingExpiresAt != null && Date.parse(row.readingExpiresAt) <= now);
}
