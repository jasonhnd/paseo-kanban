import { X_ULTRA, xUltraReservePct } from "../../shared/fleet/x-ultra";
/// <reference types="node" />
// Assembles pool-status.json: one row per pool of the catalog (shared/quota-adapters.ts), then sibling softening,
// sub pools (Claude's Fable week) following their main pool, and ChatGPT credits.
import { join } from "node:path";
import { providerBanned } from "../../shared/fleet/provider-policy";
import { readBannedProviders, readUnknownQuotaPolicy } from "./adapters/config";
import {
  burnCapReason,
  BURN_FRONT_SESSION_PCT,
  BURN_FRONT_STOP_PCT,
  CODEX_BURN_STOP_PCT,
  DOUBLE_WEEK_STOP_PCT,
  codexCreditsLayer,
  type CodexCreditsInput,
} from "../../shared/fleet/reset-coupons";
import { parseBurnWeek } from "../../shared/fleet/reset-coupons-burn";
import {
  adapterSpec,
  baseAdapterOf,
  CLAUDE_CLI,
  CODEX_CLI,
  CURSOR_API,
  isLeaderPool,
  mainWindowOf,
  paceSiblings,
  type PoolEntry,
  poolCatalog,
  poolEntry,
  poolIdsOf,
  poolOfAdapter,
  sessionWindowOf,
  subWindowFor,
  unreadPolicy,
} from "../../shared/fleet/quota-adapters";
import type { UsagePlan, UsageWindow } from "../../shared/fleet/usage";
import { capSubNeed, type NeedKind, needPerDayOf, needTargetPct, wasteRiskOf } from "../../shared/fleet/waste-risk";
import { activeDispatchPriority, poolStatusPriority, resolveDispatchPriority, withPoolPriority } from "../../shared/fleet/dispatch-priority";
import { publishPoolStatusExport } from "./exports";
import { attachConsumption, QUOTA_HISTORY_FILE, recordSample } from "./quota-history";
import { forecastPool, recentReadings, unknownForecast } from "./pool-forecast";
import type { HistorySample } from "./quota-history";
import { trackEarlyResets } from "./early-reset";
import { readJson, STATE_DIR, writeJson } from "./util";
import { codexCouponInHand, configuredStopPct, hardReason, idleReason } from "./pools-hard";
import {
  type BurnPaceClock,
  judgePace,
  paceOf,
  type Pace,
  type PaceFlags,
  type PaceState,
  periodBounds,
  softenPaceHold,
} from "./pools-pace";
import {
  cursorLogoutBlocksDispatch,
  cursorLogoutHoldReason,
  EXHAUSTED,
  SUPERVISOR_SESSION_PAUSE,
  SUPERVISOR_WEEKLY_RESERVE,
} from "./pools-windows";
import {
  carriedSuffix,
  catalogRegex,
  escapeRegex,
  claudeReadingFromHistory,
  claudeReadingFromSnapshot,
  claudeUnreadReset,
  claudeUnreadStop,
  codexUnreadStop,
  decidePoolUnread,
  hasCarryMark,
  newerClaudeReading,
  unknownAllowed,
  withCarriedUsed,
  type ClaudeUsedReading,
} from "./pools-unread";
import {
  activeReviewerException,
  readPlansReviewerException,
  reviewerBandReason,
  withReviewerException,
  type ReviewerException,
} from "./pools-reviewer";
import type { CursorReadMeta, PoolStatus, PoolStatusOptions, SuperGrokReadMeta } from "./pools-types";
import { t, tAll } from "../../shared/fleet/i18n";
import { unknownQuotaPolicy, unknownQuotaReason } from "../../shared/fleet/unknown-quota";
import { notifyUnknownQuota } from "./unknown-quota";
import { validPercent } from "../../shared/fleet/quota-cycle";

export const POOL_STATUS = join(STATE_DIR, "pool-status.json");
const PLANS_FILE = join(STATE_DIR, "plans.json");

/** Appended when a dispatchable Codex pool still has an unexpired reset coupon. */
export function codexCouponPreferNote(): string {
  return t("pools.status.couponPreferNote");
}

type BurnOpt = NonNullable<PoolStatusOptions["claudeBurn"]>;

interface Draft {
  status: PoolStatus;
  flags: PaceFlags;
}

interface StatusCtx {
  now: number;
  catalog: PoolEntry[];
  options: PoolStatusOptions;
  burn: BurnOpt | null;
  burnNames: string[] | undefined;
  draft: Map<string, Draft>;
  carryNotes: Map<string, string>;
  /** Stop line each pool's needPerDay aims at, from the same mode that judged it (DEMO_0124). */
  targets: Map<string, number>;
}

interface PoolMode {
  burn: BurnOpt | null;
  burnOn: boolean;
  burnFront: boolean;
  burnBack: boolean;
  double: boolean;
  exception: ReviewerException | null;
  weeklyStop: number;
  sessionPause: number;
  allowPrefer: boolean;
  campaign: "double" | "front" | "back" | null;
}

interface UnreadResolution {
  judged: UsageWindow | undefined;
  carryNote: string | null;
  unreadStop: string | null;
  unreadReset: boolean;
}

