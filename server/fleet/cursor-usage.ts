import { platformCapabilities } from "./platform";
/// <reference types="node" />
// Read Cursor quota on AFC's fixed hourly schedule, preferring its own Cursor API login.
// The cursor-agent `/usage` screen remains the fallback when that login is missing or the call fails,
// unless plans.json `cursor.screenRead` is false (a missing field means on). False skips the screen
// entirely and the card shows the hand-copied percentage.
// Nothing else is typed into that screen. No Cursor database and no other app's token is opened.
// `/usr/bin/expect` and `/usr/bin/script` both stall inside cursor-agent's raw-mode setup on this OS,
// so the pseudo-terminal is `/usr/bin/screen` (also shipped with macOS). A session started with -dmS
// ignores `stuff` and `hardcopy` unless they name the window (`-p 0`).
//
// The screen is started in the plugin process's own environment. `launchctl asuser` plus a wiped
// environment made cursor-agent think it was logged out and drew a login page; that page can clear
// the machine's Cursor login. Electron and Node IPC variables are removed so the child does not
// attach to the plugin's channel. Everything else (home, path, keychain session) stays.
//
// Safety: `cursor-agent status` must say logged in before the interactive screen starts. If the
// screen shows Sign in, Signing in, login, Log in, browser, or QR, the session is quit at once
// and no key is sent. After the read, status is checked again. If it is no longer logged in, the
// homepage gets a red alarm and AFC's leader and the Kanban leader are notified. This path never
// runs login or logout, never reads a token, and never opens a browser. Only the screen session
// and cursor-agent processes started for this read are stopped.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { crashNotifyTargets } from "../../shared/fleet/daemon-crash";
import { t } from "../../shared/fleet/i18n";
import { cursorScreenOffNotice } from "../../shared/fleet/quota-companies";
import { baseAdapterOf, CURSOR_API } from "../../shared/fleet/quota-adapters";
import { adapterOn, readOpsProject } from "./adapters/config";
import { readPlanSources } from "./adapters/plans";
import { BIN, HOME, readJson, run as runCmd } from "./util";
import {
  createLoginAttempt,
  loadOfficialQuotas,
  msgNetwork,
  msgReconnect,
  pollOnce,
  type OfficialFailure,
  type OfficialParts,
} from "./cursor-api";
import {
  cursorTokenStore,
  msgTokenMode,
  msgTokenSave,
  msgTokenUnreadable,
  msgTokenWrite,
  type TokenRead,
  type TokenStore,
} from "./cursor-token-store";
import {
  frameSaysLogin,
  normalizeStoredReading,
  interpretScreen,
  parseCursorUsageScreen,
  type CursorScreenWindow,
  type ParsedCursorUsage,
} from "./cursor-parse";
import {
  agentLaunchEnv,
  captureOutput,
  createScreenSession,
  describeError,
  loginAfterRead,
  NEXT_FRAME,
  pollFrames,
  runProcess,
  sleep as defaultSleep,
  stripAnsi,
  type FrameVerdict,
} from "./screen-read";
import { STATE_DIR, writeJson } from "./util";
import { kanbanConfigPath } from "./paths";
import { sampleQuota } from "./quota-sampling";
import { QUOTA_SAMPLE_MS } from "./quota-timing";
import { QUOTA_DISPLAY_TTL_MS, validQuotaTime } from "../../shared/fleet/quota-time";

export { agentLaunchEnv, stripAnsi };
export {
  frameSaysLogin,
  interpretScreen,
  parseCursorScreenWindows,
  parseCursorUsageScreen,
  textSaysLoggedOut,
  type CursorScreenWindow,
} from "./cursor-parse";

export const CURSOR_USAGE_FILE = join(STATE_DIR, "cursor-usage.json");
/** Compatibility exports; the shared scheduler now owns all API/screen attempts. */
export const CURSOR_USAGE_EVERY_MS = QUOTA_SAMPLE_MS;
export const CURSOR_SCREEN_EVERY_MS = QUOTA_SAMPLE_MS;
export const CURSOR_SCREEN_FALLBACK_MS = QUOTA_SAMPLE_MS;
export const CURSOR_USAGE_TIMEOUT_MS = 90_000;
export const CURSOR_LOGIN_WAIT_MS = 5 * 60_000;

const SESSION = "afc-cursor-usage";
const CURSOR_AGENT_BIN = join(homedir(), ".local", "bin", "cursor-agent");

