import { QUOTA_SAMPLE_MS } from "./quota-time";
import { t } from "./i18n";

export interface UnknownQuotaPolicy {
  maxAgeMs: number;
  maxConcurrent: number;
  tiers: Array<"L1" | "L2" | "L3" | "L4">;
}
export interface QuotaState {
  state?: "known" | "unknown";
  quotaStateExpiresAt?: string | null;
  unknownQuota?: UnknownQuotaPolicy;
}

/** Invalid settings retain bounded defaults; zero slots or an empty tier list closes unknown admission. */
export type UnknownQuotaOptions = { maxAgeMs?: number; maxConcurrent?: number; tiers?: string[] };

export function unknownQuotaPolicy(raw?: UnknownQuotaOptions | null): UnknownQuotaPolicy {
  return {
    maxAgeMs: typeof raw?.maxAgeMs === "number" && Number.isFinite(raw.maxAgeMs) && raw.maxAgeMs > 0 ? raw.maxAgeMs : 2 * QUOTA_SAMPLE_MS,
    maxConcurrent: typeof raw?.maxConcurrent === "number" && Number.isSafeInteger(raw.maxConcurrent) && raw.maxConcurrent >= 0 ? raw.maxConcurrent : 1,
    tiers: Array.isArray(raw?.tiers) && raw.tiers.every(tier => ["L1", "L2", "L3", "L4"].includes(tier)) ? [...new Set(raw.tiers)] as UnknownQuotaPolicy["tiers"] : ["L1", "L2"],
  };
}

/** Consumer clocks may narrow a published known row without waiting for another refresh. */
export function quotaUnknown(row: QuotaState, now: number): boolean {
  if (row.state === "unknown") return true;
  if (row.state !== "known") return false; // Compatibility rows predate source clocks.
  if (row.quotaStateExpiresAt === undefined) return false;
  const expires = row.quotaStateExpiresAt ? Date.parse(row.quotaStateExpiresAt) : NaN;
  return !Number.isFinite(expires) || expires <= now;
}

export function unknownQuotaReason(policy: UnknownQuotaPolicy): string {
  return t("quota.unknown.reason", { count: policy.maxConcurrent, tiers: policy.tiers.join("/") || "—" });
}

/** Occupancy is pool-wide, across every profile and role. It counts existing work before a new start. */
export function unknownQuotaBlock(row: QuotaState, tier: string, occupancy: number, now = Date.now()): string | null {
  if (!quotaUnknown(row, now)) return null;
  const policy = unknownQuotaPolicy(row.unknownQuota);
  return !(policy.tiers as readonly string[]).includes(tier) || occupancy >= policy.maxConcurrent ? unknownQuotaReason(policy) : null;
}