function entry(
  plan: UsagePlan,
  w: UsageWindow | undefined,
  dispatchable: boolean,
  reason: string,
  flags?: { deprioritize?: boolean; prefer?: boolean; paceState?: PaceState },
): PoolStatus {
  return {
    ...(w && ("sampledAt" in w || "collectedAt" in w || w.manualAt) ? { observedAt: w.source === "manual" ? w.manualAt : w.sampledAt ?? w.collectedAt ?? null } : {}),
    ...(plan.quotaProtection ? { quotaProtection: plan.quotaProtection, readingExpiresAt: w?.readingExpiresAt ?? null } : {}),
    plan: plan.name,
    window: w?.label ?? null,
    usedPct: w?.usedPct ?? null,
    resetsAt: w?.resetsAt ?? null,
    ...unknownForecast(),
    verdict: w?.verdict ?? "unknown",
    dispatchable,
    deprioritize: flags?.deprioritize ?? false,
    prefer: flags?.prefer ?? false,
    elapsedPct: w?.elapsedPct ?? null,
    pacePct: null,
    daysLeft: null,
    periodDays: null,
    dailyPct: null,
    perRunPct: null,
    dailyRuns: null,
    paceState: flags?.paceState ?? (dispatchable ? "steady" : "stopped"),
    reason,
  };
}

function withPace(status: PoolStatus, pace: Pace, flags: PaceFlags): PoolStatus {
  return {
    ...status,
    dispatchable: flags.dispatchable,
    deprioritize: flags.deprioritize,
    prefer: flags.prefer,
    paceState: flags.paceState,
    reason: flags.reason,
    elapsedPct: pace.elapsedRatio === null ? status.elapsedPct : pace.elapsedRatio * 100,
    pacePct: pace.pacePct,
    daysLeft: pace.daysLeft,
    periodDays: pace.periodDays,
    dailyPct: pace.dailyPct,
  };
}

function campaignOf(double: boolean, burnFront: boolean, burnBack: boolean, claudeMain: boolean): PoolMode["campaign"] {
  if (double) return "double";
  if (burnFront && claudeMain) return "front";
  if (burnBack && claudeMain) return "back";
  return null;
}

/** Claude's coupon weeks (burn, double) and the reviewer exception apply to the Claude pools only. */
function poolMode(ctx: StatusCtx, pool: PoolEntry, plan: UsagePlan): PoolMode {
  const burn = ctx.burn;
  const claude = pool.adapter === CLAUDE_CLI;
  const claudeMain = claude && pool.parent === null;
  const burnOn = Boolean(burn) && claude;
  const burnFront = Boolean(burnOn && burn?.phase === "front");
  const burnBack = Boolean(burnOn && burn?.phase === "back");
  const double = ctx.options.claudeDoubleWeek === true && claudeMain && !burnOn;
  return {
    burn,
    burnOn,
    burnFront,
    burnBack,
    double,
    exception: claudeMain ? activeReviewerException(plan, ctx.now, double || burnOn) : null,
    weeklyStop: burnFront ? BURN_FRONT_STOP_PCT : double ? DOUBLE_WEEK_STOP_PCT : SUPERVISOR_WEEKLY_RESERVE,
    sessionPause: burnFront ? BURN_FRONT_SESSION_PCT : SUPERVISOR_SESSION_PAUSE,
    allowPrefer: burnOn && claudeMain,
    campaign: campaignOf(double, burnFront, burnBack, claudeMain),
  };
}

/** The adapter's unread rule: Codex stops on a stale carry, Claude resets after its week rolls (pools-unread.ts). */
function resolveUnread(pool: PoolEntry, w: UsageWindow | undefined, options: PoolStatusOptions, now: number): UnreadResolution {
  const blank: UnreadResolution = { judged: w, carryNote: null, unreadStop: null, unreadReset: false };
  const policy = unreadPolicy(pool);
  if (!policy || (w?.usedPct ?? null) !== null) return blank;
  const decision = decidePoolUnread(
    now,
    policy === "stop" ? options.priorCodex ?? null : options.priorClaude ?? null,
    w?.resetsAt ?? null,
    policy === "stop"
      ? { stopReason: codexUnreadStop(), onRolled: "stop" }
      : { stopReason: claudeUnreadStop(), onRolled: "reset" },
  );
  if (decision.kind === "carry") {
    return { judged: withCarriedUsed(w, decision.usedPct, decision.resetsAt), carryNote: decision.note, unreadStop: null, unreadReset: false };
  }
  if (decision.kind === "stop") return { ...blank, unreadStop: decision.reason };
  return { ...blank, unreadReset: true };
}

function paceModeFor(mode: PoolMode, codexBurn: boolean): "normal" | "double" | "burn-front" | "burn-back" {
  if (mode.burnFront) return "burn-front";
  if (mode.burnBack) return "burn-back";
  if (mode.double) return "double";
  if (codexBurn) return "burn-front";
  return "normal";
}

/**
 * The user-authorised ChatGPT burn week (plans.json codex coupon `burnWeek`), only while it is running and
 * a coupon is still in hand. Null otherwise, which leaves DEMO_0070 (the Codex pool never preferred) untouched.
 */
function codexBurnWeekNow(pool: PoolEntry, options: PoolStatusOptions, couponLive: boolean, now: number): boolean {
  if (pool.adapter !== CODEX_CLI || !couponLive) return false;
  const week = parseBurnWeek(options.codexBurnWeek);
  if (!week) return false;
  return now >= Date.parse(week.start) && now < Date.parse(week.end);
}

