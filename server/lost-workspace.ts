/// <reference types="node" />
import type { AgentLauncher } from "./dispatch";
import type { AgentLiveness } from "./open";
import type { ListedWorkspace } from "./placement";
import { blockTask } from "./task-lifecycle";
import type { TaskRow } from "./task-record";
import { t } from "../shared/i18n";
import { getDb } from "./db";
import { appendEvent, getTask, requestAgentReleases } from "./store";
import { readWorktreeCreated } from "./worktree-record";
import { samePath } from "./placement";
import { branchOwnedByCard } from "./workspace";
import { START_CLAIM_TTL_MS } from "./start-claim";
import { revokeAgentToken } from "./tokens";
import { worktreeDirectoryLost } from "./workspace-recreate";
import type { ReworkReplacement } from "./flow";

/** A short window is necessary but never sufficient evidence for a retry. */
export const REWORK_STARTUP_WINDOW_MS = 120_000;
export const REWORK_STARTUP_RETRY_LIMIT = 2;

/** Authoritative host proof. Missing/partial timelines and unknown tools fail closed. */
export interface StartupEvidence {
  archived: boolean;
  busy: boolean;
  generation: string | null;
  workspaceId: string | null;
  merged: boolean;
  pullRequestUrl?: string;
  timelineComplete: boolean;
  toolCalls: number;
}

export interface ReworkStartup {
  generation: string;
  pendingId: number;
  retry: number;
  from: "ready" | "rework";
  workspaceId: string;
  directory: string;
  replacement: ReworkReplacement;
  at: string;
}

export function recordReworkStartup(task: TaskRow, generation: string, from: string, directory: string, workspaceId: string | undefined,
  replacement: ReworkReplacement | null, actor: string): ReworkStartup | null {
  if (!replacement || task.workspace_kind !== "worktree" || !workspaceId || (from !== "ready" && from !== "rework")) return null;
  const pending = getDb().prepare("SELECT id, data_json FROM events WHERE task_id = ? AND kind = 'rework_reopen_pending' ORDER BY id DESC LIMIT 1")
    .get(task.id) as { id: number; data_json: string } | undefined;
  if (!pending) return null;
  let prior: { startupRetryRoot?: number; startupRetryCount?: number } = {};
  try {
    const value: unknown = JSON.parse(pending.data_json);
    if (value && typeof value === "object") prior = value;
  } catch { /* The pending marker still authorizes dispatch. */ }
  const startup: ReworkStartup = { generation, pendingId: prior.startupRetryRoot ?? pending.id, retry: prior.startupRetryCount ?? 0,
    from, workspaceId, directory, replacement, at: new Date().toISOString() };
  appendEvent(task.id, "rework_startup", null, null, actor, { ...startup }, startup.at);
  return startup;
}

function latestStartup(taskId: number): ReworkStartup | null {
  const row = getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'rework_startup' ORDER BY id DESC LIMIT 1")
    .get(taskId) as { data_json: string } | undefined;
  try { return row ? JSON.parse(row.data_json) as ReworkStartup : null; } catch { return null; }
}

