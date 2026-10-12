/**
 * Decide what a non-interactive `cursor-agent status` / `--version` pair means.
 * This file never starts a process, never runs login or logout, and never keeps command output.
 */

import { t, tAll } from "./i18n";
import { cursorKeychainCaveat } from "./keychain-probe";

export const CURSOR_LOGIN_INTERVAL_MS = 10 * 60_000;
/** While status says logged out, check again in one minute instead of ten. */
export const CURSOR_LOGIN_OUT_INTERVAL_MS = 60_000;
/** A logged-out reading older than this does not stop the cursor pool. */
export const CURSOR_LOGOUT_FRESH_MS = 15 * 60_000;
/** Failed leader notices for one outage. The next try is the following check. */
export const CURSOR_LOGIN_NOTIFY_LIMIT = 3;
export function cursorPoolStopNotice(): string {
  return t("cursor.login.poolStop");
}
export function cursorPoolResumeNotice(): string {
  return t("cursor.login.poolResume");
}
export const CURSOR_LOGIN_TIMEOUT_MS = 10_000;
/** Logout inside this window after a version change is called out in the leader notice. */
export const UPGRADE_WINDOW_MS = 10 * 60_000;

export const CURSOR_STATUS_ARGS = ["status"] as const;
export const CURSOR_VERSION_ARGS = ["--version"] as const;

export function cursorLoginAlertKind(): string {
  return t("cursor.login.alertKind");
}

/** "partial": status says "Partially authenticated" (no refresh token). Credentials work now, expire later. */
export type CursorLogin = "in" | "out" | "partial" | "unknown";
export type CursorUnavailable = "timeout" | "missing" | "unclear";

export interface CursorLoginSample {
  login: CursorLogin;
  /** Null when `--version` did not return a version. The previous version is kept. */
  version: string | null;
  /** Set when login is unknown. Timeout and a missing command are never "out". */
  unavailable: CursorUnavailable | null;
}

export interface CursorLoginNote {
  at: number;
  text: string;
}

export interface CursorLoginState {
  login: CursorLogin;
  version: string | null;
  checkedAt: number | null;
  /** Homepage red line for the current outage. Cleared only when status says logged in. */
  alerting: boolean;
  /** One successful `paseo send` per outage. Cleared on recovery so the next outage can send again. */
  notified: boolean;
  /** Which kind ("out" or "partial") the last successful notice was for. Null when none. */
  notifiedFor: "out" | "partial" | null;
  /** Failed sends during this outage. A success or a recovery resets it. Stop after the limit. */
  notifyAttempts: number;
  versionChangedAt: number | null;
  notes: CursorLoginNote[];
  unavailable: CursorUnavailable | null;
  /** Kanban leader was told this outage stopped the cursor pool. Cleared on recovery. */
  poolStopSent: boolean;
  /** Failed sends of the stop notice during this outage. */
  poolStopAttempts: number;
  /** Recovery notice still needs a successful send. */
  poolResumePending: boolean;
  /** Failed sends of the recovery notice. */
  poolResumeAttempts: number;
}

export interface CursorLoginTick {
  state: CursorLoginState;
  notify: boolean;
  notice: string;
  note: string | null;
  /** Rewrite pool-status now: just logged out, or just left logged-out. */
  refreshPools: boolean;
  /** One stop notice and one recovery notice per outage, to the Kanban leader only. */
  poolNotify: boolean;
  poolNotice: string;
  poolKind: "stop" | "resume" | null;
}

export interface CommandCapture {
  text: string;
  timedOut: boolean;
  missing: boolean;
}

export function emptyCursorLoginState(): CursorLoginState {
  return {
    login: "unknown",
    version: null,
    checkedAt: null,
    alerting: false,
    notified: false,
    notifiedFor: null,
    notifyAttempts: 0,
    versionChangedAt: null,
    notes: [],
    unavailable: null,
    poolStopSent: false,
    poolStopAttempts: 0,
    poolResumePending: false,
    poolResumeAttempts: 0,
  };
}

export function cursorPartialNotice(): string {
  return t("cursor.login.partialNotice");
}
export function cursorPartialLabel(): string {
  return t("cursor.login.partialLabel");
}

/** "Not logged in" is checked first because that sentence also contains "logged in". */
export function loginFromStatusOutput(text: string): CursorLogin {
  if (/not logged in/i.test(text)) return "out";
  if (/partially authenticated/i.test(text)) return "partial";
  if (/logged in/i.test(text)) return "in";
  return "unknown";
}

