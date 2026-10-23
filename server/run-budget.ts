/// <reference types="node" />
import { t } from "../shared/i18n";
import { getDb } from "./db";
import { carryRunBudget } from "./run-cost";
import { addComment, appendEvent, blockTask, getTask, type TaskRow } from "./store";
import { effectiveRunBudget, type RunBudgetLimits } from "./run-budget-config";
import type { KanbanConfig } from "./config";
import { guardCard, withTimeout } from "./guard";
import { notifyTask } from "./wake";

export interface BudgetTurn {
  id: string;
  at: string;
  text: string;
  tools: Array<{ name: string; command?: string; input?: unknown }>;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
}
export interface BudgetObservation {
  source: string;
  turns: BudgetTurn[];
  complete: boolean;
  notes: string[];
}
export interface RunBudgetState {
  generation: string;
  agentId: string;
  startedAt: string;
  durationMs: number;
  observedAt?: string;
  turns: number;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  tokenStatus: "available" | "partial" | "unavailable";
  source: string;
  notes: string[];
  consecutiveWaits: number;
  limits: RunBudgetLimits;
  warned: boolean;
  degraded: boolean;
  phase: "running" | "braking" | "braked";
  interrupted?: boolean;
  interruptAttempts?: number;
  lastInterruptAt?: number;
  recent: string[];
}
export interface RunBudgetScan {
  now: Date;
  config: KanbanConfig;
  read?: (agentId: string) => Promise<BudgetObservation>;
  interrupt?: (agentId: string) => Promise<void>;
  /** R1 can supply its durable board-side wait state without a dependency on its implementation. */
  backgroundWaiting?: (task: TaskRow) => boolean;
}

