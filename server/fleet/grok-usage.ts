import { platformCapabilities } from "./platform";
/// <reference types="node" />
// SuperGrok weekly quota when Paseo listUsage returns grok with no windows.
// There is no non-interactive grok command for the weekly limit (`grok usage` is one session's tokens).
// The only CLI surface is the TUI command `/usage show`. This reader types that and nothing else.
// It does not open a browser, does not read ~/.grok, and does not call grok.com.
import { appendFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  captureOutput,
  createScreenSession,
  describeError,
  finishScreenSession,
  loginAfterRead,
  NEXT_FRAME,
  pollFrames,
  agentLaunchEnv,
  sanitizedScreenFailure,
  sleep as defaultSleep,
  stripAnsi,
  type FrameVerdict,
} from "./screen-read";
import { readRunsSince } from "./kanban";
import { profilePools, runsInSpan } from "./quota-history";
import { readJson, STATE_DIR, writeJson } from "./util";
import { GROK_CLI, isWeeklyWindow, poolOfAdapter, type QuotaWindowIdentity } from "../../shared/fleet/quota-adapters";
import { t, tAll } from "../../shared/fleet/i18n";
import { readPoolCatalog } from "./adapters/plans";
import { sampleQuota } from "./quota-sampling";
import { QUOTA_SAMPLE_MS } from "./quota-timing";
import { validQuotaTime } from "../../shared/fleet/quota-time";

export const GROK_USAGE_FILE = join(STATE_DIR, "grok-usage.json");
/** At most one CLI read per hour, including failed attempts. */
export const GROK_CLI_EVERY_MS = QUOTA_SAMPLE_MS;
/** A successful CLI reading may be carried through failures for at most two hours. */
export const GROK_CLI_MAX_AGE_MS = 2 * 60 * 60_000;
/** Homepage yellow starts once a live percent has been missing this long. */
export const SUPERGROK_UNREAD_ALARM_MS = 60 * 60_000;
/** Paseo's percent unchanged this long, while SuperGrok cards ran, means Paseo's reading is stuck. */
export const PROVIDER_STUCK_MS = 12 * 60 * 60_000;
/** CLI and Paseo differing by at least this many points is logged (not committed). */
export const CLI_PROVIDER_DIFF_PTS = 3;
export const GROK_DIFF_LOG = join(STATE_DIR, "grok-diff.log");
export const GROK_SCREEN_FAIL_LOG = join(STATE_DIR, "grok-screen-fail.log");
export const GROK_SCREEN_TIMEOUT_MS = 60_000;
/** The only keystrokes this reader ever sends. */
export const GROK_USAGE_KEYS = "/usage show\r";

export { finishScreenSession };

const SESSION = "afc-grok-usage";
const GROK_BIN = join(homedir(), ".grok", "bin", "grok");
const WEEK_MS = 7 * 24 * 60 * 60_000;

export function msgModelsOut(): string {
  return t("grok.usage.modelsOut");
}
export function msgModelsUnknown(): string {
  return t("grok.usage.modelsUnknown");
}
export function msgLoginScreen(): string {
  return t("screen.loginScreen");
}
export function msgNoPrompt(): string {
  return t("grok.usage.noPrompt");
}
export function msgNoPct(): string {
  return t("grok.usage.noPct");
}
export function msgLoginLost(): string {
  return t("grok.usage.loginLost");
}

export type GrokLogin = "in" | "out" | "unknown";

export interface GrokWindowInput extends QuotaWindowIdentity {
  label: string;
  usedPct: number | null;
  resetsAt?: string | null;
  sampledAt?: string | null;
}

export interface GrokCliReading {
  ok: boolean;
  usedPct: number | null;
  resetsAt: string | null;
  readAt: string | null;
  error: string | null;
  loggedOut: boolean;
  loginLost: boolean;
  homeAlarm: string | null;
}

export interface GrokStored {
  lastKnown?: { usedPct: number; readAt: string; resetsAt: string | null };
  readAt: string | null;
  ok: boolean;
  usedPct: number | null;
  resetsAt: string | null;
  error: string | null;
  loggedOut: boolean;
  loginLost: boolean;
  homeAlarm: string | null;
  lastAttemptAt: string | null;
  unreadSince: string | null;
  /** Paseo's last seen percent and when it first showed that exact value. */
  providerSeen: ProviderSeen | null;
  /** Last "cli/provider" pair written to the diff log, so the same pair is logged once. */
  diffLogged: string | null;
}

export interface ProviderSeen {
  usedPct: number;
  since: string;
}

