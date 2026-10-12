/// <reference types="node" />
// Quota windows of one plan, by adapter (shared/quota-adapters.ts):
//   claude-cli / codex-cli / grok-cli  the windows Paseo's listUsage reports for the plan's `usageProvider`
//   cursor-api                         a monthly window from Cursor's Auto percent (official API or screen), else the hand copy
//   manual                             a monthly window from the hand copy (plans with `cycleDay`), and nothing else:
//                                      provider windows are never read, so a switched-off cursor-api plan or a manual plan
//                                      that keeps `usageProvider` is judged on the hand copy (its 80% stop line). A
//                                      provider dollar balance stays on the monthly window as display only.
// A plan with no window at all gets one "quota not public" row so its spend still shows.
// Pure apart from the clock: callers pass the readings in.
import { adapterSpec, ANTIGRAVITY_CLI, CURSOR_API, mainWindowOf, MUSE_MSP, OPENCODE_GO_API, type AdapterId, type AntigravityBucket } from "../../../shared/fleet/quota-adapters";
import type { UsageWindow } from "../../../shared/fleet/usage";
import { t } from "../../../shared/fleet/i18n";
import type { Json } from "../util";
import type { CursorUsageReading } from "../cursor-usage";
import { antigravityPlanWindows, type AntigravityReading } from "../quota/antigravity-usage";
import { oneMonthBefore } from "../pools-pace";
import { cursorLivePct } from "../usage-view";
import { cycleBounds, manualState, validPercent, type ManualReading, type QuotaCycle } from "../../../shared/fleet/quota-cycle";
import { LIVE_READING_TTL_MS } from "../quota-timing";
import { providerSourceTime, quotaDisplayExpiry, validQuotaTime } from "../../../shared/fleet/quota-time";

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const WASTE_BELOW = 80;
const SHORT_ABOVE = 105;
const EARLY_ELAPSED = 0.1;
/** Cursor's total spend vs. plan dollars in Paseo's listUsage; shown for reference only (card #66 correction ④). */
const PLAN_USAGE_BALANCE = "plan_usage";

/** The plans.json fields the window readers use. */
export interface WindowPlan {
  id: string;
  priceUsdMonthly: number | null;
  usageProvider?: string;
  providers: string[];
  cycleDay?: number;
  manual?: { usedPct: number; at: string } | null;
  manualOverride?: ManualReading | null;
  quotaCycle?: QuotaCycle;
  stopPct?: number;
  quotaProtection?: "pause" | "none";
  /** gemini or claude-gpt. Missing: the ACP row stays unknown and no CLI rows are shown. */
  antigravityBucket?: AntigravityBucket | null;
}

/** One token row of the usage scan: the hour it fell in, who spent it, and its value at API prices. */
export interface UsdRow {
  hour: number;
  provider: string;
  model: string;
}

export interface WindowContext<R extends UsdRow = UsdRow> {
  windowsBy: Map<string, Json[]>;
  balances: Map<string, Json[]>;
  /** Cursor's last reading; null when the cursor-api adapter is off or nothing was read. */
  cursorReading: CursorUsageReading | null;
  /** agy /usage table. Null when antigravity-cli is off. Never a substitute for a proven ACP observation. */
  antigravityReading?: AntigravityReading | null;
  sumUsd: (pred: (r: R) => boolean) => number;
  quotaError?: string | null;
  providerCollectedAt?: string | null;
  now?: number;
}

export interface PlanBalance {
  usedUsd: number;
  limitUsd: number;
  usedPct: number;
  resetsAt: string;
  startsAt: string;
}

/**
 * Cursor's "Plan usage" balance (`id: "plan_usage"`, dollars): usedPct = used / limit × 100, resets at `resetsAt`,
 * the period started one calendar month earlier. Only these numeric fields are read. Null when anything is
 * missing or the limit is 0. Reference only (card #66 correction ④): it is Cursor's total spend at API prices
 * across both quota blocks, so it never decides dispatch.
 */
export function planBalance(balances: Json[] | undefined): PlanBalance | null {
  const b = (balances ?? []).find((x) => x && x.id === PLAN_USAGE_BALANCE);
  if (!b) return null;
  const used = b.used;
  const limit = b.limit;
  const end = typeof b.resetsAt === "string" ? Date.parse(b.resetsAt) : Number.NaN;
  if (typeof used !== "number" || !Number.isFinite(used) || typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) return null;
  if (Number.isNaN(end)) return null;
  const start = oneMonthBefore(new Date(end));
  return { usedUsd: used, limitUsd: limit, usedPct: (used / limit) * 100, resetsAt: new Date(end).toISOString(), startsAt: start.toISOString() };
}

