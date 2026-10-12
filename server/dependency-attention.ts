/// <reference types="node" />
import { wakeSummary } from "./wake-summary";
import { acceptanceEntry, loadAcceptanceReviewWaits, syncAcceptanceReviewWait } from "./acceptance-review-wait";
import { leaderActionNote } from "./protocol";
import { inspectAgentState, type AgentInspector } from "./agent-check";
import { deliverWake, hasWakeSender } from "./bus";
import { cardMark } from "./card-ref";
import { projectSupervisor, type KanbanConfig } from "./config";
import { getDb } from "./db";
import { agentCwdMissing, noteWakeSkipped } from "./missing-cwd";
import { agentLiveness, readAgentRecord, type AgentLiveness } from "./open";
import { appendEvent, getTask } from "./store";
import { triageRecipient } from "./wake";
import { statusLabel } from "../shared/labels";
import { guardCard, safeParse, withTimeout } from "./guard";
import { isProjectPaused } from "./paused";
import { t } from "../shared/i18n";

export const PREREQUISITE_IDLE_MS = 30 * 60_000;

type IdleEvent = { kind: string; data_json: string };

/** Follow the whole dependency chain; UNION also guards cycles and shared descendants. */
export function waitingSuccessors(taskId: number): number[] {
  const rows = getDb().prepare(`
    WITH RECURSIVE successors(id) AS (
      SELECT task_id FROM links WHERE parent_id = ?
      UNION SELECT l.task_id FROM links l JOIN successors s ON l.parent_id = s.id
    )
    SELECT t.id FROM successors s JOIN tasks t ON t.id = s.id
    WHERE t.status = 'waiting' AND t.id != ? ORDER BY t.id
  `).all(taskId, taskId) as Array<{ id: number }>;
  return rows.map(row => row.id);
}

