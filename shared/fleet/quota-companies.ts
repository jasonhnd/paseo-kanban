import { z } from "zod";
import { t, tAll } from "./i18n";
import { ANTIGRAVITY_CLI, ANTIGRAVITY_FIVE_HOUR_WINDOW, ANTIGRAVITY_WEEK_WINDOW, CLAUDE_CLI, CODEX_CLI, type CompanyEntry, CURSOR_API, cardOrder, GROK_CLI, isWeeklyWindow, MUSE_MSP, OPENCODE_GO_API, MANUAL, sessionWindowOf, type QuotaWindowIdentity } from "./quota-adapters";
import { reasonSaysNoDispatch, reasonWaitsForWindow } from "./quota-reason";
import { quotaDisplayExpiry, quotaRowStale, validQuotaTime, type SourceTimeKind } from "./quota-time";

const CLAUDE_STOP_PCT = 75;
const OTHER_STOP_PCT = 97;
const TOKYO_OFFSET_MS = 9 * 60 * 60 * 1000;

/**
 * Which stop line a window draws: the leader pool's 75%, a hand-copy rule's manual line while the percent is
 * hand-copied, or 97%. Same rule as server/pools-hard.ts; kept here so this file does not import the dispatch graph.
 */
type StopRule = "leader" | "hand-copy" | "plain";

function stopPctFor(rule: StopRule, usingManual: boolean, manualStopPct: number): number {
  if (rule === "leader") return CLAUDE_STOP_PCT;
  if (rule === "hand-copy" && usingManual) return manualStopPct;
  return OTHER_STOP_PCT;
}

