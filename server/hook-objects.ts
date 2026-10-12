import { shouldInjectMcp } from "./inject";
import { getDb } from "./db";

interface MarkedObject {
  id?: string;
  labels?: Record<string, string | undefined>;
  env?: Record<string, string>;
}

/** Labels are present on SDK lifecycle events, even though agent.create does not receive them. */
function isMarkedEvent(object: MarkedObject): boolean {
  const label = object.labels?.kanban;
  return shouldInjectMcp(object) || (label !== undefined && label !== "");
}

/** SDK lifecycle events omit labels/env. Track only known IDs, never infer from cwd/title/workspace. */
export class HookObjects {
  private agents = new Set<string>();
  private workspaces = new Set<string>();

  rememberAgent(id: string): void { this.agents.add(id); }
  rememberWorkspace(id: string): void { this.workspaces.add(id); }

  agent(agent: MarkedObject | undefined): boolean {
    return Boolean(agent && (isMarkedEvent(agent) || (agent.id && this.agents.has(agent.id))));
  }

  workspace(workspace: MarkedObject | undefined): boolean {
    return Boolean(workspace && (isMarkedEvent(workspace) || (workspace.id && this.workspaces.has(workspace.id))));
  }
}

export const hookObjects = new HookObjects();

/** Run at startup and on the scheduler timer, never from an unrelated lifecycle callback. */
export function refreshHookObjects(objects = hookObjects): void {
  const db = getDb();
  const agents = db.prepare("SELECT agent_id AS id FROM runs WHERE agent_id IS NOT NULL UNION SELECT agent_id AS id FROM tasks WHERE agent_id IS NOT NULL UNION SELECT executor_agent_id AS id FROM tasks WHERE executor_agent_id IS NOT NULL").all() as { id: string }[];
  const workspaces = db.prepare("SELECT DISTINCT paseo_workspace_id AS id FROM tasks WHERE paseo_workspace_id IS NOT NULL").all() as { id: string }[];
  for (const { id } of agents) objects.rememberAgent(id);
  for (const { id } of workspaces) objects.rememberWorkspace(id);
}

/** Background SDK subscription carries labels, including agents created by another CLI process. */
export function watchHookObjects(
  paseo: import("@getpaseo/client").PaseoApi,
  objects = hookObjects,
  log: (message: string) => void = () => {},
): () => void {
  let stopped = false;
  let release = () => {};
  const remember = (agent: MarkedObject) => {
    if (!stopped && agent.id && isMarkedEvent(agent)) objects.rememberAgent(agent.id);
  };
  const unsubscribe = paseo.agents.subscribe((update) => {
    if (update.kind === "upsert") remember(update.agent);
  });
  // Do not await this background read from a lifecycle handler. Only the stream
  // subscription needs a fetch; unrelated lifecycle events never call this function.
  void paseo.agents.list({ scope: "active", subscribe: {}, page: { limit: 200 } }).then((snapshot) => {
    if (stopped) { void snapshot.subscription.release().catch(() => {}); return; }
    for (const { agent } of snapshot.entries) remember(agent);
    release = () => { void snapshot.subscription.release().catch(() => {}); };
  }, () => {
    if (!stopped) log("lifecycle identity subscription failed; startup/launcher IDs still available");
  });
  return () => { stopped = true; unsubscribe(); release(); };
}