export interface CursorUsageReading {
  /** Last actual successful Auto reading, so failure cannot clear a known exhausted pool. */
  lastKnown?: { autoPct: number; readAt: string; resetsAt: string | null };
  readAt: string;
  ok: boolean;
  error: string | null;
  includedPct: number | null;
  /** Cursor models (Grok, Composer). The only percentage that decides dispatch. */
  autoPct: number | null;
  /** Other models. Display only. */
  apiPct: number | null;
  onDemandUsd: number | null;
  onDemandLimitUsd: number | null;
  /** Set only when the screen gives a full timestamp. A bare "Resets Oct 12" is not guessed. */
  resetsAt: string | null;
  /** Every quota row visible on the screen. Empty when the read failed. Old files omit it. */
  windows: CursorScreenWindow[];
  /** True when the screen is the login splash or `cursor-agent status` says Not logged in. */
  loggedOut: boolean;
  /** official: Cursor's usage API with AFC's own login. screen: cursor-agent /usage. Null when neither worked. */
  source?: "official" | "screen" | null;
  /** unlinked: no AFC login file yet. connected: the file is still the login. broken: refresh was rejected. */
  linkState?: "unlinked" | "connected" | "broken";
  /** True when the refresh token was rejected. Old official numbers must not be shown as current. */
  linkBroken?: boolean;
  /** Shown on the Cursor card. Never contains a token. */
  notice?: string | null;
  /** Homepage alarm. A fixed sentence, never a token. Null when there is nothing extra to flag. */
  homeAlarm?: string | null;
  /**
   * plans.json `cursor.screenRead`. Missing on old files means on.
   * False: this read did not open the cursor-agent screen.
   */
  screenRead?: boolean;
}

export async function readCursorUsageFile(): Promise<CursorUsageReading | null> {
  try {
    const reading = normalizeStoredReading(JSON.parse(await readFile(CURSOR_USAGE_FILE, "utf8")));
    if (!reading) return null;
    const at = validQuotaTime(reading.readAt, Date.now());
    if (reading.ok && (!at || Date.now() - Date.parse(at) >= QUOTA_DISPLAY_TTL_MS || reading.resetsAt && Date.parse(reading.resetsAt) <= Date.now())) {
      return { ...reading, ok: false, error: reading.error ?? t("quota.setup.staleHold"),
        ...(reading.autoPct !== null ? { lastKnown: reading.lastKnown ?? { autoPct: reading.autoPct, readAt: reading.readAt, resetsAt: reading.resetsAt } } : {}) };
    }
    return reading;
  } catch {
    return null;
  }
}

function emptyReading(readAt: string, error: string, loggedOut = false, extra: Partial<CursorUsageReading> = {}): CursorUsageReading {
  return {
    readAt,
    ok: false,
    error,
    includedPct: null,
    autoPct: null,
    apiPct: null,
    onDemandLimitUsd: null,
    onDemandUsd: null,
    resetsAt: null,
    windows: [],
    loggedOut,
    source: null,
    linkState: "unlinked",
    linkBroken: false,
    notice: error,
    homeAlarm: null,
    ...extra,
  };
}

/** Minimal environment for the user-initiated browser open only. The /usage screen does not use this. */
function guiEnv(): NodeJS.ProcessEnv {
  const home = homedir();
  const user = process.env.USER || process.env.LOGNAME || "";
  return {
    HOME: home,
    USER: user,
    LOGNAME: process.env.LOGNAME || user,
    SHELL: "/bin/zsh",
    PATH: `/usr/bin:/bin:/usr/sbin:/sbin:${home}/.local/bin`,
    TMPDIR: process.env.TMPDIR || "/tmp",
    LANG: process.env.LANG || "en_US.UTF-8",
    TERM: "xterm-256color",
  };
}

/** Browser open for the Connect button only. The /usage screen does not go through launchctl. */
function asUserArgs(args: string[]): string[] {
  const uid = process.getuid?.();
  const envPairs = Object.entries(guiEnv()).map(([key, value]) => `${key}=${value ?? ""}`);
  const command = ["/usr/bin/env", "-i", ...envPairs, ...args];
  if (uid === undefined) return command;
  return ["/bin/launchctl", "asuser", String(uid), ...command];
}

export type AgentLogin = "in" | "out" | "unknown";

/** Status text only. "Not logged in" is checked first because it also contains "logged in". The account name is not kept. */
export function loginFromStatusText(text: string): AgentLogin {
  if (/not logged in/i.test(text)) return "out";
  if (/logged in/i.test(text)) return "in";
  return "unknown";
}

