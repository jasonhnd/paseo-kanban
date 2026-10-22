/// <reference types="node" />
import { wakeSummary } from "./wake-summary";
import { leaderActionNote } from "./protocol";
import { decisionBlock, readOpenDecisions, waitingOnDecision, type DecisionBlock } from "./decisions";
import { isAgentAlive, resetAgentAliveCheck, setAgentAliveCheck } from "./alive";
import { agentCwdMissing, noteWakeSkipped } from "./missing-cwd";
import { addBoardWakeMark, clearBoardWakeMarks, forgetBoardWakeMarkCache, hasBoardWakeMark, removeBoardWakeMark } from "./board-wake-marks";
import { deliverWake, hasWakeSender, sendWake } from "./bus";
import { kanbanLeaderForAlarm, loadConfig, projectSupervisor, type KanbanConfig } from "./config";
import { getDb } from "./db";
import { cachedMergeState, contractPullRequest, readContract } from "./pr";
import { parentMergeProblem } from "./parents";
import { childFinished } from "./deps";
import { cardMark } from "./card-ref";
import { appendEvent, getTask, setBlockedListener, type TaskRow } from "./store";
import { holdPayload, awaitingLeaderHold } from "./review-hold";
import { isProjectDormant } from "./paused";
import { reasonSummary, statusLabel } from "../shared/labels";
import { t, type MessageKey } from "../shared/i18n";

export { resetAgentAliveCheck, setAgentAliveCheck };

export type WakeKind = "run_budget_warning" | "acceptance" | "blocked" | "children" | "land" | "land_missing" | "review_hold";

interface WakeTarget {
  agentId: string;
  /** Kanban supervisor. Waking them does not count as someone taking the card. */
  fallback: boolean;
  gap: string | null;
  /** Stale creator (old leader session) that was skipped in favour of the registered leader. */
  fallbackFrom?: string;
}

/** Only the registered project leader can take the card; the Kanban leader is fallback only. */
export function resolveRecipient(createdByAgent: string | null, projectSupervisorId: string | null, kanbanSupervisorId: string | null): string | null {
  if (createdByAgent && createdByAgent === projectSupervisorId && isAgentAlive(createdByAgent)) return createdByAgent;
  if (projectSupervisorId && isAgentAlive(projectSupervisorId)) return projectSupervisorId;
  if (kanbanSupervisorId && isAgentAlive(kanbanSupervisorId)) return kanbanSupervisorId;
  return null;
}

export function triageRecipient(project: string, config: KanbanConfig): string | null {
  return resolveRecipient(null, projectSupervisor(project, config), config.supervisorAgentId);
}

export function wakeText(input: { id: number; title: string; status: string; handoff: string | null; next: string; lead?: string }): string {
  const handoff = input.handoff?.trim() ? input.handoff.trim() : t("wake.handoff.none");
  const lines = [
    `${cardMark(input.id)} ${input.title}`,
    t("wake.line.status", { status: statusLabel(input.status) }),
    t("wake.line.handoff", { handoff }),
    t("wake.line.next", { next: input.next }),
    leaderActionNote(),
  ];
  if (input.lead) lines.unshift(input.lead);
  return lines.join("\n");
}

function handoffOf(task: TaskRow): string | null {
  if (!task.handoff_json) return null;
  try {
    const parsed = JSON.parse(task.handoff_json) as { summary?: string; handoff?: unknown };
    const summary = typeof parsed.summary === "string" ? parsed.summary : "";
    const body = parsed.handoff == null ? "" : typeof parsed.handoff === "string" ? parsed.handoff : JSON.stringify(parsed.handoff);
    return [summary, body].filter(Boolean).join("\n");
  } catch {
    return task.handoff_json;
  }
}

function supervisorGap(project: string, config: KanbanConfig): string {
  const id = projectSupervisor(project, config);
  if (!id) return t("wake.gap.unregistered");
  if (!isAgentAlive(id)) return t("wake.gap.closed", { id });
  return t("wake.gap.notFound");
}

function classify(task: TaskRow, who: string | null): WakeTarget | null {
  if (!who) return null;
  const config = loadConfig();
  const projectId = projectSupervisor(task.project, config);
  const kanbanId = config.supervisorAgentId;
  const primary = projectId != null && who === projectId;
  if (kanbanId && who === kanbanId && !primary) {
    return { agentId: who, fallback: true, gap: supervisorGap(task.project, config) };
  }
  return { agentId: who, fallback: false, gap: null };
}

function canReceive(agentId: string | null, taskId: number, kind: string): agentId is string {
  if (!agentId || !isAgentAlive(agentId)) return false;
  const missing = agentCwdMissing(agentId);
  if (!missing) return true;
  noteWakeSkipped(taskId, agentId, missing, kind);
  return false;
}

/**
 * Creation is not a grant of leader authority. Skip unregistered creators even when the
 * project leader is absent (including schedule/guest agents and old leader sessions).
 */
function staleCreator(task: TaskRow, config: KanbanConfig, agent: string | null = task.created_by_agent): string | null {
  const creator = agent;
  const projectId = projectSupervisor(task.project, config);
  if (!creator || creator === projectId || creator === config.supervisorAgentId) return null;
  return creator;
}

function recipientFor(task: TaskRow): WakeTarget | null {
  const config = loadConfig();
  const fallbackFrom = staleCreator(task, config);
  const chain = [projectSupervisor(task.project, config), config.supervisorAgentId];
  for (const id of chain) {
    if (!canReceive(id, task.id, "wake")) continue;
    const target = classify(task, id);
    return target && fallbackFrom ? { ...target, fallbackFrom } : target;
  }
  return null;
}

