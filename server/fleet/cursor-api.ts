/// <reference types="node" />
// AFC's own Cursor login and the official usage calls.
// Tokens passed in here are ones this process just received. This file does not open
// cursor-agent, the Cursor desktop database, another app's keychain items, or any token file.
//
// Shapes checked against public dashboard captures and the field names in current clients
// (no account data copied):
// - GET https://cursor.com/api/usage-summary
//   individualUsage.plan.autoPercentUsed / apiPercentUsed / totalPercentUsed (also accepted as
//   autoPercent / apiPercent / totalPercentUsed), billingCycleEnd or billingCycleStart (ISO),
//   individualUsage.onDemand.used / limit in cents.
// - POST https://cursor.com/api/dashboard/get-sand-usage-status  body {}
//   usagePercent is how much of Agent sandbox is already used. nextResetTimestampUtc is unix ms and
//   may be absent. Do not invent a reset from currentPeriodStart.
//   hasNonZeroIncludedLimit false, includedLimitZero, or usesPooledEnterpriseAllowance means
//   this plan has no separate Agent sandbox allowance.
// - POST https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage
//   Connect JSON, Bearer. planUsage has the same percent fields. billingCycleEnd is unix ms
//   as a string. spendLimitUsage.individualUsed / individualLimit are on-demand cents.
// - Login: GET https://cursor.com/loginDeepControl?challenge&uuid&mode=login
//   then GET https://api2.cursor.sh/auth/poll?uuid&verifier. 404 means not finished.
//   200 carries accessToken, refreshToken, and sometimes authId.
//   The challenge is base64url(SHA-256 of the base64url verifier string).
// - Refresh: POST https://api2.cursor.sh/oauth/token
//   { grant_type: "refresh_token", client_id, refresh_token } → access_token, shouldLogout.
// - cursor.com wants Cookie WorkosCursorSessionToken=<id>%3A%3A<access>, id from the JWT sub
//   after "|". api2 wants Authorization: Bearer.

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { t } from "../../shared/fleet/i18n";

/** Public OAuth client id shipped by Cursor's own app. Not a user secret. */
export const CURSOR_PUBLIC_CLIENT_ID = "KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB";

export function msgReconnect(): string {
  return t("cursor.api.reconnect");
}
export function msgNetwork(): string {
  return t("cursor.api.network");
}
export function msgFormat(): string {
  return t("cursor.api.format");
}
export function msgGrokDenied(): string {
  return t("cursor.api.grokDenied");
}

const USAGE_SUMMARY_URL = "https://cursor.com/api/usage-summary";
const SAND_URL = "https://cursor.com/api/dashboard/get-sand-usage-status";
const PERIOD_URL = "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage";
const POLL_URL = "https://api2.cursor.sh/auth/poll";
const REFRESH_URL = "https://api2.cursor.sh/oauth/token";
const LOGIN_URL = "https://cursor.com/loginDeepControl";

const REQUEST_TIMEOUT_MS = 15_000;
const REFRESH_SKEW_MS = 2 * 60_000;

export interface CursorTokens {
  accessToken: string;
  refreshToken: string;
  authId: string;
}

export interface LoginAttempt {
  url: string;
  uuid: string;
  verifier: string;
}

export interface OfficialWindow {
  label: string;
  usedPct: number | null;
  onDemandUsd: number | null;
  onDemandLimitUsd: number | null;
  resetsAt: string | null;
}

/** Percents and reset times taken from one successful official read. No tokens. */
export interface OfficialParts {
  includedPct: number | null;
  autoPct: number;
  apiPct: number | null;
  onDemandUsd: number | null;
  onDemandLimitUsd: number | null;
  resetsAt: string | null;
  windows: OfficialWindow[];
}

export type OfficialFailure = "expired" | "network" | "format";

export type OfficialLoad =
  | { ok: true; parts: OfficialParts; grokNote: string | null; tokens: CursorTokens }
  | { ok: false; failure: OfficialFailure; message: string; tokens: CursorTokens | null };

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