function paceClock(
  mode: PoolMode,
  bounds: { start: number; end: number } | null,
  codexBurn: boolean,
): BurnPaceClock | undefined {
  if (mode.burnOn && mode.burn) {
    return { startMs: mode.burn.startMs, endMs: mode.burn.endMs, baselinePct: mode.burn.baselinePct, usedAtMs: mode.burn.usedAtMs };
  }
  if (codexBurn && bounds) return { startMs: bounds.start, endMs: bounds.end };
  return undefined;
}

function pacePauseAllowed(mode: PoolMode, codexBurn: boolean, plan: UsagePlan): boolean {
  if (mode.double || mode.burnFront || codexBurn) return false;
  return plan.pacePause !== false;
}

// Campaign notes live in the catalog: pools.status.campaignAhead.<campaign> and pools.status.campaignBehind.<campaign>.

function applyCampaignPrefer(flags: PaceFlags, campaign: PoolMode["campaign"]): PaceFlags {
  if (!campaign || !flags.dispatchable) return flags;
  const ahead = flags.paceState === "ahead";
  return {
    ...flags,
    prefer: true,
    paceState: ahead ? "ahead" : "behind",
    reason: ahead ? `${flags.reason}${t(`pools.status.campaignAhead.${campaign}`)}` : t(`pools.status.campaignBehind.${campaign}`),
  };
}

function applyReviewerBand(
  status: PoolStatus,
  flags: PaceFlags,
  exception: ReviewerException | null,
  usedNow: number | null,
): { status: PoolStatus; flags: PaceFlags } {
  if (!exception || !flags.dispatchable || usedNow === null || usedNow < SUPERVISOR_WEEKLY_RESERVE || usedNow >= exception.stopPct) {
    return { status, flags };
  }
  const reason = reviewerBandReason(usedNow, exception);
  return {
    flags: { ...flags, prefer: false, reason },
    status: { ...status, prefer: false, reason, onlyRoles: [...exception.roles] },
  };
}

function applyUnreadNotes(
  status: PoolStatus,
  flags: PaceFlags,
  unreadReset: boolean,
  carryNote: string | null,
): Draft {
  const reset = unreadReset && !flags.hard
    ? { flags: { ...flags, reason: claudeUnreadReset(), paceState: "unknown" as const }, status: { ...status, reason: claudeUnreadReset(), paceState: "unknown" as const } }
    : { flags, status };
  if (!carryNote) return reset;
  const reason = t("pools.status.withNote", { reason: reset.flags.reason, note: carryNote });
  return { flags: { ...reset.flags, reason }, status: { ...reset.status, reason } };
}

function poolHard(
  pool: PoolEntry,
  plan: UsagePlan,
  judged: UsageWindow | undefined,
  sessionUsed: number | null,
  mode: PoolMode,
  couponLive: boolean,
): string | null {
  return hardReason(
    pool,
    judged,
    sessionUsed,
    mode.weeklyStop,
    mode.exception,
    couponLive ? CODEX_BURN_STOP_PCT : configuredStopPct(plan),
    mode.sessionPause,
    mode.burnFront || couponLive ? burnCapReason() : null,
    mode.burnOn && pool.parent !== null,
    !couponLive,
  );
}

function needKindOf(pool: PoolEntry | undefined): NeedKind {
  if (!pool) return "pool";
  if (isLeaderPool(pool)) return "leader";
  return pool.parent !== null ? "sub" : "pool";
}