/** `cursor-agent status` in the plugin environment. Does not start the interactive screen and does not run login. */
export async function cursorAgentLogin(timeoutMs = 8_000): Promise<AgentLogin> {
  const out = await captureOutput(CURSOR_AGENT_BIN, ["status"], { timeoutMs, limit: 400, stderr: true, env: agentLaunchEnv() });
  return loginFromStatusText(out);
}

/** True only when status says Not logged in. Null when the command did not answer. */
export async function cursorAgentNotLoggedIn(timeoutMs = 8_000): Promise<boolean | null> {
  const login = await cursorAgentLogin(timeoutMs);
  if (login === "out") return true;
  if (login === "in") return false;
  return null;
}

/**
 * The interactive agent this read may start: `…/index.js` with nothing after it.
 * Paseo agents put `--use-system-ca` or `acp` on that command, so they are left alone.
 */
export function isUsageAgentCommand(command: string): boolean {
  const text = command.trim();
  if (!/cursor-agent\/versions\/\S*index\.js$/.test(text)) return false;
  if (text.includes("--use-system-ca") || text.includes("--api-key") || /\bacp\b/.test(text) || text.includes("worker-server")) return false;
  return true;
}

async function indexJsPids(): Promise<number[]> {
  const out = await captureOutput("ps", ["-ax", "-o", "pid=,command="]);
  const pids: number[] = [];
  for (const line of out.split("\n")) {
    const trimmed = line.trim();
    const cut = trimmed.indexOf(" ");
    if (cut <= 0) continue;
    const pid = Number(trimmed.slice(0, cut));
    const command = trimmed.slice(cut + 1);
    if (pid > 1 && pid !== process.pid && isUsageAgentCommand(command)) pids.push(pid);
  }
  return pids;
}

export const MSG_STATUS_OUT = "cursor-agent status: Not logged in";
export function msgStatusUnknown(): string {
  return t("cursor.usage.statusUnknown");
}
export function msgLoginScreen(): string {
  return t("screen.loginScreen");
}
/** Homepage red alarm. A fixed sentence. Never a token, never an instruction to run login from this reader. */
export function msgLoginLost(): string {
  return t("cursor.usage.loginLost");
}

const KANBAN_CONFIG = kanbanConfigPath();

export interface ScreenIo {
  login(): Promise<AgentLogin>;
  /** Start the interactive screen. Not called unless status says logged in. */
  open(): Promise<void>;
  readFrame(): Promise<string>;
  stuff(keys: string): Promise<void>;
  /** Quit the session and stop only the processes this read started. Sends no keys. */
  close(): Promise<void>;
  notifyLoginLost(): Promise<void>;
}

/** Private on purpose: the shared `sendToAgent` in util.ts is another card's job. Swap this body when it lands. */
async function sendLeaderNote(id: string, text: string): Promise<void> {
  await runCmd(BIN.paseo, ["send", id, "--no-wait", "--prompt", text], 20_000);
}

async function defaultNotifyLoginLost(): Promise<void> {
  const ids = crashNotifyTargets(await readJson<unknown>(KANBAN_CONFIG, null), readOpsProject());
  if (ids.length === 0) {
    console.error("[afc] cursor usage: no <leader> id, skipping this round of notices");
    return;
  }
  const text = t("screen.leaderNote", { text: msgLoginLost() });
  for (const id of ids) {
    try {
      await sendLeaderNote(id, text);
    } catch (error) {
      console.error("[afc] cursor usage notify:", String(error).slice(0, 160));
    }
  }
}

function screenReading(readAt: string, parsed: ParsedCursorUsage): CursorUsageReading {
  return {
    ...parsed,
    readAt,
    ok: true,
    error: null,
    loggedOut: false,
    source: "screen",
    linkState: "unlinked",
    linkBroken: false,
    notice: null,
    homeAlarm: null,
  };
}

/** Types `/usage`, and submits it only if the frame in between is not a login page. Null means "keep polling". */
async function typeUsageCommand(io: ScreenIo, sleep: (ms: number) => Promise<void>): Promise<FrameVerdict<never>> {
  await io.stuff("/usage");
  await sleep(300);
  if (frameSaysLogin(await io.readFrame())) return { kind: "fail", error: msgLoginScreen() };
  await io.stuff("\r");
  return NEXT_FRAME;
}

/**
 * One /usage read. Status must already say logged in or the screen is never opened.
 * A login word ends the session before the next key. After the session is closed, status
 * is checked again; a change to logged out sets the red alarm and notifies the leaders.
 */
