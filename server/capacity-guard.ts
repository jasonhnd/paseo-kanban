/// <reference types="node" />
import { execFileSync } from "node:child_process";
import { statfsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { formatBytes } from "../shared/capacity-format";
import { t } from "../shared/i18n";
import { statusLabel } from "../shared/labels";
import { isAgentAlive } from "./alive";
import { deliverWake, hasWakeSender } from "./bus";
import { CARD_WORK_DIR, cardTmpFallbackRoot, cardTmpRoot, cardTmpWorkspace, type CardTmpContext } from "./card-tmp";
import { cardTmpTaskContext, preparedCardTmpDir } from "./card-tmp-record";
import { cardMarkOf } from "./card-ref";
import { DEFAULT_MAX_WORK_GIB, DEFAULT_MIN_FREE_GIB, kanbanLeaderForAlarm, loadConfig, type KanbanConfig } from "./config";
import { tightenFile } from "./data-perms";
import { getDb } from "./db";
import { agentCwdMissing } from "./missing-cwd";
import { dataDir } from "./paths";
import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "./perf-fs";
import { leaderActionNote } from "./protocol";
import { getTask } from "./task-record";

export const USAGE_CACHE_MS = 10 * 60 * 1000;
const GIB = 1024 ** 3;
const STATE_FILE = "capacity-guard.json";
const CACHE_FILE = "capacity-usage-cache.json";
const FINDING_ID = "board:capacity";
const READ_ID = "board:capacity:read";

export interface CapacityProbe {
  roots?: string[];
  du?: (path: string) => number;
  free?: (path: string) => number;
  statfs?: (path: string) => { blocks: number; bavail: number; bsize: number };
  fresh?: boolean;
}

export interface CapacityRefresh {
  now?: Date;
  config?: KanbanConfig;
  send?: (agentId: string, text: string) => Promise<void> | void;
  notify?: boolean;
}

interface CacheEntry {
  bytes: number;
  mtimeMs: number;
  at: number;
}

interface TopEntry {
  path: string;
  code: string;
  status: string | null;
  bytes: number;
  taskId: number | null;
}

interface Sample {
  at: string;
  workBytes: number;
  freeBytes: number;
  disks?: Array<{ freeBytes: number; totalBytes: number }>;
  top: TopEntry[];
}

interface GuardState {
  version: 1;
  paused: boolean;
  leaderAlerted: boolean;
  lastGood: Sample | null;
  lastError: { at: string; message: string } | null;
  reason: string | null;
}

export interface CapacityFinding {
  id: string;
  severity: "red" | "info";
  check: "board";
  project: null;
  card: null;
  taskId: null;
  object: string;
  symptom: string;
  evidence: string;
  suggestion: string;
}

interface Limits {
  maxWorkGiB: number;
  minFreeGiB: number;
  maxWorkBytes: number;
  minFreeBytes: number;
}

let probe: CapacityProbe | null = null;
let memory: GuardState | null = null;
let usage = new Map<string, CacheEntry>();
let usageLoaded = false;

export function setCapacityProbeForTests(next: CapacityProbe | null): void {
  probe = next;
}

export function resetCapacityForTests(): void {
  probe = null;
  memory = null;
  usage = new Map();
  usageLoaded = false;
  for (const file of [stateFile(), cacheFile()]) {
    try { unlinkSync(file); } catch { /* already gone */ }
  }
}

export function capacityLimits(config: KanbanConfig = loadConfig(), totalBytes?: number): Limits {
  const maxWorkGiB = config.capacity?.maxWorkGiB ?? DEFAULT_MAX_WORK_GIB;
  const configured = config.capacity?.minFreeGiB;
  const automatic = totalBytes === undefined ? DEFAULT_MIN_FREE_GIB
    : Math.min(DEFAULT_MIN_FREE_GIB, Math.max(3, totalBytes / GIB * 0.25));
  const minFreeGiB = configured !== undefined && Number.isFinite(configured) && configured > 0 ? configured : automatic;
  return { maxWorkGiB, minFreeGiB, maxWorkBytes: maxWorkGiB * GIB, minFreeBytes: minFreeGiB * GIB };
}

/** Bytes `du -sk` would charge. Does not follow a symlink at `path`. */
export function duAllocatedBytes(path: string): number {
  const info = lstatSync(path);
  if (!info.isDirectory()) throw new Error("du target is not a directory");
  const out = execFileSync("du", ["-sk", path], { encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "pipe"] });
  const kb = Number(out.trim().split(/\s+/, 1)[0]);
  if (!Number.isFinite(kb) || kb < 0) throw new Error("du returned no size");
  return kb * 1024;
}

