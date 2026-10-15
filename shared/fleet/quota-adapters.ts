// Quota source adapters: where a plan's percentages come from, and the pool rules that follow from it.
//
// Every plan in plans.json is one quota pool. Its `adapter` field says how its numbers are read:
//   claude-cli  Claude Code's usage windows (weekly, 5-hour session, the Fable model week), via Paseo
//   codex-cli   Codex's weekly window via Paseo; coupons and credits via `codex app-server`
//   grok-cli    Grok's weekly window via Paseo, the `grok` /usage screen, or a hand copy
//   cursor-api  Cursor's official usage API, the cursor-agent screen, or a hand copy (optional, off by default)
//   antigravity-cli  local `agy /usage` table for display (optional, off by default). The switch only starts
//                    that reader. It does not turn the plan into `manual`. Not the Paseo ACP pool unless both
//                    channels report the same version, tier and quota source. The reader does not.
//   manual      a percent copied by hand from the vendor's dashboard
// Copilot and a direct Gemini provider stay on `manual`: no percent can be read without a login.
// `usageProvider` "gemini" does not select `antigravity-cli`.
// Pi and Oh My Pi spend a Claude or Codex quota and do not get a pool of their own.
// Any other built-in that only fronts those accounts is the same: no separate pool.
// A plan without `adapter` (files written before this field existed) gets the adapter whose provider matches
// its `usageProvider`, else its first `providers` entry; failing that, `manual`.
// Adapter ids are `<Paseo provider id>-<transport>`, so the Paseo provider an adapter reads is part of its id.
// Pool ids are the plan ids from plans.json. Nothing here names a particular user's plan.
// Pure: no node: imports. Shared by the server and the panel.

import { language, type Language, t } from "./i18n";
import type { QuotaCycle } from "./quota-cycle";

export const CLAUDE_CLI = "claude-cli";
export const CODEX_CLI = "codex-cli";
export const GROK_CLI = "grok-cli";
export const CURSOR_API = "cursor-api";
export const MUSE_MSP = "muse-msp";
export const OPENCODE_GO_API = "opencode-go-api";
export const ANTIGRAVITY_CLI = "antigravity-cli";
export const MANUAL = "manual";
export const ADAPTER_IDS = [CLAUDE_CLI, CODEX_CLI, GROK_CLI, CURSOR_API, MUSE_MSP, OPENCODE_GO_API, ANTIGRAVITY_CLI, MANUAL] as const;
/** Display bucket inside one Antigravity plan. Missing: no CLI rows, ACP dispatch stays unknown. */
export const ANTIGRAVITY_BUCKETS = ["gemini", "claude-gpt"] as const;
export type AntigravityBucket = (typeof ANTIGRAVITY_BUCKETS)[number];
/** Primary window. Its percent is the ACP pool, never a CLI row that has not been proven to be that pool. */
export const ANTIGRAVITY_ACP_WINDOW = "acp-dispatch";
export const ANTIGRAVITY_WEEK_WINDOW = "cli-week";
export const ANTIGRAVITY_FIVE_HOUR_WINDOW = "cli-five-hour";
export type AdapterId = (typeof ADAPTER_IDS)[number];

/** Adapter metadata for company labels and opt-in policies; none of these providers is excluded by default. */
export const PROVIDER_COMPANIES: Readonly<Record<string, string>> = {
  claude: "Anthropic", codex: "OpenAI", grok: "xAI", cursor: "Cursor",
  gemini: "Google", google: "Google", antigravity: "Google",
};

/** macOS keychain presence probe. Not a quota source, but optional in the same way. */
export const KEYCHAIN = "keychain";
/** Adapters that stay off unless switched on (server/adapters/config.ts). */
export const OPTIONAL_ADAPTERS = [CURSOR_API, KEYCHAIN, ANTIGRAVITY_CLI] as const;
export type OptionalAdapter = (typeof OPTIONAL_ADAPTERS)[number];
export type AdapterSwitches = Record<OptionalAdapter, boolean>;
export const ADAPTERS_OFF: AdapterSwitches = { [CURSOR_API]: false, [KEYCHAIN]: false, [ANTIGRAVITY_CLI]: false };