function consider(ctx: StatusCtx, pool: PoolEntry, plan: UsagePlan, w: UsageWindow | undefined, sessionUsed: number | null): void {
  const key = pool.id;
  const mode = poolMode(ctx, pool, plan);
  const modern = plan.quotaProtection !== undefined || w?.readingState !== undefined;
  const unread = modern ? { judged: w, carryNote: null, unreadStop: null, unreadReset: false } : resolveUnread(pool, w, ctx.options, ctx.now);
  if (unread.carryNote) ctx.carryNotes.set(key, unread.carryNote);
  const judged = unread.judged;
  const bounds = modern && judged?.paceEligible === false ? null : periodBounds(pool.period, judged?.resetsAt ?? null, judged?.startsAt ?? null);
  const couponLive = pool.adapter === CODEX_CLI && codexCouponInHand(ctx.options.codexCouponCount, ctx.options.codexCouponExpiresAt, ctx.now);
  const codexBurn = couponLive && bounds !== null;
  const codexWeek = codexBurn && codexBurnWeekNow(pool, ctx.options, couponLive, ctx.now);
  const pace = paceOf(key, judged?.usedPct ?? null, bounds, ctx.now, paceModeFor(mode, codexBurn), paceClock(mode, bounds, codexBurn));
  // Same stop line poolHard judges this pool against.
  ctx.targets.set(key, needTargetPct(needKindOf(pool), mode.weeklyStop, couponLive ? CODEX_BURN_STOP_PCT : configuredStopPct(plan), mode.burnOn && pool.parent !== null));
  const stop = plan.stopPct ?? 97;
  const primaryLength = judged?.startsAt && judged.resetsAt ? Date.parse(judged.resetsAt) - Date.parse(judged.startsAt) : null;
  // Shorter provider windows can also exhaust the same pool, using its configured threshold.
  const shorter = modern && pool.parent === null && judged?.readingState === "live" && primaryLength !== null
    ? plan.windows.filter(window => window.source === "provider" && window.startsAt && window.resetsAt
      && Date.parse(window.resetsAt) > ctx.now && Date.parse(window.resetsAt) - Date.parse(window.startsAt) < primaryLength) : [];
  const exhausted = [judged, ...shorter].find(window => window?.usedPct !== null && window?.usedPct !== undefined && window.usedPct >= stop);
  const expired = judged?.readingExpiresAt != null && (!Number.isFinite(Date.parse(judged.readingExpiresAt)) || Date.parse(judged.readingExpiresAt) <= ctx.now);
  const safetyError = plan.windows.find(window => window.safetyError)?.safetyError ?? null;
  const knownQuotaStop = plan.quotaProtection === "none" ? null : plan.windows.find(window => window.knownQuotaStop)?.knownQuotaStop ?? null;
  const modernHard = plan.quotaProtection === "none" ? null : knownQuotaStop ?? (expired || !validPercent(judged?.usedPct)
    ? t(judged?.readingState === "stale" ? "quota.setup.staleHold" : "quota.setup.unknownHold")
    : exhausted ? t("quota.setup.windowAtStop", { window: exhausted.label, used: exhausted.usedPct!, stop }) : null);
  const hard = safetyError ?? knownQuotaStop ?? (modern ? modernHard : poolHard(pool, plan, judged, sessionUsed, mode, couponLive) ?? unread.unreadStop);
  const judgedFlags = judgePace(pool.neverPrefer, judged?.usedPct ?? null, pace, hard, idleReason(pool, judged), pacePauseAllowed(mode, codexBurn, plan), mode.allowPrefer || codexWeek);
  const flags = modern ? plan.quotaProtection === "none"
    ? { ...judgedFlags, dispatchable: true, prefer: false, deprioritize: false, hard: false, paceHold: false, reason: t("quota.setup.unprotected") }
    : judgedFlags : applyCampaignPrefer(judgedFlags, codexWeek ? "front" : mode.campaign);
  if (safetyError) Object.assign(flags, { dispatchable: false, prefer: false, deprioritize: false, hard: true, paceHold: false, reason: safetyError });
  if (modern && judged?.source === "manual") flags.reason = t("quota.setup.manualReason", { reason: flags.reason, at: judged.manualAt ?? "", error: judged.readError ?? "" });
  const paced = withPace(entry(plan, judged, flags.dispatchable, flags.reason), pace, flags);
  const status = ctx.burnNames && mode.burnOn ? { ...paced, unpauseProfiles: [...ctx.burnNames] } : paced;
  const band = applyReviewerBand(status, flags, mode.exception, judged?.usedPct ?? null);
  const reservePct = pool.parent ? mode.burnOn ? 100 - mode.weeklyStop : 0
    : pool.adapter === CODEX_CLI ? 20
    : isLeaderPool(pool) ? 100 - (band.status.onlyRoles?.length && mode.exception ? mode.exception.stopPct : mode.weeklyStop)
    : Math.max(0, 100 - (configuredStopPct(plan) ?? 100));
  const routingStatus = { ...band.status, adapter: pool.adapter, providers: [...(plan.providers ?? [])], parent: pool.parent, reservePct };
  ctx.draft.set(key, applyUnreadNotes(routingStatus, band.flags, unread.unreadReset, unread.carryNote));
}

/**
 * Every pool of the catalog, in catalog order: a main pool on its weekly window (with the 5-hour session for an
 * adapter that has one), a sub pool on its model window. An adapter that is not judged while plans.json turns
 * dispatch off (Codex) is left to closeUndispatched.
 */
function judgeListedPlans(plans: UsagePlan[], ctx: StatusCtx): void {
  const byId = new Map(plans.map((p) => [p.id, p]));
  for (const pool of ctx.catalog) {
    const plan = byId.get(pool.planId);
    if (!plan || planBanned(plan, ctx.options.bannedProviders)) continue;
    if (!adapterSpec(pool.adapter).judgedWhenOff && !plan.dispatch) continue;
    if (pool.sub !== null) {
      consider(ctx, pool, plan, subWindowFor(pool.adapter, pool.sub, plan.windows), null);
      continue;
    }
    const hasSession = adapterSpec(pool.adapter).session !== null;
    const session = sessionWindowOf(pool.adapter, plan.windows);
    consider(ctx, pool, plan, plan.windows.find(w => w.primary) ?? mainWindowOf(pool.adapter, plan.windows), hasSession ? session?.usedPct ?? null : null);
  }
}

function softenSiblingHolds(draft: Map<string, Draft>, siblings: Record<string, string[]>): void {
  const firstDispatchable = new Map([...draft].map(([key, row]) => [key, row.status.dispatchable]));
  for (const [key, row] of draft) {
    const others = (siblings[key] ?? []).filter((id) => firstDispatchable.has(id));
    const softened = softenPaceHold(
      row.flags,
      row.status.usedPct,
      row.status.pacePct,
      others.length > 0,
      others.length > 0 && others.every((id) => firstDispatchable.get(id) === false),
    );
    if (softened === row.flags) continue;
    draft.set(key, {
      flags: softened,
      status: {
        ...row.status,
        dispatchable: softened.dispatchable,
        deprioritize: softened.deprioritize,
        prefer: softened.prefer,
        paceState: softened.paceState,
        reason: softened.reason,
      },
    });
  }
}

function reapplyCarryNotes(draft: Map<string, Draft>, carryNotes: Map<string, string>): void {
  for (const [key, note] of carryNotes) {
    const carried = draft.get(key);
    if (!carried || hasCarryMark(carried.status.reason)) continue;
    const reason = t("pools.status.withNote", { reason: carried.status.reason, note });
    draft.set(key, { flags: { ...carried.flags, reason }, status: { ...carried.status, reason } });
  }
}

