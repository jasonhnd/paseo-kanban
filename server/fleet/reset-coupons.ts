/// <reference types="node" />
// Once a day, and when the quota page asks, check how many reset coupons each company still has.
// Prefer a coupon field already present in Paseo's usage payload. Otherwise ask a CLI that can
// actually see coupons. Edge and osascript are no longer used.
// Codex is the only one: `codex app-server` then the read-only method account/rateLimits/read.
// Claude, SuperGrok, and Cursor cannot see a coupon from their CLI, so those stay on the
// plans.json hand entry. Cursor never starts an interactive cursor-agent.
// Never log in or out, never open a browser, and never keep account ids or credit ids.
//
// The pieces live in reset-coupons-*.ts beside this file; this one runs the rounds and re-exports
// the public surface.
import type { PaseoApi } from "./paseo-api";
import { createPaseoClient } from "./paseo-client.bundle.mjs";
import {
  USED_DROP_POINTS,
  codexCompanyPatch,
  codexCountReadNeeded,
  codexCreditPieces,
  couponCliKind,
  couponCliTargets,
  creditsReadDue,
  findCouponFields,
  parseCodexRateLimits,
  type CouponCompany,
  type PageRead,
  type ProviderCoupon,
} from "../../shared/fleet/reset-coupons";
import { CONFIG, type Json, readJson } from "./util";
import { readCodexRateLimits } from "./reset-coupons-codex";
import { readProviderQuota } from "./provider-usage";
import { sampleQuota } from "./quota-sampling";
import { readCreditsFile, storeCodexCredits } from "./reset-coupons-credits";
import { weeklyFromSnapshot } from "./reset-coupons-home";
import { saveCouponState, setNotify } from "./reset-coupons-notify";
import { signals } from "./reset-coupons-signals";
import { signalExtra } from "./reset-coupons-surplus";
import { lock, readPlans, readState, sameTokyoDay, type CouponPlans } from "./reset-coupons-state";
import type { CompanyLive, CouponBoardView, ResetCouponState } from "./reset-coupons-types";
import { boardView, summary } from "./reset-coupons-view";

export { CODEX_CREDITS_FILE, RESET_COUPON_STATE } from "./reset-coupons-types";
export type { CompanyLive, CouponBoardView, CouponBurnView, CouponHomeNote, CouponNotice, ResetCouponState } from "./reset-coupons-types";
export { boardView } from "./reset-coupons-view";
export { signals, type CouponSignalExtra } from "./reset-coupons-signals";
export { readCodexRateLimits, type CodexSpawn } from "./reset-coupons-codex";
export { codexCreditsCardText, readCodexCreditsForDispatch } from "./reset-coupons-credits";
export { couponHomeAlerts, couponHomeBanner } from "./reset-coupons-home";
export { surplusCardCounts } from "./reset-coupons-surplus";

const DAY_CHECK_MS = 60 * 60_000;
const FIRST_CHECK_MS = 3 * 60_000;
const CODEX_PAIR_RETRY_MS = 30 * 60_000;
const ERROR_TEXT_CHARS = 160;

/** Last time a baseline coupon-count read failed. A drop still retries immediately. */
let codexPairFailAt = 0;

function liveFrom(read: ProviderCoupon, via: "paseo" | "cli", now: number): CompanyLive {
  return {
    count: read.count,
    kind: read.kind,
    expiresAt: read.expiresAt,
    excerpt: read.excerpt.slice(0, 120),
    confirmedAt: new Date(now).toISOString(),
    via,
    status: "ok",
  };
}

function handEntry(status: "manual" | "off"): CompanyLive {
  return { count: 0, kind: "unknown", expiresAt: null, excerpt: "", confirmedAt: "", via: "plans", status };
}

/** Keep a previous CLI or Paseo reading. Anything else is not a confirmation. */
function keepPrevious(previous: CompanyLive | undefined): CompanyLive {
  if (previous?.confirmedAt && (previous.via === "cli" || previous.via === "paseo")) return { ...previous, status: "unreadable" };
  return { count: 0, kind: "unknown", expiresAt: null, excerpt: "", confirmedAt: "", via: "plans", status: "unreadable" };
}

