/// <reference types="node" />
// Run non-interactive `cursor-agent status` and `--version` in this process's own environment.
// Every 10 minutes while logged in or unknown; every 1 minute while logged out.
// No login, no logout, no interactive UI, no token read.
import { spawn } from "node:child_process";
import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { agentLaunchEnv } from "./cursor-usage";
import { crashNotifyTargets } from "../../shared/fleet/daemon-crash";
import { t } from "../../shared/fleet/i18n";
import {
  type CommandCapture,
  type CursorLoginAlert,
  type CursorLoginNote,
  CURSOR_LOGIN_TIMEOUT_MS,
  CURSOR_STATUS_ARGS,
  CURSOR_VERSION_ARGS,
  alertsFromCursorLogin,
  applyCursorLoginTick,
  cursorLoginIntervalMs,
  cursorLoginNotifyFailureLine,
  normalizeCursorLoginState,
  recordCursorLoginDelivery,
  recordCursorPoolDelivery,
  sampleFromCommands,
  type CursorLoginSample,
  type CursorLoginState,
} from "../../shared/fleet/cursor-login";
import { kanbanConfigPath } from "./paths";
import { baseAdapterOf, CURSOR_API } from "../../shared/fleet/quota-adapters";
import { adapterOn, readOpsProject } from "./adapters/config";
import { readPlanSources } from "./adapters/plans";
import { requestPoolRefreshNow } from "./pool-refresh";
import { BIN, readJson, run, STATE_DIR, writeJson, sendToAgent } from "./util";

export const CURSOR_LOGIN_STATE = join(STATE_DIR, "cursor-login-state.json");
export const CURSOR_LOGIN_LOG = join(STATE_DIR, "cursor-login.log");
const KANBAN_CONFIG = kanbanConfigPath();
const AGENT = join(homedir(), ".local", "bin", "cursor-agent");

export interface CursorLoginView {
  alerts: CursorLoginAlert[];
  notes: CursorLoginNote[];
  state: CursorLoginState;
}

interface CapturedChild {
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: "error", listener: (err: NodeJS.ErrnoException) => void): unknown;
  on(event: "close", listener: () => void): unknown;
}

/** Wait for `close`, which fires after stdout and stderr end. `exit` can run before the last chunk. */
export function captureChild(child: CapturedChild, timeoutMs: number): Promise<CommandCapture> {
  return new Promise((resolve) => {
    let out = "";
    const take = (chunk: Buffer | string) => {
      if (out.length >= 500) return;
      out += String(chunk).slice(0, 500 - out.length);
    };
    let settled = false;
    const finish = (row: CommandCapture) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(row);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ text: "", timedOut: true, missing: false });
    }, timeoutMs);
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    child.on("error", (err: NodeJS.ErrnoException) => {
      finish({ text: "", timedOut: false, missing: err.code === "ENOENT" });
    });
    child.on("close", () => {
      finish({ text: out, timedOut: false, missing: false });
    });
  });
}

function runCapture(args: readonly string[], env: NodeJS.ProcessEnv): Promise<CommandCapture> {
  const child = spawn(AGENT, [...args], { stdio: ["ignore", "pipe", "pipe"], env });
  return captureChild(child, CURSOR_LOGIN_TIMEOUT_MS);
}

function kanbanSupervisorId(config: unknown): string | null {
  if (!config || typeof config !== "object" || Array.isArray(config)) return null;
  const id = (config as { supervisorAgentId?: unknown }).supervisorAgentId;
  if (typeof id !== "string") return null;
  const trimmed = id.trim();
  return trimmed ? trimmed : null;
}

/** Pool stop and resume go only to the Kanban leader named by supervisorAgentId. */
async function notifyKanbanLeader(notice: string): Promise<boolean> {
  const id = kanbanSupervisorId(await readJson<unknown>(KANBAN_CONFIG, null));
  if (!id) {
    console.error("[afc] cursor login: no Kanban <leader> id, skipping this round of notices");
    return false;
  }
  try {
    await sendToAgent(id, t("screen.leaderNote", { text: notice }));
    return true;
  } catch (error) {
    console.error("[afc] cursor login notify:", String(error).slice(0, 160));
    return false;
  }
}

async function notifyLeaders(notice: string): Promise<boolean> {
  const ids = crashNotifyTargets(await readJson<unknown>(KANBAN_CONFIG, null), readOpsProject());
  if (ids.length === 0) {
    console.error("[afc] cursor login: no <leader> id, skipping this round of notices");
    return false;
  }
  const text = t("screen.leaderNote", { text: notice });
  let sent = true;
  for (const id of ids) {
    try {
      await sendToAgent(id, text);
    } catch (error) {
      sent = false;
      console.error("[afc] cursor login notify:", String(error).slice(0, 160));
    }
  }
  return sent;
}

async function recordNotifyFailure(at: number, attempts: number, logPath = CURSOR_LOGIN_LOG): Promise<void> {
  const line = cursorLoginNotifyFailureLine(at, attempts);
  console.error(`[afc] cursor login: ${line}`);
  await mkdir(dirname(logPath), { recursive: true });
  await appendFile(logPath, `${line}\n`, "utf8");
}

