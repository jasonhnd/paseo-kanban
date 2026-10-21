/// <reference types="node" />
// Shared skeleton for the two terminal readers (cursor-usage.ts, grok-usage.ts).
// Both start a TUI inside `/usr/bin/screen`, poll its frame, type at most one command, and then stop
// only the processes this read started. Nothing in here types a key by itself: the callers decide.
import { platformCapabilities } from "./platform";
import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { t } from "../../shared/fleet/i18n";

export const SCREEN_BIN = "/usr/bin/screen";
const COMMAND_TIMEOUT_MS = 5_000;
const LAUNCH_TIMEOUT_MS = 15_000;
const KILL_WAIT_MS = 1_000;
const KILL_GRACE_MS = 400;
const CLEANUP_ATTEMPTS = 3;
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

interface ScreenRef {
  id: string;
  pid: number;
  dead: boolean;
}

interface SessionTree {
  pids: number[];
  groups: number[];
}

/** Unlike captureOutput, cleanup must distinguish a failed lookup from an empty result. */
function cleanupOutput(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { env, timeout: COMMAND_TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      // macOS screen also returns 1 for a valid -ls/-wipe listing with live sockets.
      const listing = ["-ls", "-wipe"].includes(args[0]) && error?.code === 1
        && (/No Sockets found/i.test(stdout) || /^\s*\d+\.\S+\s+\(/m.test(stdout));
      const gone = error?.code === 1 && /No screen session found/i.test(stdout);
      if (error && !listing && !gone) {
        reject(new Error(`Screen cleanup command ${args[0]} failed (${error.killed ? "timeout" : error.code ?? "unknown error"})`));
      } else resolve(stdout);
    });
  });
}

async function screenSessions(session: string, bin: string, env: NodeJS.ProcessEnv): Promise<ScreenRef[]> {
  const listed = await cleanupOutput(bin, ["-ls"], env);
  return listed.split("\n").flatMap((line): ScreenRef[] => {
    const match = /^\s*(\d+)\.([^\s]+)\s+\(([^)]+)\)/.exec(line);
    if (!match || match[2] !== session) return [];
    const pid = Number(match[1]);
    const dead = /dead/i.test(match[3]);
    if (!Number.isSafeInteger(pid) || pid <= 1 || !dead && pid === process.pid) throw new Error("Invalid screen session PID");
    return [{ id: `${pid}.${match[2]}`, pid, dead }];
  });
}

/** One bounded process-table snapshot, with no arbitrary depth or per-child command timeout. */
async function sessionTree(root: number, env: NodeJS.ProcessEnv): Promise<SessionTree> {
  const out = await cleanupOutput("/bin/ps", ["-ax", "-o", "pid=,ppid=,pgid="], env);
  const rows = out.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
    return match ? [{ pid: Number(match[1]), parent: Number(match[2]), group: Number(match[3]) }] : [];
  });
  const seen = new Set<number>([root]);
  const pids = [root];
  const children = new Map<number, number[]>();
  for (const row of rows) {
    const siblings = children.get(row.parent) ?? [];
    siblings.push(row.pid);
    children.set(row.parent, siblings);
  }
  for (let index = 0; index < pids.length; index++) {
    for (const pid of children.get(pids[index]) ?? []) {
      if (pid <= 1 || pid === process.pid || seen.has(pid)) continue;
      seen.add(pid);
      pids.push(pid);
    }
  }
  const ownGroup = rows.find((row) => row.pid === process.pid)?.group;
  const rootGroup = rows.find((row) => row.pid === root)?.group;
  // A window's process group also contains children forked during shutdown. Only groups
  // whose leader belongs to this tree qualify; never signal the screen or plugin group.
  const groups = rows.filter((row) => seen.has(row.pid) && row.pid === row.group
    && row.group !== rootGroup && row.group !== ownGroup).map((row) => row.group);
  return { pids, groups };
}

/** Exact session name only; dead socket PIDs are never used as process identities. */
export async function screenSessionPids(session: string, bin: string = SCREEN_BIN, baseEnv?: NodeJS.ProcessEnv): Promise<number[]> {
  const env = agentLaunchEnv(baseEnv);
  const live = (await screenSessions(session, bin, env)).filter((ref) => !ref.dead);
  if (live.length > 1) throw new Error("Ambiguous screen session name");
  return live[0] ? (await sessionTree(live[0].pid, env)).pids : [];
}

export interface KillDeps {
  kill: (pid: number, signal: NodeJS.Signals | 0) => void;
  sleep: (ms: number) => Promise<void>;
  self?: number;
  log?: (message: string) => void;
}

const cleanupLog = (message: string): void => console.error(`[afc] screen cleanup: ${message}`);
const defaultKillDeps: KillDeps = { kill: (pid, signal) => process.kill(pid, signal), sleep, log: cleanupLog };