/** Keep a version token only. Anything else (paths, account text) is dropped. */
export function versionFromText(text: string): string | null {
  const matched = /(\d{4}\.\d{2}\.\d{2}-[0-9a-z]+)/i.exec(text);
  if (!matched?.[1]) return null;
  return matched[1].slice(0, 80);
}

export function sampleFromCommands(status: CommandCapture, version: CommandCapture): CursorLoginSample {
  const parsed = version.timedOut || version.missing ? null : versionFromText(version.text);
  if (status.timedOut) return { login: "unknown", version: parsed, unavailable: "timeout" };
  if (status.missing) return { login: "unknown", version: parsed, unavailable: "missing" };
  const login = loginFromStatusOutput(status.text);
  if (login === "unknown") return { login: "unknown", version: parsed, unavailable: "unclear" };
  return { login, version: parsed, unavailable: null };
}

export function loginAlarmText(version: string | null): string {
  const label = version && version.trim() ? version.trim() : t("cursor.login.unknownVersion");
  return t("cursor.login.alarm", { version: label });
}

export function versionNote(from: string, to: string): string {
  return t("cursor.login.versionNote", { from, to });
}

/** The fixed start of a version note in every language, so notes stored in another language still load. */
function versionNotePrefixes(): string[] {
  const mark = "\u0000";
  return tAll("cursor.login.versionNote", { from: mark, to: mark }).map((text) => text.slice(0, text.indexOf(mark)));
}

export function cursorLoginIntervalMs(login: CursorLogin): number {
  return login === "out" ? CURSOR_LOGIN_OUT_INTERVAL_MS : CURSOR_LOGIN_INTERVAL_MS;
}

/** True only for a logged-out reading whose checkedAt is within the last 15 minutes. */
export function cursorLogoutIsFresh(login: CursorLogin, checkedAt: number | null, now: number): boolean {
  if (login !== "out" || checkedAt === null) return false;
  const age = now - checkedAt;
  return age >= 0 && age <= CURSOR_LOGOUT_FRESH_MS;
}

export function outageNotice(version: string | null, versionChangedAt: number | null, now: number): string {
  const base = loginAlarmText(version);
  if (versionChangedAt !== null && now >= versionChangedAt && now - versionChangedAt <= UPGRADE_WINDOW_MS) {
    return t("cursor.login.maybeUpgrade", { base });
  }
  return base;
}

function notifyAttemptsFrom(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
  return Math.min(CURSOR_LOGIN_NOTIFY_LIMIT, Math.floor(value));
}

function cleanVersion(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return versionFromText(value);
}

function notesFrom(value: unknown): CursorLoginNote[] {
  if (!Array.isArray(value)) return [];
  const out: CursorLoginNote[] = [];
  const prefixes = versionNotePrefixes();
  for (const row of value) {
    if (!row || typeof row !== "object") continue;
    const item = row as { at?: unknown; text?: unknown };
    const at = typeof item.at === "number" && Number.isFinite(item.at) ? item.at : NaN;
    const text = typeof item.text === "string" ? item.text.replace(/[\r\n]/g, " ").trim().slice(0, 160) : "";
    if (!Number.isFinite(at) || !prefixes.some((prefix) => text.startsWith(prefix))) continue;
    out.push({ at, text });
  }
  return out.slice(-20);
}

export function normalizeCursorLoginState(raw: unknown): CursorLoginState {
  const empty = emptyCursorLoginState();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return empty;
  const row = raw as Record<string, unknown>;
  const login = row.login === "in" || row.login === "out" || row.login === "partial" || row.login === "unknown" ? row.login : "unknown";
  const unavailable = row.unavailable === "timeout" || row.unavailable === "missing" || row.unavailable === "unclear"
    ? row.unavailable
    : null;
  return {
    login,
    version: cleanVersion(row.version),
    checkedAt: typeof row.checkedAt === "number" && Number.isFinite(row.checkedAt) ? row.checkedAt : null,
    alerting: row.alerting === true,
    notified: row.notified === true,
    notifiedFor: row.notified !== true ? null
      : row.notifiedFor === "out" || row.notifiedFor === "partial" ? row.notifiedFor
      : login === "out" || login === "partial" ? login : null,
    notifyAttempts: notifyAttemptsFrom(row.notifyAttempts),
    versionChangedAt: typeof row.versionChangedAt === "number" && Number.isFinite(row.versionChangedAt) ? row.versionChangedAt : null,
    notes: notesFrom(row.notes),
    unavailable: login === "unknown" ? unavailable : null,
    poolStopSent: row.poolStopSent === true,
    poolStopAttempts: notifyAttemptsFrom(row.poolStopAttempts),
    poolResumePending: row.poolResumePending === true,
    poolResumeAttempts: notifyAttemptsFrom(row.poolResumeAttempts),
  };
}