function windowLengthMs(label: string, resetsAt: string | null, id: unknown, adapter: AdapterId, now = Date.now()): number | null {
  if (/week/i.test(label)) return 7 * DAY;
  if (adapter === MUSE_MSP || adapter === OPENCODE_GO_API) {
    if (id === "five_hour") return 5 * HOUR;
    const seconds = typeof id === "string" ? /^(\d+(?:\.\d+)?)s$/.exec(id) : null;
    const named = /^(\d+(?:\.\d+)?)-(hour|minute|day)$/i.exec(label);
    const duration = seconds ? Number(seconds[1]) * 1000 : named
      ? Number(named[1]) * ({ hour: HOUR, minute: 60_000, day: DAY }[named[2].toLowerCase()] ?? 0)
      : null;
    if (duration !== null && Number.isFinite(duration) && duration > 0) return duration;
    if (/month/i.test(label)) return 30 * DAY;
    // Rolling and Current window report no duration; do not invent a pace for them.
    return null;
  }
  if (/month/i.test(label)) return 30 * DAY;
  const left = resetsAt ? Date.parse(resetsAt) - now : 0;
  return left > 5 * HOUR ? 7 * DAY : 5 * HOUR;
}

function monthlyCycle(cycleDay: number, now = new Date()): { start: Date; end: Date } {
  const bounds = cycleBounds({ kind: "month", day: cycleDay, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, hour: 0, minute: 0 }, now.getTime())!;
  return { start: new Date(bounds.start), end: new Date(bounds.end) };
}

/** Recognized periods include the existing Session-length rule for adapters that normalize labels. */
function providerPeriod(label: string, id: unknown, resetsAt: string | null, adapter: AdapterId, now: number): { kind: QuotaCycle["kind"]; start: number | null } {
  const end = resetsAt ? Date.parse(resetsAt) : null;
  if (!adapterSpec(adapter).keepsLabels && /^Session$/i.test(label)) {
    const length = windowLengthMs(label, resetsAt, id, adapter, now)!;
    return { kind: length === 7 * DAY ? "week" : "duration", start: end === null ? null : end - length };
  }
  if (id === "five_hour") return { kind: "duration", start: end === null ? null : end - 5 * HOUR };
  if (/week/i.test(label) || id === "seven_day") return { kind: "week", start: end === null ? null : end - 7 * DAY };
  if (/month/i.test(label)) return { kind: "month", start: end === null ? null : oneMonthBefore(new Date(end)).getTime() };
  if (/^(daily|day)$/i.test(label) || id === "one_day") return { kind: "day", start: end === null ? null : end - DAY };
  const seconds = typeof id === "string" ? /^(\d+(?:\.\d+)?)s$/.exec(id) : null;
  const named = /^(\d+(?:\.\d+)?)-(hour|minute|day)$/i.exec(label);
  const duration = id === "five_hour" ? 5 * HOUR : seconds ? Number(seconds[1]) * 1000 : named
    ? Number(named[1]) * ({ hour: HOUR, minute: 60_000, day: DAY }[named[2].toLowerCase()] ?? 0) : null;
  if (duration !== null && Number.isFinite(duration) && duration > 0) return { kind: "duration", start: end === null ? null : end - duration };
  return { kind: "unknown", start: null };
}

function calendarLabel(kind: QuotaCycle["kind"]): string {
  return kind === "month" ? t("quota.setup.monthWindow") : kind === "week" ? t("quota.setup.weekWindow") : kind === "day" ? t("quota.setup.dayWindow") : kind === "duration" ? t("quota.setup.fixedWindow") : t("quota.setup.unknownWindow");
}

export function judgeAt(usedPct: number, start: number, lengthMs: number, at: number): Pick<UsageWindow, "elapsedPct" | "projectedPct" | "runsOutAt" | "verdict"> {
  const elapsed = Math.min(1, Math.max(0, (at - start) / lengthMs));
  if (elapsed < EARLY_ELAPSED) return { elapsedPct: elapsed * 100, projectedPct: null, runsOutAt: null, verdict: "unknown" };
  const projected = usedPct / elapsed;
  const runsOut = usedPct > 0 ? start + ((at - start) * 100) / usedPct : null;
  return {
    elapsedPct: elapsed * 100,
    projectedPct: projected,
    runsOutAt: runsOut !== null && runsOut < start + lengthMs ? new Date(runsOut).toISOString() : null,
    verdict: projected < WASTE_BELOW ? "waste" : projected > SHORT_ABOVE ? "short" : "on-track",
  };
}

