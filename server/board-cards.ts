/// <reference types="node" />
import { scheduledWaitLabel } from "../shared/blocked";
import { LEADER_UNRESPONSIVE_TAG } from "./leader-activity";
import { loadAcceptanceReviewWaits, acceptanceReviewWaitText, type AcceptanceReviewWait } from "./acceptance-review-wait";
import { awaitingLeaderHold } from "./review-hold";
import { cleanupNoteFor } from "./archive-book";
import { pendingLand } from "./land-pending";
import { tempNoteFor } from "./temp-mark";
import { mcpStaleNote as staleNoteText } from "./fallback";
import { getDb } from "./db";
import { loadConfig, projectCode } from "./config";
import { profileModels } from "./profile-models";
import { contractLabel, readContract } from "./pr";
import { mergeCardNotes, taskParents } from "./parents";
import { loadDispatchMatrix } from "./matrix";
import { parseTags } from "./profile-rules";
import { isTier, resolveTier, type Tier } from "./tier";
import { downstreamCounts } from "./downstream";
import { cardMark, cardMarkOf } from "./card-ref";
import { completionNextStep } from "./external-wait";
import { findAgentFile } from "./open";
import { t } from "../shared/i18n";
import { removedProjects } from "./paseo-projects";
import { dragNote } from "../shared/board-view";
import {
  assigneeLine,
  assignerLabel,
  assignerShortLabel,
  cardModelLabel,
  boardColumnFor,
  briefAcceptance,
  briefHow,
  cardBadge,
  handoffLine,
  notStarted,
  relatedLine,
  returnNoteText,
  roleLabel,
} from "../shared/labels";
import { awaitingMerge, finishedAt } from "./task-lifecycle";
import {
  asRows,
  currentRun,
  earliestRun,
  executorRun,
  modelOf,
  personText,
  type RunRow,
  type TaskRow,
} from "./task-record";

export interface BoardCard {
  downstreamCount: number;
  id: number;
  /** Display number, e.g. DEMO_0001. `id` stays the global key. */
  code: string;
  project: string;
  title: string;
  role: string;
  roleLabel: string;
  status: string;
  profile: string | null;
  model: string | null;
  agentId: string | null;
  reviewRound: number;
  blockedAt: string | null;
  scheduledUntil: string | null;
  blockedKind: string | null;
  blockedReason: string | null;
  startedAt: string | null;
  currentText: string | null;
  executorText: string | null;
  executorAgentId: string | null;
  nextStep: string | null;
  cleanupNote: string | null;
  /** Set while this card has a temporary workspace that has not been cleaned up. */
  tempNote: string | null;
  contract: string;
  prUrl: string | null;
  unattended: boolean;
  mcpNote: string | null;
  stallNote: string | null;
  /** When a done card finished. Null for every other status. */
  finishedAt: string | null;
  awaitingMerge: boolean;
  /** Display column: todo, doing, done. Archived cards are not on this list. */
  column: string;
  badge: string;
  assigner: string;
  /** Face line: who sent it, e.g. `KBN <leader>` or the user. */
  assignerShort: string;
  /** Face line: short model name, the profile name when no model is known, or "not assigned yet". */
  modelShort: string;
  related: string;
  assignee: string;
  goal: string;
  acceptance: string;
  acceptanceMissing: boolean;
  /** Latest review or supervisor reject, one or two lines. Null when this card was not sent back. */
  returnNote: string | null;
  /** One line from the handoff, set for done cards. */
  outcome: string | null;
  /** Stored tier. Null when the card does not set one. */
  tier: string | null;
  /** Tier this card will use on the next start, including the default. */
  tierLabel: string;
  /** Tagged leader-unresponsive: acceptance has waited 2 hours with no leader action. */
  leaderUnresponsive: boolean;
  /** Rework card parked after the round-2 rejection until the leader rules. */
  leaderHold: boolean;
}

export function stallNoteFor(task: Pick<TaskRow, "id" | "status" | "agent_id">): string | null {
  if ((task.status !== "running" && task.status !== "reviewing") || !task.agent_id) return null;
  const rows = getDb()
    .prepare(`SELECT data_json FROM events WHERE task_id = ? AND kind = 'stalled' ORDER BY id DESC`)
    .all(task.id) as unknown as Array<{ data_json: string }>;
  for (const row of rows) {
    try {
      const data = JSON.parse(row.data_json) as { agentId?: string; text?: string };
      if (data.agentId === task.agent_id && data.text) return data.text;
    } catch {
      continue;
    }
  }
  return null;
}

