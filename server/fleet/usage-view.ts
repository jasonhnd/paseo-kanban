/// <reference types="node" />
// Pure view helpers for usage.ts: Cursor read shapes, dispatch/pool/company views and the Cursor link banner.
import type { DispatchStats } from "../../shared/fleet/dispatch";
import { poolLabel } from "../../shared/fleet/dispatch";
import { ANTIGRAVITY_CLI, CURSOR_API, isMonthlyWindow } from "../../shared/fleet/quota-adapters";
import type { CompanyCursorRead, CompanyProviderWindow } from "../../shared/fleet/quota-companies";
import type { BoardUsage, UsagePlan } from "../../shared/fleet/usage";
import { cursorLinkOverride, msgUnlinked, type CursorUsageReading } from "./cursor-usage";
import { t, tAll, type MessageKey } from "../../shared/fleet/i18n";
import type { CursorReadMeta, PoolStatus } from "./pools";
import { quotaDisplayExpiry, validQuotaTime } from "../../shared/fleet/quota-time";

/** Cursor login-file and lost-login alarms; a stored alarm may be in any catalog language. */
const TOKEN_ALARM_KEYS: readonly MessageKey[] = [
  "cursor.token.mode",
  "cursor.token.save",
  "cursor.token.unreadable",
  "cursor.token.write",
  "cursor.usage.loginLost",
];

function tokenAlarm(value: string | null | undefined): string | null {
  return value && TOKEN_ALARM_KEYS.some((key) => tAll(key).includes(value)) ? value : null;
}

function errorMentionsLogin(error: string): boolean {
  if (/not logged in|press any key to log in/i.test(error)) return true;
  const lower = error.toLowerCase();
  return tAll("usage.view.loginScreenMarker").some((marker) => lower.includes(marker.toLowerCase()));
}

export function cursorReadForPlan(reading: CursorUsageReading | null, manualAt: string | null): BoardUsage["plans"][number]["cursorRead"] {
  if (!reading) return null;
  const live = reading.ok && reading.autoPct !== null;
  return {
    readAt: validQuotaTime(reading.readAt, Date.now()),
    ok: live,
    includedPct: reading.includedPct,
    autoPct: reading.autoPct,
    apiPct: reading.apiPct,
    onDemandUsd: reading.onDemandUsd,
    onDemandLimitUsd: reading.onDemandLimitUsd,
    usingManual: !live,
    manualAt,
    error: live ? null : reading.error,
    loggedOut: !live && reading.linkBroken !== true && (reading.loggedOut === true || errorMentionsLogin(reading.error ?? "")),
    linkBroken: reading.linkBroken === true,
    via: reading.source === "official" ? "official" : live ? "screen" : "manual",
    alarm: tokenAlarm(reading.homeAlarm),
    ...(reading.screenRead === false ? { screenRead: false as const } : {}),
  };
}

/** Auto percent that decides Cursor dispatch. Official and screen reads both count; a failed read does not. */
export function cursorLivePct(reading: { ok?: boolean; autoPct?: number | null } | null): number | null {
  return reading?.ok === true && typeof reading.autoPct === "number" ? reading.autoPct : null;
}

export function cursorMeta(reading: CursorUsageReading | null, manualAt: string | null): CursorReadMeta | null {
  const shown = cursorReadForPlan(reading, manualAt);
  if (!shown) return null;
  const alarm = shown.alarm ?? null;
  return { ok: shown.ok, readAt: shown.readAt, usingManual: shown.usingManual, manualAt: shown.manualAt, error: shown.error, loggedOut: shown.loggedOut === true, linkBroken: shown.linkBroken === true, ...(shown.screenRead === false ? { screenRead: false as const } : {}), ...(alarm ? { alarm } : {}) };
}

function leaderProfile(name: string | null, supervisorNames: ReadonlySet<string>): string | null {
  if (!name) return name;
  return supervisorNames.has(name) ? "<leader>" : name;
}

/** `labels`: pool id → display name (shared/quota-adapters.ts poolNames(catalog, "label")). */
export function dispatchView(stats: DispatchStats | null, supervisorNames: ReadonlySet<string>, labels: Readonly<Record<string, string>> = {}): BoardUsage["dispatch"] {
  if (!stats) return null;
  return {
    tiers: stats.tiers.map((tier) => ({
      tier: tier.tier,
      profile: leaderProfile(tier.profile, supervisorNames),
      pool: tier.pool,
      poolLabel: tier.pool ? poolLabel(tier.pool, labels) : null,
      cards: tier.cards,
    })),
    costs: stats.byProfileEffort.map((row) => ({ ...row, profile: leaderProfile(row.profile, supervisorNames) ?? row.profile })),
    claude: stats.claude,
  };
}

/** `earlyReset`: quota page line per pool after an official early reset (server/early-reset.ts readEarlyResetLines). */
export function poolView(pools: Record<string, PoolStatus>, earlyReset: Record<string, string> = {}): NonNullable<BoardUsage["pools"]> {
  return Object.fromEntries(
    Object.entries(pools).map(([key, p]) => [key, {
      dispatchable: p.dispatchable,
      deprioritize: p.deprioritize,
      prefer: p.prefer,
      reason: p.reason,
      usedPct: p.usedPct,
      pacePct: p.pacePct,
      daysLeft: p.daysLeft,
      periodDays: p.periodDays,
      dailyPct: p.dailyPct,
      perRunPct: p.perRunPct,
      dailyRuns: p.dailyRuns,
      projectedPct: p.projectedPct,
      runsOutAt: p.runsOutAt,
      burnRatePctPerHour: p.burnRatePctPerHour,
      forecastConfidence: p.forecastConfidence,
      paceState: p.paceState,
      ...(earlyReset[key] ? { earlyReset: earlyReset[key] } : {}),
    }]),
  );
}

