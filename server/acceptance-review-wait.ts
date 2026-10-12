import { t } from "../shared/i18n";
import { cardMarkOf } from "./card-ref";
import { getDb } from "./db";
import { DEFAULT_LOGIN_BLIP_RETRY_MS, loadConfig } from "./config";
import { LOGIN_BLIP_REOPENS } from "./failures";
import { clearLeaderUnresponsive } from "./leader-activity";
import type { TaskRow } from "./task-record";

export interface AcceptanceEntry { id: number; at: string }
export function acceptanceEntry(task: TaskRow): AcceptanceEntry {
  // Imported cards may have no transition. Housekeeping updated_at is never an age clock.
  return (getDb().prepare(`SELECT id, at FROM events WHERE task_id = ? AND to_status = 'acceptance'
    AND from_status IS NOT NULL AND from_status != 'acceptance' ORDER BY id DESC LIMIT 1`)
    .get(task.id) as AcceptanceEntry | undefined) ?? { id: 0, at: task.created_at };
}

type WaitReason = "quota" | "rate_limit" | "retry" | "concurrency" | "dependency" | "running";
export interface AcceptanceReviewWait {
  acceptanceEventId: number;
  reviews: Array<{ id: number; code: string; reason: WaitReason }>;
}
type Facts = TaskRow & {
  created_event_id: number | null; state_entry_id: number;
  state_kind: string | null; state_actor: string | null; state_from: string | null; state_at: string | null; state_json: string | null;
  held_id: number | null; held_json: string | null;
  run_id: number | null; run_agent: string | null; run_role: string | null; run_started: string | null; run_ended: string | null; run_end_kind: string | null;
  started_json: string | null;
};
type Candidate = Facts & {
  target_id: number; acceptance_id: number; acceptance_at: string;
  dependency_wait: number;
};

const factColumns = `c.id AS created_event_id, COALESCE(s.id, c.id, 0) AS state_entry_id,
  s.kind AS state_kind, s.actor AS state_actor, s.from_status AS state_from, s.at AS state_at, s.data_json AS state_json,
  h.id AS held_id, h.data_json AS held_json, run.id AS run_id, run.agent_id AS run_agent, run.role AS run_role,
  run.started_at AS run_started, run.ended_at AS run_ended, run.end_kind AS run_end_kind, st.data_json AS started_json`;
const factJoins = `LEFT JOIN events c ON c.id = (SELECT id FROM events WHERE task_id = r.id AND kind = 'created' ORDER BY id LIMIT 1)
  LEFT JOIN events s ON s.id = (SELECT id FROM events WHERE task_id = r.id AND to_status = r.status
    AND from_status IS NOT NULL AND from_status != to_status ORDER BY id DESC LIMIT 1)
  LEFT JOIN events h ON h.id = (SELECT id FROM events WHERE task_id = r.id AND kind = 'held' ORDER BY id DESC LIMIT 1)
  LEFT JOIN runs run ON run.id = (SELECT id FROM runs WHERE task_id = r.id ORDER BY id DESC LIMIT 1)
  LEFT JOIN events st ON st.id = (SELECT id FROM events WHERE task_id = r.id AND kind = 'started'
    AND id <= s.id ORDER BY id DESC LIMIT 1)`;