interface PlanPercents {
  autoPct: number;
  apiPct: number | null;
  totalPct: number | null;
  onDemandUsd: number | null;
  onDemandLimitUsd: number | null;
  billingCycleEnd: string | null;
}

export function createLoginAttempt(bytes = randomBytes(32), id = randomUUID()): LoginAttempt {
  const verifier = bytes.toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const url = new URL(LOGIN_URL);
  url.searchParams.set("challenge", challenge);
  url.searchParams.set("uuid", id);
  url.searchParams.set("mode", "login");
  url.searchParams.set("supportsSelectedTeamLogin", "true");
  return { url: url.toString(), uuid: id, verifier };
}

export function accessTokenNeedsRefresh(token: string, nowMs: number, skewMs = REFRESH_SKEW_MS): boolean {
  const exp = jwtNumber(token, "exp");
  if (exp === null) return false;
  return exp * 1000 <= nowMs + skewMs;
}

/** Account id for the cursor.com cookie. Null when the token has no usable subject. */
export function sessionAccount(token: string): string | null {
  const sub = jwtString(token, "sub");
  if (!sub) return null;
  const account = sub.includes("|") ? sub.slice(sub.lastIndexOf("|") + 1) : sub;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(account)) return null;
  return account;
}

export function sessionCookie(token: string): string | null {
  const account = sessionAccount(token);
  if (!account) return null;
  return `WorkosCursorSessionToken=${account}%3A%3A${token}`;
}

export function parseUsageSummary(body: unknown): PlanPercents | null {
  const root = asObj(body);
  if (!root || root.__unparsed === true) return null;
  const individual = asObj(root.individualUsage);
  const plan = asObj(individual?.plan) ?? asObj(root.planUsage) ?? root;
  const auto = percent(plan.autoPercentUsed ?? plan.autoPercent);
  if (auto === null) return null;
  const demand = asObj(individual?.onDemand) ?? asObj(root.onDemand);
  return {
    autoPct: auto,
    apiPct: percent(plan.apiPercentUsed ?? plan.apiPercent),
    totalPct: percent(plan.totalPercentUsed ?? plan.totalPercent),
    onDemandUsd: centsToUsd(num(demand?.used)),
    onDemandLimitUsd: centsToUsd(num(demand?.limit)),
    billingCycleEnd: cycleEnd(root),
  };
}

export function parseCurrentPeriodUsage(body: unknown): PlanPercents | null {
  const root = asObj(body);
  if (!root || root.__unparsed === true) return null;
  const plan = asObj(root.planUsage) ?? root;
  const auto = percent(plan.autoPercentUsed ?? plan.autoPercent);
  if (auto === null) return null;
  const spend = asObj(root.spendLimitUsage);
  const used = num(spend?.individualUsed ?? spend?.totalSpend);
  const limit = num(spend?.individualLimit ?? spend?.pooledLimit);
  return {
    autoPct: auto,
    apiPct: percent(plan.apiPercentUsed ?? plan.apiPercent),
    totalPct: percent(plan.totalPercentUsed ?? plan.totalPercent),
    onDemandUsd: centsToUsd(used),
    onDemandLimitUsd: centsToUsd(limit),
    billingCycleEnd: cycleEnd(root),
  };
}

export interface SandRead {
  pct: number | null;
  resetsAt: string | null;
  excluded: boolean;
  formatError: boolean;
  /** Cookie path returned 401/403, or the access token has no account id for that cookie. */
  unauthorized: boolean;
}

export function parseSandUsage(body: unknown): SandRead {
  const root = asObj(body);
  if (!root || root.__unparsed === true) return { pct: null, resetsAt: null, excluded: false, formatError: true, unauthorized: false };
  const excluded = root.usesPooledEnterpriseAllowance === true || root.includedLimitZero === true || root.hasNonZeroIncludedLimit === false;
  const pct = percent(root.usagePercent);
  const resetsAt = isoOrNull(root.nextResetTimestampUtc);
  if (excluded) return { pct: null, resetsAt, excluded: true, formatError: false, unauthorized: false };
  if (pct === null) return { pct: null, resetsAt, excluded: false, formatError: true, unauthorized: false };
  return { pct, resetsAt, excluded: false, formatError: false, unauthorized: false };
}

