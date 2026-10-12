/// <reference types="node" />
import { getDb } from "./db";
import { readContract } from "./pr";
import { branchName, laneBranchName } from "./workspace";
import { readWorktreeCreated } from "./worktree-record";
import { loadDispatchMatrix } from "./matrix";
import { parseTags } from "./profile-rules";
import { downstreamCounts } from "./downstream";
import { cardMarkOf, projectNameForCode } from "./card-ref";
import { parseCardRef } from "../shared/card-code";
import { holdPayload, lastRejections } from "./review-hold";
import { HISTORY_PAGE, roleLabel } from "../shared/labels";
import { asRows, taskById, type RunRow, type TaskRow } from "./task-record";
import { toCard, type BoardCard } from "./board-cards";

export interface HistoryItem {
  id: number;
  code: string;
  project: string;
  title: string;
  archivedAt: string;
  /** done: it was finished before it was archived. abandoned: archived without being finished. */
  outcome: "done" | "abandoned";
  auto: boolean;
}

const HISTORY_MAX_PAGE = 100;

function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

function appendHistoryQuery(where: string[], params: Array<string | number>, query: string): void {
  const parsed = parseCardRef(query);
  if (parsed?.kind === "id") {
    where.push("(t.id = ? OR t.title LIKE ? ESCAPE '\\')");
    params.push(parsed.id, likePattern(query));
    return;
  }
  if (parsed?.kind === "code") {
    const owner = projectNameForCode(parsed.code);
    if (owner) {
      where.push("((t.project = ? AND t.code_seq = ?) OR t.title LIKE ? ESCAPE '\\')");
      params.push(owner, parsed.seq, likePattern(query));
      return;
    }
    where.push("t.title LIKE ? ESCAPE '\\'");
    params.push(likePattern(query));
    return;
  }
  where.push("t.title LIKE ? ESCAPE '\\'");
  params.push(likePattern(query));
}

function historyFilter(input: { project?: string; query?: string }): { filter: string; params: Array<string | number> } {
  const where = ["t.status = 'archived'"];
  const params: Array<string | number> = [];
  if (input.project) {
    where.push("t.project = ?");
    params.push(input.project);
  }
  const query = (input.query ?? "").trim();
  if (query) appendHistoryQuery(where, params, query);
  return { filter: where.join(" AND "), params };
}

interface HistoryRow {
  id: number;
  project: string;
  code_seq: number | null;
  title: string;
  updated_at: string;
  at: string | null;
  kind: string | null;
  from_status: string | null;
}

function historyItems(rows: HistoryRow[]): HistoryItem[] {
  return rows.map((row) => ({
    id: row.id,
    code: cardMarkOf(row),
    project: row.project,
    title: row.title,
    archivedAt: row.at ?? row.updated_at,
    outcome: row.from_status === "done" ? "done" : "abandoned",
    auto: row.kind === "auto_archived",
  }));
}

/** Archived cards, newest archive first, one page at a time. The query matches a card number or part of a title. */
export function listHistory(input: { project?: string; query?: string; offset?: number; limit?: number } = {}): {
  total: number;
  items: HistoryItem[];
} {
  const { filter, params } = historyFilter(input);
  const db = getDb();
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM tasks t WHERE ${filter}`).get(...params) as { n: number }).n;
  const limit = Math.min(Math.max(1, Math.floor(input.limit ?? HISTORY_PAGE)), HISTORY_MAX_PAGE);
  const offset = Math.max(0, Math.floor(input.offset ?? 0));
  const rows = asRows<HistoryRow>(
    db
      .prepare(
        `SELECT t.id, t.project, t.code_seq, t.title, t.updated_at, e.at, e.kind, e.from_status
         FROM tasks t
         LEFT JOIN events e ON e.id = (SELECT MAX(id) FROM events WHERE task_id = t.id AND to_status = 'archived')
         WHERE ${filter}
         ORDER BY COALESCE(
           (SELECT d.at FROM events d WHERE d.task_id = t.id AND d.to_status = 'done' ORDER BY d.id DESC LIMIT 1),
           e.at,
           t.updated_at
         ) DESC, t.id DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset),
  );
  return { total, items: historyItems(rows) };
}