function subFollowReason(sub: PoolEntry, main: PoolEntry | undefined, ownHard: boolean, dispatchable: boolean, followMain: boolean, subReason: string, mainReason: string): string {
  if (ownHard) return subReason;
  if (!dispatchable) return t("pools.status.subFollowsMain", { sub: sub.names.line ?? sub.id, main: main?.names.label ?? String(sub.parent), reason: mainReason });
  return followMain ? mainReason : t("pools.pace.canDispatch");
}

function subPaceState(ownHard: boolean, dispatchable: boolean, deprioritize: boolean, mainState: PaceState): PaceState {
  if (ownHard) return "stopped";
  if (dispatchable && !deprioritize) return "steady";
  return mainState;
}

/**
 * A sub pool (Claude's Fable week) spends the main week. It dispatches only when that week does, and only while its own
 * reading is under its stop. Outside a burn week that stop is 97%, and it is never preferred.
 * During a burn week the stop is the phase line (100% then 75%) and it is still never preferred (docs/QUOTA-MANAGEMENT.md rule 5).
 * A reviewer-only exception on the main week is copied across, including onlyRoles.
 */
function alignSubPools(draft: Map<string, Draft>, catalog: PoolEntry[], burn: BurnOpt | null, burnNames: string[] | undefined): void {
  for (const pool of catalog) if (pool.parent !== null) alignSubWithMain(draft, pool, poolEntry(catalog, pool.parent), burn, burnNames);
}

function alignSubWithMain(draft: Map<string, Draft>, pool: PoolEntry, mainPool: PoolEntry | undefined, burn: BurnOpt | null, burnNames: string[] | undefined): void {
  const main = pool.parent ? draft.get(pool.parent) : undefined;
  const sub = draft.get(pool.id);
  const keepOwnExhausted = Boolean(sub && sub.flags.hard && !burn && (sub.status.usedPct ?? 0) >= EXHAUSTED);
  if (!main || !sub || keepOwnExhausted) return;
  const ownHard = sub.flags.hard;
  const dispatchable = main.status.dispatchable && !ownHard;
  const onlyRoles = ownHard ? undefined : main.status.onlyRoles;
  const followMain = Boolean(onlyRoles || main.status.deprioritize
    || hasCarryMark(main.status.reason)
    || unknownAllowed(main.status.reason));
  const reason = subFollowReason(pool, mainPool, ownHard, dispatchable, followMain, sub.status.reason, main.status.reason);
  const flags: PaceFlags = {
    ...sub.flags,
    dispatchable,
    deprioritize: ownHard ? false : main.status.deprioritize,
    prefer: false,
    paceState: subPaceState(ownHard, dispatchable, main.status.deprioritize, main.status.paceState),
    paceHold: false,
    hard: ownHard || (!dispatchable && main.flags.hard),
    reason,
  };
  draft.set(pool.id, {
    flags,
    status: subStatus(sub.status, flags, reason, onlyRoles, burnNames),
  });
}

function subStatus(
  status: PoolStatus,
  flags: PaceFlags,
  reason: string,
  onlyRoles: string[] | undefined,
  burnNames: string[] | undefined,
): PoolStatus {
  return {
    ...status,
    dispatchable: flags.dispatchable,
    deprioritize: flags.deprioritize,
    prefer: flags.prefer,
    paceState: flags.paceState,
    reason,
    ...(onlyRoles ? { onlyRoles: [...onlyRoles] } : {}),
    ...(burnNames ? { unpauseProfiles: [...burnNames] } : {}),
  };
}

/** True when afc.config.json excludes this plan from dispatch. The default list is empty. */
function planBanned(plan: UsagePlan, terms: readonly string[] | undefined): boolean {
  return providerBanned(plan, terms);
}

function closeUndispatched(draft: Map<string, Draft>, plans: UsagePlan[], terms: readonly string[] | undefined): void {
  for (const plan of plans) {
    if (plan.dispatch) continue;
    if (planBanned(plan, terms)) continue;
    const reason = plan.note || t("pools.status.planNotUsed");
    // Closing dispatch cannot change the reading already chosen by the catalog/configuration.
    const status = draft.get(plan.id)?.status
      ?? entry(plan, plan.windows.find(w => w.primary) ?? mainWindowOf(baseAdapterOf(plan), plan.windows), false, reason);
    draft.set(plan.id, {
      flags: { dispatchable: false, deprioritize: false, prefer: false, paceState: "closed", paceHold: false, hard: true, reason },
      status: { ...status, dispatchable: false, deprioritize: false, prefer: false, paceState: "closed", reason },
    });
  }
}

