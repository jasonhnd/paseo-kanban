/**
 * Keychain health probe: classify reads, decide when to alert, and plan
 * schedule reruns. This file never runs `security` and never sees a password.
 *
 * Cursor CLI (cursor-agent 2026.09.26) on macOS stores its login with domain
 * prefix `cursor`, so the access-token item's service is `cursor-access-token`.
 * Confirmed from the bundled credential store. The probe only checks that the
 * item exists.
 */
import { t, tAll } from "./i18n";
import { CURSOR_PROVIDER } from "./quota-adapters";

export const PROBE_INTERVAL_MS = 60_000;
export const AUTH_SCAN_INTERVAL_MS = 10 * 60_000;
export const RERUN_INTERVAL_MS = 5 * 60_000;
export const FAIL_STREAK = 2;
export const NOTIFY_COOLDOWN_MS = 30 * 60_000;
export const RERUN_WINDOW_MS = 30 * 60_000;
/** One automatic rerun per schedule. A new run id from that rerun must not start another. */
export const RERUN_COOLDOWN_MS = 6 * 60 * 60_000;
export const AUTH_WINDOW_MS = 24 * 60 * 60_000;
/** First look at a transcript reads this much from the end, not the whole file. */
export const AUTH_TAIL_BYTES = 256 * 1024;
export const AUTH_KEEP_MS = 48 * 60 * 60_000;
export const NOTICE_KEEP_MS = 24 * 60 * 60_000;
export const LOG_MAX_BYTES = 5 * 1024 * 1024;
/** Ops schedule names start with this, in any language (older names are Chinese). */
export function opsNamePrefixes(): string[] {
  return tAll("keychain.match.opsPrefix");
}

export const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";
export const CURSOR_KEYCHAIN_SERVICE = "cursor-access-token";

export function keychainAlertKind(): string {
  return t("keychain.alert.kind");
}
export function keychainAlertText(): string {
  return t("keychain.alert.text");
}
/** The Cursor row only says the keychain item exists. `cursor-agent status` is the login check. */
export function cursorKeychainCaveat(): string {
  return t("keychain.cursorCaveat");
}

export type SecurityErrorType =
  | "ok"
  | "user-canceled"
  | "could-not-be-found"
  | "interaction-not-allowed"
  | "timeout"
  | "other";

export interface ServiceProbe {
  service: string;
  exitCode: number | null;
  errorType: SecurityErrorType;
  ms: number;
  /** Access failure that can make a new session report it is not logged in. Item-missing is not this. */
  failed: boolean;
}

/** Argv for an existence check. One service name, no account, no secret flags. */
export function existenceArgs(service: string): string[] {
  return ["find-generic-password", "-s", service];
}

export function classifySecurity(input: {
  exitCode: number | null;
  timedOut: boolean;
  stderr: string;
}): { errorType: SecurityErrorType; failed: boolean } {
  if (input.timedOut) return { errorType: "timeout", failed: true };
  const err = input.stderr.toLowerCase();
  if (input.exitCode === 0) return { errorType: "ok", failed: false };
  if (err.includes("user canceled") || err.includes("user cancelled")) {
    return { errorType: "user-canceled", failed: true };
  }
  if (err.includes("interaction is not allowed") || err.includes("errsecinteractionnotallowed")) {
    return { errorType: "interaction-not-allowed", failed: true };
  }
  if (err.includes("could not be found") || err.includes("item not found") || err.includes("errsecitemnotfound")) {
    return { errorType: "could-not-be-found", failed: false };
  }
  return { errorType: "other", failed: true };
}

export function toServiceProbe(
  service: string,
  outcome: { exitCode: number | null; timedOut: boolean; stderr: string; ms: number },
): ServiceProbe {
  const classified = classifySecurity(outcome);
  return {
    service,
    exitCode: outcome.exitCode,
    errorType: classified.errorType,
    ms: outcome.ms,
    failed: classified.failed,
  };
}

export interface ProbeContext {
  keychainInfoExit: number | null;
  locked: "0" | "1" | "unknown";
  load: string;
  securitydStart: string;
  claudeProcs: number;
  cursorProcs: number;
}

export interface AuthEvent {
  at: number;
  session: string;
}

export interface FileCursor {
  inode: string;
  offset: number;
}

