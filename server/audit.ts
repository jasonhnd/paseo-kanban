/// <reference types="node" />
import { agentRetired, agentsOpenedBy, cleanupIssues, overdueAgentIds, turnOpenAgentIds, turnUnknownAgentIds } from "./archive-book";
import { DEFAULT_ARCHIVE_TIMEOUT_MS, loadConfig } from "./config";
import { getDb } from "./db";
import { isLaneWorkspace } from "./lane-mark";
import { isProjectMain, samePath, type ListedWorkspace } from "./placement";
import { cardMark } from "./card-ref";
import { pendingLand, workspaceHeldForLand } from "./land-pending";
import { stallNoteFor, type TaskRow } from "./store";
import { listTempWorkspaces, tempAuditLines } from "./temp-workspace";
import { leftoverGitWorktrees } from "./worktree-gc";
import { t } from "../shared/i18n";
import { statusLabel } from "../shared/labels";
import { formatTickTime } from "../shared/scheduler";
import { doctorAuditLine } from "./doctor";
import { readSchedulerTickAt } from "./liveness";

export interface AuditAgent {
  id: string;
  archived: boolean;
  workspaceId: string | null;
}

/** Read-only look at Paseo. Implementations must not archive anything. */
export interface AuditView {
  listActiveAgents(): Promise<AuditAgent[]>;
  inspectWorkspace(workspaceId: string): Promise<ListedWorkspace | null>;
}

export interface AuditCard {
  id: number;
  title: string;
  status: string;
  unarchivedAgents: string[];
  overdueAgents: string[];
  /** Live agents past the deadline whose turn has not ended. Not an overdue archive. */
  turnOpenAgents?: string[];
  /** Live agents whose last wait_turn is stale. This tick has not confirmed them yet. */
  turnUnknownAgents?: string[];
  unclearedWorkspaces: string[];
  gitWorktrees: string[];
  stuck: string[];
  failures: string[];
  stalled: string | null;
  /** Distinct worktree directories on an unfinished card. Set when there are two or more. */
  duplicateWorktrees?: string[];
}

export interface AuditReport {
  ok: boolean;
  message: string;
  schedulerTickAt: string | null;
  cards: AuditCard[];
  /** Paseo workspaces Kanban opened that no unfinished card still uses. Main workspaces are left out. */
  unusedWorkspaces: string[];
  workspaceErrors: string[];
  /** Every temporary workspace that is still open, late ones included. */
  tempLines: string[];
}

function readLimit(): number {
  return loadConfig().archiveTimeoutMs ?? DEFAULT_ARCHIVE_TIMEOUT_MS;
}

async function within<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(t("audit.timeout"))), ms);
  });
  void work.then(
    () => undefined,
    () => undefined,
  );
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function finishedTasks(): TaskRow[] {
  return getDb().prepare("SELECT * FROM tasks WHERE status IN ('done', 'archived') ORDER BY id").all() as unknown as TaskRow[];
}

function worktreeDirectories(taskId: number): string[] {
  const rows = getDb()
    .prepare("SELECT data_json FROM events WHERE task_id = ? AND kind IN ('worktree_created', 'temp_workspace') ORDER BY id")
    .all(taskId) as Array<{ data_json: string }>;
  const dirs: string[] = [];
  for (const row of rows) {
    let data: { directory?: unknown; discarded?: unknown };
    try {
      data = JSON.parse(row.data_json) as { directory?: unknown; discarded?: unknown };
    } catch {
      continue;
    }
    if (data.discarded === true) continue;
    if (typeof data.directory !== "string" || !data.directory.trim()) continue;
    if (dirs.some((dir) => samePath(dir, data.directory as string))) continue;
    dirs.push(data.directory);
  }
  return dirs;
}

/** Unfinished cards whose worktree events point at more than one directory. */
function duplicateWorktreeCards(): AuditCard[] {
  const tasks = getDb()
    .prepare("SELECT id, title, status FROM tasks WHERE status NOT IN ('done', 'archived') ORDER BY id")
    .all() as Array<{ id: number; title: string; status: string }>;
  const cards: AuditCard[] = [];
  for (const task of tasks) {
    const directories = worktreeDirectories(task.id);
    if (directories.length < 2) continue;
    cards.push({
      id: task.id,
      title: task.title,
      status: task.status,
      unarchivedAgents: [],
      overdueAgents: [],
      unclearedWorkspaces: [],
      gitWorktrees: [],
      stuck: [],
      failures: [],
      stalled: null,
      duplicateWorktrees: directories,
    });
  }
  return cards;
}