/**
 * `poolDispatch` is plans.json `cursor.dispatch`. When false (Paseo does not dispatch to Cursor, DEMO_0098)
 * there is no pool stop/resume notice and the pool delivery flags stay cleared; login status is unchanged.
 */
export function applyCursorLoginTick(prev: CursorLoginState, sample: CursorLoginSample, now: number, poolDispatch = true): CursorLoginTick {
  const tick = judgeCursorLoginTick(prev, sample, now);
  if (poolDispatch) return tick;
  return {
    ...tick,
    state: { ...tick.state, poolStopSent: false, poolStopAttempts: 0, poolResumePending: false, poolResumeAttempts: 0 },
    poolNotify: false,
    poolNotice: "",
    poolKind: null,
  };
}

function judgeCursorLoginTick(prev: CursorLoginState, sample: CursorLoginSample, now: number): CursorLoginTick {
  const notes = prev.notes.slice();
  let version = prev.version;
  let versionChangedAt = prev.versionChangedAt;
  let recorded: string | null = null;
  const nextVersion = cleanVersion(sample.version);
  if (nextVersion) {
    if (version && nextVersion !== version) {
      recorded = versionNote(version, nextVersion);
      notes.push({ at: now, text: recorded });
      versionChangedAt = now;
    }
    version = nextVersion;
  }

  let login = prev.login;
  let alerting = prev.alerting;
  let notified = prev.notified;
  let notifiedFor = prev.notifiedFor;
  let notifyAttempts = prev.notifyAttempts;
  let unavailable = prev.unavailable;
  let notify = false;
  let notice = "";
  let poolStopSent = prev.poolStopSent;
  let poolStopAttempts = prev.poolStopAttempts;
  let poolResumePending = prev.poolResumePending;
  let poolResumeAttempts = prev.poolResumeAttempts;
  let poolNotify = false;
  let poolNotice = "";
  let poolKind: "stop" | "resume" | null = null;
  let refreshPools = false;

  if (sample.login === "in") {
    const wantResume = prev.login === "out" || prev.alerting || prev.poolResumePending;
    login = "in";
    alerting = false;
    notified = false;
    notifiedFor = null;
    notifyAttempts = 0;
    unavailable = null;
    poolStopSent = false;
    poolStopAttempts = 0;
    refreshPools = prev.login === "out" || (prev.alerting && prev.login !== "in");
    if (wantResume && prev.poolResumeAttempts < CURSOR_LOGIN_NOTIFY_LIMIT) {
      poolNotify = true;
      poolNotice = cursorPoolResumeNotice();
      poolKind = "resume";
      poolResumePending = true;
      poolResumeAttempts = prev.poolResumeAttempts;
    } else {
      poolResumePending = false;
      poolResumeAttempts = 0;
    }
  } else if (sample.login === "partial") {
    // Credentials still work: never stop the pool, no red alert. One leader notice per partial spell.
    if (prev.login === "out" || (notified && notifiedFor !== "partial")) {
      notified = false;
      notifiedFor = null;
      notifyAttempts = 0;
    }
    login = "partial";
    alerting = false;
    unavailable = null;
    if (!notified && notifyAttempts < CURSOR_LOGIN_NOTIFY_LIMIT) {
      notify = true;
      notice = cursorPartialNotice();
    }
    refreshPools = prev.login === "out";
    if ((prev.login === "out" || prev.poolStopSent || prev.poolResumePending) && prev.poolResumeAttempts < CURSOR_LOGIN_NOTIFY_LIMIT) {
      poolStopSent = false;
      poolStopAttempts = 0;
      poolNotify = true;
      poolNotice = cursorPoolResumeNotice();
      poolKind = "resume";
      poolResumePending = true;
    }
  } else if (sample.login === "out") {
    if (prev.login === "partial" || (notified && notifiedFor !== "out")) {
      notified = false;
      notifiedFor = null;
      notifyAttempts = 0;
    }
    const alreadySent = notified;
    const triedOut = notifyAttempts >= CURSOR_LOGIN_NOTIFY_LIMIT;
    login = "out";
    alerting = true;
    unavailable = null;
    poolResumePending = false;
    poolResumeAttempts = 0;
    refreshPools = prev.login !== "out";
    if (!alreadySent && !triedOut) {
      notify = true;
      notice = outageNotice(version, versionChangedAt, now);
    }
    if (!poolStopSent && poolStopAttempts < CURSOR_LOGIN_NOTIFY_LIMIT) {
      poolNotify = true;
      poolNotice = cursorPoolStopNotice();
      poolKind = "stop";
    }
  } else {
    login = "unknown";
    unavailable = sample.unavailable ?? "unclear";
    refreshPools = prev.login === "out";
  }

  return {
    state: {
      login,
      version,
      checkedAt: now,
      alerting,
      notified,
      notifiedFor,
      notifyAttempts,
      versionChangedAt,
      notes: notes.slice(-20),
      unavailable: login === "unknown" ? unavailable : null,
      poolStopSent,
      poolStopAttempts,
      poolResumePending,
      poolResumeAttempts,
    },
    notify,
    notice,
    note: recorded,
    refreshPools,
    poolNotify,
    poolNotice,
    poolKind,
  };
}