export async function readCursorScreenVia(
  io: ScreenIo,
  timeoutMs = CURSOR_USAGE_TIMEOUT_MS,
  sleep: (ms: number) => Promise<void> = defaultSleep,
): Promise<CursorUsageReading> {
  const readAt = new Date().toISOString();
  const before = await io.login();
  if (before !== "in") {
    return emptyReading(readAt, before === "out" ? MSG_STATUS_OUT : msgStatusUnknown(), before === "out", { source: null });
  }

  let opened = false;
  let sentUsage = false;
  let sawLogin = false;
  let reading: CursorUsageReading | null = null;
  let error: string | null = null;
  const onFrame = async (frame: string): Promise<FrameVerdict<CursorUsageReading>> => {
    if (frameSaysLogin(frame)) return { kind: "fail", error: msgLoginScreen() };
    const parsed = parseCursorUsageScreen(stripAnsi(frame));
    if (parsed) return { kind: "done", value: screenReading(readAt, parsed) };
    if (interpretScreen(frame) !== "ready" || sentUsage) return NEXT_FRAME;
    sentUsage = true;
    return typeUsageCommand(io, sleep);
  };
  try {
    await io.open();
    opened = true;
    const polled = await pollFrames({ readFrame: () => io.readFrame(), timeoutMs, sleep, onFrame });
    reading = polled.value;
    error = polled.error;
    sawLogin = error === msgLoginScreen();
    if (!reading && !error) error = sentUsage ? t("cursor.usage.noAutoPct") : t("cursor.usage.noPrompt");
  } catch (e) {
    error = describeError(e);
  } finally {
    if (opened && sentUsage && !sawLogin) {
      await io.stuff("\x1b").catch(() => {});
      await sleep(200);
      await io.stuff("\x03").catch(() => {});
    }
    if (opened) await io.close().catch(() => {});
  }

  const failed = reading ?? emptyReading(readAt, error ?? t("cursor.usage.screenNotRead"), false, { source: null });
  return noteIfLoginLost(io, failed);
}

async function noteIfLoginLost(io: ScreenIo, reading: CursorUsageReading): Promise<CursorUsageReading> {
  const after = await loginAfterRead(() => io.login(), "unknown");
  if (after !== "out") return reading;
  try {
    await io.notifyLoginLost();
  } catch (error) {
    console.error("[afc] cursor usage notify:", String(error).slice(0, 160));
  }
  return { ...reading, homeAlarm: msgLoginLost(), loggedOut: true };
}

/** Screen session for one read. Keys are sent only by `readCursorScreenVia`. Close never types. `bin` is a test seam for a fake `screen`. */
export function liveScreenIo(cwd: string, bin?: string): ScreenIo {
  let beforeAgents = new Set<number>();
  const session = createScreenSession({
    session: SESSION,
    dir: join(cwd, "cursor-usage-run"),
    cwd,
    launch: CURSOR_AGENT_BIN,
    bin,
    beforeLaunch: async () => {
      beforeAgents = new Set(await indexJsPids());
    },
  });
  return {
    login: () => cursorAgentLogin(),
    open: () => session.open(),
    readFrame: () => session.readFrame(),
    stuff: (keys) => session.stuff(keys),
    close: () => session.close(async () => (await indexJsPids()).filter((pid) => !beforeAgents.has(pid))),
    notifyLoginLost: () => defaultNotifyLoginLost(),
  };
}

/**
 * Start cursor-agent in a screen session whose cwd is this repo's `tmp/` (already trusted)
 * and return text that contains the Auto line. Refuses to open the screen when status is not logged in.
 * On a login word, types nothing and throws.
 */
export async function captureCursorUsageScreen(cwd: string, timeoutMs = CURSOR_USAGE_TIMEOUT_MS): Promise<string> {
  const reading = await readCursorScreen(cwd, timeoutMs);
  if (reading.autoPct === null) throw new Error(reading.error ?? t("cursor.usage.noAutoOnScreen"));
  const lines = [`Auto ${reading.autoPct}%`];
  if (reading.apiPct !== null) lines.push(`API ${reading.apiPct}%`);
  return lines.join("\n");
}

export function msgUnlinked(): string {
  return t("cursor.usage.unlinked");
}
export function manualScreenNotice(): string {
  return t("cursor.usage.screen");
}
export function msgManual(): string {
  return t("cursor.usage.manual");
}
export function msgStaleOfficial(): string {
  return t("cursor.usage.staleOfficial");
}