function mcpStaleNote(task: TaskRow): string | null {
  if (!task.agent_id) return null;
  const rows = getDb()
    .prepare(`SELECT data_json FROM events WHERE task_id = ? AND kind = 'mcp_stale' ORDER BY id DESC`)
    .all(task.id) as unknown as Array<{ data_json: string }>;
  const stale = rows.some((row) => {
    try {
      const data = JSON.parse(row.data_json) as { agentId?: string };
      return data.agentId === task.agent_id;
    } catch {
      return false;
    }
  });
  return stale ? staleNoteText() : null;
}

function agentTitle(agentId: string | null, titles: Map<string, string | null>): string | null {
  if (!agentId) return null;
  if (titles.has(agentId)) return titles.get(agentId) ?? null;
  let found: string | null = null;
  try {
    found = findAgentFile(agentId)?.title?.trim() || null;
  } catch {
    found = null;
  }
  titles.set(agentId, found);
  return found;
}

function parentRefs(taskId: number, config: ReturnType<typeof loadConfig>): Array<{ id: number; title: string; code: string }> {
  return asRows<{ id: number; project: string; title: string; code_seq: number | null }>(
    getDb().prepare(`SELECT t.id, t.project, t.title, t.code_seq FROM links l JOIN tasks t ON t.id = l.parent_id WHERE l.task_id = ? ORDER BY t.id`).all(taskId),
  ).map((row) => ({ id: row.id, title: row.title, code: cardMarkOf(row, config) }));
}

function latestReturn(taskId: number): { kind: string; reason: string } | null {
  const row = getDb()
    .prepare(
      `SELECT kind, data_json FROM events WHERE task_id = ? AND kind IN ('land_conflict', 'request_changes', 'rejected', 'leader_rework') ORDER BY id DESC LIMIT 1`,
    )
    .get(taskId) as { kind: string; data_json: string } | undefined;
  if (!row) return null;
  try {
    const data = JSON.parse(row.data_json) as { reason?: unknown };
    const reason = typeof data.reason === "string" ? data.reason : "";
    return { kind: row.kind, reason };
  } catch {
    return { kind: row.kind, reason: "" };
  }
}

/** The card this one reviews, when review_of is set. */
function reviewedCard(task: TaskRow, config: ReturnType<typeof loadConfig>): { id: number; title: string; code: string } | null {
  const id = task.review_of;
  if (!id) return null;
  const row = getDb().prepare("SELECT id, project, title, code_seq FROM tasks WHERE id = ?").get(id) as
    | { id: number; project: string; title: string; code_seq: number | null }
    | undefined;
  if (!row) return { id, title: t("boardCards.reviewed.missing"), code: cardMark(id) };
  return { id: row.id, title: row.title, code: cardMarkOf(row, config) };
}

/** What the card face needs from outside the task row. Read once per board build, not per card. */
export interface CardContext {
  supervisors: Record<string, string>;
  kanbanLeaderId: string | null;
  projectCodes: Record<string, string | null>;
  /** The config read for this build, so a card's display number does not read the file again. */
  config: ReturnType<typeof loadConfig>;
  profileModels: Map<string, string>;
  /** Agent titles read so far in this build. The same few leaders created most cards, and each card asks twice. */
  agentTitles: Map<string, string | null>;
  reviewWaits: Map<number, AcceptanceReviewWait>;
}


export function loadCardContext(): CardContext {
  const config = loadConfig();
  return {
    config,
    supervisors: config.supervisors,
    kanbanLeaderId: config.supervisorAgentId,
    projectCodes: Object.fromEntries(Object.keys(config.projects ?? {}).map((name) => [name, projectCode(name, config)])),
    profileModels: profileModels(),
    agentTitles: new Map(),
    reviewWaits: loadAcceptanceReviewWaits(),
  };
}