function tokyoClock(iso: string): string {
  const local = new Date(Date.parse(iso) + TOKYO_OFFSET_MS);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${local.getUTCMonth() + 1}/${local.getUTCDate()} ${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`;
}

/** One quota window under a company, as the cockpit shows it. */
export const companyWindowSchema = z.object({
  id: z.string(),
  name: z.string(),
  usedPct: z.number().nullable(),
  remainingPct: z.number().nullable(),
  resetsAt: z.string().nullable(),
  source: z.enum(["provider", "manual", "screen", "official", "none", "unread"]),
  readAt: z.string().nullable(),
  sourceTimeKind: z.enum(["source", "batch", "unknown"]).optional(),
  collectedAt: z.string().nullable().optional(),
  displayExpiresAt: z.string().nullable().optional(),
  sourceText: z.string(),
  who: z.string(),
  dispatchText: z.string(),
  pacePct: z.number().nullable(),
  stopPct: z.number().nullable(),
  /** Home draws the progress line and the stop line only on windows that dispatch work. */
  showPace: z.boolean(),
  tone: z.enum(["green", "yellow", "red", "muted"]),
  /** Set for rows that are dollars rather than a percent (Cursor on-demand). */
  amountText: z.string().nullable(),
  readingState: z.enum(["live", "stale", "unknown"]).optional(),
  readingExpiresAt: z.string().nullable().optional(),
});

export const companyCardSchema = z.object({
  /** Company key (shared/quota-adapters.ts companyKeyOf): the vendor account, or the plan id. */
  id: z.string(),
  /** Quota source adapter of the plan behind this card. Omitted on caches written before adapters. */
  adapter: z.string().optional(),
  /** Display-only reader state; false still identifies a Cursor card with a manual source. */
  cursorMonitoring: z.boolean().optional(),
  name: z.string(),
  remainingPct: z.number().nullable(),
  headline: z.string(),
  /** True when the numbers on this card are a previous hand copy, not a live read. */
  stale: z.boolean(),
  /** Extra line on the card, such as a dropped Cursor login. Null when there is nothing to add. */
  notice: z.string().nullable(),
  /** True when `notice` is an explanation, not a warning. Omitted means the yellow warning style. */
  noticeMuted: z.boolean().optional(),
  windows: z.array(companyWindowSchema),
  /** Reset-coupon line under the company. Omitted on caches written before coupons were tracked. */
  couponLine: z.string().optional(),
  /** Double-week plan, only for a coupon that does not move the weekly reset. */
  couponPlan: z.string().nullable().optional(),
  /** ChatGPT credits line. Omitted on caches written before that layer existed. */
  creditsLine: z.string().optional(),
});

export type CompanyWindow = z.infer<typeof companyWindowSchema>;
export type CompanyCard = z.infer<typeof companyCardSchema>;

export interface QuotaProfile {
  name: string;
  pool?: string | null;
  model?: string | null;
  role?: string | null;
}

export interface CompanyPool {
  dispatchable: boolean;
  prefer?: boolean;
  paceState?: string | null;
  reason?: string | null;
  pacePct?: number | null;
}

/** A provider window already copied onto a plan. Each keeps its own resetsAt. */
export interface CompanyProviderWindow extends QuotaWindowIdentity {
  planId: string;
  label: string;
  usedPct: number | null;
  resetsAt: string | null;
  source: "provider" | "manual" | "screen" | "none";
  readAt: string | null;
  sourceTimeKind?: SourceTimeKind;
  collectedAt?: string | null;
  displayExpiresAt?: string | null;
  readError?: string | null;
  providerStatus?: "available" | "unavailable" | "error";
  readingState?: "live" | "manual" | "stale" | "unknown";
  readingExpiresAt?: string | null;
}

export interface CompanyCursorWindow {
  label: string;
  usedPct: number | null;
  onDemandUsd: number | null;
  onDemandLimitUsd: number | null;
  resetsAt?: string | null;
}

export interface CompanyCursorRead {
  ok: boolean;
  loggedOut: boolean;
  readAt: string | null;
  readingExpiresAt?: string | null;
  displayExpiresAt?: string | null;
  manualAt: string | null;
  manualUsedPct: number | null;
  /** Billing-cycle end for the Auto block. Not guessed from a bare "Resets Oct 12". */
  resetsAt: string | null;
  windows: CompanyCursorWindow[];
  usingManual: boolean;
  /** official when the file was written from Cursor's API. */
  source?: "official" | "screen" | null;
  notice?: string | null;
  linkBroken?: boolean;
  /** False when plans.json turned off the cursor-agent screen. Missing means on. */
  screenRead?: boolean;
}

export function cursorLoggedOut(read: { ok?: unknown; loggedOut?: unknown; error?: unknown } | null | undefined): boolean {
  if (!read || read.ok === true) return false;
  if (read.loggedOut === true) return true;
  if (typeof read.error !== "string") return false;
  const error = read.error.toLowerCase();
  return /not logged in|press any key to log in/.test(error)
    || tAll("quota.companies.loginScreenMarker").some((marker) => error.includes(marker.toLowerCase()));
}

/** Shown when plans.json turns off the cursor-agent screen. Not an error. */
export function cursorScreenOffNotice(): string {
  return t("quota.companies.cursorScreenOff");
}

/** True when `text` is the screen-off notice in any language (stored readings may predate a language switch). */
export function isCursorScreenOffNotice(text: string): boolean {
  return tAll("quota.companies.cursorScreenOff").includes(text);
}

/** Yellow line on the home page when AFC's own Cursor login can no longer refresh. */
export function cursorReconnectAlarmText(): string {
  return t("quota.companies.cursorReconnect");
}

/** Yellow line on the home page when the Cursor CLI has dropped its login. */
export function cursorLoginAlarmText(when: string): string {
  return t("quota.companies.cursorLoginAlarm", { when });
}

export function resetPhrase(resetsAt: string | null, now: number): string {
  if (!resetsAt) return "";
  const end = Date.parse(resetsAt);
  if (Number.isNaN(end)) return "";
  const when = { clock: tokyoClock(resetsAt) };
  const ms = end - now;
  if (ms <= 0) return t("quota.companies.resetDue", { clock: when.clock });
  const totalHours = Math.floor(ms / 3_600_000);
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  const rel = days > 0
    ? t("quota.companies.inDaysHours", { days, hours })
    : totalHours > 0 ? t("quota.companies.inHours", { hours: totalHours }) : t("quota.companies.inUnderHour");
  return t("quota.companies.resetAt", { rel, clock: when.clock });
}

function remainingOf(used: number | null): number | null {
  if (used === null || !Number.isFinite(used)) return null;
  return Math.max(0, Math.min(100, 100 - used));
}

function clock(iso: string | null): string {
  if (!iso || Number.isNaN(Date.parse(iso))) return "";
  return tokyoClock(iso);
}

function sourceText(kind: "auto" | "manual" | "stale" | "unread" | "official" | "screen" | "off", at: string | null, timeKind?: SourceTimeKind): string {
  if (kind === "off") return t("quota.companies.source.screenOff");
  if (kind === "unread") return t("quota.companies.source.unread");
  const when = clock(at);
  if (kind === "stale") return when ? t("quota.companies.source.staleAt", { when }) : t("quota.companies.source.stale");
  if (timeKind === "batch" && when) return t("quota.companies.source.batchAt", { when });
  const label = t(kind === "manual" ? "quota.companies.source.manual"
    : kind === "official" ? "quota.companies.source.official"
      : kind === "screen" ? "quota.companies.source.screen" : "quota.companies.source.auto");
  return when ? t("quota.companies.source.at", { label, when }) : t("quota.companies.source.unknownTime", { label });
}

function modelWord(model: string | null | undefined): string {
  const m = (model ?? "").toLowerCase();
  if (m.includes("fable")) return "Fable";
  if (m.includes("opus")) return "Opus";
  if (m.includes("sonnet")) return "Sonnet";
  if (m.includes("haiku")) return "Haiku";
  if (m.includes("grok")) return "Grok 4.7";
  if (m.includes("gpt")) return m.includes("6.1") ? "GPT-6.1 Sol" : "GPT-6";
  return (model ?? "").trim();
}

function people(profiles: QuotaProfile[], pool: string, direct = false): string[] {
  return profiles.filter((p) => p.pool === pool).map((p) => {
    const word = modelWord(p.model);
    const shown = direct && word ? t("quota.companies.direct", { model: word }) : word;
    const name = p.role === "supervisor" ? "<leader>" : p.name;
    return shown ? t("quota.companies.personModel", { name, model: shown }) : name;
  });
}

/** A mid-sentence phrase shown on its own as a badge starts with a capital letter. */
function badgeText(phrase: string): string {
  return phrase.charAt(0).toUpperCase() + phrase.slice(1);
}

function dispatchText(pool: CompanyPool | undefined, mode: "pool" | "off" | "unverified"): string {
  if (mode === "unverified") return t("quota.companies.unverified");
  if (mode === "off") return t("quota.companies.noDispatch");
  const reason = pool?.reason ?? "";
  if (!pool || pool.paceState === "closed" || reasonSaysNoDispatch(reason)) return t("quota.companies.noDispatch");
  if (!pool.dispatchable) {
    const found = /(\d{1,2}\/\d{1,2}\s+\d{1,2}:\d{2})/.exec(reason)?.[1];
    if (found) return badgeText(t("quota.line.pausedUntil", { clock: found }));
    if (reasonWaitsForWindow(reason)) return badgeText(t("quota.line.pausedUntilWindow"));
    return t("quota.companies.paused");
  }
  return t("quota.companies.dispatchable");
}

function toneOf(pool: CompanyPool | undefined, stale: boolean, unread: boolean, mode: "pool" | "off" | "unverified"): CompanyWindow["tone"] {
  if (unread || mode === "unverified") return "muted";
  if (stale) return "yellow";
  if (mode === "off") return "muted";
  if (!pool || pool.dispatchable === false || pool.paceState === "closed") return "red";
  if (pool.paceState === "ahead") return "yellow";
  return "green";
}

function headline(remainingPct: number | null, stale: boolean): string {
  const n = companyRemainingText(remainingPct);
  return stale ? t("quota.companies.staleHeadline", { remaining: n }) : n;
}

/** The card's big figure: "40% left" from a remaining percent (not a used one). */
export function companyRemainingText(remainingPct: number | null): string {
  return remainingPct === null ? t("quota.line.remainingUnknown") : t("quota.line.remaining", { pct: Math.round(remainingPct) });
}

function windowBase(input: {
  id: string;
  name: string;
  usedPct: number | null;
  resetsAt: string | null;
  source: CompanyWindow["source"];
  readAt: string | null;
  sourceKind: "auto" | "manual" | "stale" | "unread" | "official" | "screen" | "off";
  who: string;
  pool: CompanyPool | undefined;
  mode: "pool" | "off" | "unverified";
  showPace: boolean;
  stopRule?: StopRule;
  usingManual?: boolean;
  manualStopPct?: number;
  /** Claude's main week during an unused double week. */
  stopPctOverride?: number;
  amountText?: string | null;
  /** Replaces the generic source sentence. Used to label the agy table and the unproven ACP row. */
  sourceTextOverride?: string;
  sample?: Pick<CompanyProviderWindow, "sourceTimeKind" | "collectedAt" | "readingState" | "readingExpiresAt" | "displayExpiresAt" | "providerStatus" | "readError">;
}): CompanyWindow {
  const unread = input.sourceKind === "unread" || input.sourceKind === "off";
  const stale = input.sourceKind === "stale";
  const calledAt = (input.source === "provider" || input.sample?.providerStatus) && input.sample?.collectedAt ? clock(input.sample.collectedAt) : "";
  const origin = input.sourceTextOverride ?? sourceText(input.sourceKind, input.readAt, input.sample?.sourceTimeKind);
  const status = input.sample?.providerStatus;
  const error = input.sample?.readError;
  const report = status && (unread || error) ? t("quota.companies.source.providerStatus", { status }) : "";
  // Specialized displays already provide their own error/source sentence.
  const problem = !input.sourceTextOverride && error && error !== status ? t("quota.companies.source.readError", { error }) : "";
  const empty = unread && status === "available" && !error ? t("quota.companies.source.availableEmpty") : "";
  return {
    id: input.id,
    name: input.name,
    usedPct: input.usedPct,
    remainingPct: remainingOf(input.usedPct),
    resetsAt: input.resetsAt,
    source: input.source,
    readAt: input.readAt,
    sourceText: [origin, report, problem, empty, calledAt ? t("quota.companies.source.calledAt", { when: calledAt }) : ""].filter(Boolean).join(" · "),
    sourceTimeKind: input.sample?.sourceTimeKind ?? (input.readAt ? "source" : "unknown"),
    collectedAt: input.sample?.collectedAt ?? null,
    displayExpiresAt: input.sample?.displayExpiresAt ?? quotaDisplayExpiry(input.readAt, input.resetsAt),
    readingExpiresAt: input.sample?.readingExpiresAt ?? null,
    readingState: stale || input.sample?.readingState === "stale" ? "stale" : unread || !input.readAt ? "unknown" : "live",
    who: input.who,
    dispatchText: dispatchText(input.pool, input.mode),
    pacePct: input.showPace ? input.pool?.pacePct ?? null : null,
    stopPct: input.showPace && input.stopRule ? (input.stopPctOverride ?? stopPctFor(input.stopRule, input.usingManual === true, input.manualStopPct ?? 80)) : null,
    showPace: input.showPace,
    tone: toneOf(input.pool, stale, unread, input.mode),
    amountText: input.amountText ?? null,
  };
}

function findWindow(rows: CompanyProviderWindow[], planId: string, test: (label: string) => boolean): CompanyProviderWindow | undefined {
  return rows.find((w) => w.planId === planId && test(w.label));
}

/** claude-cli: the weekly total, the 5-hour session, and the Fable week (a pool of its own). */
function claudeWindows(company: CompanyEntry, rows: CompanyProviderWindow[], pools: Record<string, CompanyPool>, profiles: QuotaProfile[], claudeStopPct?: number): CompanyWindow[] {
  const planId = company.planId;
  const fablePool = company.subPools.fable ?? null;
  const weekly = rows.find((w) => w.planId === planId && isWeeklyWindow(w) && !/fable/i.test(w.label));
  const sessionWords = tAll("quota.companies.fiveHourLabel").map((word) => word.toLowerCase().replace(/\s+/g, ""));
  const session = sessionWindowOf(CLAUDE_CLI, rows.filter(w => w.planId === planId))
    ?? rows.find(w => w.planId === planId && !w.id && (/five.hour/i.test(w.label) || sessionWords.some(word => w.label.toLowerCase().replace(/\s+/g, "").includes(word))));
  const fable = findWindow(rows, planId, (l) => /fable/i.test(l));
  const ownChats = t("quota.companies.ownChats");
  const weekPeople = [...people(profiles, planId), ownChats].join(t("quota.companies.listSep"));
  const fablePeople = [
    ...people(profiles, planId).length
      ? profiles.filter((p) => p.pool === planId && (p.model ?? "").toLowerCase().includes("fable")).map((p) => t("quota.companies.personModel", { name: p.name, model: modelWord(p.model) }))
      : [],
    ...(fablePool ? people(profiles, fablePool) : []),
  ];
  const fableWho = t("quota.companies.fableWho", {
    who: fablePeople.length > 0 ? fablePeople.join(t("quota.companies.listSep")) : t("quota.companies.fableDefaultWho"),
  });
  const live = (row: CompanyProviderWindow | undefined, id: string, name: string, who: string, poolKey: string | null, showPace: boolean) => {
    if (!row || row.usedPct === null) {
      const report = row ?? rows.find(w => w.planId === planId && (w.providerStatus || w.readError));
      return windowBase({
        id, name, usedPct: null, resetsAt: row?.resetsAt ?? null, source: "unread", readAt: null, sourceKind: "unread", sample: report,
        who, pool: poolKey ? pools[poolKey] : undefined, mode: poolKey ? "pool" : "off", showPace: false,
      });
    }
    return windowBase({
      id, name, usedPct: row.usedPct, resetsAt: row.resetsAt, source: row.source === "none" ? "provider" : row.source, sample: row,
      readAt: row.readAt, sourceKind: row.source === "manual" ? "manual" : row.readError ? "stale" : "auto", who, pool: poolKey ? pools[poolKey] : undefined,
      mode: "pool", showPace, stopRule: poolKey === null ? undefined : poolKey === planId ? "leader" : "plain",
      stopPctOverride: poolKey === planId ? claudeStopPct : undefined,
    });
  };
  return [
    live(weekly, `${company.key}-week`, t("quota.companies.weekTotal"), weekPeople || ownChats, planId, true),
    live(session, `${company.key}-session`, t("quota.companies.fiveHourWindow"), t("quota.companies.sameAsWeek"), planId, false),
    live(fable, `${company.key}-fable`, t("quota.companies.fableSub"), fableWho, fablePool, true),
  ];
}

function dollars(n: number): string {
  return Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`;
}

/** cursor-api: Cursor's own models (Auto), other models (API), on-demand spend, and any extra block Cursor lists. */
function cursorWindows(company: CompanyEntry, read: CompanyCursorRead | null, pools: Record<string, CompanyPool>, profiles: QuotaProfile[], manualStopPct: number): CompanyWindow[] {
  const key = company.key;
  const screenOff = read?.screenRead === false && read.ok !== true;
  const stale = !read?.ok && !screenOff;
  const via = !stale && !screenOff && read?.source === "official" ? "official" : "screen";
  const quiet = screenOff ? "off" as const : "unread" as const;
  const autoWho = people(profiles, company.planId).join(t("quota.companies.listSep")) || t("quota.companies.cursorDefaultWho");
  const cycleEnd = read?.resetsAt ?? null;
  const byLabel = new Map((read?.windows ?? []).map((w) => [w.label.trim().toLowerCase(), w]));
  const whenOf = (row: CompanyCursorWindow | undefined, ownOnly: boolean) => row?.resetsAt || (ownOnly ? null : cycleEnd);
  const autoLive = byLabel.get("auto");
  const autoUsed = read?.ok && autoLive?.usedPct != null ? autoLive.usedPct : read?.manualUsedPct ?? null;
  const auto = windowBase({
    sample: read ? { readingExpiresAt: read.readingExpiresAt, displayExpiresAt: read.displayExpiresAt } : undefined,
    id: `${key}-auto`,
    name: t("quota.companies.cursorAuto"),
    usedPct: autoUsed,
    resetsAt: whenOf(autoLive, false),
    source: screenOff || stale ? (autoUsed === null ? "unread" : "manual") : via,
    readAt: screenOff || stale ? read?.manualAt ?? null : read?.readAt ?? null,
    sourceKind: screenOff ? "manual" : stale ? (autoUsed === null ? "unread" : "stale") : via,
    who: autoWho,
    pool: pools[company.planId],
    mode: "pool",
    showPace: autoUsed !== null,
    stopRule: "hand-copy",
    usingManual: stale || screenOff,
    manualStopPct,
  });
  const apiLive = byLabel.get("api");
  const nobody = t("quota.companies.nobody");
  const apiName = t("quota.companies.cursorApi");
  const demandName = t("quota.companies.onDemand");
  const unverified = t("quota.companies.unverified");
  const api = read?.ok && apiLive
    ? windowBase({
      id: `${key}-api`, name: apiName, usedPct: apiLive.usedPct, resetsAt: whenOf(apiLive, false),
      source: via, readAt: read.readAt, sourceKind: via, who: nobody, sample: { displayExpiresAt: read.displayExpiresAt },
      pool: undefined, mode: "off", showPace: false,
    })
    : windowBase({
      id: `${key}-api`, name: apiName, usedPct: null, resetsAt: null, source: "unread",
      readAt: null, sourceKind: quiet, who: nobody, pool: undefined, mode: "off", showPace: false,
    });
  const demand = [...byLabel.values()].find((w) => /on-?demand/i.test(w.label));
  const amount = demand && demand.onDemandUsd !== null
    ? `${dollars(demand.onDemandUsd)}${demand.onDemandLimitUsd !== null ? ` / ${dollars(demand.onDemandLimitUsd)}` : ""}`
    : null;
  const onDemand = read?.ok && demand
    ? windowBase({
      id: `${key}-ondemand`, name: demandName, usedPct: demand.usedPct, resetsAt: whenOf(demand, false),
      source: via, readAt: read.readAt, sourceKind: via, who: nobody, sample: { displayExpiresAt: read.displayExpiresAt },
      pool: undefined, mode: "off", showPace: false, amountText: amount,
    })
    : windowBase({
      id: `${key}-ondemand`, name: demandName, usedPct: null, resetsAt: null, source: "unread",
      readAt: null, sourceKind: quiet, who: nobody, pool: undefined, mode: "off", showPace: false,
    });
  const known = /^(included|auto|api|on-demand|on demand)$/i;
  const extras: CompanyWindow[] = [];
  if (read?.ok) {
    for (const row of read.windows) {
      if (known.test(row.label.trim())) continue;
      const grok = /grok/i.test(row.label);
      extras.push(windowBase({
        id: `${key}-${row.label.trim().toLowerCase().replace(/\s+/g, "-")}`,
        name: grok ? t("cursor.api.sandboxLabel") : row.label.trim(),
        usedPct: row.usedPct,
        resetsAt: grok ? (row.resetsAt ?? null) : whenOf(row, false),
        source: via,
        sample: { displayExpiresAt: read.displayExpiresAt },
        readAt: read.readAt,
        sourceKind: via,
        who: unverified,
        pool: undefined,
        mode: "unverified",
        showPace: false,
      }));
    }
  }
  // Look at the block names only, not the `${key}-` prefix (a plan id may itself contain "grok").
  const hasGrok = extras.some((w) => w.id.slice(key.length + 1).includes("grok")) || [...byLabel.keys()].some((k) => k.includes("grok"));
  const sandboxAgents = hasGrok ? null : windowBase({
    id: `${key}-grok-bot`,
    name: t("cursor.api.sandboxLabel"),
    usedPct: null,
    resetsAt: null,
    source: "unread",
    readAt: null,
    sourceKind: quiet,
    who: unverified,
    pool: undefined,
    mode: "unverified",
    showPace: false,
  });
  return [auto, api, onDemand, ...extras, ...(sandboxAgents ? [sandboxAgents] : [])];
}

function oneWindow(
  rows: CompanyProviderWindow[],
  planId: string,
  id: string,
  name: string,
  who: string,
  pool: CompanyPool | undefined,
  mode: "pool" | "off",
  showPace: boolean,
  stopRule?: StopRule,
  stopPctOverride?: number,
): CompanyWindow {
  const row = rows.find((w) => w.planId === planId && isWeeklyWindow(w)) ?? rows.find((w) => w.planId === planId);
  if (!row || row.usedPct === null) {
    return windowBase({
      id, name, usedPct: null, resetsAt: row?.resetsAt ?? null, source: "unread", readAt: null,
      sourceKind: "unread", who, pool, mode, showPace: false, sample: row,
    });
  }
  const sourceKind = row.source === "manual" ? "manual" : row.readError ? "stale" : row.source === "screen" ? "screen" : "auto";
  return windowBase({
    id, name, usedPct: row.usedPct, resetsAt: row.resetsAt, source: row.source === "none" ? "provider" : row.source, sample: row,
    readAt: row.readAt, sourceKind, who, pool, mode, showPace, stopRule,
    usingManual: row.source === "manual",
    stopPctOverride,
  });
}

export interface BuildCompaniesInput {
  now?: number;
  /** One per plan (shared/quota-adapters.ts companyCatalog); each becomes a card built by its adapter. */
  companies: CompanyEntry[];
  windows: CompanyProviderWindow[];
  pools: Record<string, CompanyPool>;
  profiles: QuotaProfile[];
  cursor: CompanyCursorRead | null;
  manualStopPct?: number;
  claudeStopPct?: number;
  /** Coupon lines by company key. */
  coupons?: Partial<Record<string, { line: string; plan: string | null }>>;
  /** ChatGPT credits sentence. Omitted when plans.json has no credits window. */
  creditsLine?: string | null;
  /** Yellow line when SuperGrok's live percent has been missing for over an hour. */
  supergrokNotice?: string | null;
  /** Source sentence for the SuperGrok card, e.g. "CLI 13% (22:12) · Paseo 12%". Null keeps the default. */
  supergrokSource?: string | null;
  /** plans.json stopPct by pool id. Only pools that set one are listed. */
  stopPctByPool?: Record<string, number>;
}

function claudeCard(company: CompanyEntry, input: BuildCompaniesInput): CompanyCard {
  const rows = claudeWindows(company, input.windows, input.pools, input.profiles, input.claudeStopPct);
  const week = rows.find((w) => w.id === `${company.key}-week`);
  return {
    id: company.key,
    adapter: company.adapter,
    name: company.cardName,
    remainingPct: week?.remainingPct ?? null,
    headline: headline(week?.remainingPct ?? null, false),
    stale: false,
    notice: null,
    windows: rows,
    couponLine: input.coupons?.[company.key]?.line,
    couponPlan: input.coupons?.[company.key]?.plan ?? null,
  };
}

function cursorCard(company: CompanyEntry, input: BuildCompaniesInput): CompanyCard {
  const manualStopPct = input.manualStopPct ?? 80;
  const rows = cursorWindows(company, input.cursor, input.pools, input.profiles, manualStopPct);
  const screenOff = input.cursor?.screenRead === false && input.cursor.ok !== true && input.cursor.linkBroken !== true;
  const stale = input.cursor?.ok !== true && !screenOff;
  const included = input.cursor?.windows.find((w) => /^included$/i.test(w.label.trim()));
  const auto = rows.find((w) => w.id === `${company.key}-auto`);
  const remaining = input.cursor?.ok && included?.usedPct != null ? remainingOf(included.usedPct) : auto?.remainingPct ?? null;
  return {
    id: company.key,
    adapter: company.adapter,
    name: company.cardName,
    remainingPct: remaining,
    headline: headline(remaining, stale),
    stale,
    notice: input.cursor?.linkBroken
      ? (input.cursor.notice || t("quota.companies.linkBroken"))
      : screenOff
        ? (input.cursor?.notice || cursorScreenOffNotice())
        : (input.cursor?.notice ?? null),
    ...(screenOff ? { noticeMuted: true } : {}),
    windows: rows,
    couponLine: input.coupons?.[company.key]?.line,
    couponPlan: null,
  };
}

/** grok-cli, and any plan read by hand: one weekly (or monthly) window. */
function singleWindowCard(company: CompanyEntry, input: BuildCompaniesInput): CompanyCard {
  const grok = company.adapter === GROK_CLI;
  const fallbackWho = grok ? t("quota.companies.grokDefaultWho") : "";
  const row = oneWindow(
    input.windows,
    company.planId,
    `${company.key}-week`,
    grok ? t("quota.companies.weekQuota") : company.cardName,
    people(input.profiles, company.planId, grok).join(t("quota.companies.listSep")) || fallbackWho,
    input.pools[company.planId],
    "pool",
    true,
    "hand-copy",
    input.stopPctByPool?.[company.planId],
  );
  const shown = grok && input.supergrokSource ? { ...row, sourceText: input.supergrokSource } : row;
  return {
    id: company.key,
    adapter: company.adapter,
    name: company.cardName,
    remainingPct: row.remainingPct,
    headline: headline(row.remainingPct, false),
    stale: false,
    notice: grok ? input.supergrokNotice ?? null : null,
    windows: [shown],
    couponLine: input.coupons?.[company.key]?.line,
    couponPlan: null,
  };
}

function codexCard(company: CompanyEntry, input: BuildCompaniesInput): CompanyCard {
  const codexPool = input.pools[company.planId];
  const codexReason = codexPool?.reason ?? "";
  const codexOff = !codexPool || codexPool.paceState === "closed" || reasonSaysNoDispatch(codexReason);
  const chatPeople = people(input.profiles, company.planId);
  const sep = t("quota.companies.listSep");
  const ownChats = t("quota.companies.ownChats");
  const chatWho = codexOff ? t("quota.companies.userReserved") : chatPeople.length > 0 ? [...chatPeople, ownChats].join(sep) : ownChats;
  const chat = oneWindow(
    input.windows,
    company.planId,
    `${company.key}-week`,
    t("quota.companies.weekQuota"),
    chatWho,
    codexPool,
    codexOff ? "off" : "pool",
    !codexOff,
    codexOff ? undefined : "plain",
    input.stopPctByPool?.[company.planId],
  );
  return {
    id: company.key,
    adapter: company.adapter,
    name: company.cardName,
    remainingPct: chat.remainingPct,
    headline: headline(chat.remainingPct, false),
    stale: false,
    notice: null,
    windows: [chat],
    couponLine: input.coupons?.[company.key]?.line,
    couponPlan: input.coupons?.[company.key]?.plan ?? null,
    ...(input.creditsLine ? { creditsLine: input.creditsLine } : {}),
  };
}

function antigravityCard(company: CompanyEntry, input: BuildCompaniesInput): CompanyCard {
  const rows = input.windows.filter((row) => row.planId === company.planId);
  const windows = (["gemini", "claude-gpt"] as const).flatMap((bucket) => (["five-hour", "week"] as const).map((window) => {
    const id = `${bucket}-${window === "week" ? ANTIGRAVITY_WEEK_WINDOW : ANTIGRAVITY_FIVE_HOUR_WINDOW}`;
    const row = rows.find((candidate) => candidate.id === id);
    const stale = row?.readingState === "stale";
    const known = row?.usedPct != null && row.readingState !== "unknown";
    const when = clock(row?.readAt ?? null);
    return {
      ...windowBase({
        id: `${company.key}-${id}`,
        name: t(bucket === "gemini" ? window === "week" ? "quota.antigravity.geminiWeek" : "quota.antigravity.geminiFiveHour"
          : window === "week" ? "quota.antigravity.claudeWeek" : "quota.antigravity.claudeFiveHour"),
        usedPct: known ? row.usedPct : null, resetsAt: known ? row.resetsAt : null,
        source: known ? "screen" : "unread", readAt: known ? row.readAt : null, sample: row,
        sourceKind: stale ? "stale" : known ? "screen" : "unread",
        sourceTextOverride: stale ? t("quota.antigravity.cliStale", { when: when || row?.readAt || "" })
          : known ? t("quota.antigravity.sampledAt", { when: when || row.readAt || "" })
          : row?.readError || t("quota.antigravity.displayUnknown"),
        who: "", pool: undefined, mode: "off", showPace: false,
      }),
      readingState: stale ? "stale" as const : known ? "live" as const : "unknown" as const,
      readingExpiresAt: row?.readingExpiresAt ?? null,
      dispatchText: t("quota.antigravity.displayPaused"),
    };
  }));
  return {
    id: company.key, adapter: company.adapter, name: "Antigravity",
    remainingPct: null, headline: t("quota.antigravity.displayPaused"),
    stale: windows.some((row) => row.readingState === "stale"),
    notice: t("quota.antigravity.displayPaused"), noticeMuted: true, windows,
  };
}

const CARD_BUILDERS: Record<string, (company: CompanyEntry, input: BuildCompaniesInput) => CompanyCard> = {
  [CLAUDE_CLI]: claudeCard,
  [CURSOR_API]: cursorCard,
  [ANTIGRAVITY_CLI]: antigravityCard,
  [GROK_CLI]: singleWindowCard,
  [CODEX_CLI]: codexCard,
  [MUSE_MSP]: singleWindowCard,
  [OPENCODE_GO_API]: singleWindowCard,
  [MANUAL]: singleWindowCard,
};

/**
 * Group the quotas the cockpit already read by company: one card per plan, built by its adapter, in the quota
 * page's card order. Each window keeps the resetsAt it came with.
 * Does not decide dispatch; `pools` is the snapshot `pools.ts` already wrote.
 */
export function buildCompanies(input: BuildCompaniesInput): CompanyCard[] {
  // Every Antigravity plan reads the same two CLI buckets. Keep protected pools separate, but show the table once.
  const first = input.companies.find(company => company.adapter === ANTIGRAVITY_CLI);
  return cardOrder(input.companies).filter(company => company.adapter !== ANTIGRAVITY_CLI || company === first)
    .map((company) => {
      const card = (CARD_BUILDERS[company.adapter] ?? singleWindowCard)(company, input);
      return company.cursorMonitoring === undefined ? card : {
        ...card, cursorMonitoring: company.cursorMonitoring,
        ...(company.cursorMonitoring === false ? { notice: t("cursor.monitoring.off"), noticeMuted: false } : {}),
      };
    })
    .map(card => input.now === undefined ? card : refreshCompanyTime(card, input.now));
}

/** File caches and newly assembled cards both use the current clock, never the board header's freshness. */
export function refreshCompanyTime(card: CompanyCard, now: number, generatedAt?: string | null): CompanyCard {
  const cacheOld = generatedAt !== undefined && (validQuotaTime(generatedAt, now) === null
    || quotaRowStale({ readAt: generatedAt, resetsAt: null }, now));
  const windows = card.windows.map(row => {
    const stale = row.usedPct !== null && (cacheOld || quotaRowStale(row, now, generatedAt));
    const readAt = validQuotaTime(row.readAt, now);
    const badTime = row.readAt !== null && readAt === null;
    const sourceTimeKind: SourceTimeKind = badTime ? "unknown" : row.sourceTimeKind ?? (readAt ? "source" : "unknown");
    const baseSource = badTime ? sourceText(row.source === "manual" ? "manual" : row.source === "official" ? "official" : row.source === "screen" ? "screen" : "auto", null) : row.sourceText;
    return { ...row, readAt, sourceTimeKind,
      ...(stale ? { readingState: "stale" as const, tone: "yellow" as const,
        sourceText: tAll("quota.companies.source.stale").some(label => baseSource.includes(label)) ? baseSource : `${baseSource} · ${t("quota.companies.source.stale")}` }
        : badTime ? { readingState: "unknown" as const, sourceText: baseSource } : {}),
    };
  });
  return { ...card, windows, stale: card.stale || windows.some(row => row.readingState === "stale") };
}