function judge(usedPct: number | null, start: number, lengthMs: number): Pick<UsageWindow, "elapsedPct" | "projectedPct" | "runsOutAt" | "verdict"> {
  if (usedPct === null) return { elapsedPct: Math.min(100, Math.max(0, ((Date.now() - start) / lengthMs) * 100)), projectedPct: null, runsOutAt: null, verdict: "unknown" };
  return judgeAt(usedPct, start, lengthMs, Date.now());
}

/** Windows Paseo reports for the plan's usage provider. */
function providerWindowsOf(cfg: WindowPlan, adapter: AdapterId, ctx: WindowContext): UsageWindow[] {
  const mine = (r: UsdRow) => cfg.providers.includes(r.provider);
  const daily = cfg.priceUsdMonthly !== null ? (cfg.priceUsdMonthly * 12) / 365 : null;
  const windows: UsageWindow[] = [];
  for (const w of cfg.usageProvider ? (ctx.windowsBy.get(cfg.usageProvider) ?? []) : []) {
    const now = ctx.now ?? Date.now();
    const time = providerSourceTime(w, now);
    const collectedAt = validQuotaTime(w.collectedAt ?? ctx.providerCollectedAt, now);
    const basis = time.sampledAt ?? collectedAt;
    const label = String(w.label ?? "");
    const resetsAt = typeof w.resetsAt === "string" && Number.isFinite(Date.parse(w.resetsAt)) ? w.resetsAt : null;
    const rawUsed = typeof w.usedPct === "number" ? w.usedPct : typeof w.remainingPct === "number" ? 100 - w.remainingPct : null;
    // Legacy exhaustion rules must still see over-limit readings. Configured pools validate again below.
    const numeric = typeof rawUsed === "number" && Number.isFinite(rawUsed) && rawUsed >= 0 ? rawUsed : null;
    const expired = resetsAt !== null && Date.parse(resetsAt) <= now || basis !== null && now - Date.parse(basis) > 2 * HOUR;
    const used = expired ? null : numeric;
    const len = windowLengthMs(label, resetsAt, w.id, adapter, ctx.now ?? Date.now());
    const configured = cfg.quotaCycle !== undefined || cfg.manualOverride !== undefined;
    const period = providerPeriod(label, w.id, resetsAt, adapter, ctx.now ?? Date.now());
    const start = configured ? period.start : len === null ? null : resetsAt ? Date.parse(resetsAt) - len : Date.now() - len;
    const length = configured ? start !== null && resetsAt ? Date.parse(resetsAt) - start : null : len;
    const onlyFable = /fable/i.test(label);
    const apiUsd = ctx.sumUsd((r) => mine(r) && r.hour >= (start ?? Date.now() - 7 * DAY) - HOUR && (!onlyFable || /fable/i.test(r.model)));
    // Claude's five_hour window is labeled Session and must stay Session even when its reset is more than five hours away.
    // Other adapters (Codex) still use the old rename, so pool-status.json keeps window: "Weekly".
    const shown = adapterSpec(adapter).keepsLabels ? label : (/week/i.test(label) || len === 7 * DAY ? label.replace(/^Session$/i, "Weekly") : label);
    windows.push({
      ...(typeof w.id === "string" ? { id: w.id } : {}),
      label: shown,
      usedPct: used,
      resetsAt,
      startsAt: start === null ? null : new Date(start).toISOString(),
      ...(configured ? { cycleKind: period.kind } : {}),
      ...(start === null || length === null
        ? { elapsedPct: null, projectedPct: null, runsOutAt: null, verdict: "unknown" as const }
        : configured && used !== null ? judgeAt(used, start, length, ctx.now ?? Date.now()) : judge(used, start, length)),
      apiUsd,
      fullWindowUsd: used !== null && used >= 2 ? (apiUsd * 100) / used : null,
      planUsd: daily !== null && len !== null ? (daily * len) / DAY : null,
      source: "provider",
      manualAt: null,
      ...time,
      collectedAt,
      displayExpiresAt: quotaDisplayExpiry(basis, resetsAt),
      ...(w.providerStatus ? { providerStatus: w.providerStatus } : {}),
      readError: w.readError ?? null,
      safetyError: knownQuotaFailure(w.readError ?? ctx.quotaError),
      ...(configured ? { readingExpiresAt: readingExpiry(basis ?? (ctx.providerCollectedAt === undefined ? new Date(now).toISOString() : null), resetsAt) } : {}),
      ...(expired ? { staleUsedPct: numeric } : {}),
    });
  }
  return windows;
}