function markUnattended(taskId: number, status: string): void {
  const ts = new Date().toISOString();
  const info = getDb().prepare(`UPDATE tasks SET unattended_at = ? WHERE id = ? AND unattended_at IS NULL`).run(ts, taskId);
  if (info.changes !== 1) return;
  appendEvent(taskId, "unattended", null, status, "scheduler", { reason: t("wake.unattended.reason") });
}

function clearUnattended(taskId: number): void {
  getDb().prepare(`UPDATE tasks SET unattended_at = NULL WHERE id = ? AND unattended_at IS NOT NULL`).run(taskId);
}

function fallbackText(task: TaskRow, next: string, gap: string, lead?: string): string {
  const handoff = handoffOf(task)?.trim() ? handoffOf(task)!.trim() : t("wake.handoff.none");
  const lines = [
    `${cardMark(task.id)} ${task.title}`,
    t("wake.line.project", { project: task.project }),
    t("wake.line.status", { status: statusLabel(task.status) }),
    t("wake.fallback.noLeader", { gap }),
    t("wake.fallback.note"),
    t("wake.line.handoff", { handoff }),
    t("wake.line.next", { next }),
    leaderActionNote(),
  ];
  if (lead) lines.unshift(lead);
  return lines.join("\n");
}

/** The event that moved the card into its current status. Wake events from an earlier round do not count for this one. */
export function roundStartId(task: TaskRow): number {
  const row = getDb()
    .prepare(
      `SELECT id FROM events WHERE task_id = ? AND to_status = ? AND from_status IS NOT NULL AND from_status != to_status ORDER BY id DESC LIMIT 1`,
    )
    .get(task.id, task.status) as { id: number } | undefined;
  return row?.id ?? 0;
}

interface NoticeData {
  agentId?: string | null;
  fallback?: boolean;
  delivered?: boolean;
  generation?: string;
}

/** Wake events of these kinds written since the card entered its current status. */
function roundNotices(task: TaskRow, kinds: readonly string[]): NoticeData[] {
  const marks = kinds.map(() => "?").join(", ");
  const rows = getDb()
    .prepare(`SELECT data_json FROM events WHERE task_id = ? AND id > ? AND kind IN (${marks})`)
    .all(task.id, roundStartId(task), ...kinds) as unknown as Array<{ data_json: string }>;
  const out: NoticeData[] = [];
  for (const row of rows) {
    try {
      out.push(JSON.parse(row.data_json) as NoticeData);
    } catch {
      continue;
    }
  }
  return out;
}

/** Events from before delivered was recorded carry no flag and count when they named a receiver. */
const wasDelivered = (data: NoticeData): boolean => Boolean(data.agentId) && data.delivered !== false;

function fallbackAlready(task: TaskRow, kind: WakeKind, generation?: string): boolean {
  return roundNotices(task, [`wake_${kind}`]).some((data) => data.fallback === true && wasDelivered(data) && (!generation || data.generation === generation));
}

export interface NoticeScope { key: string; current: () => boolean }

const noticeInflight = new Set<string>();

/**
 * Send a wake and record it only after the sender took it. No sender (the CLI runs in its own
 * process), a refused send, or an async send still in flight leave no "woken" record, so the card
 * stays unattended and the plugin's next retry sends it. A refused send is logged once per round.
 */
function sendNotice(task: TaskRow, kind: WakeKind, target: WakeTarget, text: string, onDelivered: () => void, scope?: NoticeScope): void {
  if (!hasWakeSender()) {
    markUnattended(task.id, task.status);
    return;
  }
  const round = roundStartId(task);
  const key = `${task.id}:${kind}:${round}:${scope?.key ?? ""}`;
  if (noticeInflight.has(key)) return;
  const record = (delivered: boolean): void => {
    appendEvent(task.id, `wake_${kind}`, null, task.status, "scheduler", {
      agentId: target.agentId,
      fallback: target.fallback,
      delivered,
      ...(target.gap ? { gap: target.gap } : {}),
      ...(target.fallbackFrom ? { fallbackFrom: target.fallbackFrom } : {}),
      taskId: task.id,
      ...(scope ? { generation: scope.key } : {}),
      text: wakeSummary(text),
    });
  };
  const settle = (ok: boolean): void => {
    noticeInflight.delete(key);
    // The card re-entered review (or left it) while this send was in flight: it says nothing about the new round.
    const current = getTask(task.id);
    if (current.status !== task.status || roundStartId(current) !== round || scope && !scope.current()) return;
    if (ok) record(true);
    else if (!roundNotices(task, [`wake_${kind}`]).some((data) => data.delivered === false && data.agentId === target.agentId)) record(false);
    if (ok) onDelivered();
    else markUnattended(task.id, task.status);
  };
  const result = sendWake(target.agentId, text);
  if (typeof result === "boolean") {
    settle(result);
    return;
  }
  noticeInflight.add(key);
  void result.then(settle);
}

function deliverNotice(task: TaskRow, kind: WakeKind, next: string, target: WakeTarget | null, retry: boolean, lead?: string, scope?: NoticeScope): void {
  if (target && !target.fallback) {
    const text = wakeText({ id: task.id, title: task.title, status: task.status, handoff: handoffOf(task), next, lead });
    sendNotice(task, kind, target, text, () => clearUnattended(task.id), scope);
    return;
  }
  if (target?.fallback) {
    if (!fallbackAlready(task, kind, scope?.key)) {
      sendNotice(task, kind, target, fallbackText(task, next, target.gap ?? t("wake.gap.notFound"), lead), () => {}, scope);
    }
    markUnattended(task.id, task.status);
    return;
  }
  if (retry || task.unattended_at) return;
  const text = wakeText({ id: task.id, title: task.title, status: task.status, handoff: handoffOf(task), next, lead });
  appendEvent(task.id, `wake_${kind}`, null, task.status, "scheduler", { agentId: null, taskId: task.id, text: wakeSummary(text) });
  markUnattended(task.id, task.status);
}

