/// <reference types="node" />
import { existsSync } from "./perf-fs";
import type { PaseoApi } from "@getpaseo/client";
import type { AgentSnapshot, CleanupOps } from "./cleanup";
import type { AgentLauncher } from "./dispatch";
import { KanbanError } from "./errors";
import { findAgentFile, readAgentRecord } from "./open";
import { endNoteFromTimeline } from "./login-blip";
import { lastAssistantText } from "./nudge";
import { activityFromSnapshot, advanceActivity, lastTimelineStamp, type AgentActivity } from "./stall";
import type { ListedWorkspace } from "./placement";
import { runGit } from "./git";
import { hookObjects } from "./hook-objects";
import { shouldInjectMcp } from "./inject";
import { t } from "../shared/i18n";

const PAGE = 200;

export interface AgentListItem {
  id: string;
  archived: boolean;
  workspaceId: string | null;
  labels?: Record<string, string>;
  createdAt?: string | null;
  cwd?: string | null;
  title?: string;
}

/** One workspace list page. Throws when the shape cannot be trusted, so callers do not treat it as empty. */
export function readWorkspacePage(result: unknown): { entries: ListedWorkspace[]; nextCursor: string | null } {
  if (!result || typeof result !== "object") throw new KanbanError("paseo_shape", t("paseo.shape.workspaceListNotObject"));
  const page = result as { entries?: unknown; pageInfo?: unknown };
  if (!Array.isArray(page.entries)) throw new KanbanError("paseo_shape", t("paseo.shape.workspaceListNoEntries"));
  if (!page.pageInfo || typeof page.pageInfo !== "object" || !("nextCursor" in page.pageInfo)) {
    throw new KanbanError("paseo_shape", t("paseo.shape.workspaceListNoCursor"));
  }
  const next = (page.pageInfo as { nextCursor?: unknown }).nextCursor;
  if (next !== null && (typeof next !== "string" || !next)) throw new KanbanError("paseo_shape", t("paseo.shape.cursorNotString"));
  return { entries: page.entries.map((entry) => listedFromChecked(entry)), nextCursor: typeof next === "string" ? next : null };
}

function listedFromChecked(entry: unknown): ListedWorkspace {
  if (!entry || typeof entry !== "object") throw new KanbanError("paseo_shape", t("paseo.shape.workspaceEntryNotObject"));
  const row = entry as Record<string, unknown>;
  if (typeof row.id !== "string" || !row.id) throw new KanbanError("paseo_shape", t("paseo.shape.workspaceNoId"));
  if (typeof row.workspaceKind !== "string" || !row.workspaceKind) {
    throw new KanbanError("paseo_shape", t("paseo.shape.workspaceNoKind", { id: row.id }));
  }
  if (!("archivingAt" in row) || (row.archivingAt != null && typeof row.archivingAt !== "string")) {
    throw new KanbanError("paseo_shape", t("paseo.shape.workspaceNoArchivingAt", { id: row.id }));
  }
  if (typeof row.projectRootPath !== "string") throw new KanbanError("paseo_shape", t("paseo.shape.workspaceNoRoot", { id: row.id }));
  const title = typeof row.title === "string" ? row.title.trim() : "";
  const name = typeof row.name === "string" ? row.name : "";
  return {
    id: row.id,
    name: title || name || null,
    directory: typeof row.workspaceDirectory === "string" ? row.workspaceDirectory : null,
    projectRoot: row.projectRootPath,
    projectId: typeof row.projectId === "string" ? row.projectId : null,
    kind: row.workspaceKind,
    archived: Boolean(row.archivingAt),
    pinned: Boolean(row.pinnedAt),
  };
}