interface CardFacts {
  task: TaskRow;
  defaultTier: Tier | null;
  downstreamCount: number;
  run: RunRow | null;
  executor: RunRow | null;
  first: RunRow | null;
  model: string | null;
  currentText: string | null;
  showExecutor: boolean;
  contract: ReturnType<typeof readContract>;
  parents: Array<{ id: number; title: string; code: string }>;
  returned: { kind: string; reason: string } | null;
  acceptance: ReturnType<typeof briefAcceptance>;
  started: boolean;
  profile: string | null;
  reviewOf: { id: number; title: string; code: string } | null;
  pending: ReturnType<typeof pendingLand>;
  context: CardContext;
}

function cardFacts(task: TaskRow, defaultTier: Tier | null, downstreamCount: number, context: CardContext): CardFacts {
  const run = currentRun(task);
  const executor = executorRun(task);
  const first = earliestRun(task.id);
  const model = modelOf(run);
  const currentText = run ? personText(run.role, run.profile_name, model, task.agent_id) : null;
  const showExecutor = Boolean(task.executor_agent_id && task.agent_id && task.executor_agent_id !== task.agent_id);
  const contract = readContract(task.contract_json);
  const parents = parentRefs(task.id, context.config);
  const returned = task.status === "rework" || task.status === "blocked" ? latestReturn(task.id) : null;
  const acceptance = briefAcceptance(task.brief ?? "");
  const started = !notStarted(task.status, task.blocked_from) && Boolean(task.agent_id);
  const profile = run?.profile_name ?? task.executor_profile ?? task.profile_override;
  const reviewOf = reviewedCard(task, context.config);
  const pending = task.status === "done" || task.status === "archived" ? pendingLand(task.id) : null;
  return {
    task, defaultTier, downstreamCount, run, executor, first, model, currentText, showExecutor,
    contract, parents, returned, acceptance, started, profile, reviewOf, pending, context,
  };
}

function cardHead(facts: CardFacts) {
  const { task, run, model, downstreamCount, first, currentText, showExecutor, executor } = facts;
  return {
    downstreamCount,
    id: task.id,
    code: cardMarkOf(task, facts.context.config),
    project: task.project,
    title: task.title,
    role: task.role,
    roleLabel: roleLabel(task.role),
    status: task.status,
    profile: run?.profile_name ?? task.profile_override ?? task.executor_profile,
    model,
    agentId: task.agent_id,
    startedAt: first?.started_at ?? run?.started_at ?? null,
    currentText,
    executorText: showExecutor
      ? personText(executor?.role ?? "executor", executor?.profile_name ?? task.executor_profile, modelOf(executor), task.executor_agent_id)
      : null,
    executorAgentId: task.executor_agent_id,
    reviewRound: task.review_round,
    blockedAt: task.blocked_at,
    scheduledUntil: task.scheduled_until,
    blockedKind: task.blocked_kind,
    blockedReason: task.blocked_reason,
  };
}

function cardStatus(facts: CardFacts) {
  const { task, contract } = facts;
  return {
    waitDecision: task.wait_decision,
    nextStep: facts.context.reviewWaits.has(task.id)
      ? acceptanceReviewWaitText(facts.context.reviewWaits.get(task.id)!) : completionNextStep(task.handoff_json, task.hold_reason, task.status),
    cleanupNote: cleanupNoteFor(task.id),
    tempNote: tempNoteFor(task.id),
    contract: contractLabel(contract),
    prUrl: contract.pr,
    unattended: !facts.context.reviewWaits.has(task.id) && Boolean(task.unattended_at),
    mcpNote: mcpStaleNote(task),
    stallNote: stallNoteFor(task),
    finishedAt: task.status === "done" ? finishedAt(task) : null,
    awaitingMerge: awaitingMerge(task, contract),
    column: boardColumnFor(task.status, task.blocked_from),
  };
}

