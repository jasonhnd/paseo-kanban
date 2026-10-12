/// <reference types="node" />
// Once a minute, read the new tail of ~/.paseo/daemon.log and remember crashes.
// Every 10 minutes, ask Kanban's check-missing-cwd how many agents have a missing directory.
// This file only reads logs and runs that script. It never opens an agent.
import { existsSync } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  type CrashState,
  type DaemonAlert,
  absorbLines,
  alertsFromState,
  assessMissingCwd,
  crashNotifyTargets,
  emptyCrashState,
  normalizeCrashState,
  planRead,
  takeComplete,
} from "../../shared/fleet/daemon-crash";
import { kanbanConfigPath, kanbanRoot } from "./paths";
import { readOpsProject } from "./adapters/config";
import { BIN, PASEO_DIR, readJson, run, runOutcome, STATE_DIR, writeJson, sendToAgent } from "./util";

export const CRASH_STATE_PATH = join(STATE_DIR, "daemon-crash-state.json");
const KANBAN_ROOT = kanbanRoot();
export const MISSING_CWD_SCRIPT = join(KANBAN_ROOT, "bin", "check-missing-cwd");
const KANBAN_CONFIG = kanbanConfigPath();
const SCAN_MS = 60_000;
const MISSING_MS = 10 * 60_000;
const DAEMON_LOG = "daemon.log";

export interface ScanResult {
  state: CrashState;
  notify: boolean;
  notice: string;
}

export async function scanDaemonDir(dir: string, state: CrashState, now: number): Promise<ScanResult> {
  const daemonPath = join(dir, DAEMON_LOG);
  let daemonStat: { inode: string; size: number };
  try {
    const info = await stat(daemonPath);
    daemonStat = { inode: String(info.ino), size: info.size };
  } catch {
    return { state, notify: false, notice: "" };
  }
  const rotated = await newestRotated(dir);
  const plan = planRead(state, daemonStat, rotated);
  if (plan.bootstrap) {
    const text = await readRange(daemonPath, 0, daemonStat.size);
    const taken = finishAtEof(takeComplete("", text));
    const absorbed = absorbLines(state, taken.lines, now, true);
    return {
      state: { ...absorbed.state, pending: taken.pending, inode: daemonStat.inode, offset: daemonStat.size, bootstrapped: true },
      notify: false,
      notice: "",
    };
  }

  let next = state;
  let notify = false;
  let notice = "";
  const keep = (absorbed: ReturnType<typeof absorbLines>, pending: string) => {
    next = { ...absorbed.state, pending };
    if (absorbed.notify) {
      notify = true;
      notice = absorbed.notice;
    }
  };

  if (plan.rotatedFrom !== null && rotated) {
    const text = await readRange(rotated.path, plan.rotatedFrom, rotated.size);
    const taken = takeComplete(next.pending, text);
    const lines = taken.pending ? [...taken.lines, taken.pending] : taken.lines;
    keep(absorbLines(next, lines, now, false), "");
  } else if (plan.daemonFrom === 0) {
    next = { ...next, pending: "" };
  }

  const text = await readRange(daemonPath, plan.daemonFrom, daemonStat.size);
  const taken = finishAtEof(takeComplete(next.pending, text));
  keep(absorbLines(next, taken.lines, now, false), taken.pending);
  return {
    state: { ...next, inode: daemonStat.inode, offset: daemonStat.size, bootstrapped: true },
    notify,
    notice,
  };
}

async function newestRotated(dir: string): Promise<{ path: string; inode: string; size: number } | null> {
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch {
    return null;
  }
  const hits = names.filter((name) => name !== DAEMON_LOG && name.endsWith("-daemon.log"));
  const stats = await Promise.all(hits.map(async (name) => {
    const path = join(dir, name);
    try {
      const info = await stat(path);
      return { path, inode: String(info.ino), size: info.size, mtime: info.mtimeMs, name };
    } catch {
      return null;
    }
  }));
  const ready = stats.filter((row): row is NonNullable<typeof row> => row !== null);
  ready.sort((a, b) => b.mtime - a.mtime || b.name.localeCompare(a.name));
  return ready[0] ?? null;
}

/** A last line with no newline is still a crash if it is already one JSON object. */
function finishAtEof(taken: { lines: string[]; pending: string }): { lines: string[]; pending: string } {
  const trimmed = taken.pending.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return taken;
  try {
    JSON.parse(trimmed);
  } catch {
    return taken;
  }
  return { lines: [...taken.lines, trimmed], pending: "" };
}

async function readRange(path: string, start: number, end: number): Promise<string> {
  if (!(end > start)) return "";
  const fh = await open(path, "r");
  try {
    const len = end - start;
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, start);
    return buf.subarray(0, bytesRead).toString("utf8");
  } finally {
    await fh.close();
  }
}

export async function checkMissingCwd(now: number): Promise<CrashState["missing"]> {
  if (!existsSync(MISSING_CWD_SCRIPT)) {
    return assessMissingCwd({ exists: false, ok: false, timedOut: false, stdout: "", exitCode: null }, now, KANBAN_ROOT);
  }
  const outcome = await runOutcome(MISSING_CWD_SCRIPT, ["--json"], 10_000);
  return assessMissingCwd({
    exists: true,
    ok: outcome.ok,
    timedOut: outcome.timedOut,
    stdout: outcome.stdout,
    exitCode: outcome.exitCode,
  }, now, KANBAN_ROOT);
}

export async function readDaemonHealth(now = Date.now()): Promise<{ today: number; crash: DaemonAlert | null; missing: DaemonAlert | null }> {
  const state = normalizeCrashState(await readJson<unknown>(CRASH_STATE_PATH, null));
  return alertsFromState(state, now);
}

async function runTick(): Promise<void> {
  const prev = normalizeCrashState(await readJson<unknown>(CRASH_STATE_PATH, null));
  const now = Date.now();
  const scanned = await scanDaemonDir(PASEO_DIR, prev, now);
  let next = scanned.state;
  const due = next.missing.checkedAt === null || now - next.missing.checkedAt >= MISSING_MS;
  if (due) next = { ...next, missing: await checkMissingCwd(now) };
  await writeJson(CRASH_STATE_PATH, next);
  if (!scanned.notify || !scanned.notice) return;
  await notifyDaemonCrash(scanned.notice);
}

/** Read the current operations project at delivery time. */
export async function notifyDaemonCrash(notice: string, notify = sendToAgent): Promise<void> {
  const ids = crashNotifyTargets(await readJson<unknown>(KANBAN_CONFIG, null), readOpsProject());
  if (ids.length === 0) {
    console.error("[afc] daemon crash: no <leader> id, no notice for this wave");
    return;
  }
  for (const id of ids) {
    try {
      await notify(id, notice);
    } catch (error) {
      console.error("[afc] daemon crash notify:", String(error).slice(0, 200));
    }
  }
}

/** First pass immediately, then every minute. The missing-directory script runs at most every 10 minutes. */
export function startDaemonWatch(): () => void {
  let timer: ReturnType<typeof setInterval> | null = null;
  let scanning = false;
  const tick = () => {
    if (scanning) return;
    scanning = true;
    void runTick()
      .catch((error) => console.error("[afc] daemon crash:", String(error).slice(0, 200)))
      .finally(() => {
        scanning = false;
      });
  };
  tick();
  timer = setInterval(tick, SCAN_MS);
  return () => {
    if (timer) clearInterval(timer);
  };
}

export { emptyCrashState };