function attachDuplicates(cards: AuditCard[]): void {
  for (const extra of duplicateWorktreeCards()) {
    const found = cards.find((card) => card.id === extra.id);
    if (found) {
      found.duplicateWorktrees = extra.duplicateWorktrees;
      continue;
    }
    cards.push(extra);
  }
}

function stalledCards(): AuditCard[] {
  const rows = getDb().prepare("SELECT * FROM tasks WHERE status IN ('running', 'reviewing') ORDER BY id").all() as unknown as TaskRow[];
  const cards: AuditCard[] = [];
  for (const task of rows) {
    const stalled = stallNoteFor(task);
    if (!stalled) continue;
    cards.push({
      id: task.id,
      title: task.title,
      status: task.status,
      unarchivedAgents: [],
      overdueAgents: [],
      unclearedWorkspaces: [],
      gitWorktrees: [],
      stuck: [],
      failures: [],
      stalled,
    });
  }
  return cards;
}

async function unclearedWorkspace(task: TaskRow, active: AuditAgent[], view: AuditView, ms: number): Promise<string | null> {
  if (task.workspace_kind !== "worktree") return null;
  const workspaceId = task.paseo_workspace_id;
  if (!workspaceId) return null;
  if (isLaneWorkspace(workspaceId, task.workspace_path)) return null;
  const others = getDb().prepare("SELECT COUNT(*) AS n FROM tasks WHERE paseo_workspace_id = ? AND id != ?").get(workspaceId, task.id) as {
    n: number;
  };
  if (others.n > 0) return null;
  const snapshot = await within(view.inspectWorkspace(workspaceId), ms);
  if (!snapshot) return null;
  if (isLaneWorkspace(workspaceId, snapshot.directory)) return null;
  if (snapshot.archived || snapshot.kind !== "worktree" || isProjectMain(snapshot) || samePath(snapshot.directory, snapshot.projectRoot)) return null;
  const ours = new Set(agentsOpenedBy(task));
  const foreign = active.some((agent) => !agent.archived && agent.workspaceId === workspaceId && !ours.has(agent.id));
  if (foreign) return null;
  return workspaceId;
}