export function poolStatus(plans: UsagePlan[], options: PoolStatusOptions = {}): Record<string, PoolStatus> {
  plans = plans.filter((plan) => !providerBanned(plan, options.bannedProviders)).map(plan => {
    const reserve = plan.id === X_ULTRA ? xUltraReservePct(plan.xUltraReserve) : null;
    return reserve === null ? plan : { ...plan, stopPct: Math.min(plan.stopPct ?? 97, 100 - reserve) };
  });
  const now = options.now ?? Date.now();
  const burn = options.claudeBurn ?? null;
  const catalog = options.catalog ?? poolCatalog(plans);
  const ctx: StatusCtx = {
    now,
    catalog,
    options,
    burn,
    burnNames: burn && burn.unpauseProfiles.length > 0 ? burn.unpauseProfiles : undefined,
    draft: new Map(),
    carryNotes: new Map(),
    targets: new Map(),
  };
  judgeListedPlans(plans, ctx);
  softenSiblingHolds(ctx.draft, options.siblings ?? paceSiblings(catalog));
  reapplyCarryNotes(ctx.draft, ctx.carryNotes);
  alignSubPools(ctx.draft, catalog, burn, ctx.burnNames);
  closeUndispatched(ctx.draft, plans, options.bannedProviders);
  // DEMO_0070: the coupon used to force prefer on the Codex pool here (reason + codexCouponPreferNote()).
  // Removed on purpose; the coupon record and burn-mode pacing are untouched, only the preference is gone.
  applyCodexCredits(ctx.draft, plans, options, now, catalog);
  const pools = Object.fromEntries([...ctx.draft].map(([key, row]) => [key, { ...row.status, ...wasteRiskOf(row.status) }]));
  return applyXUltraReserve(withQuotaStates(withNeed(restrictPlanRoles(pools, plans, catalog), ctx.targets, catalog), plans, catalog, options, now), plans, options);
}

/** Unknown reserves impose the conservative G1d bounds; configured reserves can only narrow dispatch. */
function applyXUltraReserve(pools: Record<string, PoolStatus>, plans: UsagePlan[], options: PoolStatusOptions): Record<string, PoolStatus> {
  const row = pools[X_ULTRA];
  if (!row) return pools;
  const reserve = xUltraReservePct(plans.find(p => p.id === X_ULTRA)?.xUltraReserve);
  if (reserve === null) {
    const base = unknownQuotaPolicy(options.unknownQuota);
    const policy = { ...base, maxConcurrent: Math.min(1, base.maxConcurrent), tiers: base.tiers.filter(tier => tier === "L1" || tier === "L2") };
    pools[X_ULTRA] = { ...row, state: "unknown", unknownQuota: policy, prefer: false,
      reason: `${row.reason} ${t("quota.xUltra.reservePending")} ${unknownQuotaReason(policy)}` };
  } else {
    const stopped = row.usedPct !== null && row.usedPct >= 100 - reserve;
    pools[X_ULTRA] = { ...row, reservePct: reserve, ...(stopped ? { dispatchable: false, prefer: false, deprioritize: false,
      reason: t("quota.xUltra.reserveStop", { reserve }), paceState: "stopped" as const } : {}) };
  }
  return pools;
}

/** Preserve hard stops and pool order while making failed/expired source evidence explicit. */
function withQuotaStates(pools: Record<string, PoolStatus>, plans: UsagePlan[], catalog: PoolEntry[], options: PoolStatusOptions, now: number): Record<string, PoolStatus> {
  const policy = unknownQuotaPolicy(options.unknownQuota);
  for (const [id, row] of Object.entries(pools)) {
    const pool = catalog.find(item => item.id === id);
    const plan = plans.find(item => item.id === (pool?.planId ?? id));
    const w = plan && pool ? pool.sub !== null ? subWindowFor(pool.adapter, pool.sub, plan.windows)
      : plan.windows.find(window => window.primary) ?? mainWindowOf(pool.adapter, plan.windows) : undefined;
    const clock = w?.source === "manual" ? w.manualAt : w?.sampledAt ?? w?.collectedAt;
    const at = clock ? Date.parse(clock) : NaN;
    // Numeric legacy fixtures/files without any source-clock fields retain their old policy.
    const clocked = !!w && ("sampledAt" in w || "collectedAt" in w || w.source === "manual" && !!w.manualAt);
    const deadlines = [clocked ? Number.isFinite(at) && at <= now ? at + policy.maxAgeMs : now : Infinity,
      ...[w?.readingExpiresAt, w?.resetsAt].filter((value): value is string => value != null).map(value => Date.parse(value))];
    const expires = Math.min(...deadlines);
    const unknown = !validPercent(w?.usedPct) || !!w?.readError || w?.readingState === "stale" || w?.readingState === "unknown"
      || !Number.isFinite(expires) && expires !== Infinity || expires <= now;
    const fields = { state: unknown ? "unknown" as const : "known" as const, unknownQuota: policy,
      ...(expires !== Infinity ? { quotaStateExpiresAt: Number.isFinite(expires) ? new Date(expires).toISOString() : null } : {}) };
    pools[id] = unknown ? { ...row, ...fields, usedPct: null, projectedPct: null, runsOutAt: null, prefer: false,
      paceState: "unknown", reason: row.dispatchable ? unknownQuotaReason(policy) : row.reason }
      : { ...row, ...fields };
  }
  return pools;
}

/** Apply explicit role limits last: they can narrow a reviewer exception, but never reopen a pool. */
function restrictPlanRoles(pools: Record<string, PoolStatus>, plans: UsagePlan[], catalog: PoolEntry[]): Record<string, PoolStatus> {
  const byId = new Map(plans.map(plan => [plan.id, plan]));
  const planIds = new Map(catalog.map(pool => [pool.id, pool.planId]));
  for (const [id, row] of Object.entries(pools)) {
    const roles = byId.get(planIds.get(id) ?? id)?.onlyRoles;
    if (!roles?.length) continue;
    const onlyRoles = row.onlyRoles?.length ? roles.filter(role => row.onlyRoles!.includes(role)) : [...roles];
    pools[id] = onlyRoles.length > 0 ? { ...row, onlyRoles } : {
      ...row, onlyRoles, dispatchable: false, prefer: false, deprioritize: false,
      paceState: "stopped", reason: t("dispatch.status.paused"),
    };
  }
  return pools;
}