interface ScheduledCodex { raw: unknown; at: number }
type SampledCoupon = ProviderCoupon & { sampledAt: number };

async function scheduledCodexRead(now: number): Promise<ScheduledCodex> {
  const sample = await sampleQuota("codex-coupons", () => readCodexRateLimits(), { now });
  if (sample.error) throw new Error(sample.error);
  const at = Date.parse(sample.collectedAt ?? "");
  if (!Number.isFinite(at)) throw new Error("Codex source time is unknown");
  return { raw: sample.value, at };
}

/** Coupon fields in Paseo's usage payload, by company (CouponPlans.providerCompany maps the provider). */
async function couponsFromPaseo(paseo: PaseoApi, now: number, providerCompany: Readonly<Record<string, CouponCompany>>): Promise<Partial<Record<CouponCompany, SampledCoupon>>> {
  const out: Partial<Record<CouponCompany, SampledCoupon>> = {};
  try {
    const sample = await readProviderQuota(paseo, { now });
    if (sample.error) throw new Error(sample.error);
    const res = sample.value;
    for (const raw of res?.providers ?? []) {
      if (!raw || typeof raw !== "object") continue;
      const id = String((raw as { providerId?: unknown }).providerId ?? "");
      const company = Object.prototype.hasOwnProperty.call(providerCompany, id) ? providerCompany[id] : undefined;
      if (!company) continue;
      const found = findCouponFields(raw, now);
      const sampledAt = Date.parse(sample.collectedAt ?? "");
      if (found && Number.isFinite(sampledAt)) out[company] = { ...found, sampledAt };
    }
  } catch (error) {
    console.error("[afc] reset coupons: reading Paseo usage failed", String(error).slice(0, ERROR_TEXT_CHARS));
  }
  return out;
}

interface CodexRead {
  sampledAt: number;
  parsed: PageRead | null;
  raw: unknown;
  failed: boolean;
}

/** One read-only Codex call, and the credits balance it carries. A failed read is recorded, not thrown. */
async function readCodexForConfirm(now: number): Promise<CodexRead> {
  let raw: unknown = null;
  let parsed: PageRead | null = null;
  let failed = false;
  let sampledAt = now;
  try {
    const sample = await scheduledCodexRead(now);
    raw = sample.raw;
    sampledAt = sample.at;
    parsed = parseCodexRateLimits(raw);
  } catch (error) {
    failed = true;
    console.error("[afc] reset coupons: Codex CLI", String(error).slice(0, ERROR_TEXT_CHARS));
  }
  await storeCodexCredits(failed ? null : raw, sampledAt, null);
  return { parsed, raw, failed, sampledAt };
}

/** What one company shows after a confirm: Paseo's field, a hand entry, the Codex CLI read, or the previous reading. */
function companyAfterConfirm(
  company: CouponCompany,
  fromApi: SampledCoupon | undefined,
  plans: CouponPlans,
  codex: CodexRead | null,
  previous: CompanyLive | undefined,
  now: number,
): CompanyLive {
  if (fromApi) return liveFrom(fromApi, "paseo", fromApi.sampledAt);
  if (couponCliKind(company) === "none") return handEntry("manual");
  if (!plans.cliRead[company]) return handEntry("off");
  const parsed = codex?.parsed;
  if (!codex || codex.failed || !parsed || parsed.status === "unreadable") return keepPrevious(previous);
  return {
    ...liveFrom({ count: parsed.count, kind: parsed.kind, expiresAt: parsed.expiresAt, excerpt: parsed.excerpt }, "cli", codex.sampledAt),
    items: codexCreditPieces(codex.raw),
  };
}

