/// <reference types="node" />
// Token usage per hour and model, read from the providers' own transcript files on this machine.
// Each file is parsed once and its buckets are cached on disk until the file changes.
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { HOME, type Json, readJson, STATE_DIR, writeJson } from "./util";

/** [uncached input, cache read, cache write (5 min), cache write (1 h), output incl. reasoning, model calls] */
export type Bucket = [number, number, number, number, number, number];
/** Key: "<hour ISO>|<provider>|<model>|<1 when the call exceeded the long-context threshold>" */
export type Buckets = Record<string, Bucket>;

interface FileScan { mtimeMs: number; size: number; provider: string; sessionId: string; b: Buckets }
interface ScanCache { version: number; files: Record<string, FileScan> }

const VERSION = 3;
const CACHE = join(STATE_DIR, "usage-scan-cache.json");
const MAX_AGE_MS = 40 * 24 * 60 * 60_000;
const LONG_CONTEXT = { claude: 200_000, codex: 272_000, grok: 200_000 } as const;

export interface ScanResult { at: string; files: FileScan[] }

let latest: ScanResult | null = null;
let running: Promise<ScanResult> | null = null;

export function latestScan(): ScanResult | null {
  return latest;
}

export function scanInFlight(): boolean {
  return running !== null;
}

/** Start a scan unless one is running or the last finished less than maxAgeMs ago. */
export function ensureScan(maxAgeMs: number): Promise<ScanResult> {
  if (running) return running;
  if (latest && Date.now() - Date.parse(latest.at) < maxAgeMs) return Promise.resolve(latest);
  running = scanAll()
    .then((r) => (latest = r))
    .finally(() => {
      running = null;
    });
  return running;
}

function add(b: Buckets, ts: number, provider: string, model: string, long: boolean, v: Bucket): void {
  if (!Number.isFinite(ts) || !model) return;
  const hour = new Date(ts).toISOString().slice(0, 13);
  const key = `${hour}|${provider}|${model}|${long ? 1 : 0}`;
  const cur = b[key] ?? [0, 0, 0, 0, 0, 0];
  for (let i = 0; i < 6; i++) cur[i] += v[i];
  b[key] = cur;
}

const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : 0);

