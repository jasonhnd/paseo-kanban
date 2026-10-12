/// <reference types="node" />
// Shared skeleton for the two terminal readers (cursor-usage.ts, grok-usage.ts).
// Both start a TUI inside `/usr/bin/screen`, poll its frame, type at most one command, and then stop
// only the processes this read started. Nothing in here types a key by itself: the callers decide.
import { platformCapabilities } from "./platform";
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { t } from "../../shared/fleet/i18n";

export const SCREEN_BIN = "/usr/bin/screen";
const COMMAND_TIMEOUT_MS = 5_000;
const LAUNCH_TIMEOUT_MS = 15_000;
const SESSION_TREE_DEPTH = 5;
const KILL_GRACE_MS = 400;
const POLL_MS = 1_000;
const FAILURE_LINES = 39;

export const sleep = (ms: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms));

const IPC_ENV = new Set(["NODE_CHANNEL_FD", "NODE_CHANNEL_SERIALIZATION_MODE", "NODE_OPTIONS", "NODE_UNIQUE_ID", "ELECTRON_RUN_AS_NODE"]);

/**
 * Plugin environment with Electron and Node IPC variables removed.
 * The child keeps the plugin's home, path, and login keychain session.
 * `launchctl asuser` is not used: a wiped environment made cursor-agent show a login page.
 */
export function agentLaunchEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of Object.keys(env)) {
    if (key.startsWith("ELECTRON_") || key.startsWith("VSCODE_") || key.startsWith("NODE_CHANNEL_") || IPC_ENV.has(key)) delete env[key];
  }
  if (!env.TERM) env.TERM = "xterm-256color";
  return env;
}

export function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "\n")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\r/g, "");
}

/** ANSI removed without inserting newlines, so a cursor-addressed "Plan" stays one word. */
export function flattenAnsi(raw: string): string {
  return raw
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b./g, "")
    .replace(/\r/g, "");
}

/** One line of a thrown error, safe to put in a reading. */
export function describeError(e: unknown): string {
  return String(e).replace(/\s+/g, " ").slice(0, 180);
}

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Name used in error text. Defaults to the command. */
  label?: string;
}

/** Run a command with no output. Resolves on exit 0; a timeout kills it and rejects. */
export function runProcess(cmd: string, args: string[], timeoutMs: number, opts: RunOptions = {}): Promise<void> {
  const label = opts.label ?? cmd;
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "ignore", cwd: opts.cwd, env: opts.env });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(t("screen.run.timeout", { label })));
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(t("screen.run.exitCode", { label, code: String(code) })));
    });
  });
}

export interface CaptureOptions {
  /** Kill the command and return what it printed. Unset waits for exit. */
  timeoutMs?: number;
  /** Stop collecting after this many characters. Unset keeps everything. */
  limit?: number;
  /** Also collect stderr. */
  stderr?: boolean;
  env?: NodeJS.ProcessEnv;
}

/** Output of a command. A spawn error, a timeout, or a non-zero exit never throws: you get what was printed. */
export function captureOutput(cmd: string, args: string[], opts: CaptureOptions = {}): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", opts.stderr ? "pipe" : "ignore"], env: opts.env });
    let out = "";
    const take = (d: Buffer | string) => {
      if (opts.limit === undefined) out += String(d);
      else if (out.length < opts.limit) out += String(d).slice(0, opts.limit - out.length);
    };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    const timer = opts.timeoutMs === undefined
      ? null
      : setTimeout(() => {
          child.kill("SIGKILL");
          resolve(out);
        }, opts.timeoutMs);
    const done = () => {
      if (timer) clearTimeout(timer);
      resolve(out);
    };
    child.on("error", done);
    child.on("exit", done);
  });
}

/** Pids of the screen session called `session` and everything it started, captured before quit so none are left behind. */
export async function screenSessionPids(session: string, bin: string = SCREEN_BIN): Promise<number[]> {
  const env = agentLaunchEnv();
  const listed = await captureOutput(bin, ["-ls"], { timeoutMs: COMMAND_TIMEOUT_MS, env });
  const leader = listed.match(new RegExp(`(\\d+)\\.${session}(?:\\s|$)`));
  if (!leader) return [];
  const root = Number(leader[1]);
  const seen = new Set<number>([root]);
  let frontier = [root];
  for (let depth = 0; depth < SESSION_TREE_DEPTH && frontier.length > 0; depth++) {
    const next: number[] = [];
    for (const pid of frontier) {
      const kids = (await captureOutput("pgrep", ["-P", String(pid)], { timeoutMs: COMMAND_TIMEOUT_MS, env }))
        .split("\n")
        .map((s) => Number(s.trim()))
        .filter((n) => n > 1 && !seen.has(n));
      for (const kid of kids) {
        seen.add(kid);
        next.push(kid);
      }
    }
    frontier = next;
  }
  return [...seen];
}

export interface KillDeps {
  kill: (pid: number, signal: NodeJS.Signals | 0) => void;
  sleep: (ms: number) => Promise<void>;
  self?: number;
}

const defaultKillDeps: KillDeps = { kill: (pid, signal) => process.kill(pid, signal), sleep };

/** SIGTERM the pids, then SIGKILL anything still alive. Never types into the TUI. Pid 1 and this process are skipped. */
export async function finishScreenSession(pids: number[], deps: KillDeps = defaultKillDeps): Promise<void> {
  const self = deps.self ?? process.pid;
  const mine = [...new Set(pids)].filter((pid) => pid > 1 && pid !== self);
  for (const pid of mine) {
    try { deps.kill(pid, "SIGTERM"); } catch { /* already gone */ }
  }
  await deps.sleep(KILL_GRACE_MS);
  for (const pid of mine) {
    try {
      deps.kill(pid, 0);
      deps.kill(pid, "SIGKILL");
    } catch { /* already gone */ }
  }
}

