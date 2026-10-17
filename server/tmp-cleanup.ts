/// <reference types="node" />
import { execFile, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstatSync, renameSync, type BigIntStats } from "node:fs";
import { lstat, readdir, realpath, rm } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { formatCardCode } from "../shared/card-code";
import { agentsOpenedBy } from "./archive-book";
import { cardMarkOf } from "./card-ref";
import { cardTmpGeneration, cardTmpRoots } from "./card-tmp";
import { cardTmpTaskContext, preparedCardTmpDir } from "./card-tmp-record";
import { getDb } from "./db";
import { upsertSummaryEvent } from "./event-summary";
import { pathWithin, readCwdAgentList, type CwdAgent } from "./missing-cwd";
import { countIo, round } from "./perf";
import { displayProjectCode } from "./project-codes";
import { appendEvent, type TaskRow } from "./store";

/** First removal failure waits this long. Later failures double until the cap. Occupancy is retried on the next round. */
export const TMP_FAIL_BACKOFF_MS = 60_000;
/** Removal retries keep going. The wait never grows past this, and a failure is never dropped. */
export const TMP_FAIL_BACKOFF_CAP_MS = 60 * 60_000;

const FAILURE_KIND = "tmp_cleanup_failed";

type TerminalTask = TaskRow & { ended_at: string | null; ended_event_id: number | null };
// Event id identifies the terminal stretch even if two events have the same timestamp.
const TERMINAL_TASKS = `SELECT t.*, e.at AS ended_at, e.id AS ended_event_id FROM tasks t
  LEFT JOIN events e ON e.id = (SELECT id FROM events WHERE task_id = t.id
    AND to_status IN ('done', 'archived') AND COALESCE(from_status, '') NOT IN ('done', 'archived')
    ORDER BY id DESC LIMIT 1)`;

function terminal(task: TerminalTask): boolean {
  return task.status === "done" || task.status === "archived";
}

/** Same finished stretch we started with. A reopen, or a new done/archived event, keeps the directory. */
function sameStretch(task: TerminalTask, started: TerminalTask): boolean {
  return terminal(task) && task.ended_event_id === started.ended_event_id &&
    (task.ended_at ?? task.updated_at) === (started.ended_at ?? started.updated_at);
}

export interface TmpCleanOptions {
  now?: Date;
  roots?: string[];
  /** Tests cap one round. The scheduler cleans every finished directory it can see. */
  limit?: number;
  /** Accepted from older callers. Every round already runs. */
  force?: boolean;
  /** Only directories owned by this uid are deleted. Defaults to the current user. */
  ownerUid?: number;
}

export interface TmpCleaned {
  taskId: number;
  path: string;
  bytes: number;
}

export interface TmpCleanupProblem {
  taskId: number;
  project: string;
  card: string | null;
  path: string;
  reason: string;
}

export interface TmpCleanupHooks {
  /** One process-cwd listing. null means the listing could not be read. */
  listProcessCwds?: () => string[] | null;
}

interface Hold {
  reason: string;
  /** Permission, busy and I/O failures wait. A live process is checked again on the next call. */
  backoff: boolean;
}

interface RootMark {
  dev: bigint;
  ino: bigint;
  generation: string | null;
}

interface OpenFailure {
  attempt: number;
  retryAt: number;
}

interface Retirement {
  path: string;
  retiredPath: string;
  bytes: number;
  dev: string;
  ino: string;
  card: string;
  generation: string | null;
}

let running: Promise<TmpCleaned[]> | null = null;
/** A schedule that arrived while a round was running. One follow-up starts when that round ends. */
let pending: TmpCleanOptions | null = null;
let hooks: TmpCleanupHooks = {};
let roundCwds: string[] | null | undefined;

export function setTmpCleanupHooks(next: TmpCleanupHooks | null): void {
  hooks = next ?? {};
}

export function resetTmpCleanupForTests(): void {
  running = null;
  pending = null;
  hooks = {};
  roundCwds = undefined;
}

