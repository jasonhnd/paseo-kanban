import { canonicalPoolId, canonicalPoolRows } from "../shared/fleet/x-ultra";
/// <reference types="node" />
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { formatCardCode, isProjectCode } from "../shared/card-code";
import { profilesFromConfig } from "../shared/fleet/dispatch";
import { operationalExecution } from "../shared/fleet/executor-effort";
import { estimateRunCost, summarizeRunCosts, type CostQuery, type RunCost } from "../shared/fleet/run-cost";
import { assertTestDataPath, dataDir, paseoConfigPath } from "./paths";
import { isTier, resolveTier } from "./tier";
import type { RunBudgetState } from "./run-budget";

export const RUN_COST_FILE = "run-costs.json";
export const MAX_QUOTA_AGE_MS = 30 * 60_000;
/** Allow the normal scheduler observation cadence before an ordinary completion. */
export const MAX_TOKEN_AGE_MS = 2 * 60_000;
type Json = Record<string, any>;
function read(path: string): Json { try { return JSON.parse(readFileSync(path, "utf8")) ?? {}; } catch { return {}; } }
function parsed(text: unknown): Json { try { return typeof text === "string" ? JSON.parse(text) ?? {} : {}; } catch { return {}; } }
const numeric = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
interface Reading { pct: number | null; at: string | null; reset: string | null; stale: boolean }
function reading(dir: string, pool: string | null, at: string): Reading {
  const file = read(join(dir, "fleet/pool-status.json"));
  const raw = pool ? canonicalPoolRows<Record<string, any>>(file.pools ?? {})[canonicalPoolId(pool)!] : null;
  const row = raw && typeof raw === "object" ? raw : null;
  const observed = row && "observedAt" in row ? row.observedAt : file.generatedAt;
  const age = Date.parse(at) - Date.parse(observed);
  const valid = row?.state !== "unknown" && numeric(row?.usedPct) && row.usedPct <= 100 && Number.isFinite(age) && age >= 0;
  return { pct: valid ? row!.usedPct : null, at: typeof observed === "string" ? observed : null,
    reset: typeof row?.resetsAt === "string" ? row.resetsAt : null, stale: !valid || age > MAX_QUOTA_AGE_MS };
}
function startContext(raw: string, capture: boolean, dir: string): Json {
  const row = parsed(raw);
  const config = read(join(dir, "kanban.config.json"));
  const code = config.projects?.[row.project]?.code;
  const profilePath = paseoConfigPath();
  let host: Json = {};
  // Cost tracking also runs in low-level DB fixtures: never let those fixtures
  // discover the personal host config when they did not provide an isolated one.
  try { assertTestDataPath(profilePath); host = read(profilePath); } catch { /* Unknown pool. */ }
  const profile = profilesFromConfig(host)?.find(p => p.name === row.profile);
  const tagsRaw: unknown = parsed(row.tags);
  const tags: string[] = Array.isArray(tagsRaw) ? tagsRaw.filter((t: unknown) => typeof t === "string") : [];
  const matrix = read(join(dir, "fleet/dispatch-matrix.json"));
  const pool = canonicalPoolId(profile?.pool) ?? null;
  return { cardCode: typeof code === "string" && isProjectCode(code) && row.codeSeq != null ? formatCardCode(code, row.codeSeq) : `#${row.taskId}`,
    runId: row.runId, agentId: row.agentId, role: row.role, tier: resolveTier(row.tier, tags, isTier(matrix.defaultTier ?? "") ? matrix.defaultTier : null),
    cardType: row.role === "reviewer" ? "review" : row.role === "reader" ? "read"
      : operationalExecution({ role: row.role, tags, title: row.title, brief: row.brief }) ? "ops" : row.role === "executor" ? "code" : row.role,
    pool, provider: row.provider, model: row.model, effort: row.effort, startedAt: row.startedAt,
    quota: capture ? reading(dir, pool, row.startedAt) : { pct: null, at: null, reset: null, stale: true } };
}
/** Accept only observations belonging to this run, including across budget resets. */
function budgetForRun(context: Json, state: Json): RunBudgetState | null {
  return typeof state.generation === "string" && state.generation.startsWith(`${context.agentId}:${context.runId}:`)
    && state.agentId === context.agentId && Date.parse(state.startedAt) >= Date.parse(context.startedAt)
    ? state as RunBudgetState : null;
}
const knownTokens = (state: RunBudgetState) => state.tokenStatus !== "unavailable" && numeric(state.inputTokens) && numeric(state.outputTokens);
function finishContext(context: Json, endedAt: string, state: Json, dir: string): RunCost {
  const before = context.quota as Reading;
  const after = reading(dir, context.pool, endedAt);
  const generations = new Map<string, RunBudgetState>();
  for (const raw of Object.values(context.budgetGenerations ?? {})) {
    const carried = raw && typeof raw === "object" ? budgetForRun(context, raw as Json) : null;
    if (carried) generations.set(carried.generation, carried);
  }
  const budget = budgetForRun(context, state);
  // The final state supersedes a checkpoint from the same generation, never adds to it.
  if (budget) generations.set(budget.generation, budget);
  const segments = [...generations.values()];
  const known = segments.some(knownTokens);
  const complete = segments.length > 0 && segments.every(s => knownTokens(s) && s.tokenStatus === "available");
  const inputTokens = segments.reduce((n, s) => n + (knownTokens(s) ? s.inputTokens : 0), 0);
  const outputTokens = segments.reduce((n, s) => n + (knownTokens(s) ? s.outputTokens : 0), 0);
  const cached = segments.filter(s => knownTokens(s) && numeric(s.cachedInputTokens));
  const cachedInputTokens = cached.reduce((n, s) => n + s.cachedInputTokens, 0);
  const observedTurns = segments.filter(s => numeric(s.turns));
  const turns = observedTurns.length ? observedTurns.reduce((n, s) => n + s.turns, 0) : null;
  const notes: string[] = ["Quota delta is pool-wide and can include overlapping runs or personal usage"];
  if (!known) notes.push("Per-call tokens unavailable for this run; no zero was substituted");
  if (segments.length && !complete) notes.push("Run-budget tokens include partial or unavailable generations; totals are a lower bound");
  if (segments.length && !budget) notes.push("No current generation after reset; carried usage is a lower bound");
  const budgetAge = Date.parse(endedAt) - Date.parse(budget?.observedAt ?? "");
  const budgetFresh = Number.isFinite(budgetAge) && budgetAge >= 0 && budgetAge <= MAX_TOKEN_AGE_MS;
  if (budget && !budgetFresh) notes.push("The final interval exceeds the two-minute token observation window or is undated; tokens are a lower bound");
  if (before.stale || after.stale) notes.push("Quota reading missing or stale (over 30 minutes from the run endpoint)");
  const sameWindow = before.reset === after.reset && (!before.reset || Date.parse(before.reset) > Date.parse(endedAt));
  const newReading = before.at !== null && after.at !== null && Date.parse(after.at) > Date.parse(before.at);
  if (!newReading) notes.push("No new quota reading during the run; delta unavailable rather than an invented zero");
  const delta = numeric(before.pct) && numeric(after.pct) && sameWindow && newReading && after.pct >= before.pct ? after.pct - before.pct : null;
  if (!sameWindow || numeric(before.pct) && numeric(after.pct) && after.pct < before.pct) notes.push("Quota reset boundary; percentage delta unavailable");
  for (const segment of segments) notes.push(...(Array.isArray(segment.notes) ? segment.notes : []));
  const any = known || numeric(before.pct) || numeric(after.pct) || turns !== null;
  const measured = complete && budget?.tokenStatus === "available" && budgetFresh && !before.stale && !after.stale && delta !== null;
  const { agentId: _agent, startedAt, quota: _quota, budgetGenerations: _generations, ...identity } = context;
  identity.pool = canonicalPoolId(identity.pool) ?? null;
  return { ...identity, tokensIn: known ? inputTokens : null, tokensOut: known ? outputTokens : null,
    tokensCached: cached.length ? cachedInputTokens : null,
    quotaPctBefore: before.pct, quotaPctAfter: after.pct, quotaPctDelta: delta,
    quotaObservedBefore: before.at, quotaObservedAfter: after.at,
    wallMs: Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)) || 0,
    turns,
    source: measured ? "measured" : any ? "partial" : "unknown", finishedAt: endedAt, notes } as RunCost;
}

