/// <reference types="node" />
import { mkdirSync, readFileSync, writeFileSync } from "./perf-fs";
import { join } from "node:path";
import { schedulerIdleNote, tickAgeMs, TICK_WAKE_MS } from "../shared/scheduler";
import { getDb } from "./db";
import { dataDir } from "./paths";
import { releaseBoardWake, wakeKanbanSupervisor } from "./wake";

/** Gitignored. compat and audit are other processes, so they read this instead of memory. */
export const SCHEDULER_TICK_FILE = "scheduler-tick.json";

let memoryAt: string | null = null;
const bootedAt = Date.now();

function idleAge(now: number): { at: string | null; ageMs: number } {
  const at = readSchedulerTickAt();
  if (at) return { at, ageMs: tickAgeMs(at, now) };
  return { at: null, ageMs: Math.max(0, now - bootedAt) };
}

/** Board text. A process that just started and has never ticked is not idle yet. */
export function currentSchedulerIdleNote(now = Date.now()): string | null {
  const { at, ageMs } = idleAge(now);
  return schedulerIdleNote(at, now, ageMs);
}

export function schedulerTickPath(): string {
  return join(dataDir(), SCHEDULER_TICK_FILE);
}

export function resetSchedulerTickForTests(): void {
  memoryAt = null;
}

/** Remember that a scheduler tick finished. Memory for this process, file for the others. */
export function noteSchedulerTick(at: Date): void {
  memoryAt = at.toISOString();
  try {
    mkdirSync(dataDir(), { recursive: true });
    writeFileSync(schedulerTickPath(), `${JSON.stringify({ at: memoryAt })}\n`);
  } catch (err) {
    console.error("[paseo-kanban] scheduler tick", err instanceof Error ? err.message : err);
  }
}

export function readSchedulerTickAt(): string | null {
  if (memoryAt) return memoryAt;
  try {
    const raw = JSON.parse(readFileSync(schedulerTickPath(), "utf8")) as { at?: unknown };
    return typeof raw.at === "string" ? raw.at : null;
  } catch {
    return null;
  }
}

function waitingCards(): number {
  const row = getDb().prepare("SELECT COUNT(*) AS n FROM tasks WHERE status IN ('ready', 'in_review')").get() as { n: number };
  return row.n;
}

/**
 * Wake once when the scheduler has not ticked for 5 minutes and a card is waiting.
 * Call this from a timer or from MCP/RPC. Do not call it from the scheduler tick.
 */
export function checkSchedulerIdle(now = Date.now()): boolean {
  const { at, ageMs } = idleAge(now);
  if (ageMs <= TICK_WAKE_MS) {
    releaseBoardWake("scheduler_idle");
    return false;
  }
  if (waitingCards() === 0) return false;
  const detail = schedulerIdleNote(at, now, ageMs);
  if (!detail) return false;
  return wakeKanbanSupervisor({
    taskId: null,
    kind: "scheduler_idle",
    detail,
  });
}
