/// <reference types="node" />
// Daily tidy of the decision list: one reminder at 3 days, shelve at 7 days.
// Blocking items get reminders but are never shelved. All effects can be injected for offline tests.
import { commandInvocation } from "./commands";
import { spawnSync } from "node:child_process";
import { appendFile, mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  applyMaintenance,
  autoShelveNote,
  type DecisionRecord,
  MAINT_FIRST_DELAY_MS,
  MAINT_INTERVAL_MS,
  normalizeMaintState,
  overturnNotice,
  leaderDigest,
  planMaintenance,
  readSupervisorTable,
  supervisorIdFor,
} from "../../shared/fleet/decisions";
import { t, tAll } from "../../shared/fleet/i18n";
import { isPausedProject } from "../../shared/fleet/paused";
import { readPausedProjects, PAUSED_PROJECTS } from "./paused";
import { kanbanConfigPath, rolesBin } from "./paths";
import { DECISIONS, logSwallowed, readJson, STATE_DIR, writeJson } from "./util";

export const KANBAN_CONFIG = kanbanConfigPath();
export const MAINT_STATE = join(STATE_DIR, "decisions-maint-state.json");
export const MAINT_LOG = join(STATE_DIR, "decisions-maint.log");

const LOCK_STALE_MS = 30_000;

export interface MaintPaths {
  decisionsPath: string;
  statePath: string;
  logPath: string;
  kanbanConfigPath: string;
  rolesBin?: string;
  /** paused-projects.json; paused projects get no reminder and no auto-shelve. */
  pausedPath?: string;
}

export type NotifyFn = (agentId: string, text: string) => Promise<void> | void;

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false; // no such process: the lock owner is dead
  }
}

/** True when a stale lock held by a dead process was removed, so the caller can retry at once. */
async function clearStaleLock(lockPath: string): Promise<boolean> {
  try {
    const info = await stat(lockPath);
    if (Date.now() - info.mtimeMs <= LOCK_STALE_MS) return false;
    if (isPidAlive(Number(await readFile(lockPath, "utf8")))) return false;
    await unlink(lockPath).catch((error) => logSwallowed("decisions lock unlink", error));
    return true;
  } catch (error) {
    // The lock vanished while we looked (owner released it): retry.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") logSwallowed("decisions lock check", error);
    return true;
  }
}

async function acquireLock(lockPath: string): Promise<Awaited<ReturnType<typeof open>>> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      const fh = await open(lockPath, "wx");
      await fh.writeFile(String(process.pid));
      return fh;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (await clearStaleLock(lockPath)) continue;
    if (Date.now() >= deadline) throw new Error("decisions.json is busy");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function withLock<T>(decisionsPath: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = `${decisionsPath}.lock`;
  await mkdir(dirname(decisionsPath), { recursive: true });
  const held = await acquireLock(lockPath);
  try {
    return await fn();
  } finally {
    await held.close();
    await unlink(lockPath).catch((error) => logSwallowed("decisions-maint fs cleanup", error));
  }
}

async function readItems(path: string): Promise<DecisionRecord[]> {
  try {
    const data = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!Array.isArray(data)) return [];
    return data.filter((item): item is DecisionRecord => Boolean(item) && typeof item === "object");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];
    throw error;
  }
}

