/** An authoritative daemon lookup. Null means the daemon answered "no such agent". */
export type AgentInspector = (agentId: string) => Promise<{ archived: boolean } | null>;
export type AgentApiState = "alive" | "archived" | "missing" | "unknown";
export const AGENT_QUERY_TIMEOUT_MS = 5_000;

/** Bound the extra liveness check so a disconnected daemon cannot wedge the scheduler. */
export async function inspectAgentState(agentId: string, inspect?: AgentInspector, timeoutMs = AGENT_QUERY_TIMEOUT_MS): Promise<AgentApiState> {
  if (!inspect) return "unknown";
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const agent = await Promise.race([
      Promise.resolve().then(() => inspect(agentId)),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("agent lookup timed out")), timeoutMs); }),
    ]);
    if (agent === null) return "missing";
    if (!agent || typeof agent.archived !== "boolean") throw new Error("the agent archive state has the wrong shape");
    return agent.archived ? "archived" : "alive";
  } catch (err) {
    console.error("[paseo-kanban] liveness API", err instanceof Error ? err.message : err);
    return "unknown";
  } finally {
    clearTimeout(timer);
  }
}