export function notifyTask(task: TaskRow, kind: WakeKind, next: string, retry = false, lead?: string, scope?: NoticeScope): void {
  if (isProjectDormant(task.project)) return;
  deliverNotice(task, kind, next, recipientFor(task), retry, lead, scope);
}

const reviewHoldInflight = new Set<number>();

/** A primary wake counts only after deliverWake accepts it. An attempt with delivered:false does not. */
function reviewHoldDelivered(taskId: number): boolean {
  const rows = getDb().prepare(`SELECT data_json FROM events WHERE task_id = ? AND kind = 'wake_review_hold'`).all(taskId) as Array<{
    data_json: string;
  }>;
  return rows.some((row) => {
    try {
      const data = JSON.parse(row.data_json) as { agentId?: string | null; fallback?: boolean; delivered?: boolean };
      return data.delivered === true && Boolean(data.agentId) && data.fallback !== true;
    } catch {
      return false;
    }
  });
}

/**
 * Wake the project leader once for a round-2 hold. Retries use the copy stored on review_leader_hold.
 * The success event is written only after deliverWake resolves true. A throw, a rejected promise,
 * or a missing sender leaves the card unattended so the next tick can try again.
 */
export function deliverStoredReviewHold(taskId: number): void {
  if (!awaitingLeaderHold(taskId) || reviewHoldDelivered(taskId) || reviewHoldInflight.has(taskId)) return;
  const copy = holdPayload(taskId);
  if (!copy) return;
  const task = getTask(taskId);
  if (task.status !== "rework" || isProjectDormant(task.project)) return;
  const target = recipientFor(task);
  if (!target || target.fallback) {
    notifyTask(task, "review_hold", copy.next, Boolean(task.unattended_at), copy.lead);
    return;
  }
  if (!hasWakeSender()) {
    markUnattended(task.id, task.status);
    return;
  }
  const text = wakeText({
    id: task.id,
    title: task.title,
    status: task.status,
    handoff: handoffOf(task),
    next: copy.next,
    lead: copy.lead,
  });
  reviewHoldInflight.add(task.id);
  void deliverWake(target.agentId, text).then((ok) => {
    reviewHoldInflight.delete(task.id);
    if (!awaitingLeaderHold(taskId)) return;
    const current = getTask(taskId);
    if (current.status !== "rework") return;
    if (!ok) {
      appendEvent(task.id, "wake_review_hold", null, current.status, "scheduler", {
        agentId: target.agentId,
        fallback: false,
        delivered: false,
        taskId: task.id,
        text: wakeSummary(text),
      });
      markUnattended(task.id, current.status);
      return;
    }
    if (reviewHoldDelivered(taskId)) return;
    appendEvent(task.id, "wake_review_hold", null, current.status, "scheduler", {
      agentId: target.agentId,
      fallback: false,
      delivered: true,
      taskId: task.id,
      text: wakeSummary(text),
    });
    clearUnattended(task.id);
  });
}

/** Cards still waiting on a round-2 ruling whose project leader was not reached. */
export function retryReviewHolds(): void {
  const rows = getDb()
    .prepare(
      `SELECT id FROM tasks WHERE status = 'rework' AND (
         SELECT kind FROM events WHERE task_id = tasks.id AND kind IN ('review_leader_hold', 'leader_rework', 'leader_pass') ORDER BY id DESC LIMIT 1
       ) = 'review_leader_hold'`,
    )
    .all() as Array<{ id: number }>;
  for (const row of rows) deliverStoredReviewHold(row.id);
}

const parentMergeNotices = new Set<string>();

interface MergeNoticeEvent {
  id: number;
  at: string;
  task_id: number;
  data_json: string;
  task_project?: string;
}

