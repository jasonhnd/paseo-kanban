/// <reference types="node" />
import { providerBanned } from "../../shared/fleet/provider-policy";
// "Am I using what I pay for?" — token usage per plan and model, valued at API list prices,
// set against each plan's price and quota windows.
import type { PaseoApi } from "./paseo-api";
import { join } from "node:path";
import { activeDispatchPriority, type DispatchPriority, poolStatusPriority, resolveDispatchPriority } from "../../shared/fleet/dispatch-priority";
import {
  type AdapterSwitches,
  adapterOf,
  baseAdapterOf,
  ANTIGRAVITY_CLI,
  CLAUDE_CLI,
  CODEX_CLI,
  CURSOR_API,
  companyCatalog,
  GROK_CLI,
  type PoolEntry,
  poolCatalog,
  poolNames,
  poolOfWindow,
  adapterSpec,
  isWeeklyWindow,
} from "../../shared/fleet/quota-adapters";
import { buildCompanies, type QuotaProfile } from "../../shared/fleet/quota-companies";
import type { BoardUsage, Period, Tokens, UsagePlan, UsageWindow } from "../../shared/fleet/usage";
import { capturePolicyDigest } from "../application/policy-snapshot";
import { publishDispatch } from "./dispatch";
import { deliverEarlyResetNotices, readEarlyResetLines } from "./early-reset";
import { ledgerBuckets } from "./ledger";
import { captureCursorUsage, readCursorUsageFile, type CursorUsageReading } from "./cursor-usage";
import { antigravityDisplayWindows, antigravityUsageRequested, readAntigravityUsage, unavailableAntigravityReading, type AntigravityReading } from "./quota/antigravity-usage";
import { settleSuperGrokChoice, type SuperGrokChoice } from "./grok-usage";
import { configuredStopPct, type CursorReadMeta, MANUAL_STOP, oneMonthBefore, poolStatus, type PoolStatus, type SuperGrokReadMeta, writePoolStatus } from "./pools";
import { textHidden } from "../../shared/fleet/hidden-plans";
import { adapterSwitches, readHiddenPlans, readBannedProviders } from "./adapters/config";
import { judgeAt, knownQuotaFailure, planBalance, type PlanBalance, windowsFor } from "./adapters/windows";
import { type CouponBoardView, codexCreditsCardText, readCodexCreditsForDispatch, refreshCouponRound } from "./reset-coupons";
import { cursorLivePct, cursorMeta, cursorReadForPlan, companyCursor, companyWindows, dispatchView, poolView, withCursorLink } from "./usage-view";
import { type Price, priceFor, pricesFetchedAt } from "./prices";
import { type AgentRecord, type Profile, readAgentRecords, readPoolProfiles, readRoleProfiles } from "./records";
import { type Bucket, type Buckets, ensureScan, latestScan, scanInFlight } from "./scan";
import { type Json, readJson, STATE_DIR, writeJson } from "./util";
import { t } from "../../shared/fleet/i18n";
import type { ManualReading, QuotaCycle } from "../../shared/fleet/quota-cycle";
import { readSettings, writeSettings } from "./settings";
import { providerUsageStatus, quotaErrorText, readProviderQuota } from "./provider-usage";

export const PLANS = join(STATE_DIR, "plans.json");
/** Display cache for the home page. Not read by Kanban. */
export const QUOTA_COMPANIES = join(STATE_DIR, "quota-companies.json");
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const RESCAN_MS = 5 * 60_000;

/**
 * One plan of plans.json: one quota pool, keyed by `id` (the `pool` of agent profiles).
 * See examples/plans.example.json and shared/quota-adapters.ts for `adapter`.
 */
interface PlanConfig {
  id: string;
  name: string;
  /**
   * Where the quota percent comes from: claude-cli, codex-cli, grok-cli, cursor-api, antigravity-cli or manual.
   * Missing: inferred from `usageProvider` / `providers` (shared/quota-adapters.ts baseAdapterOf).
   */
  adapter?: string;
  /** Never preferred even when behind the progress line. Missing: the adapter's default (Claude and Codex never). */
  neverPrefer?: boolean;
  priceUsdMonthly: number | null;
  /** Paseo usage provider id whose quota windows describe this plan. */
  usageProvider?: string;
  /** Providers whose tokens count against this plan. */
  providers: string[];
  /** Whether dispatched work may rely on this plan. */
  dispatch: boolean;
  /**
   * When false, being ahead of the progress line does not pause this plan.
   * Omitted means true. Hard stops (97%, Claude 75% / 5-hour 70%, hand-copied 80%, dispatch:false) still apply.
   */
  pacePause?: boolean;
  /** Optional dispatch role allowlist. Independent of pacing and quota protection. */
  onlyRoles?: string[];
  /**
   * Optional hard stop, as a percent already used. Missing keeps that pool's existing line
   * (Claude's 75% reserve and 5-hour 70% pause, a hand-copied 80%, otherwise 97%).
   */
  stopPct?: number;
  note?: string;
  coverage: string;
  /** Other plans that come bundled with this one: their usage counts toward this plan's value for money. */
  includes?: string[];
  /** Monthly plans without an API: billing day and a percentage copied from the vendor's dashboard. */
  cycleDay?: number;
  manual?: { usedPct: number; at: string } | null;
  quotaCycle?: QuotaCycle;
  manualOverride?: ManualReading | null;
  quotaProtection?: "pause" | "none";
  /** Display bucket for antigravity-cli. Does not make the agy table the ACP pool. */
  antigravityBucket?: "gemini" | "claude-gpt";
  /**
   * grok-cli only. Missing means on. False skips the grok `/usage show` screen.
   * A live Paseo window still wins either way.
   */
  cliRead?: boolean;
  /** Whether pay-per-use is on (cursor-api). Display only; dispatch follows `manual` (server/pools.ts MANUAL_STOP). */
  overageBilling?: boolean;
}