/** One agent list page. A missing archivedAt is an error, not "already archived". */
export function readAgentPage(result: unknown): { agents: AgentListItem[]; nextCursor: string | null } {
  if (!result || typeof result !== "object") throw new KanbanError("paseo_shape", t("paseo.shape.agentListNotObject"));
  const page = result as { entries?: unknown; pageInfo?: unknown };
  if (!Array.isArray(page.entries)) throw new KanbanError("paseo_shape", t("paseo.shape.agentListNoEntries"));
  if (!page.pageInfo || typeof page.pageInfo !== "object" || !("nextCursor" in page.pageInfo)) {
    throw new KanbanError("paseo_shape", t("paseo.shape.agentListNoCursor"));
  }
  const next = (page.pageInfo as { nextCursor?: unknown }).nextCursor;
  if (next != null && typeof next !== "string") throw new KanbanError("paseo_shape", t("paseo.shape.agentListCursorNotString"));
  const nextCursor = typeof next === "string" ? next : null;
  const agents: AgentListItem[] = [];
  for (const entry of page.entries) {
    if (!entry || typeof entry !== "object" || !("agent" in entry)) throw new KanbanError("paseo_shape", t("paseo.shape.agentEntryNoAgent"));
    const agent = (entry as { agent?: unknown }).agent;
    if (!agent || typeof agent !== "object") throw new KanbanError("paseo_shape", t("paseo.shape.agentEntryNoAgent"));
    const row = agent as Record<string, unknown>;
    if (typeof row.id !== "string" || !row.id) throw new KanbanError("paseo_shape", t("paseo.shape.agentNoId"));
    if (!("archivedAt" in row) || (row.archivedAt != null && typeof row.archivedAt !== "string")) {
      throw new KanbanError("paseo_shape", t("paseo.shape.agentNoArchivedAt", { id: row.id }));
    }
    if (row.workspaceId != null && typeof row.workspaceId !== "string") {
      throw new KanbanError("paseo_shape", t("paseo.shape.agentBadWorkspaceId", { id: row.id }));
    }
    agents.push({
      id: row.id,
      archived: Boolean(row.archivedAt),
      workspaceId: typeof row.workspaceId === "string" ? row.workspaceId : null,
      labels: row.labels && typeof row.labels === "object" && !Array.isArray(row.labels)
        ? Object.fromEntries(Object.entries(row.labels).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
        : undefined,
      createdAt: typeof row.createdAt === "string" ? row.createdAt : null,
      cwd: typeof row.cwd === "string" ? row.cwd : null,
      title: typeof row.title === "string" ? row.title : "",
    });
  }
  return { agents, nextCursor };
}

async function eachPage<T>(load: (cursor: string | undefined) => Promise<{ items: T[]; nextCursor: string | null }>, label: string): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 50; page += 1) {
    const parsed = await load(cursor);
    items.push(...parsed.items);
    if (!parsed.nextCursor) return items;
    if (parsed.nextCursor === cursor) throw new KanbanError("paseo_shape", t("paseo.shape.cursorStuck", { label }));
    cursor = parsed.nextCursor;
  }
  throw new KanbanError("paseo_shape", t("paseo.shape.tooManyPages", { label }));
}

export async function listPaseoWorkspaces(paseo: PaseoApi): Promise<ListedWorkspace[]> {
  return eachPage(async (cursor) => {
    const result = await paseo.workspaces.list({ page: { limit: PAGE, ...(cursor ? { cursor } : {}) } });
    const parsed = readWorkspacePage(result);
    return { items: parsed.entries, nextCursor: parsed.nextCursor };
  }, t("paseo.list.workspaces"));
}

/**
 * The daemon caches a per-directory git snapshot. A directory registered before
 * `git init` keeps `isGit: false`, and worktree creation then fails with this text
 * until something forces a refresh. Registering the same directory again is the
 * official forced refresh (open_project), but it can add a duplicate local workspace.
 */
const STALE_NON_GIT = /requires a git repository/i;

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function refreshStaleGitSnapshot(paseo: PaseoApi, cwd: string): Promise<void> {
  const before = new Set((await listPaseoWorkspaces(paseo)).map((entry) => entry.id));
  const handle = await paseo.workspaces.create({ source: { kind: "directory", path: cwd } });
  if (before.has(handle.id)) return;
  await paseo.workspaces.archive(handle.id).catch((err) => {
    console.error(`[kanban] refreshing the git snapshot registered an extra workspace ${handle.id}; archiving it failed: ${errorText(err)}`);
  });
}

/** The daemon writes the refreshed snapshot back in the background, so wait for it. */
const SNAPSHOT_RETRY_DELAYS_MS = [250, 500, 1000, 2000, 4000, 8000];
export const snapshotRetryDelays = { value: SNAPSHOT_RETRY_DELAYS_MS };