export interface TaskDetail {
  task: BoardCard & {
    brief: string;
    workspacePath: string | null;
    workspaceKind: string | null;
    workspaceBase: string | null;
    branch: string | null;
    lane: string | null;
    paseoWorkspace: string | null;
    profileOverride: string | null;
    tags: string[];
    effort: string | null;
    executorProfile: string | null;
    executorFamily: string | null;
    executorAgentId: string | null;
    handoff: string | null;
    readScope: "project" | null;
    createdAt: string;
    updatedAt: string;
  };
  parents: LinkRef[];
  children: LinkRef[];
  comments: Array<{ id: number; author: string; body: string; createdAt: string }>;
  events: Array<{ id: number; at: string; kind: string; fromStatus: string | null; toStatus: string | null; actor: string | null; data: string }>;
  runs: Array<{
    id: number;
    agentId: string | null;
    role: string;
    roleLabel: string;
    profileName: string | null;
    provider: string | null;
    model: string | null;
    startedAt: string;
    endedAt: string | null;
    endKind: string | null;
  }>;
  /** Latest review or leader verdict, one short text. Null when nothing has been decided yet. */
  review: ReviewVerdict | null;
  /** The three-way ruling text while the card waits for the leader after round 2. */
  reviewHold: string | null;
  /** The last two request_changes verdicts, oldest first. Empty unless the card waits after round 2. */
  holdRounds: Array<{ at: string; kind: string; reason: string; findings: string }>;
  /** PR address and the latest check outcome. Null for a card with no PR. */
  pr: PrStatus | null;
}

export interface ReviewVerdict {
  kind: string;
  at: string;
  actor: string | null;
  summary: string;
}

export interface PrStatus {
  url: string | null;
  repo: string | null;
  awaiting: boolean;
  /** Latest pr_wait / pr_failed / pr_error event. Null when checks never reported. */
  check: { kind: string; at: string; summary: string } | null;
}

interface LinkRef {
  id: number;
  title: string;
  status: string;
  project: string;
  code: string;
}

interface CommentRow {
  id: number;
  task_id: number;
  author: string;
  body: string;
  created_at: string;
}

interface EventRow {
  id: number;
  task_id: number;
  at: string;
  kind: string;
  from_status: string | null;
  to_status: string | null;
  actor: string | null;
  data_json: string;
}

const VERDICT_KINDS = ["approve", "request_changes", "rejected", "leader_rework", "leader_pass"] as const;
const PR_CHECK_KINDS = ["pr_wait", "pr_failed", "pr_error"] as const;
const VERDICT_TEXT_MAX = 400;

function eventText(raw: string): string {
  try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    for (const key of ["summary", "reason", "note"]) {
      const value = data[key];
      if (typeof value === "string" && value.trim()) return value.trim().slice(0, VERDICT_TEXT_MAX);
    }
  } catch {
    return "";
  }
  return "";
}

function latestEvent(taskId: number, kinds: readonly string[]): { kind: string; at: string; actor: string | null; data_json: string } | null {
  const marks = kinds.map(() => "?").join(", ");
  const row = getDb()
    .prepare(`SELECT kind, at, actor, data_json FROM events WHERE task_id = ? AND kind IN (${marks}) ORDER BY id DESC LIMIT 1`)
    .get(taskId, ...kinds) as { kind: string; at: string; actor: string | null; data_json: string } | undefined;
  return row ?? null;
}

function reviewVerdict(taskId: number): ReviewVerdict | null {
  const row = latestEvent(taskId, VERDICT_KINDS);
  return row ? { kind: row.kind, at: row.at, actor: row.actor, summary: eventText(row.data_json) } : null;
}

function prStatus(task: TaskRow): PrStatus | null {
  const contract = readContract(task.contract_json);
  if (!contract.pr && contract.kind !== "github") return null;
  const row = latestEvent(task.id, PR_CHECK_KINDS);
  return {
    url: contract.pr,
    repo: contract.repo,
    awaiting: contract.awaiting,
    check: row ? { kind: row.kind, at: row.at, summary: eventText(row.data_json) } : null,
  };
}

function laneInfo(task: TaskRow): { branch: string | null; lane: string | null } {
  if (task.workspace_kind !== "lane") return { branch: null, lane: null };
  const row = getDb()
    .prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'lane_bound' ORDER BY id DESC LIMIT 1")
    .get(task.id) as { data_json: string } | undefined;
  if (row) {
    try {
      const data = JSON.parse(row.data_json) as { branch?: unknown; lane?: unknown };
      const branch = typeof data.branch === "string" && data.branch ? data.branch : laneBranchName(task.id, task.title);
      const lane = typeof data.lane === "string" && data.lane ? data.lane : null;
      return { branch, lane };
    } catch {
      // fall through to the name this card would use
    }
  }
  return { branch: laneBranchName(task.id, task.title), lane: null };
}