interface PlansFile { plans: PlanConfig[]; prices?: Record<string, Json>; invalid?: boolean }

/**
 * plans.json, or no plans when it is missing, unreadable or empty. Nothing is written here: a fresh data directory
 * starts from examples/plans.example.json (copied by hand for now), never from built-in plans.
 */
async function readPlans(): Promise<PlansFile> {
  const file = await readJson<PlansFile | null>(PLANS, null);
  if (Array.isArray(file?.plans)) return file;
  return { plans: [], invalid: true };
}

/**
 * Plans the cockpit can judge: an `id`, a `name` (else the id) and `providers` as a list of strings.
 * A malformed entry is skipped here only; plans.json itself is left as it is.
 */
function usablePlans(raw: readonly unknown[]): PlanConfig[] {
  const out: PlanConfig[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const plan = row as Partial<PlanConfig>;
    if (typeof plan.id !== "string" || !plan.id) continue;
    const providers = Array.isArray(plan.providers) ? plan.providers.filter((p): p is string => typeof p === "string") : [];
    out.push({ ...(plan as PlanConfig), name: typeof plan.name === "string" ? plan.name : plan.id, providers, priceUsdMonthly: plan.priceUsdMonthly ?? null, dispatch: plan.dispatch === true, coverage: plan.coverage ?? "" });
  }
  return out;
}

/** No plan to judge. Writing a snapshot without pools would let Kanban treat every pool as open, so none is written. */
const NO_PLANS = "plans.json is unreadable or malformed; the previous quota snapshot is retained.";

export async function updatePlan(input: { id: string; priceUsdMonthly?: number | null; manualUsedPct?: number | null }): Promise<{ ok: boolean; message: string }> {
  const file = await readPlans();
  const plan = file.plans.find((p) => p.id === input.id);
  if (!plan) return { ok: false, message: t("usage.plan.notFound", { id: input.id }) };
  if (plan.quotaCycle || plan.manualOverride !== undefined || plan.quotaProtection) {
    const snapshot = await readSettings("plans");
    const row = (snapshot.document.plans as PlanConfig[]).find(p => p.id === input.id);
    if (!row) return { ok: false, message: t("usage.plan.notFound", { id: input.id }) };
    if (input.priceUsdMonthly !== undefined) row.priceUsdMonthly = input.priceUsdMonthly;
    if (input.manualUsedPct !== undefined) row.manualOverride = input.manualUsedPct === null ? null : { ...row.manualOverride, usedPct: input.manualUsedPct, at: new Date().toISOString() };
    const result = await writeSettings({ file: "plans", revision: snapshot.revision, document: snapshot.document });
    return { ok: result.status === "saved", message: t(result.status === "saved" ? "usage.plan.saved" : "settings.conflict") };
  }
  if (input.priceUsdMonthly !== undefined) plan.priceUsdMonthly = input.priceUsdMonthly;
  if (input.manualUsedPct !== undefined) plan.manual = input.manualUsedPct === null ? null : { usedPct: input.manualUsedPct, at: new Date().toISOString() };
  await writeJson(PLANS, file);
  return { ok: true, message: t("usage.plan.saved") };
}

// ---------- token rows ----------

interface Row { hour: number; provider: string; model: string; long: boolean; v: Bucket; sessionId: string }

async function allRows(): Promise<{ rows: Row[]; scannedAt: string | null; estimated: Set<string> }> {
  const scan = latestScan();
  const rows: Row[] = [];
  const push = (b: Buckets, sessionId: string) => {
    for (const [key, v] of Object.entries(b)) {
      const [hour, provider, model, long] = key.split("|");
      rows.push({ hour: Date.parse(`${hour}:00:00.000Z`), provider, model, long: long === "1", v, sessionId });
    }
  };
  for (const f of scan?.files ?? []) push(f.b, f.sessionId);
  const estimated = new Set<string>();
  for (const f of await ledgerBuckets()) {
    push(f.b, f.sessionId);
    for (const m of f.estimated) estimated.add(m);
  }
  return { rows, scannedAt: scan?.at ?? null, estimated };
}