type ProviderOf<T extends string> = T extends `${infer P}-${infer Rest}`
  ? Rest extends `${string}-${string}` ? `${P}-${ProviderOf<Rest>}` : P
  : never;

/** The Paseo provider an adapter id names: the part before the last `-`. */
export function providerOf<T extends string>(adapter: T): ProviderOf<T> {
  return adapter.slice(0, adapter.lastIndexOf("-")) as ProviderOf<T>;
}

export const CLAUDE_PROVIDER = providerOf(CLAUDE_CLI);
export const CODEX_PROVIDER = providerOf(CODEX_CLI);
export const GROK_PROVIDER = providerOf(GROK_CLI);
export const CURSOR_PROVIDER = providerOf(CURSOR_API);
export const MUSE_PROVIDER = providerOf(MUSE_MSP);
export const OPENCODE_GO_PROVIDER = providerOf(OPENCODE_GO_API);
/** Paseo providers some adapter reads, in adapter order. */
export const ADAPTER_PROVIDERS = [CLAUDE_PROVIDER, CODEX_PROVIDER, GROK_PROVIDER, CURSOR_PROVIDER, MUSE_PROVIDER, OPENCODE_GO_PROVIDER] as const;

/** How a pool's period is bounded: the window the provider reported, the 7 days before reset, or the calendar month. */
export type PoolPeriod = "window" | "week" | "month";

/** Display names of one pool. Missing entries fall back as each caller documents (usually to the pool id). */
export interface PoolNames {
  /** Home one-liner and hard-stop texts ("Claude", "Fable"). */
  line?: string;
  /** Dispatch matrix and roles page ("Claude main quota"). */
  label?: string;
  /** Priority line and early-reset notice ("GPT"). */
  short?: string;
  /** Role cards: how the work is paid for ("Uses Claude quota"). */
  via?: string;
  /** Coupon surplus notice. */
  surplus?: string;
}

/** Rule for a percent copied by hand: stop at the manual line (MANUAL_STOP in server/pools-windows.ts). */
export interface HandCopy {
  /** Window sources the rule covers. `none` also covers "nothing copied yet". */
  sources: ReadonlyArray<"manual" | "none">;
  /** Reason when the copied percent reached the stop line. */
  stopText: (used: number, stopPct: number, name: string) => string;
  /** Reason when nothing was copied (only when `sources` has `none`). */
  emptyText: string;
  /** Reason once the period is spent (97%), for monthly pools. */
  spentText: (used: number, spentPct: number, name: string) => string;
}

/** A model window that is a pool of its own and spends its parent's main window too. */
interface SubWindowSpec {
  key: string;
  match: RegExp;
  names: PoolNames;
}

interface AdapterSpec {
  /** Off unless switched on. A switched-off plan is read as `manual`, except `antigravity-cli`: that switch only starts the reader. */
  optional: boolean;
  /**
   * Reads the windows Paseo reports for the plan's `usageProvider`. False (manual): only the hand copy decides the
   * percent, whatever the provider reports.
   */
  readsProvider: boolean;
  period: PoolPeriod;
  /** Default for plans.json `neverPrefer`: being behind the progress line does not make the pool preferred. */
  neverPrefer: boolean;
  /**
   * The leader's own pool (the configured quota policy): its week stops at 75% so the leader keeps 25%, new work pauses at
   * 70% of the 5-hour window, and Claude's reset coupons (burn and double weeks) and the reviewer exception apply.
   */
  leaderPool: boolean;
  /** Window label that is the 5-hour session. Null: the adapter has none. */
  session: RegExp | null;
  /** Keep window labels as read. Others call a week-long "Session" window "Weekly". */
  keepsLabels: boolean;
  /** What a refresh without a percent does with the last good one (pools-unread.ts). Null: nothing. */
  unread: "reset" | "stop" | null;
  /** Judged while plans.json `dispatch` is false. When false the pool is only closed, not judged. */
  judgedWhenOff: boolean;
  /** Use the first window when no weekly one is found. */
  firstWindowFallback: boolean;
  subWindows: readonly SubWindowSpec[];
  handCopy: HandCopy | null;
  /** Company card and reset-coupon key (the vendor account). Null: the plan id. */
  companyKey: string | null;
  /** Reset coupons move this pool's weekly reset (server/early-reset.ts). */
  couponShiftsReset: boolean;
  /** Order in pool-status.json (and so the tie-break of the dispatch order). Plans.json order breaks ties. */
  judgeRank: number;
  /** Order of company cards on the quota page. */
  cardRank: number;
  names: PoolNames;
  /** Company card title. Null: the plan name. */
  cardName: string | null;
  /** Name on reset-coupon lines. Null: the plan name. */
  couponName: string | null;
}