/** TERM first, then KILL surviving targets, and bound the final wait. groups must be owned window groups. */
export async function finishScreenSession(pids: number[], deps: KillDeps = defaultKillDeps, groups: number[] = []): Promise<void> {
  const self = deps.self ?? process.pid;
  const safePid = (pid: number) => Number.isSafeInteger(pid) && pid > 1 && pid !== self;
  const mine = [...new Set(pids)].filter(safePid).reverse();
  const targets = [...mine, ...[...new Set(groups)].filter(safePid).map((pid) => -pid)];
  const log = deps.log ?? cleanupLog;
  const signal = (pid: number, sig: NodeJS.Signals | 0): boolean => {
    try { deps.kill(pid, sig); return true; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ESRCH") return false;
      log(`Could not send ${sig} to process target ${pid} (${code ?? "unknown error"})`);
      return true;
    }
  };
  const alive = () => targets.filter((pid) => signal(pid, 0));
  const running = alive();
  if (!running.length) return;
  for (const pid of running) signal(pid, "SIGTERM");
  await deps.sleep(KILL_GRACE_MS);
  const remaining = alive();
  if (!remaining.length) return;
  log(`Escalating ${remaining.length} process target(s) to SIGKILL`);
  for (const pid of remaining) signal(pid, "SIGKILL");
  for (let waited = 0; waited < KILL_WAIT_MS; waited += 50) {
    if (!alive().length) return;
    await deps.sleep(50);
  }
  if (alive().length) {
    const message = "Process targets remain after the SIGKILL deadline";
    log(message);
    throw new Error(message);
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
  /** Optional environment for an isolated screen socket directory and fake CLI. */
  env?: NodeJS.ProcessEnv;
  /** Name used in screen error text. Defaults to the binary path. */
  label?: string;
  /** Decides whether a hardcopy can be trusted. Default: not blank. An unusable one falls back to the stream log. */
  usable?: (frame: string) => boolean;
}

export interface ScreenSession {
  open(): Promise<void>;
  readFrame(): Promise<string>;
  stuff(keys: string): Promise<void>;
  /** Stop the owned process tree before quitting the exact session, then remove its dead socket. */
  close(): Promise<void>;
}

/** The screen plumbing both readers share. Keys are sent only through `stuff`, which only the reader calls. */
export function createScreenSession(opts: ScreenSessionOptions): ScreenSession {
  const bin = opts.bin ?? SCREEN_BIN;
  const env = agentLaunchEnv(opts.env);
  const logPath = join(opts.dir, "screen.log");
  const shot = join(opts.dir, "shot.txt");
  const rc = join(opts.dir, "screenrc");
  const usable = opts.usable ?? ((frame: string) => Boolean(frame.trim()));
  const ctl = (args: string[], timeoutMs: number, cwd?: string) =>
    runProcess(bin, args, timeoutMs, { cwd, env, label: opts.label });
  const cleanupAttempt = async (): Promise<void> => {
    try {
      const refs = await screenSessions(opts.session, bin, env);
      if (!refs.length) return;
      if (refs.filter((ref) => !ref.dead).length > 1) throw new Error("Ambiguous screen session name");
      for (const ref of refs) {
        try {
          if (!ref.dead) {
            // Keep the terminal alive until the CLI tree is gone. Quitting first sends HUP
            // and can orphan a raw-mode CLI that ignores it. An inspection failure leaves
            // the terminal intact rather than turning an unknown tree into orphaned work.
            const tree = await sessionTree(ref.pid, env);
            await finishScreenSession(tree.pids.filter((pid) => pid !== ref.pid), defaultKillDeps, tree.groups);
            try { await cleanupOutput(bin, ["-S", ref.id, "-X", "quit"], env); }
            catch (error) { cleanupLog(describeError(error)); }
            // A hung or failed control command cannot leave the owned screen server alive.
            await finishScreenSession([ref.pid]);
          }
        } finally {
          // Full PID.name matcher only: never run a global wipe or use a dead socket's PID.
          await cleanupOutput(bin, ["-wipe", ref.id], env);
        }
      }
      const remaining = await screenSessions(opts.session, bin, env);
      if (remaining.some((ref) => refs.some((old) => old.id === ref.id))) {
        throw new Error("Screen session remains after cleanup");
      }
    } catch (error) {
      cleanupLog(describeError(error));
      throw error;
    }
  };
  const cleanup = async (): Promise<void> => {
    for (let attempt = 1; ; attempt++) {
      try { return await cleanupAttempt(); }
      catch (error) {
        if (attempt >= CLEANUP_ATTEMPTS) throw error;
        // Reinspect the exact session on every attempt. A timed-out ps or screen
        // command must not turn a transient load spike into an abandoned terminal.
        cleanupLog(`Retrying cleanup (${attempt}/${CLEANUP_ATTEMPTS})`);
        await sleep(100);
      }
    }
  };
  let pending = Promise.resolve();
  const serialized = (action: () => Promise<void>): Promise<void> => {
    const next = pending.then(action);
    pending = next.catch(() => {});
    return next;
  };
  return {
    open: () => serialized(async () => {
      if (!opts.bin && !platformCapabilities().screen) throw new Error(t("screen.unavailable"));
      await cleanup();
      await rm(opts.dir, { recursive: true, force: true }).catch(() => {});
      await mkdir(opts.dir, { recursive: true });
      await writeFile(
        rc,
        ["logfile " + logPath, "deflog on", "logfile flush 1", "height 50", "width 160", "startup_message off", ""].join("\n"),
        "utf8",
      );
      try {
        await ctl(["-c", rc, "-dmS", opts.session, opts.launch], LAUNCH_TIMEOUT_MS, opts.cwd);
      } catch (error) {
        // The launcher may fail or time out after the daemon and CLI have already started.
        await cleanup().catch(() => {});
        throw error;
      }
    }),
    readFrame: async () => {
      await ctl(["-S", opts.session, "-p", "0", "-X", "hardcopy", shot], COMMAND_TIMEOUT_MS).catch(() => {});
      const frame = await readFile(shot, "utf8").catch(() => "");
      if (usable(frame)) return frame;
      return readFile(logPath, "utf8").catch(() => "");
    },
    stuff: (keys) => ctl(["-S", opts.session, "-p", "0", "-X", "stuff", keys], COMMAND_TIMEOUT_MS),
    // Cancellation can request close while the detached launcher is still running.
    // Wait for that launch (including its failure cleanup) before inspecting again.
    close: () => serialized(cleanup),
  };
}
