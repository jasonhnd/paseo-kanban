/// <reference types="node" />
import { reclaimTask } from "./failures";
import { readAgentRecord, type AgentFile } from "./open";
import type { ReclaimEvidence } from "./reclaim-note";
import { appendEvent, getTask } from "./store";

/**
 * What we know about an agent after a canceled turn.
 * running / idle: still here (a new prompt cancels the current turn and starts the next one).
 * error is reported as idle: the record exists and the agent is not closed.
 * closed / archived / missing: confirmed gone, safe to reclaim.
 * unknown: the API could not be asked and the record file was missing or half-written. Treat as still here.
 */
export type AgentPresence = "running" | "idle" | "closed" | "archived" | "missing" | "unknown";

export interface AgentView {
  status: string | null;
  archivedAt: string | null;
  activeTurn?: unknown;
}

/** "absent" means the daemon answered and has no such agent. A throw means the daemon could not be asked. */
export type AgentAsk = () => Promise<AgentView | "absent">;

const NOT_FOUND = /not found|does not exist|unknown agent|no such agent|\b404\b/i;

export function classifyAgentView(view: AgentView): AgentPresence {
  if (view.archivedAt) return "archived";
  if (view.status === "closed") return "closed";
  if (view.status === "running" || view.status === "initializing") return "running";
  if (view.activeTurn != null && typeof view.activeTurn === "object") return "running";
  if (view.status === "idle" || view.status === "error") return "idle";
  if (!view.status) return "unknown";
  return "idle";
}

function classifyFile(file: AgentFile): AgentPresence {
  return classifyAgentView({ status: file.lastStatus, archivedAt: file.archivedAt });
}

/** Confirmed gone. unknown is not gone: a reload can hide the record for one tick. */
export function presenceIsGone(presence: AgentPresence): boolean {
  return presence === "closed" || presence === "archived" || presence === "missing";
}

/**
 * Prefer a Paseo snapshot when the API returns one.
 * If the API cannot be asked, use the record file. A missing or half-written file
 * alone is unknown, not gone: `paseo reload` rewrites those files.
 * An empty snapshot (no error, no agent) is not a deletion by itself; a live file still counts.
 * An error that says the agent does not exist is a deletion, unless the file is unreadable.
 */
export async function readAgentPresence(agentId: string, ask?: AgentAsk): Promise<AgentPresence> {
  if (ask) {
    try {
      const view = await ask();
      if (view === "absent") return absentOrFile(agentId);
      return classifyAgentView(view);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (NOT_FOUND.test(message)) return confirmedMissing(agentId);
      console.error("[paseo-kanban] presence", message);
    }
  }
  return fileOnly(agentId);
}

/** Daemon returned no agent and no error. A live or closed file still decides; both missing means gone. */
function absentOrFile(agentId: string): AgentPresence {
  const read = readAgentRecord(agentId);
  if (read.state === "unreadable") return "unknown";
  if (read.state === "missing") return "missing";
  return classifyFile(read.file);
}

/** Daemon said this agent does not exist. A half-written file is not enough to contradict that. */
function confirmedMissing(agentId: string): AgentPresence {
  const read = readAgentRecord(agentId);
  if (read.state === "unreadable") return "unknown";
  if (read.state === "ok") {
    const presence = classifyFile(read.file);
    if (presence === "closed" || presence === "archived") return presence;
  }
  return "missing";
}

function fileOnly(agentId: string): AgentPresence {
  const read = readAgentRecord(agentId);
  if (read.state !== "ok") return "unknown";
  return classifyFile(read.file);
}

/**
 * A canceled turn is not the agent leaving. Keep the card when the agent is still
 * running, idle, or we cannot tell. Reclaim only when it is archived, closed, or gone.
 * Paseo's auto-archive-on-merge lands here (DEMO_0001): it closes the agent mid-turn. The evidence (last recognised
 * operations, the merged PR) goes on the reclaimed event so the next agent is told what already happened.
 * Does not remind and does not increment the nudge counter.
 */
export function settleCanceledTurn(
  taskId: number,
  agentId: string,
  presence: AgentPresence,
  evidence?: ReclaimEvidence,
): "kept" | "reclaimed" | "skip" {
  const task = getTask(taskId);
  if (task.status !== "running" && task.status !== "reviewing") return "skip";
  // The presence and evidence reads are awaited: another start may already hold this card.
  if (task.agent_id !== agentId) return "skip";
  if (presenceIsGone(presence)) {
    const result = reclaimTask(taskId, new Date(), { source: "turn_canceled", apiState: presence, ...evidence });
    return result === "reclaimed" || result === "guarded" ? "reclaimed" : "skip";
  }
  appendEvent(taskId, "turn_canceled", task.status, task.status, "scheduler", { agentId, presence });
  return "kept";
}