/** Shared by the Cursor and SuperGrok hand copies: `<label> 63% (copied by hand from /usage), at the 80% stop line`. */
function handCopyStop(label: string, source: string) {
  return (used: number, stopPct: number) => t("quota.adapters.handCopyStop", { label, used: Math.round(used), source, stop: stopPct });
}

/** Provider weeks dispatch work; other reported windows remain available for display. */
function providerWeekSpec(name: string, rank: number, session: RegExp | null): AdapterSpec {
  return {
    optional: false, readsProvider: true, period: "week", neverPrefer: false, leaderPool: false,
    session, keepsLabels: true, unread: null, judgedWhenOff: true, firstWindowFallback: false,
    subWindows: [], handCopy: null, companyKey: null, couponShiftsReset: false,
    judgeRank: rank, cardRank: rank,
    names: { line: name, label: name, short: name, via: t("quota.adapters.via", { name }), surplus: name },
    cardName: name, couponName: name,
  };
}

/** Built per language: names and texts go through t(), which must not run at module load. */
function buildSpecs(): Record<AdapterId, AdapterSpec> {
  const noHandCopyYet = t("quota.adapters.noHandCopyYet");
  return {
    [CLAUDE_CLI]: {
      optional: false,
      readsProvider: true,
      period: "window",
      neverPrefer: true,
      leaderPool: true,
      session: /session/i,
      keepsLabels: true,
      unread: "reset",
      judgedWhenOff: true,
      firstWindowFallback: false,
      subWindows: [{ key: "fable", match: /fable/i, names: { line: "Fable", label: "Claude Fable", short: "Claude Fable", via: t("quota.adapters.via", { name: "Fable" }) } }],
      handCopy: null,
      companyKey: "claude",
      couponShiftsReset: false,
      judgeRank: 0,
      cardRank: 0,
      names: { line: "Claude", label: t("quota.adapters.mainQuota", { name: "Claude" }), short: "Claude", via: t("quota.adapters.via", { name: "Claude" }), surplus: t("quota.adapters.mainQuota", { name: "Claude" }) },
      cardName: "Claude",
      couponName: "Claude",
    },
    [GROK_CLI]: {
      optional: false,
      readsProvider: true,
      period: "week",
      neverPrefer: false,
      leaderPool: false,
      session: null,
      keepsLabels: false,
      unread: null,
      judgedWhenOff: true,
      firstWindowFallback: true,
      subWindows: [],
      handCopy: {
        sources: ["manual"],
        stopText: handCopyStop(t("quota.adapters.grokWeekUsed"), "/usage show"),
        emptyText: noHandCopyYet,
        spentText: () => t("quota.adapters.weekSpent"),
      },
      companyKey: null,
      couponShiftsReset: false,
      judgeRank: 1,
      cardRank: 2,
      names: { line: "SuperGrok", label: "SuperGrok", short: "SuperGrok", via: t("quota.adapters.via", { name: "SuperGrok" }), surplus: "SuperGrok" },
      cardName: t("quota.adapters.cardAlias", { name: "SuperGrok", alias: "Grok" }),
      couponName: "SuperGrok",
    },
    [CURSOR_API]: {
      optional: true,
      readsProvider: true,
      period: "month",
      neverPrefer: false,
      leaderPool: false,
      session: null,
      keepsLabels: false,
      unread: null,
      judgedWhenOff: true,
      firstWindowFallback: true,
      subWindows: [],
      handCopy: {
        sources: ["manual", "none"],
        stopText: handCopyStop(t("quota.adapters.cursorModelUsed"), "/usage"),
        emptyText: noHandCopyYet,
        spentText: (used, spentPct) => t("quota.adapters.cursorSpent", { used: Math.round(used), stop: spentPct }),
      },
      companyKey: null,
      couponShiftsReset: false,
      judgeRank: 2,
      cardRank: 1,
      names: { line: "Cursor", label: "Cursor", short: "Cursor", via: t("quota.adapters.via", { name: "Cursor" }), surplus: "Cursor" },
      cardName: "Cursor",
      couponName: "Cursor",
    },
    [CODEX_CLI]: {
      optional: false,
      readsProvider: true,
      period: "week",
      neverPrefer: true,
      leaderPool: false,
      session: null,
      keepsLabels: false,
      unread: "stop",
      judgedWhenOff: false,
      firstWindowFallback: true,
      subWindows: [],
      handCopy: null,
      companyKey: "chatgpt",
      couponShiftsReset: true,
      judgeRank: 3,
      cardRank: 3,
      names: { line: "ChatGPT", short: "GPT", surplus: "ChatGPT" },
      cardName: t("quota.adapters.cardAlias", { name: "ChatGPT", alias: "Codex" }),
      couponName: "ChatGPT",
    },
    [MUSE_MSP]: providerWeekSpec(t("quota.adapters.muse"), 4, /^(?:\d+(?:\.\d+)?-(?:hour|minute|day)|Current window)$/i),
    [OPENCODE_GO_API]: providerWeekSpec(t("quota.adapters.opencodeGo"), 5, null),
    [ANTIGRAVITY_CLI]: {
      optional: true,
      readsProvider: false,
      period: "window",
      neverPrefer: true,
      leaderPool: false,
      session: null,
      keepsLabels: true,
      unread: null,
      judgedWhenOff: true,
      firstWindowFallback: false,
      subWindows: [],
      handCopy: null,
      companyKey: null,
      couponShiftsReset: false,
      judgeRank: 6,
      cardRank: 6,
      names: { line: "Antigravity", label: "Antigravity", short: "Antigravity", via: t("quota.adapters.via", { name: "Antigravity" }) },
      cardName: "Antigravity",
      couponName: null,
    },
    [MANUAL]: {
      optional: false,
      readsProvider: false,
      period: "month",
      neverPrefer: false,
      leaderPool: false,
      session: null,
      keepsLabels: false,
      unread: null,
      judgedWhenOff: true,
      firstWindowFallback: true,
      subWindows: [],
      handCopy: {
        sources: ["manual", "none"],
        stopText: (used, stopPct, name) => t("quota.adapters.manualStop", { name, used: Math.round(used), stop: stopPct }),
        emptyText: t("quota.adapters.manualEmpty"),
        spentText: (used, spentPct, name) => t("quota.adapters.manualSpent", { name, used: Math.round(used), stop: spentPct }),
      },
      companyKey: null,
      couponShiftsReset: false,
      judgeRank: 7,
      cardRank: 7,
      names: {},
      cardName: null,
      couponName: null,
    },
  };
}

