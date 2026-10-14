/// <reference types="node" />
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfigForReport } from "./config";
import { getDb } from "./db";
import { dataDir } from "./paths";
import { mcpStaleNote } from "./fallback";
import { appendEvent, type TaskRow } from "./store";

export { mcpStaleNote };

function portFile(): string {
  return join(dataDir(), "mcp.port");
}

export function readSavedMcpPort(): number | null {
  try {
    const value = Number(readFileSync(portFile(), "utf8").trim());
    return Number.isInteger(value) && value > 0 && value < 65536 ? value : null;
  } catch {
    return null;
  }
}

export function writeSavedMcpPort(port: number): void {
  writeFileSync(portFile(), `${port}\n`, { mode: 0o600 });
}

/** Keep data/mcp.port when this process had to move. The next start must try the address agents already have. */
export function recordMcpListen(port: number, replaced: boolean): void {
  if (!replaced) writeSavedMcpPort(port);
}

/** Read at plugin startup: a lost config file falls back to the memory copy or data/mcp.port instead of stopping the plugin (DEMO_0001). */
export function preferredMcpPort(): number | null {
  return loadConfigForReport().mcpPort ?? readSavedMcpPort();
}

export function markRunningMcpStale(): number {
  const rows = getDb()
    .prepare(`SELECT id, status, agent_id FROM tasks WHERE status IN ('running', 'reviewing') AND agent_id IS NOT NULL`)
    .all() as unknown as Array<{ id: number; status: string; agent_id: string }>;
  let marked = 0;
  for (const row of rows) {
    if (mcpStaleFor(row.id, row.agent_id)) continue;
    appendEvent(row.id, "mcp_stale", row.status, row.status, "scheduler", { agentId: row.agent_id });
    marked += 1;
  }
  return marked;
}

export function mcpStaleFor(taskId: number, agentId: string | null): boolean {
  if (!agentId) return false;
  const rows = getDb()
    .prepare(`SELECT data_json FROM events WHERE task_id = ? AND kind = 'mcp_stale' ORDER BY id DESC`)
    .all(taskId) as unknown as Array<{ data_json: string }>;
  return rows.some((row) => {
    try {
      const data = JSON.parse(row.data_json) as { agentId?: string };
      return data.agentId === agentId;
    } catch {
      return false;
    }
  });
}

export function mcpNoteFor(task: Pick<TaskRow, "id" | "agent_id">): string | null {
  return mcpStaleFor(task.id, task.agent_id) ? mcpStaleNote() : null;
}