function data(raw: string | null): Record<string, unknown> | null {
  try { const value = JSON.parse(raw ?? 'null'); return value && typeof value === 'object' && !Array.isArray(value) ? value : null; }
  catch { return null; }
}
function currentProblem(row: Facts): boolean {
  return row.status === 'blocked' || row.status === 'rework' || Boolean(row.wait_decision) ||
    Boolean(row.blocked_kind && !['quota', 'rate_limit', 'transient'].includes(row.blocked_kind));
}
function liveRun(row: Facts, role: string): boolean {
  const started = data(row.started_json);
  if (!row.agent_id || row.run_agent !== row.agent_id || row.run_role !== role || row.run_ended != null) return false;
  // Production writes the run just before its started event; their timestamps can differ by milliseconds.
  if (started?.agentId != null) return started.agentId === row.run_agent && started.role === role &&
    (started.reviewerRunId == null || started.reviewerRunId === row.run_id);
  return Boolean(row.run_started && row.state_at && Date.parse(row.run_started) >= Date.parse(row.state_at));
}
/** Producer transitions bind a requeue to the preceding started run; a bare blocked_kind proves nothing. */
function retryReason(row: Facts, role: string, loginBlipRetryMs: number): WaitReason | null {
  if (!['ready', 'in_review'].includes(row.status) || !['requeued', 'login_blip'].includes(row.state_kind ?? '') || row.state_actor !== 'scheduler' ||
      row.state_from !== (row.status === 'in_review' ? 'reviewing' : 'running') || row.run_role !== role || !row.run_ended) return null;
  const queued = data(row.state_json), started = data(row.started_json);
  if (!queued || !started || !row.run_agent || started.agentId !== row.run_agent || started.role !== role ||
      (role === 'reviewer' && started.reviewerRunId !== row.run_id)) return null;
  if (row.state_kind === 'login_blip') {
    // login-blip.ts records no cooldown in the event: its closed run's timestamp
    // plus the configured retry interval must reproduce the current cooldown exactly.
    const ended = Date.parse(row.run_ended);
    return queued.agentId === row.run_agent && Number.isInteger(queued.attempt) &&
      Number(queued.attempt) > 0 && Number(queued.attempt) <= LOGIN_BLIP_REOPENS &&
      row.run_end_kind === 'transient' && row.blocked_kind === 'transient' &&
      row.agent_id === (row.status === 'in_review' ? row.executor_agent_id : null) &&
      Number.isFinite(ended) && typeof row.cooldown_until === 'string' &&
      Date.parse(row.cooldown_until) === ended + loginBlipRetryMs ? 'retry' : null;
  }
  if (queued.kind !== row.run_end_kind) return null;
  if (queued.kind === 'quota' || queued.kind === 'rate_limit') {
    return queued.counted === false && row.blocked_kind === queued.kind && row.blocked_reason === queued.message &&
      typeof queued.cooldownUntil === 'string' && queued.cooldownUntil === row.cooldown_until &&
      Date.parse(queued.cooldownUntil) > Date.parse(row.run_ended) ? queued.kind : null;
  }
  if ((queued.kind === 'transient' || queued.kind === 'other') && row.blocked_kind == null && row.blocked_reason == null && row.cooldown_until == null &&
      row.agent_id === (row.status === 'in_review' ? row.executor_agent_id : null) &&
      queued.failCount === row.fail_count && queued.maxRetries === row.max_retries && row.fail_count > 0 && row.fail_count < row.max_retries) return 'retry';
  return null;
}
function heldReason(row: Facts): WaitReason | null {
  if (!['ready', 'in_review'].includes(row.status) || row.held_id == null || row.held_id < row.state_entry_id) return null;
  const held = data(row.held_json);
  if (!held || typeof held.reason !== 'string' || !held.reason || held.reason !== row.hold_reason) return null;
  if (held.kind === 'quota' && held.quotaWait === true) return 'quota';
  return held.kind === 'concurrency' ? 'concurrency' : null;
}

/**
 * One status-bounded query, plus one bounded ancestor batch only for dependency waits. No titles, comments,
 * profile names or provider guesses. Creation must belong to this acceptance round;
 * an old open reviewer cannot suppress a resubmission. No cached result survives an await.
 */