// SQL observes every writer, including recovery, cancellation and cloud paths. The row is
// committed/rolled back with runs, before budget state can be cleared for a new generation.
const contextSql = `json_object('runId', NEW.id, 'taskId', NEW.task_id, 'agentId', NEW.agent_id,
  'role', NEW.role, 'provider', NEW.provider, 'model', NEW.model, 'effort', NEW.effort,
  'profile', NEW.profile_name, 'startedAt', NEW.started_at, 'project', t.project,
  'codeSeq', t.code_seq, 'title', t.title, 'brief', t.brief, 'tags', t.tags, 'tier', t.tier)`;
const budgetSql = `(SELECT state_json FROM run_budget_state WHERE task_id = NEW.task_id)`;

/** Save a generation before its budget state/turns are discarded. The start context
 * is already durable and keeps this map private; no schema or trigger change is needed.
 */
export function carryRunBudget(db: DatabaseSync, taskId: number, now = new Date()): void {
  const row = db.prepare("SELECT state_json FROM run_budget_state WHERE task_id = ?").get(taskId) as { state_json: string } | undefined;
  if (!row) return;
  const state = parsed(row.state_json);
  const runs = db.prepare(`SELECT r.id, c.start_json, ${contextSql.replaceAll("NEW.", "r.")} AS run_json
    FROM runs r JOIN tasks t ON t.id = r.task_id LEFT JOIN run_cost_snapshots c ON c.run_id = r.id
    WHERE r.task_id = ? AND r.agent_id = ? AND r.ended_at IS NULL`).all(taskId, state.agentId ?? null) as Array<{ id: number; start_json: string | null; run_json: string }>;
  for (const run of runs) {
    // Runs already open at installation have no start reading; preserve that unknown.
    const context = run.start_json ? parsed(run.start_json) : startContext(run.run_json, false, dataDir());
    if (!budgetForRun(context, state)) continue;
    const age = now.getTime() - Date.parse(state.observedAt ?? "");
    const partial = !Number.isFinite(age) || age < 0 || age > MAX_TOKEN_AGE_MS;
    const snapshot = { generation: state.generation, agentId: state.agentId, startedAt: state.startedAt, observedAt: state.observedAt,
      inputTokens: state.inputTokens, outputTokens: state.outputTokens, cachedInputTokens: state.cachedInputTokens, turns: state.turns,
      tokenStatus: state.tokenStatus === "available" && partial ? "partial" : state.tokenStatus,
      notes: [...(Array.isArray(state.notes) ? state.notes : []), ...(partial ? ["Generation reset after an unsampled interval; carried tokens are a lower bound"] : [])] };
    const carried = { [state.generation]: snapshot };
    // JSON merge replaces a repeated generation's absolute counters. The write checks
    // the run is still open, so a concurrent finish cannot change a frozen record.
    db.prepare(`INSERT INTO run_cost_snapshots(run_id, start_json)
      SELECT ?, ? WHERE EXISTS (SELECT 1 FROM runs WHERE id = ? AND ended_at IS NULL)
      ON CONFLICT(run_id) DO UPDATE SET start_json = json_set(run_cost_snapshots.start_json, '$.budgetGenerations',
        json_patch(coalesce(json_extract(run_cost_snapshots.start_json, '$.budgetGenerations'), '{}'), json(?)))
      WHERE run_cost_snapshots.record_json IS NULL`)
      .run(run.id, JSON.stringify({ ...context, budgetGenerations: carried }), run.id, JSON.stringify(carried));
  }
}