function noticeData(row: MergeNoticeEvent): Record<string, unknown> {
  try {
    const data = JSON.parse(row.data_json);
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch { return {}; }
}

/** Persist reason transitions, including a known OPEN state, so reopen/close starts a new episode. */
export async function notifyParentMergeProblem(parentId: number): Promise<void> {
  const parent = getTask(parentId);
  const pr = contractPullRequest(readContract(parent.contract_json));
  if (!pr) return;
  const db = getDb();
  const latest = db.prepare("SELECT id, at, task_id, data_json FROM events WHERE task_id = ? AND kind = 'parent_merge_reason' ORDER BY id DESC LIMIT 1").get(parentId) as MergeNoticeEvent | undefined;
  const previous = latest ? noticeData(latest) : null;
  // Cache absence after restart is not evidence that a closed PR reopened.
  if (!cachedMergeState(pr) && latest && previous?.pr === pr) return;
  const reason = parentMergeProblem(parent);
  if (!cachedMergeState(pr) && !reason) return;
  let episode = latest;
  if (!latest || previous?.reason !== reason || previous?.pr !== pr) {
    appendEvent(parentId, "parent_merge_reason", null, parent.status, "scheduler", { pr, reason, legacyEligible: !latest });
    episode = db.prepare("SELECT id, at, task_id, data_json FROM events WHERE task_id = ? AND kind = 'parent_merge_reason' ORDER BY id DESC LIMIT 1").get(parentId) as unknown as MergeNoticeEvent;
  }
  if (!reason || !episode || !hasWakeSender()) return;
  const children = db.prepare("SELECT t.* FROM links l JOIN tasks t ON t.id = l.task_id WHERE l.parent_id = ? AND t.status = 'waiting' ORDER BY t.id").all(parentId) as unknown as TaskRow[];
  const groups = new Map<string, TaskRow[]>();
  for (const child of children) {
    if (!parentMergeProblem(parent, child)) continue;
    groups.set(child.project, [...(groups.get(child.project) ?? []), child]);
  }
  const rows = db.prepare("SELECT e.id, e.at, e.task_id, e.data_json, t.project AS task_project FROM events e JOIN tasks t ON t.id = e.task_id WHERE e.kind = 'wake_parent_merge' AND (e.task_id = ? OR json_extract(e.data_json, '$.parentId') = ?) ORDER BY e.id").all(parentId, parentId) as unknown as MergeNoticeEvent[];
  for (const [project, tasks] of groups) {
    if (isProjectDormant(project)) continue;
    const ids = tasks.map(task => task.id);
    const wakes = rows.filter(row => {
      const data = noticeData(row);
      return data.parentId === parentId && data.reason === reason &&
        (data.project === project || (data.project == null && row.task_project === project)) &&
        (data.episode === episode.id || (data.episode == null && noticeData(episode).legacyEligible === true));
    });
    const first = wakes[0];
    const leader = projectSupervisor(project);
    const acknowledgedIds = [...new Set([parentId, ...ids, ...wakes.flatMap(row => {
      const list = noticeData(row).taskIds;
      return Array.isArray(list) ? list.filter((id): id is number => typeof id === "number") : [row.task_id];
    })])];
    const placeholders = acknowledgedIds.map(() => "?").join(",");
    // MCP records the actor's agentId in events; direct comments retain their author.
    const acknowledged = first && (
      db.prepare(`SELECT id FROM events WHERE kind = 'comment' AND id > ? AND task_id IN (${placeholders}) AND actor IN ('supervisor', ?) LIMIT 1`).get(first.id, ...acknowledgedIds, leader) ||
      (typeof noticeData(first).commentId === "number"
        ? db.prepare(`SELECT id FROM comments WHERE id > ? AND task_id IN (${placeholders}) AND author IN ('supervisor', ?) LIMIT 1`).get(noticeData(first).commentId as number, ...acknowledgedIds, leader)
        : db.prepare(`SELECT id FROM comments WHERE created_at > ? AND task_id IN (${placeholders}) AND author IN ('supervisor', ?) LIMIT 1`).get(first.at, ...acknowledgedIds, leader))
    );
    if (acknowledged) {
      for (const id of ids) clearUnattended(id);
      continue;
    }
    const task = tasks[0];
    const target = recipientFor(task);
    if (!target) {
      for (const id of ids) markUnattended(id, "waiting");
      continue;
    }
    const already = wakes.some(row => target.fallback || noticeData(row).fallback !== true);
    const key = `${parentId}:${episode.id}:${project}`;
    if (already || parentMergeNotices.has(key)) continue;
    const next = t("wake.parentMerge.next", { parent: cardMark(parentId), reason, children: ids.map(cardMark).join(t("common.listSep")) });
    const text = target.fallback
      ? fallbackText({ ...parent, project }, next, target.gap ?? t("wake.gap.notFound"))
      : wakeText({ id: parent.id, title: parent.title, status: parent.status, handoff: handoffOf(parent), next });
    const commentId = (db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM comments").get() as { id: number }).id;
    parentMergeNotices.add(key);
    try {
      if (await deliverWake(target.agentId, text)) {
        appendEvent(parentId, "wake_parent_merge", null, parent.status, "scheduler", { agentId: target.agentId, fallback: target.fallback, parentId, project, taskIds: ids, episode: episode.id, commentId, reason, text: wakeSummary(text) });
        for (const id of ids) {
          if (target.fallback) markUnattended(id, "waiting");
          else clearUnattended(id);
        }
      }
    } finally {
      parentMergeNotices.delete(key);
    }
  }
}

/** A standalone review card (role reviewer) tells its supervisor the verdict up front. */
function standaloneReviewNotice(task: TaskRow): { lead: string; next: string } | null {
  if (task.role !== "reviewer") return null;
  const row = getDb()
    .prepare(`SELECT kind, data_json FROM events WHERE task_id = ? AND kind IN ('approve', 'request_changes') ORDER BY id DESC LIMIT 1`)
    .get(task.id) as { kind: string; data_json: string } | undefined;
  if (!row) return null;
  let data: { summary?: unknown; reason?: unknown } = {};
  try {
    data = JSON.parse(row.data_json) as { summary?: unknown; reason?: unknown };
  } catch {
    data = {};
  }
  if (row.kind === "approve") {
    const summary = typeof data.summary === "string" ? data.summary.trim() : "";
    const lead = t("wake.review.approved");
    return { lead: summary ? `${lead}\n${summary}` : lead, next: t("wake.acceptance.next") };
  }
  const reason = typeof data.reason === "string" ? data.reason : "";
  const summary = reasonSummary(reason);
  const lead = t("wake.review.changes");
  return { lead: summary ? `${lead}\n${summary}` : lead, next: t("wake.review.fixNext") };
}

function landWoken(taskId: number, kind = "land", after = 0): boolean {
  const rows = getDb().prepare(`SELECT data_json FROM events WHERE task_id = ? AND kind = ? AND id > ?`).all(taskId, `wake_${kind}`, after) as Array<{
    data_json: string;
  }>;
  return rows.some((row) => {
    try {
      const data = JSON.parse(row.data_json) as NoticeData;
      return wasDelivered(data) && data.fallback !== true;
    } catch {
      return false;
    }
  });
}

/** Tell the project leader once that a queued land hit a conflict. The card stays done. */
export function notifyLandConflict(taskId: number, detail: string): void {
  if (landWoken(taskId)) return;
  notifyTask(getTask(taskId), "land", detail);
}

/** Missing-branch intervention is separate from an earlier conflict notice. */
export function notifyMissingLand(taskId: number, detail: string): void {
  const lastPresent = getDb().prepare(`SELECT id FROM events WHERE task_id = ? AND kind = 'land_pending'
    AND COALESCE(json_extract(data_json, '$.missingBranch'), 0) != 1 ORDER BY id DESC LIMIT 1`).get(taskId) as { id: number } | undefined;
  if (!landWoken(taskId, "land_missing", lastPresent?.id ?? 0)) notifyTask(getTask(taskId), "land_missing", detail);
}

/** True once a live receiver took the no-PR wake. Events from before delivered was recorded count when they named a receiver. */
export function missingPrWakeDelivered(taskId: number): boolean {
  const rows = getDb().prepare(`SELECT data_json FROM events WHERE task_id = ? AND kind = 'wake_missing_pr'`).all(taskId) as Array<{ data_json: string }>;
  return rows.some((row) => {
    try {
      const data = JSON.parse(row.data_json) as { agentId?: string | null; delivered?: boolean };
      return data.delivered ?? Boolean(data.agentId);
    } catch {
      return false;
    }
  });
}

const missingPrInFlight = new Set<number>();

/**
 * A finished GitHub card has no pull request, and cleanup has used up its backoff.
 * Wake the project leader. This is not an archive-stuck board problem.
 * The cleanup event is recorded once by the caller; this wake counts as sent only when a live
 * receiver accepted it (delivered), so later cleanup rounds call it again until someone has it.
 * An undelivered attempt is written to the event log only the first time.
 */
export async function notifyMissingPullRequest(taskId: number, branch: string, dirty = false): Promise<void> {
  if (missingPrInFlight.has(taskId) || missingPrWakeDelivered(taskId)) return;
  missingPrInFlight.add(taskId);
  try {
    const task = getTask(taskId);
    const next = t("wake.missingPr.next", { branch, dirty: dirty ? t("wake.missingPr.dirty") : "" });
    const config = loadConfig();
    const projectId = projectSupervisor(task.project, config);
    const kanbanId = config.supervisorAgentId;
    const reachable = (agentId: string | null): agentId is string => {
      if (!agentId || !isAgentAlive(agentId)) return false;
      return !agentCwdMissing(agentId);
    };
    const who = reachable(projectId) ? projectId : reachable(kanbanId) ? kanbanId : null;
    const text = wakeText({ id: task.id, title: task.title, status: task.status, handoff: handoffOf(task), next });
    const delivered = who != null && hasWakeSender() ? await deliverWake(who, text) : false;
    const tried = (getDb().prepare(`SELECT 1 AS n FROM events WHERE task_id = ? AND kind = 'wake_missing_pr' LIMIT 1`).get(taskId) as { n: number } | undefined) != null;
    if (!delivered && tried) return;
    appendEvent(task.id, "wake_missing_pr", null, task.status, "scheduler", {
      agentId: who,
      fallback: who != null && who === kanbanId && who !== projectId,
      delivered,
      taskId: task.id,
      text: wakeSummary(text),
    });
  } finally {
    missingPrInFlight.delete(taskId);
  }
}

/** Send one wake per kind for a card; the event row is the "already sent" mark. */
function wakeOnce(taskId: number, kind: string, sentence: string): void {
  if (getDb().prepare("SELECT id FROM events WHERE task_id = ? AND kind = ? LIMIT 1").get(taskId, kind)) return;
  const task = getTask(taskId);
  const config = loadConfig();
  const projectId = projectSupervisor(task.project, config);
  const kanbanId = config.supervisorAgentId;
  const reachable = (agentId: string | null): agentId is string => {
    if (!agentId || !isAgentAlive(agentId)) return false;
    return !agentCwdMissing(agentId);
  };
  const who = reachable(projectId) ? projectId : reachable(kanbanId) ? kanbanId : null;
  const text = wakeText({ id: task.id, title: task.title, status: task.status, handoff: handoffOf(task), next: sentence });
  appendEvent(task.id, kind, null, task.status, "kanban", {
    agentId: who,
    fallback: who != null && who === kanbanId && who !== projectId,
    text,
  });
  if (who && hasWakeSender()) deliverWake(who, text);
}

/** One wake after a read-only copy's local edits were saved. The caller comments on the card. */
export function notifyReadOnlyLeftovers(taskId: number, sentence: string): void {
  wakeOnce(taskId, "wake_readonly_leftovers", sentence);
}

/** One wake when branch deletion kept failing and cleanup gave up, keeping the branch. */
export function notifyBranchKept(taskId: number, sentence: string): void {
  wakeOnce(taskId, "wake_branch_kept", sentence);
}

/** An open decision that names the card holds the wake for this long; then the leader is told anyway. */
export const DECISION_WAKE_HOLD_MS = 30 * 60_000;
/** An unreadable decisions file is only trusted for this long. */
export const DECISION_UNCERTAIN_HOLD_MS = 5 * 60_000;

/** When this round first held the acceptance wake back for a decision, as epoch ms. */
function suppressedSince(task: TaskRow): number | null {
  const row = getDb()
    .prepare(`SELECT at FROM events WHERE task_id = ? AND id > ? AND kind = 'wake_suppressed_decision' ORDER BY id LIMIT 1`)
    .get(task.id, roundStartId(task)) as { at: string } | undefined;
  const ms = row ? Date.parse(row.at) : Number.NaN;
  return Number.isNaN(ms) ? null : ms;
}

/**
 * The wake is held back, never lost: the first hold of a round is written to the card, and once the
 * hold is old enough the wake goes out with a note naming the decision. Returns the note when the
 * hold is over, or null while it still holds.
 */
function holdForDecision(task: TaskRow, block: DecisionBlock, nowMs: number): string | null {
  const since = suppressedSince(task);
  if (since == null) {
    appendEvent(task.id, "wake_suppressed_decision", null, task.status, "scheduler", {
      decisionIds: block.decisionIds,
      uncertain: block.uncertain,
      taskId: task.id,
    });
    return null;
  }
  const limit = block.uncertain ? DECISION_UNCERTAIN_HOLD_MS : DECISION_WAKE_HOLD_MS;
  if (nowMs - since < limit) return null;
  return block.uncertain
    ? t("wake.decision.uncertain")
    : t("wake.decision.held", { ids: block.decisionIds.join(t("common.listSep")), minutes: Math.round(limit / 60_000) });
}

export function notifyAcceptance(taskId: number, retry = false, decisionsPath?: string, nowMs = Date.now()): void {
  const task = getTask(taskId);
  if (task.status !== "acceptance" || isProjectDormant(task.project)) return;
  const block = decisionBlock(task, readOpenDecisions(decisionsPath));
  const held = block ? holdForDecision(task, block, nowMs) : undefined;
  if (held === null) return;
  const verdict = standaloneReviewNotice(task);
  if (verdict) {
    notifyTask(task, "acceptance", verdict.next, retry, held ? [held, verdict.lead].filter(Boolean).join("\n") : verdict.lead);
    return;
  }
  notifyTask(task, "acceptance", t("wake.acceptance.next"), retry, held);
}

function latestChildCreator(parentId: number): string | null {
  const row = getDb()
    .prepare(
      `SELECT t.created_by_agent AS agent FROM links l JOIN tasks t ON t.id = l.task_id
       WHERE l.parent_id = ? AND t.created_by_agent IS NOT NULL ORDER BY t.id DESC LIMIT 1`,
    )
    .get(parentId) as { agent: string } | undefined;
  return row?.agent ?? null;
}

/**
 * links.task_id is the successor (child). links.parent_id is the prerequisite (parent).
 * A parent is notified only after every child has finished its own work.
 */
export function childrenAllFinished(parentId: number): boolean {
  const rows = getDb()
    .prepare(`SELECT t.status AS status FROM links l JOIN tasks t ON t.id = l.task_id WHERE l.parent_id = ?`)
    .all(parentId) as unknown as Array<{ status: string }>;
  if (rows.length === 0) return false;
  return rows.every((row) => childFinished(row.status));
}

/** Child creation does not grant authority either; use the same project/fallback chain. */
export function childWakeRecipient(
  builder: string | null,
  parentCreator: string | null,
  projectSupervisorId: string | null,
  kanbanSupervisorId: string | null,
): string | null {
  if (builder && builder === projectSupervisorId && isAgentAlive(builder)) return builder;
  return resolveRecipient(parentCreator, projectSupervisorId, kanbanSupervisorId);
}

export function notifyChildren(taskId: number, retry = false): void {
  if (!childrenAllFinished(taskId)) return;
  const task = getTask(taskId);
  if (isProjectDormant(task.project)) return;
  const config = loadConfig();
  const builder = latestChildCreator(taskId);
  const staleBuilder = staleCreator(task, config, builder);
  const staleParent = staleCreator(task, config);
  const fallbackFrom = staleBuilder ?? staleParent;
  const chain = [projectSupervisor(task.project, config), config.supervisorAgentId];
  let who: string | null = null;
  for (const id of chain) {
    if (!canReceive(id, task.id, "children")) continue;
    who = id;
    break;
  }
  const target = classify(task, who);
  deliverNotice(task, "children", t("wake.children.next"), target && fallbackFrom ? { ...target, fallbackFrom } : target, retry);
}

function blockedNext(task: TaskRow): string {
  const next = task.blocked_kind === "capability" ? t("wake.blocked.capability") : t("wake.blocked.needsHuman");
  return `${next}${task.blocked_reason ? t("wake.blocked.reason", { reason: task.blocked_reason }) : ""}`;
}

function onBlocked(task: TaskRow, actor: string): void {
  if (task.blocked_kind !== "needs_human" && task.blocked_kind !== "capability") return;
  if ((actor === "scheduler" || actor === "kanban") && task.blocked_kind === "needs_human") {
    wakeKanbanSupervisor({
      taskId: task.id,
      kind: actor === "kanban" ? "nudge_stuck" : "fused",
      detail: task.blocked_reason ?? t("wake.blocked.boardNeedsHuman"),
    });
    return;
  }
  notifyTask(task, "blocked", blockedNext(task));
}

function boardBlockKind(task: TaskRow): BoardProblemKind | null {
  if (task.status !== "blocked" || task.blocked_kind !== "needs_human") return null;
  const row = getDb()
    .prepare(`SELECT actor FROM events WHERE task_id = ? AND kind = 'blocked' ORDER BY id DESC LIMIT 1`)
    .get(task.id) as { actor: string | null } | undefined;
  if (row?.actor === "kanban") return "nudge_stuck";
  if (row?.actor === "scheduler") return "fused";
  return null;
}

/** A live receiver took a wake in the current round. A refused or never-sent attempt does not count. */
function wokePrimary(task: TaskRow): boolean {
  const target = recipientFor(task);
  if (!target || target.fallback) return false;
  // Old versions could record a delivered schedule/guest wake as primary. That does not
  // stop recovery, nor does delivery to a leader who has since closed or been replaced.
  return roundNotices(task, ["wake_acceptance", "wake_blocked", "wake_children"]).some(
    (data) => data.agentId === target.agentId && data.fallback !== true && wasDelivered(data),
  );
}

/** Try again on the next tick when the first wake found nobody, including cards already sitting there. */
export function retryUnattended(decisionsPath?: string): void {
  const decisions = readOpenDecisions(decisionsPath);
  const rows = getDb()
    .prepare(
      `SELECT id FROM tasks WHERE status = 'acceptance' OR (status = 'blocked' AND blocked_kind IN ('needs_human', 'capability')) ORDER BY id ASC`,
    )
    .all() as unknown as Array<{ id: number }>;
  for (const row of rows) {
    const task = getTask(row.id);
    if (isProjectDormant(task.project)) continue;
    if (wokePrimary(task)) {
      clearUnattended(row.id);
      continue;
    }
    const retry = Boolean(task.unattended_at);
    if (task.status === "acceptance") {
      if (waitingOnDecision(task, decisions)) {
        // notifyAcceptance records the hold and sends the wake once the hold is old enough.
        notifyAcceptance(task.id, retry, decisionsPath);
        continue;
      }
      if (childrenAllFinished(task.id)) notifyChildren(task.id, retry);
      notifyAcceptance(task.id, retry, decisionsPath);
      continue;
    }
    const boardKind = boardBlockKind(task);
    if (boardKind) {
      wakeKanbanSupervisor({ taskId: task.id, kind: boardKind, detail: task.blocked_reason ?? t("wake.blocked.boardStopped") });
      continue;
    }
    notifyTask(task, "blocked", blockedNext(task), retry);
  }
}

setBlockedListener(onBlocked);

export type BoardProblemKind =
  | "start_failed"
  | "effort_unsupported"
  | "fused"
  | "tick_error"
  | "nudge_stuck"
  | "archive_stuck"
  | "stalled"
  | "review_ruling"
  | "pool_stale"
  | "matrix_invalid"
  | "scheduler_idle"
  | "config_missing"
  | "config_broken";

/** Message keys of the board problem labels; looked up when a wake is built, never at import. */
const BOARD_LABEL_KEYS = {
  start_failed: "wake.board.startFailed",
  effort_unsupported: "wake.board.effortUnsupported",
  fused: "wake.board.fused",
  tick_error: "wake.board.tickError",
  nudge_stuck: "wake.board.nudgeStuck",
  archive_stuck: "wake.board.archiveStuck",
  stalled: "wake.board.stalled",
  review_ruling: "wake.board.reviewRuling",
  pool_stale: "wake.board.poolStale",
  matrix_invalid: "wake.board.matrixInvalid",
  scheduler_idle: "wake.board.schedulerIdle",
  config_missing: "wake.board.configMissing",
  config_broken: "wake.board.configBroken",
} as const satisfies Record<BoardProblemKind, MessageKey>;

function boardLabel(kind: BoardProblemKind): string {
  return t(BOARD_LABEL_KEYS[kind]);
}

/** Allow the same board-level wake again after the condition clears. */
export function releaseBoardWake(kind: BoardProblemKind): void {
  memoryWake.delete(kind);
  removeBoardWakeMark(kind);
}

const memoryWake = new Set<string>();
/** A board wake whose send has not answered yet, and when a refused one may be tried again. */
const boardWakeInflight = new Set<string>();
const boardWakeRetryAfter = new Map<string, number>();
const BOARD_WAKE_RETRY_MS = 5 * 60_000;
let tickStreak = 0;

export function resetBoardWakeForTests(): void {
  memoryWake.clear();
  boardWakeInflight.clear();
  boardWakeRetryAfter.clear();
  clearBoardWakeMarks();
  tickStreak = 0;
}

function boardAlready(taskId: number, kind: BoardProblemKind, subject?: string): boolean {
  const rows = getDb()
    .prepare(`SELECT data_json FROM events WHERE task_id = ? AND kind = 'board_wake'`)
    .all(taskId) as unknown as Array<{ data_json: string }>;
  return rows.some((row) => {
    try {
      const data = JSON.parse(row.data_json) as { kind?: string; agentId?: string | null; subject?: string };
      if (data.kind !== kind || !data.agentId) return false;
      if (subject) return data.subject === subject;
      return !data.subject;
    } catch {
      return false;
    }
  });
}

/**
 * Wake the Kanban supervisor for a problem the board itself caused.
 * The same card and the same kind are not sent twice.
 * Pass subject when one card can have the same kind for more than one agent:
 * the same card and the same agent are not sent twice.
 * Cleanup calls this with kind "archive_stuck" when an archive stays stuck or keeps coming back.
 */
export function wakeKanbanSupervisor(input: { taskId: number | null; kind: BoardProblemKind; detail: string; subject?: string }): boolean {
  // A lost or broken config file must not stop the wake that reports it (DEMO_0001).
  const who = kanbanLeaderForAlarm();
  if (!who || !isAgentAlive(who)) return false;
  const missing = agentCwdMissing(who);
  if (missing) {
    noteWakeSkipped(input.taskId, who, missing, input.kind);
    return false;
  }
  if (!hasWakeSender()) return false;
  // A paused project's cards are not chased. Cleanup trouble is still reported: that is not a nudge.
  if (input.taskId != null && input.kind !== "archive_stuck" && isProjectDormant(getTask(input.taskId).project)) return false;
  const memoryKey = input.taskId == null ? (input.subject ? `${input.kind}:${input.subject}` : input.kind) : "";
  const inflightKey = input.taskId == null ? memoryKey : `${input.taskId}:${input.kind}:${input.subject ?? ""}`;
  if (input.taskId == null) {
    if (memoryWake.has(memoryKey) || hasBoardWakeMark(memoryKey)) return false;
  } else if (boardAlready(input.taskId, input.kind, input.subject)) {
    return false;
  }
  if (boardWakeInflight.has(inflightKey) || Date.now() < (boardWakeRetryAfter.get(inflightKey) ?? 0)) return false;
  const problem = t("wake.board.problem", { label: boardLabel(input.kind) });
  let text = `${problem}\n${input.detail}`;
  const task = input.taskId != null ? getTask(input.taskId) : null;
  if (task) text = [problem, `${cardMark(task.id)} ${task.title}`, t("wake.line.project", { project: task.project }), input.detail, leaderActionNote()].join("\n");
  else text += `\n${leaderActionNote()}`;
  // The "already sent" record is written only after the sender took the text. A refused send
  // leaves nothing behind except a short retry delay, so the same problem is told again later.
  const settle = (ok: boolean): void => {
    boardWakeInflight.delete(inflightKey);
    if (!ok) {
      boardWakeRetryAfter.set(inflightKey, Date.now() + BOARD_WAKE_RETRY_MS);
      return;
    }
    boardWakeRetryAfter.delete(inflightKey);
    if (task) {
      appendEvent(task.id, "board_wake", null, task.status, "scheduler", { kind: input.kind, agentId: who, subject: input.subject ?? null, text });
      return;
    }
    memoryWake.add(memoryKey);
    addBoardWakeMark(memoryKey);
  };
  const result = sendWake(who, text);
  if (typeof result === "boolean") {
    settle(result);
    return result;
  }
  boardWakeInflight.add(inflightKey);
  void result.then(settle);
  return true;
}

/** One kind of overdue archive found on a card in this round. */
export interface OverdueArchive {
  taskId: number;
  /** "deadline" = agents not archived; "temp_workspace" = temporary workspace not put away. */
  kind: "deadline" | "temp_workspace";
  detail: string;
}

/** A card that already got an overdue wake is not woken for its other kind inside this window. */
export const OVERDUE_MERGE_WINDOW_MS = 30 * 60_000;
/** More cards than this in one project are listed as "N more card(s)". */
export const OVERDUE_LIST_MAX = 10;
const OVERDUE_SUBJECT = "overdue";
const OVERDUE_KINDS = new Set<string>(["deadline", "temp_workspace", OVERDUE_SUBJECT]);

interface OverdueHistory {
  kinds: Set<string>;
  lastAt: number;
}

function overdueHistory(taskId: number): OverdueHistory {
  const rows = getDb()
    .prepare(`SELECT at, data_json FROM events WHERE task_id = ? AND kind = 'board_wake'`)
    .all(taskId) as unknown as Array<{ at: string; data_json: string }>;
  const out: OverdueHistory = { kinds: new Set(), lastAt: 0 };
  for (const row of rows) {
    try {
      const data = JSON.parse(row.data_json) as { kind?: string; subject?: string | null; subjects?: string[] };
      if (data.kind !== "archive_stuck" || !data.subject || !OVERDUE_KINDS.has(data.subject)) continue;
      for (const kind of [data.subject, ...(data.subjects ?? [])]) out.kinds.add(kind);
      out.lastAt = Math.max(out.lastAt, Date.parse(row.at) || 0);
    } catch {
      continue;
    }
  }
  return out;
}

/** Cards to report, with the kinds that are new. Empty when the card was reported recently or fully. */
function freshOverdue(taskId: number, found: OverdueArchive[], now: Date): OverdueArchive[] {
  const history = overdueHistory(taskId);
  const fresh = found.filter((item) => !history.kinds.has(item.kind));
  if (fresh.length === 0) return [];
  if (history.kinds.size > 0 && now.getTime() - history.lastAt < OVERDUE_MERGE_WINDOW_MS) return [];
  return fresh;
}

/**
 * Wake once per project for every card whose archive stayed overdue in one round.
 * A card's two kinds (agents past the deadline, temporary workspace left behind) share one line.
 * The project's leader gets it; the Kanban supervisor takes over when none is reachable.
 * Returns the number of cards reported.
 */
export function wakeOverdueArchives(items: OverdueArchive[], now = new Date()): number {
  if (items.length === 0 || !hasWakeSender()) return 0;
  const config = loadConfig();
  const byCard = new Map<number, OverdueArchive[]>();
  for (const item of items) byCard.set(item.taskId, [...(byCard.get(item.taskId) ?? []), item]);
  const byProject = new Map<string, Array<{ task: TaskRow; fresh: OverdueArchive[] }>>();
  for (const [taskId, found] of byCard) {
    const fresh = freshOverdue(taskId, found, now);
    if (fresh.length === 0) continue;
    const task = getTask(taskId);
    byProject.set(task.project, [...(byProject.get(task.project) ?? []), { task, fresh }]);
  }
  let reported = 0;
  for (const [project, cards] of byProject) {
    const who = triageRecipient(project, config);
    if (!who) continue;
    const missing = agentCwdMissing(who);
    if (missing) {
      noteWakeSkipped(cards[0]?.task.id ?? null, who, missing, "archive_stuck");
      continue;
    }
    const sorted = [...cards].sort((a, b) => a.task.id - b.task.id);
    const shown = sorted.slice(0, OVERDUE_LIST_MAX);
    const lines = shown.map(({ task, fresh }) =>
      t("wake.overdue.line", { card: cardMark(task.id), title: task.title, details: fresh.map((item) => item.detail).join(t("common.semicolon")) }),
    );
    if (cards.length > shown.length) lines.push(t("wake.overdue.more", { count: cards.length - shown.length }));
    const text = [
      t("wake.board.problem", { label: boardLabel("archive_stuck") }),
      t("wake.overdue.project", { project, count: cards.length }),
      ...lines,
      leaderActionNote(),
    ].join("\n");
    for (const { task, fresh } of cards) {
      appendEvent(task.id, "board_wake", null, task.status, "scheduler", {
        kind: "archive_stuck",
        agentId: who,
        subject: OVERDUE_SUBJECT,
        subjects: fresh.map((item) => item.kind),
        text,
      });
    }
    deliverWake(who, text);
    reported += cards.length;
  }
  return reported;
}

export function noteTickSuccess(): void {
  tickStreak = 0;
  memoryWake.delete("tick_error");
  removeBoardWakeMark("tick_error");
}

export function noteTickFailure(message: string): void {
  tickStreak += 1;
  if (tickStreak >= 2) wakeKanbanSupervisor({ taskId: null, kind: "tick_error", detail: message });
}

/** A plugin reload: memory is gone, the persisted marks stay. */
export function forgetBoardWakesInMemoryForTests(): void {
  memoryWake.clear();
  boardWakeInflight.clear();
  boardWakeRetryAfter.clear();
  forgetBoardWakeMarkCache();
}