export type RemindReason = "foreign" | "still-out";

export interface ProbeNotice {
  at: number;
  name: string;
  runId: string;
  scheduleId: string;
  reason?: RemindReason;
}

export interface ProbeState {
  consecutiveFailures: number;
  alerting: boolean;
  lastNotifiedAt: number | null;
  lastProbeAt: number | null;
  probeOk: boolean;
  authEvents: AuthEvent[];
  authCursors: Record<string, FileCursor>;
  authCheckedAt: number | null;
  reranRunIds: string[];
  /** schedule id → when this probe last auto-reran it. */
  rerunAtBySchedule: Record<string, number>;
  rerunNotices: ProbeNotice[];
  remindNotices: ProbeNotice[];
  rerunCheckedAt: number | null;
  /** Last cursor-agent keychain read. Item-missing is not an access failure. */
  cursorError: SecurityErrorType | null;
}

export function emptyProbeState(): ProbeState {
  return {
    consecutiveFailures: 0,
    alerting: false,
    lastNotifiedAt: null,
    lastProbeAt: null,
    probeOk: false,
    authEvents: [],
    authCursors: {},
    authCheckedAt: null,
    reranRunIds: [],
    rerunAtBySchedule: {},
    rerunNotices: [],
    remindNotices: [],
    rerunCheckedAt: null,
    cursorError: null,
  };
}

function num(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function notices(value: unknown): ProbeNotice[] {
  if (!Array.isArray(value)) return [];
  const out: ProbeNotice[] = [];
  for (const row of value) {
    if (!row || typeof row !== "object") continue;
    const item = row as Record<string, unknown>;
    const name = str(item.name).replace(/[\r\n]/g, " ").slice(0, 80);
    const runId = str(item.runId).slice(0, 80);
    const scheduleId = str(item.scheduleId).slice(0, 80);
    const at = num(item.at, NaN);
    if (!name || !runId || !Number.isFinite(at)) continue;
    const reason = item.reason === "still-out" || item.reason === "foreign" ? item.reason : undefined;
    out.push({ at, name, runId, scheduleId, reason });
  }
  return out.slice(-50);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function authEventsFrom(value: unknown): AuthEvent[] {
  const events: AuthEvent[] = [];
  if (!Array.isArray(value)) return events;
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const ev = item as Record<string, unknown>;
    const at = num(ev.at, NaN);
    const session = str(ev.session).replace(/[\r\n]/g, "").slice(0, 240);
    if (!session || !Number.isFinite(at)) continue;
    events.push({ at, session });
  }
  return events;
}

function cursorsFrom(value: unknown): Record<string, FileCursor> {
  const cursors: Record<string, FileCursor> = {};
  if (!isPlainRecord(value)) return cursors;
  for (const [key, entry] of Object.entries(value)) {
    if (!entry || typeof entry !== "object") continue;
    const cur = entry as Record<string, unknown>;
    const inode = str(cur.inode).slice(0, 40);
    const offset = num(cur.offset, NaN);
    if (!inode || !Number.isFinite(offset) || offset < 0) continue;
    cursors[key.slice(0, 400)] = { inode, offset };
  }
  return cursors;
}

function rerunTimesFrom(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!isPlainRecord(value)) return out;
  for (const [key, entry] of Object.entries(value)) {
    const at = num(entry, NaN);
    if (!key || !Number.isFinite(at)) continue;
    out[key.slice(0, 80)] = at;
  }
  return out;
}

