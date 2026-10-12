/// <reference types="node" />
// Read-only 7-day tally of what each Claude <leader> did itself, from ~/.claude/projects/<dir>/*.jsonl.
// The tally is recomputed in the background at most once per TTL; the snapshot only reads the memo.
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { tokyoDayStart } from "../../shared/fleet/dispatch";
import { addStats, classifyToolUse, EMPTY_WEEK_STATS, tokyoDayKey, WEEK_MS, WEEK_STATS_TTL_MS, type WeekStats } from "../../shared/fleet/leader-week";

export const CLAUDE_PROJECTS = join(homedir(), ".claude", "projects");

/** Pure: the tool-call counts of one jsonl line and when they happened, or null if it is not a counted assistant tool call. Bad lines are skipped. */
export function lineStats(line: string, cutoff: number): { at: number; stats: WeekStats } | null {
  if (!line.includes("tool_use")) return null;
  let entry: any;
  try { entry = JSON.parse(line); } catch { return null; }
  const at = Date.parse(entry?.timestamp);
  if (entry?.type !== "assistant" || !Number.isFinite(at) || at < cutoff || !Array.isArray(entry.message?.content)) return null;
  let stats = EMPTY_WEEK_STATS;
  for (const block of entry.message.content) {
    if (block?.type !== "tool_use" || typeof block.name !== "string") continue;
    const command = typeof block.input?.command === "string" ? block.input.command : "";
    stats = addStats(stats, classifyToolUse(block.name, command));
  }
  return { at, stats };
}
/** Pure: add one jsonl line to the tally if it is an assistant tool call newer than cutoff (ms). Bad lines are skipped. */
export function tallyLine(line: string, cutoff: number, stats: WeekStats): WeekStats {
  const hit = lineStats(line, cutoff);
  return hit ? addStats(stats, hit.stats) : stats;
}
export function tallyLines(lines: Iterable<string>, cutoff: number, into: WeekStats = EMPTY_WEEK_STATS): WeekStats {
  let stats = into;
  for (const line of lines) stats = tallyLine(line, cutoff, stats);
  return stats;
}

export async function scanProjectDir(dir: string, now: number): Promise<WeekStats | null> {
  let names: string[];
  try { names = (await readdir(dir)).filter((n) => n.endsWith(".jsonl")); } catch { return null; }
  const cutoff = now - WEEK_MS;
  let stats = EMPTY_WEEK_STATS;
  for (const name of names) {
    const file = join(dir, name);
    if (((await stat(file).catch(() => null))?.mtimeMs ?? 0) < cutoff) continue;
    const rl = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
    for await (const line of rl) stats = tallyLine(line, cutoff, stats);
  }
  return stats;
}

/** Same scan, but split by Tokyo calendar day ("2026-10-05"); only days in [now - days, now] are counted. */
export async function scanProjectDirByDay(dir: string, now: number, days = 8): Promise<Map<string, WeekStats> | null> {
  let names: string[];
  try { names = (await readdir(dir)).filter((n) => n.endsWith(".jsonl")); } catch { return null; }
  const cutoff = tokyoDayStart(now) - (days - 1) * 86_400_000;
  const byDay = new Map<string, WeekStats>();
  for (const name of names) {
    const file = join(dir, name);
    if (((await stat(file).catch(() => null))?.mtimeMs ?? 0) < cutoff) continue;
    const rl = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
    for await (const line of rl) {
      const hit = lineStats(line, cutoff);
      if (!hit) continue;
      const day = tokyoDayKey(hit.at);
      byDay.set(day, addStats(byDay.get(day) ?? EMPTY_WEEK_STATS, hit.stats));
    }
  }
  return byDay;
}

interface Memo { at: number; value: WeekStats | null }
const memo = new Map<string, Memo>();
const inflight = new Map<string, Promise<void>>();

/**
 * Returns the last tally immediately (undefined while the first one is still being computed).
 * A stale tally triggers one background recompute; callers never wait for the scan.
 */
export function weekStatsFor(
  dir: string, now: number, scan: (dir: string, now: number) => Promise<WeekStats | null> = scanProjectDir,
): WeekStats | null | undefined {
  const hit = memo.get(dir);
  if ((!hit || now - hit.at >= WEEK_STATS_TTL_MS) && !inflight.has(dir)) {
    const job = scan(dir, now).then((value) => { memo.set(dir, { at: now, value }); }, () => { memo.set(dir, { at: now, value: hit?.value ?? null }); })
      .finally(() => inflight.delete(dir));
    inflight.set(dir, job);
  }
  return hit?.value;
}
export function pendingWeekScans(): Promise<unknown> { return Promise.all(inflight.values()); }
export function resetWeekStats(): void { memo.clear(); inflight.clear(); }