export function partsFromPlan(plan: PlanPercents, sand: SandRead | null): { parts: OfficialParts; grokNote: string | null } {
  const end = plan.billingCycleEnd;
  const windows: OfficialWindow[] = [];
  if (plan.totalPct !== null) windows.push(row("Included", plan.totalPct, null, null, end));
  windows.push(row("Auto", plan.autoPct, null, null, end));
  if (plan.apiPct !== null) windows.push(row("API", plan.apiPct, null, null, end));
  if (plan.onDemandUsd !== null || plan.onDemandLimitUsd !== null) {
    windows.push(row("On-Demand", null, plan.onDemandUsd, plan.onDemandLimitUsd, end));
  }
  let grokNote: string | null = null;
  if (sand?.excluded) {
    windows.push(row("Grok", null, null, null, sand.resetsAt));
    grokNote = t("cursor.api.grokNotSeparate");
  } else if (sand && !sand.formatError && !sand.unauthorized && sand.pct !== null) {
    windows.push(row("Grok", sand.pct, null, null, sand.resetsAt));
  } else if (sand?.unauthorized) {
    grokNote = msgGrokDenied();
  } else if (sand?.formatError) {
    grokNote = t("cursor.api.grokFormat");
  } else if (sand === null) {
    grokNote = t("cursor.api.grokNetwork");
  }
  return {
    parts: {
      includedPct: plan.totalPct,
      autoPct: plan.autoPct,
      apiPct: plan.apiPct,
      onDemandUsd: plan.onDemandUsd,
      onDemandLimitUsd: plan.onDemandLimitUsd,
      resetsAt: end,
      windows,
    },
    grokNote,
  };
}

export type PollVerdict =
  | { kind: "pending" }
  | { kind: "retry" }
  | { kind: "refused" }
  | { kind: "ok"; tokens: CursorTokens };

/** 404 is "not finished yet". A 200 without both tokens is a format failure, reported as refused. */
export function interpretPoll(status: number, body: unknown): PollVerdict {
  if (status === 404) return { kind: "pending" };
  if (status === 429 || status >= 500 || status === 0) return { kind: "retry" };
  if (status !== 200) return { kind: "refused" };
  const root = asObj(body);
  const access = str(root?.accessToken);
  const refresh = str(root?.refreshToken);
  if (!access || !refresh) return { kind: "refused" };
  return { kind: "ok", tokens: { accessToken: access, refreshToken: refresh, authId: str(root?.authId) ?? "" } };
}

export type RefreshVerdict =
  | { kind: "ok"; tokens: CursorTokens }
  | { kind: "expired" }
  | { kind: "format" };

export function interpretRefresh(status: number, body: unknown, previous: CursorTokens): RefreshVerdict {
  if (status === 401 || status === 403) return { kind: "expired" };
  if (status !== 200) return { kind: "format" };
  const root = asObj(body);
  if (!root) return { kind: "format" };
  if (root.shouldLogout === true) return { kind: "expired" };
  const access = str(root.access_token) ?? str(root.accessToken);
  if (!access) return { kind: "format" };
  const refresh = str(root.refresh_token) ?? str(root.refreshToken) ?? previous.refreshToken;
  return { kind: "ok", tokens: { accessToken: access, refreshToken: refresh, authId: previous.authId } };
}