/** Two sentences joined the way the current language writes them. */
function sentences(a: string, b: string): string {
  return t("cursor.join.sentence", { a, b });
}

/** Two clauses of one sentence. */
function clauses(a: string, b: string): string {
  return t("cursor.join.clause", { a, b });
}
const STALE_OFFICIAL_MS = 30 * 60_000;

export type StoreFailure = OfficialFailure | "local";

export type OfficialAttempt =
  | { ok: true; parts: OfficialParts; grokNote: string | null }
  | { ok: false; failure: StoreFailure; message: string };

/** Keep a screen-read alarm (login lost) together with a token-file alarm. */
export function mergeHomeAlarm(primary?: string | null, extra?: string | null): string | null {
  const unique = [...new Set([primary, extra].filter((item): item is string => Boolean(item)))];
  return unique.length > 0 ? unique.reduce(sentences) : null;
}

/**
 * Official numbers win. A rejected refresh never keeps the previous official numbers.
 * A network or format miss uses a fresh screen read, then a recent official read (with a notice), then the hand copy.
 */
export function combineCursorReading(input: {
  readAt: string;
  attemptedOfficial: boolean;
  official: OfficialAttempt | null;
  screen: CursorUsageReading | null;
  previous: CursorUsageReading | null;
  nowMs: number;
  homeAlarm?: string | null;
  /** Missing means on. False drops the screen and keeps the hand copy. */
  screenRead?: boolean;
}): CursorUsageReading {
  const screenOn = input.screenRead !== false;
  const screen = screenOn ? input.screen : null;
  const alarm = mergeHomeAlarm(input.homeAlarm, screen?.homeAlarm);
  const finish = (reading: CursorUsageReading): CursorUsageReading => {
    const lastKnown = reading.ok && reading.autoPct !== null ? { autoPct: reading.autoPct, readAt: reading.readAt, resetsAt: reading.resetsAt }
      : input.previous?.lastKnown ?? (input.previous?.ok && input.previous.autoPct !== null
        ? { autoPct: input.previous.autoPct, readAt: input.previous.readAt, resetsAt: input.previous.resetsAt } : undefined);
    return { ...reading, homeAlarm: alarm, screenRead: screenOn, ...(lastKnown ? { lastKnown } : {}) };
  };
  const stayBroken = !input.attemptedOfficial && (input.previous?.linkState === "broken" || input.previous?.linkBroken === true);
  if (stayBroken) {
    if (screen?.ok && screen.autoPct !== null) {
      return finish({
        ...screen,
        source: "screen",
        linkState: "broken",
        linkBroken: true,
        loggedOut: false,
        notice: sentences(msgReconnect(), manualScreenNotice()),
        error: null,
      });
    }
    if (!screenOn) {
      return finish(emptyReading(input.readAt, sentences(msgReconnect(), cursorScreenOffNotice()), false, {
        linkState: "broken",
        linkBroken: true,
        notice: sentences(msgReconnect(), cursorScreenOffNotice()),
        loggedOut: false,
      }));
    }
    const screenError = screen?.error ?? t("cursor.usage.screenNotRead");
    return finish(emptyReading(input.readAt, sentences(clauses(msgReconnect(), screenError), msgManual()), false, {
      linkState: "broken",
      linkBroken: true,
      notice: sentences(msgReconnect(), msgManual()),
      loggedOut: false,
    }));
  }
  if (!input.attemptedOfficial) {
    if (screen?.ok && screen.autoPct !== null) {
      return finish({ ...screen, source: "screen", linkState: "unlinked", linkBroken: false, notice: null, error: null });
    }
    if (screen) {
      return finish({ ...screen, source: null, linkState: "unlinked", linkBroken: false, notice: screen.notice ?? screen.error });
    }
    if (!screenOn) {
      return finish(emptyReading(input.readAt, cursorScreenOffNotice(), false, {
        error: null,
        notice: cursorScreenOffNotice(),
        linkState: "unlinked",
      }));
    }
    return finish(emptyReading(input.readAt, msgUnlinked(), false, { notice: msgUnlinked(), linkState: "unlinked" }));
  }

  if (input.official?.ok) {
    const parts = input.official.parts;
    const notes = [input.official.grokNote, alarm && alarm !== input.official.grokNote ? alarm : null].filter((item): item is string => Boolean(item));
    return finish({
      readAt: input.readAt,
      ok: true,
      error: null,
      includedPct: parts.includedPct,
      autoPct: parts.autoPct,
      apiPct: parts.apiPct,
      onDemandUsd: parts.onDemandUsd,
      onDemandLimitUsd: parts.onDemandLimitUsd,
      resetsAt: parts.resetsAt,
      windows: parts.windows,
      loggedOut: false,
      source: "official",
      linkState: "connected",
      linkBroken: false,
      notice: notes.length > 0 ? notes.reduce(sentences) : null,
    });
  }

  const failure = input.official && !input.official.ok ? input.official : { ok: false as const, failure: "network" as const, message: msgNetwork() };
  const broken = failure.failure === "expired";
  if (screen?.ok && screen.autoPct !== null) {
    const notice = broken ? sentences(msgReconnect(), manualScreenNotice()) : sentences(failure.message, manualScreenNotice());
    return finish({ ...screen, source: "screen", linkState: broken ? "broken" : "connected", linkBroken: broken, loggedOut: false, notice, error: null });
  }

  if (!broken && input.previous?.source === "official" && input.previous.ok && input.previous.autoPct !== null) {
    const age = input.nowMs - Date.parse(input.previous.readAt);
    if (age >= 0 && age < STALE_OFFICIAL_MS) {
      return finish({ ...input.previous, linkState: "connected", linkBroken: false, notice: sentences(failure.message, msgStaleOfficial()) });
    }
  }

  const screenError = screen?.error ?? t("cursor.usage.screenNotRead");
  const error = screenOn ? sentences(clauses(failure.message, screenError), msgManual()) : sentences(failure.message, cursorScreenOffNotice());
  const loggedOut = !broken && screen?.loggedOut === true;
  return finish(emptyReading(input.readAt, error, loggedOut, {
    linkState: broken ? "broken" : "connected",
    linkBroken: broken,
    notice: broken ? sentences(msgReconnect(), screenOn ? msgManual() : cursorScreenOffNotice()) : error,
    loggedOut,
  }));
}

