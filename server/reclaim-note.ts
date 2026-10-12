/// <reference types="node" />
import type { PaseoApi } from "@getpaseo/client";
import { getDb } from "./db";
import { shellActions } from "./reclaim-actions";
import { t } from "../shared/i18n";

/**
 * DEMO_0001: a reclaimed agent may already have done things that must not happen twice (push, merge a PR,
 * close an issue, write a database, send a message). Paseo's auto-archive-on-merge archives the agents of a
 * worktree whose branch's PR merged, so a merge card's agent is taken seconds after its own `gh pr merge`.
 * The board keeps what it saw of that agent and tells the next agent before it starts.
 */

/**
 * What the reclaimed agent was last seen doing on its Paseo timeline. Raw commands and messages can hold
 * credentials, so only recognised operations, rebuilt from an allowlist (reclaim-actions.ts), are kept.
 */
export interface ReclaimTrail {
  /** Last recognised operations (push, merge a PR, close an issue, a database or deploy tool), oldest first, with their result. */
  actions: string[];
  /** Shell commands in the same window with no recognised operation. Counted, never stored. */
  otherCommands: number;
}

/** The agent's workspace as Paseo described it when the agent was archived. */
export interface ReclaimWorkspace {
  id: string;
  /** Paseo had marked the workspace archiving (archivingAt): the agent went with its workspace. */
  archiving: boolean;
  /** The PR Paseo tracks for the directory's current branch. A merged one is what auto-archive-on-merge acts on. */
  pullRequest?: { url: string; number?: number; headRefName?: string; merged: boolean };
}

export interface ReclaimEvidence {
  fileState?: string;
  apiState?: string;
  /** Which path reclaimed: turn_canceled (Paseo closed the agent mid-turn), agent.archived, or the scheduler's reconcile. */
  source?: string;
  /** `outcome.reason` of the canceled turn, e.g. Paseo's "agent closed". */
  cancelReason?: string;
  trail?: ReclaimTrail;
  workspace?: ReclaimWorkspace;
}

const TRAIL_TIMELINE_LIMIT = 60;
const TRAIL_ACTIONS = 10;
export const TRAIL_TIMEOUT_MS = 5_000;

function unwrap(entry: unknown): Record<string, unknown> | null {
  const item = entry && typeof entry === "object" && "item" in entry ? (entry as { item: unknown }).item : entry;
  return item && typeof item === "object" ? (item as Record<string, unknown>) : null;
}

/** The recognised operations of one shell tool call, each with the call's result. Null when it is not a shell call. */
function shellCallActions(item: Record<string, unknown>): string[] | null {
  if (item.type !== "tool_call") return null;
  const detail = item.detail as { type?: unknown; command?: unknown; exitCode?: unknown } | undefined;
  if (detail?.type !== "shell" || typeof detail.command !== "string" || !detail.command.trim()) return null;
  const status = typeof item.status === "string" ? item.status : "";
  const result =
    typeof detail.exitCode === "number"
      ? t("reclaimNote.result.exit", { code: detail.exitCode })
      : status === "running"
        ? t("reclaimNote.result.running")
        : status === "failed"
          ? t("reclaimNote.result.failed")
          : t("reclaimNote.result.unknown");
  return shellActions(detail.command).map((action) => `${action}${t("common.paren", { text: result })}`);
}

/** Recognised operations from a timeline page (items or `{ item }` rows, oldest first). Assistant text is not kept. */
export function trailFromTimeline(entries: unknown): ReclaimTrail | null {
  if (!Array.isArray(entries)) return null;
  const actions: string[] = [];
  let otherCommands = 0;
  for (const entry of entries) {
    const item = unwrap(entry);
    const found = item ? shellCallActions(item) : null;
    if (!found) continue;
    if (found.length === 0) otherCommands += 1;
    actions.push(...found);
  }
  if (actions.length === 0 && otherCommands === 0) return null;
  return { actions: actions.slice(-TRAIL_ACTIONS), otherCommands };
}