async function createWorktreeAfterRefresh(
  paseo: PaseoApi,
  request: Parameters<PaseoApi["workspaces"]["create"]>[0],
  firstError: unknown,
) {
  let lastError = firstError;
  for (const delay of snapshotRetryDelays.value) {
    await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      return await paseo.workspaces.create(request);
    } catch (err) {
      if (!STALE_NON_GIT.test(errorText(err))) throw err;
      lastError = err;
    }
  }
  throw lastError;
}

async function snapshotWorkspace(paseo: PaseoApi, workspaceId: string): Promise<ListedWorkspace | null> {
  const handle = paseo.workspaces.ref(workspaceId);
  const current = handle.current() ?? (await handle.refresh());
  if (!current) return null;
  return listedFromChecked(current);
}

/**
 * Agents are created inside an existing workspace id.
 * `agents.create({ cwd })` without that id opens the cwd as a project. That is how
 * the worktree directory `kanban-9-m3-worktree-readme` became its own Paseo project:
 * the worktree itself stayed under the parent project, then the agent was started
 * with the worktree path as cwd and no workspaceId.
 */
function snapshotFrom(agent: { archivedAt?: string | null; status?: string | null; activeTurn?: unknown }): AgentSnapshot {
  const turn = agent.activeTurn;
  const busy = agent.status === "running" || (turn != null && typeof turn === "object");
  return { archived: Boolean(agent.archivedAt), busy };
}

export interface PaseoAgentView {
  status: string | null;
  archivedAt: string | null;
  activeTurn: unknown;
}

/**
 * One snapshot from the daemon. "absent" means the daemon answered and has no such agent.
 * Throws when the daemon cannot be asked; callers then fall back to the record file.
 */
export async function askPaseoAgent(paseo: PaseoApi, agentId: string): Promise<PaseoAgentView | "absent"> {
  const handle = paseo.agents.ref(agentId);
  const refreshed = await handle.refresh();
  const agent = refreshed?.agent ?? handle.current();
  if (!agent) return "absent";
  return {
    status: typeof agent.status === "string" ? agent.status : null,
    archivedAt: typeof agent.archivedAt === "string" ? agent.archivedAt : null,
    activeTurn: agent.activeTurn ?? null,
  };
}

/** Live agent clock. A failure here is unknown, not idle and not gone. */
export async function readAgentActivity(paseo: PaseoApi, agentId: string): Promise<AgentActivity> {
  let activity: AgentActivity = { state: "unknown" };
  let cwd = "";
  try {
    const handle = paseo.agents.ref(agentId);
    const refreshed = await handle.refresh();
    const agent = refreshed?.agent ?? handle.current();
    if (agent) {
      activity = activityFromSnapshot(agent);
      if (typeof agent.cwd === "string") cwd = agent.cwd;
    }
  } catch (err) {
    console.error("[paseo-kanban] stall", err instanceof Error ? err.message : err);
  }
  if (!activity.lastAt || activity.state === "idle" || activity.state === "archived" || activity.state === "unknown") {
    const file = findAgentFile(agentId);
    if (file) {
      const fromFile = activityFromSnapshot({
        status: file.lastStatus,
        archivedAt: file.archivedAt,
        updatedAt: file.updatedAt,
        lastActivityAt: file.lastActivityAt,
        attentionReason: file.attentionReason,
        attentionTimestamp: file.attentionTimestamp,
      });
      if (activity.state === "unknown") activity = fromFile;
      else activity = advanceActivity(activity, fromFile.lastAt);
      if (!cwd) cwd = file.cwd;
    }
  }
  if (cwd && existsSync(cwd) && (!activity.lastAt || activity.state === "idle" || activity.state === "archived")) {
    try {
      const page = await paseo.agents.ref(agentId).timeline.refetch({ direction: "tail", limit: 20 });
      activity = advanceActivity(activity, lastTimelineStamp(page?.entries));
      const text = lastAssistantText(page?.entries);
      if (text) activity = { ...activity, lastAssistant: text };
    } catch (err) {
      console.error("[paseo-kanban] stall", err instanceof Error ? err.message : err);
    }
  }
  return activity;
}

/**
 * End reason when the turn event did not carry one.
 * Reads the agent snapshot `lastError`, then the timeline tail, then the agent record's `lastError`.
 * Null means none of those had text. Callers must not invent a reason.
 */