/** Only a real reader signal, never a missing percent, activates this independent failure stop. */
export function knownQuotaFailure(error: unknown): string | null {
  return typeof error === "string" && /quota|rate[_ -]?limit|auth|unauthorized|not.logged|login.*lost/i.test(error) ? error : null;
}

function cursorSafetyError(reading: CursorUsageReading | null): string | null {
  return reading?.linkBroken ? reading.notice ?? reading.error ?? "Cursor authentication failed" : knownQuotaFailure(reading?.error);
}

function cursorKnownStop(cfg: WindowPlan, reading: CursorUsageReading | null, now: number): string | null {
  const known = reading?.lastKnown;
  if (reading?.ok || cfg.quotaProtection === "none" || !known || !validQuotaTime(known.readAt, now)
    || known.autoPct < (cfg.stopPct ?? 97) || known.resetsAt && Date.parse(known.resetsAt) <= now) return null;
  return t("quota.setup.windowAtStop", { window: "Monthly", used: known.autoPct, stop: cfg.stopPct ?? 97 });
}

function readingExpiry(at: string | null, reset: string | null): string | null {
  if (!at) return null;
  return new Date(Math.min(Date.parse(at) + LIVE_READING_TTL_MS, reset ? Date.parse(reset) : Infinity)).toISOString();
}

/** Billing cycle of a monthly plan: the live Cursor reset wins over the configured billing day. */
function cycleOf(cfg: WindowPlan, live: number | null, cursorReading: CursorUsageReading | null): { start: Date; end: Date } {
  const cycle = monthlyCycle(cfg.cycleDay ?? 1);
  // Zero is a valid live reading and uses the provider reset, just like any other live percentage.
  if (live === null || !cursorReading?.resetsAt) return cycle;
  const parsed = Date.parse(cursorReading.resetsAt);
  if (Number.isNaN(parsed)) return cycle;
  const end = new Date(parsed);
  return { start: oneMonthBefore(end), end };
}

/** Monthly window: Cursor's live Auto percent for cursor-api, else the hand copy of this billing cycle. */
function monthlyWindowOf(cfg: WindowPlan, adapter: AdapterId, ctx: WindowContext): UsageWindow {
  const balance = cfg.providers.map((prov) => planBalance(ctx.balances.get(prov))).find((b) => b !== null) ?? null;
  const live = adapter === CURSOR_API ? cursorLivePct(ctx.cursorReading) : null;
  const { start, end } = cycleOf(cfg, live, ctx.cursorReading);
  const len = end.getTime() - start.getTime();
  const apiUsd = ctx.sumUsd((r) => cfg.providers.includes(r.provider) && r.hour >= start.getTime());
  // A live Auto percent (official API or /usage) replaces the hand copy. A copied percentage is judged at the time it was copied.
  const manual = live === null && cfg.manual && Date.parse(cfg.manual.at) >= start.getTime() ? cfg.manual : null;
  const used = live !== null ? live : manual?.usedPct ?? null;
  const verdict = used !== null
    ? judgeAt(used, start.getTime(), len, live !== null ? Date.now() : Date.parse(manual?.at ?? ""))
    : judge(null, start.getTime(), len);
  const liveSource = ctx.cursorReading?.source === "official" ? "official" : "screen";
  return {
    label: "Monthly",
    usedPct: used,
    resetsAt: end.toISOString(),
    startsAt: start.toISOString(),
    ...verdict,
    apiUsd,
    fullWindowUsd: null,
    planUsd: cfg.priceUsdMonthly,
    source: live !== null ? liveSource : manual ? "manual" : "none",
    manualAt: manual?.at ?? null,
    sampledAt: live !== null ? validQuotaTime(ctx.cursorReading?.readAt, ctx.now ?? Date.now()) : null,
    displayExpiresAt: quotaDisplayExpiry(live !== null ? validQuotaTime(ctx.cursorReading?.readAt, ctx.now ?? Date.now()) : manual?.at ?? null, end.toISOString()),
    safetyError: adapter === CURSOR_API ? cursorSafetyError(ctx.cursorReading) : null,
    knownQuotaStop: adapter === CURSOR_API ? cursorKnownStop(cfg, ctx.cursorReading, ctx.now ?? Date.now()) : null,
    // Card #66 correction ④: Paseo's balance does not split Cursor's quota blocks, so it is shown for
    // reference only. Dispatch uses the Auto percent from the official API or `/usage`, or the hand copy when both failed.
    balance: balance ? { usedUsd: balance.usedUsd, limitUsd: balance.limitUsd } : null,
  };
}