export interface SuperGrokChoice {
  readError?: string | null;
  safetyError?: string | null;
  knownQuotaStop?: string | null;
  usedPct: number | null;
  resetsAt: string | null;
  source: "provider" | "screen" | "manual" | "none";
  manualAt: string | null;
  readAt: string | null;
  unreadSince: string | null;
  /** Yellow homepage sentence. Null when a live percent is in hand, or the gap is under an hour. */
  alarm: string | null;
  loginLost: boolean;
  loginAlarm: string | null;
  /** Paseo's own percent, shown beside the CLI number when they differ. */
  providerPct: number | null;
  providerStuck: boolean;
  /** Quota-page source sentence, e.g. "CLI 13% (22:12) · Paseo 12%". Null keeps the default text. */
  sourceText: string | null;
  /** One log line when CLI and Paseo are at least 3 points apart. */
  diffLine: string | null;
}

/** Missing `cliRead` stays on. Only a literal false turns the grok screen off. */
export function grokCliReadEnabled(plan: { cliRead?: unknown } | null | undefined): boolean {
  return plan?.cliRead !== false;
}

/** True when the last CLI attempt is missing or at least an hour old. */
export function grokCliDue(lastAttemptAt: number | null, now: number): boolean {
  if (lastAttemptAt === null || !Number.isFinite(lastAttemptAt)) return true;
  return now - lastAttemptAt >= GROK_CLI_EVERY_MS;
}

/**
 * `grok models` prints "You are logged in with grok.com." when the CLI session is usable.
 * "Not logged in" is checked first because that phrase also contains "logged in".
 */
export function loginFromGrokModels(text: string): GrokLogin {
  if (/not logged in|not authenticated|you are not authenticated/i.test(text)) return "out";
  if (/you are logged in|logged in with grok\.com/i.test(text)) return "in";
  return "unknown";
}

/**
 * Login splash. "You are logged in" does not match.
 * grok 1.0.44's data-sharing line says "Opt in"; that is not a login prompt.
 */
const LOGIN_WORD_RE = /sign(?:ing)?\s+in|\blog[\s-]?in\b|\blogin\b|not authenticated|authentication required|qr code/i;

export function frameSaysGrokLogin(raw: string): boolean {
  return LOGIN_WORD_RE.test(stripAnsi(raw));
}

/**
 * Composer is ready for `/usage show`.
 * grok 1.0.44 draws the box as a `│ ❯` row plus `always-approve` / `Grok Build`.
 * The usage panel paints over that same row (`Esc close`, `Tab switch`), so the row alone is not ready.
 * Older guessed phrases stay, so a screen that really says "Awaiting your input" still counts.
 */
function frameSaysGrokReady(text: string): boolean {
  if (/awaiting your input|type a message/i.test(text)) return true;
  if (/weekly\s+limit|\besc close\b|\btab switch\b/i.test(text)) return false;
  const prompt = /│\s*❯/.test(text);
  const chrome = /always-approve|enter:\s*send|grok build\s+\d|quit\s+ctrl\+q/i.test(text);
  return prompt && chrome;
}

/** What the captured screen is asking. A login word wins, and it is never answered. */
export function interpretGrokScreen(raw: string): "login" | "usage" | "ready" | "wait" {
  if (frameSaysGrokLogin(raw)) return "login";
  if (parseGrokUsageScreen(raw)) return "usage";
  if (frameSaysGrokReady(stripAnsi(raw))) return "ready";
  return "wait";
}

function parseReset(text: string): string | null {
  const m = /next reset:\s*([^\n]+)/i.exec(text);
  if (!m) return null;
  const raw = m[1].trim().replace(/\s+/g, " ");
  const iso = raw.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/);
  if (iso) {
    const t = Date.parse(iso[0]);
    return Number.isNaN(t) ? null : new Date(t).toISOString();
  }
  if (!/\b20\d{2}\b/.test(raw)) return null;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

const MONTH_INDEX: Record<string, number> = {
  jan: 0, january: 0,
  feb: 1, february: 1,
  mar: 2, march: 2,
  apr: 3, april: 3,
  may: 4,
  jun: 5, june: 5,
  jul: 6, july: 6,
  aug: 7, august: 7,
  sep: 8, sept: 8, september: 8,
  oct: 9, october: 9,
  nov: 10, november: 10,
  dec: 11, december: 11,
};

/** Asia/Tokyo has no daylight saving; wall time is a fixed +9 hours. */
const TOKYO_OFFSET_MS = 9 * 60 * 60_000;