export async function readAgentEndNote(paseo: PaseoApi, agentId: string): Promise<string | null> {
  const parts: string[] = [];
  try {
    const handle = paseo.agents.ref(agentId);
    const refreshed = await handle.refresh();
    const agent = refreshed?.agent ?? handle.current();
    const lastError = agent && typeof (agent as { lastError?: unknown }).lastError === "string" ? (agent as { lastError: string }).lastError.trim() : "";
    if (lastError) parts.push(lastError);
    try {
      const page = await handle.timeline.refetch({ direction: "tail", limit: 20 });
      const text = endNoteFromTimeline(page?.entries);
      if (text) parts.push(text);
    } catch (err) {
      console.error("[paseo-kanban] login", err instanceof Error ? err.message : err);
    }
  } catch (err) {
    console.error("[paseo-kanban] login", err instanceof Error ? err.message : err);
  }
  const file = findAgentFile(agentId);
  if (file?.lastError) parts.push(file.lastError);
  const note = parts.join("\n").trim();
  return note || null;
}

/** Paseo 0.10.1 throws this when the daemon has no such agent. It does not return a null agent. */
export function daemonAgentMissing(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /^Agent not found\b/.test(message);
}

async function inspectPaseoAgent(paseo: PaseoApi, agentId: string): Promise<AgentSnapshot | null> {
  try {
    const handle = paseo.agents.ref(agentId);
    const refreshed = await handle.refresh();
    const agent = refreshed?.agent ?? handle.current();
    if (agent) return snapshotFrom(agent);
  } catch (err) {
    // "Agent not found" means the daemon has no such agent. A timeout or a dropped
    // connection is not that answer. A leftover file that looks idle must not turn
    // the failure into "safe to delete".
    if (!daemonAgentMissing(err)) {
      console.error("[paseo-kanban] inspect agent", err instanceof Error ? err.message : err);
      throw new Error(t("paseo.agent.lookupFailed"));
    }
  }
  return snapshotFromRecord(agentId);
}

/**
 * What the agent record says. Null means the record is really absent. An unreadable record or
 * root is a failed lookup, not "gone": a half-written file must not settle an agent as purged.
 */
export function snapshotFromRecord(agentId: string): AgentSnapshot | null {
  const read = readAgentRecord(agentId);
  if (read.state === "unreadable") throw new Error(t("paseo.agent.lookupFailed"));
  if (read.state === "missing") return null;
  return { archived: Boolean(read.file.archivedAt), busy: read.file.lastStatus === "running" };
}

export function cleanupOps(paseo: PaseoApi): CleanupOps {
  const launcher = launcherFrom(paseo);
  return {
    archiveAgent: (agentId) => launcher.archiveAgent?.(agentId) ?? Promise.resolve(),
    archiveWorkspace: (workspaceId) => launcher.archiveWorkspace?.(workspaceId) ?? Promise.resolve(),
    listAgents: (workspaceId) => launcher.listAgents?.(workspaceId) ?? Promise.resolve([]),
    inspectWorkspace: (workspaceId) => launcher.inspectWorkspace?.(workspaceId) ?? Promise.resolve(null),
    listWorkspaceIds: async () => new Set((await listPaseoWorkspaces(paseo)).map(workspace => workspace.id)),
    inspectAgent: (agentId) => inspectPaseoAgent(paseo, agentId),
  };
}