let built: { lang: Language; specs: Record<AdapterId, AdapterSpec> } | null = null;

/** The adapter specs in the current language (rebuilt only when the language changes). */
function specs(): Record<AdapterId, AdapterSpec> {
  const lang = language();
  if (!built || built.lang !== lang) built = { lang, specs: buildSpecs() };
  return built.specs;
}

export function isAdapterId(value: unknown): value is AdapterId {
  return typeof value === "string" && (ADAPTER_IDS as readonly string[]).includes(value);
}

export function adapterSpec(id: AdapterId): AdapterSpec {
  return specs()[id];
}

/** The fields of a plans.json plan (or a board plan) that decide its adapter and pools. */
export interface PlanSource {
  id: string;
  name?: string;
  adapter?: unknown;
  /** Display-only state on assembled plans; independent of dispatch eligibility. */
  cursorMonitoring?: boolean;
  usageProvider?: string;
  providers?: readonly string[];
  cycleDay?: number;
  quotaCycle?: QuotaCycle;
  neverPrefer?: unknown;
}

/** `usageProvider` then `providers`, as written; anything that is not a non-empty string is skipped. */
function providersOf(plan: PlanSource): string[] {
  const listed: unknown[] = Array.isArray(plan.providers) ? plan.providers : [];
  return [plan.usageProvider, ...listed].filter((p): p is string => typeof p === "string" && p.length > 0);
}