/** Soonest Asia/Tokyo wall-clock time strictly after `now`. A missing year rolls forward. */
function nextTokyoWall(month: number, day: number, hour: number, minute: number, now: number): string | null {
  if (day < 1 || day > 31 || hour > 23 || minute > 59) return null;
  const yearNow = new Date(now + TOKYO_OFFSET_MS).getUTCFullYear();
  const atYear = (year: number): number | null => {
    const wall = Date.UTC(year, month, day, hour, minute);
    const back = new Date(wall);
    if (back.getUTCMonth() !== month || back.getUTCDate() !== day) return null;
    return wall - TOKYO_OFFSET_MS;
  };
  const thisYear = atYear(yearNow);
  if (thisYear === null) return null;
  const at = thisYear > now ? thisYear : atYear(yearNow + 1);
  return at === null ? null : new Date(at).toISOString();
}

/**
 * grok 1.0.44 prints `Resets: October 7, 08:18` with no year, in the machine's Tokyo clock.
 * `Next reset:` stays on parseReset so a bare "Oct 6" is still not a timestamp.
 */
function parseResetsLine(text: string, now = Date.now()): string | null {
  const m = /\bResets:\s*([A-Za-z]+)\s+(\d{1,2}),\s*(\d{1,2}):(\d{2})\b/.exec(text);
  if (!m) return null;
  const month = MONTH_INDEX[m[1].toLowerCase()];
  if (month === undefined) return null;
  return nextTokyoWall(month, Number(m[2]), Number(m[3]), Number(m[4]), now);
}

/**
 * Weekly used percent from the `/usage show` screen.
 * The monthly block and "credits left" are not the weekly number.
 * A bare "Next reset: Oct 6" is not turned into a timestamp.
 * `Resets: October 7, 08:18` (no year) is the next such clock time in Asia/Tokyo.
 */
export function parseGrokUsageScreen(raw: string): { usedPct: number; resetsAt: string | null } | null {
  const text = stripAnsi(raw);
  if (/hit your weekly limit/i.test(text)) return { usedPct: 100, resetsAt: parseResetsLine(text) ?? parseReset(text) };
  const start = text.search(/weekly\s+limit/i);
  if (start < 0) return null;
  const rest = text.slice(start);
  const endRel = rest.slice("weekly limit".length).search(/\n\s*(monthly\s+limit|credits\b|auto\s+top-?up|pay-as-you-go)\b/i);
  const section = endRel < 0 ? rest.slice(0, 500) : rest.slice(0, "weekly limit".length + endRel);
  const pct = /(\d+(?:\.\d+)?)\s*%/.exec(section);
  if (!pct || pct.index === undefined) return null;
  let used = Number(pct[1]);
  const around = section.slice(Math.max(0, pct.index - 24), pct.index + pct[0].length + 24);
  if (/\bleft\b|\bremaining\b/i.test(around) && !/\bused\b/i.test(around)) used = 100 - used;
  if (!Number.isFinite(used) || used < 0 || used > 100) return null;
  return { usedPct: used, resetsAt: parseResetsLine(section) ?? parseReset(section) };
}

export function providerWeekly(windows: GrokWindowInput[]): { usedPct: number; resetsAt: string | null; sampledAt: string | null } | null {
  const labeled = windows.find((w) => isWeeklyWindow(w) && typeof w.usedPct === "number" && Number.isFinite(w.usedPct));
  const any = labeled ?? windows.find((w) => !tAll("screen.window.quotaHidden").includes(w.label) && typeof w.usedPct === "number" && Number.isFinite(w.usedPct));
  if (!any || any.usedPct === null) return null;
  return { usedPct: any.usedPct, resetsAt: any.resetsAt ?? null, sampledAt: any.sampledAt ?? null };
}

/**
 * A hand copy from before this week's reset is last week's number and is ignored.
 * With no reset time, the copy expires 7 days after `at`, so last week's 85% cannot block the new week forever.
 */
export function manualApplies(
  manual: { usedPct: number; at: string } | null | undefined,
  resetsAt: string | null,
  now: number,
): manual is { usedPct: number; at: string } {
  if (!manual || typeof manual.usedPct !== "number" || !Number.isFinite(manual.usedPct)) return false;
  const at = Date.parse(manual.at);
  if (Number.isNaN(at) || at > now + 5 * 60_000) return false;
  if (!resetsAt) return now - at <= WEEK_MS;
  const end = Date.parse(resetsAt);
  if (Number.isNaN(end)) return now - at <= WEEK_MS;
  return at >= end - WEEK_MS;
}

/**
 * Hours since the live percent disappeared.
 * A stored stamp wins. Otherwise the start of the trailing null streak in quota history.
 * A brand-new miss starts at `now`, so the yellow line waits an hour.
 */