function valueOf(v: Bucket, long: boolean, p: Price | null): number | null {
  if (!p) return null;
  const r = long && p.long ? p.long : p;
  // A one-hour cache write costs twice the input price at Anthropic; the catalog's cache_write is the 5-minute rate.
  return (v[0] * r.input + v[1] * r.cacheRead + v[2] * r.cacheWrite + v[3] * r.input * 2 + v[4] * r.output) / 1e6;
}

const emptyTokens = (): Tokens => ({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0, calls: 0 });
function addTokens(t: Tokens, v: Bucket): void {
  t.input += v[0];
  t.cacheRead += v[1];
  t.cacheWrite += v[2] + v[3];
  t.output += v[4];
  t.calls += v[5];
}

// ---------- quota windows (server/adapters/windows.ts) ----------

interface ProviderUsage {
  windows: Map<string, Json[]>;
  balances: Map<string, Json[]>;
  /** Why listUsage could not be read; null when it was. */
  error: string | null;
  collectedAt: string | null;
}

async function providerUsage(paseo: PaseoApi): Promise<ProviderUsage> {
  try {
    const sample = await readProviderQuota(paseo);
    const res = sample.value;
    const providers = (res?.providers ?? []) as Json[];
    const batchError = quotaErrorText(sample.error);
    return {
      windows: new Map(providers.map((p) => {
        const status = providerUsageStatus(p.status);
        const error = batchError ?? quotaErrorText(p.error) ?? (status && status !== "available" ? status : null);
        // An empty report carries metadata, not an invented weekly reading or reset.
        const windows = (p.windows?.length ? p.windows : [{ label: t("screen.window.quotaHidden"), usedPct: null }]) as Json[];
        return [String(p.providerId), windows.map((w: Json) => ({
          ...w,
          // A conflicting current report supplies no trusted percent. RPC failures retain old samples instead.
          ...(error && !sample.error ? { usedPct: null, remainingPct: null } : {}),
          collectedAt: sample.collectedAt,
          fetchedAt: w.fetchedAt ?? p.fetchedAt ?? null,
          // The legacy host fetchedAt is a batch minimum, not a per-account timestamp.
          batchFetchedAt: res?.fetchedAt ?? null,
          providerStatus: status,
          readError: error,
        }))];
      })),
      balances: new Map(providers.map((p) => [String(p.providerId), (p.balances ?? []) as Json[]])),
      error: batchError,
      collectedAt: sample.collectedAt,
    };
  } catch (e) {
    return { windows: new Map(), balances: new Map(), error: quotaErrorText(e), collectedAt: null };
  }
}

export { oneMonthBefore, cursorLivePct, planBalance };
export type { PlanBalance };

// ---------- assembly ----------

const PERIOD_MS: Record<Period, number | null> = { today: null, "7d": 7 * DAY, "30d": 30 * DAY };