export function normalizeProbeState(raw: unknown): ProbeState {
  const base = emptyProbeState();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return base;
  const row = raw as Record<string, unknown>;
  const events = authEventsFrom(row.authEvents);
  const cursors = cursorsFrom(row.authCursors);
  const reran = Array.isArray(row.reranRunIds)
    ? row.reranRunIds.filter((id): id is string => typeof id === "string" && id.length > 0 && id.length < 80).slice(-200)
    : [];
  const rerunAtBySchedule = rerunTimesFrom(row.rerunAtBySchedule);
  const cursorError = row.cursorError;
  return {
    consecutiveFailures: Math.max(0, Math.floor(num(row.consecutiveFailures))),
    alerting: row.alerting === true,
    lastNotifiedAt: typeof row.lastNotifiedAt === "number" ? row.lastNotifiedAt : null,
    lastProbeAt: typeof row.lastProbeAt === "number" ? row.lastProbeAt : null,
    probeOk: row.probeOk === true,
    authEvents: events.slice(-500),
    authCursors: cursors,
    authCheckedAt: typeof row.authCheckedAt === "number" ? row.authCheckedAt : null,
    reranRunIds: reran,
    rerunAtBySchedule,
    rerunNotices: notices(row.rerunNotices),
    remindNotices: notices(row.remindNotices),
    rerunCheckedAt: typeof row.rerunCheckedAt === "number" ? row.rerunCheckedAt : null,
    cursorError: cursorError === "ok" || cursorError === "user-canceled" || cursorError === "could-not-be-found"
      || cursorError === "interaction-not-allowed" || cursorError === "timeout" || cursorError === "other"
      ? cursorError
      : null,
  };
}

export interface TickOutcome {
  state: ProbeState;
  notify: boolean;
  recovered: boolean;
}

/** A minute fails when any probed service had an access failure. Two in a row raises the alert. */
export function applyProbeTick(state: ProbeState, services: ServiceProbe[], now: number): TickOutcome {
  const failed = services.some((service) => service.failed);
  const cursor = services.find((service) => service.service === CURSOR_KEYCHAIN_SERVICE);
  const cursorError = cursor ? cursor.errorType : state.cursorError;
  const consecutiveFailures = failed ? state.consecutiveFailures + 1 : 0;
  const alerting = failed && (consecutiveFailures >= FAIL_STREAK || state.alerting);
  const recovered = state.alerting && !alerting;
  let lastNotifiedAt = state.lastNotifiedAt;
  let notify = false;
  if (alerting) {
    const cooled = lastNotifiedAt === null || now - lastNotifiedAt >= NOTIFY_COOLDOWN_MS;
    if (cooled) {
      notify = true;
      lastNotifiedAt = now;
    }
  } else if (recovered) {
    lastNotifiedAt = null;
  }
  return {
    state: {
      ...state,
      consecutiveFailures,
      alerting,
      lastNotifiedAt,
      lastProbeAt: now,
      probeOk: !failed,
      cursorError,
    },
    notify,
    recovered,
  };
}

export interface ProbeAlert {
  level: "red" | "yellow" | "info";
  kind: string;
  text: string;
  agentId: null;
}

export function sessionsInWindow(events: readonly AuthEvent[], now: number, windowMs = AUTH_WINDOW_MS): number {
  const sessions = new Set<string>();
  for (const event of events) {
    if (event.at <= now && now - event.at <= windowMs) sessions.add(event.session);
  }
  return sessions.size;
}

export function alertsFromProbe(state: ProbeState, now: number): ProbeAlert[] {
  const alerts: ProbeAlert[] = [];
  if (state.alerting) {
    alerts.push({ level: "red", kind: keychainAlertKind(), text: keychainAlertText(), agentId: null });
  }
  const count = sessionsInWindow(state.authEvents, now);
  if (count > 0) {
    alerts.push({
      level: "info",
      kind: t("keychain.alert.authKind"),
      text: t("keychain.alert.authText", { count }),
      agentId: null,
    });
  }
  for (const notice of state.rerunNotices) {
    if (now - notice.at > NOTICE_KEEP_MS) continue;
    alerts.push({ level: "info", kind: t("keychain.alert.scheduleKind"), text: t("keychain.alert.rerun", { name: notice.name }), agentId: null });
  }
  for (const notice of state.remindNotices) {
    if (now - notice.at > NOTICE_KEEP_MS) continue;
    const text = notice.reason === "still-out"
      ? t("keychain.alert.stillOut", { name: notice.name })
      : t("keychain.alert.emptyRun", { name: notice.name });
    alerts.push({ level: "info", kind: t("keychain.alert.scheduleKind"), text, agentId: null });
  }
  if (state.cursorError === "could-not-be-found") {
    alerts.push({
      level: "info",
      kind: t("keychain.alert.cursorUnlinked"),
      text: t("keychain.alert.cursorUnlinked"),
      agentId: null,
    });
  }
  return alerts;
}

export function serviceLabel(service: string): string {
  if (service === CLAUDE_KEYCHAIN_SERVICE) return "claude";
  if (service === CURSOR_KEYCHAIN_SERVICE) return CURSOR_PROVIDER;
  return "svc";
}