export function resolveUnreadSince(
  now: number,
  stored: string | null,
  history: Array<{ at: string; usedPct: number | null }>,
): string {
  const storedAt = stored ? Date.parse(stored) : Number.NaN;
  if (!Number.isNaN(storedAt) && storedAt <= now) return new Date(storedAt).toISOString();
  const sorted = history.filter((row) => !Number.isNaN(Date.parse(row.at))).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  let start: string | null = null;
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (typeof sorted[i].usedPct === "number") break;
    start = sorted[i].at;
  }
  return start ?? new Date(now).toISOString();
}

/** Paseo's percent with the time it first showed. A new value restarts the clock. */
export function nextProviderSeen(seen: ProviderSeen | null, providerPct: number | null, now: number): ProviderSeen | null {
  if (providerPct === null) return null;
  if (seen && seen.usedPct === providerPct && !Number.isNaN(Date.parse(seen.since))) return seen;
  return { usedPct: providerPct, since: new Date(now).toISOString() };
}

/** Trailing run of equal history samples ending at `providerPct`, for a first look with no stored stamp. */
export function seenFromHistory(history: Array<{ at: string; usedPct: number | null }>, providerPct: number | null): ProviderSeen | null {
  if (providerPct === null) return null;
  const sorted = history.filter((row) => !Number.isNaN(Date.parse(row.at))).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  let since: string | null = null;
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (sorted[i].usedPct !== providerPct) break;
    since = sorted[i].at;
  }
  return since ? { usedPct: providerPct, since } : null;
}

/** Stuck: same percent for 12 hours and a SuperGrok card started in that time. */
export function providerIsStuck(seen: ProviderSeen | null, now: number, ranSince: (sinceMs: number) => boolean): boolean {
  if (!seen) return false;
  const since = Date.parse(seen.since);
  if (Number.isNaN(since) || now - since < PROVIDER_STUCK_MS) return false;
  return ranSince(since);
}

export function providerStuckAlarm(now: number, seen: ProviderSeen | null): string {
  const hours = seen ? Math.max(12, Math.floor((now - Date.parse(seen.since)) / 3_600_000)) : 12;
  return t("grok.usage.stuckAlarm", { hours });
}

const TOKYO_MS = 9 * 60 * 60_000;

function tokyoHm(iso: string | null): string {
  if (!iso || Number.isNaN(Date.parse(iso))) return "";
  const t = new Date(Date.parse(iso) + TOKYO_MS);
  return `${String(t.getUTCHours()).padStart(2, "0")}:${String(t.getUTCMinutes()).padStart(2, "0")}`;
}

function pctWord(n: number): string {
  return `${Math.round(n)}%`;
}

function sourceSentence(cli: GrokCliReading | null, providerPct: number | null, stuck: boolean): string | null {
  if (cli && cli.usedPct !== null) {
    const when = tokyoHm(cli.readAt);
    const pct = pctWord(cli.usedPct);
    const head = when ? t("grok.source.cliAt", { pct, when }) : t("grok.source.cli", { pct });
    if (providerPct === null || Math.round(providerPct) === Math.round(cli.usedPct)) return head;
    return stuck ? t("grok.source.withPaseoStuck", { head, pct: pctWord(providerPct) }) : `${head} · Paseo ${pctWord(providerPct)}`;
  }
  if (stuck && providerPct !== null) return t("grok.source.paseoStuckUnused", { pct: pctWord(providerPct) });
  return null;
}

export function supergrokUnreadAlarm(now: number, unreadSince: string | null, live: boolean): string | null {
  if (live || !unreadSince) return null;
  const at = Date.parse(unreadSince);
  if (Number.isNaN(at) || now - at < SUPERGROK_UNREAD_ALARM_MS) return null;
  const hours = Math.max(1, Math.floor((now - at) / 3_600_000));
  return t("grok.usage.unreadAlarm", { hours });
}

function cliCurrent(reading: GrokCliReading | null, now: number): boolean {
  if (!reading?.ok || reading.usedPct === null || !Number.isFinite(reading.usedPct)) return false;
  const at = reading.readAt ? Date.parse(reading.readAt) : Number.NaN;
  if (!Number.isFinite(at) || at > now || now - at > GROK_CLI_MAX_AGE_MS) return false;
  if (reading.resetsAt) {
    const end = Date.parse(reading.resetsAt);
    if (!Number.isNaN(end) && end <= now) return false;
  }
  return true;
}

