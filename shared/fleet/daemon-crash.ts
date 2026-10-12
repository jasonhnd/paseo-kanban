// Pure crash accounting. The watcher in server/daemon-watch.ts owns the log files and the timer.
// This file is in the plugin shared bundle, so it cannot import node:* modules.
import { TOKYO_OFFSET_MS, tokyoDayStart } from "./dispatch";
import { type CrashSignal, parseCrashSignal } from "./daemon-log";
import { t } from "./i18n";
import { readSupervisorTable, supervisorIdFor } from "./decisions";

export const CRASH_BURST_MS = 10 * 60_000;
export const CRASH_COOLDOWN_MS = 30 * 60_000;
const CONTEXT_LINES = 8;
const KEEP_MS = 48 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

export interface DaemonCrash {
  at: number;
  message: string;
  agentId: string;
  cwd: string;
}

export interface MissingCwdState {
  checkedAt: number | null;
  ok: boolean;
  count: number;
  listPath: string;
}

export interface CrashState {
  inode: string | null;
  offset: number;
  pending: string;
  bootstrapped: boolean;
  lastNotifiedAt: number | null;
  crashes: DaemonCrash[];
  /** Last few complete lines, so a crash at the start of the next read still sees the lines before it. */
  prelude: string[];
  missing: MissingCwdState;
}

export interface DaemonAlert {
  level: "red" | "yellow" | "info";
  kind: string;
  text: string;
  agentId: string | null;
}

export interface LogStat {
  inode: string;
  size: number;
}

export function emptyCrashState(): CrashState {
  return {
    inode: null,
    offset: 0,
    pending: "",
    bootstrapped: false,
    lastNotifiedAt: null,
    crashes: [],
    prelude: [],
    missing: { checkedAt: null, ok: false, count: 0, listPath: "" },
  };
}

export function normalizeCrashState(raw: unknown): CrashState {
  const empty = emptyCrashState();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return empty;
  const row = raw as Partial<CrashState>;
  const crashes = Array.isArray(row.crashes) ? row.crashes.flatMap(normalizeCrash) : [];
  const missing = normalizeMissing(row.missing);
  return {
    inode: typeof row.inode === "string" && row.inode ? row.inode : null,
    offset: typeof row.offset === "number" && row.offset >= 0 ? row.offset : 0,
    pending: typeof row.pending === "string" ? row.pending.slice(0, 256_000) : "",
    bootstrapped: row.bootstrapped === true,
    lastNotifiedAt: typeof row.lastNotifiedAt === "number" ? row.lastNotifiedAt : null,
    crashes,
    prelude: Array.isArray(row.prelude) ? row.prelude.filter((line): line is string => typeof line === "string").slice(-CONTEXT_LINES) : [],
    missing,
  };
}

function normalizeCrash(raw: unknown): DaemonCrash[] {
  if (!raw || typeof raw !== "object") return [];
  const row = raw as Partial<DaemonCrash>;
  if (typeof row.at !== "number" || !Number.isFinite(row.at)) return [];
  return [{
    at: row.at,
    message: typeof row.message === "string" ? row.message.slice(0, 300) : "",
    agentId: typeof row.agentId === "string" ? row.agentId : "",
    cwd: typeof row.cwd === "string" ? row.cwd : "",
  }];
}

function normalizeMissing(raw: unknown): MissingCwdState {
  if (!raw || typeof raw !== "object") return emptyCrashState().missing;
  const row = raw as Partial<MissingCwdState>;
  return {
    checkedAt: typeof row.checkedAt === "number" ? row.checkedAt : null,
    ok: row.ok === true,
    count: typeof row.count === "number" && row.count >= 0 ? row.count : 0,
    listPath: typeof row.listPath === "string" ? row.listPath : "",
  };
}

/** Same file: keep reading at the saved offset. Smaller file or a new inode: finish the newest rotated log, then start over. */
export function planRead(state: CrashState, daemon: LogStat, rotated: LogStat | null): { bootstrap: boolean; rotatedFrom: number | null; daemonFrom: number } {
  if (!state.bootstrapped || state.inode === null) return { bootstrap: true, rotatedFrom: null, daemonFrom: 0 };
  const same = state.inode === daemon.inode && daemon.size >= state.offset;
  if (same) return { bootstrap: false, rotatedFrom: null, daemonFrom: state.offset };
  const rotatedFrom = rotated && rotated.size > state.offset ? state.offset : null;
  return { bootstrap: false, rotatedFrom, daemonFrom: 0 };
}