export async function loadOfficialQuotas(tokens: CursorTokens, deps: { fetch?: FetchLike; now?: () => number } = {}): Promise<OfficialLoad> {
  const fetchImpl = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  let current = tokens;
  let justRefreshed = false;
  if (accessTokenNeedsRefresh(current.accessToken, now())) {
    const refreshed = await refresh(current, fetchImpl);
    if (refreshed.kind === "network") return fail("network", msgNetwork(), current);
    if (refreshed.kind === "expired") return fail("expired", msgReconnect(), null);
    if (refreshed.kind === "format") return fail("format", msgFormat(), current);
    current = refreshed.tokens;
    justRefreshed = true;
  }

  let summary = await getPlan(USAGE_SUMMARY_URL, current, fetchImpl, "cookie", parseUsageSummary);
  if (summary.kind === "unauthorized" && !justRefreshed) {
    const refreshed = await refresh(current, fetchImpl);
    if (refreshed.kind === "network") return fail("network", msgNetwork(), current);
    if (refreshed.kind === "expired") return fail("expired", msgReconnect(), null);
    if (refreshed.kind === "format") return fail("format", msgFormat(), current);
    current = refreshed.tokens;
    justRefreshed = true;
    summary = await getPlan(USAGE_SUMMARY_URL, current, fetchImpl, "cookie", parseUsageSummary);
  }

  let plan: PlanPercents | null = summary.kind === "ok" ? summary.plan : null;
  if (!plan) {
    // A 401 on the cookie path means cursor.com rejected the cookie, not that the token is dead.
    // Bearer GetCurrentPeriodUsage is the fallback. Only that 401/403, or a rejected refresh, drops the login.
    const period = await getPlan(PERIOD_URL, current, fetchImpl, "bearer", parseCurrentPeriodUsage);
    if (period.kind === "ok") plan = period.plan;
    else if (period.kind === "unauthorized") return fail("expired", msgReconnect(), null);
    else if (period.kind === "network" || summary.kind === "network") return fail("network", msgNetwork(), current);
    else return fail("format", msgFormat(), current);
  }

  const sand = await getSand(current, fetchImpl);
  const built = partsFromPlan(plan, sand);
  return { ok: true, parts: built.parts, grokNote: built.grokNote, tokens: current };
}

export async function pollOnce(attempt: LoginAttempt, fetchImpl: FetchLike = fetch): Promise<PollVerdict> {
  const url = new URL(POLL_URL);
  url.searchParams.set("uuid", attempt.uuid);
  url.searchParams.set("verifier", attempt.verifier);
  const hit = await requestJson(fetchImpl, url.toString(), { method: "GET", headers: { Accept: "application/json" } });
  if (hit.kind === "network") return { kind: "retry" };
  return interpretPoll(hit.status, hit.body);
}

function fail(failure: OfficialFailure, message: string, tokens: CursorTokens | null): OfficialLoad {
  return { ok: false, failure, message, tokens };
}

async function refresh(previous: CursorTokens, fetchImpl: FetchLike): Promise<RefreshVerdict | { kind: "network" }> {
  const hit = await requestJson(fetchImpl, REFRESH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: CURSOR_PUBLIC_CLIENT_ID,
      refresh_token: previous.refreshToken,
    }),
  });
  if (hit.kind === "network") return { kind: "network" };
  return interpretRefresh(hit.status, hit.body, previous);
}

async function getPlan(
  url: string,
  tokens: CursorTokens,
  fetchImpl: FetchLike,
  auth: "cookie" | "bearer",
  parse: (body: unknown) => PlanPercents | null,
): Promise<{ kind: "ok"; plan: PlanPercents } | { kind: "unauthorized" } | { kind: "network" } | { kind: "format" }> {
  const headers = authHeaders(tokens, auth);
  if (!headers) return { kind: "format" };
  const hit = await requestJson(fetchImpl, url, {
    method: auth === "bearer" ? "POST" : "GET",
    headers,
    body: auth === "bearer" ? "{}" : undefined,
  });
  if (hit.kind === "network") return { kind: "network" };
  if (hit.status === 401 || hit.status === 403) return { kind: "unauthorized" };
  if (hit.status !== 200) return { kind: "format" };
  const plan = parse(hit.body);
  if (!plan) return { kind: "format" };
  return { kind: "ok", plan };
}