/** Reconcile must leave an in-flight create to its start claim, including during the host archive RPC. */
export function reworkStartupInFlight(taskId: number, now = Date.now()): boolean {
  const startup = latestStartup(taskId);
  if (!startup) return false;
  const claim = getDb().prepare("SELECT token, pid, at FROM start_claims WHERE task_id = ?").get(taskId) as { token: string; pid: number; at: string } | undefined;
  if (!claim || claim.token !== startup.generation || now - Date.parse(claim.at) >= START_CLAIM_TTL_MS) return false;
  try { process.kill(claim.pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code !== "ESRCH"; }
}

/**
 * Only a newly opened rework executor with complete zero-tool evidence may return to pending.
 * The durable generation, binding, timestamp and pending root are checked again under a write lock after every host await.
 */
export async function recoverReworkStartup(task: TaskRow, launcher: AgentLauncher, options: {
  startup?: ReworkStartup | null; agentId?: string; now?: number; actor?: string; claimToken?: string;
} = {}): Promise<"unhandled" | "stale" | "retry" | "blocked"> {
  const startup = options.startup ?? latestStartup(task.id);
  if (!startup || !["running", "reviewing", "ready"].includes(task.status)) return "unhandled";
  if (options.startup && task.status === "ready") return "stale";
  let agentId = options.agentId ?? task.agent_id;
  if (task.status === "ready" && !options.startup) {
    // A canceled-turn hook may win the race with reconcile. Do not let that path bypass the same safety proof.
    const reclaimed = getDb().prepare(`SELECT id, json_extract(data_json, '$.agentId') AS agentId FROM events
      WHERE task_id = ? AND kind = 'reclaimed' ORDER BY id DESC LIMIT 1`).get(task.id) as { id: number; agentId: string | null } | undefined;
    const opened = getDb().prepare(`SELECT id FROM events WHERE task_id = ? AND kind = 'rework_startup_agent'
      AND json_extract(data_json, '$.generation') = ? AND json_extract(data_json, '$.agentId') = ? ORDER BY id DESC LIMIT 1`)
      .get(task.id, startup.generation, reclaimed?.agentId ?? null) as { id: number } | undefined;
    const newPending = opened && getDb().prepare("SELECT 1 FROM events WHERE task_id = ? AND kind = 'rework_reopen_pending' AND id > ? LIMIT 1").get(task.id, opened.id);
    if (!opened || !reclaimed?.agentId || reclaimed.id <= opened.id || newPending) return "unhandled";
    agentId = reclaimed.agentId;
    const fate = await workspaceFateReader(launcher)(task);
    if (fate === "live" && !worktreeDirectoryLost({ directory: startup.directory })) return "unhandled";
  }
  if (!agentId) return "unhandled";
  if (!options.startup) {
    const last = getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind IN ('started', 'resumed') ORDER BY id DESC LIMIT 1")
      .get(task.id) as { data_json: string } | undefined;
    const data = last ? JSON.parse(last.data_json) as { agentId?: string; startupGeneration?: string } : null;
    if (data?.agentId !== agentId || data?.startupGeneration !== startup.generation) return "unhandled";
  }
  const opened = getDb().prepare(`SELECT json_extract(data_json, '$.workspaceId') AS workspaceId FROM events WHERE task_id = ? AND kind = 'rework_startup_agent'
    AND json_extract(data_json, '$.generation') = ? AND json_extract(data_json, '$.agentId') = ? LIMIT 1`).get(task.id, startup.generation, agentId) as { workspaceId: string | null } | undefined;
  if (!opened) return "unhandled";
  const actor = options.actor ?? "scheduler";
  const missing: string[] = [];
  if (opened.workspaceId !== startup.workspaceId) missing.push("matching create binding");
  const saved = readWorktreeCreated(task.id);
  const others = getDb().prepare("SELECT workspace_path FROM tasks WHERE id != ? AND status NOT IN ('done', 'archived')").all(task.id) as Array<{ workspace_path: string | null }>;
  if (task.workspace_kind !== "worktree" || !["executor", "batch"].includes(task.role) || !saved?.branch || saved.readOnly ||
    !saved.root || samePath(saved.root, startup.directory) || !branchOwnedByCard(task.id, saved.branch) ||
    !samePath(saved.directory, startup.directory) || saved.workspaceId !== startup.workspaceId ||
    others.some(other => samePath(other.workspace_path, startup.directory))) missing.push("exclusive card-owned worktree");
  const age = (options.now ?? Date.now()) - Date.parse(startup.at);
  if (!Number.isFinite(age) || age < 0 || age > REWORK_STARTUP_WINDOW_MS) missing.push("startup window");
  if (startup.retry >= REWORK_STARTUP_RETRY_LIMIT) missing.push("retry budget exhausted");
  let evidence: StartupEvidence | null = null;
  if (missing.length === 0) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      evidence = await Promise.race([
        launcher.inspectStartup?.(agentId, startup.workspaceId) ?? Promise.resolve(null),
        new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 5_000); }),
      ]);
    } catch { /* Unavailable proof is not permission to repeat external work. */ }
    finally { clearTimeout(timer); }
    if (!evidence?.archived || evidence.busy) missing.push("authoritative archived and stopped agent");
    if (evidence?.generation !== startup.generation || evidence?.workspaceId !== startup.workspaceId) missing.push("matching host generation/workspace");
    if (!evidence?.merged || !evidence.pullRequestUrl) missing.push("host merge archive");
    if (!evidence?.timelineComplete || evidence.toolCalls !== 0) missing.push("complete timeline with zero tool calls");
  }
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    const fresh = getTask(task.id);
    const claim = db.prepare("SELECT token FROM start_claims WHERE task_id = ?").get(task.id) as { token: string } | undefined;
    const currentCopy = readWorktreeCreated(task.id);
    if (fresh.status !== task.status || fresh.agent_id !== task.agent_id || fresh.executor_agent_id !== task.executor_agent_id ||
      fresh.paseo_workspace_id !== task.paseo_workspace_id || fresh.workspace_path !== task.workspace_path || fresh.workspace_kind !== task.workspace_kind || fresh.updated_at !== task.updated_at ||
      currentCopy?.directory !== saved?.directory || currentCopy?.branch !== saved?.branch || currentCopy?.workspaceId !== saved?.workspaceId ||
      (claim && claim.token !== (options.claimToken ?? startup.generation)) ||
      latestStartup(task.id)?.generation !== startup.generation) {
      db.exec("ROLLBACK");
      return "stale";
    }
    const shared = db.prepare("SELECT workspace_path FROM tasks WHERE id != ? AND status NOT IN ('done', 'archived')").all(task.id) as Array<{ workspace_path: string | null }>;
    if (shared.some(other => samePath(other.workspace_path, startup.directory))) missing.push("worktree became shared during proof lookup");
    if (missing.length > 0) {
      const recoverableRef = saved?.branch ?? "unrecorded";
      const detail = `Startup recovery refused: ${missing.join("; ")}. Recoverable branch/ref: ${recoverableRef}${saved?.head ? ` (${saved.head})` : ""}.`;
      blockTask(task.id, "needs_human", `${t("schedule.lostWorkspace.reason")} ${detail}`, actor, {
        cause: "host_workspace_or_agent_lost", workspaceId: startup.workspaceId, agentId,
        startupGeneration: startup.generation, missingFacts: missing, recoverableRef,
      });
      db.exec("COMMIT");
      return "blocked";
    }
    const at = new Date().toISOString();
    const changed = db.prepare(`UPDATE tasks SET status = ?, agent_id = NULL,
      executor_agent_id = CASE WHEN executor_agent_id = ? THEN NULL ELSE executor_agent_id END,
      hold_reason = NULL, nudge_count = 0, updated_at = ? WHERE id = ? AND status = ?
      AND agent_id IS ? AND paseo_workspace_id IS ? AND updated_at = ?`)
      .run(startup.from, agentId, at, task.id, task.status, task.agent_id, task.paseo_workspace_id, task.updated_at);
    if (changed.changes !== 1) { db.exec("ROLLBACK"); return "stale"; }
    db.prepare("UPDATE runs SET ended_at = ?, end_kind = 'startup_archived' WHERE task_id = ? AND agent_id = ? AND ended_at IS NULL").run(at, task.id, agentId);
    revokeAgentToken(agentId);
    appendEvent(task.id, "rework_startup_retry", task.status, startup.from, actor, {
      generation: startup.generation, pendingId: startup.pendingId, retry: startup.retry + 1, agentId,
      workspaceId: startup.workspaceId, directory: startup.directory, recoverableRef: saved?.branch,
      evidence: { archived: true, merged: true, timelineComplete: true, toolCalls: 0, pullRequestUrl: evidence!.pullRequestUrl },
    });
    appendEvent(task.id, "rework_reopen_pending", null, null, actor, {
      ...startup.replacement, startupRetryRoot: startup.pendingId, startupRetryCount: startup.retry + 1,
    });
    db.exec("COMMIT");
  } catch (err) { try { db.exec("ROLLBACK"); } catch {} throw err; }
  requestAgentReleases(task.id, [{ agentId, role: "executor" }]);
  return "retry";
}

