import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { companyCardSchema } from "./quota-companies";
import { t } from "./i18n";
import { quotaCycleSchema } from "./quota-cycle";

const tokensSchema = z.object({
  input: z.number(), // uncached input
  cacheRead: z.number(),
  cacheWrite: z.number(),
  output: z.number(),
  calls: z.number(),
});

const windowSchema = z.object({
  label: z.string(),
  usedPct: z.number().nullable(),
  resetsAt: z.string().nullable(),
  startsAt: z.string().nullable(),
  elapsedPct: z.number().nullable(),
  /** Linear projection of usedPct at reset time. */
  projectedPct: z.number().nullable(),
  /** When the quota runs out at the current pace, if before reset. */
  runsOutAt: z.string().nullable(),
  verdict: z.enum(["waste", "on-track", "short", "unknown"]),
  apiUsd: z.number(),
  /** API value of a full window at the observed rate (apiUsd / usedPct). */
  fullWindowUsd: z.number().nullable(),
  planUsd: z.number().nullable(),
  source: z.enum(["provider", "manual", "none", "screen", "official"]),
  manualAt: z.string().nullable(),
  /** When this window's sample was taken. Omitted on windows that are not a stored sample. */
  sampledAt: z.string().nullable().optional(),
  /** AFC read invocation time; never substituted for sampledAt. */
  collectedAt: z.string().nullable().optional(),
  sourceTimeKind: z.enum(["source", "batch", "unknown"]).optional(),
  displayExpiresAt: z.string().nullable().optional(),
  primary: z.boolean().optional(),
  /** Stable provider window id, retained when its displayed label is translated. */
  id: z.string().optional(),
  readingState: z.enum(["live", "manual", "stale", "unknown"]).optional(),
  readError: z.string().nullable().optional(),
  /** Last official report status; a successful RPC may still contain unavailable sources. */
  providerStatus: z.enum(["available", "unavailable", "error"]).optional(),
  staleUsedPct: z.number().nullable().optional(),
  readingExpiresAt: z.string().nullable().optional(),
  /** Existing quota/auth/rate-limit reader signals override cached dispatch decisions. */
  safetyError: z.string().nullable().optional(),
  /** A known exhausted reading remains a quota stop while its reset is still pending. */
  knownQuotaStop: z.string().nullable().optional(),
  /** Provider window identity, independent of the displayed translation. */
  cycleKind: z.enum(["day", "week", "month", "duration", "unknown"]).optional(),
  /** False when live usage cannot be compared with the selected cycle. */
  paceEligible: z.boolean().optional(),
  /** Set when usedPct comes from a dollar balance the provider reports (Cursor "Plan usage"). */
  balance: z.object({ usedUsd: z.number(), limitUsd: z.number() }).nullable().optional(),
  /** pool-status.json key this window feeds: the plan id, or a sub pool such as Claude's Fable week. */
  pool: z.string().optional(),
});

/** One pool of pool-status.json, as shown on the quota page (see docs/KANBAN-CONTRACT.md §1). */
const poolSchema = z.object({
  projectedPct: z.number().nullable().optional(),
  runsOutAt: z.string().nullable().optional(),
  burnRatePctPerHour: z.number().nullable().optional(),
  forecastConfidence: z.enum(["high", "low", "none"]).optional(),
  dispatchable: z.boolean(),
  deprioritize: z.boolean(),
  prefer: z.boolean(),
  reason: z.string(),
  usedPct: z.number().nullable().optional(),
  pacePct: z.number().nullable().optional(),
  daysLeft: z.number().nullable().optional(),
  periodDays: z.number().nullable().optional(),
  dailyPct: z.number().nullable().optional(),
  perRunPct: z.number().nullable().optional(),
  dailyRuns: z.number().nullable().optional(),
  paceState: z.string().optional(),
  /** "10/7 official early reset (not a coupon)" for 7 days after an official early reset (DEMO_0124). */
  earlyReset: z.string().optional(),
});