function cardFace(facts: CardFacts) {
  const { task, returned, parents, pending, profile, model, started, run, acceptance, reviewOf, defaultTier, downstreamCount, context } = facts;
  return {
    badge: task.status === "blocked" && task.blocked_kind === "scheduled" && task.scheduled_until
      ? scheduledWaitLabel(task.scheduled_until) : context.reviewWaits.has(task.id) ? t('acceptanceReviewWait.badge') : cardBadge({
      status: task.status,
      reviewRound: task.review_round,
      parentMarks: parents.map((item) => item.code),
      supervisorReject: returned?.kind === "rejected",
      landPending: pending != null,
      landConflict: pending?.conflict === true,
    }),
    assigner: assignerLabel({
      createdBy: task.created_by,
      createdByAgent: task.created_by_agent,
      agentTitle: agentTitle(task.created_by_agent, context.agentTitles),
    }),
    assignerShort: assignerShortLabel({
      createdBy: task.created_by,
      createdByAgent: task.created_by_agent,
      agentTitle: agentTitle(task.created_by_agent, context.agentTitles),
      projectLeaderId: context.supervisors[task.project] ?? null,
      kanbanLeaderId: context.kanbanLeaderId,
      projectCode: context.projectCodes[task.project] ?? null,
      project: task.project,
    }),
    modelShort: cardModelLabel({
      hasRun: run !== null,
      model: run?.model ?? null,
      profileModel: profile ? (context.profileModels.get(profile) ?? null) : null,
      profile,
    }),
    related: [relatedLine({ project: task.project, parents, reviewOf, tags: parseTags(task.tags) }), dragNote(downstreamCount), ...mergeCardNotes(task, taskParents(task.id))].join(" · "),
    assignee: assigneeLine({
      started,
      profileOverride: task.profile_override,
      roleLabel: roleLabel(run?.role ?? task.role),
      profile,
      model,
    }),
    goal: briefHow(task.brief ?? ""),
    acceptance: acceptance.text,
    acceptanceMissing: acceptance.missing,
    returnNote: returned?.reason ? returnNoteText(returned.reason) : null,
    outcome: task.status === "done" ? handoffLine(task.handoff_json) : null,
    tier: task.tier && isTier(task.tier) ? task.tier : null,
    tierLabel: resolveTier(task.tier, parseTags(task.tags), defaultTier),
    leaderUnresponsive: !context.reviewWaits.has(task.id) && parseTags(task.tags).includes(LEADER_UNRESPONSIVE_TAG),
    leaderHold: task.status === "rework" && awaitingLeaderHold(task.id),
  };
}

export function toCard(task: TaskRow, defaultTier: Tier | null, downstreamCount: number, context: CardContext = loadCardContext()): BoardCard {
  const facts = cardFacts(task, defaultTier, downstreamCount, context);
  return { ...cardHead(facts), ...cardStatus(facts), ...cardFace(facts) };
}

/**
 * Cards for the board. `archived: false` leaves archived cards out; the board
 * reads them page by page through listHistory instead.
 */
export function listBoard(project?: string, options: { archived?: boolean; includeRemoved?: boolean } = {}): { projects: string[]; tasks: BoardCard[] } {
  const db = getDb();
  // Projects that left Paseo stay in the database but not on the board, unless asked for.
  const removed = options.includeRemoved ? new Set<string>() : removedProjects();
  const projects = asRows<{ project: string }>(db.prepare(`SELECT DISTINCT project FROM tasks ORDER BY project`).all()).map((r) => r.project).filter((name) => !removed.has(name));
  const where: string[] = [];
  const params: string[] = [];
  if (project) {
    where.push("project = ?");
    params.push(project);
  }
  if (options.archived === false) where.push("status <> 'archived'");
  const sql = `SELECT * FROM tasks${where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY priority DESC, id DESC`;
  const rows = asRows<TaskRow>(db.prepare(sql).all(...params)).filter((task) => !removed.has(task.project));
  const loaded = loadDispatchMatrix();
  const defaultTier = loaded.state === "ok" ? loaded.matrix.defaultTier : null;
  const downstream = downstreamCounts();
  const context = loadCardContext();
  return { projects, tasks: rows.map((task) => toCard(task, defaultTier, downstream.get(task.id) ?? 0, context)) };
}

export function archivedCount(project?: string): number {
  const row = (project
    ? getDb().prepare(`SELECT COUNT(*) AS n FROM tasks WHERE status = 'archived' AND project = ?`).get(project)
    : getDb().prepare(`SELECT COUNT(*) AS n FROM tasks WHERE status = 'archived'`).get()) as { n: number };
  return row.n;
}

/** What the board RPC sends: every card that is not archived, plus how many are. */
export function boardSnapshot(project?: string): { projects: string[]; tasks: BoardCard[]; archivedCount: number } {
  return { ...listBoard(project, { archived: false }), archivedCount: archivedCount(project) };
}