/**
 * Points per day still to use before reset, the dispatch order inside the dispatchable band (DEMO_0124).
 * wastePct / wasteRisk (DEMO_0122) stay on the row for display only. A pool closed to dispatch keeps 97% as target.
 * A sub pool's need is capped at its main pool's (needCappedBy marks it); its needTargetPct stays its own line.
 */
function withNeed(pools: Record<string, PoolStatus>, targets: Map<string, number>, catalog: PoolEntry[]): Record<string, PoolStatus> {
  const out: Record<string, PoolStatus> = {};
  for (const [key, row] of Object.entries(pools)) {
    const target = targets.get(key) ?? needTargetPct(needKindOf(poolEntry(catalog, key)), SUPERVISOR_WEEKLY_RESERVE, null);
    out[key] = { ...row, needTargetPct: target, needPerDay: needPerDayOf(row.usedPct, row.daysLeft, target) };
  }
  // A sub pool keeps its own target but its need is capped at the main week's (it spends that week too).
  for (const pool of catalog) {
    const sub = pool.parent !== null ? out[pool.id] : undefined;
    const main = pool.parent !== null ? out[pool.parent] : undefined;
    if (sub && main && pool.parent) out[pool.id] = { ...sub, ...capSubNeed(sub.needPerDay ?? null, main.needPerDay ?? null, pool.parent) };
  }
  return out;
}

/** True when this codex row is stopped by the weekly percent, which credits may replace. */
function weeklyQuotaStop(reason: string): boolean {
  if (tAll("pools.hard.weekSpent").some((text) => reason.includes(text))) return true;
  const week = tAll("pools.hard.thisWeek").map(escapeRegex).join("|");
  return catalogRegex("pools.hard.planStop", { period: `(?:${week})`, used: "\\s*\\d+", stop: "\\s*\\d+" }).test(reason);
}

/**
 * After the weekly stop, and only when no unexpired coupon is waiting.
 * Before the credits start date the weekly stop stays as it is.
 * A week that still has room, or a week whose percent was not read, is left alone.
 * A plan with dispatch turned off, and any stop that is not the weekly percent, stay stopped.
 * A carried percent keeps its original read time on the reason, whether or not credits dispatch.
 */
function applyCodexCredits(draft: Map<string, Draft>, plans: UsagePlan[], options: PoolStatusOptions, now: number, catalog: PoolEntry[]): void {
  const credits = options.codexCredits;
  if (!credits) return;
  for (const id of poolIdsOf(catalog, CODEX_CLI)) {
    const row = draft.get(id);
    if (!row) continue;
    const plan = plans.find((item) => item.id === id);
    if (!creditsApply(row, plan, options, now)) continue;
    const decision = codexCreditsLayer(now, credits);
    if (!decision.applies) continue;
    draft.set(id, creditsDraft(row, decision.dispatchable, decision.reason));
  }
}

function creditsApply(row: Draft, plan: UsagePlan | undefined, options: PoolStatusOptions, now: number): boolean {
  if (!plan?.dispatch || row.status.paceState === "closed") return false;
  if (codexCouponInHand(options.codexCouponCount, options.codexCouponExpiresAt, now)) return false;
  const used = row.status.usedPct;
  if (used === null) return false;
  const stop = configuredStopPct(plan) ?? EXHAUSTED;
  if (used < stop) return false;
  return !row.status.dispatchable && weeklyQuotaStop(row.status.reason);
}

function creditsDraft(row: Draft, dispatchable: boolean, decisionReason: string): Draft {
  const previous = hasCarryMark(row.status.reason) ? row.status.reason : row.flags.reason;
  const suffix = carriedSuffix(previous);
  const reason = suffix && !hasCarryMark(decisionReason) ? `${decisionReason}${suffix}` : decisionReason;
  const paceState = dispatchable ? "steady" as const : "stopped" as const;
  return {
    flags: { ...row.flags, dispatchable, prefer: false, deprioritize: false, paceState, paceHold: false, hard: !dispatchable, reason },
    status: { ...row.status, dispatchable, prefer: false, deprioritize: false, paceState, reason },
  };
}

/** Overlay the logout hold onto the cursor-api pools of an already judged snapshot. Other pools are left as they are. */
export function applyCursorLogoutHold(pools: Record<string, PoolStatus>, raw: unknown, now: number, cursorPools: readonly string[]): Record<string, PoolStatus> {
  if (!cursorLogoutBlocksDispatch(raw, now)) return pools;
  let next = pools;
  for (const id of cursorPools) {
    const cursor = next[id];
    if (!cursor) continue;
    next = {
      ...next,
      [id]: {
        ...cursor,
        dispatchable: false,
        deprioritize: false,
        prefer: false,
        paceState: "stopped",
        reason: cursorLogoutHoldReason(),
      },
    };
  }
  return next;
}

/** Pools that can carry a previous reading (an adapter with an unread rule). */
export function carriedPools(catalog: readonly PoolEntry[]): string[] {
  return catalog.filter((pool) => unreadPolicy(pool) !== null).map((pool) => pool.id);
}

/** A carried percent must not be stored as a new history sample, or the 30-minute clock would restart. */
export function withoutCarriedReadings(pools: Record<string, PoolStatus>, carried: readonly string[]): Record<string, PoolStatus> {
  let next = pools;
  for (const key of carried) {
    const row = next[key];
    if (!row || !hasCarryMark(row.reason)) continue;
    next = { ...next, [key]: { ...row, usedPct: null } };
  }
  return next;
}