export function capacityHoldReason(): string | null {
  const state = readState();
  return state.paused ? state.reason : null;
}

export function capacityAlertSuppressId(): string | null {
  const state = readState();
  return state.paused && state.leaderAlerted ? FINDING_ID : null;
}

export function markCapacityLeaderAlerted(): void {
  const state = readState();
  if (!state.paused || state.leaderAlerted) return;
  writeState({ ...state, leaderAlerted: true });
}

export function capacityFindings(): CapacityFinding[] {
  const state = readState();
  const findings: CapacityFinding[] = [];
  if (state.paused && state.lastGood) {
    const { limits, freeBytes } = sampleLimits(state.lastGood);
    const lines = [
      t("capacity.doctor.amounts", {
        work: formatBytes(state.lastGood.workBytes),
        max: formatBytes(limits.maxWorkBytes),
        free: formatBytes(freeBytes),
        min: formatBytes(limits.minFreeBytes),
      }),
      ...state.lastGood.top.map((entry) => t("capacity.doctor.topLine", {
        code: entry.code,
        status: entry.status ? statusLabel(entry.status) : t("capacity.status.unknown"),
        size: formatBytes(entry.bytes),
      })),
    ];
    findings.push({
      id: FINDING_ID,
      severity: "red",
      check: "board",
      project: null,
      card: null,
      taskId: null,
      object: t("capacity.doctor.object"),
      symptom: t("capacity.doctor.symptom"),
      evidence: lines.join("\n"),
      suggestion: t("capacity.doctor.suggestion"),
    });
  }
  if (state.lastError) {
    const key = state.lastGood ? "capacity.doctor.infoReused" : "capacity.doctor.infoFailed";
    const text = t(key, { error: state.lastError.message });
    findings.push({
      id: READ_ID,
      severity: "info",
      check: "board",
      project: null,
      card: null,
      taskId: null,
      object: t("capacity.doctor.object"),
      symptom: text,
      evidence: text,
      suggestion: t("capacity.doctor.suggestion"),
    });
  }
  return findings;
}

/** Never throws. A failed reading reuses the last good sample and does not start a new pause. */
export async function refreshCapacityGuard(input: CapacityRefresh = {}): Promise<void> {
  const now = input.now ?? new Date();
  try {
    const config = input.config ?? loadConfig();
    const sample = measure(now);
    const { limits, freeBytes } = sampleLimits(sample, config);
    const judged = judge(sample.workBytes, freeBytes, limits);
    const prev = readState();
    const next: GuardState = {
      version: 1,
      paused: judged.paused,
      leaderAlerted: judged.paused ? prev.leaderAlerted : false,
      lastGood: sample,
      lastError: null,
      reason: judged.reason,
    };
    writeState(next);
    if (input.notify !== false && next.paused && !next.leaderAlerted) {
      if (await notifyLeader(input, next.reason ?? "")) writeState({ ...next, leaderAlerted: true });
    }
  } catch (err) {
    const prev = readState();
    const reading = prev.lastGood ? sampleLimits(prev.lastGood, input.config) : null;
    const judged = prev.lastGood && reading ? judge(prev.lastGood.workBytes, reading.freeBytes, reading.limits) : { paused: false, reason: null };
    const next: GuardState = {
      version: 1,
      paused: judged.paused,
      leaderAlerted: judged.paused ? prev.leaderAlerted : false,
      lastGood: prev.lastGood,
      lastError: { at: now.toISOString(), message: clip(err) },
      reason: judged.reason,
    };
    writeState(next);
    if (input.notify !== false && next.paused && !next.leaderAlerted && next.reason) {
      if (await notifyLeader(input, next.reason)) writeState({ ...next, leaderAlerted: true });
    }
  }
}

/** Snapshot the card directory once. A missing directory or a failed `du` leaves the column null. */
export function recordCardWorkBytes(taskId: number): void {
  try {
    const task = getTask(taskId);
    if (task.tmp_work_bytes != null) return;
    const code = cardMarkOf(task);
    if (!/^[A-Za-z0-9]+_\d+$/.test(code)) return;
    const prepared = preparedCardTmpDir(task.id, code);
    const dir = prepared ?? join(cardTmpRoot(cardTmpTaskContext(task)), code);
    const info = lstatSync(dir);
    if (!info.isDirectory()) return;
    const bytes = duAllocatedBytes(dir);
    getDb().prepare("UPDATE tasks SET tmp_work_bytes = ? WHERE id = ? AND tmp_work_bytes IS NULL").run(bytes, taskId);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return;
    console.error("[paseo-kanban] card work size", err instanceof Error ? err.message : err);
  }
}