/** The /usage screen only. Does not write cursor-usage.json. */
export async function readCursorScreen(cwd = join(STATE_DIR, "tmp"), timeoutMs = CURSOR_USAGE_TIMEOUT_MS): Promise<CursorUsageReading> {
  if (!platformCapabilities().screen) throw new Error(t("screen.unavailable"));
  return readCursorScreenVia(liveScreenIo(cwd), timeoutMs);
}

let sessionEpoch = 0;
let loginGeneration = 0;
let waitingMessage: string | null = null;

export function cursorLinkOverride(): { state: "waiting"; message: string } | null {
  if (!waitingMessage) return null;
  return { state: "waiting", message: waitingMessage };
}

/** True when the /usage screen should be opened now. `immediate` is set by disconnect and is not the 2 hour gap. */
export function shouldReadScreen(input: { lastAt: number; now: number; mode: "unlinked" | "fallback"; immediate: boolean }): boolean {
  if (input.immediate || input.lastAt === 0) return true;
  const gap = input.mode === "unlinked" ? CURSOR_SCREEN_EVERY_MS : CURSOR_SCREEN_FALLBACK_MS;
  return input.now - input.lastAt >= gap;
}

async function screenIfDue(cwd: string, _mode: "unlinked" | "fallback", epoch: number): Promise<CursorUsageReading | null> {
  // The enclosing Cursor reservation owns the cadence, including screen fallback.
  if (epoch !== sessionEpoch) return null;
  const reading = await readCursorScreen(cwd);
  return epoch === sessionEpoch ? reading : null;
}

async function persistRefreshed(previous: { accessToken: string; refreshToken: string; authId: string }, next: { accessToken: string; refreshToken: string; authId: string }, store: TokenStore = cursorTokenStore): Promise<"saved" | "unchanged" | "failed"> {
  if (previous.accessToken === next.accessToken && previous.refreshToken === next.refreshToken && previous.authId === next.authId) return "unchanged";
  try {
    await store.set(next);
    return "saved";
  } catch (err) {
    console.error("[afc] cursor token save: failed");
    return "failed";
  }
}

/** Missing `screenRead` stays on. Only a literal false turns the cursor-agent screen off. */
export function cursorScreenReadEnabled(plan: { screenRead?: unknown } | null | undefined): boolean {
  return plan?.screenRead !== false;
}

/** `screenRead` of the cursor-api plan in plans.json. */
async function plansCursorScreenRead(): Promise<boolean> {
  const cursor = (await readPlanSources()).find((p) => baseAdapterOf(p) === CURSOR_API) as { screenRead?: unknown } | undefined;
  return cursorScreenReadEnabled(cursor ?? null);
}