/** Read the database and Paseo. Does not write, and does not archive. */
export async function performAudit(view: AuditView): Promise<AuditReport> {
  const ms = readLimit();
  let active: AuditAgent[];
  try {
    active = await within(view.listActiveAgents(), ms);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const stalled = stalledCards();
    attachDuplicates(stalled);
    return {
      ok: false,
      message: t("audit.agentsUnreadable", { message }),
      schedulerTickAt: readSchedulerTickAt(),
      cards: stalled,
      unusedWorkspaces: [],
      workspaceErrors: [],
      tempLines: safeTempAudit().lines,
    };
  }
  const live = new Set(active.filter((agent) => !agent.archived).map((agent) => agent.id));
  const cards: AuditCard[] = [];
  for (const task of finishedTasks()) {
    const issues = cleanupIssues(task.id);
    const late = new Set(overdueAgentIds(task.id));
    const turnOpen = new Set(turnOpenAgentIds(task.id));
    const turnUnknown = new Set(turnUnknownAgentIds(task.id));
    const openedLive = agentsOpenedBy(task).filter((id) => live.has(id) && !agentRetired(task.id, id));
    const turnOpenAgents = openedLive.filter((id) => turnOpen.has(id));
    const turnUnknownAgents = openedLive.filter((id) => turnUnknown.has(id));
    const overdueAgents = openedLive.filter((id) => late.has(id));
    const unarchivedAgents = openedLive.filter((id) => !late.has(id) && !turnOpen.has(id) && !turnUnknown.has(id));
    const unclearedWorkspaces: string[] = [];
    const gitWorktrees = leftoverGitWorktrees(task);
    if (!pendingLand(task.id)) {
      try {
        const workspaceId = await unclearedWorkspace(task, active, view, ms);
        if (workspaceId) unclearedWorkspaces.push(workspaceId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        issues.failures.push(t("audit.workspaceUnreadable", { workspace: task.paseo_workspace_id ?? "", message }).trim());
      }
    }
    if (
      unarchivedAgents.length === 0 &&
      overdueAgents.length === 0 &&
      turnOpenAgents.length === 0 &&
      turnUnknownAgents.length === 0 &&
      unclearedWorkspaces.length === 0 &&
      gitWorktrees.length === 0 &&
      issues.stuck.length === 0 &&
      issues.failures.length === 0
    ) {
      continue;
    }
    cards.push({
      id: task.id,
      title: task.title,
      status: task.status,
      unarchivedAgents,
      overdueAgents,
      turnOpenAgents,
      turnUnknownAgents,
      unclearedWorkspaces,
      gitWorktrees,
      stuck: issues.stuck,
      failures: issues.failures,
      stalled: null,
    });
  }
  const stalled = stalledCards();
  cards.push(...stalled);
  attachDuplicates(cards);
  const unused = await unusedKanbanWorkspaces(view, ms);
  const unusedWorkspaces = unused.ids;
  const workspaceErrors = unused.errors;
  const { lines: tempLines, late } = safeTempAudit();
  const leak = late || unusedWorkspaces.length > 0 || workspaceErrors.length > 0 || cards.some((card) => card.stalled == null);
  const ok = !late && cards.length === 0 && unusedWorkspaces.length === 0 && workspaceErrors.length === 0;
  const message = ok ? t("audit.summary.clean") : leak ? t("audit.summary.leak") : t("audit.summary.stalled");
  return { ok, message, schedulerTickAt: readSchedulerTickAt(), cards, unusedWorkspaces, workspaceErrors, tempLines };
}

/**
 * The temporary workspace lines for the report, and whether one of them is a late (not cleaned up) workspace.
 * Lateness comes from the rows, not from the line text: a late line is exactly a row that is late and not waiting to land.
 */
function safeTempAudit(): { lines: string[]; late: boolean } {
  try {
    const rows = listTempWorkspaces();
    return { lines: tempAuditLines(rows), late: rows.some((row) => !row.pendingReason && row.late) };
  } catch {
    return { lines: [], late: false };
  }
}

/** Workspaces this board bound that no unfinished card still holds. Project main workspaces stay. */
async function unusedKanbanWorkspaces(view: AuditView, ms: number): Promise<{ ids: string[]; errors: string[] }> {
  const rows = getDb()
    .prepare(
      `SELECT DISTINCT paseo_workspace_id AS id FROM tasks
       WHERE paseo_workspace_id IS NOT NULL AND trim(paseo_workspace_id) != ''
       ORDER BY id`,
    )
    .all() as unknown as Array<{ id: string }>;
  const ids: string[] = [];
  const errors: string[] = [];
  for (const row of rows) {
    const used = getDb()
      .prepare(`SELECT COUNT(*) AS n FROM tasks WHERE paseo_workspace_id = ? AND status NOT IN ('done', 'archived')`)
      .get(row.id) as { n: number };
    if (used.n > 0) continue;
    if (workspaceHeldForLand(row.id)) continue;
    if (isLaneWorkspace(row.id)) continue;
    try {
      const snapshot = await within(view.inspectWorkspace(row.id), ms);
      if (!snapshot || snapshot.archived || isProjectMain(snapshot)) continue;
      if (isLaneWorkspace(row.id, snapshot.directory)) continue;
      ids.push(row.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(t("audit.rowUnreadable", { id: row.id, message }));
    }
  }
  return { ids, errors };
}

export function formatAudit(report: AuditReport): string {
  const tick = t("audit.lastTick", { time: formatTickTime(report.schedulerTickAt) });
  const temps = report.tempLines ?? [];
  const doctor = doctorAuditLine();
  if (report.ok) {
    const body = temps.length ? `${temps.join("\n")}\n` : "";
    return `${t("audit.summary.clean")}\n${body}${tick}\n${doctor}`;
  }
  const lines: string[] = [];
  if (report.cards.length === 0) lines.push(report.message);
  for (const card of report.cards) {
    lines.push(t("audit.cardLine", { card: cardMark(card.id), title: card.title, status: statusLabel(card.status) }));
    for (const id of card.overdueAgents) lines.push(t("audit.overdue", { id }));
    for (const id of card.turnOpenAgents ?? []) lines.push(t("audit.turnOpen", { id }));
    for (const id of card.turnUnknownAgents ?? []) lines.push(t("audit.turnUnknown", { id }));
    for (const id of card.unarchivedAgents) lines.push(t("audit.unarchived", { id }));
    for (const id of card.unclearedWorkspaces) lines.push(t("audit.uncleared", { id }));
    for (const line of card.gitWorktrees) lines.push(t("audit.gitWorktree", { line }));
    for (const line of card.stuck) lines.push(line);
    for (const line of card.failures) lines.push(t("audit.cleanupFailed", { line }));
    if ((card.duplicateWorktrees?.length ?? 0) > 1) lines.push(t("audit.duplicateWorktrees", { list: card.duplicateWorktrees?.join(t("common.listSep")) ?? "" }));
    if (card.stalled) lines.push(card.stalled);
  }
  for (const id of report.unusedWorkspaces) lines.push(t("audit.unusedWorkspace", { id }));
  for (const line of report.workspaceErrors) lines.push(t("audit.workspaceError", { line }));
  for (const line of temps) lines.push(line);
  lines.push(tick);
  lines.push(doctor);
  return lines.join("\n");
}