function measure(now: Date): Sample {
  const nowMs = now.getTime();
  const fresh = probe?.fresh === true;
  const pending = new Map(loadUsage());
  const roots = configuredRoots();
  let workBytes = 0;
  const top: TopEntry[] = [];
  const cards = cardsByCode();
  const present: string[] = [];
  for (const root of roots) {
    const dir = realDirectory(root);
    if (!dir) continue;
    present.push(dir.path);
    workBytes += takeBytes(dir.path, dir.mtimeMs, nowMs, fresh, pending);
    for (const child of childDirectories(dir.path)) {
      const info = realDirectory(child);
      if (!info) continue;
      const bytes = takeBytes(info.path, info.mtimeMs, nowMs, fresh, pending);
      const code = childName(child);
      const known = cards.get(code.toUpperCase());
      top.push({ path: info.path, code, status: known?.status ?? null, bytes, taskId: known?.id ?? null });
    }
  }
  const points = present.length > 0 ? present : [existingAncestor(roots[0] ?? dataDir())];
  const disks = points.map((path) => {
    const stat = probe?.statfs ? probe.statfs(path) : statfsSync(path);
    const totalBytes = Number(stat.blocks) * Number(stat.bsize);
    const freeBytes = probe?.free ? probe.free(path) : Number(stat.bavail) * Number(stat.bsize);
    if (!Number.isFinite(totalBytes) || totalBytes <= 0 || !Number.isFinite(freeBytes) || freeBytes < 0) {
      throw new Error("statfs returned invalid disk space");
    }
    return { freeBytes, totalBytes };
  });
  const freeBytes = Math.min(...disks.map(disk => disk.freeBytes));
  if (!Number.isFinite(freeBytes)) throw new Error("statfs returned no free space");
  usage = pending;
  usageLoaded = true;
  saveUsage();
  top.sort((a, b) => b.bytes - a.bytes || a.code.localeCompare(b.code));
  return { at: now.toISOString(), workBytes, freeBytes, disks, top: top.slice(0, 5) };
}

function judge(workBytes: number, freeBytes: number, limits: Limits): { paused: boolean; reason: string | null } {
  const parts: string[] = [];
  if (workBytes > limits.maxWorkBytes) {
    parts.push(t("capacity.hold.work", { work: formatBytes(workBytes), max: formatBytes(limits.maxWorkBytes) }));
  }
  if (freeBytes < limits.minFreeBytes) {
    parts.push(t("capacity.hold.free", { free: formatBytes(freeBytes), min: formatBytes(limits.minFreeBytes) }));
  }
  if (parts.length === 0) return { paused: false, reason: null };
  return { paused: true, reason: t("capacity.hold", { detail: parts.join(t("capacity.sep")) }) };
}

function configuredRoots(): string[] {
  if (probe?.roots) return probe.roots.map((path) => resolve(path));
  const override = process.env.KANBAN_TMP_ROOT?.trim();
  if (override) return [resolve(override)];
  const names = new Set<string>();
  for (const name of Object.keys(loadConfig().projects ?? {})) names.add(name);
  try {
    const rows = getDb().prepare("SELECT DISTINCT project FROM tasks").all() as Array<{ project: string }>;
    for (const row of rows) if (row.project) names.add(row.project);
  } catch { /* a closed database still leaves the configured projects */ }
  if (names.size === 0) names.add("");
  const roots: string[] = [];
  for (const project of names) {
    const context: CardTmpContext = { project: project || undefined };
    const workspace = cardTmpWorkspace(context);
    if (workspace) roots.push(join(workspace, CARD_WORK_DIR));
    roots.push(cardTmpFallbackRoot(context.project));
  }
  return [...new Set(roots)];
}

function cardsByCode(): Map<string, { id: number; status: string }> {
  const map = new Map<string, { id: number; status: string }>();
  try {
    const config = loadConfig();
    const rows = getDb().prepare("SELECT id, project, code_seq, status FROM tasks").all() as Array<{
      id: number; project: string; code_seq: number | null; status: string;
    }>;
    for (const row of rows) map.set(cardMarkOf(row, config).toUpperCase(), { id: row.id, status: row.status });
  } catch { /* names stay unknown when the board cannot be read */ }
  return map;
}

