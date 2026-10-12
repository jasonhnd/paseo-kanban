/// <reference types="node" />
// Once a minute, check that the login keychain can answer an existence query.
// The commands never ask for a secret. Stdout from `security` is discarded.
// Logs keep the exit code, an error type, and timing — never attribute values.
import { execFile } from "node:child_process";
import { appendFile, mkdir, open, readdir, rename, stat } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { crashNotifyTargets } from "../../shared/fleet/daemon-crash";
import { t } from "../../shared/fleet/i18n";
import { CURSOR_API, KEYCHAIN } from "../../shared/fleet/quota-adapters";
import { platformCapabilities } from "./platform";
import { adapterOn, readOpsProject } from "./adapters/config";
import {
  alertsFromProbe,
  applyProbeTick,
  AUTH_KEEP_MS,
  AUTH_SCAN_INTERVAL_MS,
  CLAUDE_KEYCHAIN_SERVICE,
  AUTH_TAIL_BYTES,
  consumeAuthBuffer,
  CURSOR_KEYCHAIN_SERVICE,
  existenceArgs,
  firstAuthOffset,
  keepAuthCursors,
  formatProbeLine,
  formatRecoveryLine,
  formatRerunFailLine,
  formatRerunLine,
  isSafeProbeLine,
  keychainAlertText,
  mergeAuthEvents,
  normalizeProbeState,
  noteRemind,
  noteRerun,
  parseLoadavg,
  parseScreenLocked,
  planScheduleReruns,
  PROBE_INTERVAL_MS,
  type ProbeAlert,
  type ProbeContext,
  type ProbeState,
  RERUN_INTERVAL_MS,
  type ScheduleCandidate,
  type ServiceProbe,
  shouldRotate,
  toServiceProbe,
} from "../../shared/fleet/keychain-probe";
import { kanbanConfigPath } from "./paths";
import { BIN, HOME, readJson, run, runJson, runOutcome, STATE_DIR, writeJson, sendToAgent } from "./util";

export const PROBE_LOG = join(STATE_DIR, "keychain-probe.log");
export const PROBE_STATE = join(STATE_DIR, "keychain-probe-state.json");
export const PROJECTS_ROOT = join(HOME, ".claude", "projects");
const KANBAN_CONFIG = kanbanConfigPath();
/** AFC_SECURITY_BIN lets the offline harness stand in for the real keychain tool. */
const SECURITY = process.env.AFC_SECURITY_BIN || "/usr/bin/security";
const LOGIN_KEYCHAIN = join(HOME, "Library", "Keychains", "login.keychain-db");

interface QuietResult {
  exitCode: number | null;
  timedOut: boolean;
  stderr: string;
  stdout: string;
  ms: number;
}

function execQuiet(cmd: string, args: string[], timeoutMs: number, maxBuffer = 1024 * 1024): Promise<QuietResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer, env: { ...process.env, LC_ALL: "C" } }, (err, stdout, stderr) => {
      const ms = Date.now() - started;
      if (!err) {
        resolve({ exitCode: 0, timedOut: false, stderr: String(stderr ?? ""), stdout: String(stdout ?? ""), ms });
        return;
      }
      const rawCode = (err as { code?: unknown }).code;
      const timedOut = Boolean((err as { killed?: boolean }).killed) || rawCode === "ETIMEDOUT";
      resolve({
        exitCode: typeof rawCode === "number" ? rawCode : null,
        timedOut,
        stderr: String(stderr || ""),
        stdout: String(stdout ?? ""),
        ms,
      });
    });
  });
}

async function probeService(service: string): Promise<ServiceProbe> {
  const outcome = await execQuiet(SECURITY, existenceArgs(service), 3_000);
  return toServiceProbe(service, outcome);
}

async function screenLocked(): Promise<ProbeContext["locked"]> {
  const out = await execQuiet("/usr/sbin/ioreg", ["-l", "-w0", "-d", "4", "-n", "Root"], 8_000, 16 * 1024 * 1024);
  if (out.timedOut) return "unknown";
  return parseScreenLocked(out.stdout);
}

