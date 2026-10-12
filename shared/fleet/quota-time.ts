/** Presentation/source clocks only; dispatch safety expiry is independent. */
export const QUOTA_SAMPLE_MS = 60 * 60_000;
export const QUOTA_DISPLAY_TTL_MS = QUOTA_SAMPLE_MS + 2 * 60_000;
export type SourceTimeKind = "source" | "batch" | "unknown";

export function validQuotaTime(value: unknown, now: number): string | null {
  if (typeof value !== "string") return null;
  const at = Date.parse(value);
  return Number.isFinite(at) && at <= now ? new Date(at).toISOString() : null;
}

/** Explicit bad source times cannot be repaired with a newer batch or panel timestamp. */
export function providerSourceTime(row: { sampledAt?: unknown; readAt?: unknown; fetchedAt?: unknown; batchFetchedAt?: unknown }, now: number): { sampledAt: string | null; sourceTimeKind: SourceTimeKind } {
  const source = row.sampledAt ?? row.readAt ?? row.fetchedAt;
  if (source !== undefined && source !== null) {
    const sampledAt = validQuotaTime(source, now);
    return { sampledAt, sourceTimeKind: sampledAt ? "source" : "unknown" };
  }
  const sampledAt = validQuotaTime(row.batchFetchedAt, now);
  return { sampledAt, sourceTimeKind: sampledAt ? "batch" : "unknown" };
}

export function quotaDisplayExpiry(at: string | null, reset: string | null): string | null {
  if (!at) return null;
  const expires = Math.min(Date.parse(at) + QUOTA_DISPLAY_TTL_MS, reset && Number.isFinite(Date.parse(reset)) ? Date.parse(reset) : Infinity);
  return Number.isFinite(expires) ? new Date(expires).toISOString() : null;
}

/** Rejudge presentation caches at read time. readingExpiresAt is a dispatch deadline, not display expiry. */
export function quotaRowStale(row: {
  readAt: string | null; collectedAt?: string | null; readingState?: string;
  readingExpiresAt?: string | null; displayExpiresAt?: string | null; resetsAt: string | null;
}, now: number, cacheGeneratedAt?: string | null): boolean {
  if (row.readingState === "stale") return true;
  for (const deadline of [row.displayExpiresAt, row.resetsAt]) {
    if (deadline !== undefined && deadline !== null && (!Number.isFinite(Date.parse(deadline)) || Date.parse(deadline) <= now)) return true;
  }
  if (row.readAt && !validQuotaTime(row.readAt, now)) return true;
  const basis = row.readAt ?? row.collectedAt ?? cacheGeneratedAt ?? null;
  if (!basis) return false;
  const at = validQuotaTime(basis, now);
  return at === null || now - Date.parse(at) >= QUOTA_DISPLAY_TTL_MS;
}