/**
 * Same gone set as reconcile. A live file is not enough when the host has
 * already archived the workspace the card is bound to.
 */
const GONE = new Set<AgentLiveness>(["closed", "error", "archived", "missing"]);

export type WorkspaceFate = "live" | "gone" | "unknown";

type WorkspaceView = Pick<AgentLauncher, "inspectWorkspace" | "listWorkspaces">;

/**
 * Whether the card's bound Paseo workspace is still usable.
 * No recorded id is not proof of an archive. An empty list, a thrown lookup,
 * or a launcher that cannot list workspaces stays unknown: the caller keeps
 * the existing lost-agent rule instead of guessing. Doctor stays read-only;
 * this is the scheduler's check, not a second scanner.
 */
export function workspaceFateReader(launcher: WorkspaceView): (task: Pick<TaskRow, "paseo_workspace_id">) => Promise<WorkspaceFate> {
  const byId = new Map<string, WorkspaceFate>();
  let listed: Promise<ListedWorkspace[] | null> | undefined;
  return async (task) => {
    const id = task.paseo_workspace_id?.trim() ?? "";
    if (!id) return "live";
    const cached = byId.get(id);
    if (cached) return cached;
    const fate = await readFate(id, launcher, () => {
      if (!listed) listed = loadList(launcher);
      return listed;
    });
    byId.set(id, fate);
    return fate;
  };
}

