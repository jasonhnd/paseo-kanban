/// <reference types="node" />
// Once a day at 08:30 (Asia/Tokyo) run the health check, append the result to doctor-history.jsonl, and tell the AFC
// <leader> only about reds that were not already announced today. The check itself is read-only; this file is the
// only part that writes (the history line and doctor-state.json), and only from the plugin timer.
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type DoctorDailyState, dailyRunDue, doctorNotice, historyLine, newReds, normalizeDailyState, recordNotified, tokyoClock } from "../../shared/fleet/doctor-daily";
import type { DoctorReport } from "../../shared/fleet/doctor";
import { runDoctor } from "./doctor";
import type { BoardSummary } from "../contract";
import { kanbanSource } from "./kanban-source";
import { kanbanConfigPath } from "./paths";
import { readJson, sendToAgent, STATE_DIR, writeJson } from "./util";
import { readOpsProject } from "./adapters/config";
import { readSupervisorTable, supervisorIdFor } from "../../shared/fleet/decisions";

export const DOCTOR_STATE_PATH = join(STATE_DIR, "doctor-state.json");
export const DOCTOR_HISTORY_PATH = join(STATE_DIR, "doctor-history.jsonl");
const KANBAN_CONFIG = kanbanConfigPath();
const TICK_MS = 60_000;
const FIRST_TICK_MS = 45_000;

/** The AFC leader as the board summary lists it; undefined when the summary has no such project. */
export function summaryLeaderId(summary: BoardSummary | null, opsProject = readOpsProject()): string | null | undefined {
  const row = summary?.projects.find((project) => project.name.toLowerCase() === opsProject.toLowerCase());
  if (!row) return undefined;
  return row.leaderAgentId?.trim() || null;
}

export function afcLeaderId(config: unknown, opsProject = readOpsProject()): string | null {
  return supervisorIdFor(opsProject, readSupervisorTable(config));
}

export interface DailyDeps {
  now: () => number;
  run: () => Promise<DoctorReport>;
  loadState: () => Promise<DoctorDailyState>;
  saveState: (state: DoctorDailyState) => Promise<void>;
  appendHistory: (line: string) => Promise<void>;
  leaderId: () => Promise<string | null>;
  notify: (agentId: string, text: string) => Promise<void>;
}

export function productionDailyDeps(): DailyDeps {
  return {
    now: Date.now,
    run: () => runDoctor(),
    loadState: async () => normalizeDailyState(await readJson<unknown>(DOCTOR_STATE_PATH, null)),
    saveState: (state) => writeJson(DOCTOR_STATE_PATH, state),
    appendHistory: async (line) => {
      await mkdir(dirname(DOCTOR_HISTORY_PATH), { recursive: true });
      await appendFile(DOCTOR_HISTORY_PATH, `${line}\n`);
    },
    leaderId: async () => {
      const source = kanbanSource();
      if (source.presence === "absent") return null;
      const project = readOpsProject();
      const fromSummary = summaryLeaderId(source.summary, project);
      return fromSummary !== undefined ? fromSummary : afcLeaderId(await readJson<unknown>(KANBAN_CONFIG, null), project);
    },
    notify: (agentId, text) => sendToAgent(agentId, text),
  };
}

async function sendNotice(deps: DailyDeps, text: string): Promise<boolean> {
  const id = await deps.leaderId();
  // Standalone and first-run installations can have no registered leader yet.
  if (!id) return false;
  await deps.notify(id, text);
  return true;
}

/**
 * Returns true when it ran or sent something. The day is marked done only after the doctor ran and the history line
 * was written; a failed run is tried again next minute. A notice that fails to send is kept in the state and only
 * the sending is retried (same day), so the reds are not lost and the doctor is not run again.
 */
export async function runDailyOnce(deps: DailyDeps): Promise<boolean> {
  const state = await deps.loadState();
  const now = deps.now();
  const day = tokyoClock(now).day;
  if (state.pending && state.pending.day === day) {
    if (!await sendNotice(deps, state.pending.text)) return false;
    await deps.saveState(recordNotified({ ...state, pending: null }, day, state.pending.keys));
    return true;
  }
  if (!dailyRunDue(now, state)) return false;
  const report = await deps.run();
  await deps.appendHistory(historyLine(report));
  const reds = newReds(report, state, day);
  const text = doctorNotice(reds, day);
  const keys = reds.map((row) => row.key);
  const done = { ...state, lastRunDay: day, pending: null };
  if (reds.length === 0) {
    await deps.saveState(done);
    return true;
  }
  await deps.saveState({ ...done, pending: { day, text, keys } });
  try {
    if (!await sendNotice(deps, text)) return true;
  } catch (error) {
    console.error("[afc] doctor: notice not sent; only the notice is retried next minute:", String(error).slice(0, 200));
    return true;
  }
  await deps.saveState(recordNotified(done, day, keys));
  return true;
}

export function startDoctorDaily(deps: DailyDeps = productionDailyDeps()): () => void {
  let busy = false;
  const tick = () => {
    if (busy) return;
    busy = true;
    void runDailyOnce(deps)
      .catch((error) => console.error("[afc] doctor daily:", String(error).slice(0, 200)))
      .finally(() => {
        busy = false;
      });
  };
  const first = setTimeout(tick, FIRST_TICK_MS);
  const timer = setInterval(tick, TICK_MS);
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