async function loadavg(): Promise<string> {
  const out = await execQuiet("/usr/sbin/sysctl", ["-n", "vm.loadavg"], 2_000);
  return parseLoadavg(out.stdout);
}

async function countComm(name: string): Promise<number> {
  const out = await execQuiet("/usr/bin/pgrep", ["-x", name], 2_000);
  return out.stdout.split("\n").filter((line) => /^\d+$/.test(line.trim())).length;
}

async function securitydStart(): Promise<string> {
  const found = await execQuiet("/usr/bin/pgrep", ["-x", "securityd"], 2_000);
  const pid = found.stdout.split("\n").map((line) => line.trim()).find((line) => /^\d+$/.test(line));
  if (!pid) return "unknown";
  const ps = await execQuiet("/bin/ps", ["-o", "lstart=", "-p", pid], 2_000);
  return ps.stdout.trim() || "unknown";
}

async function readContext(): Promise<ProbeContext> {
  const info = await execQuiet(SECURITY, ["show-keychain-info", LOGIN_KEYCHAIN], 3_000);
  const [locked, load, securityd, claudeProcs, cursorProcs] = await Promise.all([
    screenLocked(),
    loadavg(),
    securitydStart(),
    countComm("claude"),
    countComm("cursor-agent"),
  ]);
  return {
    keychainInfoExit: info.exitCode,
    locked,
    load,
    securitydStart: securityd,
    claudeProcs,
    cursorProcs,
  };
}