async function getSand(tokens: CursorTokens, fetchImpl: FetchLike): Promise<SandRead | null> {
  const headers = authHeaders(tokens, "cookie");
  if (!headers) return { pct: null, resetsAt: null, excluded: false, formatError: false, unauthorized: true };
  headers["Content-Type"] = "application/json";
  const hit = await requestJson(fetchImpl, SAND_URL, { method: "POST", headers, body: "{}" });
  if (hit.kind === "network") return null;
  if (hit.status === 401 || hit.status === 403) return { pct: null, resetsAt: null, excluded: false, formatError: false, unauthorized: true };
  // A rejected cookie comes back as 200 text/html (the login page), not 401.
  if (hit.status === 200 && asObj(hit.body)?.__unparsed === true) return { pct: null, resetsAt: null, excluded: false, formatError: false, unauthorized: true };
  if (hit.status !== 200) return { pct: null, resetsAt: null, excluded: false, formatError: true, unauthorized: false };
  return parseSandUsage(hit.body);
}

function authHeaders(tokens: CursorTokens, auth: "cookie" | "bearer"): Record<string, string> | null {
  if (auth === "bearer") {
    return {
      Authorization: `Bearer ${tokens.accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "Connect-Protocol-Version": "1",
    };
  }
  const cookie = sessionCookie(tokens.accessToken);
  if (!cookie) return null;
  return {
    Cookie: cookie,
    Accept: "application/json",
    Origin: "https://cursor.com",
  };
}

async function requestJson(fetchImpl: FetchLike, url: string, init: RequestInit): Promise<{ kind: "network" } | { kind: "http"; status: number; body: unknown }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const res = await Promise.race([
      fetchImpl(url, { ...init, redirect: "error" }),
      new Promise<Response>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), REQUEST_TIMEOUT_MS);
      }),
    ]);
    const text = await res.text();
    if (!text) return { kind: "http", status: res.status, body: null };
    try {
      return { kind: "http", status: res.status, body: JSON.parse(text) as unknown };
    } catch {
      return { kind: "http", status: res.status, body: { __unparsed: true } };
    }
  } catch {
    return { kind: "network" };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function row(label: string, usedPct: number | null, onDemandUsd: number | null, onDemandLimitUsd: number | null, resetsAt: string | null): OfficialWindow {
  return { label, usedPct, onDemandUsd, onDemandLimitUsd, resetsAt };
}

function cycleEnd(root: Record<string, unknown>): string | null {
  const direct = isoOrNull(root.billingCycleEnd);
  if (direct) return direct;
  const cycle = root.billingCycle;
  if (typeof cycle === "string") return isoOrNull(cycle);
  const box = asObj(cycle);
  return isoOrNull(box?.end ?? box?.billingCycleEnd);
}

function asObj(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function percent(v: unknown): number | null {
  const n = num(v);
  if (n === null || n < 0 || n > 1000) return null;
  return n;
}

function centsToUsd(cents: number | null): number | null {
  if (cents === null) return null;
  return Math.round(cents) / 100;
}

function isoOrNull(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v) && v > 1e11) {
    const t = new Date(v);
    return Number.isNaN(t.getTime()) ? null : t.toISOString();
  }
  if (typeof v === "string") {
    const trimmed = v.trim();
    if (/^\d{12,}$/.test(trimmed)) {
      const t = new Date(Number(trimmed));
      return Number.isNaN(t.getTime()) ? null : t.toISOString();
    }
    const parsed = Date.parse(trimmed);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  }
  return null;
}

function jwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const json = Buffer.from(parts[1], "base64url").toString("utf8");
    return asObj(JSON.parse(json) as unknown);
  } catch {
    return null;
  }
}

function jwtString(token: string, key: string): string | null {
  return str(jwtPayload(token)?.[key]);
}

function jwtNumber(token: string, key: string): number | null {
  return num(jwtPayload(token)?.[key]);
}