/** The adapter a plan names, or the one inferred from its providers. Ignores the optional-adapter switches. */
export function baseAdapterOf(plan: PlanSource): AdapterId {
  if (isAdapterId(plan.adapter)) return plan.adapter;
  for (const provider of providersOf(plan)) {
    const hit = ADAPTER_IDS.find((id) => id !== MANUAL && providerOf(id) === provider);
    if (hit) return hit;
  }
  return MANUAL;
}

/**
 * The adapter in force. With switches, a plan on a switched-off optional adapter is read by hand (`manual`).
 * `antigravity-cli` is the exception: off or unset only skips `agy`. The plan stays on that adapter so a hand
 * copy cannot replace the unknown ACP hold. Without switches (pure callers, tests) the plan's own adapter is used.
 */
export function adapterOf(plan: PlanSource, switches?: Partial<AdapterSwitches>): AdapterId {
  const base = baseAdapterOf(plan);
  if (base === ANTIGRAVITY_CLI) return base;
  if (switches && specs()[base].optional && switches[base as OptionalAdapter] !== true) return MANUAL;
  return base;
}

/** Company card and coupon key: the vendor account for Claude and ChatGPT, otherwise the plan id. */
export function companyKeyOf(plan: PlanSource): string {
  return specs()[baseAdapterOf(plan)].companyKey ?? plan.id;
}

/** One pool of pool-status.json. Serializable, so the panel can receive it. */
export interface PoolEntry {
  id: string;
  planId: string;
  adapter: AdapterId;
  /** Sub-window key for a model window that is a pool of its own; null for the plan's main pool. */
  sub: string | null;
  /** The main pool a sub pool also spends. Null for a main pool. */
  parent: string | null;
  period: PoolPeriod;
  neverPrefer: boolean;
  names: PoolNames;
}

function periodOf(adapter: AdapterId, plan: PlanSource): PoolPeriod {
  if (plan.quotaCycle) return "window";
  if (adapter === MANUAL && !plan.cycleDay) return "week";
  return specs()[adapter].period;
}

/** Sub pool id: `<provider>-<key>` (the Claude Fable week of a plan reading `claude` is `claude-fable`). */
export function subPoolId(plan: PlanSource, adapter: AdapterId, key: string): string {
  const own = typeof plan.usageProvider === "string" ? plan.usageProvider : "";
  const provider = own || (adapter === MANUAL ? plan.id : providerOf(adapter));
  return `${provider}-${key}`;
}

function entriesOf(plan: PlanSource, adapter: AdapterId): PoolEntry[] {
  const spec = specs()[adapter];
  const neverPrefer = typeof plan.neverPrefer === "boolean" ? plan.neverPrefer : spec.neverPrefer;
  const period = periodOf(adapter, plan);
  const main: PoolEntry = { id: plan.id, planId: plan.id, adapter, sub: null, parent: null, period, neverPrefer, names: spec.names };
  const subs = spec.subWindows.map((sub): PoolEntry => ({
    id: subPoolId(plan, adapter, sub.key),
    planId: plan.id,
    adapter,
    sub: sub.key,
    parent: plan.id,
    period,
    neverPrefer,
    names: sub.names,
  }));
  return [main, ...subs];
}

/**
 * Every pool the plans define, in pool-status.json order: by adapter rank, then plans.json order;
 * a plan's sub pools right after its main pool.
 */
export function poolCatalog(plans: readonly PlanSource[], switches?: Partial<AdapterSwitches>): PoolEntry[] {
  const ranked = plans
    .map((plan, index) => ({ plan, index, adapter: adapterOf(plan, switches) }))
    .sort((a, b) => specs()[a.adapter].judgeRank - specs()[b.adapter].judgeRank || a.index - b.index);
  return ranked.flatMap(({ plan, adapter }) => entriesOf(plan, adapter));
}