function realDirectory(path: string): { path: string; mtimeMs: number } | null {
  try {
    const info = lstatSync(path);
    if (!info.isDirectory()) return null;
    return { path, mtimeMs: info.mtimeMs };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

function childDirectories(path: string): string[] {
  return readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => join(path, entry.name));
}

function existingAncestor(path: string): string {
  let current = resolve(path);
  for (;;) {
    if (realDirectory(current)) return current;
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

function takeBytes(path: string, mtimeMs: number, nowMs: number, fresh: boolean, pending: Map<string, CacheEntry>): number {
  const hit = pending.get(path);
  if (!fresh && hit && hit.mtimeMs === mtimeMs && nowMs - hit.at < USAGE_CACHE_MS) return hit.bytes;
  const bytes = probe?.du ? probe.du(path) : duAllocatedBytes(path);
  if (!Number.isFinite(bytes) || bytes < 0) throw new Error("du returned no size");
  pending.set(path, { bytes, mtimeMs, at: nowMs });
  return bytes;
}

/** Compare each disk with its own reserve; the lowest free count can be on a healthy small disk. */
function sampleLimits(sample: Sample, config?: KanbanConfig): { limits: Limits; freeBytes: number } {
  const disks = sample.disks?.length ? sample.disks : [{ freeBytes: sample.freeBytes, totalBytes: undefined }];
  let worst: { limits: Limits; freeBytes: number } | undefined;
  for (const disk of disks) {
    const limits = safeLimits(config, disk.totalBytes);
    const reading = { limits, freeBytes: disk.freeBytes };
    if (!worst || reading.freeBytes - limits.minFreeBytes < worst.freeBytes - worst.limits.minFreeBytes) worst = reading;
  }
  return worst!;
}

function childName(path: string): string {
  const name = path.split(/[\\/]/).filter(Boolean).pop();
  return name || path;
}

async function notifyLeader(input: CapacityRefresh, reason: string): Promise<boolean> {
  const who = kanbanLeaderForAlarm();
  if (!who || !isAgentAlive(who) || agentCwdMissing(who)) return false;
  const text = [t("capacity.wake.title"), reason, leaderActionNote()].join("\n");
  try {
    if (input.send) {
      await input.send(who, text);
      return true;
    }
    if (!hasWakeSender()) return false;
    return await deliverWake(who, text);
  } catch {
    return false;
  }
}

function safeLimits(config?: KanbanConfig, totalBytes?: number): Limits {
  try {
    return capacityLimits(config ?? loadConfig(), totalBytes);
  } catch {
    return capacityLimits({ capacity: undefined } as KanbanConfig, totalBytes);
  }
}

function clip(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.slice(0, 200);
}

function emptyState(): GuardState {
  return { version: 1, paused: false, leaderAlerted: false, lastGood: null, lastError: null, reason: null };
}

function readState(): GuardState {
  if (memory) return memory;
  try {
    const parsed = JSON.parse(readFileSync(stateFile(), "utf8")) as Partial<GuardState>;
    if (parsed.version !== 1 || typeof parsed.paused !== "boolean") return emptyState();
    memory = {
      version: 1,
      paused: parsed.paused,
      leaderAlerted: parsed.leaderAlerted === true,
      lastGood: parsed.lastGood ?? null,
      lastError: parsed.lastError ?? null,
      reason: typeof parsed.reason === "string" ? parsed.reason : null,
    };
    return memory;
  } catch {
    return emptyState();
  }
}

function writeState(state: GuardState): void {
  memory = state;
  try { writeJson(stateFile(), state); } catch (err) {
    console.error("[paseo-kanban] capacity state", err instanceof Error ? err.message : err);
  }
}

function loadUsage(): Map<string, CacheEntry> {
  if (usageLoaded) return usage;
  usageLoaded = true;
  try {
    const parsed = JSON.parse(readFileSync(cacheFile(), "utf8")) as Record<string, CacheEntry>;
    for (const [key, value] of Object.entries(parsed)) {
      if (value && typeof value.bytes === "number" && typeof value.mtimeMs === "number" && typeof value.at === "number") {
        usage.set(key, value);
      }
    }
  } catch { /* first reading */ }
  return usage;
}

function saveUsage(): void {
  try { writeJson(cacheFile(), Object.fromEntries(usage)); } catch (err) {
    console.error("[paseo-kanban] capacity cache", err instanceof Error ? err.message : err);
  }
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(dataDir(), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
    tightenFile(file);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* the temp file was not left behind */ }
    throw err;
  }
}

function stateFile(): string {
  return join(dataDir(), STATE_FILE);
}

function cacheFile(): string {
  return join(dataDir(), CACHE_FILE);
}
