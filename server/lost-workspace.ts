/// <reference types="node" />
import type { AgentLauncher } from "./dispatch";
import type { AgentLiveness } from "./open";
import type { ListedWorkspace } from "./placement";
import { blockTask } from "./task-lifecycle";
import type { TaskRow } from "./task-record";
import { t } from "../shared/i18n";

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
  return blockTask(task.id, "needs_human", t("schedule.lostWorkspace.reason"), "scheduler", {
    cause: "host_workspace_or_agent_lost",
    workspaceId: task.paseo_workspace_id,
    agentId: task.agent_id,
    agentGone,
  });
}
