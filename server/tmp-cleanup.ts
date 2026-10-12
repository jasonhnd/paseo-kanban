/// <reference types="node" />
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, renameSync, type BigIntStats } from "node:fs";
import { lstat, readdir, realpath, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { formatCardCode } from "../shared/card-code";
import { cardMarkOf } from "./card-ref";
import { cardTmpGeneration } from "./card-tmp";
import { getDb } from "./db";
import { upsertSummaryEvent } from "./event-summary";
import { pathWithin, readCwdAgentList } from "./missing-cwd";
import { countIo, round } from "./perf";
import { displayProjectCode } from "./project-codes";
import { appendEvent, type TaskRow } from "./store";

/** A card's own temp directory is deleted this long after the card turned done or archived. */
export const TMP_KEEP_MS = 24 * 60 * 60_000;
/** At most this many directories are deleted per round, so one tick never meets a flood of rm -rf. */
export const TMP_CLEAN_PER_ROUND = 20;
/** The scan reads /tmp at most this often. */
export const TMP_SCAN_EVERY_MS = 5 * 60_000;
const DEFAULT_ROOTS = ["/tmp", "/private/tmp"];

type TerminalTask = TaskRow & { ended_at: string | null; ended_event_id: number | null };
// Event id identifies the terminal stretch even if two events have the same timestamp.
const TERMINAL_TASKS = `SELECT t.*, e.at AS ended_at, e.id AS ended_event_id FROM tasks t
  LEFT JOIN events e ON e.id = (SELECT id FROM events WHERE task_id = t.id
    AND to_status IN ('done', 'archived') AND COALESCE(from_status, '') NOT IN ('done', 'archived')
    ORDER BY id DESC LIMIT 1)`;

function expired(task: TerminalTask, now: number): boolean {
  return (task.status === "done" || task.status === "archived") && now - Date.parse(task.ended_at ?? task.updated_at) >= TMP_KEEP_MS;
}

export interface TmpCleanOptions {
  now?: Date;
  roots?: string[];
  limit?: number;
  /** Tests skip the throttle. */
  force?: boolean;
  /** Only directories owned by this uid are deleted. Defaults to the current user. */
  ownerUid?: number;
}

export interface TmpCleaned {
  taskId: number;
  path: string;
  bytes: number;
}

let lastScanAt = 0;
let running: Promise<TmpCleaned[]> | null = null;

export function resetTmpCleanupForTests(): void {
  lastScanAt = 0;
  running = null;
}

/** The directory names that belong to one card and no other: DEMO_0001, demo_0001, demo-0001, demo0001. */
export function tmpNamesFor(code: string): string[] {
  const lower = code.toLowerCase();
  const [prefix, seq] = lower.split("_");
  if (!prefix || !seq) return [code];
  return [code, lower, `${prefix}-${seq}`, `${prefix}${seq}`];
}

function codeOf(task: TaskRow): string | null {
  if (task.code_seq == null) return null;
  const code = displayProjectCode(task.project);
  return code ? formatCardCode(code, task.code_seq) : null;
}

/** Directory name → card, for cards that have been over for the full keep time. Names claimed by two cards are dropped. */
function expiredNames(now: number): Map<string, TerminalTask> {
  const names = new Map<string, TerminalTask>();
  const clash = new Set<string>();
  // One query: each card's start of its current terminal stretch is its latest event into done/archived from a non-terminal state.
  const rows = getDb()
    .prepare(`${TERMINAL_TASKS} WHERE t.code_seq IS NOT NULL`)
    .all() as unknown as TerminalTask[];
  for (const task of rows) {
    const code = codeOf(task);
    if (!code) continue;
    const over = expired(task, now);
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

function sizeOf(path: string): Promise<number> {
  return new Promise((resolve) => {
    execFile("du", ["-sk", path], { timeout: 60_000 }, (err, stdout) => {
      const kb = err ? 0 : Number.parseInt(String(stdout).split(/\s/)[0] ?? "", 10);
      resolve(Number.isFinite(kb) ? kb * 1024 : 0);
    });
  });
}

async function roots(list: string[]): Promise<string[]> {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const root of list) {
    try {
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

/** True when any agent's cwd is the directory or inside it, comparing real paths so /tmp, /private/tmp and symlinks match. */
async function agentInside(path: string, cwds: string[]): Promise<boolean> {
  const real = await realOr(path);
  for (const cwd of cwds) {
    if (pathWithin(path, cwd) || pathWithin(real, cwd) || pathWithin(real, await realOr(cwd))) return true;
  }
  return false;
}

/** Why a directory must be kept, or null when it is safe to delete. Anything unreadable counts as a reason to keep. */
async function keepReason(path: string, uid: number | null): Promise<string | null> {
  const info = await lstat(path);
  if (uid != null && info.uid !== uid) return "owner";
  const agents = readCwdAgentList();
  if (!agents) return "agent_list_unreadable";
  if (await agentInside(path, agents.map((agent) => agent.cwd.trim()).filter(Boolean))) return "agent_cwd";
  const git = await lstat(join(path, ".git")).then(() => true, () => false);
  if (!git) return null;
  const unpushed = await new Promise<string | null>((resolve) => {
    execFile("git", ["-C", path, "rev-list", "HEAD", "--branches", "--not", "--remotes", "--max-count=1"], { timeout: 30_000 }, (err, stdout) => {
      resolve(err ? "unpushed_unknown" : String(stdout).trim() ? "unpushed" : null);
    });
  });
  return unpushed;
}

function statMark(info: BigIntStats): string {
  return `${info.dev}:${info.ino}:${info.mode}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
}

/** Include nested writes, replacements and removals; never follow symlinks or read file contents. */
async function activity(path: string): Promise<{ digest: string; info: BigIntStats; generation: string | null }> {
  const digest = createHash("sha256");
  const info = await lstat(path, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("tmp directory changed");
  const pending = [""];
  let count = 0;
  while (pending.length) {
    if (++count > 100_000) throw new Error("tmp activity scan limit reached; keeping directory");
    const relative = pending.pop()!;
    const item = relative ? await lstat(join(path, relative), { bigint: true }) : info;
    digest.update(JSON.stringify([relative, statMark(item)]));
    if (item.isDirectory()) {
      const entries = (await readdir(join(path, relative))).sort().reverse();
      for (const entry of entries) pending.push(join(relative, entry));
    }
  }
  return { digest: digest.digest("hex"), info, generation: cardTmpGeneration(path) };
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

/** The write lock serializes status changes from other CLI/plugin processes with the sync rename.
 * No await or recursive I/O inside the lock. A new run can then recreate the canonical path safely.
 */
function retire(task: TerminalTask, before: Awaited<ReturnType<typeof activity>>, record: Retirement, now: number, uid: number | null): boolean {
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    const fresh = db.prepare(`${TERMINAL_TASKS} WHERE t.id = ?`).get(task.id) as TerminalTask | undefined;
    if (!fresh || !expired(fresh, now) || fresh.ended_event_id !== task.ended_event_id ||
      (fresh.ended_at ?? fresh.updated_at) !== (task.ended_at ?? task.updated_at) || codeOf(fresh) !== record.card ||
      !tmpNamesFor(record.card).includes(basename(record.path))) return false;
    const info = lstatSync(record.path, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink() || (uid != null && info.uid !== BigInt(uid)) ||
      statMark(info) !== statMark(before.info) || cardTmpGeneration(record.path) !== before.generation) return false;
    renameSync(record.path, record.retiredPath);
    return true;
  } finally {
    // This transaction only holds a write lock; the durable preparation event was committed beforehand.
    db.exec("ROLLBACK");
  }
}

/** Most retirement ids one tmp_cleaned summary row remembers; an older id simply finds its prepared row with no match and lstat says the path is gone. */
const RETIREMENT_ID_CAP = 200;

async function removeRetired(taskId: number, retirementId: number, record: Retirement, done: TmpCleaned[]): Promise<void> {
  await rm(record.retiredPath, { recursive: true, force: true });
  done.push({ taskId, path: record.path, bytes: record.bytes });
  // One summary row per card and path (DEMO_0001). `retirementIds` keeps every journaled retirement this row settles.
  upsertSummaryEvent(taskId, "tmp_cleaned", "scheduler", record.path, { ...record, retirementId }, { list: { field: "retirementIds", entry: retirementId, cap: RETIREMENT_ID_CAP } });
}

/** A failed rm (or a crash after rename) can only retry the journaled old inode, never the card path. */
async function retryRetired(root: string, budget: number, done: TmpCleaned[], uid: number | null): Promise<void> {
  const rows = getDb().prepare(`SELECT e.id, e.task_id, e.data_json FROM events e WHERE e.kind = 'tmp_retirement_prepared'
    AND NOT EXISTS (SELECT 1 FROM events f WHERE f.task_id = e.task_id AND f.kind IN ('tmp_cleaned', 'tmp_retirement_cancelled')
      AND (json_extract(f.data_json, '$.retirementId') = e.id
        OR EXISTS (SELECT 1 FROM json_each(f.data_json, '$.retirementIds') j WHERE j.value = e.id)))`).all() as Array<{ id: number; task_id: number; data_json: string }>;
  for (const row of rows) {
    if (done.length >= budget) return;
    try {
      const record = JSON.parse(row.data_json) as Retirement;
      if (dirname(record.path) !== root || dirname(record.retiredPath) !== root ||
        !/^[A-Za-z0-9]+_\d+$/.test(record.card) || !tmpNamesFor(record.card).includes(basename(record.path)) ||
        !new RegExp(`^\\.kanban-tmp-retired-${record.card}-[0-9a-f-]{36}$`).test(basename(record.retiredPath))) continue;
      const info = await lstat(record.retiredPath, { bigint: true }).catch((err) => {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
      });
      if (!info) continue; // Preparation may have crashed before rename, or rm finished before recording success.
      if (!info.isDirectory() || info.isSymbolicLink() || String(info.dev) !== record.dev || String(info.ino) !== record.ino) continue;
      if (await keepReason(record.retiredPath, uid)) continue;
      const fresh = lstatSync(record.retiredPath, { bigint: true });
      if (!fresh.isDirectory() || fresh.isSymbolicLink() || fresh.dev !== info.dev || fresh.ino !== info.ino ||
        cardTmpGeneration(record.retiredPath) !== record.generation) continue;
      await removeRetired(row.task_id, row.id, record, done);
    } catch (err) {
      console.error("[paseo-kanban] tmp retirement retry", err instanceof Error ? err.message : err);
    }
  }
}

async function cleanRoot(root: string, names: Map<string, TerminalTask>, budget: number, done: TmpCleaned[], uid: number | null, now: number): Promise<void> {
  await retryRetired(root, budget, done, uid);
  if (done.length >= budget || names.size === 0) return;
  let entries: string[];
  try {
    countIo("readdir");
    entries = await readdir(root);
  } catch (err) {
    console.error("[paseo-kanban] tmp cleanup", err instanceof Error ? err.message : err);
    return;
  }
  for (const entry of entries) {
    if (done.length >= budget) return;
    const task = names.get(entry);
    if (!task) continue;
    const path = join(root, entry);
    try {
      countIo("stat");
      const info = await lstat(path);
      if (info.isSymbolicLink() || !info.isDirectory()) continue;
      const before = await activity(path);
      const keep = await keepReason(path, uid);
      if (keep) {
        console.error(`[paseo-kanban] tmp cleanup keeps ${path}: ${keep}`);
        continue;
      }
      const bytes = await sizeOf(path);
      // du/git/path resolution all await: refresh cwd/owner/git protection and the full activity snapshot.
      if (await keepReason(path, uid)) continue;
      const after = await activity(path);
      if (before.digest !== after.digest || before.generation !== after.generation) continue;
      const record: Retirement = {
        path, retiredPath: join(root, `.kanban-tmp-retired-${cardMarkOf(task)}-${randomUUID()}`), bytes,
        dev: String(before.info.dev), ino: String(before.info.ino), card: cardMarkOf(task), generation: before.generation,
      };
      // Persist the exact target before the rename, so a crash cannot leave an untracked old directory.
      const retirementId = appendEvent(task.id, "tmp_retirement_prepared", null, null, "scheduler", { ...record });
      if (!retire(task, before, record, now, uid)) {
        appendEvent(task.id, "tmp_retirement_cancelled", null, null, "scheduler", { retirementId });
        continue;
      }
      await removeRetired(task.id, retirementId, record, done);
    } catch (err) {
      console.error("[paseo-kanban] tmp cleanup", path, err instanceof Error ? err.message : err);
    }
  }
}

/** Delete /tmp/<card> directories of cards over for 24 hours. Async; never touches names that are not an exact card code. */
export async function cleanTmpDirs(options: TmpCleanOptions = {}): Promise<TmpCleaned[]> {
  const now = (options.now ?? new Date()).getTime();
  const done: TmpCleaned[] = [];
  const found = await roots(options.roots ?? DEFAULT_ROOTS);
  // After the first await, so the tick that started this has already returned.
  await new Promise((resolve) => setImmediate(resolve));
  const names = expiredNames(now);
  const budget = options.limit ?? TMP_CLEAN_PER_ROUND;
  const uid = options.ownerUid ?? (typeof process.getuid === "function" ? process.getuid() : null);
  for (const root of found) {
    if (done.length >= budget) break;
    await cleanRoot(root, names, budget, done, uid, now);
  }
  return done;
}

/** Scheduler hook: throttled, one scan at a time, never awaited by the tick. */
export function scheduleTmpCleanup(options: TmpCleanOptions = {}): void {
  const now = (options.now ?? new Date()).getTime();
  if (running || (!options.force && now - lastScanAt < TMP_SCAN_EVERY_MS)) return;
  lastScanAt = now;
  running = round("tmpCleanup", () => cleanTmpDirs(options))
    .catch((err) => {
      console.error("[paseo-kanban] tmp cleanup", err instanceof Error ? err.message : err);
      return [] as TmpCleaned[];
    })
    .finally(() => {
      running = null;
    });
}

/** Wait for the scan in flight. For tests. */
export async function flushTmpCleanup(): Promise<void> {
  if (running) await running;
}