/** The directory names that belong to one card and no other: DEMO_0001, demo_0001, demo-0001, demo0001. */
export function tmpNamesFor(code: string): string[] {
  const lower = code.toLowerCase();
  const [prefix, seq] = lower.split("_");
  if (!prefix || !seq) return [code];
  return [code, lower, `${prefix}-${seq}`, `${prefix}${seq}`];
}

function codeOf(task: Pick<TaskRow, "project" | "code_seq">): string | null {
  if (task.code_seq == null) return null;
  const code = displayProjectCode(task.project);
  return code ? formatCardCode(code, task.code_seq) : null;
}

/** Directory name → card, for cards that are done or archived now. Names claimed by a live card are dropped. */
function terminalNames(root?: string): Map<string, TerminalTask> {
  const names = new Map<string, TerminalTask>();
  const clash = new Set<string>();
  const rows = getDb()
    .prepare(`${TERMINAL_TASKS} WHERE t.code_seq IS NOT NULL`)
    .all() as unknown as TerminalTask[];
  for (const task of rows) {
    const code = codeOf(task);
    if (!code) continue;
    if (root && !taskRoots(task).includes(root)) continue;
    const over = terminal(task);
    for (const name of tmpNamesFor(code)) {
      if (names.has(name) || clash.has(name)) {
        names.delete(name);
        clash.add(name);
        continue;
      }
      if (over) names.set(name, task);
      else clash.add(name);
    }
  }
  return names;
}

function taskRoots(task: TaskRow): string[] {
  const recorded = preparedCardTmpDir(task.id, cardMarkOf(task));
  return [...cardTmpRoots(cardTmpTaskContext(task)),
    ...(recorded ? [dirname(recorded)] : [])];
}

/** Include recorded locations so config/override changes do not strand an older generation. */
function defaultRoots(): string[] {
  const tasks = getDb().prepare("SELECT * FROM tasks WHERE code_seq IS NOT NULL").all() as unknown as TaskRow[];
  const retired = getDb().prepare("SELECT data_json FROM events WHERE kind = 'tmp_retirement_prepared'").all() as Array<{ data_json: string }>;
  const journals = retired.flatMap(row => {
    try {
      const path = JSON.parse(row.data_json).path;
      return typeof path === "string" && path.startsWith("/") ? [dirname(path)] : [];
    } catch { return []; }
  });
  return [...new Set([...tasks.flatMap(taskRoots), ...journals])];
}

function sizeOf(path: string): Promise<number> {
  return new Promise((resolve) => {
    execFile("du", ["-sk", path], { timeout: 60_000 }, (err, stdout) => {
      const kb = err ? 0 : Number.parseInt(String(stdout).split(/\s/)[0] ?? "", 10);
      resolve(Number.isFinite(kb) ? kb * 1024 : 0);
    });
  });
}

async function roots(list: string[], strict: boolean): Promise<string[]> {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const root of list) {
    try {
      if (strict && !(await lstat(root)).isDirectory()) continue;
      const real = await realpath(root);
      if (seen.has(real)) continue;
      seen.add(real);
      out.push(root);
    } catch {
      // root missing: nothing to clean there
    }
  }
  return out;
}

/** Real path of the deepest existing ancestor plus the missing tail, so an agent cwd that no longer exists still resolves through aliases. */
async function realOr(path: string): Promise<string> {
  let head = resolve(path);
  let tail = "";
  for (;;) {
    try {
      return join(await realpath(head), tail);
    } catch {
      const parent = resolve(head, "..");
      if (parent === head) return resolve(path);
      tail = join(head.slice(parent.length + 1), tail);
      head = parent;
    }
  }
}

/** Compare real paths so aliases and symlinks cannot bypass an agent's cwd protection. */
async function cwdInside(path: string, cwds: string[]): Promise<boolean> {
  const real = await realOr(path);
  for (const cwd of cwds) {
    if (pathWithin(path, cwd) || pathWithin(real, cwd) || pathWithin(real, await realOr(cwd))) return true;
  }
  return false;
}

