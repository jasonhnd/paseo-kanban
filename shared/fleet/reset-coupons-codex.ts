import { type CouponKind, CODEX_CONSUME_MIN_PCT, USED_DROP_POINTS } from "./reset-coupons-core";
import { type PageRead } from "./reset-coupons-page";
import { t } from "./i18n";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function unixMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value < 1e12 ? value * 1000 : value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function creditKind(row: Record<string, unknown>): CouponKind {
  const title = typeof row.title === "string" ? row.title : "";
  if (/full/i.test(title)) return "full";
  if (/session|5[\s-]*hour/i.test(title)) return "session";
  if (/week/i.test(title)) return "weekly";
  if (row.resetType === "codexRateLimits") return "full";
  return "unknown";
}

/**
 * Parse Codex `account/rateLimits/read` (the result object, or the whole JSON-RPC message).
 * A missing coupon block is unreadable. `availableCount: 0` is a real reading of no coupons.
 * Credit ids and the account id are not copied.
 */
export function parseCodexRateLimits(payload: unknown): PageRead {
  const root = asRecord(payload);
  const result = asRecord(root?.result) ?? root;
  const bag = asRecord(result?.rateLimitResetCredits);
  const availableCount = bag?.availableCount;
  if (!bag || typeof availableCount !== "number" || !Number.isFinite(availableCount) || availableCount < 0) {
    return { status: "unreadable", count: 0, kind: "unknown", expiresAt: null, excerpt: "" };
  }
  const count = Math.floor(availableCount);
  const credits = Array.isArray(bag.credits) ? bag.credits.map(asRecord).filter((row): row is Record<string, unknown> => row !== null) : [];
  const available = credits.filter((row) => row.status === "available");
  if (count <= 0) return { status: "none", count: 0, kind: "unknown", expiresAt: null, excerpt: "" };
  const kinds = (available.length > 0 ? available : credits).map(creditKind);
  const kind = kinds.length > 0 && kinds.every((item) => item === kinds[0]) ? kinds[0] : "unknown";
  let earliest: number | null = null;
  for (const row of available.length > 0 ? available : credits) {
    const ms = unixMs(row.expiresAt);
    if (ms === null) continue;
    if (earliest === null || ms < earliest) earliest = ms;
  }
  const title = typeof available[0]?.title === "string" ? available[0].title : t("coupons.codex.defaultTitle");
  return {
    status: "coupon",
    count,
    kind,
    expiresAt: earliest === null ? null : new Date(earliest).toISOString(),
    excerpt: t("coupons.codex.excerpt", { title, count }).slice(0, 120),
  };
}

function creditsBalanceNumber(credits: Record<string, unknown> | null): number | null {
  if (!credits) return null;
  if (credits.unlimited === true && (credits.balance === undefined || credits.balance === null)) return null;
  const raw = credits.balance;
  const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : Number.NaN;
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

/**
 * Flexible-usage balance from `account/rateLimits/read`.
 * The live payload puts it on `rateLimits.credits`, not on the result root and not on a reset coupon.
 * `rateLimitsByLimitId` is used only when the main window has no balance. Coupon ids and account ids are not copied.
 * Null when no balance can be read.
 */
export function parseCodexCreditsBalance(payload: unknown): number | null {
  const root = asRecord(payload);
  const result = asRecord(root?.result) ?? root;
  const limits = asRecord(result?.rateLimits);
  const fromWindow = creditsBalanceNumber(asRecord(limits?.credits));
  if (fromWindow !== null) return fromWindow;
  const byId = asRecord(result?.rateLimitsByLimitId);
  if (byId) {
    for (const value of Object.values(byId)) {
      const found = creditsBalanceNumber(asRecord(asRecord(value)?.credits));
      if (found !== null) return found;
    }
  }
  return creditsBalanceNumber(asRecord(result?.credits));
}

/** Weekly percent and reset instant from `account/rateLimits/read`. Does not copy account or credit ids. */
export function codexWeeklyReading(payload: unknown): { usedPct: number | null; resetsAt: string | null } {
  const root = asRecord(payload);
  const result = asRecord(root?.result) ?? root;
  const limits = asRecord(result?.rateLimits);
  const primary = asRecord(limits?.primary);
  const used = primary?.usedPercent;
  const resets = unixMs(primary?.resetsAt);
  return {
    usedPct: typeof used === "number" && Number.isFinite(used) ? used : null,
    resetsAt: resets === null ? null : new Date(resets).toISOString(),
  };
}

/** Titles and expiries only. Credit ids stay out of this list. Earliest expiry first. */
export function codexCreditPieces(payload: unknown): { title: string; expiresAt: string | null }[] {
  const root = asRecord(payload);
  const result = asRecord(root?.result) ?? root;
  const bag = asRecord(result?.rateLimitResetCredits);
  const credits = Array.isArray(bag?.credits) ? bag.credits.map(asRecord).filter((row): row is Record<string, unknown> => row !== null) : [];
  const available = credits.filter((row) => row.status === "available");
  const list = (available.length > 0 ? available : credits).map((row) => {
    const ms = unixMs(row.expiresAt);
    return {
      title: typeof row.title === "string" && row.title ? row.title : t("coupons.codex.defaultTitle"),
      expiresAt: ms === null ? null : new Date(ms).toISOString(),
    };
  });
  return list.sort((a, b) => (a.expiresAt ?? "9999").localeCompare(b.expiresAt ?? "9999"));
}

/** Count, kind, expiry, and titles from one read. Credit ids are not copied. Null when the read is not a count. */
export function codexCompanyPatch(payload: unknown): {
  count: number;
  kind: CouponKind;
  expiresAt: string | null;
  excerpt: string;
  items: { title: string; expiresAt: string | null }[];
} | null {
  const parsed = parseCodexRateLimits(payload);
  if (parsed.status !== "coupon" && parsed.status !== "none") return null;
  return {
    count: parsed.count,
    kind: parsed.kind,
    expiresAt: parsed.expiresAt,
    excerpt: parsed.excerpt,
    items: codexCreditPieces(payload),
  };
}

/** The manual command's gate. A low reading or an empty wallet refuses before any redeem call. */
export function codexConsumeGate(input: { count: number; usedPct: number | null }): { ok: true } | { ok: false; reason: string } {
  if (!(input.count > 0)) return { ok: false, reason: t("coupons.codex.gateNone") };
  if (input.usedPct === null || !Number.isFinite(input.usedPct)) return { ok: false, reason: t("coupons.codex.gateUnread") };
  if (input.usedPct < CODEX_CONSUME_MIN_PCT) return { ok: false, reason: t("coupons.codex.gateLow", { pct: Math.round(input.usedPct), min: CODEX_CONSUME_MIN_PCT }) };
  return { ok: true };
}

export function codexConsumeOutcome(payload: unknown): string | null {
  const root = asRecord(payload);
  const result = asRecord(root?.result) ?? root;
  return typeof result?.outcome === "string" ? result.outcome : null;
}

/** True when the second read is back near empty, or fell by a coupon-sized step. */
export function codexUsageBackDown(before: number, after: number | null): boolean {
  if (after === null || !Number.isFinite(after)) return false;
  return after <= 20 || before - after >= USED_DROP_POINTS;
}
