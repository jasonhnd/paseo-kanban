import { PACE_TARGET_PCT } from "./dispatch";
import { type MessageKey, t } from "./i18n";
import { cursorScreenOffNotice } from "./quota-companies";
import { CURSOR_API, GROK_CLI, isMonthlyWindow, type PlanSource, poolCatalog, poolEntry } from "./quota-adapters";
import { remainingRounded, remainingText, stopRemainText, untilResetRemainText } from "./quota-line";
import type { BoardUsage, UsagePlan, UsageWindow } from "./usage";
import { validQuotaTime } from "./quota-time";

export function quotaWindowReadText(window: UsageWindow, now = Date.now()): string {
  const at = validQuotaTime(window.source === "manual" ? window.manualAt : window.sampledAt, now);
  const when = at ? fmtWhen(at) : "";
  const label = t(window.source === "manual" ? "quota.companies.source.manual" : window.source === "official" ? "quota.companies.source.official"
    : window.source === "screen" ? "quota.companies.source.screen" : "quota.companies.source.auto");
  const origin = window.sourceTimeKind === "batch" && when && window.source !== "manual" ? t("quota.companies.source.batchAt", { when })
    : when ? t("quota.companies.source.at", { label, when }) : t("quota.companies.source.unknownTime", { label });
  const call = window.source === "provider" ? validQuotaTime(window.collectedAt, now) : null;
  return call ? `${origin} · ${t("quota.companies.source.calledAt", { when: fmtWhen(call) })}` : origin;
}

export type PoolView = NonNullable<BoardUsage["pools"]>[string];

export function fmtUsd(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  if (n >= 1000) return `$${Math.round(n).toLocaleString("en-US")}`;
  if (n >= 10) return `$${n.toFixed(0)}`;
  return `$${n.toFixed(2)}`;
}