export const RUN_COST_TRIGGERS = `
CREATE TRIGGER IF NOT EXISTS runs_cost_started AFTER INSERT ON runs BEGIN
  INSERT INTO run_cost_snapshots(run_id, start_json)
    SELECT NEW.id, kanban_cost_start(${contextSql}, NEW.ended_at IS NULL) FROM tasks t WHERE t.id = NEW.task_id;
  UPDATE run_cost_snapshots SET record_json = kanban_cost_finish(start_json, NEW.ended_at, ${budgetSql})
    WHERE run_id = NEW.id AND NEW.ended_at IS NOT NULL;
END;
CREATE TRIGGER IF NOT EXISTS runs_cost_finished AFTER UPDATE OF ended_at ON runs
WHEN OLD.ended_at IS NULL AND NEW.ended_at IS NOT NULL BEGIN
  INSERT OR IGNORE INTO run_cost_snapshots(run_id, start_json)
    SELECT NEW.id, kanban_cost_start(${contextSql}, 0) FROM tasks t WHERE t.id = NEW.task_id;
  UPDATE run_cost_snapshots SET record_json = kanban_cost_finish(start_json, NEW.ended_at, ${budgetSql})
    WHERE run_id = NEW.id AND record_json IS NULL;
END;`;

/** Bind per-connection readers before installing triggers. No DB calls inside SQL functions. */
export function bindRunCostFunctions(db: DatabaseSync, dir: string): void {
  let queued = false;
  db.function("kanban_cost_start", (raw, capture) => JSON.stringify(startContext(String(raw), Boolean(capture), dir)));
  db.function("kanban_cost_finish", (raw, at, state) => {
    const record = JSON.stringify(finishContext(parsed(raw), String(at), parsed(state), dir));
    if (!queued) {
      queued = true;
      queueMicrotask(() => {
        queued = false;
        // A rollback cannot leak a file record. Long transactions retry on the scheduler tick.
        if (!db.isOpen || db.isTransaction) return;
        try { publishRunCosts(db, dir); } catch (error) { console.error("[kanban] run cost export deferred", String(error).slice(0, 120)); }
      });
    }
    return record;
  });
}
export function publishRunCosts(db: DatabaseSync, dir = dataDir()) {
  const records = () => (db.prepare("SELECT record_json FROM run_cost_snapshots WHERE record_json IS NOT NULL ORDER BY run_id").all() as Array<{ record_json: string }>).map(row => ({ ...JSON.parse(row.record_json), pool: canonicalPoolId(JSON.parse(row.record_json).pool) ?? null }) as RunCost);
  // Serialize file publication with other database writers, so an older export cannot
  // overwrite a newer one from another CLI process. SQLite remains the durable source.
  const transaction = !db.isTransaction;
  if (transaction) db.exec("BEGIN IMMEDIATE");
  try {
    const rows = records();
    const result = { version: 1, records: rows, averages: summarizeRunCosts(rows) };
    if (transaction && rows.length) {
      const path = join(dir, "fleet", RUN_COST_FILE);
      const content = JSON.stringify(result);
      let old = ""; try { old = readFileSync(path, "utf8"); } catch { /* First export. */ }
      if (content !== old) {
        mkdirSync(join(dir, "fleet"), { recursive: true, mode: 0o700 });
        const pending = `${path}.${process.pid}.pending`;
        writeFileSync(pending, content, { mode: 0o600 }); renameSync(pending, path);
      }
    }
    if (transaction) db.exec("COMMIT");
    return result;
  } catch (error) { if (transaction) db.exec("ROLLBACK"); throw error; }
}

/** G2 entry point. Optional role/tier narrow the primary model/effort/type grouping. */
export function costEstimate(query: CostQuery, dir = dataDir()) {
  const file = read(join(dir, "fleet", RUN_COST_FILE));
  return estimateRunCost(Array.isArray(file.records) ? file.records : [], query);
}