function localIso(now: number): string {
  const date = new Date(now);
  const pad = (n: number) => String(n).padStart(2, "0");
  const tz = -date.getTimezoneOffset();
  const sign = tz >= 0 ? "+" : "-";
  const abs = Math.abs(tz);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

async function loadSupervisors(path: string): Promise<Record<string, string> | null> {
  try {
    return readSupervisorTable(JSON.parse(await readFile(path, "utf8")) as unknown);
  } catch (error) {
    logSwallowed("decisions-maint read kanban config", error);
    return null;
  }
}

export async function readDecisionMaintView(statePath = MAINT_STATE): Promise<{ enabled: boolean }> {
  const state = normalizeMaintState(await readJson(statePath, {}));
  return { enabled: state.enabled };
}

export async function setDecisionMaintEnabled(enabled: boolean, statePath = MAINT_STATE, decisionsPath = DECISIONS): Promise<boolean> {
  return withLock(statePath, async () => {
    const state = normalizeMaintState(await readJson(statePath, {}));
    state.enabled = enabled;
    await writeJson(statePath, state);
    return state.enabled;
  });
}

export async function runDecisionMaintenance(opts: {
  paths: MaintPaths;
  now: number;
  notify: NotifyFn;
  close?: (id: string, note: string) => Promise<boolean>;
}): Promise<{ logs: string[]; messages: { agentId: string; text: string }[] }> {
  const { paths, now, notify } = opts;
  // Lock maintenance state separately: `roles decide done` takes the decisions lock itself.
  return withLock(paths.statePath, async () => {
    let raw: unknown;
    try { raw = JSON.parse(await readFile(paths.statePath, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    let state = normalizeMaintState(raw);
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(now));
    if (state.lastRunDay === day) return { logs: [], messages: [] };
    const paused = await readPausedProjects(paths.pausedPath ?? PAUSED_PROJECTS);
    const items = (await readItems(paths.decisionsPath)).filter((item) => !isPausedProject(String(item.project ?? ""), paused));
    const supervisors = await loadSupervisors(paths.kanbanConfigPath);
    const actions = planMaintenance(items, state, now, supervisors);
    state.lastRunDay = day;
    await writeJson(paths.statePath, state); // Claim the day before any external effect, including after reload.
    const logs: string[] = [];
    const messages: { agentId: string; text: string }[] = [];
    for (const action of actions) {
      if (state.enabled && action.kind === "shelve") {
        try {
          const closed = opts.close
            ? await opts.close(action.id, autoShelveNote())
            : closeDecision(paths, action.id);
          if (!closed) continue; // The user may have answered or made it blocking since the scan.
        } catch (error) {
          logs.push(`${localIso(now)}\tshelve failed\t${action.id}\t${String(error).slice(0, 180)}`);
          continue;
        }
      }
      const applied = applyMaintenance({ items, state, nowIso: localIso(now), actions: [action], enabled: state.enabled });
      state = applied.state;
      state.pendingNotifications = [...(state.pendingNotifications ?? []), ...applied.messages];
      logs.push(...applied.logs);
      await writeJson(paths.statePath, state);
    }
    if (state.enabled) {
      const groups = new Map<string, NonNullable<typeof state.pendingNotifications>>();
      for (const message of state.pendingNotifications ?? []) {
        // Old queue entries lack project metadata. Match their decision id before delivery,
        // so reminders queued under the removed AFC fallback cannot escape on the next pass.
        const project = message.project ?? items.find((item) => item.id && (item.id === message.id || tAll("decisions.maint.legacyIdRef", { id: item.id }).some((ref) => message.text.includes(ref))))?.project;
        if (typeof project === "string" && isPausedProject(project, paused)) {
          logs.push(`${localIso(now)}\tnot notified (project paused)\t${project}`);
          state.pendingNotifications = state.pendingNotifications!.filter((row) => row !== message);
          continue;
        }
        if (typeof project !== "string" || supervisorIdFor(project, supervisors) !== message.agentId) {
          logs.push(`${localIso(now)}\tnot notified (project has no <leader> or owner changed)\t${project ?? "unknown project"}`);
          state.pendingNotifications = state.pendingNotifications!.filter((row) => row !== message);
          continue;
        }
        const list = groups.get(message.agentId);
        if (list) list.push(message);
        else groups.set(message.agentId, [message]);
      }
      await writeJson(paths.statePath, state);
      for (const [agentId, group] of groups) {
        const text = leaderDigest(group);
        try {
          await notify(agentId, text);
          messages.push({ agentId, text });
          const drop = new Set(group);
          state.pendingNotifications = (state.pendingNotifications ?? []).filter((row) => !drop.has(row));
          await writeJson(paths.statePath, state);
        } catch (error) {
          logs.push(`${localIso(now)}\tnotify failed (retry next pass)\t${agentId}\t${group.length} item(s)\t${String(error).slice(0, 180)}`);
        }
      }
    }
    if (logs.length) {
      await mkdir(dirname(paths.logPath), { recursive: true }).catch((error) => logSwallowed("decisions-maint fs cleanup", error));
      await appendFile(paths.logPath, `${logs.join("\n")}\n`, "utf8");
    }
    return { logs, messages };
  });
}

function closeDecision(paths: MaintPaths, id: string): boolean {
  const result = runRoles(dirname(paths.decisionsPath), paths.kanbanConfigPath,
    ["done", id, "--as", "shelved", "--note", autoShelveNote(), "--auto-shelve"], paths.rolesBin);
  if (!result.ok) throw new Error(result.stderr || result.stdout || "roles decide done failed");
  return /\bshelved\s*$/.test(result.stdout);
}

/** Detail bin/roles writes on the reopened copy of an overturned decision (any language). */
function isOverturnDetail(detail: string): boolean {
  return tAll("cli.roles.overturnDetail", { body: "" }).some((prefix) => detail.startsWith(prefix));
}

export interface OverturnResult {
  ok: boolean;
  notified: boolean;
  message: string;
}

function runRoles(stateDir: string, kanbanConfig: string, args: string[], commandPath = rolesBin()): { ok: boolean; stdout: string; stderr: string } {
  // Keep explicit test overrides; otherwise follow the current managed checkout.
  const invocation = commandInvocation(commandPath, ["decide", ...args]);
  const result = spawnSync(invocation.command, invocation.args, {
    encoding: "utf8",
    timeout: 20_000,
    env: { ...process.env, KANBAN_DATA_DIR: dirname(stateDir), ROLES_STATE_DIR: "", AFC_DATA_DIR: "", AFC_LEGACY_DATA_DIR: "", ROLES_KANBAN_CONFIG: kanbanConfig },
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? "",
    stderr: `${result.stderr ?? ""}${result.error ? String(result.error.message) : ""}`,
  };
}

/**
 * Same effect as `roles decide overturn`, then tell the project's registered supervisor.
 * A missing supervisor updates the list and returns a notice; it does not throw.
 */
export async function performOverturn(opts: {
  id: string;
  note?: string;
  decisionsPath: string;
  kanbanConfigPath: string;
  notify: NotifyFn;
}): Promise<OverturnResult> {
  const stateDir = dirname(opts.decisionsPath);
  const args = ["overturn", opts.id];
  if (opts.note) args.push("--note", opts.note);
  const ran = runRoles(stateDir, opts.kanbanConfigPath, args);
  if (!ran.ok) {
    const why = (ran.stderr || ran.stdout).trim().slice(0, 200) || t("decisions.overturn.failed");
    return { ok: false, notified: false, message: why };
  }
  const opened = /reopened\s+(\S+)/.exec(ran.stdout)?.[1] ?? "";
  let project = "";
  let title = "";
  let detail = "";
  try {
    const items = await readItems(opts.decisionsPath);
    const item = items.find((row) => row.id === opened) ?? items.find((row) => row.status === "open" && isOverturnDetail(String(row.detail ?? "")));
    project = typeof item?.project === "string" ? item.project : "";
    title = typeof item?.title === "string" ? item.title : "";
    detail = typeof item?.detail === "string" ? item.detail : "";
  } catch (error) {
    logSwallowed("overturn read decisions", error);
    project = "";
  }
  const supervisor = supervisorIdFor(project, await loadSupervisors(opts.kanbanConfigPath));
  if (!supervisor) {
    return { ok: true, notified: false, message: t("decisions.overturn.reopenedNotNotified") };
  }
  const text = overturnNotice(project, title, detail);
  try {
    await opts.notify(supervisor, text);
  } catch (error) {
    return { ok: true, notified: false, message: t("decisions.overturn.reopenedNotifyFailed", { error: String(error).slice(0, 120) }) };
  }
  return { ok: true, notified: true, message: t("decisions.overturn.reopenedNotified") };
}

export async function runProductionMaintenance(notify: NotifyFn): Promise<void> {
  const result = await runDecisionMaintenance({
    paths: { decisionsPath: DECISIONS, statePath: MAINT_STATE, logPath: MAINT_LOG, kanbanConfigPath: KANBAN_CONFIG },
    now: Date.now(),
    notify,
  });
  console.log(`[afc] decision maint: ${result.logs.length} line(s), ${result.messages.length} reminder(s)`);
}

/** First pass about 5 minutes after load, then once a day. */
export function startDecisionMaintenance(notify: NotifyFn): () => void {
  let interval: ReturnType<typeof setInterval> | null = null;
  const first = setTimeout(() => {
    void runProductionMaintenance(notify).catch((error) => console.error("[afc] decision maint:", String(error).slice(0, 300)));
    interval = setInterval(() => {
      void runProductionMaintenance(notify).catch((error) => console.error("[afc] decision maint:", String(error).slice(0, 300)));
    }, MAINT_INTERVAL_MS);
  }, MAINT_FIRST_DELAY_MS);
  return () => {
    clearTimeout(first);
    if (interval) clearInterval(interval);
  };
}