/** One `lsof -d cwd` listing for this round. null when it cannot be read. Not a per-file walk. */
export function listProcessCwds(): string[] | null {
  if (hooks.listProcessCwds) return hooks.listProcessCwds();
  const out = spawnSync("lsof", ["-d", "cwd", "-F", "pn"], { encoding: "utf8", timeout: 15_000, maxBuffer: 64 * 1024 * 1024 });
  if (out.error || out.status == null) return null;
  if (out.status !== 0 && out.status !== 1) return null;
  if (!out.stdout && out.stderr) return null;
  const cwds: string[] = [];
  for (const line of String(out.stdout).split("\n")) {
    if (line.startsWith("n") && line.length > 1) cwds.push(line.slice(1));
  }
  return cwds;
}

function roundProcessCwds(): string[] | null {
  if (roundCwds === undefined) roundCwds = listProcessCwds();
  return roundCwds;
}

function backoffDelay(attempt: number): number {
  const shift = Math.min(20, Math.max(0, attempt - 1));
  return Math.min(TMP_FAIL_BACKOFF_CAP_MS, TMP_FAIL_BACKOFF_MS * 2 ** shift);
}

function eventTime(row: { at: string; id: number }, other: { at: string; id: number }): boolean {
  if (row.at !== other.at) return row.at > other.at;
  return row.id > other.id;
}

function openFailure(taskId: number, path: string): OpenFailure | null {
  const db = getDb();
  const fail = db.prepare(`SELECT id, at, data_json FROM events WHERE task_id = ? AND kind = ? AND json_extract(data_json, '$.summaryKey') = ? ORDER BY id DESC LIMIT 1`)
    .get(taskId, FAILURE_KIND, path) as { id: number; at: string; data_json: string } | undefined;
  if (!fail) return null;
  const cleaned = db.prepare(`SELECT id, at FROM events WHERE task_id = ? AND kind = 'tmp_cleaned' AND json_extract(data_json, '$.summaryKey') = ? ORDER BY id DESC LIMIT 1`)
    .get(taskId, path) as { id: number; at: string } | undefined;
  if (cleaned && eventTime(cleaned, fail)) return null;
  try {
    const data = JSON.parse(fail.data_json) as { attempt?: unknown; retryAt?: unknown };
    const retryAt = typeof data.retryAt === "string" ? Date.parse(data.retryAt) : Number.NaN;
    return { attempt: typeof data.attempt === "number" ? data.attempt : 1, retryAt: Number.isFinite(retryAt) ? retryAt : 0 };
  } catch {
    return { attempt: 1, retryAt: 0 };
  }
}

function recordProblem(taskId: number, path: string, reason: string, now: number, backoff: boolean): void {
  const open = openFailure(taskId, path);
  const attempt = (open?.attempt ?? 0) + 1;
  const delay = backoff ? backoffDelay(attempt) : 0;
  upsertSummaryEvent(taskId, FAILURE_KIND, "scheduler", path, {
    path, reason, attempt, retryAt: new Date(now + delay).toISOString(),
  }, { at: new Date(now).toISOString() });
  console.error(`[paseo-kanban] tmp cleanup failed ${path}: ${reason}`);
}

function waiting(taskId: number, path: string, now: number): boolean {
  const open = openFailure(taskId, path);
  return open != null && open.retryAt > now;
}