export function formatProbeLine(at: number, services: ServiceProbe[], ctx: ProbeContext): string {
  const parts = services.map((service) => {
    const code = service.exitCode === null ? "none" : String(service.exitCode);
    return `${serviceLabel(service.service)}=${code}/${service.errorType}/${Math.max(0, Math.round(service.ms))}ms`;
  });
  const keychain = ctx.keychainInfoExit === null ? "none" : String(ctx.keychainInfoExit);
  const load = sanitizeLoad(ctx.load);
  const securityd = sanitizeStamp(ctx.securitydStart);
  const locked = ctx.locked === "0" || ctx.locked === "1" ? ctx.locked : "unknown";
  return [
    new Date(at).toISOString(),
    parts.join(" "),
    `keychain=${keychain}`,
    `locked=${locked}`,
    `load=${load}`,
    `securityd=${securityd}`,
    `procs=claude:${Math.max(0, Math.floor(ctx.claudeProcs))},cursor-agent:${Math.max(0, Math.floor(ctx.cursorProcs))}`,
  ].join(" ");
}

export function formatRecoveryLine(at: number): string {
  return t("keychain.log.recovered", { at: new Date(at).toISOString() });
}

export function formatRerunLine(at: number, scheduleId: string, name: string): string {
  const safeName = name.replace(/[\r\n]/g, " ").slice(0, 80);
  const safeId = scheduleId.replace(/[^0-9a-zA-Z_-]/g, "").slice(0, 40);
  return t("keychain.log.rerun", { at: new Date(at).toISOString(), id: safeId, name: safeName });
}

export function formatRerunFailLine(at: number, scheduleId: string, exitCode: number | null): string {
  const safeId = scheduleId.replace(/[^0-9a-zA-Z_-]/g, "").slice(0, 40);
  const code = exitCode === null ? "none" : String(exitCode);
  return t("keychain.log.rerunFailed", { at: new Date(at).toISOString(), id: safeId, code });
}

export function sanitizeLoad(text: string): string {
  const nums = text.match(/\d+\.\d+|\d+/g);
  if (!nums || nums.length === 0) return "unknown";
  return nums.slice(0, 3).join(",");
}

export function sanitizeStamp(text: string): string {
  if (text === "unknown") return "unknown";
  const at = Date.parse(text);
  if (Number.isNaN(at)) return "unknown";
  return new Date(at).toISOString();
}

export function parseScreenLocked(text: string): "0" | "1" | "unknown" {
  const match = /CGSSessionScreenIsLocked"\s*=\s*(Yes|No|true|false|1|0)/i.exec(text);
  if (!match) return "unknown";
  const value = match[1].toLowerCase();
  return value === "yes" || value === "true" || value === "1" ? "1" : "0";
}

export function parseLoadavg(text: string): string {
  return sanitizeLoad(text);
}

/** Refuse a log line that still carries keychain attribute text. */
export function isSafeProbeLine(line: string): boolean {
  return !/<blob>|password=|0x00000007|acct"|svce"/i.test(line);
}

export function shouldRotate(size: number): boolean {
  return size >= LOG_MAX_BYTES;
}

const AUTH_ERROR_RE = /"error"\s*:\s*"authentication_failed"/;
const TS_RE = /"timestamp"\s*:\s*"([^"]+)"/;

/** Timestamp only. Other fields on the line are ignored. */
export function extractAuthFailure(line: string): number | null {
  if (!AUTH_ERROR_RE.test(line)) return null;
  const match = TS_RE.exec(line);
  if (!match) return null;
  const at = Date.parse(match[1]);
  return Number.isNaN(at) ? null : at;
}

export function consumeAuthBuffer(buf: Buffer): { times: number[]; consumedBytes: number } {
  const nl = buf.lastIndexOf(0x0a);
  if (nl < 0) return { times: [], consumedBytes: 0 };
  const text = buf.subarray(0, nl + 1).toString("utf8");
  const times: number[] = [];
  for (const line of text.split("\n")) {
    const at = extractAuthFailure(line);
    if (at !== null) times.push(at);
  }
  return { times, consumedBytes: nl + 1 };
}