/** Parse one transcript line. A bad line (often a half-written tail) yields null so the caller can count it. */
function parseLine(line: string): Json | null {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function logSkipped(provider: string, count: number): void {
  if (count > 0) console.error(`[afc] scan: ${provider} skipped ${count} record(s) that failed to parse`);
}

function parseClaude(text: string): Buckets {
  // Claude Code writes one line per content block, repeating the message's usage; keep the last per message id.
  const byId = new Map<string, { ts: number; model: string; u: Json }>();
  let skipped = 0;
  for (const line of text.split("\n")) {
    if (!line.includes('"usage"') || !line.includes('"assistant"')) continue;
    const d = parseLine(line);
    if (!d) {
      skipped += 1;
      continue;
    }
    const m = d.message;
    if (d.type !== "assistant" || !m?.usage || !m.model || m.model === "<synthetic>") continue;
    byId.set(String(m.id ?? d.uuid), { ts: Date.parse(d.timestamp), model: String(m.model), u: m.usage });
  }
  logSkipped("claude", skipped);
  const b: Buckets = {};
  for (const { ts, model, u } of byId.values()) {
    const write1h = n(u.cache_creation?.ephemeral_1h_input_tokens);
    const writeAll = n(u.cache_creation_input_tokens);
    const ctx = n(u.input_tokens) + n(u.cache_read_input_tokens) + writeAll;
    add(b, ts, "claude", model, ctx > LONG_CONTEXT.claude, [n(u.input_tokens), n(u.cache_read_input_tokens), writeAll - write1h, write1h, n(u.output_tokens), 1]);
  }
  return b;
}

function parseCodex(text: string): Buckets {
  const b: Buckets = {};
  let model = "";
  let prev = { input: 0, cached: 0, output: 0 };
  let skipped = 0;
  for (const line of text.split("\n")) {
    if (!line.includes('"turn_context"') && !line.includes('"token_count"')) continue;
    const d = parseLine(line);
    if (!d) {
      skipped += 1;
      continue;
    }
    const p = d.payload ?? {};
    if (d.type === "turn_context" && p.model) model = String(p.model);
    if (d.type !== "event_msg" || p.type !== "token_count" || !p.info?.total_token_usage) continue;
    const t = p.info.total_token_usage;
    const cur = { input: n(t.input_tokens), cached: n(t.cached_input_tokens), output: n(t.output_tokens) };
    const dIn = cur.input - prev.input;
    const dCached = cur.cached - prev.cached;
    const dOut = cur.output - prev.output;
    const last = p.info.last_token_usage ?? {};
    const long = n(last.input_tokens) > LONG_CONTEXT.codex;
    const ts = Date.parse(d.timestamp);
    prev = cur;
    if (dIn < 0 || dOut < 0) {
      // Counter reset (e.g. a resumed thread started a fresh total): count this call's own usage.
      add(b, ts, "codex", model || "codex", long, [n(last.input_tokens) - n(last.cached_input_tokens), n(last.cached_input_tokens), 0, 0, n(last.output_tokens), 1]);
      continue;
    }
    if (dIn === 0 && dOut === 0) continue; // repeated rate-limit refresh
    add(b, ts, "codex", model || "codex", long, [dIn - dCached, dCached, 0, 0, dOut, 1]);
  }
  logSkipped("codex", skipped);
  return b;
}

function grokUsage(b: Buckets, ts: number, usage: Json): boolean {
  if (!Number.isFinite(ts) || usage.usageIsIncomplete) return false;
  const per: Record<string, Json> = usage.modelUsage ?? { [usage.primaryModelId || "grok"]: usage };
  const entries = Object.entries(per);
  if (!entries.length || entries.some(([, u]) => !u || u.usageIsIncomplete
      || typeof u.inputTokens !== "number" || typeof u.outputTokens !== "number"
      || !Number.isFinite(u.inputTokens) || !Number.isFinite(u.outputTokens) || u.inputTokens < 0 || u.outputTokens < 0)) return false;
  for (const [model, u] of entries) {
    const calls = Math.max(1, n(u.modelCalls));
    const cacheRead = Math.min(u.inputTokens, Math.max(0, n(u.cachedReadTokens)));
    const write = Math.min(u.inputTokens - cacheRead, Math.max(0, n(u.cacheCreationTokens)));
    const input = u.inputTokens - cacheRead - write;
    // Grok's UsageTotals includes reasoning within outputTokens; totalTokens is input + output.
    add(b, ts, "grok", model, u.inputTokens / calls > LONG_CONTEXT.grok, [input, cacheRead, write, 0, u.outputTokens, calls]);
  }
  return true;
}

/** Grok's public SessionUsageFile stores dated turn deltas, alongside session totals. */
function parseGrokUsage(text: string, sessionId: string): Buckets {
  const b: Buckets = {};
  const data = parseLine(text);
  // A fork can initially contain its parent's usage file. Do not attribute that copied bill.
  if (!data || (data.sessionId && data.sessionId !== sessionId) || data.session?.usageIsIncomplete || !Array.isArray(data.turns)) return b;
  for (const turn of data.turns) {
    if (!turn || typeof turn.endedAt !== "string" || !grokUsage(b, Date.parse(turn.endedAt), turn)) return {};
  }
  return b;
}

function parseGrok(text: string): Buckets {
  const b: Buckets = {};
  let skipped = 0;
  for (const line of text.split("\n")) {
    if (!line.includes('"usage"')) continue;
    const d = parseLine(line);
    if (!d) {
      skipped += 1;
      continue;
    }
    const upd = d.params?.update;
    if (!upd?.usage || !(upd.stop_reason || upd.stopReason || upd.sessionUpdate === "turn_completed")) continue;
    const ts = typeof d.timestamp === "number"
      ? d.timestamp > 1e12 ? d.timestamp : d.timestamp * 1000
      : typeof d.timestamp === "string" ? Date.parse(d.timestamp) : NaN;
    if (!grokUsage(b, ts, upd.usage)) return {};
  }
  logSkipped("grok", skipped);
  return b;
}

async function walk(dir: string, depth: number, accept: (path: string) => boolean, out: string[]): Promise<void> {
  if (depth < 0) return;
  for (const ent of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) await walk(full, depth - 1, accept, out);
    else if (accept(full)) out.push(full);
  }
}