export function loadAcceptanceReviewWaits(targetId?: number): Map<number, AcceptanceReviewWait> {
  const rows = getDb().prepare(`WITH RECURSIVE ancestors(review_id, id) AS (
    SELECT r.id, l.parent_id FROM tasks r JOIN links l ON l.task_id = r.id
      JOIN tasks target ON target.id = r.review_of AND target.project = r.project
      WHERE r.role = 'reviewer' AND r.status = 'waiting' AND target.status = 'acceptance'
    UNION SELECT a.review_id, l.parent_id FROM ancestors a JOIN links l ON l.task_id = a.id
  ) SELECT r.*, target.id AS target_id,
    COALESCE(a.id, 0) AS acceptance_id, COALESCE(a.at, target.created_at) AS acceptance_at,
    ${factColumns},
    (EXISTS (SELECT 1 FROM links l JOIN tasks p ON p.id = l.parent_id
      WHERE l.task_id = r.id AND p.status IN ('waiting','ready','running','in_review','reviewing','acceptance'))
     AND NOT EXISTS (SELECT 1 FROM ancestors a JOIN tasks p ON p.id = a.id
      WHERE a.review_id = r.id AND p.id IN (target.id, r.id))) AS dependency_wait
    FROM tasks r JOIN tasks target ON target.id = r.review_of AND target.project = r.project
    LEFT JOIN events a ON a.id = (SELECT id FROM events WHERE task_id = target.id AND to_status = 'acceptance'
      AND from_status IS NOT NULL AND from_status != 'acceptance' ORDER BY id DESC LIMIT 1)
    ${factJoins}
    WHERE r.status IN ('ready','waiting','running','in_review','reviewing','blocked','rework')
      AND r.role = 'reviewer' AND target.status = 'acceptance' ${targetId == null ? "" : "AND target.id = ?"}
    ORDER BY r.id`).all(...(targetId == null ? [] : [targetId])) as unknown as Candidate[];
  const config = rows.length ? loadConfig() : undefined;
  const loginBlipRetryMs = config?.loginBlipRetryMs ?? DEFAULT_LOGIN_BLIP_RETRY_MS;
  const waits = new Map<number, AcceptanceReviewWait>();
  const problems = new Set<number>();
  const uncertainDependencies = new Set<number>();
  if (rows.some(row => row.status === 'waiting' && row.dependency_wait)) {
    const ancestors = getDb().prepare(`WITH RECURSIVE ancestors(review_id, id) AS (
      SELECT review.id, l.parent_id FROM tasks review JOIN links l ON l.task_id = review.id
        JOIN tasks target ON target.id = review.review_of AND target.project = review.project
        WHERE review.role = 'reviewer' AND review.status = 'waiting' AND target.status = 'acceptance'
          ${targetId == null ? '' : 'AND target.id = ?'}
      UNION SELECT a.review_id, l.parent_id FROM ancestors a JOIN links l ON l.task_id = a.id
    ) SELECT a.review_id, r.*, ${factColumns} FROM ancestors a LEFT JOIN tasks r ON r.id = a.id ${factJoins}`)
      .all(...(targetId == null ? [] : [targetId])) as unknown as Array<Facts & { review_id: number }>;
    for (const parent of ancestors) {
      if (parent.id == null) { uncertainDependencies.add(parent.review_id); continue; }
      const role = parent.status === 'reviewing' || parent.status === 'in_review' ? 'reviewer' : parent.role;
      const active = ['running', 'reviewing'].includes(parent.status) && liveRun(parent, role);
      const queue = retryReason(parent, role, loginBlipRetryMs);
      const held = !parent.blocked_kind && !parent.cooldown_until && heldReason(parent);
      const started = data(parent.started_json);
      const success = ['complete', 'approve'].includes(parent.run_end_kind ?? '') && parent.run_ended != null &&
        started?.agentId === parent.run_agent && started?.role === parent.run_role;
      const delivered = success && ((parent.status === 'acceptance' && parent.state_kind === parent.run_end_kind) ||
        (parent.status === 'done' && parent.state_kind === 'accept'));
      // Historical counters need current healthy facts; unknown dependency failures remain conservative.
      if (currentProblem(parent) || ((parent.fail_count > 0 || parent.blocked_kind || parent.cooldown_until) && !active && !queue && !held && !delivered))
        uncertainDependencies.add(parent.review_id);
    }
  }
  for (const row of rows) {
    if (row.created_event_id == null || row.created_event_id <= row.acceptance_id ||
        (row.acceptance_id === 0 && Date.parse(row.created_at) < Date.parse(row.acceptance_at))) continue;
    // A real review block/failure needs an answer even when another review is still active.
    if (currentProblem(row)) {
      problems.add(row.target_id);
      continue;
    }
    let reason: WaitReason | null = null;
    if (['running', 'reviewing'].includes(row.status) && liveRun(row, 'reviewer')) reason = 'running';
    else if (row.status === 'waiting' && row.dependency_wait && !uncertainDependencies.has(row.id)) reason = 'dependency';
    else {
      const retry = retryReason(row, 'reviewer', loginBlipRetryMs);
      if (retry) reason = heldReason(row) ?? retry;
      else if (!row.blocked_kind && !row.cooldown_until) reason = heldReason(row);
    }
    if (!reason) continue;
    const wait = waits.get(row.target_id) ?? { acceptanceEventId: row.acceptance_id, reviews: [] };
    wait.reviews.push({ id: row.id, code: cardMarkOf(row, config), reason });
    waits.set(row.target_id, wait);
  }
  for (const id of problems) waits.delete(id);
  return waits;
}