/** Tail of an agent's timeline. Paseo keeps an archived agent's timeline until the agent is deleted. */
async function readTrail(paseo: PaseoApi, agentId: string): Promise<ReclaimTrail | null> {
  try {
    const page = await paseo.agents.ref(agentId).timeline.refetch({ direction: "tail", limit: TRAIL_TIMELINE_LIMIT });
    return trailFromTimeline((page as { entries?: unknown } | undefined)?.entries);
  } catch (err) {
    console.error("[paseo-kanban] reclaim trail", err instanceof Error ? err.message : err);
    return null;
  }
}

/** archivingAt and the tracked PR from a Paseo workspace descriptor. Unknown shapes give null. */
export function workspaceFromDescriptor(id: string, descriptor: unknown): ReclaimWorkspace | null {
  if (!descriptor || typeof descriptor !== "object") return null;
  const record = descriptor as { archivingAt?: unknown; githubRuntime?: { pullRequest?: unknown } | null };
  const pr = record.githubRuntime?.pullRequest as { url?: unknown; number?: unknown; headRefName?: unknown; isMerged?: unknown } | null | undefined;
  const workspace: ReclaimWorkspace = { id, archiving: typeof record.archivingAt === "string" && record.archivingAt !== "" };
  if (pr && typeof pr.url === "string" && pr.url) {
    workspace.pullRequest = {
      url: pr.url,
      ...(typeof pr.number === "number" ? { number: pr.number } : {}),
      ...(typeof pr.headRefName === "string" && pr.headRefName ? { headRefName: pr.headRefName } : {}),
      merged: pr.isMerged === true,
    };
  }
  return workspace;
}

