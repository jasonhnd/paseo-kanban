/// <reference types="node" />
// Daily archive of what each <leader> did itself, appended to leader-activity.jsonl at the repo root (gitignored by /*.jsonl).
// The Claude session jsonl can be pruned or the leader session replaced; the archive keeps the history for the weekly review.
import { appendFile, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { tokyoDayStart } from "../../shared/fleet/dispatch";
import { codeCommits, tokyoDayKey, type WeekStats } from "../../shared/fleet/leader-week";
import { scanProjectDirByDay } from "./leader-week";
import { logSwallowed, STATE_DIR } from "./util";

export const LEADER_ACTIVITY_FILE = join(STATE_DIR, "leader-activity.jsonl");
export const ARCHIVE_EVERY_MS = 60 * 60_000;

/** One line per leader (project) per finished Tokyo day. `commit` is code only; `docCommit` is the doc-only commits. */
export interface ArchiveOwner { project: string; code: string; dir: string }
export interface ActivityRecord {
  day: string; project: string; code: string;
  /** Session directory name. One directory-day is written once, whichever project asks. */
  dir: string;
  dispatch: number; merge: number; commit: number; docCommit: number; test: number; edit: number;
  at: string;
}

export function activityRecord(day: string, who: ArchiveOwner, stats: WeekStats, at: number): ActivityRecord {
  return {
    day, project: who.project, code: who.code, dir: who.dir, dispatch: stats.dispatch, merge: stats.merge, commit: codeCommits(stats), docCommit: stats.docCommit,
    test: stats.test, edit: stats.edit, at: new Date(at).toISOString(),
  };
}
const hasActivity = (stats: WeekStats): boolean => Object.values(stats).some((n) => n > 0);

/** Pure: parse the archive, skipping bad lines. */
export function parseActivity(text: string): ActivityRecord[] {
  const rows: ActivityRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const raw = JSON.parse(line);
      if (typeof raw?.day === "string" && typeof raw.project === "string") rows.push(raw as ActivityRecord);
    } catch { /* a broken line must not hide the rest */ }
  }
  return rows;
}

/**
 * Pure: records still missing from the archive. Only finished days (before today in Tokyo) are written, so a record
 * never needs a later correction, and a day with nothing counted is skipped.
 */
export function missingRecords(
  byDay: ReadonlyMap<string, WeekStats>, existing: readonly ActivityRecord[], who: ArchiveOwner, now: number,
): ActivityRecord[] {
  const today = tokyoDayKey(tokyoDayStart(now));
  const have = new Set(existing.filter((r) => r.project === who.project || (r.dir !== undefined && r.dir === who.dir)).map((r) => r.day));
  return [...byDay.entries()]
    .filter(([day, stats]) => day < today && !have.has(day) && hasActivity(stats))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, stats]) => activityRecord(day, who, stats, now));
}

/** Append what is missing for one leader. Returns the lines written; null when its session directory cannot be read. */
export async function archiveLeaderDays(
  dir: string, who: { project: string; code: string }, now: number, file = LEADER_ACTIVITY_FILE,
): Promise<ActivityRecord[] | null> {
  const byDay = await scanProjectDirByDay(dir, now);
  if (!byDay) return null;
  const existing = parseActivity(await readFile(file, "utf8").catch(() => ""));
  const rows = missingRecords(byDay, existing, { ...who, dir: basename(dir) }, now);
  if (rows.length > 0) await appendFile(file, rows.map((r) => `${JSON.stringify(r)}\n`).join(""), "utf8");
  return rows;
}

const lastRun = new Map<string, number>();
const running = new Map<string, Promise<unknown>>();
/**
 * Called from the panel refresh. At most once per hour per session directory, in the background; never throws.
 * Two projects sharing one leader session share the directory, so only the first one seen is archived.
 */
export function noteLeaderForArchive(dir: string, who: { project: string; code: string }, now: number, file = LEADER_ACTIVITY_FILE): void {
  if (running.has(dir) || now - (lastRun.get(dir) ?? -Infinity) < ARCHIVE_EVERY_MS) return;
  lastRun.set(dir, now);
  const job = archiveLeaderDays(dir, who, now, file).catch((error) => logSwallowed("leader activity archive", error)).finally(() => running.delete(dir));
  running.set(dir, job);
}
export function pendingArchives(): Promise<unknown> { return Promise.all(running.values()); }
export function resetArchiveForTests(): void { lastRun.clear(); running.clear(); }
