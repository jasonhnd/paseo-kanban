/// <reference types="node" />
import { open, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import type { BudgetObservation, BudgetTurn } from "./run-budget";
import { commandInvocation, findCommand } from "./command-invocation";
import { execFile } from "node:child_process";
import { paseoHome } from "./contract";
import { SAFE_AGENT_ID } from "./agent-id";

type Row = Record<string, any>;
const MAX_READ = 8 * 1024 * 1024;
const number = (value: unknown): number | undefined => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const textOf = (content: unknown): string => Array.isArray(content) ? content.map(x => x?.text ?? "").join(" ").slice(0, 300) : typeof content === "string" ? content.slice(0, 300) : "";

/** Codex emits token_count per model call, including calls within one Paseo turn.
 * input_tokens already includes cached_input_tokens. Repeated quota-only readings are not calls.
 * Only usage, tool names/arguments and short assistant summaries are inspected; no credential files.
 */
export function parseCodexBudget(text: string, partial = false): BudgetObservation {
  const turns: BudgetTurn[] = [];
  let tools: BudgetTurn["tools"] = [];
  let reply = "";
  let previous = "";
  let malformed = false;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let row: Row;
    try { row = JSON.parse(line); } catch { malformed = true; continue; }
    const payload = row.payload;
    if (!payload || typeof payload !== "object") continue;
    if (row.type === "response_item") {
      if (["function_call", "custom_tool_call"].includes(payload.type) && typeof payload.name === "string") {
        let args: Row = {};
        try { args = JSON.parse(payload.arguments ?? payload.input ?? "{}"); } catch { args = { code: payload.input }; }
        tools.push({ name: payload.name, command: String(args.cmd ?? args.command ?? args.code ?? "").slice(0, 2000), input: args });
      }
      if (payload.type === "message" && payload.role === "assistant") reply = textOf(payload.content);
    }
    if (row.type !== "event_msg" || payload.type !== "token_count") continue;
    const usage = payload.info?.last_token_usage;
    const total = payload.info?.total_token_usage;
    if (!total || typeof row.timestamp !== "string") continue;
    const key = JSON.stringify([total.input_tokens, total.output_tokens, total.cached_input_tokens]);
    if (key === previous) continue;
    previous = key;
    if (!usage || number(usage.input_tokens) === undefined || number(usage.output_tokens) === undefined) continue;
    turns.push({ id: `${row.timestamp}:${key}`, at: row.timestamp, text: reply, tools,
      inputTokens: number(usage.input_tokens), outputTokens: number(usage.output_tokens), cachedInputTokens: number(usage.cached_input_tokens) });
    tools = []; reply = "";
  }
  return { source: "codex-token-count", turns, complete: !partial && !malformed,
    notes: [...(partial ? ["Transcript tail only; counts are a lower bound"] : []), ...(malformed ? ["Incomplete transcript line; usage is partial"] : [])] };
}

/** Canonical turnId is an outer provider turn. Assistant/tool cycles give a conservative
 * lower bound on model rounds when per-call telemetry is unavailable. Never invent tokens
 * from lastUsage: providers differ on whether it is cumulative or the last turn only.
 */
export function parseCanonicalBudget(entries: unknown[], complete: boolean): BudgetObservation {
  const turns: BudgetTurn[] = [];
  let turn: BudgetTurn | undefined;
  let outer: string | undefined;
  for (const raw of entries) {
    const entry = raw as Row;
    if (!entry?.item || typeof entry.timestamp !== "string" || !Number.isSafeInteger(entry.seqStart)) continue;
    const item = entry.item;
    if (item.type === "user_message" || entry.turnId && outer && entry.turnId !== outer) turn = undefined;
    if (typeof entry.turnId === "string") outer = entry.turnId;
    if (item.type === "assistant_message" || !turn && item.type === "tool_call") {
      turn = { id: String(entry.seqStart), at: entry.timestamp, text: item.type === "assistant_message" ? textOf(item.text) : "", tools: [] };
      turns.push(turn);
    }
    if (turn && item.type === "tool_call") {
      const detail = item.detail ?? {};
      turn.tools.push({ name: String(item.name ?? "unknown"), command: typeof detail.command === "string" ? detail.command.slice(0, 2000) : undefined,
        input: detail.type === "unknown" ? detail.input : undefined });
    }
  }
  return { source: "canonical-rounds", turns, complete,
    notes: ["Per-call tokens unavailable; model rounds are a lower bound from canonical assistant/tool cycles", ...(!complete ? ["Timeline window is partial"] : [])] };
}

