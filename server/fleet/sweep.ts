/// <reference types="node" />
// Collect role agents that finished outside Kanban and are still sitting in Paseo.
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { t } from "../../shared/fleet/i18n";
import { readUnfinishedAgentIds } from "./kanban";
import { KANBAN_ABSENT, kanbanSource } from "./kanban-source";
import { type AgentRecord, readAgentRecords } from "./records";
import {
  type ArchiveCandidate,
  archiveCommandArgs,
  normalizeSweepState,
  selectIdleAgents,
  type SweepAgent,
} from "./sweep-select";
import { BIN, clearCache, type Json, readJson, runJson, runOutcome, STATE_DIR, tilde, writeJson } from "./util";

export const SWEEP_FIRST_DELAY_MS = 2 * 60_000;
export const SWEEP_INTERVAL_MS = 60 * 60_000;
export const ARCHIVE_TIMEOUT_MS = 60_000;
export const MAX_CONSECUTIVE_FAILURES = 3;
export const SWEEP_LOG_LIMIT = 20;

export const SWEEP_LOG = join(STATE_DIR, "sweep.log");
const SWEEP_STATE = join(STATE_DIR, "sweep-state.json");

export interface SweepLogLine {
  at: string;
  agentId: string | null;
  title: string;
  cwd: string;
  idleHours: number | null;
  result: "archived" | "failed" | "would_archive" | "aborted";
  reason: string | null;
}

const RESULTS = new Set<SweepLogLine["result"]>(["archived", "failed", "would_archive", "aborted"]);

interface SweepState {
  enabled: boolean;
  failures: Record<string, number>;
}

function flat(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

async function loadState(): Promise<SweepState> {
  const raw = await readJson<Json>(SWEEP_STATE, {});
  return normalizeSweepState(raw);
}

async function saveState(state: SweepState): Promise<void> {
  await writeJson(SWEEP_STATE, state);
}

async function appendSweepLog(line: SweepLogLine): Promise<void> {
  const safe: SweepLogLine = {
    ...line,
    title: flat(line.title),
    cwd: flat(line.cwd),
    reason: line.reason === null ? null : flat(line.reason).slice(0, 300),
  };
  await mkdir(dirname(SWEEP_LOG), { recursive: true });
  await appendFile(SWEEP_LOG, `${JSON.stringify(safe)}\n`, "utf8");
}

export async function readSweepEntries(limit = SWEEP_LOG_LIMIT): Promise<SweepLogLine[]> {
  const text = await readFile(SWEEP_LOG, "utf8").catch(() => "");
  const rows: SweepLogLine[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const c = JSON.parse(line) as Json;
      const result = String(c.result ?? "");
      if (!RESULTS.has(result as SweepLogLine["result"])) continue;
      rows.push({
        at: String(c.at ?? ""),
        agentId: c.agentId == null || c.agentId === "" ? null : String(c.agentId),
        title: String(c.title ?? ""),
        cwd: String(c.cwd ?? ""),
        idleHours: typeof c.idleHours === "number" ? c.idleHours : null,
        result: result as SweepLogLine["result"],
        reason: c.reason == null || c.reason === "" ? null : String(c.reason),
      });
    } catch {
      continue;
    }
  }
  return rows.slice(-limit).reverse();
}

export async function readSweepView(): Promise<{ enabled: boolean; entries: SweepLogLine[] }> {
  const state = await loadState();
  return { enabled: state.enabled, entries: await readSweepEntries() };
}

export async function setSweepEnabled(enabled: boolean): Promise<boolean> {
  const state = await loadState();
  state.enabled = enabled;
  await saveState(state);
  return state.enabled;
}

function matchesPending(agentId: string, pending: readonly string[]): boolean {
  return pending.some((raw) => {
    const p = raw.trim();
    if (!p) return false;
    if (agentId === p) return true;
    const short = p.length <= agentId.length ? p : agentId;
    const long = p.length <= agentId.length ? agentId : p;
    return short.length >= 8 && long.startsWith(short);
  });
}

function toSweepAgent(rec: AgentRecord, pending: readonly string[]): SweepAgent {
  return {
    id: rec.id,
    title: rec.title,
    cwd: rec.cwd,
    status: rec.status,
    updatedAt: rec.updatedAt,
    lastActivityAt: rec.lastActivityAt,
    archivedAt: rec.archivedAt,
    requiresAttention: rec.requiresAttention,
    attentionReason: rec.attentionReason,
    pendingPermission: matchesPending(rec.id, pending),
    lastError: rec.lastError,
  };
}