/** Problems still open: a later successful clean of the same path drops the red. */
export function tmpCleanupProblems(): TmpCleanupProblem[] {
  const rows = getDb().prepare(`SELECT e.id, e.at, e.task_id, e.kind, e.data_json, t.project, t.code_seq
    FROM events e JOIN tasks t ON t.id = e.task_id
    WHERE e.kind IN (?, 'tmp_cleaned')`).all(FAILURE_KIND) as Array<{
    id: number; at: string; task_id: number; kind: string; data_json: string; project: string; code_seq: number | null;
  }>;
  const latest = new Map<string, { id: number; at: string; kind: string; data_json: string; project: string; code_seq: number | null; task_id: number }>();
  for (const row of rows) {
    let path = "";
    try {
      const data = JSON.parse(row.data_json) as { path?: unknown; summaryKey?: unknown };
      path = typeof data.path === "string" ? data.path : typeof data.summaryKey === "string" ? data.summaryKey : "";
    } catch { path = ""; }
    if (!path) continue;
    const key = `${row.task_id}\0${path}`;
    const prev = latest.get(key);
    if (!prev || eventTime(row, prev)) latest.set(key, { ...row, id: row.id });
  }
  const problems: TmpCleanupProblem[] = [];
  for (const row of latest.values()) {
    if (row.kind !== FAILURE_KIND) continue;
    let reason = "cleanup failed";
    let path = "";
    try {
      const data = JSON.parse(row.data_json) as { path?: unknown; reason?: unknown };
      if (typeof data.path === "string") path = data.path;
      if (typeof data.reason === "string" && data.reason) reason = data.reason;
    } catch { /* keep the fallback reason */ }
    if (!path) continue;
    problems.push({ taskId: row.task_id, project: row.project, card: codeOf(row), path, reason });
  }
  return problems;
}

function errorText(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.slice(0, 300);
}

/** Outside the card root, or an evidence directory, is never a deletion target. */
function protectedPath(root: string, path: string): boolean {
  if (!pathWithin(root, path)) return true;
  return path.split(sep).includes(".local-evidence");
}

async function rootMark(path: string): Promise<RootMark> {
  const info = await lstat(path, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("tmp directory changed");
  return { dev: info.dev, ino: info.ino, generation: cardTmpGeneration(path) };
}

function sameRoot(before: RootMark, after: RootMark): boolean {
  return before.dev === after.dev && before.ino === after.ino && before.generation === after.generation;
}

function statIdentity(info: BigIntStats): string {
  return `${info.dev}:${info.ino}`;
}

/** The write lock serializes status changes from other CLI/plugin processes with the sync rename.
 * No await or recursive I/O inside the lock. A new run can then recreate the canonical path safely.
 */
function retire(task: TerminalTask, before: RootMark, record: Retirement, uid: number | null): boolean {
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    const fresh = db.prepare(`${TERMINAL_TASKS} WHERE t.id = ?`).get(task.id) as TerminalTask | undefined;
    if (!fresh || !sameStretch(fresh, task) || codeOf(fresh) !== record.card ||
      !tmpNamesFor(record.card).includes(basename(record.path))) return false;
    const info = lstatSync(record.path, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink() || (uid != null && Number(info.uid) !== uid) ||
      statIdentity(info) !== `${before.dev}:${before.ino}` || cardTmpGeneration(record.path) !== before.generation) return false;
    renameSync(record.path, record.retiredPath);
    return true;
  } finally {
    // This transaction only holds a write lock; the durable preparation event was committed beforehand.
    db.exec("ROLLBACK");
  }
}

/** Most retirement ids one tmp_cleaned summary row remembers; an older id simply finds its prepared row with no match and lstat says the path is gone. */
const RETIREMENT_ID_CAP = 200;

async function removeRetired(taskId: number, retirementId: number, record: Retirement, done: TmpCleaned[], now: number): Promise<void> {
  await rm(record.retiredPath, { recursive: true, force: true });
  done.push({ taskId, path: record.path, bytes: record.bytes });
  upsertSummaryEvent(taskId, "tmp_cleaned", "scheduler", record.path, { ...record, retirementId }, {
    at: new Date(now).toISOString(),
    list: { field: "retirementIds", entry: retirementId, cap: RETIREMENT_ID_CAP },
  });
}