export function fmtWhen(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (x: number) => String(x).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const WINDOW_LABEL: Record<string, MessageKey> = {
  Session: "quota.plans.window.session",
  Weekly: "quota.plans.window.weekly",
  "Weekly · Fable": "quota.plans.window.fableWeekly",
  Monthly: "quota.plans.window.monthly",
  Rolling: "quota.plans.window.rolling",
  "Current window": "quota.plans.window.current",
};

export function windowLabel(label: string): string {
  const key = Object.hasOwn(WINDOW_LABEL, label) ? WINDOW_LABEL[label] : undefined;
  if (key) return t(key);
  const duration = /^(\d+(?:\.\d+)?)-(hour|minute|day)$/i.exec(label);
  if (!duration) return label;
  const unitKeys: Record<string, MessageKey> = {
    hour: "quota.plans.window.hours", minute: "quota.plans.window.minutes", day: "quota.plans.window.days",
  };
  return t(unitKeys[duration[2].toLowerCase()], { count: duration[1] });
}

export function hoursBeforeReset(runsOutAt: string, resetsAt: string | null): number | null {
  if (!resetsAt) return null;
  return Math.round((Date.parse(resetsAt) - Date.parse(runsOutAt)) / 3_600_000);
}

export function verdictText(w: UsageWindow): { text: string; tone: "red" | "yellow" | "green" | "muted" } {
  if (w.verdict === "short" && w.runsOutAt) return shortVerdict(w.runsOutAt, w.resetsAt);
  if (w.verdict === "short") return { text: t("quota.plans.verdict.short"), tone: "red" };
  if (w.verdict === "waste" && w.projectedPct !== null) return { text: untilResetRemainText(w.projectedPct), tone: "yellow" };
  if (w.verdict === "on-track") return { text: t("quota.plans.verdict.onTrack"), tone: "green" };
  if (w.source === "none" && w.usedPct === null) return { text: t("quota.plans.verdict.noPercent"), tone: "muted" };
  return { text: t("quota.plans.verdict.tooEarly"), tone: "muted" };
}

function shortVerdict(runsOutAt: string, resetsAt: string | null): { text: string; tone: "red" } {
  const hours = hoursBeforeReset(runsOutAt, resetsAt);
  const early = hours ? t("quota.plans.verdict.earlyBy", { hours }) : "";
  return { text: t("quota.plans.verdict.runsOutAt", { when: fmtWhen(runsOutAt), early }), tone: "red" };
}

/** Pool key of pool-status.json a window feeds: its `pool` (a sub pool such as Claude's Fable week), else the plan id. */
export function poolKey(planId: string, window: Pick<UsageWindow, "pool">): string {
  return window.pool ?? planId;
}

/** True for the first window of a plan that feeds this window's pool (the pool line is drawn once). */
export function isFirstPoolWindow(windows: ReadonlyArray<Pick<UsageWindow, "pool">>, planId: string, index: number): boolean {
  const key = poolKey(planId, windows[index] ?? {});
  return windows.findIndex((item) => poolKey(planId, item) === key) === index;
}

export function poolLineKind(pool: Pick<PoolView, "dispatchable" | "deprioritize" | "prefer"> | undefined): { label: string; tone: "red" | "yellow" | "green" } | null {
  if (!pool) return null;
  if (!pool.dispatchable) return { label: t("quota.plans.pool.paused"), tone: "red" };
  if (pool.deprioritize) return { label: t("quota.plans.pool.deprioritize"), tone: "yellow" };
  if (pool.prefer) return { label: t("quota.plans.pool.prefer"), tone: "green" };
  return null;
}

export function paceTone(pool: Pick<PoolView, "dispatchable" | "prefer" | "paceState">): "green" | "yellow" | "red" | "neutral" {
  if (!pool.dispatchable && pool.paceState === "ahead") return "yellow";
  if (pool.prefer || pool.paceState === "behind") return "green";
  if (!pool.dispatchable) return "red";
  return "neutral";
}

export function planNote(plan: Pick<UsagePlan, "dispatch" | "note">): { tone: "yellow" | "muted"; text: string } | null {
  if (!plan.dispatch) return { tone: "yellow", text: plan.note || t("quota.plans.notDispatched") };
  if (plan.note) return { tone: "muted", text: plan.note };
  return null;
}

export function windowUsageLine(w: Pick<UsageWindow, "usedPct" | "elapsedPct" | "resetsAt">): string {
  const used = w.usedPct !== null ? remainingText(w.usedPct) : t("quota.plans.usageUnknown");
  const elapsed = w.elapsedPct !== null ? t("quota.plans.elapsed", { pct: Math.round(w.elapsedPct) }) : "";
  const reset = w.resetsAt ? t("quota.plans.resetsAt", { when: fmtWhen(w.resetsAt) }) : "";
  return `${used}${elapsed}${reset}`;
}

export function cursorOverCap(plan: Pick<UsagePlan, "adapter">, usedPct: number | null): boolean {
  return plan.adapter === CURSOR_API && usedPct !== null && usedPct >= 100;
}

export function windowValueLine(w: Pick<UsageWindow, "apiUsd" | "planUsd" | "fullWindowUsd">): string {
  const plan = w.planUsd ? t("quota.plans.value.planShare", { usd: fmtUsd(w.planUsd) }) : "";
  const full = w.fullWindowUsd !== null ? t("quota.plans.value.full", { usd: fmtUsd(w.fullWindowUsd) }) : "";
  return t("quota.plans.value.line", { usd: fmtUsd(w.apiUsd), plan, full });
}

/** The hand-copy box: monthly windows, and the grok-cli week (its `/usage show` percent can be copied by hand). */
export function showManualEditor(window: Pick<UsageWindow, "label" | "cycleKind">, plan: Pick<UsagePlan, "adapter">): boolean {
  return isMonthlyWindow(window) || plan.adapter === GROK_CLI;
}

export function roiLine(plan: Pick<UsagePlan, "api30dUsd" | "roi30d">): string {
  const roi = plan.roi30d !== null ? t("quota.plans.roi.ratio", { ratio: plan.roi30d.toFixed(1) }) : "";
  return t("quota.plans.roi.line", { usd: fmtUsd(plan.api30dUsd), roi });
}

export function claudeProjected(projectedPct: number | null): string {
  if (projectedPct === null) return t("quota.plans.notEnoughData");
  if (remainingRounded(projectedPct) <= 0) return t("quota.plans.claude.runsOut");
  return t("quota.plans.claude.leftAtReset", { remaining: remainingText(projectedPct) });
}

export function claudePaceSentence(projectedPct: number | null, dailyCapPct: number | null): string {
  const daily = dailyCapPct === null ? t("quota.plans.notEnoughData") : `${dailyCapPct.toFixed(1)}%`;
  return t("quota.plans.claude.paceSentence", { projected: claudeProjected(projectedPct), target: remainingText(PACE_TARGET_PCT), daily });
}

export function claudePeriodTitle(resetsAt: string | null): string {
  return resetsAt ? t("quota.plans.claude.periodResets", { when: fmtWhen(resetsAt) }) : t("quota.plans.claude.period");
}

/** Plan name of a pool; a sub pool (Claude's Fable week) by its own label. */
export function paceName(plans: readonly (PlanSource & { name: string })[], key: string): string {
  const entry = poolEntry(poolCatalog(plans), key);
  if (entry?.parent) return entry.names.label ?? key;
  return plans.find((plan) => plan.id === key)?.name ?? key;
}

export function paceDaysLine(pool: { daysLeft?: number | null; periodDays?: number | null }): string {
  if (pool.daysLeft == null || pool.periodDays == null) return "—";
  return t("quota.plans.pace.days", { days: Math.round(pool.periodDays), left: pool.daysLeft.toFixed(1) });
}

export function paceDailyLine(pool: { dailyPct?: number | null; perRunPct?: number | null; dailyRuns?: number | null }): string {
  const daily = pool.dailyPct != null ? `${pool.dailyPct.toFixed(1)}%` : "—";
  const per = pool.perRunPct != null ? `${pool.perRunPct.toFixed(2)}%` : t("quota.plans.pace.notEstimated");
  const runs = pool.dailyRuns != null ? t("quota.plans.pace.runs", { runs: pool.dailyRuns.toFixed(1) }) : "—";
  return t("quota.plans.pace.daily", { daily, per, runs });
}

export function cursorFailKind(read: { screenRead?: boolean; error: string | null; loggedOut?: boolean; linkBroken?: boolean }): "screen-off" | "manual" {
  if (read.screenRead === false && !read.error && !read.loggedOut && !read.linkBroken) return "screen-off";
  return "manual";
}

export function cursorScreenOffText(manualAt: string | null): string {
  const notice = cursorScreenOffNotice();
  return manualAt ? t("quota.plans.cursor.withWhen", { text: notice, when: fmtWhen(manualAt) }) : notice;
}

export function cursorManualFailText(manualAt: string | null, error: string | null): string {
  const when = manualAt ? t("quota.plans.cursor.copiedAt", { when: fmtWhen(manualAt) }) : "";
  const why = error ? t("quota.plans.cursor.why", { error }) : "";
  return t("quota.plans.cursor.manualFail", { when, why });
}

export function cursorVia(via: string | undefined): string {
  return t(via === "official" ? "quota.companies.source.official" : "quota.companies.source.screen");
}

export function cursorDemand(read: { onDemandUsd: number | null; onDemandLimitUsd: number | null }): string {
  if (read.onDemandUsd == null || read.onDemandLimitUsd == null) return "—";
  return `$${read.onDemandUsd.toFixed(2)} / $${read.onDemandLimitUsd.toFixed(2)}`;
}

export function cursorConnectLabel(busy: boolean, state: string): string {
  if (busy) return t("quota.plans.cursor.opening");
  if (state === "waiting") return t("quota.plans.cursor.reopenAuth");
  return t("quota.plans.cursor.connect");
}

export function showCursorConnect(state: string): boolean {
  return state !== "connected";
}

export function showCursorDisconnect(state: string): boolean {
  return state === "connected" || state === "broken";
}

export function priceButtonLabel(price: number | null): string {
  if (price === null) return t("quota.plans.price.fill");
  if (price === 0) return t("quota.plans.price.included");
  return t("quota.plans.price.monthly", { price });
}

export function parseMonthlyPrice(value: string): { ok: true; price: number | null } | { ok: false; error: string } {
  const n = value.trim() === "" ? null : Number(value);
  if (n !== null && (!Number.isFinite(n) || n < 0)) return { ok: false, error: t("quota.plans.price.enterNumber") };
  return { ok: true, price: n };
}

export function parseManualPct(value: string): number | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 100) return null;
  return n;
}

export function manualPreview(value: string): string {
  const typed = Number(value);
  if (value.trim() === "" || !Number.isFinite(typed)) return "";
  return t("quota.plans.manual.preview", { remaining: remainingText(typed) });
}

export function manualContext(plan: Pick<UsagePlan, "adapter" | "cursorRead">, w: Pick<UsageWindow, "manualAt">): string {
  if (w.manualAt) return t("quota.plans.manual.copiedAt", { when: fmtWhen(w.manualAt) });
  if (plan.adapter === GROK_CLI) return t("quota.plans.manual.grok", { stop: stopRemainText(80) });
  if (plan.adapter === CURSOR_API && plan.cursorRead?.screenRead === false) return t("quota.plans.manual.cursorScreenOff");
  if (plan.adapter === CURSOR_API) return t("quota.plans.manual.cursor");
  return t("quota.plans.manual.noApi");
}

export function priceDraft(price: number | null): string {
  return price !== null ? String(price) : "";
}