export function launcherFrom(paseo: PaseoApi, beforeStart?: () => Promise<void>): AgentLauncher {
  return {
    ...(beforeStart ? { beforeStart } : {}),
    async create(options) {
      if (options.workspaceId) {
        const handle = await paseo.workspaces.ref(options.workspaceId).agents.create({
          title: options.title,
          prompt: options.prompt,
          labels: options.labels,
          env: options.env,
          config: options.config,
        });
        if (shouldInjectMcp(options)) hookObjects.rememberAgent(handle.id);
        return { id: handle.id, workspaceId: handle.workspaceId ?? options.workspaceId };
      }
      const handle = await paseo.agents.create({
        cwd: options.cwd,
        title: options.title,
        prompt: options.prompt,
        labels: options.labels,
        env: options.env,
        config: options.config,
      });
      if (shouldInjectMcp(options)) hookObjects.rememberAgent(handle.id);
      return { id: handle.id, workspaceId: handle.workspaceId };
    },
    send(agentId, text) {
      return paseo.agents.ref(agentId).send(text);
    },
    listWorkspaces() {
      return listPaseoWorkspaces(paseo);
    },
    async createDirectoryWorkspace(options) {
      const handle = await paseo.workspaces.create({ source: { kind: "directory", path: options.cwd } });
      hookObjects.rememberWorkspace(handle.id);
      const snapshot = handle.current() ?? (await handle.refresh());
      const directory = snapshot?.workspaceDirectory ?? handle.directory ?? options.cwd;
      return { id: handle.id, directory, name: snapshot?.title?.trim() || snapshot?.name || handle.name };
    },
    async createWorktree(options) {
      const request = {
        ...(options.title ? { title: options.title } : {}),
        source: {
          kind: "worktree" as const,
          cwd: options.cwd,
          action: "branch-off" as const,
          baseBranch: options.baseBranch,
          branchName: options.branchName,
          ...(options.projectId ? { projectId: options.projectId } : {}),
          ...(options.worktreeSlug ? { worktreeSlug: options.worktreeSlug } : {}),
        },
      };
      let handle;
      try {
        handle = await paseo.workspaces.create(request);
      } catch (err) {
        if (!STALE_NON_GIT.test(errorText(err))) throw err;
        await refreshStaleGitSnapshot(paseo, options.cwd);
        handle = await createWorktreeAfterRefresh(paseo, request, err);
      }
      hookObjects.rememberWorkspace(handle.id);
      const snapshot = handle.current() ?? (await handle.refresh());
      if (options.projectId && snapshot?.projectId && snapshot.projectId !== options.projectId) {
        await handle.archive().catch(() => undefined);
        throw new KanbanError("workspace_missing", t("paseo.worktree.wrongProject"));
      }
      const directory = snapshot?.workspaceDirectory ?? handle.directory;
      if (!directory) throw new KanbanError("workspace_missing", t("paseo.worktree.noDirectory"));
      const head = options.readOnly ? await runGit(directory, ["rev-parse", "HEAD"]) : null;
      return {
        directory,
        workspaceId: handle.id,
        name: snapshot?.title?.trim() || snapshot?.name || handle.name,
        ...(head?.code === 0 ? { head: head.stdout.trim() } : {}),
      };
    },
    archiveAgent(agentId) {
      return paseo.agents.ref(agentId).archive().then(() => undefined);
    },
    async inspectAgent(agentId) {
      try {
        const view = await askPaseoAgent(paseo, agentId);
        return view === "absent" ? null : { archived: Boolean(view.archivedAt) };
      } catch (err) {
        if (daemonAgentMissing(err)) return null;
        throw err;
      }
    },
    archiveWorkspace(workspaceId) {
      return paseo.workspaces.archive(workspaceId).then(() => undefined);
    },
    async listAgents(workspaceId) {
      const agents = await listActivePaseoAgents(paseo);
      return agents.filter((agent) => agent.workspaceId === workspaceId).map(({ id, archived }) => ({ id, archived }));
    },
    inspectWorkspace(workspaceId) {
      return snapshotWorkspace(paseo, workspaceId);
    },
    listModels(provider) {
      return paseo.providers.listModels(provider);
    },
  };
}

/** Active agents across workspaces. Read-only: this does not archive. */
export async function listActivePaseoAgents(paseo: PaseoApi): Promise<AgentListItem[]> {
  return eachPage(async (cursor) => {
    const result = await paseo.agents.list({
      scope: "active",
      page: { limit: PAGE, ...(cursor ? { cursor } : {}) },
    });
    const parsed = readAgentPage(result);
    return { items: parsed.agents, nextCursor: parsed.nextCursor };
  }, t("paseo.list.agents"));
}

export function auditView(paseo: PaseoApi): {
  listActiveAgents(): Promise<Array<{ id: string; archived: boolean; workspaceId: string | null }>>;
  inspectWorkspace(workspaceId: string): Promise<ListedWorkspace | null>;
} {
  return {
    listActiveAgents: () => listActivePaseoAgents(paseo),
    inspectWorkspace: (workspaceId) => snapshotWorkspace(paseo, workspaceId),
  };
}