export function acceptanceReviewWaitText(wait: AcceptanceReviewWait): string {
  return t('acceptanceReviewWait.detail', { reviews: wait.reviews.map(review =>
    `${review.code} (${t(`acceptanceReviewWait.reason.${review.reason}`)})`).join(t('common.listSep')) });
}

/** Persist only wait edges, once per round/episode. Reads (including the board) never mutate. */
export function syncAcceptanceReviewWait(task: TaskRow, wait: AcceptanceReviewWait | undefined, entry: AcceptanceEntry, at: string): AcceptanceEntry {
  const db = getDb();
  const prior = db.prepare(`SELECT id, at, kind, data_json FROM events WHERE task_id = ?
    AND kind IN ('acceptance_review_wait_started','acceptance_review_wait_ended') ORDER BY id DESC LIMIT 1`)
    .get(task.id) as { id: number; at: string; kind: string; data_json: string } | undefined;
  let sameRound = false;
  try { sameRound = prior != null && JSON.parse(prior.data_json).acceptanceEventId === entry.id; } catch { /* no evidence */ }
  // Compare the newest durable edge in the INSERT itself. Two connections
  // observing the same edge cannot both append it. Async callers recheck review facts.
  const edge = (kind: string, data: Record<string, unknown>): AcceptanceEntry => {
    const result = db.prepare(`INSERT INTO events(task_id, at, kind, actor, data_json)
      SELECT ?, ?, ?, 'scheduler', ? WHERE COALESCE((SELECT id FROM events WHERE task_id = ?
        AND kind IN ('acceptance_review_wait_started','acceptance_review_wait_ended') ORDER BY id DESC LIMIT 1), 0) = ?`)
      .run(task.id, at, kind, JSON.stringify({ acceptanceEventId: entry.id, ...data }), task.id, prior?.id ?? 0);
    if (result.changes === 1) return { id: Number(result.lastInsertRowid), at };
    return entry; // The next scan reconciles the winning edge; never grant an old cap exemption.
  };
  if (wait) {
    if (!sameRound || prior?.kind !== 'acceptance_review_wait_started') {
      edge('acceptance_review_wait_started', { reviewIds: wait.reviews.map(review => review.id) });
    }
    clearLeaderUnresponsive(task.project, 'independent_review_wait', at, { acceptanceEventId: entry.id }, task.id);
    return entry;
  }
  if (sameRound && prior?.kind === 'acceptance_review_wait_started') {
    return edge('acceptance_review_wait_ended', {});
  }
  // A completed/invalidated review starts a fresh reminder episode, even if old false
  // wakes exhausted the two-delivery cap. Durable across restart, scoped to this round.
  return sameRound && prior?.kind === 'acceptance_review_wait_ended' ? { id: prior.id, at: prior.at } : entry;
}