function worktreeBranch(task: TaskRow): string | null {
  if (task.workspace_kind !== "worktree") return null;
  const data = readWorktreeCreated(task.id);
  if (typeof data?.branch === "string" && data.branch) return data.branch;
  return branchName(task.id, task.title);
}

function linkRefs(rows: unknown): LinkRef[] {
  return asRows<{ id: number; title: string; status: string; project: string; code_seq: number | null }>(rows).map((row) => ({
    id: row.id,
    title: row.title,
    status: row.status,
    project: row.project,
    code: cardMarkOf(row),
  }));
}

function detailLinks(db: ReturnType<typeof getDb>, id: number): { parents: LinkRef[]; children: LinkRef[] } {
  return {
    parents: linkRefs(
      db
        .prepare(
          `SELECT t.id, t.title, t.status, t.project, t.code_seq FROM links l JOIN tasks t ON t.id = l.parent_id WHERE l.task_id = ? ORDER BY t.id`,
        )
        .all(id),
    ),
    children: linkRefs(
      db
        .prepare(
          `SELECT t.id, t.title, t.status, t.project, t.code_seq FROM links l JOIN tasks t ON t.id = l.task_id WHERE l.parent_id = ? ORDER BY t.id`,
        )
        .all(id),
    ),
  };
}

function detailComments(db: ReturnType<typeof getDb>, id: number): TaskDetail["comments"] {
  return asRows<CommentRow>(db.prepare(`SELECT * FROM comments WHERE task_id = ? ORDER BY id`).all(id)).map((c) => ({
    id: c.id,
    author: c.author,
    body: c.body,
    createdAt: c.created_at,
  }));
}

function detailEvents(db: ReturnType<typeof getDb>, id: number): TaskDetail["events"] {
  return asRows<EventRow>(db.prepare(`SELECT * FROM events WHERE task_id = ? ORDER BY id`).all(id)).map((e) => ({
    id: e.id,
    at: e.at,
    kind: e.kind,
    fromStatus: e.from_status,
    toStatus: e.to_status,
    actor: e.actor,
    data: e.data_json,
  }));
}

function detailRuns(db: ReturnType<typeof getDb>, id: number): TaskDetail["runs"] {
  return asRows<RunRow>(db.prepare(`SELECT * FROM runs WHERE task_id = ? ORDER BY id`).all(id)).map((r) => ({
    id: r.id,
    agentId: r.agent_id,
    role: r.role,
    roleLabel: roleLabel(r.role),
    profileName: r.profile_name,
    provider: r.provider,
    model: r.model,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    endKind: r.end_kind,
  }));
}

function detailTask(task: TaskRow, card: BoardCard, lane: { branch: string | null; lane: string | null }): TaskDetail["task"] {
  return {
    ...card,
    brief: task.brief,
    workspacePath: task.workspace_path,
    workspaceKind: task.workspace_kind,
    workspaceBase: task.workspace_base,
    branch: task.workspace_kind === "lane" ? lane.branch : worktreeBranch(task),
    lane: lane.lane,
    paseoWorkspace: task.paseo_workspace_name,
    profileOverride: task.profile_override,
    tags: parseTags(task.tags),
    effort: task.effort,
    executorProfile: task.executor_profile,
    executorFamily: task.executor_family,
    executorAgentId: task.executor_agent_id,
    handoff: task.handoff_json,
    readScope: task.status === "done" || task.status === "archived" ? null : task.project_read_scope,
    createdAt: task.created_at,
    updatedAt: task.updated_at,
  };
}

export function getDetail(id: number): TaskDetail {
  const task = taskById(id);
  const db = getDb();
  const loaded = loadDispatchMatrix();
  const card = toCard(task, loaded.state === "ok" ? loaded.matrix.defaultTier : null, downstreamCounts().get(task.id) ?? 0);
  const links = detailLinks(db, id);
  const comments = detailComments(db, id);
  const events = detailEvents(db, id);
  const lane = laneInfo(task);
  const runs = detailRuns(db, id);
  return {
    task: detailTask(task, card, lane),
    parents: links.parents,
    children: links.children,
    comments,
    events,
    runs,
    review: reviewVerdict(id),
    reviewHold: card.leaderHold ? holdPayload(id)?.next ?? null : null,
    holdRounds: card.leaderHold ? lastRejections(id, 2) : [],
    pr: prStatus(task),
  };
}