function round(task: TaskRow) {
  const event = getDb().prepare(`SELECT id, at, data_json FROM events WHERE task_id = ? AND to_status IN ('running','reviewing')
    AND from_status IS NOT NULL AND from_status != to_status AND kind != 'background_resumed'
    AND NOT (kind = 'unblocked' AND CASE WHEN json_valid(data_json) THEN coalesce(json_extract(data_json, '$.via'), '') ELSE '' END = 'background_wait')
    ORDER BY id DESC LIMIT 1`).get(task.id) as { id: number; at: string; data_json: string } | undefined;
  const run = getDb().prepare("SELECT id, started_at FROM runs WHERE task_id = ? AND agent_id = ? ORDER BY id DESC LIMIT 1")
    .get(task.id, task.agent_id) as { id: number; started_at: string } | undefined;
  const at = event?.at && (!run || Date.parse(event.at) >= Date.parse(run.started_at)) ? event.at : run?.started_at ?? task.created_at;
  let override: unknown;
  try { override = JSON.parse(event?.data_json ?? "{}").runBudget; } catch { /* Legacy malformed event has no override. */ }
  return { generation: `${task.agent_id}:${run?.id ?? 0}:${event?.id ?? 0}`, startedAt: at, override };
}
export function runBudgetSnapshot(id: number): RunBudgetState | null {
  const row = getDb().prepare("SELECT state_json FROM run_budget_state WHERE task_id = ?").get(id) as { state_json: string } | undefined;
  return row ? JSON.parse(row.state_json) : null;
}
function save(id: number, state: RunBudgetState): void {
  getDb().prepare(`INSERT INTO run_budget_state (task_id, generation, state_json) VALUES (?, ?, ?)
    ON CONFLICT(task_id) DO UPDATE SET generation = excluded.generation, state_json = excluded.state_json`).run(id, state.generation, JSON.stringify(state));
}
function stillCurrent(task: TaskRow, generation: string): boolean {
  const fresh = getTask(task.id);
  return fresh.status === task.status && fresh.agent_id === task.agent_id && round(fresh).generation === generation;
}
const normalize = (text: string) => text.toLowerCase().replace(/[\p{P}\p{Z}\d]/gu, "").trim();
function waitingTool(tool: BudgetTurn["tools"][number]): boolean {
  const name = tool.name.split(/[./]/).at(-1) ?? "";
  if (/^(wait|sleep|wait_agent|wait_for_completion|poll)$/.test(name)) return true;
  if (name === "write_stdin") {
    const args = tool.input as { chars?: unknown } | undefined;
    return !!args && (args.chars === undefined || args.chars === "");
  }
  const command = tool.command?.trim() ?? "";
  if (/^(sleep\s+[\d.]+|tail\s+[^;&|]+|ps(?:\s+[^;&|]+)?|kill\s+-0\s+\d+)\s*$/.test(command)) return true;
  if (name === "exec") {
    const calls = [...command.matchAll(/tools\.([\w]+)\s*\(/g)].map(x => x[1]);
    return calls.length > 0 && calls.every(x => /^(wait|sleep|write_stdin|clock__sleep|clock__curr_time)$/.test(x)) &&
      !/chars\s*:\s*["'][^"']/.test(command);
  }
  return false;
}
function waitTurn(turn: BudgetTurn, previousText: string): boolean {
  // A real command/read/edit always breaks the streak, even if its accompanying text repeats.
  if (turn.tools.length) return turn.tools.every(waitingTool);
  const text = normalize(turn.text);
  return Boolean(text) && (/^(continuewaiting|stillwaiting|waiting|\u7ee7\u7eed\u7b49\u5f85|\u7b49\u5f85\u4e2d|\u5f15\u304d\u7d9a\u304d\u5f85\u6a5f)/u.test(text) || text.length >= 8 && text === previousText);
}

/** Durable wait intervals also filter late timeline pages, rather than merely skipping a tick. */
function backgroundIntervals(task: TaskRow, since: string): Array<[number, number]> {
  const rows = getDb().prepare(`SELECT at, kind, data_json FROM events WHERE task_id = ? AND at >= ?
    AND kind IN ('background_wait_started','background_wait_finished','background_wait','background_resumed','unblocked') ORDER BY id`).all(task.id, since) as Array<{ at: string; kind: string; data_json: string }>;
  const result: Array<[number, number]> = [];
  let start: number | null = null;
  for (const row of rows) {
    let data;
    try { data = JSON.parse(row.data_json); } catch { continue; }
    if (row.kind === "unblocked" && data.via !== "background_wait") continue;
    if (data.agentId && data.agentId !== task.agent_id) continue;
    if (data.generation && data.generation !== round(task).generation) continue;
    if (row.kind === "background_wait_started" || row.kind === "background_wait") start ??= Date.parse(row.at);
    else if (start !== null) { result.push([start, Date.parse(row.at)]); start = null; }
  }
  if (start !== null) result.push([start, Infinity]);
  return result;
}
function warningDelivered(id: number, generation: string): boolean {
  const state = runBudgetSnapshot(id);
  if (state?.generation !== generation) return true;
  return Boolean(getDb().prepare(`SELECT id FROM events WHERE task_id = ? AND kind = 'wake_run_budget_warning'
    AND json_extract(data_json, '$.generation') = ? AND json_extract(data_json, '$.delivered') = 1 LIMIT 1`).get(id, generation));
}
function summary(state: RunBudgetState, hits: Array<{ name: string; actual: number; limit: number }>, warning = false): string {
  return [t(warning ? "runBudget.warning" : "runBudget.brake"),
    ...hits.map(hit => t("runBudget.metric", hit)),
    t("runBudget.totals", { durationMs: state.durationMs, turns: state.turns, tokens: state.tokens, cached: state.cachedInputTokens, waits: state.consecutiveWaits }),
    t("runBudget.source", { source: state.source, status: state.tokenStatus }),
    ...(state.notes.length ? [t("runBudget.notes", { notes: state.notes.join("; ") })] : []),
    t("runBudget.recent", { recent: state.recent.join(" | ") || "-" }), t("runBudget.next")].join("\n");
}
async function interrupt(task: TaskRow, state: RunBudgetState, input: RunBudgetScan): Promise<void> {
  if (!input.interrupt || state.interrupted) return;
  if (state.lastInterruptAt !== undefined && input.now.getTime() - state.lastInterruptAt < 60_000) return;
  state.phase = "braking"; state.lastInterruptAt = input.now.getTime(); state.interruptAttempts = (state.interruptAttempts ?? 0) + 1;
  const claimed = getDb().prepare(`UPDATE run_budget_state SET state_json = ? WHERE task_id = ? AND generation = ?
    AND coalesce(json_extract(state_json, '$.interrupted'), 0) = 0
    AND (json_extract(state_json, '$.lastInterruptAt') IS NULL OR json_extract(state_json, '$.lastInterruptAt') <= ?)`)
    .run(JSON.stringify(state), task.id, state.generation, input.now.getTime() - 60_000);
  if (claimed.changes !== 1) return;
  try {
    await withTimeout(() => {
      if (!stillCurrent(task, state.generation)) throw new Error("Run generation changed before interrupt");
      return input.interrupt!(state.agentId);
    }, "run budget interrupt");
    if (!stillCurrent(task, state.generation)) return;
    state.interrupted = true;
    appendEvent(task.id, "run_budget_interrupted", null, task.status, "run-budget", { generation: state.generation, agentId: state.agentId });
  } catch (error) {
    if (!stillCurrent(task, state.generation)) return;
    if (state.interruptAttempts === 1) {
      const text = t("runBudget.interruptFailed");
      addComment(task.id, "run-budget", text);
      appendEvent(task.id, "run_budget_interrupt_failed", null, task.status, "run-budget", { generation: state.generation, message: String(error).slice(0, 200) });
    }
  }
  state.phase = "braked"; save(task.id, state);
}

async function check(id: number, input: RunBudgetScan): Promise<void> {
  const task = getTask(id);
  if (!task.agent_id) return;
  const current = round(task);
  let state = runBudgetSnapshot(id);
  if (task.status === "blocked") {
    if (state?.generation === current.generation && state.phase !== "running") await interrupt(task, state, input);
    return;
  }
  if (task.status !== "running" && task.status !== "reviewing") return;
  if (!state || state.generation !== current.generation) {
    if (state) carryRunBudget(getDb(), id, input.now);
    state = { generation: current.generation, agentId: task.agent_id, startedAt: current.startedAt,
      durationMs: 0, turns: 0, tokens: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0,
      tokenStatus: "unavailable", source: "unavailable", notes: [], consecutiveWaits: 0,
      limits: effectiveRunBudget(task.project, input.config, current.override), warned: false, degraded: false, phase: "running", recent: [] };
    getDb().prepare("DELETE FROM run_budget_turns WHERE task_id = ?").run(id);
    save(id, state);
    appendEvent(id, "run_budget_started", null, task.status, "run-budget", { generation: state.generation, startedAt: state.startedAt, limits: state.limits });
  }
  state.limits = effectiveRunBudget(task.project, input.config, current.override);
  let sample: BudgetObservation;
  try { sample = await withTimeout(() => input.read!(task.agent_id!), "run budget observation"); }
  catch { sample = { source: state.source, turns: [], complete: false, notes: ["Activity unavailable; enforcing wall clock and previously observed usage"] }; }
  if (!stillCurrent(task, state.generation)) return;
  state.observedAt = input.now.toISOString();
  state.durationMs = Math.max(0, input.now.getTime() - Date.parse(state.startedAt));
  const intervals = backgroundIntervals(task, state.startedAt);
  const background = input.backgroundWaiting?.(task) === true;
  const insert = getDb().prepare("INSERT INTO run_budget_turns (task_id,generation,source,turn_id,at,turn_json) VALUES (?,?,?,?,?,?) ON CONFLICT(task_id,generation,source,turn_id) DO UPDATE SET turn_json = json_patch(run_budget_turns.turn_json, excluded.turn_json)");
  for (const turn of sample.turns) {
    const at = Date.parse(turn.at);
    if (!Number.isFinite(at) || at < Date.parse(state.startedAt) || at > input.now.getTime()) continue;
    if (background || intervals.some(([start, end]) => at >= start && at <= end)) continue;
    insert.run(id, state.generation, sample.source, turn.id, turn.at, JSON.stringify(turn));
  }
  // Per-call Codex telemetry supersedes the canonical lower bound; sources are never added together.
  const preferred = getDb().prepare("SELECT 1 FROM run_budget_turns WHERE task_id = ? AND generation = ? AND source = 'codex-token-count' LIMIT 1").get(id, state.generation)
    ? "codex-token-count" : sample.source;
  const rows = getDb().prepare("SELECT turn_json FROM run_budget_turns WHERE task_id = ? AND generation = ? AND source = ? ORDER BY at, rowid")
    .all(id, state.generation, preferred) as Array<{ turn_json: string }>;
  const turns: BudgetTurn[] = rows.map(row => JSON.parse(row.turn_json));
  state.source = preferred; state.notes = sample.notes; state.turns = turns.length;
  state.inputTokens = turns.reduce((n, turn) => n + (turn.inputTokens ?? 0), 0);
  state.outputTokens = turns.reduce((n, turn) => n + (turn.outputTokens ?? 0), 0);
  state.cachedInputTokens = turns.reduce((n, turn) => n + (turn.cachedInputTokens ?? 0), 0);
  state.tokens = state.inputTokens + state.outputTokens;
  const known = turns.filter(x => x.inputTokens !== undefined && x.outputTokens !== undefined).length;
  state.tokenStatus = !known ? "unavailable" : known < turns.length || !sample.complete ? "partial" : "available";
  state.consecutiveWaits = 0;
  let previousText = "";
  for (const turn of turns) {
    state.consecutiveWaits = waitTurn(turn, previousText) ? state.consecutiveWaits + 1 : 0;
    previousText = normalize(turn.text);
  }
  state.recent = turns.slice(-5).map(x => `${x.at} ${x.text.slice(0, 160)} [${x.tools.map(y => y.name).join(", ")}]`);
  if (state.tokenStatus !== "available" && !state.degraded) {
    state.degraded = true;
    const text = t("runBudget.degraded", { source: state.source, notes: state.notes.join("; ") || state.tokenStatus });
    addComment(id, "run-budget", text); appendEvent(id, "run_budget_degraded", null, task.status, "run-budget", { generation: state.generation, text });
  }
  const metrics = [
    { name: "durationMs", actual: state.durationMs, limit: state.limits.maxDurationMs },
    { name: "turns", actual: state.turns, limit: state.limits.maxTurns },
    { name: "tokens", actual: state.tokens, limit: state.limits.maxTokens },
    { name: "consecutiveWaits", actual: state.consecutiveWaits, limit: state.limits.maxConsecutiveWaits },
  ];
  const exceeded = metrics.filter(x => x.actual >= x.limit);
  if (exceeded.length) {
    // Claim synchronously before the external stop. Lifecycle hooks now see a blocked card,
    // and overlapping ticks cannot claim the same generation again.
    const db = getDb();
    db.exec("BEGIN IMMEDIATE");
    let blocked: TaskRow;
    try {
      if (!stillCurrent(task, state.generation)) { db.exec("ROLLBACK"); return; }
      state.phase = "braking"; save(id, state);
      blocked = blockTask(id, "needs_human", summary(state, exceeded), "run-budget", { generation: state.generation });
      db.prepare("UPDATE runs SET ended_at = ?, end_kind = 'run_budget' WHERE task_id = ? AND agent_id = ? AND ended_at IS NULL")
        .run(input.now.toISOString(), id, task.agent_id);
      appendEvent(id, "run_budget_braked", null, "blocked", "run-budget", { generation: state.generation, exceeded, snapshot: state });
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    await interrupt(blocked, state, input);
    return;
  }
  const warning = metrics.filter(x => x.actual >= x.limit * 0.8);
  if (warning.length && !state.warned) {
    state.warned = true;
    const text = summary(state, warning, true);
    addComment(id, "run-budget", text); appendEvent(id, "run_budget_warning", null, task.status, "run-budget", { generation: state.generation, text });
  }
  save(id, state);
  if (state.warned && !warningDelivered(id, state.generation)) {
    const generation = state.generation;
    notifyTask(task, "run_budget_warning", summary(state, warning, true), false, undefined,
      { key: generation, current: () => runBudgetSnapshot(id)?.generation === generation && stillCurrent(task, generation) });
  }
}

// One in-flight read/stop per card and database. A timed-out read can return later but
// cannot apply its result to a new generation. Durable state deduplicates later ticks/reloads.
const inflight = new Map<string, Promise<void>>();
export async function scanRunBudgets(input: RunBudgetScan): Promise<void> {
  if (!input.read || !input.interrupt) return;
  const rows = getDb().prepare("SELECT id FROM tasks WHERE status IN ('running','reviewing','blocked') AND agent_id IS NOT NULL ORDER BY id").all() as Array<{ id: number }>;
  for (const { id } of rows) {
    const key = `${process.env.KANBAN_DATA_DIR ?? "default"}:${id}`;
    const previous = inflight.get(key);
    if (previous) { await previous; continue; }
    const pending = guardCard(id, "tick.runBudget", () => check(id, input), input.now);
    inflight.set(key, pending);
    try { await pending; } finally { if (inflight.get(key) === pending) inflight.delete(key); }
  }
}