/** Mark a pool notice only after `paseo send` returns. A failure is retried on the next check. */
export function recordCursorPoolDelivery(state: CursorLoginState, kind: "stop" | "resume", sent: boolean): CursorLoginState {
  if (kind === "stop") {
    if (sent) return { ...state, poolStopSent: true, poolStopAttempts: 0 };
    return { ...state, poolStopSent: false, poolStopAttempts: Math.min(CURSOR_LOGIN_NOTIFY_LIMIT, state.poolStopAttempts + 1) };
  }
  if (sent) return { ...state, poolResumePending: false, poolResumeAttempts: 0 };
  return { ...state, poolResumePending: true, poolResumeAttempts: Math.min(CURSOR_LOGIN_NOTIFY_LIMIT, state.poolResumeAttempts + 1) };
}

export interface CursorLoginAlert {
  level: "red";
  kind: string;
  text: string;
  agentId: null;
}

/** Mark a send only after `paseo send` returns. A failure counts once and is retried next tick. */
export function recordCursorLoginDelivery(state: CursorLoginState, sent: boolean): CursorLoginState {
  if (sent) {
    const notifiedFor = state.login === "out" || state.login === "partial" ? state.login : state.notifiedFor;
    return { ...state, notified: true, notifiedFor, notifyAttempts: 0 };
  }
  const notifyAttempts = Math.min(CURSOR_LOGIN_NOTIFY_LIMIT, state.notifyAttempts + 1);
  return { ...state, notified: false, notifyAttempts };
}

export function cursorLoginNotifyFailureLine(at: number, attempts: number): string {
  const when = Number.isFinite(at) ? new Date(at).toISOString() : "";
  const count = Math.max(0, Math.min(CURSOR_LOGIN_NOTIFY_LIMIT, Math.floor(attempts)));
  return t("cursor.login.notifyFailed", { when, count, limit: CURSOR_LOGIN_NOTIFY_LIMIT });
}

export function alertsFromCursorLogin(state: CursorLoginState): CursorLoginAlert[] {
  if (!state.alerting) return [];
  return [{ level: "red", kind: cursorLoginAlertKind(), text: loginAlarmText(state.version), agentId: null }];
}

export interface CursorAccessPatch {
  state: "in" | "out" | "unknown";
  stateLabel: string;
  detail: string;
  account: string;
  accountLive: boolean;
}

/** Permissions page uses this status. Timeout and a missing command stay "unknown". */
export function cursorAccessPatch(state: CursorLoginState, account: string, accountLive: boolean): CursorAccessPatch {
  const caveat = cursorKeychainCaveat();
  const unknown = t("cursor.access.unknown");
  if (state.checkedAt === null) {
    return { state: "unknown", stateLabel: unknown, detail: t("cursor.access.notChecked", { caveat }), account, accountLive: false };
  }
  if (state.login === "in") {
    return { state: "in", stateLabel: t("cursor.access.in"), detail: caveat, account, accountLive };
  }
  if (state.login === "partial") {
    return {
      state: "unknown",
      stateLabel: cursorPartialLabel(),
      detail: t("cursor.access.partialDetail", { caveat }),
      account,
      accountLive,
    };
  }
  if (state.login === "out") {
    const out = t("cursor.access.out");
    return { state: "out", stateLabel: out, detail: caveat, account: out, accountLive: false };
  }
  const why = state.unavailable === "timeout"
    ? t("cursor.access.whyTimeout")
    : state.unavailable === "missing" ? t("cursor.access.whyMissing") : t("cursor.access.whyUnclear");
  return { state: "unknown", stateLabel: unknown, detail: t("cursor.access.unknownDetail", { why, caveat }), account, accountLive: false };
}