export function poolEntry(catalog: readonly PoolEntry[], id: string | null | undefined): PoolEntry | undefined {
  return id ? catalog.find((entry) => entry.id === id) : undefined;
}

/** Main pools only, in catalog order. */
export function mainPools(catalog: readonly PoolEntry[]): PoolEntry[] {
  return catalog.filter((entry) => entry.parent === null);
}

/** The first main pool read by this adapter. */
export function poolOfAdapter(catalog: readonly PoolEntry[], adapter: AdapterId): PoolEntry | undefined {
  return catalog.find((entry) => entry.adapter === adapter && entry.parent === null);
}

/** Pool ids of every main pool read by this adapter. */
export function poolIdsOf(catalog: readonly PoolEntry[], adapter: AdapterId): string[] {
  return catalog.filter((entry) => entry.adapter === adapter && entry.parent === null).map((entry) => entry.id);
}

/** The leader's pool (see AdapterSpec.leaderPool), if the plans have one. */
export function leaderPool(catalog: readonly PoolEntry[]): PoolEntry | undefined {
  return catalog.find((entry) => entry.parent === null && specs()[entry.adapter].leaderPool);
}

export function isLeaderPool(entry: PoolEntry): boolean {
  return entry.parent === null && specs()[entry.adapter].leaderPool;
}

/** What an unread refresh does for this pool. Sub pools never carry a reading. */
export function unreadPolicy(entry: PoolEntry): "reset" | "stop" | null {
  return entry.parent === null ? specs()[entry.adapter].unread : null;
}

/** The hand-copy rule of this pool's adapter. Sub pools have none. */
export function handCopyOf(entry: PoolEntry): HandCopy | null {
  return entry.parent === null ? specs()[entry.adapter].handCopy : null;
}

/** Sub-window key of a window label under this adapter, or null for the main windows. */
export function subWindowOf(adapter: AdapterId, label: string): string | null {
  return specs()[adapter].subWindows.find((sub) => sub.match.test(label))?.key ?? null;
}

/** The pool a plan window feeds: its sub pool for a model window, otherwise the plan's main pool. */
export function poolOfWindow(plan: PlanSource, adapter: AdapterId, label: string): string {
  const sub = subWindowOf(adapter, label);
  return sub ? subPoolId(plan, adapter, sub) : plan.id;
}

/** Stable provider and cycle identity; labels are only a compatibility fallback for old snapshots. */
export interface QuotaWindowIdentity {
  label: string;
  id?: string;
  cycleKind?: QuotaCycle["kind"];
  primary?: boolean;
}

function identifiedCycle(window: QuotaWindowIdentity): QuotaCycle["kind"] | undefined {
  if (window.cycleKind !== undefined) return window.cycleKind;
  if (window.id === "seven_day" || window.id === "weekly") return "week";
  if (window.id === "one_month" || window.id === "monthly") return "month";
  if (window.id === "one_day" || window.id === "daily") return "day";
  if (window.id === "five_hour" || (window.id && /^\d+(?:\.\d+)?s$/.test(window.id))) return "duration";
  return undefined;
}

/** Stable period identity wins; old snapshots without identity retain their original label lookup. */
export function isMonthlyWindow(window: QuotaWindowIdentity): boolean {
  const kind = identifiedCycle(window);
  return kind !== undefined ? kind === "month" : window.label === "Monthly";
}

export function isWeeklyWindow(window: QuotaWindowIdentity): boolean {
  const kind = identifiedCycle(window);
  return kind !== undefined ? kind === "week" : /week/i.test(window.label);
}

/** Main weekly window by stable identity, excluding model windows; most adapters fall back to the first row. */
export function mainWindowOf<W extends QuotaWindowIdentity>(adapter: AdapterId, windows: readonly W[]): W | undefined {
  const weekly = windows.find((w) => isWeeklyWindow(w) && subWindowOf(adapter, w.label) === null);
  return weekly ?? (specs()[adapter].firstWindowFallback ? windows[0] : undefined);
}