async function readPriorReadings(pools: string[]): Promise<Record<string, ClaudeUsedReading | null>> {
  const [snap, history] = await Promise.all([
    readJson<{ generatedAt?: unknown; pools?: Record<string, { usedPct?: unknown; resetsAt?: unknown; reason?: unknown }> } | null>(POOL_STATUS, null),
    readJson<{ samples?: Array<{ at?: unknown; pools?: Record<string, { usedPct?: unknown; resetsAt?: unknown }> }> }>(QUOTA_HISTORY_FILE, { samples: [] }),
  ]);
  const samples = Array.isArray(history.samples) ? history.samples : [];
  const out: Record<string, ClaudeUsedReading | null> = {};
  for (const pool of pools) out[pool] = newerClaudeReading(claudeReadingFromSnapshot(snap, pool), claudeReadingFromHistory(samples, pool));
  return out;
}

export async function writePoolStatus(
  plans: UsagePlan[],
  cursorRead?: CursorReadMeta | null,
  now = Date.now(),
  claudeDoubleWeek = false,
  supergrokRead?: SuperGrokReadMeta | null,
  claudeBurn: PoolStatusOptions["claudeBurn"] = null,
  codexCouponCount = 0,
  codexCouponExpiresAt: string | null = null,
  codexCredits: CodexCreditsInput | null = null,
  codexBurnWeek: PoolStatusOptions["codexBurnWeek"] = null,
  catalog: PoolEntry[] = poolCatalog(plans),
): Promise<Record<string, PoolStatus>> {
  const plansForStatus = withReviewerException(plans, await readPlansReviewerException());
  const claudeId = poolOfAdapter(catalog, CLAUDE_CLI)?.id ?? null;
  const codexId = poolOfAdapter(catalog, CODEX_CLI)?.id ?? null;
  const prior = await readPriorReadings([claudeId, codexId].filter((id): id is string => id !== null));
  const pools = await recordPools(plansForStatus, {
    now,
    catalog,
    claudeDoubleWeek: claudeDoubleWeek && !claudeBurn,
    claudeBurn,
    priorClaude: claudeId ? prior[claudeId] : null,
    priorCodex: codexId ? prior[codexId] : null,
    codexCouponCount,
    codexCouponExpiresAt,
    codexBurnWeek,
    codexCredits,
    bannedProviders: readBannedProviders(),
    unknownQuota: readUnknownQuotaPolicy(),
  });
  const override = activeDispatchPriority(await readJson<unknown>(PLANS_FILE, null), now);
  const loginState = await readJson<unknown>(join(STATE_DIR, "cursor-login-state.json"), null);
  const judged = applyCursorLogoutHold(pools, loginState, now, poolIdsOf(catalog, CURSOR_API));
  // Same pure function and the same `now` as publishDispatch, so pool-status.json and the matrix agree.
  const priority = resolveDispatchPriority(judged, override, now);
  const held = withPoolPriority(judged, priority);
  const priorityLine = poolStatusPriority(priority);
  await writeJson(POOL_STATUS, {
    generatedAt: new Date(now).toISOString(),
    rules: "the configured quota policy",
    priority: priorityLine,
    pools: held,
    ...(cursorRead ? { cursorRead } : {}),
    ...(supergrokRead ? { supergrokRead } : {}),
  });
  // File-only recovery tracking; panel publications never send messages.
  await notifyUnknownQuota(held, [], async () => {}, undefined, now).catch(error => console.error("[afc] unknown quota tracking:", String(error).slice(0, 160)));
  // The fleet-quota/v1 copy for Kanban; logs and carries on if it fails.
  await publishPoolStatusExport(held, priorityLine, now);
  // Files only: compare with the last reading for an official early reset. A carried percent is not a new reading.
  await trackEarlyResets(withoutCarriedReadings(held, carriedPools(catalog)), now).catch((error) => {
    console.error("[afc] early reset:", String(error).slice(0, 160));
  });
  return held;
}

async function recordPools(plans: UsagePlan[], options: PoolStatusOptions): Promise<Record<string, PoolStatus>> {
  let pools = poolStatus(plans, options);
  try {
    const carried = carriedPools(options.catalog ?? poolCatalog(plans));
    const samples = await recordSample(withoutCarriedReadings(pools, carried), options.now ?? Date.now());
    pools = await attachConsumption(pools, samples);
  } catch (e) {
    console.error("[afc] quota history:", String(e).slice(0, 200));
  }
  try {
    const now = options.now ?? Date.now();
    const file = join(STATE_DIR, "quota-forecast-history.json");
    const history = await readJson<{ samples: HistorySample[] }>(file, { samples: [] });
    const readings = withoutCarriedReadings(pools, carriedPools(options.catalog ?? poolCatalog(plans)));
    const samples = recentReadings(Array.isArray(history.samples) ? history.samples : [], readings, now);
    await writeJson(file, { samples });
    pools = Object.fromEntries(Object.entries(pools).map(([key, pool]) => {
      const forecasted = { ...pool, ...forecastPool(readings[key], samples, key, now) };
      return [key, { ...forecasted, ...wasteRiskOf(forecasted) }];
    }));
  } catch (e) {
    console.error("[afc] quota forecast:", String(e).slice(0, 200));
  }
  return pools;
}