export async function confirmResetCoupons(paseo: PaseoApi | null, options: { force?: boolean; now?: number } = {}): Promise<{ ok: boolean; message: string }> {
  return lock(async () => {
    const now = options.now ?? Date.now();
    const plans = await readPlans();
    const state = await readState();
    if (!options.force && sameTokyoDay(state.attemptedAt, now) && state.attemptedAt) {
      return { ok: true, message: summary(plans.seeds, state, now, plans.cliRead, plans.names) };
    }
    const found = paseo && Object.keys(plans.providerCompany).length > 0 ? await couponsFromPaseo(paseo, now, plans.providerCompany) : {};
    const wantsCodex = couponCliTargets(plans.cliRead).includes("chatgpt") && !found.chatgpt;
    const codex = wantsCodex ? await readCodexForConfirm(now) : null;
    const companies: ResetCouponState["companies"] = { ...state.companies };
    for (const company of Object.keys(plans.seeds)) {
      companies[company] = companyAfterConfirm(company, found[company], plans, codex, state.companies[company], now);
    }
    const next: ResetCouponState = { ...state, attemptedAt: new Date(now).toISOString(), companies };
    const weekly = await weeklyFromSnapshot();
    const signaled = signals(plans.seeds, next, now, weekly.usedPct, weekly.resetsAt, plans.cliRead, await signalExtra(undefined, false));
    await saveCouponState(signaled.state, signaled.sends, signaled.pending, now);
    const message = summary(plans.seeds, signaled.state, now, plans.cliRead, plans.names);
    console.log(`[afc] reset coupons: ${message}`);
    return { ok: true, message };
  });
}

interface CountPairing {
  creditsAt?: number;
  state: ResetCouponState;
  codexCountNow: number | null | undefined;
  anchor: boolean;
  /** Raw rate-limits payload when this round already read one. Null for a failed read. Undefined when it did not read. */
  creditsRaw: unknown | null | undefined;
}

/**
 * Read the ChatGPT coupon count at the same moment as the usage sample, when a drop might need it.
 * A failed read backs off for half an hour, unless usage is dropping right now.
 */
async function pairCodexCount(state: ResetCouponState, plans: CouponPlans, nextCodexPct: number | null, now: number): Promise<CountPairing> {
  const unread: CountPairing = { state, codexCountNow: undefined, anchor: false, creditsRaw: undefined };
  // Only a Codex plan in plans.json with its coupon read on (CouponPlans has no `chatgpt` key without one).
  const needCount = plans.cliRead.chatgpt === true && codexCountReadNeeded(state.lastCodexUsedPct ?? null, nextCodexPct, state.codexCountAtLastUsage ?? null);
  const dropping = typeof state.lastCodexUsedPct === "number" && typeof nextCodexPct === "number" && state.lastCodexUsedPct - nextCodexPct >= USED_DROP_POINTS;
  if (!needCount || !(dropping || now - codexPairFailAt >= CODEX_PAIR_RETRY_MS)) return unread;
  try {
    const { raw, at } = await scheduledCodexRead(now);
    const patch = codexCompanyPatch(raw);
    if (!patch) {
      if (!dropping) codexPairFailAt = now;
      return { ...unread, codexCountNow: null, creditsRaw: raw, creditsAt: at };
    }
    codexPairFailAt = 0;
    const chatgpt: CompanyLive = {
      count: patch.count,
      kind: patch.kind,
      expiresAt: patch.expiresAt,
      excerpt: patch.excerpt,
      confirmedAt: new Date(at).toISOString(),
      via: "cli",
      status: "ok",
      items: patch.items,
    };
    return { state: { ...state, companies: { ...state.companies, chatgpt } }, codexCountNow: patch.count, anchor: true, creditsRaw: raw, creditsAt: at };
  } catch (error) {
    if (!dropping) codexPairFailAt = now;
    console.error("[afc] reset coupons: read-only coupon count check failed", String(error).slice(0, ERROR_TEXT_CHARS));
    return { ...unread, codexCountNow: null, creditsRaw: null };
  }
}

/** Credits balance, when the count read did not already carry one and the stored reading is an hour old. */
async function readCreditsIfDue(plans: CouponPlans, now: number): Promise<ScheduledCodex | null | undefined> {
  if (plans.cliRead.chatgpt !== true) return undefined;
  const prev = await readCreditsFile();
  if (!creditsReadDue(prev?.readAt, now)) return undefined;
  try {
    return await scheduledCodexRead(now);
  } catch (error) {
    console.error("[afc] reset coupons: read-only credits read failed", String(error).slice(0, ERROR_TEXT_CHARS));
    return null;
  }
}