const cursorReadSchema = z.object({
  readAt: z.string().nullable(),
  ok: z.boolean(),
  includedPct: z.number().nullable(),
  autoPct: z.number().nullable(),
  apiPct: z.number().nullable(),
  onDemandUsd: z.number().nullable(),
  onDemandLimitUsd: z.number().nullable(),
  usingManual: z.boolean(),
  manualAt: z.string().nullable(),
  error: z.string().nullable(),
  /** True when the CLI is on the login screen or `status` says Not logged in. */
  loggedOut: z.boolean().optional(),
  /** True when AFC's own refresh token was rejected. */
  linkBroken: z.boolean().optional(),
  /** Where the Auto percent came from. Omitted on older snapshots. */
  via: z.enum(["official", "screen", "manual"]).optional(),
  /** Token-file alarm. Omitted when there is nothing to flag. Never a token. */
  alarm: z.string().nullable().optional(),
  /** False when the cursor-agent screen is turned off. Omitted means on. */
  screenRead: z.boolean().optional(),
});

const planSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Quota source adapter in force (shared/quota-adapters.ts): claude-cli, codex-cli, grok-cli, cursor-api, antigravity-cli or manual. */
  adapter: z.string().optional(),
  /** Display-only Cursor reader state, retained when the effective source becomes manual. */
  cursorMonitoring: z.boolean().optional(),
  /** Billing day of a monthly plan (plans.json `cycleDay`), so the panel's pool catalog has the same periods. */
  cycleDay: z.number().optional(),
  quotaCycle: quotaCycleSchema.optional(),
  quotaProtection: z.enum(["pause", "none"]).optional(),
  xUltraReserve: z.object({ botPct: z.number().nullable().optional(), userPct: z.number().nullable().optional() }).optional(),
  priceUsdMonthly: z.number().nullable(),
  dispatch: z.boolean(),
  /**
   * When false, being ahead of the progress line does not pause this plan.
   * Omitted means true (pause when ahead). Hard stops are unaffected.
   */
  pacePause: z.boolean().optional(),
  /** Nonempty lists restrict dispatch roles even when pacing or quota protection is disabled. */
  onlyRoles: z.array(z.string()).optional(),
  /**
   * Optional hard stop, as a percent already used. Missing keeps that pool's existing line
   * (Claude's 75% reserve and 5-hour 70% pause, a hand-copied 80%, otherwise 97%).
   */
  stopPct: z.number().optional(),
  note: z.string(),
  providers: z.array(z.string()),
  windows: z.array(windowSchema),
  /** Display-only agy buckets. Never used by poolStatus or the fleet-quota contract. */
  antigravityDisplay: z.array(windowSchema).optional(),
  api30dUsd: z.number(),
  /** Whether pay-per-use is on (cursor-api). Display only, never decides dispatch. */
  overageBilling: z.boolean().optional(),
  roi30d: z.number().nullable(),
  coverage: z.string(),
  /** cursor-api plans: Cursor's last reading. Other plans omit it. Display, plus the Auto percent already copied onto the monthly window. */
  cursorRead: cursorReadSchema.nullable().optional(),
});

const modelRowSchema = z.object({
  model: z.string(),
  plan: z.string(),
  tokens: tokensSchema,
  apiUsd: z.number().nullable(),
  priced: z.string(),
});

const roleRowSchema = z.object({
  role: z.string(),
  tokens: tokensSchema,
  apiUsd: z.number(),
});

const effortStatSchema = z.object({
  profile: z.string(),
  effort: z.string(),
  runs: z.number(),
  // Optional while reading snapshots from installations that predate usage coverage counts.
  usageSamples: z.number().optional(),
  pricedSamples: z.number().optional(),
  avgTokens: z.number().nullable(),
  avgUsd: z.number().nullable(),
});

const tierCardSchema = z.object({
  tier: z.string(),
  profile: z.string().nullable(),
  pool: z.string().nullable(),
  poolLabel: z.string().nullable(),
  cards: z.number().nullable(),
});

const claudeCategorySchema = z.object({
  category: z.string(),
  usd: z.number(),
  sharePct: z.number(),
});

const claudeSpendSchema = z.object({
  today: z.array(claudeCategorySchema),
  week: z.array(claudeCategorySchema),
  unmatchedDirs: z.array(z.string()),
  projectedPct: z.number().nullable(),
  dailyCapPct: z.number().nullable(),
  resetsAt: z.string().nullable(),
});

const dispatchSchema = z.object({
  tiers: z.array(tierCardSchema),
  costs: z.array(effortStatSchema),
  claude: claudeSpendSchema.nullable(),
});

export const PERIODS = ["today", "7d", "30d"] as const;
export type Period = (typeof PERIODS)[number];