export function chooseSuperGrok(input: {
  now: number;
  providerWindows: GrokWindowInput[];
  cli: GrokCliReading | null;
  cliEnabled: boolean;
  manual: { usedPct: number; at: string } | null;
  unreadSince: string | null;
  history: Array<{ at: string; usedPct: number | null }>;
  loginLost?: boolean;
  loginAlarm?: string | null;
  providerSeen?: ProviderSeen | null;
  providerStuck?: boolean;
  lastKnown?: GrokStored["lastKnown"];
}): SuperGrokChoice {
  const seenProvider = providerWeekly(input.providerWindows);
  const stuck = input.providerStuck === true && seenProvider !== null;
  const provider = stuck ? null : seenProvider;
  const cli = input.cliEnabled && cliCurrent(input.cli, input.now) ? input.cli : null;
  const live = Boolean(provider || cli);
  const resetHint = provider?.resetsAt ?? cli?.resetsAt ?? seenProvider?.resetsAt ?? null;
  const manual = !live && manualApplies(input.manual, resetHint, input.now) ? input.manual : null;
  const unreadSince = live ? null : resolveUnreadSince(input.now, input.unreadSince, input.history);
  const loginLost = input.loginLost === true;
  const alarm = !cli && stuck ? providerStuckAlarm(input.now, input.providerSeen ?? null) : supergrokUnreadAlarm(input.now, unreadSince, live);
  const diff = cli && cli.usedPct !== null && seenProvider ? Math.abs(cli.usedPct - seenProvider.usedPct) : 0;
  const knownAt = validQuotaTime(input.lastKnown?.readAt, input.now);
  const providerAt = validQuotaTime(provider?.sampledAt, input.now);
  return {
    readError: input.cliEnabled ? input.cli?.error ?? null : null,
    safetyError: input.cliEnabled && (input.cli?.loggedOut || input.cli?.loginLost) ? input.cli.homeAlarm ?? msgLoginLost() : null,
    knownQuotaStop: input.cliEnabled && input.lastKnown && knownAt && input.lastKnown.usedPct >= 97 && !cli
      && (!input.lastKnown.resetsAt || !Number.isFinite(Date.parse(input.lastKnown.resetsAt)) || Date.parse(input.lastKnown.resetsAt) > input.now)
      && (!providerAt || Date.parse(providerAt) < Date.parse(knownAt))
      ? t("pools.hard.weekSpent") : null,
    usedPct: cli?.usedPct ?? provider?.usedPct ?? manual?.usedPct ?? null,
    resetsAt: cli?.resetsAt ?? provider?.resetsAt ?? null,
    source: cli ? "screen" : provider ? "provider" : manual ? "manual" : "none",
    manualAt: manual?.at ?? null,
    readAt: cli?.readAt ?? provider?.sampledAt ?? null,
    unreadSince,
    alarm: withCopyTime(alarm, manual),
    loginLost,
    loginAlarm: loginLost ? (input.loginAlarm ?? msgLoginLost()) : null,
    providerPct: seenProvider?.usedPct ?? null,
    providerStuck: stuck,
    sourceText: sourceSentence(cli, seenProvider?.usedPct ?? null, stuck),
    diffLine: cli && seenProvider && diff >= CLI_PROVIDER_DIFF_PTS
      ? t(stuck ? "grok.diff.lineStuck" : "grok.diff.line", {
        at: new Date(input.now).toISOString(),
        cli: pctWord(cli.usedPct as number),
        paseo: pctWord(seenProvider.usedPct),
        diff: Math.round(diff),
      })
      : null,
  };
}

function withCopyTime(alarm: string | null, manual: { at: string } | null): string | null {
  if (!alarm || !manual) return alarm;
  return t("grok.usage.copiedAt", { alarm, at: manual.at });
}

function emptyReading(readAt: string, error: string, loggedOut: boolean): GrokCliReading {
  return {
    ok: false,
    usedPct: null,
    resetsAt: null,
    readAt,
    error,
    loggedOut,
    loginLost: false,
    homeAlarm: null,
  };
}

export interface GrokScreenIo {
  login(): Promise<GrokLogin>;
  open(): Promise<void>;
  readFrame(): Promise<string>;
  stuff(keys: string): Promise<void>;
  /** Quit the session. Must not type into the TUI. */
  close(): Promise<void>;
  /** Save only a sanitized failed frame, never raw screen output. */
  fail?(frame: string, error: string): Promise<void>;
}

/** Last failed frame, bounded to 40 lines; credential- and identity-bearing lines are dropped. See `sanitizedScreenFailure`. */
export const sanitizedGrokFailure = sanitizedScreenFailure;

function frameReading(readAt: string, parsed: { usedPct: number; resetsAt: string | null }): GrokCliReading {
  return {
    ok: true,
    usedPct: parsed.usedPct,
    resetsAt: parsed.resetsAt,
    readAt,
    error: null,
    loggedOut: false,
    loginLost: false,
    homeAlarm: null,
  };
}

/**
 * One `/usage show` read. The screen is never opened unless `grok models` says logged in.
 * The only keystrokes are `/usage show` and the return that submits it.
 * A login word ends the session before the next key. Close does not type.
 */