async function readWorkspace(paseo: PaseoApi, workspaceId: string): Promise<ReclaimWorkspace | null> {
  try {
    return workspaceFromDescriptor(workspaceId, await paseo.workspaces.ref(workspaceId).refresh());
  } catch (err) {
    console.error("[paseo-kanban] reclaim workspace", err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * What a reclaim records about the departing agent: its last recognised operations (from the ended turn's timeline when the
 * event carried one, else the tail Paseo still keeps) and, when the agent named a workspace, whether Paseo was
 * archiving it and which PR it tracked. Bounded: a slow daemon must not hold the reclaim; a failed or late read
 * is just missing evidence.
 */
export async function readReclaimContext(
  paseo: PaseoApi,
  agentId: string,
  workspaceId: string | null | undefined,
  options: { timeline?: unknown; timeoutMs?: number } = {},
): Promise<Pick<ReclaimEvidence, "trail" | "workspace">> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), options.timeoutMs ?? TRAIL_TIMEOUT_MS);
  });
  const bounded = <T>(read: Promise<T>) => Promise.race([read, timeout]);
  const carried = trailFromTimeline(options.timeline);
  try {
    const [trail, workspace] = await Promise.all([
      carried ? Promise.resolve(carried) : bounded(readTrail(paseo, agentId)).then((read) => read ?? carried),
      workspaceId ? bounded(readWorkspace(paseo, workspaceId)) : Promise.resolve(null),
    ]);
    return { ...(trail ? { trail } : {}), ...(workspace ? { workspace } : {}) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

interface ReclaimedRun {
  agentId: string;
  profile: string | null;
  startedAt: string;
  endedAt: string;
}

interface EventRow {
  id: number;
  at: string;
  kind: string;
  data_json: string;
}

function parse(raw: string): Record<string, unknown> {
  try {
    const data = JSON.parse(raw) as unknown;
    return data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The latest finished run of this role, when it ended because the board reclaimed it. */
function lastReclaimedRun(taskId: number, role: string): ReclaimedRun | null {
  const row = getDb()
    .prepare(
      `SELECT agent_id, profile_name, started_at, ended_at, end_kind FROM runs
       WHERE task_id = ? AND role = ? AND ended_at IS NOT NULL ORDER BY id DESC LIMIT 1`,
    )
    .get(taskId, role) as { agent_id: string | null; profile_name: string | null; started_at: string; ended_at: string; end_kind: string | null } | undefined;
  if (!row || row.end_kind !== "reclaimed" || !row.agent_id) return null;
  return { agentId: row.agent_id, profile: row.profile_name, startedAt: row.started_at, endedAt: row.ended_at };
}

function causeLine(evidence: Record<string, unknown>, workspaceTaken: boolean): string {
  const workspace = evidence.workspace as ReclaimWorkspace | undefined;
  const pr = workspace?.pullRequest;
  if (pr?.merged) {
    const branch = pr.headRefName ? t("reclaimNote.cause.branch", { branch: pr.headRefName }) : " ";
    return t("reclaimNote.cause.prMerged", { url: String(pr.url), branch });
  }
  if (workspaceTaken || workspace?.archiving) {
    return t("reclaimNote.cause.workspace");
  }
  if (evidence.source === "agent.archived" || evidence.apiState === "archived") return t("reclaimNote.cause.archived");
  if (evidence.source === "turn_canceled") return t("reclaimNote.cause.canceled");
  const states = [evidence.fileState, evidence.apiState].filter((value) => typeof value === "string" && value);
  return states.length > 0 ? t("reclaimNote.cause.goneStates", { states: states.join(t("reclaimNote.cause.stateSep")) }) : t("reclaimNote.cause.gone");
}

function branchLines(rows: EventRow[]): string[] {
  return rows
    .filter((row) => row.kind === "branch_observed")
    .map((row) => {
      const data = parse(row.data_json);
      const head = typeof data.head === "string" ? data.head.slice(0, 12) : "?";
      return t("reclaimNote.branch", { branch: String(data.branch ?? "?"), head, pushed: data.pushed === true ? t("reclaimNote.branch.pushed") : "" });
    });
}

/**
 * Prompt section for the agent that replaces a reclaimed one. Empty unless this role's latest finished run
 * was reclaimed. Lists the old agent, why it went, what the board saw it do, and asks for a check before acting.
 */
export function reclaimedAgentNote(taskId: number, role: string): string {
  const run = lastReclaimedRun(taskId, role);
  if (!run) return "";
  const rows = getDb()
    .prepare(
      `SELECT id, at, kind, data_json FROM events WHERE task_id = ? AND at >= ?
       AND kind IN ('reclaimed', 'branch_observed', 'paseo_workspace_archiving', 'temp_workspace_recreated') ORDER BY id`,
    )
    .all(taskId, run.startedAt) as unknown as EventRow[];
  const reclaim = [...rows].reverse().find((row) => row.kind === "reclaimed" && parse(row.data_json).agentId === run.agentId);
  const evidence = reclaim ? parse(reclaim.data_json) : {};
  const workspaceTaken = rows.some((row) => (row.kind === "paseo_workspace_archiving" || row.kind === "temp_workspace_recreated") && (!reclaim || row.id > reclaim.id));
  const lines = [
    t("reclaimNote.run", { agent: run.agentId, profile: run.profile ?? t("reclaimNote.profileUnknown"), startedAt: run.startedAt, endedAt: run.endedAt }),
    t("reclaimNote.cause", { cause: causeLine(evidence, workspaceTaken) }),
    ...branchLines(rows),
  ];
  const trail = evidence.trail as Partial<ReclaimTrail> | undefined;
  const actions = Array.isArray(trail?.actions) ? trail.actions.filter((action): action is string => typeof action === "string") : [];
  if (actions.length > 0) lines.push(t("reclaimNote.actions"), ...actions.map((action) => `- ${action}`));
  if (typeof trail?.otherCommands === "number" && trail.otherCommands > 0) lines.push(t("reclaimNote.otherCommands", { count: trail.otherCommands }));
  lines.push(
    t("reclaimNote.check"),
    t("reclaimNote.attribute", { agent: run.agentId }),
  );
  return `${t("reclaimNote.heading")}\n${lines.join("\n")}`;
}