export type FrameVerdict<T> = { kind: "done"; value: T } | { kind: "fail"; error: string } | { kind: "next" };
export const NEXT_FRAME: FrameVerdict<never> = { kind: "next" };

export interface PollResult<T> {
  value: T | null;
  /** Set when a frame ended the read with an error. Null on success and on timeout. */
  error: string | null;
}

/**
 * Read frames once a second until one is `done` or `fail`, or `timeoutMs` passes.
 * A timeout returns `{ value: null, error: null }` so the caller can word it. A thrown error is the caller's.
 */
export async function pollFrames<T>(input: {
  readFrame: () => Promise<string>;
  timeoutMs: number;
  sleep: (ms: number) => Promise<void>;
  onFrame: (frame: string) => Promise<FrameVerdict<T>>;
}): Promise<PollResult<T>> {
  const started = Date.now();
  while (Date.now() - started < input.timeoutMs) {
    const verdict = await input.onFrame(await input.readFrame());
    if (verdict.kind === "done") return { value: verdict.value, error: null };
    if (verdict.kind === "fail") return { value: null, error: verdict.error };
    await input.sleep(POLL_MS);
  }
  return { value: null, error: null };
}

/** Login state after the session is closed. A failing check counts as unknown. */
export async function loginAfterRead<L extends string>(login: () => Promise<L>, unknown: L): Promise<L> {
  try {
    return await login();
  } catch {
    return unknown;
  }
}

/**
 * Last failed frame, bounded to 40 lines; discard identity/credential-bearing lines entirely.
 * Control bytes and OSC titles are removed first.
 */
export function sanitizedScreenFailure(frame: string, error: string, at: string): string {
  const clean = stripAnsi(frame).replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
  const privateLine = /token|api[\s_-]*key|secret|password|credential|authorization|bearer|account|e-?mail|logged in|https?:\/\/|\/Users\/|[\w.+-]+@[\w.-]+|\b[A-Za-z0-9_=-]{32,}\b/i;
  const lines = clean.split("\n").map((line) => privateLine.test(line) ? t("screen.fail.redactedLine") : line.slice(0, 240));
  const safeError = privateLine.test(error) ? t("screen.fail.redactedError") : stripAnsi(error).replace(/[\r\n\x00-\x1f\x7f]/g, " ").slice(0, 180);
  return [`${at} ${safeError}`, ...lines.slice(-FAILURE_LINES)].join("\n") + "\n";
}

export interface ScreenSessionOptions {
  /** `screen -S` name. */
  session: string;
  /** Scratch directory for the screenrc, the hardcopy file, and the stream log. Wiped on open. */
  dir: string;
  /** Working directory of the launched program. */
  cwd: string;
  /** The program to run inside the session. */
  launch: string;
  bin?: string;
  /** Name used in screen error text. Defaults to the binary path. */
  label?: string;
  /** Decides whether a hardcopy can be trusted. Default: not blank. An unusable one falls back to the stream log. */
  usable?: (frame: string) => boolean;
  /** Runs after the old session is quit and before the new one starts. */
  beforeLaunch?: () => Promise<void>;
}

export interface ScreenSession {
  open(): Promise<void>;
  readFrame(): Promise<string>;
  stuff(keys: string): Promise<void>;
  /** Quit the session and stop it plus anything it started and any `extraPids`. Sends no keys. */
  close(extraPids?: () => Promise<number[]>): Promise<void>;
}

/** The screen plumbing both readers share. Keys are sent only through `stuff`, which only the reader calls. */
export function createScreenSession(opts: ScreenSessionOptions): ScreenSession {
  const bin = opts.bin ?? SCREEN_BIN;
  const logPath = join(opts.dir, "screen.log");
  const shot = join(opts.dir, "shot.txt");
  const rc = join(opts.dir, "screenrc");
  const usable = opts.usable ?? ((frame: string) => Boolean(frame.trim()));
  const ctl = (args: string[], timeoutMs: number, cwd?: string) =>
    runProcess(bin, args, timeoutMs, { cwd, env: agentLaunchEnv(), label: opts.label });
  const quit = () => ctl(["-S", opts.session, "-X", "quit"], COMMAND_TIMEOUT_MS).catch(() => {});
  return {
    open: async () => {
      if (!opts.bin && !platformCapabilities().screen) throw new Error(t("screen.unavailable"));
      await rm(opts.dir, { recursive: true, force: true }).catch(() => {});
      await mkdir(opts.dir, { recursive: true });
      await writeFile(
        rc,
        ["logfile " + logPath, "deflog on", "logfile flush 1", "height 50", "width 160", "startup_message off", ""].join("\n"),
        "utf8",
      );
      await quit();
      await opts.beforeLaunch?.();
      await ctl(["-c", rc, "-dmS", opts.session, opts.launch], LAUNCH_TIMEOUT_MS, opts.cwd);
    },
    readFrame: async () => {
      await ctl(["-S", opts.session, "-p", "0", "-X", "hardcopy", shot], COMMAND_TIMEOUT_MS).catch(() => {});
      const frame = await readFile(shot, "utf8").catch(() => "");
      if (usable(frame)) return frame;
      return readFile(logPath, "utf8").catch(() => "");
    },
    stuff: (keys) => ctl(["-S", opts.session, "-p", "0", "-X", "stuff", keys], COMMAND_TIMEOUT_MS),
    close: async (extraPids) => {
      const tree = await screenSessionPids(opts.session, bin);
      await quit();
      const more = extraPids ? await extraPids() : [];
      await finishScreenSession([...tree, ...more]);
    },
  };
}