export interface CursorLoginPublishEffects {
  writeState: (state: CursorLoginState) => Promise<void>;
  /** Fired after the new login state is on disk. Must not wait for notifications. */
  refreshPools: () => void;
  notifyLeaders: (notice: string) => Promise<boolean>;
  notifyPool: (notice: string) => Promise<boolean>;
  recordFailure: (at: number, attempts: number) => Promise<void>;
}

/**
 * Persist the new login state and kick a pool refresh before any `paseo send`.
 * Delivery flags are written again after the notices. A failed failure-log does not
 * undo the state write or the refresh.
 */
export async function publishCursorLoginTick(
  prev: CursorLoginState,
  sample: CursorLoginSample,
  now: number,
  effects: CursorLoginPublishEffects,
  poolDispatch = true,
): Promise<void> {
  const tick = applyCursorLoginTick(prev, sample, now, poolDispatch);
  if (tick.note) console.error(`[afc] cursor login: ${tick.note}`);
  let state = tick.state;
  await effects.writeState(state);
  if (tick.refreshPools) effects.refreshPools();

  let deliver = false;
  if (tick.notify && tick.notice) {
    deliver = true;
    let sent = false;
    try {
      sent = await effects.notifyLeaders(tick.notice);
    } catch (error) {
      console.error("[afc] cursor login notify:", String(error).slice(0, 160));
    }
    state = recordCursorLoginDelivery(state, sent);
    if (!sent) {
      try {
        await effects.recordFailure(now, state.notifyAttempts);
      } catch (error) {
        console.error("[afc] cursor login:", String(error).slice(0, 200));
      }
    }
  }
  if (tick.poolNotify && tick.poolNotice && tick.poolKind) {
    deliver = true;
    let sent = false;
    try {
      sent = await effects.notifyPool(tick.poolNotice);
    } catch (error) {
      console.error("[afc] cursor login notify:", String(error).slice(0, 160));
    }
    state = recordCursorPoolDelivery(state, tick.poolKind, sent);
    if (!sent) {
      const attempts = tick.poolKind === "stop" ? state.poolStopAttempts : state.poolResumeAttempts;
      try {
        await effects.recordFailure(now, attempts);
      } catch (error) {
        console.error("[afc] cursor login:", String(error).slice(0, 200));
      }
    }
  }
  if (deliver) {
    try {
      await effects.writeState(state);
    } catch (error) {
      console.error("[afc] cursor login:", String(error).slice(0, 200));
    }
  }
}

async function runOnce(statePath = CURSOR_LOGIN_STATE): Promise<void> {
  const prev = normalizeCursorLoginState(await readJson<unknown>(statePath, null));
  const env = agentLaunchEnv();
  const [status, version] = await Promise.all([
    runCapture(CURSOR_STATUS_ARGS, env),
    runCapture(CURSOR_VERSION_ARGS, env),
  ]);
  const plan = (await readPlanSources()).find((p) => baseAdapterOf(p) === CURSOR_API) as { dispatch?: unknown } | undefined;
  const poolDispatch = plan?.dispatch !== false;
  await publishCursorLoginTick(prev, sampleFromCommands(status, version), Date.now(), {
    writeState: (state) => writeJson(statePath, state),
    refreshPools: requestPoolRefreshNow,
    notifyLeaders,
    notifyPool: notifyKanbanLeader,
    recordFailure: (at, attempts) => recordNotifyFailure(at, attempts),
  }, poolDispatch);
}

let inflight: Promise<void> | null = null;

/** One status plus one --version. Overlapping calls share the same run. */
/** One `cursor-agent status` round. Nothing runs while the cursor-api adapter is off. */
export function checkCursorLogin(): Promise<void> {
  if (!adapterOn(CURSOR_API)) return Promise.resolve();
  if (!inflight) {
    inflight = runOnce()
      .catch((error) => {
        console.error("[afc] cursor login:", String(error).slice(0, 200));
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

/** The login watch's state and alerts. Empty while the cursor-api adapter is off. */
export async function readCursorLoginView(): Promise<CursorLoginView> {
  if (!adapterOn(CURSOR_API)) {
    const state = normalizeCursorLoginState(null);
    return { alerts: [], notes: state.notes, state };
  }
  const state = normalizeCursorLoginState(await readJson<unknown>(CURSOR_LOGIN_STATE, null));
  return { alerts: alertsFromCursorLogin(state), notes: state.notes, state };
}

async function nextLoginDelay(): Promise<number> {
  const state = normalizeCursorLoginState(await readJson<unknown>(CURSOR_LOGIN_STATE, null));
  return cursorLoginIntervalMs(state.login);
}

export function startCursorLoginWatch(): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const arm = (delay: number) => {
    if (stopped) return;
    timer = setTimeout(() => {
      void checkCursorLogin().finally(() => {
        void nextLoginDelay().then((ms) => arm(ms));
      });
    }, delay);
  };
  const first = setTimeout(() => {
    void checkCursorLogin().finally(() => {
      void nextLoginDelay().then((ms) => arm(ms));
    });
  }, 15_000);
  return () => {
    stopped = true;
    clearTimeout(first);
    if (timer) clearTimeout(timer);
  };
}