/** Test seam. Production leaves this unset and reads plans.json. */
export interface CaptureCursorHooks {
  statePath?: string;
  /** Used instead of plans.json. A missing `screenRead` still means on. */
  plan?: { screenRead?: unknown } | null;
  screenIfDue?: (cwd: string, mode: "unlinked" | "fallback", epoch: number) => Promise<CursorUsageReading | null>;
  tokenGet?: () => Promise<TokenRead>;
  previous?: () => Promise<CursorUsageReading | null>;
  /** Replaces the write to cursor-usage.json so a test does not touch the live file. */
  persist?: (reading: CursorUsageReading) => Promise<void>;
}

/** Official API when AFC has its own login; otherwise the screen; the hand copy is applied by usage.ts when this is not ok. */
async function captureCursorUsageOnce(cwd: string, hooks?: CaptureCursorHooks): Promise<CursorUsageReading> {
  const epoch = sessionEpoch;
  const readAt = new Date().toISOString();
  const nowMs = Date.now();
  const previous = hooks?.previous ? await hooks.previous() : await readCursorUsageFile();
  let attempted = false;
  let official: OfficialAttempt | null = null;
  let homeAlarm: string | null = null;
  try {
    const got = hooks?.tokenGet ? await hooks.tokenGet() : await cursorTokenStore.get();
    if (got.ok) {
      attempted = true;
      const loaded = await loadOfficialQuotas(got.tokens);
      if (epoch !== sessionEpoch) return (await readCursorUsageFile()) ?? emptyReading(readAt, t("cursor.usage.disconnect"), false);
      const next = loaded.tokens;
      if (next) {
        const saved = await persistRefreshed(got.tokens, next);
        if (saved === "failed") homeAlarm = msgTokenSave();
      } else if (!loaded.ok && loaded.failure === "expired") {
        await cursorTokenStore.delete().catch(() => {});
      }
      official = loaded.ok
        ? { ok: true, parts: loaded.parts, grokNote: loaded.grokNote }
        : { ok: false, failure: loaded.failure, message: loaded.message };
    } else if (got.reason === "insecure") {
      attempted = true;
      homeAlarm = msgTokenMode();
      official = { ok: false, failure: "local", message: msgTokenMode() };
    } else if (got.reason === "unreadable") {
      attempted = true;
      homeAlarm = msgTokenUnreadable();
      official = { ok: false, failure: "local", message: msgTokenUnreadable() };
    }
  } catch (e) {
    attempted = true;
    homeAlarm = msgTokenUnreadable();
    official = { ok: false, failure: "local", message: msgTokenUnreadable() };
    console.error("[afc] cursor official: failed");
  }
  if (epoch !== sessionEpoch) return (await readCursorUsageFile()) ?? emptyReading(readAt, t("cursor.usage.disconnect"), false);

  const screenOn = hooks && "plan" in hooks ? cursorScreenReadEnabled(hooks.plan) : await plansCursorScreenRead();
  let screen: CursorUsageReading | null = null;
  if (screenOn && !official?.ok) {
    screen = hooks?.screenIfDue
      ? await hooks.screenIfDue(cwd, attempted ? "fallback" : "unlinked", epoch)
      : await screenIfDue(cwd, attempted ? "fallback" : "unlinked", epoch);
  }
  if (epoch !== sessionEpoch) return (await readCursorUsageFile()) ?? emptyReading(readAt, t("cursor.usage.disconnect"), false);

  const reading = combineCursorReading({ readAt, attemptedOfficial: attempted, official, screen, previous, nowMs, homeAlarm, screenRead: screenOn });
  if (hooks?.persist) await hooks.persist(reading);
  else await writeJson(CURSOR_USAGE_FILE, reading);
  return reading;
}

/** Login/disconnect requests share the slot; they cannot force an extra quota read. */
export async function captureCursorUsage(cwd = join(STATE_DIR, "tmp"), hooks?: CaptureCursorHooks): Promise<CursorUsageReading | null> {
  if (!adapterOn(CURSOR_API)) return null;
  const sample = await sampleQuota("cursor", () => captureCursorUsageOnce(cwd, hooks), { statePath: hooks?.statePath, errorOf: reading => reading.error });
  if (sample.error && sample.collectedAt !== sample.attemptedAt) {
    return { ...(sample.value ?? emptyReading(sample.attemptedAt ?? "", sample.error, false)), ok: false, error: sample.error };
  }
  return sample.value;
}