/** The window of a sub pool. */
export function subWindowFor<W extends { label: string }>(adapter: AdapterId, key: string, windows: readonly W[]): W | undefined {
  const spec = specs()[adapter].subWindows.find((sub) => sub.key === key);
  return spec ? windows.find((w) => spec.match.test(w.label)) : undefined;
}

/** The session window, when the adapter has one. */
export function sessionWindowOf<W extends QuotaWindowIdentity>(adapter: AdapterId, windows: readonly W[]): W | undefined {
  const session = specs()[adapter].session;
  return session ? windows.find((w) => w.id === "five_hour") ?? windows.find((w) => {
    const kind = identifiedCycle(w);
    return (kind === undefined || kind === "duration") && session.test(w.label);
  }) : undefined;
}

/**
 * Pools that can stand in for each other: every other main pool. A pace hold softens only when all of them that
 * are in the snapshot are already stopped. Sub pools spend their parent and are nobody's sibling.
 */
export function paceSiblings(catalog: readonly PoolEntry[]): Record<string, string[]> {
  const mains = mainPools(catalog).map((entry) => entry.id);
  return Object.fromEntries(mains.map((id) => [id, mains.filter((other) => other !== id)]));
}

/** A display name of a pool, or `fallback` when this context has none. */
export function poolName(catalog: readonly PoolEntry[], id: string, kind: keyof PoolNames, fallback: string = id): string {
  return poolEntry(catalog, id)?.names[kind] ?? fallback;
}

/** Name lookup for one context, for code that only has pool ids. */
export function poolNames(catalog: readonly PoolEntry[], kind: keyof PoolNames): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of catalog) {
    const name = entry.names[kind];
    if (name) out[entry.id] = name;
  }
  return out;
}

/** Pools whose reset coupons can move the weekly reset, with their coupon key. */
export function resetShiftingCoupons(plans: readonly PlanSource[], switches?: Partial<AdapterSwitches>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const plan of plans) if (specs()[adapterOf(plan, switches)].couponShiftsReset) out[plan.id] = companyKeyOf(plan);
  return out;
}

/** One vendor account: a company card and its reset-coupon line. */
export interface CompanyEntry {
  key: string;
  planId: string;
  adapter: AdapterId;
  /** Retains Cursor identity when its reader falls back to manual. */
  cursorMonitoring?: boolean;
  /** Company card title. */
  cardName: string;
  /** Name on reset-coupon lines. */
  couponName: string;
  /** Paseo providers whose usage payload belongs to this account. */
  providers: string[];
  /** Sub-window key → its pool id (Claude: `fable` → the Fable week's pool). */
  subPools: Record<string, string>;
}

/** One entry per plan, in plans.json order (the order of the coupon lines). */
export function companyCatalog(plans: readonly PlanSource[], switches?: Partial<AdapterSwitches>): CompanyEntry[] {
  return plans.map((plan) => {
    const adapter = adapterOf(plan, switches);
    const spec = specs()[adapter];
    const name = typeof plan.name === "string" && plan.name ? plan.name : plan.id;
    const providers = providersOf(plan);
    const subPools = Object.fromEntries(spec.subWindows.map((sub) => [sub.key, subPoolId(plan, adapter, sub.key)]));
    const cursorMonitoring = plan.cursorMonitoring ?? (baseAdapterOf(plan) === CURSOR_API ? adapter === CURSOR_API : undefined);
    return { ...(cursorMonitoring !== undefined ? { cursorMonitoring } : {}), key: companyKeyOf(plan), planId: plan.id, adapter, cardName: spec.cardName ?? name, couponName: spec.couponName ?? name, providers: [...new Set(providers)], subPools };
  });
}

/** Company cards order on the quota page. */
export function cardOrder(companies: readonly CompanyEntry[]): CompanyEntry[] {
  return companies
    .map((company, index) => ({ company, index }))
    .sort((a, b) => specs()[a.company.adapter].cardRank - specs()[b.company.adapter].cardRank || a.index - b.index)
    .map(({ company }) => company);
}