const sessionPaths = new Map<string, string>();
async function codexTranscript(session: string, home: string): Promise<string | null> {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(session)) return null;
  const key = `${home}:${session}`;
  if (sessionPaths.has(key)) return sessionPaths.get(key)!;
  async function walk(root: string, depth: number): Promise<string | null> {
    let entries;
    try { entries = await readdir(root, { withFileTypes: true }); } catch { return null; }
    for (const entry of entries.reverse()) {
      if (depth === 3 && entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(`-${session}.jsonl`)) return join(root, entry.name);
      if (depth < 3 && entry.isDirectory() && (depth === 0 ? /^\d{4}$/ : /^\d{2}$/).test(entry.name)) {
        const found = await walk(join(root, entry.name), depth + 1);
        if (found) return found;
      }
    }
    return null;
  }
  const path = await walk(join(home, "sessions"), 0);
  if (path) sessionPaths.set(key, path);
  return path;
}

export async function readRunBudgetObservation(paseo: PaseoApi, agentId: string): Promise<BudgetObservation> {
  const handle = paseo.agents.ref(agentId);
  const refreshed = await handle.refresh();
  const agent = refreshed?.agent ?? handle.current();
  if (agent?.provider === "codex" && agent.persistence) {
    try {
      const path = await codexTranscript(agent.persistence.nativeHandle ?? agent.persistence.sessionId, process.env.CODEX_HOME ?? join(homedir(), ".codex"));
      if (path) {
        const file = await open(path, "r");
        try {
          const { size } = await file.stat();
          const offset = Math.max(0, size - MAX_READ);
          const buffer = Buffer.alloc(Math.min(size, MAX_READ));
          const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
          let text = buffer.toString("utf8", 0, bytesRead);
          if (offset) text = text.slice(text.indexOf("\n") + 1);
          const parsed = parseCodexBudget(text, offset > 0);
          if (parsed.turns.length) return parsed;
        } finally { await file.close(); }
      }
    } catch { /* Unavailable provider telemetry falls back to the host timeline. */ }
  }
  const page = await handle.timeline.refetch({ direction: "tail", limit: 1000, projection: "canonical" });
  if (page.agentId !== agentId || page.projection !== "canonical" || page.error || page.gap || page.staleCursor || page.hasNewer) {
    throw new Error("Run budget timeline is unavailable or inconsistent");
  }
  return parseCanonicalBudget(page.entries, page.hasOlder === false && (page.window?.minSeq === 0 || page.window?.minSeq === 1));
}

/** The supported SDK has no cancel action on PaseoAgentHandle. The public CLI stop
 * operation cancels the current turn without archiving the agent or its workspace.
 */
export function interruptRunBudgetAgent(agentId: string): Promise<void> {
  if (!SAFE_AGENT_ID.test(agentId)) return Promise.reject(new Error("Invalid agent id for interrupt"));
  const command = findCommand("paseo");
  if (!command) return Promise.reject(new Error("Paseo CLI is unavailable; interrupt was not sent"));
  const endpoint = process.env.PASEO_URL ? ["--host", process.env.PASEO_URL] : ["--home", paseoHome()];
  const invocation = commandInvocation(command, ["agent", "stop", agentId, ...endpoint, "--json"]);
  return new Promise((resolve, reject) => {
    execFile(invocation.command, invocation.args, { timeout: 10_000, maxBuffer: 64 * 1024 }, error => error ? reject(new Error("Paseo stop failed or timed out")) : resolve());
  });
}