export function requestCursorCapture(cwd = join(STATE_DIR, "tmp")): void {
  if (!adapterOn(CURSOR_API)) return;
  captureCursorUsage(cwd)
    .catch((e) => console.error("[afc] cursor usage:", String(e).slice(0, 200)));
}

async function openLoginUrl(url: string): Promise<boolean> {
  const argv = asUserArgs(["/usr/bin/open", url]);
  try {
    await runProcess(argv[0], argv.slice(1), 10_000);
    return true;
  } catch {
    return false;
  }
}

async function rememberNotice(notice: string, linkState: "unlinked" | "broken", homeAlarm: string | null = null): Promise<void> {
  // A login started while the adapter was on may finish after it was switched off: write nothing then.
  if (!adapterOn(CURSOR_API)) return;
  const previous = await readCursorUsageFile();
  const readAt = new Date().toISOString();
  const base = previous ?? emptyReading(readAt, notice, false);
  await writeJson(CURSOR_USAGE_FILE, { ...base, linkState, linkBroken: linkState === "broken", notice, homeAlarm });
}

async function watchLogin(generation: number, attempt: ReturnType<typeof createLoginAttempt>): Promise<void> {
  const deadline = Date.now() + CURSOR_LOGIN_WAIT_MS;
  try {
    while (Date.now() < deadline && generation === loginGeneration) {
      await defaultSleep(2000);
      if (generation !== loginGeneration) return;
      const verdict = await pollOnce(attempt);
      if (verdict.kind === "pending" || verdict.kind === "retry") continue;
      if (generation !== loginGeneration) return;
      if (verdict.kind === "refused") {
        waitingMessage = null;
        await rememberNotice(t("cursor.usage.loginRefused"), "unlinked");
        return;
      }
      try {
        await cursorTokenStore.set(verdict.tokens);
      } catch {
        waitingMessage = null;
        await rememberNotice(msgTokenWrite(), "unlinked", msgTokenWrite());
        return;
      }
      waitingMessage = null;
      requestCursorCapture();
      return;
    }
    if (generation === loginGeneration) {
      waitingMessage = null;
      await rememberNotice(t("cursor.usage.loginTimeout"), "unlinked");
    }
  } catch (e) {
    if (generation === loginGeneration) {
      waitingMessage = null;
      const notice = String(e).includes(msgTokenWrite())
        ? msgTokenWrite()
        : t("cursor.usage.connectFailed");
      await rememberNotice(notice, "unlinked", notice === msgTokenWrite() ? msgTokenWrite() : null).catch(() => {});
    }
    console.error("[afc] cursor login: failed");
  }
}

/** Opens the browser login page and polls in the background. Does not click the authorization button. */
export const MSG_ADAPTER_OFF = "The Cursor adapter is off. Turn on adapters.cursor-api in afc.config.json to connect Cursor.";

export async function beginCursorConnect(): Promise<{ ok: boolean; message: string }> {
  if (!adapterOn(CURSOR_API)) return { ok: false, message: MSG_ADAPTER_OFF };
  const attempt = createLoginAttempt();
  const generation = ++loginGeneration;
  waitingMessage = t("cursor.usage.waiting");
  const opened = await openLoginUrl(attempt.url);
  if (generation !== loginGeneration) return { ok: false, message: t("cursor.usage.browser") };
  if (!opened) {
    waitingMessage = null;
    return { ok: false, message: t("cursor.usage.browser") };
  }
  void watchLogin(generation, attempt);
  return { ok: true, message: t("cursor.usage.opened") };
}

/** Deletes only AFC's token file. Does not log out cursor-agent or the Cursor app. */
export async function disconnectCursor(): Promise<{ ok: boolean; message: string }> {
  loginGeneration += 1;
  sessionEpoch += 1;
  waitingMessage = null;
  await cursorTokenStore.delete();
  // Adapter off: only the login file goes. Writing cursor-usage.json would mark the adapter as in use (adapters/config.ts).
  if (!adapterOn(CURSOR_API)) return { ok: true, message: t("cursor.usage.disconnected") };
  const readAt = new Date().toISOString();
  await writeJson(CURSOR_USAGE_FILE, emptyReading(readAt, t("cursor.usage.disconnect"), false, { linkState: "unlinked", notice: t("cursor.usage.disconnect") }));
  requestCursorCapture();
  return { ok: true, message: t("cursor.usage.disconnected") };
}