export function takeComplete(pending: string, chunk: string): { lines: string[]; pending: string } {
  const text = pending + chunk;
  const last = text.lastIndexOf("\n");
  if (last < 0) return { lines: [], pending: text.length > 256_000 ? "" : text };
  const rest = text.slice(last + 1);
  return { lines: text.slice(0, last).split("\n"), pending: rest.length > 256_000 ? "" : rest };
}

interface RawHit extends CrashSignal {
  index: number;
}

export function absorbLines(state: CrashState, lines: string[], now: number, bootstrap: boolean): { state: CrashState; added: DaemonCrash[]; notify: boolean; notice: string } {
  const window = [...state.prelude, ...lines];
  const base = state.prelude.length;
  const events: RawHit[] = [];
  for (let i = base; i < window.length; i++) {
    const signal = parseCrashSignal(window[i]);
    if (signal) events.push({ ...signal, index: i });
  }
  const fresh = mergeHits(events).map((hit) => ({ ...hit, ...fieldsNear(window, hit.index) }));
  const seen = new Set(state.crashes.map(crashKey));
  const added = fresh.filter((crash) => {
    const key = crashKey(crash);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const crashes = trimCrashes([...state.crashes, ...added], now);
  const notify = shouldNotify(crashes, added, now, state.lastNotifiedAt, bootstrap);
  return {
    state: {
      ...state,
      crashes,
      prelude: window.slice(-CONTEXT_LINES).map((line) => line.slice(0, 12_000)),
      bootstrapped: true,
      lastNotifiedAt: notify ? now : state.lastNotifiedAt,
    },
    added,
    notify,
    notice: notify ? crashNotice(crashes, now) : "",
  };
}

function mergeHits(events: RawHit[]): Array<CrashSignal & { index: number }> {
  const sorted = [...events].sort((a, b) => a.at - b.at || a.index - b.index);
  const used = new Set<number>();
  const out: Array<CrashSignal & { index: number }> = [];
  for (let i = 0; i < sorted.length; i++) {
    if (used.has(i)) continue;
    const hit = sorted[i];
    used.add(i);
    let partner: RawHit | null = null;
    for (let j = i + 1; j < sorted.length; j++) {
      if (sorted[j].at - hit.at > 1000) break;
      if (used.has(j) || sorted[j].fatal === hit.fatal) continue;
      partner = sorted[j];
      used.add(j);
      break;
    }
    const fatal = hit.fatal ? hit : partner?.fatal ? partner : null;
    const chosen = fatal ?? hit;
    const message = (fatal?.message || hit.message || partner?.message || "").slice(0, 300);
    out.push({ at: chosen.at, fatal: Boolean(fatal), message, index: chosen.index });
  }
  return out;
}

function fieldsNear(lines: string[], index: number): { agentId: string; cwd: string } {
  let agentId = "";
  let cwd = "";
  let agentDist = CONTEXT_LINES + 1;
  let cwdDist = CONTEXT_LINES + 1;
  const from = Math.max(0, index - CONTEXT_LINES);
  const to = Math.min(lines.length - 1, index + CONTEXT_LINES);
  for (let i = from; i <= to; i++) {
    if (i === index) continue;
    const fields = fieldsOf(lines[i]);
    const dist = Math.abs(i - index);
    if (fields.agentId && dist < agentDist) {
      agentId = fields.agentId;
      agentDist = dist;
    }
    if (fields.cwd && dist < cwdDist) {
      cwd = fields.cwd;
      cwdDist = dist;
    }
  }
  return { agentId, cwd };
}

function fieldsOf(line: string): { agentId: string; cwd: string } {
  try {
    const obj = JSON.parse(line) as Record<string, unknown>;
    return { agentId: stringField(obj, "agentId"), cwd: stringField(obj, "cwd") };
  } catch {
    return { agentId: "", cwd: "" };
  }
}

function stringField(obj: Record<string, unknown>, key: string): string {
  const top = obj[key];
  if (typeof top === "string" && top.trim()) return top.trim();
  for (const value of Object.values(obj)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const nested = (value as Record<string, unknown>)[key];
    if (typeof nested === "string" && nested.trim()) return nested.trim();
  }
  return "";
}

function crashKey(crash: DaemonCrash): string {
  return `${crash.at}|${crash.message}`;
}

function trimCrashes(crashes: DaemonCrash[], now: number): DaemonCrash[] {
  const sorted = [...crashes].sort((a, b) => a.at - b.at);
  const recent = sorted.filter((crash) => now - crash.at <= KEEP_MS);
  const older = sorted.filter((crash) => now - crash.at > KEEP_MS);
  const kept = [...(older.length ? [older[older.length - 1]] : []), ...recent];
  return kept.slice(-80);
}

export function shouldNotify(crashes: DaemonCrash[], added: DaemonCrash[], now: number, lastNotifiedAt: number | null, bootstrap: boolean): boolean {
  if (bootstrap || added.length === 0) return false;
  if (lastNotifiedAt !== null && now - lastNotifiedAt < CRASH_COOLDOWN_MS) return false;
  return crashes.filter((crash) => crash.at <= now + 1000 && now - crash.at <= CRASH_BURST_MS).length >= 2;
}

export function crashNotice(crashes: DaemonCrash[], now: number): string {
  const recent = crashes.filter((crash) => crash.at <= now + 1000 && now - crash.at <= CRASH_BURST_MS).sort((a, b) => a.at - b.at);
  const last = recent[recent.length - 1];
  if (!last) return t("daemon.crash.noticeEmpty");
  const parts = [t("daemon.crash.noticeHead", { count: recent.length, time: clock(last.at).hm })];
  parts.push(t("daemon.crash.noticeError", { message: last.message || t("daemon.crash.notRead") }));
  if (last.agentId) parts.push(t("daemon.crash.noticeAgent", { agent: last.agentId }));
  if (last.cwd) parts.push(t("daemon.crash.noticeCwd", { cwd: last.cwd }));
  parts.push(t("daemon.crash.noticeTail"));
  return parts.join("");
}

export function crashesToday(crashes: DaemonCrash[], now: number): number {
  const start = tokyoDayStart(now);
  return crashes.filter((crash) => crash.at >= start && crash.at <= now + 1000).length;
}

export function homeCrashClause(today: number): string | null {
  if (today <= 0) return null;
  return t("daemon.crash.homeClause", { count: today });
}

export function crashAlert(crashes: DaemonCrash[], now: number): DaemonAlert {
  const known = crashes.filter((crash) => crash.at <= now + 1000).sort((a, b) => a.at - b.at);
  if (known.length === 0) return { level: "info", kind: t("daemon.crash.kind"), text: t("daemon.crash.none24h"), agentId: null };
  const today = known.filter((crash) => crash.at >= tokyoDayStart(now));
  if (today.length > 0) {
    const last = today[today.length - 1];
    return { level: "red", kind: t("daemon.crash.kind"), text: alertText(t("daemon.crash.today", { count: today.length, time: clock(last.at).hm }), today.slice(-3)), agentId: null };
  }
  const within = known.filter((crash) => now - crash.at <= DAY_MS);
  if (within.length > 0) {
    const last = within[within.length - 1];
    return {
      level: "yellow",
      kind: t("daemon.crash.kind"),
      text: alertText(t("daemon.crash.within24h", { count: within.length, time: clock(last.at).mdhm }), within.slice(-3)),
      agentId: null,
    };
  }
  const last = known[known.length - 1];
  return { level: "info", kind: t("daemon.crash.kind"), text: t("daemon.crash.none24hLast", { time: clock(last.at).mdhm }), agentId: null };
}

function alertText(head: string, rows: DaemonCrash[]): string {
  return [head, ...rows.map(detailLine)].join("\n");
}

function detailLine(crash: DaemonCrash): string {
  const lines = [t("daemon.crash.detailError", { time: clock(crash.at).hm, message: crash.message || t("daemon.crash.notRead") })];
  if (crash.agentId) lines.push(t("daemon.crash.detailAgent", { agent: crash.agentId }));
  if (crash.cwd) lines.push(t("daemon.crash.detailCwd", { cwd: crash.cwd }));
  return lines.join("\n");
}

function clock(at: number): { hm: string; mdhm: string } {
  const d = new Date(at + TOKYO_OFFSET_MS);
  const hm = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  return { hm, mdhm: `${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())} ${hm}` };
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function alertsFromState(state: CrashState, now: number): { today: number; crash: DaemonAlert | null; missing: DaemonAlert | null } {
  const missing = missingAlert(state.missing);
  if (!state.bootstrapped) return { today: 0, crash: null, missing };
  return { today: crashesToday(state.crashes, now), crash: crashAlert(state.crashes, now), missing };
}

export function missingAlert(missing: MissingCwdState): DaemonAlert | null {
  if (missing.checkedAt === null) return null;
  if (!missing.ok) return { level: "info", kind: t("daemon.missing.checkKind"), text: t("daemon.missing.unavailable"), agentId: null };
  if (missing.count > 0) {
    return {
      level: "yellow",
      kind: t("daemon.missing.kind"),
      text: t("daemon.missing.found", { count: missing.count, path: missing.listPath }),
      agentId: null,
    };
  }
  return null;
}

export interface MissingRun {
  exists: boolean;
  ok: boolean;
  timedOut: boolean;
  stdout: string;
  /** 0 and 1 are success when the JSON matches the contract. Omitted falls back to `ok` (exit 0 only). */
  exitCode?: number | null;
}

/** Exit 0 (none missing) and 1 (some missing) both count. Other codes, timeout, or bad JSON do not. */
function exitAllowsReport(run: MissingRun): boolean {
  if (run.timedOut) return false;
  if (typeof run.exitCode === "number") return run.exitCode === 0 || run.exitCode === 1;
  return run.ok;
}

/** Contract listPath may be relative to Kanban's install directory (`kanbanRoot`). Empty stays empty. */
export function absoluteListPath(listPath: string, kanbanRoot: string): string {
  if (!listPath || listPath.startsWith("/")) return listPath;
  const root = kanbanRoot.replace(/\/+$/, "");
  const rel = listPath.replace(/^\.\//, "");
  return `${root}/${rel}`;
}

/** Script missing, timed out, exit other than 0/1, or not the contract JSON: the check is unavailable. */
export function assessMissingCwd(run: MissingRun, now: number, kanbanRoot: string): MissingCwdState {
  const bad: MissingCwdState = { checkedAt: now, ok: false, count: 0, listPath: "" };
  if (!run.exists || !exitAllowsReport(run)) return bad;
  let parsed: unknown;
  try {
    parsed = JSON.parse(run.stdout);
  } catch {
    return bad;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return bad;
  const row = parsed as Record<string, unknown>;
  if (typeof row.checkedAt !== "string" || !row.checkedAt) return bad;
  if (typeof row.count !== "number" || !Number.isFinite(row.count) || row.count < 0) return bad;
  if (typeof row.placeholder !== "number" || !Number.isFinite(row.placeholder)) return bad;
  if (typeof row.listPath !== "string") return bad;
  if (!Array.isArray(row.items)) return bad;
  return { checkedAt: now, ok: true, count: row.count, listPath: absoluteListPath(row.listPath, kanbanRoot) };
}

/** Operations project supervisor, then the Kanban supervisor. Missing ids are skipped. */
export function crashNotifyTargets(config: unknown, opsProject: string): string[] {
  const ids: string[] = [];
  if (!config || typeof config !== "object" || Array.isArray(config)) return ids;
  const row = config as { supervisorAgentId?: unknown };
  const afc = supervisorIdFor(opsProject, readSupervisorTable(config));
  if (afc) ids.push(afc);
  if (typeof row.supervisorAgentId === "string" && row.supervisorAgentId.trim() && !ids.includes(row.supervisorAgentId.trim())) {
    ids.push(row.supervisorAgentId.trim());
  }
  return ids;
}