/** Windows of every plan the company cards draw from plan windows; a cursor-api plan's card uses the Cursor read instead. */
export function companyWindows(plans: UsagePlan[], panelAt?: string): CompanyProviderWindow[] {
  const now = panelAt && Number.isFinite(Date.parse(panelAt)) ? Date.parse(panelAt) : Date.now();
  return plans.filter((p) => p.adapter !== CURSOR_API).flatMap((p) => (p.adapter === ANTIGRAVITY_CLI ? p.antigravityDisplay ?? p.windows : p.windows).map((w) => {
    const readAt = validQuotaTime(w.source === "manual" ? w.manualAt : w.sampledAt, now);
    // An explicit display deadline preserves a successful automatic sample after its dispatch safety pause.
    const displayOnly = w.readingState === "stale" && w.source === "none" && !w.manualAt && w.displayExpiresAt != null;
    return {
      planId: p.id,
      label: w.label,
      id: w.id,
      cycleKind: w.cycleKind,
      primary: w.primary,
      usedPct: w.usedPct ?? w.staleUsedPct ?? null,
      resetsAt: w.resetsAt,
      source: w.source === "manual" || w.source === "none" || w.source === "provider" ? w.source : "screen",
      readAt,
      sourceTimeKind: readAt ? w.source === "manual" ? "source" : w.sourceTimeKind ?? "source" : "unknown",
      collectedAt: validQuotaTime(w.collectedAt, now),
      displayExpiresAt: w.displayExpiresAt ?? quotaDisplayExpiry(validQuotaTime(w.source === "manual" ? w.manualAt : w.sampledAt ?? w.collectedAt, now),
        w.source === "manual" ? w.readingExpiresAt ?? w.resetsAt : w.resetsAt),
      // A safety-only pause is still a successful display sample, not a reader failure.
      readError: displayOnly ? null : w.readError ?? null,
      providerStatus: w.providerStatus,
      readingState: displayOnly ? readAt ? "live" : "unknown" : w.readingState ?? (w.readError ? "stale" : readAt ? "live" : "unknown"),
      readingExpiresAt: w.readingExpiresAt,
    };
  }));
}

export function companyCursor(plans: UsagePlan[], reading: CursorUsageReading | null, cursorRead: CursorReadMeta | null): CompanyCursorRead | null {
  const monthly = plans.find((p) => p.adapter === CURSOR_API)?.windows.find(isMonthlyWindow);
  if (!reading && !monthly) return null;
  const live = reading?.ok === true && reading.autoPct !== null;
  return {
    ok: live,
    loggedOut: cursorRead?.loggedOut === true || reading?.loggedOut === true,
    readAt: validQuotaTime(reading?.readAt, Date.now()),
    readingExpiresAt: monthly?.readingExpiresAt ?? null,
    displayExpiresAt: quotaDisplayExpiry(validQuotaTime(reading?.readAt, Date.now()), monthly?.resetsAt ?? null),
    manualAt: cursorRead?.manualAt ?? monthly?.manualAt ?? null,
    manualUsedPct: live ? null : monthly?.usedPct ?? null,
    resetsAt: monthly?.resetsAt ?? null,
    windows: (reading?.windows ?? []).map((w) => ({
      label: w.label,
      usedPct: w.usedPct,
      onDemandUsd: w.onDemandUsd,
      onDemandLimitUsd: w.onDemandLimitUsd,
      resetsAt: w.resetsAt ?? null,
    })),
    usingManual: !live,
    source: reading?.source === "official" ? "official" : live ? "screen" : null,
    notice: reading?.notice ?? null,
    linkBroken: reading?.linkBroken === true,
    ...(reading?.screenRead === false ? { screenRead: false as const } : {}),
  };
}

function cursorLinkOf(reading: CursorUsageReading | null): NonNullable<BoardUsage["cursorLink"]> {
  const waiting = cursorLinkOverride();
  if (waiting) return waiting;
  if (reading?.linkBroken || reading?.linkState === "broken") return { state: "broken", message: "" };
  if (reading?.awaitingSample) return { state: "authorized", message: t("cursor.monitoring.authorized") };
  if (reading?.linkState === "connected" || reading?.source === "official") return { state: "connected", message: "" };
  return { state: "unlinked", message: msgUnlinked() };
}

export function withCursorLink(board: BoardUsage, companies: BoardUsage["companies"], reading: CursorUsageReading | null): BoardUsage {
  const cursorLink = cursorLinkOf(reading);
  const shown = (companies ?? []).map((card) => (
    card.adapter === CURSOR_API && (cursorLink.state === "waiting" || cursorLink.state === "authorized") ? { ...card, notice: cursorLink.message } : card
  ));
  return { ...board, companies: shown, cursorLink };
}