/** Update used-coupon detection and reminders from the latest weekly reading. Does not start a CLI. */
export async function refreshCouponRound(input: {
  now?: number;
  weeklyUsedPct: number | null;
  weeklyResetsAt: string | null;
  codexUsedPct?: number | null;
  codexResetsAt?: string | null;
}): Promise<CouponBoardView> {
  return lock(async () => {
    const now = input.now ?? Date.now();
    const plans = await readPlans();
    const paired = await pairCodexCount(await readState(), plans, input.codexUsedPct ?? null, now);
    const credits = paired.creditsRaw !== undefined ? { raw: paired.creditsRaw, at: paired.creditsAt ?? now } : await readCreditsIfDue(plans, now);
    if (credits !== undefined) await storeCodexCredits(credits?.raw ?? null, credits?.at ?? now, input.codexResetsAt ?? null);
    const extra = await signalExtra({ usedPct: input.codexUsedPct ?? null, resetsAt: input.codexResetsAt ?? null }, paired.anchor, paired.codexCountNow);
    const signaled = signals(plans.seeds, paired.state, now, input.weeklyUsedPct, input.weeklyResetsAt, plans.cliRead, extra);
    await saveCouponState(signaled.state, signaled.sends, signaled.pending, now);
    return boardView(plans.seeds, signaled.state, now, plans.cliRead);
  });
}

async function daemonUrl(): Promise<string> {
  const listen = (await readJson<Json>(CONFIG, {}))?.daemon?.listen;
  return `ws://${typeof listen === "string" && listen.includes(":") ? listen : "127.0.0.1:6767"}/ws`;
}

async function confirmWith(paseo: PaseoApi | null): Promise<void> {
  if (paseo) {
    await confirmResetCoupons(paseo);
    return;
  }
  const client = createPaseoClient({ url: await daemonUrl(), clientId: "afc-reset-coupons", connectTimeoutMs: 10_000, reconnect: { enabled: false } });
  try {
    await client.connect();
  } catch (error) {
    console.error("[afc] reset coupons: own daemon connection failed", String(error).slice(0, ERROR_TEXT_CHARS));
    await client.close().catch(() => {});
    await confirmResetCoupons(null);
    return;
  }
  try {
    await confirmResetCoupons(client);
  } finally {
    await client.close().catch(() => {});
  }
}

export function startResetCouponConfirm(handle: () => PaseoApi | null, notify: (agentId: string, text: string) => Promise<void>): () => void {
  setNotify(notify);
  let timer: ReturnType<typeof setInterval> | undefined;
  let running = false;
  const tick = async (force: boolean) => {
    if (running) return;
    running = true;
    try {
      const state = await readState();
      if (!force && sameTokyoDay(state.attemptedAt, Date.now())) return;
      await confirmWith(handle());
    } catch (error) {
      console.error("[afc] reset coupons:", String(error).slice(0, 200));
    } finally {
      running = false;
    }
  };
  const first = setTimeout(() => {
    void tick(false);
    timer = setInterval(() => void tick(false), DAY_CHECK_MS);
  }, FIRST_CHECK_MS);
  return () => {
    clearTimeout(first);
    if (timer) clearInterval(timer);
  };
}

/** One confirm from this process, using its own daemon connection. Used by the harness, not the plugin timer. */
export async function confirmResetCouponsStandalone(): Promise<{ ok: boolean; message: string }> {
  const client = createPaseoClient({ url: await daemonUrl(), clientId: "afc-reset-coupons-once", connectTimeoutMs: 10_000, reconnect: { enabled: false } });
  try {
    await client.connect();
    return await confirmResetCoupons(client, { force: true });
  } finally {
    await client.close().catch(() => {});
  }
}

export async function describeCoupons(now = Date.now()): Promise<string> {
  const plans = await readPlans();
  const state = await readState();
  return summary(plans.seeds, state, now, plans.cliRead, plans.names);
}