interface Source { provider: string; files: string[]; sessionId: (path: string, text: string) => string; parse: (text: string, path: string) => Buckets }

function codexSessionId(path: string, text: string): string {
  for (const line of text.split("\n")) {
    if (!line.includes('"session_meta"')) continue;
    const row = parseLine(line);
    if (row?.type === "session_meta" && typeof row.payload?.id === "string" && row.payload.id) return row.payload.id;
  }
  return /([0-9a-f]{8}-[0-9a-f-]{27})\.jsonl$/.exec(path)?.[1] ?? basename(path);
}

async function sources(): Promise<Source[]> {
  const transcriptHome = process.env.AFC_TRANSCRIPT_HOME ?? HOME;
  const claude: string[] = [];
  await walk(join(transcriptHome, ".claude", "projects"), 4, (p) => p.endsWith(".jsonl"), claude);
  const codex: string[] = [];
  const codexHome = process.env.AFC_TRANSCRIPT_HOME ? join(transcriptHome, ".codex") : process.env.CODEX_HOME || join(transcriptHome, ".codex");
  for (const dir of ["sessions", "archived_sessions"]) {
    await walk(join(codexHome, dir), 4, (p) => /rollout-.*\.jsonl$/.test(p), codex);
  }
  const grok: string[] = [];
  await walk(join(transcriptHome, ".grok", "sessions"), 2, (p) => p.endsWith("/updates.jsonl") || p.endsWith("/usage.json"), grok);
  // usage.json is authoritative when present, including an explicit incomplete/unknown bill.
  // Older sessions without it fall back to updates.jsonl, never a second bill for that session.
  grok.sort((a, b) => Number(b.endsWith("/usage.json")) - Number(a.endsWith("/usage.json")) || a.localeCompare(b));
  return [
    {
      provider: "claude",
      files: claude,
      // Subagent transcripts live in <session>/subagents/*.jsonl and belong to the parent session.
      sessionId: (p) => (p.includes("/subagents/") ? basename(dirname(dirname(p))) : basename(p, ".jsonl")),
      parse: parseClaude,
    },
    {
      provider: "codex",
      files: codex,
      sessionId: codexSessionId,
      parse: parseCodex,
    },
    { provider: "grok", files: grok, sessionId: (p) => basename(dirname(p)),
      parse: (text, path) => path.endsWith("/usage.json") ? parseGrokUsage(text, basename(dirname(path))) : parseGrok(text) },
  ];
}

async function scanAll(): Promise<ScanResult> {
  const cache = await readJson<ScanCache>(CACHE, { version: VERSION, files: {} });
  const old = cache.version === VERSION ? cache.files : {};
  const next: Record<string, FileScan> = {};
  const grokSessions = new Set<string>();
  const cutoff = Date.now() - MAX_AGE_MS;
  for (const src of await sources()) {
    for (const path of src.files) {
      if (src.provider === "grok" && grokSessions.has(dirname(path))) continue;
      const st = await stat(path).catch(() => null);
      if (!st || st.mtimeMs < cutoff) continue;
      const hit = old[path];
      if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) next[path] = hit;
      else {
        const text = await readFile(path, "utf8").catch(() => "");
        next[path] = { mtimeMs: st.mtimeMs, size: st.size, provider: src.provider, sessionId: src.sessionId(path, text), b: src.parse(text, path) };
      }
      if (src.provider === "grok" && (path.endsWith("/usage.json") || Object.keys(next[path].b).length)) grokSessions.add(dirname(path));
      // Yield between files so RPCs stay responsive during the first full scan.
      await new Promise((r) => setImmediate(r));
    }
  }
  await writeJson(CACHE, { version: VERSION, files: next });
  return { at: new Date().toISOString(), files: Object.values(next) };
}