function periodStart(period: Period): number {
  const ms = PERIOD_MS[period];
  if (ms !== null) return Date.now() - ms;
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

interface Assembled {
  board: BoardUsage;
  /** Pools of all allowed plans, including hidden quota cards, under the switches in force (shared/quota-adapters.ts). */
  catalog: PoolEntry[];
  /** Why provider quotas could not be read; the pool snapshot must not be written from such a board. */
  usageError: string | null;
  /** Set when plans.json gave no plan to judge; the pool snapshot must not be written either. */
  plansError: string | null;
  cursorRead: CursorReadMeta | null;
  cursorReading: CursorUsageReading | null;
  supergrokRead: SuperGrokReadMeta | null;
  /** plans.json dispatchPriority override in force when the board was built (DEMO_0124). */
  override: DispatchPriority | null;
}

/** Quota cards stay visible unless afc.config.json lists a matching hiddenPlans term. */
function shownInCockpit(text: string, hidden: readonly string[]): boolean {
  return !textHidden(text, hidden);
}

interface PlanContext {
  windowsBy: Map<string, Json[]>;
  balances: Map<string, Json[]>;
  cursorReading: CursorUsageReading | null;
  antigravityReading: AntigravityReading | null;
  sumUsd: (pred: (r: Row) => boolean) => number;
  switches: AdapterSwitches;
  quotaError?: string | null;
  providerCollectedAt?: string | null;
}

function planOf(cfg: PlanConfig, planConfigs: PlanConfig[], ctx: PlanContext): UsagePlan {
  const adapter = adapterOf(cfg, ctx.switches);
  const ambiguous = cfg.quotaCycle && adapterSpec(adapter).readsProvider && planConfigs.filter(p => p.usageProvider === cfg.usageProvider && adapterSpec(adapterOf(p, ctx.switches)).readsProvider).length > 1;
  const windows = windowsFor(cfg, adapter, { ...ctx, ...(ambiguous ? { quotaError: t("quota.setup.ambiguousSource") } : {}) }).map((w) => ({ ...w, pool: w.primary ? cfg.id : poolOfWindow(cfg, adapter, w.label) }));
  const bundled = new Set([...cfg.providers, ...(cfg.includes ?? []).flatMap((id) => planConfigs.find((p) => p.id === id)?.providers ?? [])]);
  const api30dUsd = ctx.sumUsd((r) => bundled.has(r.provider) && r.hour >= Date.now() - 30 * DAY);
  const stopPct = configuredStopPct(cfg);
  return {
    id: cfg.id,
    name: cfg.name,
    adapter,
    ...(baseAdapterOf(cfg) === CURSOR_API ? { cursorMonitoring: ctx.switches[CURSOR_API] } : {}),
    ...(cfg.cycleDay ? { cycleDay: cfg.cycleDay } : {}),
    ...(cfg.quotaCycle ? { quotaCycle: cfg.quotaCycle } : {}),
    ...(cfg.quotaCycle || cfg.manualOverride !== undefined || cfg.quotaProtection ? { quotaProtection: cfg.quotaProtection ?? "pause" } : {}),
    priceUsdMonthly: cfg.priceUsdMonthly,
    dispatch: cfg.dispatch,
    ...(cfg.pacePause !== undefined ? { pacePause: cfg.pacePause } : {}),
    ...(Array.isArray(cfg.onlyRoles) ? { onlyRoles: cfg.onlyRoles.filter(role => typeof role === "string" && role.length > 0) } : {}),
    ...(stopPct !== null ? { stopPct } : {}),
    note: cfg.note ?? "",
    providers: cfg.providers,
    windows,
    ...(adapter === ANTIGRAVITY_CLI ? { antigravityDisplay: antigravityDisplayWindows(ctx.antigravityReading, Date.now()) } : {}),
    api30dUsd,
    ...(cfg.overageBilling !== undefined ? { overageBilling: cfg.overageBilling } : {}),
    roi30d: cfg.priceUsdMonthly ? api30dUsd / cfg.priceUsdMonthly : null,
    coverage: cfg.coverage,
    ...(adapter === CURSOR_API ? { cursorRead: cursorReadForPlan(ctx.cursorReading, cfg.manual?.at ?? null) } : {}),
  };
}

/** Session id (and agent id) -> the role name shown on the by-role table. */
function sessionRolesOf(records: AgentRecord[], profiles: Profile[]): Map<string, string> {
  const roleName = new Map(profiles.map((p) => [p.role as string, p.role === "supervisor" ? "<leader>" : p.name]));
  const sessionRole = new Map<string, string>();
  for (const rec of records) {
    const role = rec.role ? (roleName.get(rec.role) ?? rec.role) : t("usage.role.paseoOther");
    if (rec.sessionId) sessionRole.set(rec.sessionId, role);
    sessionRole.set(rec.id, role);
  }
  return sessionRole;
}

interface PeriodTables {
  byModel: BoardUsage["byModel"];
  byRole: BoardUsage["byRole"];
  totals: BoardUsage["totals"];
  unpriced: Set<string>;
}

interface PeriodInput {
  rows: Row[];
  period: Period;
  planConfigs: PlanConfig[];
  priceMemo: Map<string, Price | null>;
  estimated: Set<string>;
  sessionRole: Map<string, string>;
}

function periodTables({ rows, period, planConfigs, priceMemo, estimated, sessionRole }: PeriodInput): PeriodTables {
  const since = periodStart(period);
  const inPeriod = rows.filter((r) => r.hour >= since - (period === "today" ? 0 : HOUR));
  const planOfProvider = new Map<string, PlanConfig>();
  for (const p of planConfigs) for (const prov of p.providers) planOfProvider.set(prov, p);
  const models = new Map<string, BoardUsage["byModel"][number]>();
  const roles = new Map<string, BoardUsage["byRole"][number]>();
  const totals = { apiUsd: 0, planUsd: 0, tokens: emptyTokens() };
  const unpriced = new Set<string>();
  for (const r of inPeriod) {
    const key = `${r.provider}/${r.model}`;
    const price = priceMemo.get(`${r.provider}|${r.model}`) ?? null;
    const value = valueOf(r.v, r.long, price);
    if (value === null) unpriced.add(key);
    const m = models.get(key) ?? { model: key, plan: planOfProvider.get(r.provider)?.name ?? "?", tokens: emptyTokens(), apiUsd: price ? 0 : null, priced: `${price?.catalogId ?? t("usage.model.noPrice")}${estimated.has(key) ? t("usage.model.estimated") : ""}` };
    addTokens(m.tokens, r.v);
    if (m.apiUsd !== null && value !== null) m.apiUsd += value;
    models.set(key, m);
    const role = sessionRole.get(r.sessionId) ?? t("usage.role.outside");
    const rr = roles.get(role) ?? { role, tokens: emptyTokens(), apiUsd: 0 };
    addTokens(rr.tokens, r.v);
    rr.apiUsd += value ?? 0;
    roles.set(role, rr);
    addTokens(totals.tokens, r.v);
    totals.apiUsd += value ?? 0;
  }
  const days = (Date.now() - since) / DAY;
  totals.planUsd = planConfigs.reduce((s, p) => s + (p.priceUsdMonthly ? (p.priceUsdMonthly * 12 * days) / 365 : 0), 0);
  return {
    byModel: [...models.values()].sort((a, b) => (b.apiUsd ?? 0) - (a.apiUsd ?? 0)),
    byRole: [...roles.values()].sort((a, b) => b.apiUsd - a.apiUsd),
    totals,
    unpriced,
  };
}

function tableWarnings(unpriced: Set<string>, planConfigs: PlanConfig[]): string[] {
  const warnings: string[] = [];
  if (unpriced.size) warnings.push(t("usage.warn.unpriced", { models: [...unpriced].join(t("usage.warn.listJoin")) }));
  const missingPrice = planConfigs.filter((p) => p.priceUsdMonthly === null && !planConfigs.some((o) => o.includes?.includes(p.id))).map((p) => p.name);
  if (missingPrice.length) warnings.push(t("usage.warn.missingPrice", { plans: missingPrice.join(t("usage.warn.listJoin")) }));
  return warnings;
}

async function priceMemoOf(rows: Row[], overrides: Record<string, Json>): Promise<Map<string, Price | null>> {
  const priceMemo = new Map<string, Price | null>();
  for (const r of rows) {
    const k = `${r.provider}|${r.model}`;
    if (!priceMemo.has(k)) priceMemo.set(k, await priceFor(r.provider, r.model, overrides));
  }
  return priceMemo;
}

export async function assemble(paseo: PaseoApi, period: Period, options?: { captureGrok?: boolean }): Promise<Assembled> {
  ensureScan(RESCAN_MS).catch((e) => console.error("[afc] usage scan:", String(e)));
  const switches = adapterSwitches();
  const banned = readBannedProviders();
  const plansFile = await readPlans();
  const planConfigs = usablePlans(plansFile.plans).filter((p) => !providerBanned(p, banned));
  const auto = planConfigs.some(p => adapterSpec(adapterOf(p, switches)).readsProvider);
  const wantAntigravity = antigravityUsageRequested(planConfigs, switches);
  const [{ rows: all, scannedAt, estimated }, usage, records, profiles, cursorReading, antigravityReading] = await Promise.all([
    allRows(),
    auto ? providerUsage(paseo) : Promise.resolve({ windows: new Map<string, Json[]>(), balances: new Map<string, Json[]>(), error: null, collectedAt: null }),
    readAgentRecords(),
    readRoleProfiles(),
    // cursor-api off: no Cursor reading at all; its plans fall back to the hand copy.
    switches[CURSOR_API] && planConfigs.some(p => adapterOf(p, switches) === CURSOR_API)
      ? captureCursorUsage().then(async captured => {
        const local = await readCursorUsageFile();
        return captured && !captured.ok && captured.error ? { ...(local ?? captured), ok: false, error: captured.error } : local ?? captured;
      }).catch(error => {
        console.error("[afc] cursor sampling:", String(error).slice(0, 200));
        return readCursorUsageFile();
      }) : Promise.resolve(null),
    // Off, or no plan on this adapter: do not spawn agy. A failed read stays an unknown ACP hold.
    wantAntigravity ? readAntigravityUsage().catch(() => unavailableAntigravityReading()) : Promise.resolve(null),
  ]);
  const warnings: string[] = [];
  if (usage.error) warnings.push(t("usage.warn.quotaUnread", { error: usage.error }));
  if (!scannedAt) warnings.push(t("usage.warn.firstScan"));
  const rows = all.filter((r) => !providerBanned(r, banned));
  const plansError = plansFile.invalid || (plansFile.plans.length > 0 && planConfigs.length === 0) ? NO_PLANS : null;
  if (plansError) warnings.push(plansError);
  else if (planConfigs.length === 0) warnings.push(t("usage.noPools"));
  const priceMemo = await priceMemoOf(rows, plansFile.prices ?? {});
  const usd = (r: Row) => valueOf(r.v, r.long, priceMemo.get(`${r.provider}|${r.model}`) ?? null) ?? 0;
  const ctx: PlanContext = {
    windowsBy: usage.windows,
    balances: usage.balances,
    cursorReading,
    antigravityReading,
    sumUsd: (pred) => rows.reduce((s, r) => (pred(r) ? s + usd(r) : s), 0),
    switches,
    quotaError: usage.error,
    providerCollectedAt: usage.collectedAt,
  };
  const plans = planConfigs.map((cfg) => planOf(cfg, planConfigs, ctx));
  const catalog = poolCatalog(planConfigs, switches);
  const tables = periodTables({ rows, period, planConfigs, priceMemo, estimated, sessionRole: sessionRolesOf(records, profiles) });
  warnings.push(...tableWarnings(tables.unpriced, planConfigs));
  const supergrokRead = await overlaySuperGrok(plans, planConfigs, options?.captureGrok === true, switches);
  const generatedAt = new Date().toISOString();
  // From the plans.json already read above: no extra file, CLI, or daemon call on the panel path.
  const override = activeDispatchPriority(plansFile, Date.parse(generatedAt));
  const board: BoardUsage = {
    generatedAt,
    scannedAt,
    scanning: scanInFlight(),
    pricesAt: await pricesFetchedAt(),
    plans,
    byModel: tables.byModel,
    byRole: tables.byRole,
    totals: tables.totals,
    warnings,
    companies: [],
  };
  const cursorPlan = planConfigs.find((p) => adapterOf(p, switches) === CURSOR_API);
  return { board, catalog, usageError: usage.error, plansError, cursorRead: cursorMeta(cursorReading, cursorPlan?.manual?.at ?? null), cursorReading, supergrokRead, override };
}

/**
 * The grok-cli plan: a grok screen reading no older than two hours wins. Paseo falls back unless stuck; then use
 * the hand copy.
 */
async function overlaySuperGrok(plans: UsagePlan[], configs: PlanConfig[], capture: boolean, switches: AdapterSwitches): Promise<SuperGrokReadMeta | null> {
  const cfg = configs.find((p) => adapterOf(p, switches) === GROK_CLI && !p.quotaCycle && !p.manualOverride);
  const plan = cfg ? plans.find((p) => p.id === cfg.id) : undefined;
  if (!plan || !cfg) return null;
  const choice = await settleSuperGrokChoice({
    providerWindows: plan.windows,
    manual: cfg.manual ?? null,
    cliRead: cfg.cliRead,
    capture,
  });
  const meta: SuperGrokReadMeta = {
    unreadSince: choice.unreadSince,
    alarm: choice.alarm,
    loginLost: choice.loginLost,
    loginAlarm: choice.loginAlarm,
    via: choice.source,
    sourceText: choice.sourceText,
    providerStuck: choice.providerStuck,
  };
  if (choice.source !== "provider" && choice.usedPct !== null) {
    plan.windows = [windowFromSuperGrok(choice, plan.windows[0], cfg.priceUsdMonthly)];
  } else if (choice.providerStuck && choice.usedPct === null) {
    plan.windows = plan.windows.map((w) => stuckWindow(w));
  }
  const safetyError = choice.safetyError ?? (choice.loginLost ? choice.loginAlarm ?? "Grok authentication failed" : knownQuotaFailure(choice.readError));
  if (safetyError) plan.windows = plan.windows.map(window => ({ ...window, safetyError }));
  if (choice.knownQuotaStop) plan.windows = plan.windows.map(window => ({ ...window, knownQuotaStop: choice.knownQuotaStop }));
  return meta;
}

/** A stuck Paseo window keeps its reset time but carries no percent, so nothing downstream uses it. */
export function stuckWindow(w: UsageWindow): UsageWindow {
  return { ...w, usedPct: null, elapsedPct: null, projectedPct: null, runsOutAt: null, verdict: "unknown", fullWindowUsd: null };
}

export function windowFromSuperGrok(choice: SuperGrokChoice, previous: UsageWindow | undefined, priceUsdMonthly: number | null): UsageWindow {
  const daily = priceUsdMonthly !== null ? (priceUsdMonthly * 12) / 365 : null;
  const apiUsd = previous?.apiUsd ?? 0;
  const planUsd = previous?.planUsd ?? (daily !== null ? daily * 7 : null);
  const sampleMeta = { sampledAt: choice.readAt, readError: choice.readError ?? null,
    safetyError: choice.safetyError ?? (choice.loginLost ? choice.loginAlarm ?? "Grok authentication failed" : knownQuotaFailure(choice.readError)) };
  const used = choice.usedPct ?? 0;
  const end = choice.resetsAt ? Date.parse(choice.resetsAt) : Number.NaN;
  if (Number.isNaN(end)) {
    return {
      label: "Weekly",
      usedPct: choice.usedPct,
      resetsAt: null,
      startsAt: null,
      elapsedPct: null,
      projectedPct: null,
      runsOutAt: null,
      verdict: "unknown",
      apiUsd,
      fullWindowUsd: null,
      planUsd,
      source: choice.source === "screen" ? "screen" : "manual",
      manualAt: choice.manualAt,
      ...sampleMeta,
    };
  }
  const len = 7 * DAY;
  const start = end - len;
  const at = choice.source === "manual" && choice.manualAt ? Date.parse(choice.manualAt) : Date.now();
  return {
    label: "Weekly",
    usedPct: choice.usedPct,
    resetsAt: new Date(end).toISOString(),
    startsAt: new Date(start).toISOString(),
    ...judgeAt(used, start, len, Number.isNaN(at) ? Date.now() : at),
    apiUsd,
    fullWindowUsd: used >= 2 ? (apiUsd * 100) / used : null,
    planUsd,
    source: choice.source === "screen" ? "screen" : "manual",
    manualAt: choice.manualAt,
    ...sampleMeta,
  };
}

/** Coupon round inputs: the Claude main week and the Codex week, whatever plans.json calls those plans. */
async function couponRound(plans: UsagePlan[]): Promise<CouponBoardView | null> {
  if (!plans.some(p => p.adapter === CLAUDE_CLI || p.adapter === CODEX_CLI)) return null;
  const plan = plans.find((p) => p.adapter === CLAUDE_CLI);
  const week = plan?.windows.find(w => isWeeklyWindow(w) && !/fable/i.test(w.label));
  const codex = plans.find((p) => p.adapter === CODEX_CLI);
  const codexWeek = codex?.windows.find(isWeeklyWindow);
  return refreshCouponRound({
    weeklyUsedPct: week?.usedPct ?? null,
    weeklyResetsAt: week?.resetsAt ?? null,
    codexUsedPct: codexWeek?.usedPct ?? null,
    codexResetsAt: codexWeek?.resetsAt ?? null,
  });
}

async function companiesOf(
  board: BoardUsage,
  pools: Record<string, PoolStatus>,
  reading: CursorUsageReading | null,
  cursorRead: CursorReadMeta | null,
  write: boolean,
  coupons: CouponBoardView | null,
  supergrokNotice: string | null,
  supergrokSource: string | null = null,
): Promise<BoardUsage["companies"]> {
  const hidden = readHiddenPlans();
  const shown = board.plans.filter((plan) => shownInCockpit(`${plan.id} ${plan.name} ${(plan.providers ?? []).join(" ")}`, hidden));
  const profiles = await readPoolProfiles().catch(() => [] as QuotaProfile[]);
  const creditsLine = await codexCreditsCardText(Date.parse(board.generatedAt) || Date.now()).catch(() => null);
  const codexPlan = board.plans.find((plan) => plan.adapter === CODEX_CLI);
  const companies = buildCompanies({
    now: Date.parse(board.generatedAt),
    companies: companyCatalog(shown),
    windows: companyWindows(shown, board.generatedAt),
    pools,
    profiles,
    cursor: companyCursor(shown, reading, cursorRead),
    manualStopPct: MANUAL_STOP,
    claudeStopPct: coupons?.claudeStopPct,
    coupons: coupons?.lines,
    creditsLine,
    supergrokNotice,
    supergrokSource,
    stopPctByPool: {
      ...Object.fromEntries(board.plans.flatMap((plan) => (typeof plan.stopPct === "number" ? [[plan.id, plan.stopPct] as const] : []))),
      ...(coupons?.codexStopPct != null && codexPlan ? { [codexPlan.id]: coupons.codexStopPct } : {}),
    },
  });
  if (write) {
    await writeJson(QUOTA_COMPANIES, { generatedAt: board.generatedAt, companies }).catch((e) => {
      console.error("[afc] quota companies:", String(e).slice(0, 200));
    });
  }
  return companies;
}

/** "Official early reset" lines from early-resets.json (file read only). A bad file shows nothing rather than failing the page. */
async function earlyLines(board: BoardUsage): Promise<Record<string, string>> {
  return readEarlyResetLines(Date.parse(board.generatedAt) || Date.now()).catch((error) => {
    console.error("[afc] early reset:", String(error).slice(0, 160));
    return {};
  });
}

/** The quota page's dispatch-order line: the same order the matrix gets, from pools already judged in memory (DEMO_0124). */
function withPriority(board: BoardUsage, pools: Record<string, PoolStatus>, override: DispatchPriority | null): BoardUsage {
  const now = Date.parse(board.generatedAt) || Date.now();
  return { ...board, priority: poolStatusPriority(resolveDispatchPriority(pools, override, now)) };
}

export async function buildUsage(paseo: PaseoApi, period: Period): Promise<BoardUsage> {
  const board = await buildUsageWithPools(paseo, period);
  const hidden = readHiddenPlans();
  return { ...board, plans: board.plans.filter((plan) => shownInCockpit(`${plan.id} ${plan.name} ${(plan.providers ?? []).join(" ")}`, hidden)) };
}

async function buildUsageWithPools(paseo: PaseoApi, period: Period): Promise<BoardUsage> {
  const capturedDigest = capturePolicyDigest();
  const { board, catalog, usageError, plansError, cursorRead, cursorReading, supergrokRead, override } = await assemble(paseo, period, { captureGrok: false });
  const coupons = await couponRound(board.plans).catch((error) => {
    console.error("[afc] reset coupons:", String(error).slice(0, 200));
    return null;
  });
  const codexCredits = await readCodexCreditsForDispatch().catch((error) => {
    console.error("[afc] codex credits:", String(error).slice(0, 160));
    return null;
  });
  const grokNotice = supergrokRead?.alarm ?? null;
  const poolOptions = {
    catalog,
    claudeDoubleWeek: coupons?.claudeDoubleWeek === true,
    claudeBurn: coupons?.claudeBurn ?? null,
    codexCouponCount: coupons?.codexCouponCount ?? 0,
    codexCouponExpiresAt: coupons?.codexCouponExpiresAt ?? null,
    codexBurnWeek: coupons?.codexBurnWeek ?? null,
    codexCredits,
    bannedProviders: readBannedProviders(),
  };
  if (plansError) {
    logPlansError(plansError);
    const judged = poolStatus(board.plans, poolOptions);
    const companies = await companiesOf(board, judged, cursorReading, cursorRead, false, coupons, grokNotice, supergrokRead?.sourceText ?? null);
    return withCursorLink(withPriority(board, judged, override), companies, cursorReading);
  }
  try {
    const pools = await writePoolStatus(board.plans, cursorRead, Date.now(), coupons?.claudeDoubleWeek === true, supergrokRead, coupons?.claudeBurn ?? null, coupons?.codexCouponCount ?? 0, coupons?.codexCouponExpiresAt ?? null, codexCredits, coupons?.codexBurnWeek ?? null, catalog);
    const companies = await companiesOf(board, pools, cursorReading, cursorRead, true, coupons, grokNotice, supergrokRead?.sourceText ?? null);
    const dispatch = await publishDispatch(pools, Date.now(), catalog, capturedDigest).catch((e) => {
      console.error("[afc] dispatch:", String(e).slice(0, 200));
      return null;
    });
    const supervisorNames = new Set((await readRoleProfiles()).filter((profile) => profile.role === "supervisor").map((profile) => profile.name));
    const early = await earlyLines(board);
    return withCursorLink({ ...withPriority(board, pools, override), pools: poolView(pools, early), dispatch: dispatchView(dispatch, supervisorNames, poolNames(catalog, "label")) }, companies, cursorReading);
  } catch (e) {
    console.error("[afc] pool status:", String(e));
    const pools = poolStatus(board.plans, poolOptions);
    const companies = await companiesOf(board, pools, cursorReading, cursorRead, false, coupons, grokNotice, supergrokRead?.sourceText ?? null);
    return withCursorLink({ ...withPriority(board, pools, override), pools: poolView(pools, await earlyLines(board)), dispatch: null }, companies, cursorReading);
  }
}

let lastPlansError: string | null = null;

/** Logged once per change, not on every timer tick. */
function logPlansError(message: string | null): void {
  if (!message || message === lastPlansError) return;
  lastPlansError = message;
  console.error(`[afc] pool status: ${message}`);
}

/** Publish local protection from scheduled samples; quota failures must not stop the heartbeat. */
export async function refreshPoolStatus(paseo: PaseoApi): Promise<void> {
  const capturedDigest = capturePolicyDigest();
  const { board, catalog, plansError, cursorRead, cursorReading, supergrokRead } = await assemble(paseo, "7d", { captureGrok: true });
  // Another connection would not help: keep the last snapshot, which goes stale and raises its own alarm.
  if (plansError) {
    logPlansError(plansError);
    return;
  }
  lastPlansError = null;
  const coupons = await couponRound(board.plans);
  const codexCredits = await readCodexCreditsForDispatch().catch((error) => {
    console.error("[afc] codex credits:", String(error).slice(0, 160));
    return null;
  });
  const pools = await writePoolStatus(board.plans, cursorRead, Date.now(), coupons?.claudeDoubleWeek ?? false, supergrokRead, coupons?.claudeBurn ?? null, coupons?.codexCouponCount ?? 0, coupons?.codexCouponExpiresAt ?? null, codexCredits, coupons?.codexBurnWeek ?? null, catalog);
  await companiesOf(board, pools, cursorReading, cursorRead, true, coupons, supergrokRead?.alarm ?? null, supergrokRead?.sourceText ?? null);
  await publishDispatch(pools, Date.now(), catalog, capturedDigest).catch((error) => {
    console.error("[afc] dispatch:", String(error).slice(0, 200));
  });
  // `paseo send` lives here, on the timer, never on the panel path (DEMO_0120).
  await deliverEarlyResetNotices(Date.now()).catch((error) => {
    console.error("[afc] early reset:", String(error).slice(0, 160));
  });
}