/** Durable state-entry and absence clocks survive ticks, comments, and scheduler restarts. */
async function scanPrerequisiteAttentionOnce(options: {
  now: Date;
  config: KanbanConfig;
  agentState?: (id: string | null) => AgentLiveness;
  inspectAgent?: AgentInspector;
  send?: (id: string, text: string) => Promise<void>;
}): Promise<number[]> {
  const now = options.now.getTime();
  const at = options.now.toISOString();
  const rows = getDb().prepare("SELECT id FROM tasks WHERE status IN ('acceptance', 'rework') ORDER BY id")
    .all() as Array<{ id: number }>;
  const woken: number[] = [];
  let waits = loadAcceptanceReviewWaits();
  const scanOne = async (rowId: number): Promise<void> => {
    const task = getTask(rowId);
    const acceptanceRound = task.status === 'acceptance' ? acceptanceEntry(task).id : null;
    if (task.status !== 'acceptance' && task.status !== 'rework') return;
    if (isProjectPaused(task.project)) return;
    const children = waitingSuccessors(task.id);
    if (!children.length) return;
    const entry = getDb().prepare(
      "SELECT id, at FROM events WHERE task_id = ? AND to_status = ? AND ((from_status IS NOT NULL AND from_status != to_status) OR kind = 'created') ORDER BY id DESC LIMIT 1",
    ).get(task.id, task.status) as { id: number; at: string } | undefined;
    const wait = task.status === 'acceptance' ? waits.get(task.id) : undefined;
    const episode = task.status === 'acceptance'
      ? syncAcceptanceReviewWait(task, wait, acceptanceEntry(task), at) : { id: entry?.id ?? 0, at: entry?.at ?? task.created_at };
    if (wait) return;
    const stateEntryId = Math.max(entry?.id ?? 0, episode.id);
    const key = { status: task.status, stateEntryId };
    const already = getDb().prepare(
      "SELECT id FROM events WHERE task_id = ? AND kind = 'wake_prerequisite' AND json_extract(data_json, '$.status') = ? AND json_extract(data_json, '$.stateEntryId') = ? LIMIT 1",
    ).get(task.id, task.status, stateEntryId);
    if (already) return;
    const prior = getDb().prepare(
      "SELECT kind, data_json FROM events WHERE task_id = ? AND kind IN ('prerequisite_idle_started', 'prerequisite_idle_cleared') ORDER BY id DESC LIMIT 1",
    ).get(task.id) as IdleEvent | undefined;
    const saved = prior ? safeParse<{ status: string; stateEntryId: number; idleSince?: string }>(prior.data_json) : null;
    const sameEntry = saved?.status === task.status && saved.stateEntryId === stateEntryId;
    const ids = [...new Set([task.agent_id, task.executor_agent_id].filter((id): id is string => Boolean(id)))];
    let alive = false;
    let inspected = false;
    let departure = Date.parse(episode.at);
    for (const id of ids) {
      const state = (options.agentState ?? agentLiveness)(id);
      const confirmed = (state === 'missing' || state === 'archived') && options.inspectAgent
        ? (inspected = true, await inspectAgentState(id, options.inspectAgent))
        : state === 'missing' && !options.agentState ? 'unknown' : state;
      // Unknown is not evidence of absence. An API miss during reload must not wake or restart work.
      if (confirmed === 'alive' || confirmed === 'unknown') { alive = true; break; }
      const read = readAgentRecord(id);
      const ended = read.state === 'ok' ? read.file.archivedAt ?? read.file.updatedAt : null;
      departure = Math.max(departure, ended && Number.isFinite(Date.parse(ended)) ? Date.parse(ended) : now);
    }
    if (inspected) {
      waits = loadAcceptanceReviewWaits();
      const current = getTask(task.id);
      if (current.status !== task.status || (acceptanceRound != null && acceptanceEntry(current).id !== acceptanceRound)) return;
      const wait = waits.get(task.id);
      if (wait) { syncAcceptanceReviewWait(current, wait, acceptanceEntry(current), at); return; }
    }
    if (alive) {
      if (!sameEntry || prior?.kind !== 'prerequisite_idle_cleared') {
        appendEvent(task.id, 'prerequisite_idle_cleared', null, null, 'scheduler', key, at);
      }
      return;
    }
    const idleSince = sameEntry && prior?.kind === 'prerequisite_idle_started' && saved?.idleSince
      ? saved.idleSince : new Date(sameEntry ? now : Number.isFinite(departure) ? departure : now).toISOString();
    if (!sameEntry || prior?.kind !== 'prerequisite_idle_started') {
      appendEvent(task.id, 'prerequisite_idle_started', null, null, 'scheduler', { ...key, idleSince }, at);
    }
    if (now - Date.parse(idleSince) <= PREREQUISITE_IDLE_MS) return;
    const who = triageRecipient(task.project, options.config);
    if (!who || (!options.send && !hasWakeSender())) return;
    const cwd = agentCwdMissing(who);
    if (cwd) { noteWakeSkipped(task.id, who, cwd, 'prerequisite'); return; }
    const cards = children.map(id => cardMark(id));
    const text = [
      `${cardMark(task.id)} ${task.title}`,
      t("dependencyAttention.wake.status", { project: task.project, status: statusLabel(task.status) }),
      t("dependencyAttention.wake.idle", { count: cards.length, cards: cards.join(t("common.listSep")) }),
      ...(who !== projectSupervisor(task.project, options.config) ? [t("dependencyAttention.wake.noLeader")] : []),
      t("dependencyAttention.wake.ask"),
      leaderActionNote(),
    ].join('\n');
    const current = getTask(task.id);
    if (current.status !== task.status || current.updated_at !== task.updated_at) return;
    // Agent inspection above is asynchronous. A newly linked review is evidence
    // of handling even when linking it did not update the target row.
    if (current.status === 'acceptance') {
      const wait = waits.get(current.id);
      if (wait) { syncAcceptanceReviewWait(current, wait, acceptanceEntry(current), at); return; }
    }
    try {
      if (options.send) await withTimeout(() => options.send!(who, text), t("dependencyAttention.call.send"));
      else if (!await withTimeout(() => deliverWake(who, text), t("dependencyAttention.call.send"))) return;
    } catch { return; }
    finally { waits = loadAcceptanceReviewWaits(); }
    if (getTask(task.id).status !== task.status || (task.status === 'acceptance' && acceptanceEntry(getTask(task.id)).id !== acceptanceRound)) return;
    const settledWait = waits.get(task.id);
    if (settledWait) { syncAcceptanceReviewWait(getTask(task.id), settledWait, acceptanceEntry(getTask(task.id)), at); return; }
    appendEvent(task.id, 'wake_prerequisite', null, null, 'scheduler', {
      ...key, agentId: who, fallback: who !== projectSupervisor(task.project, options.config),
      idleSince, waitingCount: cards.length, waitingTaskIds: children, waitingCards: cards, taskId: task.id, text: wakeSummary(text),
    }, at);
    woken.push(task.id);
  };
  for (const row of rows) {
    await guardCard(row.id, "tick.prerequisiteWake", () => scanOne(row.id), options.now);
  }
  return woken;
}

let scanning = false;
export async function scanPrerequisiteAttention(options: Parameters<typeof scanPrerequisiteAttentionOnce>[0]): Promise<number[]> {
  if (scanning) return [];
  scanning = true;
  try { return await scanPrerequisiteAttentionOnce(options); } finally { scanning = false; }
}