async function loadList(launcher: WorkspaceView): Promise<ListedWorkspace[] | null> {
  if (!launcher.listWorkspaces) return null;
  try {
    const rows = await launcher.listWorkspaces();
    return rows.length === 0 ? null : rows;
  } catch (err) {
    console.error("[paseo-kanban] lost workspace", err instanceof Error ? err.message : err);
    return null;
  }
}

async function readFate(id: string, launcher: WorkspaceView, list: () => Promise<ListedWorkspace[] | null>): Promise<WorkspaceFate> {
  if (launcher.inspectWorkspace) {
    try {
      const inspected = await launcher.inspectWorkspace(id);
      if (!inspected || inspected.archived) return "gone";
      return "live";
    } catch (err) {
      console.error("[paseo-kanban] lost workspace", err instanceof Error ? err.message : err);
      return "unknown";
    }
  }
  const listed = await list();
  if (!listed) return "unknown";
  const entry = listed.find((item) => item.id === id);
  if (!entry || entry.archived) return "gone";
  return "live";
}

/** Stop a running card whose workspace the host archived. A person hands the work in. */
export function blockLostWorkspace(task: TaskRow, liveness: AgentLiveness): TaskRow {
  const agentGone = !task.agent_id || GONE.has(liveness);
  const startup = latestStartup(task.id);
  const saved = startup ? readWorktreeCreated(task.id) : null;
  const detail = startup ? ` Startup recovery unavailable for the current run/generation. Recoverable branch/ref: ${saved?.branch ?? "unrecorded"}.` : "";
  return blockTask(task.id, "needs_human", t("schedule.lostWorkspace.reason") + detail, "scheduler", {
    cause: "host_workspace_or_agent_lost",
    workspaceId: task.paseo_workspace_id,
    agentId: task.agent_id,
    agentGone,
    ...(startup ? { startupGeneration: startup.generation, missingFacts: ["matching current startup agent/generation"], recoverableRef: saved?.branch ?? null } : {}),
  });
}