function hiddenWindowOf(cfg: WindowPlan, ctx: WindowContext, adapter: AdapterId): UsageWindow {
  const daily = cfg.priceUsdMonthly !== null ? (cfg.priceUsdMonthly * 12) / 365 : null;
  return {
    label: t("screen.window.quotaHidden"), usedPct: null, resetsAt: null, startsAt: null, elapsedPct: null, projectedPct: null, runsOutAt: null,
    verdict: "unknown", apiUsd: ctx.sumUsd((r) => cfg.providers.includes(r.provider) && r.hour >= Date.now() - 7 * DAY), fullWindowUsd: null, planUsd: daily !== null ? daily * 7 : null,
    source: "none", manualAt: null,
    readError: adapterSpec(adapter).readsProvider ? ctx.quotaError ?? null : null,
    safetyError: adapterSpec(adapter).readsProvider ? knownQuotaFailure(ctx.quotaError) : null,
  };
}

/** Every window of one plan under its adapter, in display order. */
export function windowsFor(cfg: WindowPlan, adapter: AdapterId, ctx: WindowContext): UsageWindow[] {
  // Before the hand-copy fallback: a stored usedPct must not become the ACP percent.
  if (adapter === ANTIGRAVITY_CLI) {
    const now = ctx.now ?? Date.now();
    return antigravityPlanWindows(
      { id: cfg.id, antigravityBucket: cfg.antigravityBucket ?? null, priceUsdMonthly: cfg.priceUsdMonthly },
      ctx.antigravityReading ?? null,
      now,
      ctx.sumUsd((row) => cfg.providers.includes(row.provider)),
    );
  }
  const provider = adapterSpec(adapter).readsProvider ? providerWindowsOf(cfg, adapter, ctx) : [];
  if (cfg.quotaCycle || cfg.manualOverride !== undefined) return configuredWindows(cfg, adapter, ctx, provider);
  const windows = [...provider, ...(cfg.cycleDay ? [monthlyWindowOf(cfg, adapter, ctx)] : [])];
  if (windows.length === 0) windows.push(hiddenWindowOf(cfg, ctx, adapter));
  return windows;
}

