/// <reference types="node" />
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "./paths";

/**
 * Board-level wakes (no card to hang an event on) are sent once per problem. The mark that says
 * "already sent" lives in a small file in the data dir, so a plugin reload does not send it again.
 * A mark is removed when the problem clears. Alert marks keep the newest MAX_MARKS. Skip marks
 * (`skip:<agent>:<kind>`, a log line that is only written once) never clear on their own, so they are
 * counted apart, capped at MAX_SKIP_MARKS, and expire after SKIP_MARK_TTL_MS; a pile of them cannot push
 * a live alert mark out.
 */
const MAX_MARKS = 100;
const MAX_SKIP_MARKS = 100;
const SKIP_MARK_TTL_MS = 7 * 24 * 60 * 60_000;
const SKIP_PREFIX = "skip:";

let cache: Map<string, string> | null = null;
let cachePath = "";

function marksPath(): string {
  return join(dataDir(), "board-wake-marks.json");
}

function load(): Map<string, string> {
  const path = marksPath();
  if (cache && cachePath === path) return cache;
  cachePath = path;
  cache = new Map();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { marks?: unknown };
    const marks = parsed.marks && typeof parsed.marks === "object" && !Array.isArray(parsed.marks) ? parsed.marks : {};
    for (const [key, at] of Object.entries(marks)) if (typeof at === "string") cache.set(key, at);
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException).code === "ENOENT";
    if (!missing) console.error("[paseo-kanban] board-wake-marks", err instanceof Error ? err.message : err);
  }
  return cache;
}

function save(marks: Map<string, string>): void {
  const path = marksPath();
  const newestFirst = (entries: Array<[string, string]>, max: number): Array<[string, string]> => entries.sort((a, b) => a[1].localeCompare(b[1])).slice(-max);
  const oldestSkip = new Date(Date.now() - SKIP_MARK_TTL_MS).toISOString();
  const all = [...marks.entries()];
  const kept = [
    ...newestFirst(all.filter(([key]) => !key.startsWith(SKIP_PREFIX)), MAX_MARKS),
    ...newestFirst(all.filter(([key, at]) => key.startsWith(SKIP_PREFIX) && at >= oldestSkip), MAX_SKIP_MARKS),
  ];
  marks.clear();
  for (const [key, at] of kept) marks.set(key, at);
  const temp = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(dataDir(), { recursive: true });
    writeFileSync(temp, `${JSON.stringify({ marks: Object.fromEntries(kept) }, null, 2)}\n`);
    renameSync(temp, path);
  } catch (err) {
    console.error("[paseo-kanban] board-wake-marks", err instanceof Error ? err.message : err);
  }
}

export function hasBoardWakeMark(key: string): boolean {
  return load().has(key);
}

export function addBoardWakeMark(key: string, at = new Date().toISOString()): void {
  const marks = load();
  marks.set(key, at);
  save(marks);
}

/** Cheap when the key is not marked: no file access after the first read. */
export function removeBoardWakeMark(key: string): void {
  const marks = load();
  if (!marks.delete(key)) return;
  save(marks);
}

/** Next read goes to the file again, as after a plugin reload. */
export function forgetBoardWakeMarkCache(): void {
  cache = null;
}

export function clearBoardWakeMarks(): void {
  cache = null;
  rmSync(marksPath(), { force: true });
}