export const boardUsageRpc = defineRpc({
  name: "board.usage",
  input: z.object({ period: z.enum(PERIODS) }),
  output: z.object({
    generatedAt: z.string(),
    scannedAt: z.string().nullable(),
    scanning: z.boolean(),
    pricesAt: z.string().nullable(),
    plans: z.array(planSchema),
    byModel: z.array(modelRowSchema),
    byRole: z.array(roleRowSchema),
    totals: z.object({ apiUsd: z.number(), planUsd: z.number(), tokens: tokensSchema }),
    warnings: z.array(z.string()),
    /** Dispatch state per pool key, same as the snapshot written for Paseo Kanban. */
    pools: z.record(z.string(), poolSchema).optional(),
    /** Pool order in force: by quota (needPerDay) or the user's plans.json override (DEMO_0124). */
    priority: z
      .object({
        order: z.array(z.string()),
        until: z.string(),
        mode: z.enum(["quota", "manual"]).optional(),
        needPerDay: z.record(z.string(), z.number().nullable()).optional(),
        overrideUntil: z.string().optional(),
      })
      .optional(),
    /** Per-tier capacity, profile × effort cost, and who spent the Claude week. Null when that file could not be written. */
    dispatch: dispatchSchema.nullable().optional(),
    /** Quotas grouped by company. Display only; dispatch still uses `pools`. */
    companies: z.array(companyCardSchema).optional(),
    /** AFC's own Cursor login. No token is included. */
    cursorLink: z.object({
      state: z.enum(["unlinked", "waiting", "authorized", "connected", "broken"]),
      message: z.string(),
    }).optional(),
  }),
});

export const planUpdateRpc = defineRpc({
  name: "board.plan-update",
  input: z.object({
    id: z.string(),
    priceUsdMonthly: z.number().nonnegative().nullable().optional(),
    manualUsedPct: z.number().min(0).max(100).nullable().optional(),
  }),
  output: z.object({ ok: z.boolean(), message: z.string() }),
});

export const cursorConnectRpc = defineRpc({
  name: "board.cursor-connect",
  input: z.object({}),
  output: z.object({ ok: z.boolean(), message: z.string() }),
});

export const cursorDisconnectRpc = defineRpc({
  name: "board.cursor-disconnect",
  input: z.object({}),
  output: z.object({ ok: z.boolean(), message: z.string() }),
});

/** Re-read reset coupons from Paseo or a CLI that can see them. Does not open a browser. */
export const resetCouponsRefreshRpc = defineRpc({
  name: "board.reset-coupons-refresh",
  input: z.object({}),
  output: z.object({ ok: z.boolean(), message: z.string() }),
});

/** Ahead-limited / normal / behind-use-first, plus stopped when a hard stop (not the progress line) closed the pool. */
export function paceStatusLabel(pool: { dispatchable: boolean; prefer?: boolean; paceState?: string | null }): string {
  if (pool.paceState === "unknown") return t("quota.unknown.label");
  if (!pool.dispatchable && pool.paceState === "ahead") return t("usage.pace.ahead");
  if (pool.prefer || pool.paceState === "behind") return t("usage.pace.behind");
  if (!pool.dispatchable) return t("usage.pace.stopped");
  return t("usage.pace.normal");
}

/** Dollars as a balance reports them: whole numbers bare, otherwise with cents. */
export function fmtBalanceUsd(n: number): string {
  return Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`;
}

/**
 * Reference line for Cursor's Paseo "Plan usage" balance: total spend at API prices across both quota blocks,
 * so it is not the percentage that decides dispatch (server/pools.ts MANUAL_STOP). `overageBilling` is display only.
 */
export function cursorBalanceNote(b: { usedUsd: number; limitUsd: number }, overageBilling: boolean | undefined): string {
  const billing = overageBilling === true ? t("usage.balance.overageOn") : overageBilling === false ? t("usage.balance.overageOff") : "";
  return t("usage.balance.note", { used: fmtBalanceUsd(b.usedUsd), limit: fmtBalanceUsd(b.limitUsd), billing });
}

export type BoardUsage = z.infer<typeof boardUsageRpc.output>;
export type UsagePlan = BoardUsage["plans"][number];
export type UsageWindow = UsagePlan["windows"][number];
export type Tokens = z.infer<typeof tokensSchema>;
