/// <reference types="node" />
import { createPaseoClient } from "@getpaseo/client";
import { askPaseoAgent } from "./paseo";
import { readAgentPresence, type AgentPresence } from "./presence";

export async function livePresence(agentId: string, env: NodeJS.ProcessEnv): Promise<AgentPresence> {
  const url = env.PASEO_URL ?? "ws://127.0.0.1:6767/ws";
  const client = createPaseoClient({ url, reconnect: { enabled: false }, connectTimeoutMs: 4_000 });
  try {
    await client.connect();
    return await readAgentPresence(agentId, () => askPaseoAgent(client, agentId));
  } catch (err) {
    console.error("[paseo-kanban] presence", err instanceof Error ? err.message : err);
    return readAgentPresence(agentId);
  } finally {
    await client.close().catch(() => undefined);
  }
}
