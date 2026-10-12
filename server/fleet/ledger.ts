import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import type { PluginHookAgent, PluginHookContext } from "@getpaseo/plugin/server";
import { CURSOR_PROVIDER } from "../../shared/fleet/quota-adapters";
import type { Bucket, Buckets } from "./scan";
import { type Json, LEDGER, readJson, writeJson } from "./util";

// Providers whose transcripts are not readable on this machine (Cursor encrypts them):
// their usage is taken from what Paseo reports at the end of each turn.
export const LEDGER_PROVIDERS = new Set<string>([CURSOR_PROVIDER]);
const MAX_TURNS = 20_000;

export interface LedgerTurn { at: string; agentId: string; provider: string; model: string; input: number; cached: number; output: number; calls?: number; estimated?: boolean }
interface LedgerFile { version: 2; turns: LedgerTurn[] }

let chain: Promise<void> = Promise.resolve();

/** Rough characters per token for mixed Chinese/English text. */
const CHARS_PER_TOKEN = 3;

export function recordTurn(agent: PluginHookAgent, timeline: readonly AgentTimelineItem[], context: PluginHookContext): void {
  if (!agent || !LEDGER_PROVIDERS.has(agent.provider)) return;
  const items = Array.isArray(timeline) ? timeline : [];
  chain = chain.then(() => record(agent, items, context)).catch((e) => console.error("[afc] ledger:", String(e)));
}

async function record(agent: PluginHookAgent, timeline: readonly AgentTimelineItem[], { paseo }: PluginHookContext): Promise<void> {
  const handle = paseo.agents.ref(agent.id);
  await handle.refresh();
  const usage = handle.lastUsage as Json | null;
  const current = (handle.current() ?? {}) as Json;
  // Without reported usage, count model requests from the turn's timeline —
  // one per tool call plus the final answer — and estimate output tokens from the text written.
  const toolCalls = timeline.filter((t) => t && t.type === "tool_call").length;
  const written = timeline.reduce((n, t) => {
    if (!t || (t.type !== "assistant_message" && t.type !== "reasoning")) return n;
    return n + (typeof t.text === "string" ? t.text.length : 0);
  }, 0);
  const file = await readLedger();
  file.turns.push({
    at: new Date().toISOString(),
    agentId: agent.id,
    provider: agent.provider,
    model: String(current.model ?? current.config?.model ?? "?"),
    input: Number(usage?.inputTokens ?? 0),
    cached: Number(usage?.cachedInputTokens ?? 0),
    output: usage ? Number(usage.outputTokens ?? 0) : Math.round(written / CHARS_PER_TOKEN),
    calls: toolCalls + 1,
    estimated: !usage,
  });
  if (file.turns.length > MAX_TURNS) file.turns = file.turns.slice(-MAX_TURNS);
  await writeJson(LEDGER, file);
}

async function readLedger(): Promise<LedgerFile> {
  const raw = await readJson<Json>(LEDGER, {});
  return raw.version === 2 && Array.isArray(raw.turns) ? (raw as LedgerFile) : { version: 2, turns: [] };
}

/**
 * Ledger turns as hourly buckets, keyed by agent (used as the session id).
 * Some ACP agents report per-turn usage and some report running session totals; a series that never
 * decreases over three or more turns is treated as running totals and converted to deltas.
 */
export async function ledgerBuckets(): Promise<Array<{ provider: string; sessionId: string; b: Buckets; estimated: string[] }>> {
  const byAgent = new Map<string, LedgerTurn[]>();
  for (const t of (await readLedger()).turns) {
    const list = byAgent.get(t.agentId) ?? [];
    list.push(t);
    byAgent.set(t.agentId, list);
  }
  const out: Array<{ provider: string; sessionId: string; b: Buckets; estimated: string[] }> = [];
  for (const [agentId, turns] of byAgent) {
    const reported = turns.filter((t) => !t.estimated);
    const cumulative = reported.length >= 3 && reported.every((t, i) => i === 0 || (t.input >= reported[i - 1].input && t.output >= reported[i - 1].output));
    const b: Buckets = {};
    turns.forEach((t) => {
      const i = reported.indexOf(t);
      const p = cumulative && i > 0 ? reported[i - 1] : { input: 0, cached: 0, output: 0 };
      const input = t.input - p.input;
      const cached = Math.min(input, Math.max(0, t.cached - p.cached));
      const v: Bucket = [input - cached, cached, 0, 0, t.output - p.output, t.calls ?? 1];
      const key = `${t.at.slice(0, 13)}|${t.provider}|${t.model}|0`;
      const cur = b[key] ?? [0, 0, 0, 0, 0, 0];
      for (let k = 0; k < 6; k++) cur[k] += v[k];
      b[key] = cur;
    });
    out.push({ provider: turns[0].provider, sessionId: agentId, b, estimated: [...new Set(turns.filter((t) => t.estimated).map((t) => `${t.provider}/${t.model}`))] });
  }
  return out;
}