export function mergeAuthEvents(existing: readonly AuthEvent[], added: readonly AuthEvent[], now: number): AuthEvent[] {
  const seen = new Set<string>();
  const next: AuthEvent[] = [];
  for (const event of [...existing, ...added]) {
    if (event.at > now + 60_000) continue;
    if (now - event.at > AUTH_KEEP_MS) continue;
    const key = `${event.session}|${event.at}`;
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(event);
  }
  next.sort((a, b) => a.at - b.at);
  return next.slice(-500);
}

export function outputStartsNotLoggedIn(output: string): boolean {
  return output.startsWith("Not logged in");
}

export interface ScheduleCandidate {
  scheduleId: string;
  name: string;
  scheduleStatus: string;
  runId: string;
  startedAt: number;
  output: string;
}

export interface RerunPlan {
  rerun: ScheduleCandidate[];
  remind: ScheduleCandidate[];
  /** Ops task already auto-reran inside the cooldown, and the newest run is still not logged in. */
  stillOut: ScheduleCandidate[];
}

export function planScheduleReruns(input: {
  now: number;
  probeOk: boolean;
  alreadyRerun: ReadonlySet<string>;
  alreadyReminded: ReadonlySet<string>;
  lastRerunAt: Readonly<Record<string, number>>;
  schedules: readonly ScheduleCandidate[];
}): RerunPlan {
  const rerun: ScheduleCandidate[] = [];
  const opsPrefixes = opsNamePrefixes();
  const remind: ScheduleCandidate[] = [];
  const stillOut: ScheduleCandidate[] = [];
  for (const row of input.schedules) {
    if (row.scheduleStatus !== "active") continue;
    if (!outputStartsNotLoggedIn(row.output)) continue;
    if (!(row.startedAt <= input.now && input.now - row.startedAt <= RERUN_WINDOW_MS)) continue;
    const ops = opsPrefixes.some((prefix) => row.name.startsWith(prefix));
    if (!ops) {
      if (!input.alreadyReminded.has(row.runId)) remind.push(row);
      continue;
    }
    const last = input.lastRerunAt[row.scheduleId];
    const cooling = typeof last === "number" && input.now - last < RERUN_COOLDOWN_MS;
    if (cooling || input.alreadyRerun.has(row.runId)) {
      if (cooling && !input.alreadyRerun.has(row.runId) && !input.alreadyReminded.has(row.runId)) stillOut.push(row);
      continue;
    }
    if (!input.probeOk) continue;
    rerun.push(row);
  }
  return { rerun, remind, stillOut };
}

/** Resume a known file. A first look at a large transcript starts at the tail. */
export function firstAuthOffset(size: number, previous: number | null, tail = AUTH_TAIL_BYTES): number {
  if (previous !== null && previous >= 0 && previous <= size) return previous;
  if (size > tail) return size - tail;
  return 0;
}

/** Drop cursors for files that are gone or have not changed within the keep window. */
export function keepAuthCursors(
  cursors: Readonly<Record<string, FileCursor>>,
  present: ReadonlyMap<string, number>,
  now: number,
): Record<string, FileCursor> {
  const next: Record<string, FileCursor> = {};
  for (const [path, cursor] of Object.entries(cursors)) {
    const mtime = present.get(path);
    if (mtime === undefined || now - mtime > AUTH_KEEP_MS) continue;
    next[path] = cursor;
  }
  return next;
}

export function noteRerun(state: ProbeState, row: ScheduleCandidate, now: number): ProbeState {
  const notice: ProbeNotice = { at: now, name: row.name.slice(0, 80), runId: row.runId, scheduleId: row.scheduleId };
  return {
    ...state,
    reranRunIds: [...state.reranRunIds, row.runId].slice(-200),
    rerunAtBySchedule: { ...state.rerunAtBySchedule, [row.scheduleId]: now },
    rerunNotices: [...state.rerunNotices, notice].slice(-50),
  };
}

export function noteRemind(state: ProbeState, row: ScheduleCandidate, now: number, reason: RemindReason = "foreign"): ProbeState {
  const notice: ProbeNotice = {
    at: now,
    name: row.name.slice(0, 80),
    runId: row.runId,
    scheduleId: row.scheduleId,
    reason,
  };
  return {
    ...state,
    remindNotices: [...state.remindNotices, notice].slice(-50),
  };
}