export async function readGrokScreenVia(
  io: GrokScreenIo,
  timeoutMs = GROK_SCREEN_TIMEOUT_MS,
  sleep: (ms: number) => Promise<void> = defaultSleep,
): Promise<GrokCliReading> {
  const readAt = new Date().toISOString();
  const before = await io.login();
  if (before !== "in") return emptyReading(readAt, before === "out" ? msgModelsOut() : msgModelsUnknown(), before === "out");

  let opened = false;
  let sent = false;
  let reading: GrokCliReading | null = null;
  let error: string | null = null;
  let lastFrame = "";
  const onFrame = async (frame: string): Promise<FrameVerdict<GrokCliReading>> => {
    lastFrame = frame;
    if (frameSaysGrokLogin(frame)) return { kind: "fail", error: msgLoginScreen() };
    const parsed = parseGrokUsageScreen(frame);
    if (parsed) return { kind: "done", value: frameReading(readAt, parsed) };
    if (!sent && interpretGrokScreen(frame) === "ready") {
      sent = true;
      await io.stuff(GROK_USAGE_KEYS);
    }
    return NEXT_FRAME;
  };
  try {
    await io.open();
    opened = true;
    const polled = await pollFrames({ readFrame: () => io.readFrame(), timeoutMs, sleep, onFrame });
    reading = polled.value;
    error = polled.error;
    if (!reading && !error) error = sent ? msgNoPct() : msgNoPrompt();
  } catch (e) {
    error = describeError(e);
  } finally {
    if (!reading && opened) await io.fail?.(lastFrame, error ?? msgNoPct()).catch(() => {});
    if (opened) await io.close().catch(() => {});
  }

  const failed = reading ?? emptyReading(readAt, error ?? msgNoPct(), false);
  const after = await loginAfterRead(() => io.login(), "unknown");
  if (after !== "out") return failed;
  return { ...failed, loggedOut: true, loginLost: true, homeAlarm: msgLoginLost() };
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export async function readGrokUsageFile(): Promise<GrokStored | null> {
  const raw = await readJson<Partial<GrokStored> | null>(GROK_USAGE_FILE, null);
  if (!raw || typeof raw !== "object") return null;
  return {
    ...(raw.lastKnown && typeof raw.lastKnown.usedPct === "number" && Number.isFinite(raw.lastKnown.usedPct) && typeof raw.lastKnown.readAt === "string"
      ? { lastKnown: { usedPct: raw.lastKnown.usedPct, readAt: raw.lastKnown.readAt, resetsAt: typeof raw.lastKnown.resetsAt === "string" ? raw.lastKnown.resetsAt : null } } : {}),
    readAt: typeof raw.readAt === "string" ? raw.readAt : null,
    ok: raw.ok === true,
    usedPct: num(raw.usedPct),
    resetsAt: typeof raw.resetsAt === "string" ? raw.resetsAt : null,
    error: typeof raw.error === "string" ? raw.error : null,
    loggedOut: raw.loggedOut === true,
    loginLost: raw.loginLost === true,
    homeAlarm: typeof raw.homeAlarm === "string" ? raw.homeAlarm : null,
    lastAttemptAt: typeof raw.lastAttemptAt === "string" ? raw.lastAttemptAt : null,
    unreadSince: typeof raw.unreadSince === "string" ? raw.unreadSince : null,
    providerSeen: seenOf(raw.providerSeen),
    diffLogged: typeof raw.diffLogged === "string" ? raw.diffLogged : null,
  };
}

function seenOf(v: unknown): ProviderSeen | null {
  const r = v as Partial<ProviderSeen> | null | undefined;
  if (!r || typeof r !== "object") return null;
  return num(r.usedPct) !== null && typeof r.since === "string" ? { usedPct: r.usedPct as number, since: r.since } : null;
}

function storedReading(stored: GrokStored | null): GrokCliReading | null {
  if (!stored) return null;
  return {
    ok: stored.ok,
    usedPct: stored.usedPct,
    resetsAt: stored.resetsAt,
    readAt: stored.readAt,
    error: stored.error,
    loggedOut: stored.loggedOut,
    loginLost: stored.loginLost,
    homeAlarm: stored.homeAlarm,
  };
}

/** quota-history readings of the grok-cli pool (plans.json names it). */
async function readSuperGrokHistory(): Promise<Array<{ at: string; usedPct: number | null }>> {
  const [file, catalog] = await Promise.all([
    readJson<{ samples?: Array<{ at?: unknown; pools?: Record<string, { usedPct?: unknown } | undefined> }> }>(
      join(STATE_DIR, "quota-history.json"),
      { samples: [] },
    ),
    readPoolCatalog(),
  ]);
  const pool = poolOfAdapter(catalog, GROK_CLI)?.id;
  const out: Array<{ at: string; usedPct: number | null }> = [];
  for (const sample of file.samples ?? []) {
    if (typeof sample.at !== "string") continue;
    const used = pool ? sample.pools?.[pool]?.usedPct : undefined;
    out.push({ at: sample.at, usedPct: typeof used === "number" && Number.isFinite(used) ? used : null });
  }
  return out;
}

export interface SettleHooks {
  statePath?: string;
  previous?: () => Promise<GrokStored | null>;
  history?: () => Promise<Array<{ at: string; usedPct: number | null }>>;
  capture?: () => Promise<GrokCliReading>;
  persist?: (stored: GrokStored) => Promise<void>;
  /** True when a SuperGrok-pool card started at or after this time. */
  ranSince?: (sinceMs: number) => Promise<boolean>;
  log?: (line: string) => Promise<void>;
  now?: number;
}

/** True when a card on the grok-cli pool (plans.json names it) started since `sinceMs`. */
async function superGrokRanSince(sinceMs: number): Promise<boolean> {
  const runs = readRunsSince(new Date(sinceMs).toISOString());
  if (runs.length === 0) return false;
  const pool = poolOfAdapter(await readPoolCatalog(), GROK_CLI)?.id;
  if (!pool) return false;
  return runsInSpan(runs, await profilePools(), pool, sinceMs, Date.now()) > 0;
}

function storedFrom(reading: GrokCliReading, lastAttemptAt: string | null, unreadSince: string | null, providerSeen: ProviderSeen | null, diffLogged: string | null, lastKnown?: GrokStored["lastKnown"]): GrokStored {
  return {
    ...(lastKnown ? { lastKnown } : {}),
    readAt: reading.readAt,
    ok: reading.ok,
    usedPct: reading.usedPct,
    resetsAt: reading.resetsAt,
    error: reading.error,
    loggedOut: reading.loggedOut,
    loginLost: reading.loginLost,
    homeAlarm: reading.homeAlarm,
    lastAttemptAt,
    unreadSince,
    providerSeen,
    diffLogged,
  };
}

/**
 * The grok screen is the truth: a CLI reading at most once an hour, even when Paseo has a number.
 * Paseo's percent is the fallback when no current CLI reading exists, unless it looks stuck.
 * `capture` must be true to open the screen; the quota page leaves it false and only reads the file.
 * A failed capture keeps the previous reading while `cliCurrent` still accepts it, and only refreshes lastAttemptAt and error.
 * `cliRead: false` never opens the screen and does not keep an old screen percent.
 */
export async function settleSuperGrokChoice(input: {
  providerWindows: GrokWindowInput[];
  manual: { usedPct: number; at: string } | null;
  cliRead?: boolean;
  capture?: boolean;
  hooks?: SettleHooks;
}): Promise<SuperGrokChoice> {
  const now = input.hooks?.now ?? Date.now();
  const enabled = grokCliReadEnabled({ cliRead: input.cliRead });
  const previous = input.hooks?.previous ? await input.hooks.previous() : await readGrokUsageFile();
  const history = input.hooks?.history ? await input.hooks.history() : await readSuperGrokHistory();
  const provider = providerWeekly(input.providerWindows);
  const providerPct = provider?.usedPct ?? null;
  const providerSeen = nextProviderSeen(previous?.providerSeen ?? seenFromHistory(history, providerPct), providerPct, now);
  const ranSince = input.hooks?.ranSince ?? superGrokRanSince;
  let stuck = false;
  if (providerSeen && now - Date.parse(providerSeen.since) >= PROVIDER_STUCK_MS) {
    stuck = await ranSince(Date.parse(providerSeen.since)).catch(() => false);
  }
  const providerUsable = provider !== null && !stuck;
  let cli = enabled ? storedReading(previous) : null;
  let loginLost = !providerUsable && enabled && previous?.loginLost === true;
  let loginAlarm = loginLost ? previous?.homeAlarm ?? msgLoginLost() : null;
  let lastAttemptAt = previous?.lastAttemptAt ?? null;
  if (enabled && input.capture === true) {
    const sample = await sampleQuota("grok-screen", () => input.hooks?.capture ? input.hooks.capture() : readGrokScreen(),
      { now, statePath: input.hooks?.statePath, errorOf: reading => reading.error });
    const captured = sample.value && sample.error ? { ...sample.value, ok: false, error: sample.error } : sample.value;
    if (captured && sample.attemptedAt !== lastAttemptAt) {
      const prior = storedReading(previous);
      if (!captured.ok && cliCurrent(prior, now) && prior) {
        cli = {
          ...prior,
          error: captured.error,
          loggedOut: captured.loggedOut || prior.loggedOut,
          loginLost: captured.loginLost || prior.loginLost,
          homeAlarm: captured.homeAlarm ?? prior.homeAlarm,
        };
      } else {
        cli = captured;
      }
      loginLost = !providerUsable && cli.loginLost === true;
      loginAlarm = loginLost ? cli.homeAlarm : null;
      lastAttemptAt = sample.attemptedAt;
    }
  }
  const choice = chooseSuperGrok({
    now,
    providerWindows: input.providerWindows,
    cli,
    cliEnabled: enabled,
    manual: input.manual,
    unreadSince: previous?.unreadSince ?? null,
    history,
    loginLost,
    loginAlarm,
    providerSeen,
    providerStuck: stuck,
    lastKnown: previous?.lastKnown ?? (previous?.ok && previous.usedPct !== null && previous.readAt
      ? { usedPct: previous.usedPct, readAt: previous.readAt, resetsAt: previous.resetsAt } : undefined),
  });
  let diffLogged = previous?.diffLogged ?? null;
  if (input.capture === true && choice.diffLine) {
    const key = `${choice.usedPct}/${choice.providerPct}`;
    if (key !== diffLogged) {
      diffLogged = key;
      const log = input.hooks?.log ?? ((line: string) => appendFile(GROK_DIFF_LOG, `${line}\n`, "utf8"));
      await log(choice.diffLine).catch(() => {});
    }
  }
  if (input.capture === true) {
    const kept: GrokCliReading = cli ?? {
      ok: false,
      usedPct: null,
      resetsAt: null,
      readAt: previous?.readAt ?? null,
      error: previous?.error ?? null,
      loggedOut: previous?.loggedOut === true,
      loginLost: false,
      homeAlarm: null,
    };
    const persist = input.hooks?.persist ?? ((stored: GrokStored) => writeJson(GROK_USAGE_FILE, stored));
    const lastKnown = kept.ok && kept.usedPct !== null && kept.readAt ? { usedPct: kept.usedPct, readAt: kept.readAt, resetsAt: kept.resetsAt }
      : previous?.lastKnown ?? (previous?.ok && previous.usedPct !== null && previous.readAt
        ? { usedPct: previous.usedPct, readAt: previous.readAt, resetsAt: previous.resetsAt } : undefined);
    await persist(storedFrom(kept, lastAttemptAt, choice.unreadSince, providerSeen, diffLogged, lastKnown)).catch(() => {});
  }
  return choice;
}

let screenInflight: Promise<GrokCliReading> | null = null;

export async function readGrokScreen(timeoutMs = GROK_SCREEN_TIMEOUT_MS): Promise<GrokCliReading> {
  if (!platformCapabilities().screen) throw new Error(t("screen.unavailable"));
  if (screenInflight) return screenInflight;
  const run = readGrokScreenVia(liveGrokScreenIo(), timeoutMs);
  screenInflight = run;
  void run.finally(() => {
    if (screenInflight === run) screenInflight = null;
  });
  return run;
}

async function grokModelsLogin(): Promise<GrokLogin> {
  const out = await captureOutput(GROK_BIN, ["models"], { timeoutMs: 15_000, limit: 500, stderr: true, env: agentLaunchEnv() });
  return loginFromGrokModels(out);
}

/** Screen session for one read. Keys are sent only by `readGrokScreenVia`. Close does not type. `bin` is a test seam for a fake `screen`. */
export function liveGrokScreenIo(bin?: string): GrokScreenIo {
  const cwd = join(STATE_DIR, "tmp");
  const session = createScreenSession({
    session: SESSION,
    dir: join(cwd, "grok-usage-run"),
    cwd,
    launch: GROK_BIN,
    bin,
    label: "screen",
    // macOS screen can corrupt Unicode cells in hardcopy (NUL padding / invalid UTF-8).
    // Its terminal stream still has the intact composer. That log is fresh for each read.
    usable: grokHardcopyUsable,
  });
  return {
    login: () => grokModelsLogin(),
    open: () => session.open(),
    readFrame: () => session.readFrame(),
    stuff: (keys) => session.stuff(keys),
    fail: (frame, error) => writeFile(GROK_SCREEN_FAIL_LOG, sanitizedScreenFailure(frame, error, new Date().toISOString()), { encoding: "utf8", mode: 0o600 }),
    close: () => session.close(),
  };
}

export function grokHardcopyUsable(frame: string): boolean {
  // The ASCII usage labels survive even when the progress-bar glyphs do not.
  // A login warning must always win over a potentially older stream frame.
  return frameSaysGrokLogin(frame) || parseGrokUsageScreen(frame) !== null
    || (Boolean(frame.trim()) && !/[\x00\ufffd]/.test(frame));
}