/** A failed rm (or a crash after rename) retries the journaled old inode, never a newer card path. */
async function retryRetired(root: string, budget: number, done: TmpCleaned[], uid: number | null, now: number): Promise<void> {
  const rows = getDb().prepare(`SELECT e.id, e.task_id, e.data_json FROM events e WHERE e.kind = 'tmp_retirement_prepared'
    AND NOT EXISTS (SELECT 1 FROM events f WHERE f.task_id = e.task_id AND f.kind IN ('tmp_cleaned', 'tmp_retirement_cancelled')
      AND (json_extract(f.data_json, '$.retirementId') = e.id
        OR EXISTS (SELECT 1 FROM json_each(f.data_json, '$.retirementIds') j WHERE j.value = e.id)))`).all() as Array<{ id: number; task_id: number; data_json: string }>;
  for (const row of rows) {
    if (done.length >= budget) return;
    let record: Retirement | null = null;
    try {
      record = JSON.parse(row.data_json) as Retirement;
      if (dirname(record.path) !== root || dirname(record.retiredPath) !== root ||
        !/^[A-Za-z0-9]+_\d+$/.test(record.card) || !tmpNamesFor(record.card).includes(basename(record.path)) ||
        !new RegExp(`^\\.kanban-tmp-retired-${record.card}-[0-9a-f-]{36}$`).test(basename(record.retiredPath))) continue;
      if (protectedPath(root, record.path) || protectedPath(root, record.retiredPath)) continue;
      if (waiting(row.task_id, record.path, now)) continue;
      const info = await lstat(record.retiredPath, { bigint: true }).catch((err) => {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
      });
      if (!info) continue;
      if (!info.isDirectory() || info.isSymbolicLink() || String(info.dev) !== record.dev || String(info.ino) !== record.ino) continue;
      if (uid != null && Number(info.uid) !== uid) continue;
      const fresh = lstatSync(record.retiredPath, { bigint: true });
      if (!fresh.isDirectory() || fresh.isSymbolicLink() || fresh.dev !== info.dev || fresh.ino !== info.ino ||
        cardTmpGeneration(record.retiredPath) !== record.generation) continue;
      await removeRetired(row.task_id, row.id, record, done, now);
    } catch (err) {
      if (record) recordProblem(row.task_id, record.path, `cannot remove directory: ${errorText(err)}`, now, true);
      else console.error("[paseo-kanban] tmp retirement retry", errorText(err));
    }
  }
}

async function cleanRoot(root: string, names: Map<string, TerminalTask>, budget: number, done: TmpCleaned[], uid: number | null, now: number): Promise<void> {
  await retryRetired(root, budget, done, uid, now);
  if (done.length >= budget || names.size === 0) return;
  let entries: string[];
  try {
    countIo("readdir");
    entries = await readdir(root);
  } catch (err) {
    const reason = `cannot read work root: ${errorText(err)}`;
    for (const [entry, task] of names) recordProblem(task.id, join(root, entry), reason, now, true);
    return;
  }
  for (const entry of entries) {
    if (done.length >= budget) return;
    const task = names.get(entry);
    if (!task) continue;
    const path = join(root, entry);
    if (protectedPath(root, path) || waiting(task.id, path, now)) continue;
    try {
      countIo("stat");
      const info = await lstat(path);
      if (info.isSymbolicLink() || !info.isDirectory()) continue;
      if (uid != null && info.uid !== uid) {
        console.error(`[paseo-kanban] tmp cleanup keeps ${path}: owner`);
        continue;
      }
      const git = await lstat(join(path, ".git")).then(() => true, () => false);
      if (git) {
        console.error(`[paseo-kanban] tmp cleanup keeps ${path}: git_repository`);
        continue;
      }
      const before = await rootMark(path);
      const hold = await occupancy(task, path);
      if (hold) {
        recordProblem(task.id, path, hold.reason, now, hold.backoff);
        continue;
      }
      const bytes = await sizeOf(path);
      const again = await occupancy(task, path);
      if (again) {
        recordProblem(task.id, path, again.reason, now, again.backoff);
        continue;
      }
      const after = await rootMark(path);
      if (!sameRoot(before, after)) continue;
      const record: Retirement = {
        path, retiredPath: join(root, `.kanban-tmp-retired-${cardMarkOf(task)}-${randomUUID()}`), bytes,
        dev: String(before.dev), ino: String(before.ino), card: cardMarkOf(task), generation: before.generation,
      };
      if (protectedPath(root, record.retiredPath)) continue;
      const retirementId = appendEvent(task.id, "tmp_retirement_prepared", null, null, "scheduler", { ...record });
      if (!retire(task, before, record, uid)) {
        appendEvent(task.id, "tmp_retirement_cancelled", null, null, "scheduler", { retirementId });
        continue;
      }
      await removeRetired(task.id, retirementId, record, done, now);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // Already gone, or the root changed before we committed to it: not a failed removal.
      if (code === "ENOENT" || (err instanceof Error && err.message === "tmp directory changed")) continue;
      recordProblem(task.id, path, `cannot remove directory: ${errorText(err)}`, now, true);
    }
  }
}