async function pendingAgentIds(): Promise<{ ok: true; ids: string[] } | { ok: false; error: string }> {
  try {
    const raw = await runJson<unknown>(BIN.paseo, ["permit", "ls", "--json"], 15_000);
    const list = Array.isArray(raw)
      ? raw
      : raw && typeof raw === "object" && Array.isArray((raw as Json).items)
        ? ((raw as Json).items as unknown[])
        : raw && typeof raw === "object" && Array.isArray((raw as Json).requests)
          ? ((raw as Json).requests as unknown[])
          : null;
    if (!list) return { ok: false, error: t("sweep.pendingNotList") };
    const ids: string[] = [];
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      const row = item as Json;
      const id = String(row.agentId ?? row.agent ?? "");
      if (id) ids.push(id);
    }
    return { ok: true, ids };
  } catch (e) {
    return { ok: false, error: t("sweep.pendingUnreadable", { error: String(e).slice(0, 160) }) };
  }
}

function logLine(candidate: ArchiveCandidate, result: SweepLogLine["result"], reason: string | null): SweepLogLine {
  return {
    at: new Date().toISOString(),
    agentId: candidate.id,
    title: candidate.title,
    cwd: tilde(candidate.cwd),
    idleHours: candidate.idleHours,
    result,
    reason,
  };
}

async function abortRound(reason: string): Promise<void> {
  await appendSweepLog({
    at: new Date().toISOString(),
    agentId: null,
    title: "",
    cwd: "",
    idleHours: null,
    result: "aborted",
    reason,
  });
  console.error(`[afc] idle sweep aborted: ${reason}`);
}

let sweeping = false;

export async function runIdleSweep(): Promise<void> {
  if (sweeping) return;
  sweeping = true;
  try {
    await sweepOnce();
  } catch (e) {
    console.error(`[afc] idle sweep: ${String(e).slice(0, 300)}`);
  } finally {
    sweeping = false;
  }
}

async function sweepOnce(): Promise<void> {
  console.log("[afc] idle sweep: start");
  // Without Kanban there is no way to tell which agents still belong to a card: skip before any command runs.
  if (kanbanSource().presence === "absent") {
    await abortRound(KANBAN_ABSENT);
    return;
  }
  const state = await loadState();
  const pending = await pendingAgentIds();
  if (!pending.ok) {
    await abortRound(pending.error);
    return;
  }
  const kanban = readUnfinishedAgentIds();
  if (!kanban.ok) {
    await abortRound(kanban.error);
    return;
  }
  clearCache("records");
  const records = await readAgentRecords();
  const decision = selectIdleAgents(records.map((rec) => toSweepAgent(rec, pending.ids)), kanban.ids, Date.now());
  if (decision.aborted) {
    await abortRound(decision.aborted);
    return;
  }
  if (!state.enabled) {
    for (const candidate of decision.archive) {
      await appendSweepLog(logLine(candidate, "would_archive", t("sweep.switchOff")));
    }
    console.log(`[afc] idle sweep: disabled, ${decision.archive.length} candidate(s)`);
    return;
  }
  let archived = 0;
  let failed = 0;
  let skippedCap = 0;
  for (const candidate of decision.archive) {
    if ((state.failures[candidate.id] ?? 0) >= MAX_CONSECUTIVE_FAILURES) {
      skippedCap += 1;
      continue;
    }
    const outcome = await runOutcome(BIN.paseo, archiveCommandArgs(candidate.id), ARCHIVE_TIMEOUT_MS);
    if (outcome.ok) {
      delete state.failures[candidate.id];
      await saveState(state);
      await appendSweepLog(logLine(candidate, "archived", null));
      archived += 1;
      continue;
    }
    state.failures[candidate.id] = (state.failures[candidate.id] ?? 0) + 1;
    await saveState(state);
    const why = outcome.timedOut
      ? t("sweep.timedOut", { error: outcome.error ?? t("sweep.noResponse60s") })
      : (outcome.error ?? t("sweep.archiveFailed"));
    await appendSweepLog(logLine(candidate, "failed", why));
    failed += 1;
  }
  console.log(`[afc] idle sweep: archived ${archived}, failed ${failed}, skipped-after-3 ${skippedCap}`);
}

/** First pass shortly after the plugin loads, then once an hour. Returns a stop function for unload. */
export function startIdleSweep(): () => void {
  let interval: ReturnType<typeof setInterval> | null = null;
  const first = setTimeout(() => {
    void runIdleSweep();
    interval = setInterval(() => {
      void runIdleSweep();
    }, SWEEP_INTERVAL_MS);
  }, SWEEP_FIRST_DELAY_MS);
  return () => {
    clearTimeout(first);
    if (interval) clearInterval(interval);
  };
}
