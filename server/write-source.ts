/// <reference types="node" />
import { t } from "../shared/i18n";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { getDb } from "./db";
import { KanbanError } from "./errors";
import type { Identity } from "./tokens";

export interface WriteSource {
  agentId: string | null;
  /** Observed Kanban run for the authenticated identity; NOT provider provenance. */
  runId: number | null;
  threadId: null;
  turnId: null;
  toolCallId: null;
  transport: "mcp" | "cli" | "in-process";
  requestId: string;
  provenance: "identity_only";
}

interface CallContext {
  transport: WriteSource["transport"];
  requestId: string;
  source?: WriteSource;
  auditing?: boolean;
}

const calls = new AsyncLocalStorage<CallContext>();

/** Only host code chooses the transport; never consume headers, arguments or env as proof. */
export function withWriteTransport<T>(transport: WriteSource["transport"], work: () => T): T {
  return calls.run({ transport, requestId: randomUUID() }, work);
}

export function currentWriteSource(): WriteSource | null {
  return calls.getStore()?.source ?? null;
}

const READ_TOOLS = new Set(["kanban_ping", "kanban_show", "kanban_list", "kanban_doctor"]);
export function isWriteTool(name: string): boolean { return !READ_TOOLS.has(name); }

/** Persist a minimal, parameter-free audit for every authenticated write attempt. */
export async function auditWrite<T>(operation: string, identity: Identity, work: () => T | Promise<T>): Promise<T> {
  const parent = calls.getStore();
  // The CLI already audits its whole command, including commands handled without handleTool.
  if (parent?.auditing) return work();
  const db = getDb();
  const run = identity.taskId != null && identity.agentId
    ? db.prepare("SELECT id FROM runs WHERE task_id = ? AND agent_id = ? ORDER BY id DESC LIMIT 1")
      .get(identity.taskId, identity.agentId) as { id: number } | undefined
    : undefined;
  const source: WriteSource = {
    agentId: identity.agentId, runId: run?.id ?? null,
    threadId: null, turnId: null, toolCallId: null,
    transport: parent?.transport ?? "in-process", requestId: parent?.requestId ?? randomUUID(),
    provenance: "identity_only",
  };
  const row = db.prepare(`INSERT INTO write_audits (at, operation, task_id, role, source_json, outcome)
    VALUES (?, ?, ?, ?, ?, 'started')`)
    .run(new Date().toISOString(), operation, identity.taskId, identity.role, JSON.stringify(source));
  const finish = (outcome: string, code: string | null) => db.prepare("UPDATE write_audits SET outcome = ?, error_code = ? WHERE id = ?")
    .run(outcome, code, Number(row.lastInsertRowid));
  return calls.run({ transport: source.transport, requestId: source.requestId, source, auditing: true }, async () => {
    try {
      const result = await work();
      finish("returned", null);
      return result;
    } catch (err) {
      // Do not persist error messages: they may contain credentials or caller-supplied text.
      finish("threw", err instanceof KanbanError ? err.code : "internal");
      throw err;
    }
  });
}

/** Optional stored note only: handoff shapes are unconstrained and prove no call provenance. */
export function completionHandoffWarnings(handoff: unknown): string[] {
  if (!currentWriteSource() || typeof handoff !== "string") return [];
  try { JSON.parse(handoff); }
  catch {
    return [t("writeSource.invalidHandoffJson")];
  }
  return [];
}