/** Live agents, their cwd, and any process cwd. Owner and git are decided by the caller. */
async function occupancy(task: TerminalTask, path: string): Promise<Hold | null> {
  const agents = readCwdAgentList();
  if (!agents) return { reason: "the agent list could not be read", backoff: false };
  if (openedAgentLive(task, agents)) return { reason: "an agent opened by this card is still present", backoff: false };
  const live = agents.filter((agent) => !agent.archived).map((agent) => agent.cwd.trim()).filter(Boolean);
  if (await cwdInside(path, live)) return { reason: "an agent working directory is inside this card directory", backoff: false };
  const processes = roundProcessCwds();
  if (!processes) return { reason: "process working directories could not be listed", backoff: false };
  if (await cwdInside(path, processes)) return { reason: "a process working directory is inside this card directory", backoff: false };
  return null;
}

function openedAgentLive(task: TerminalTask, agents: CwdAgent[]): boolean {
  const live = new Set(agents.filter((agent) => !agent.archived).map((agent) => agent.id));
  return agentsOpenedBy(task).some((id) => live.has(id));
}

/** Delete owned card work directories as soon as the card is done or archived. Unrelated names stay. */
export async function cleanTmpDirs(options: TmpCleanOptions = {}): Promise<TmpCleaned[]> {
  const now = (options.now ?? new Date()).getTime();
  const done: TmpCleaned[] = [];
  const found = await roots(options.roots ?? defaultRoots(), !options.roots);
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  const budget = options.limit ?? Number.POSITIVE_INFINITY;
  const uid = options.ownerUid ?? (typeof process.getuid === "function" ? process.getuid() : null);
  roundCwds = undefined;
  for (const root of found) {
    if (done.length >= budget) break;
    await cleanRoot(root, terminalNames(options.roots ? undefined : root), budget, done, uid, now);
  }
  roundCwds = undefined;
  return done;
}

/** Scheduler hook: one scan at a time, every round, never awaited by the tick.
 * A request that arrives mid-round is kept and runs as soon as this round finishes,
 * so a card that ends during a long delete is still cleaned on the next round.
 */
export function scheduleTmpCleanup(options: TmpCleanOptions = {}): void {
  if (running) {
    pending = options;
    return;
  }
  running = round("tmpCleanup", () => cleanTmpDirs(options))
    .catch((err) => {
      console.error("[paseo-kanban] tmp cleanup", err instanceof Error ? err.message : err);
      return [] as TmpCleaned[];
    })
    .finally(() => {
      running = null;
      const next = pending;
      pending = null;
      if (next) scheduleTmpCleanup(next);
    });
}

/** Wait until every round already started, including one queued follow-up, has finished. For tests. */
export async function flushTmpCleanup(): Promise<void> {
  while (running) await running;
}