/** Live percentages take precedence; a stored fallback never changes the selected adapter. */
function configuredWindows(cfg: WindowPlan, adapter: AdapterId, ctx: WindowContext, provider: UsageWindow[]): UsageWindow[] {
  const now = ctx.now ?? Date.now();
  const cycle = cfg.quotaCycle ?? { kind: "unknown" };
  const main = mainWindowOf(adapter, provider) ?? provider[0];
  const providerError = adapterSpec(adapter).readsProvider ? ctx.quotaError ?? main?.readError : null;
  const cursor = adapter === CURSOR_API ? cursorLivePct(ctx.cursorReading) : null;
  const live = cursor !== null ? cursor : main?.usedPct ?? null;
  const reset = cursor !== null ? ctx.cursorReading?.resetsAt : main?.resetsAt;
  const sampledAt = validQuotaTime(cursor !== null ? ctx.cursorReading?.readAt : main?.sampledAt, now);
  const collectedAt = cursor !== null ? sampledAt : main?.collectedAt ?? (adapterSpec(adapter).readsProvider ? ctx.providerCollectedAt : null) ?? null;
  const expires = cursor !== null ? readingExpiry(sampledAt, reset ?? null) : main?.readingExpiresAt ?? null;
  const liveValid = validPercent(live) && !providerError && (!reset || Date.parse(reset) > now)
    && (expires === null ? ctx.providerCollectedAt === undefined : Date.parse(expires) > now);
  const manual = manualState(cfg.manualOverride === undefined ? cfg.manual : cfg.manualOverride, cycle, now);
  const used = liveValid ? live : manual.state === "manual" ? manual.reading!.usedPct : null;
  const liveEnd = reset ? Date.parse(reset) : null;
  const liveStart = cursor !== null && liveEnd !== null ? oneMonthBefore(new Date(liveEnd)).getTime() : main?.startsAt ? Date.parse(main.startsAt) : null;
  const liveBounds = liveStart !== null && liveEnd !== null && liveStart < liveEnd ? { start: liveStart, end: liveEnd } : null;
  const liveKind = cursor !== null ? "month" : main?.cycleKind ?? "unknown";
  const bounds = liveValid ? liveBounds : cycle.kind === "unknown" ? null : manual.bounds;
  const paceEligible = bounds !== null && (liveValid
    ? cycle.kind !== "unknown" && liveKind === cycle.kind && (cycle.kind !== "duration" || bounds.end - bounds.start === cycle.seconds * 1000)
    : cycle.kind !== "unknown");
  const error = liveValid || adapter === "manual" ? null : providerError ?? (adapter === CURSOR_API ? ctx.cursorReading?.error : null)
    ?? (main?.providerStatus === "available" ? null : t("quota.setup.readFailed"));
  const knownStop = !liveValid && cfg.quotaProtection !== "none" && typeof live === "number" && live >= (cfg.stopPct ?? 97)
    && (!reset || Date.parse(reset) > now)
    ? t("quota.setup.windowAtStop", { window: main?.label ?? "Monthly", used: live, stop: cfg.stopPct ?? 97 }) : null;
  const label = liveValid ? cursor !== null ? calendarLabel("month") : /^(weekly|monthly|daily|day)$/i.test(main!.label) ? calendarLabel(liveKind) : main!.label : calendarLabel(cycle.kind);
  const primary: UsageWindow = {
    ...(liveValid && cursor === null && main?.id ? { id: main.id } : {}),
    label, primary: true, usedPct: used,
    resetsAt: liveValid ? reset ?? null : bounds ? new Date(bounds.end).toISOString() : null,
    startsAt: bounds ? new Date(bounds.start).toISOString() : null,
    ...(paceEligible && bounds && used !== null ? judgeAt(used, bounds.start, bounds.end - bounds.start, now) : { elapsedPct: null, projectedPct: null, runsOutAt: null, verdict: "unknown" as const }),
    apiUsd: ctx.sumUsd(r => cfg.providers.includes(r.provider) && r.hour >= (bounds?.start ?? now - 7 * DAY)), fullWindowUsd: null, planUsd: cfg.priceUsdMonthly,
    source: liveValid ? cursor !== null ? "official" : "provider" : manual.state === "manual" ? "manual" : "none",
    manualAt: liveValid ? null : manual.reading?.at ?? null,
    sampledAt,
    collectedAt,
    ...(main?.providerStatus ? { providerStatus: main.providerStatus } : {}),
    sourceTimeKind: !liveValid && manual.state === "manual" ? "source" : cursor !== null ? sampledAt ? "source" : "unknown" : main?.sourceTimeKind ?? "unknown",
    // Safety expiry alone does not invalidate a successful sample's display. Failures and expired hand copies still do.
    displayExpiresAt: liveValid || (manual.state === "unknown" && validPercent(live) && !providerError && !main?.readError)
      ? quotaDisplayExpiry(sampledAt ?? collectedAt, reset ?? null) : null,
    safetyError: main?.safetyError ?? (adapter === CURSOR_API ? cursorSafetyError(ctx.cursorReading) : null) ?? knownQuotaFailure(providerError),
    knownQuotaStop: knownStop ?? (adapter === CURSOR_API ? cursorKnownStop(cfg, ctx.cursorReading, now) : null),
    readingState: liveValid ? "live" : manual.state === "unknown" && live !== null ? "stale" : manual.state,
    cycleKind: liveValid ? liveKind : cycle.kind, paceEligible,
    readError: error, staleUsedPct: manual.state === "stale" ? manual.reading?.usedPct ?? null : !liveValid ? live : null,
    readingExpiresAt: liveValid ? expires
      : manual.reading ? new Date(Math.min(Date.parse(manual.reading.at) + (manual.reading.ttlSeconds ?? 86400) * 1000, manual.reading.resetsAt ? Date.parse(manual.reading.resetsAt) : Infinity, manual.bounds?.end ?? Infinity)).toISOString() : null,
  };
  return [primary, ...provider.filter(w => w !== main)];
}