export async function appendProbeLog(path: string, line: string): Promise<void> {
  if (!isSafeProbeLine(line)) {
    console.error("[afc] keychain probe: refused a log line that carries attribute values");
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  const info = await stat(path).catch(() => null);
  if (info && shouldRotate(info.size)) await rename(path, `${path}.1`).catch(() => undefined);
  await appendFile(path, `${line}\n`, "utf8");
}

function sessionOf(filePath: string): string {
  const rel = relative(PROJECTS_ROOT, filePath);
  const top = rel.split("/")[0] || "unknown";
  return `${top}/${basename(filePath)}`.slice(0, 240);
}

async function readNewBytes(path: string, offset: number, size: number): Promise<{ times: number[]; nextOffset: number }> {
  if (!(size > offset)) return { times: [], nextOffset: offset };
  const fh = await open(path, "r");
  const times: number[] = [];
  let pos = offset;
  try {
    while (pos < size) {
      const len = Math.min(512 * 1024, size - pos);
      const buf = Buffer.alloc(len);
      const { bytesRead } = await fh.read(buf, 0, len, pos);
      if (bytesRead <= 0) break;
      const chunk = buf.subarray(0, bytesRead);
      const taken = consumeAuthBuffer(chunk);
      times.push(...taken.times);
      if (taken.consumedBytes <= 0) {
        if (pos + bytesRead >= size) break;
        pos += bytesRead;
      } else {
        pos += taken.consumedBytes;
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
  } finally {
    await fh.close();
  }
  return { times, nextOffset: pos };
}

async function walkJsonl(dir: string, depth: number, visit: (path: string, inode: string, size: number, mtimeMs: number) => Promise<void>): Promise<void> {
  if (depth > 3) return;
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error("[afc] keychain probe: cannot read directory", dir, String(error).slice(0, 120));
    return;
  }
  for (const name of names) {
    const path = join(dir, name);
    const info = await stat(path).catch(() => null);
    if (!info) continue;
    if (info.isDirectory()) {
      await walkJsonl(path, depth + 1, visit);
      continue;
    }
    if (!name.endsWith(".jsonl")) continue;
    await visit(path, String(info.ino), info.size, info.mtimeMs);
  }
}

async function scanAuth(state: ProbeState, now: number): Promise<ProbeState> {
  const fresh: ProbeState["authCursors"] = {};
  const present = new Map<string, number>();
  const added: ProbeState["authEvents"] = [];
  await walkJsonl(PROJECTS_ROOT, 0, async (path, inode, size, mtimeMs) => {
    await new Promise((resolve) => setImmediate(resolve));
    present.set(path, mtimeMs);
    if (now - mtimeMs > AUTH_KEEP_MS) return;
    const prev = state.authCursors[path];
    if (prev && prev.inode === inode && prev.offset >= size) {
      fresh[path] = prev;
      return;
    }
    const previous = prev && prev.inode === inode ? prev.offset : null;
    const read = await readNewBytes(path, firstAuthOffset(size, previous, AUTH_TAIL_BYTES), size);
    const session = sessionOf(path);
    for (const at of read.times) added.push({ at, session });
    fresh[path] = { inode, offset: read.nextOffset };
  });
  return {
    ...state,
    authEvents: mergeAuthEvents(state.authEvents, added, now),
    authCursors: keepAuthCursors(fresh, present, now),
    authCheckedAt: now,
  };
}

interface ScheduleRow {
  id: string;
  name: string;
  status: string;
}

async function listSchedules(): Promise<ScheduleRow[]> {
  const raw = await runJson<unknown>(BIN.paseo, ["schedule", "ls", "--json"], 15_000);
  if (!Array.isArray(raw)) return [];
  const rows: ScheduleRow[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const id = typeof row.id === "string" ? row.id : "";
    const name = typeof row.name === "string" ? row.name.replace(/[\r\n]/g, " ").slice(0, 80) : "";
    const status = typeof row.status === "string" ? row.status : "";
    if (!id || !name) continue;
    rows.push({ id, name, status });
  }
  return rows;
}

async function latestRun(id: string): Promise<{ runId: string; startedAt: number; output: string } | null> {
  const raw = await runJson<unknown>(BIN.paseo, ["schedule", "inspect", id, "--json"], 20_000);
  if (!raw || typeof raw !== "object") return null;
  const runs = (raw as { runs?: unknown }).runs;
  if (!Array.isArray(runs)) return null;
  let best: { runId: string; startedAt: number; output: string } | null = null;
  for (const item of runs) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const runId = typeof row.id === "string" ? row.id : "";
    const startedAt = typeof row.startedAt === "string" ? Date.parse(row.startedAt) : NaN;
    const output = typeof row.output === "string" ? row.output.slice(0, 40) : "";
    if (!runId || Number.isNaN(startedAt)) continue;
    if (!best || startedAt > best.startedAt) best = { runId, startedAt, output };
  }
  return best;
}

async function scheduleCandidates(schedules: ScheduleRow[]): Promise<ScheduleCandidate[]> {
  const candidates: ScheduleCandidate[] = [];
  for (const schedule of schedules) {
    try {
      const latest = await latestRun(schedule.id);
      if (!latest) continue;
      candidates.push({
        scheduleId: schedule.id,
        name: schedule.name,
        scheduleStatus: schedule.status,
        runId: latest.runId,
        startedAt: latest.startedAt,
        output: latest.output,
      });
    } catch (error) {
      console.error("[afc] keychain probe: reading schedule runs failed", schedule.id, String(error).slice(0, 120));
    }
  }
  return candidates;
}

async function rerunSchedules(state: ProbeState, now: number, logPath: string): Promise<ProbeState> {
  let schedules: ScheduleRow[] = [];
  try {
    schedules = await listSchedules();
  } catch (error) {
    console.error("[afc] keychain probe: reading schedules failed", String(error).slice(0, 160));
    return { ...state, rerunCheckedAt: now };
  }
  const candidates = await scheduleCandidates(schedules);
  const reminded = new Set(state.remindNotices.map((notice) => notice.runId));
  const plan = planScheduleReruns({
    now,
    probeOk: state.probeOk,
    alreadyRerun: new Set(state.reranRunIds),
    alreadyReminded: reminded,
    lastRerunAt: state.rerunAtBySchedule,
    schedules: candidates,
  });
  let next = state;
  for (const row of plan.remind) next = noteRemind(next, row, now, "foreign");
  for (const row of plan.stillOut) next = noteRemind(next, row, now, "still-out");
  for (const row of plan.rerun) {
    const outcome = await runOutcome(BIN.paseo, ["schedule", "run-once", row.scheduleId], 30_000);
    if (!outcome.ok) {
      await appendProbeLog(logPath, formatRerunFailLine(now, row.scheduleId, outcome.exitCode));
      continue;
    }
    next = noteRerun(next, row, now);
    await appendProbeLog(logPath, formatRerunLine(now, row.scheduleId, row.name));
  }
  return { ...next, rerunCheckedAt: now };
}

async function notifySupervisors(): Promise<void> {
  const ids = crashNotifyTargets(await readJson<unknown>(KANBAN_CONFIG, null), readOpsProject());
  if (ids.length === 0) {
    console.error("[afc] keychain probe: no <leader> id, skipping this round of notices");
    return;
  }
  const text = t("screen.leaderNote", { text: keychainAlertText() });
  for (const id of ids) {
    try {
      await sendToAgent(id, text);
    } catch (error) {
      console.error("[afc] keychain probe notify:", String(error).slice(0, 160));
    }
  }
}

async function runTick(logPath = PROBE_LOG, statePath = PROBE_STATE): Promise<void> {
  if (!platformCapabilities().keychain) return;
  const prev = normalizeProbeState(await readJson<unknown>(statePath, null));
  const now = Date.now();
  // Cursor's entry is probed only while the cursor-api adapter is on; otherwise there is nothing to report about it.
  const cursorOn = adapterOn(CURSOR_API);
  const services = [await probeService(CLAUDE_KEYCHAIN_SERVICE), ...(cursorOn ? [await probeService(CURSOR_KEYCHAIN_SERVICE)] : [])];
  const ctx = await readContext();
  const probed = applyProbeTick(prev, services, now);
  const tick = cursorOn ? probed : { ...probed, state: { ...probed.state, cursorError: null } };
  await appendProbeLog(logPath, formatProbeLine(now, services, ctx));
  if (tick.recovered) await appendProbeLog(logPath, formatRecoveryLine(now));
  let state = tick.state;
  if (tick.notify) {
    try {
      await notifySupervisors();
    } catch (error) {
      console.error("[afc] keychain probe notify:", String(error).slice(0, 160));
    }
  }
  const authDue = state.authCheckedAt === null || now - state.authCheckedAt >= AUTH_SCAN_INTERVAL_MS;
  if (authDue) {
    try {
      state = await scanAuth(state, now);
    } catch (error) {
      console.error("[afc] keychain probe auth:", String(error).slice(0, 160));
      state = { ...state, authCheckedAt: now };
    }
  }
  const rerunDue = state.rerunCheckedAt === null || now - state.rerunCheckedAt >= RERUN_INTERVAL_MS;
  if (rerunDue) state = await rerunSchedules(state, now, logPath);
  await writeJson(statePath, state);
}

/** Alerts from the last probes. None while the keychain adapter is off. */
export async function readKeychainAlerts(now = Date.now()): Promise<ProbeAlert[]> {
  if (!platformCapabilities().keychain || !adapterOn(KEYCHAIN)) return [];
  const state = normalizeProbeState(await readJson<unknown>(PROBE_STATE, null));
  return alertsFromProbe(state, now);
}

/**
 * First pass immediately, then every minute. Auth scan and reruns ride the same timer.
 * Optional (macOS keychain): a tick does nothing while the keychain adapter is off (server/adapters/config.ts).
 */
export function startKeychainProbe(): () => void {
  if (!platformCapabilities().keychain) return () => {};
  let timer: ReturnType<typeof setInterval> | null = null;
  let scanning = false;
  const tick = () => {
    if (scanning || !adapterOn(KEYCHAIN)) return;
    scanning = true;
    void runTick()
      .catch((error) => console.error("[afc] keychain probe:", String(error).slice(0, 200)))
      .finally(() => {
        scanning = false;
      });
  };
  tick();
  timer = setInterval(tick, PROBE_INTERVAL_MS);
  return () => {
    if (timer) clearInterval(timer);
  };
}
