/// <reference types="node" />
// Read-only facts from the providers' own transcript files. This never asks Paseo to load an
// agent (which would start a provider process) — it only reads files already on disk.
import type { Stats } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { AgentRecord } from "./records";
import { cached, HOME, type Json } from "./util";

export interface TranscriptFacts {
  turns: number; // user turns (the first one is the brief)
  lastReply: string;
}

const MAX_FULL_READ = 16 * 1024 * 1024;
const TAIL_BYTES = 256 * 1024;

/** ENOENT: nothing there. ENOTDIR: a stray file where a folder was expected. Neither is worth a log line. */
function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * A provider that was never installed has no transcript folder: that is normal and stays quiet.
 * Any other failure (permissions, a file where a folder should be) is logged, then treated as empty
 * so one unreadable folder does not take down the rest of the scan.
 */
async function listDir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (error) {
    if (!isMissing(error)) console.error(`[afc] transcripts: cannot read directory ${dir}:`, String(error).slice(0, 160));
    return [];
  }
}

/** Null when the file is gone (a session can be cleaned up between the index and the read); other failures are logged. */
async function statOrNull(path: string): Promise<Stats | null> {
  try {
    return await stat(path);
  } catch (error) {
    if (!isMissing(error)) console.error(`[afc] transcripts: cannot stat file ${path}:`, String(error).slice(0, 160));
    return null;
  }
}

async function walk(dir: string, depth: number, match: (name: string, full: string) => string | null, out: Map<string, string>): Promise<void> {
  if (depth < 0) return;
  for (const name of await listDir(dir)) {
    const full = join(dir, name);
    const key = match(name, full);
    if (key) out.set(key, full);
    else if (!name.includes(".")) await walk(full, depth - 1, match, out);
  }
}

/** sessionId -> transcript path, per provider. Cached 5 min. */
function index(provider: string): Promise<Map<string, string>> {
  return cached(`transcript-index:${provider}`, 5 * 60_000, async () => {
    const out = new Map<string, string>();
    if (provider === "codex") {
      await walk(join(HOME, ".codex", "sessions"), 4, (name) => {
        const m = /^rollout-.*-([0-9a-f]{8}-[0-9a-f-]{27})\.jsonl$/.exec(name);
        return m ? m[1] : null;
      }, out);
    } else if (provider === "grok") {
      const root = join(HOME, ".grok", "sessions");
      for (const cwdDir of await listDir(root)) {
        for (const sid of await listDir(join(root, cwdDir))) {
          out.set(sid, join(root, cwdDir, sid, "chat_history.jsonl"));
        }
      }
    } else if (provider === "claude") {
      const root = join(HOME, ".claude", "projects");
      for (const proj of await listDir(root)) {
        for (const f of await listDir(join(root, proj))) {
          if (f.endsWith(".jsonl")) out.set(f.slice(0, -6), join(root, proj, f));
        }
      }
    }
    return out;
  });
}

async function readText(path: string): Promise<{ text: string; partial: boolean } | null> {
  const st = await statOrNull(path);
  if (!st) return null;
  const fh = await open(path, "r");
  try {
    const partial = st.size > MAX_FULL_READ;
    const start = partial ? st.size - TAIL_BYTES : 0;
    const buf = Buffer.alloc(st.size - start);
    await fh.read(buf, 0, buf.length, start);
    let text = buf.toString("utf8");
    if (partial) text = text.slice(text.indexOf("\n") + 1);
    return { text, partial };
  } finally {
    await fh.close();
  }
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c === "object" && c ? String((c as Json).text ?? "") : "")).join("");
  return "";
}

/** `badLines` counts JSON lines that did not parse (a transcript still being written ends mid-line). */
export function parseTranscript(provider: string, text: string): { facts: TranscriptFacts; badLines: number } {
  let turns = 0;
  let badLines = 0;
  let lastReply = "";
  for (const line of text.split("\n")) {
    if (!line.startsWith("{")) continue;
    let d: Json;
    try {
      d = JSON.parse(line);
    } catch {
      badLines += 1;
      continue;
    }
    if (provider === "codex") {
      if (d.type === "event_msg" && d.payload?.type === "task_started") turns += 1;
      if (d.type === "response_item" && d.payload?.type === "message" && d.payload?.role === "assistant") {
        const t = textOf(d.payload.content);
        if (t.trim()) lastReply = t;
      }
    } else if (provider === "grok") {
      if (d.type === "user" && !d.synthetic_reason && textOf(d.content).includes("<user_query>")) turns += 1;
      if (d.type === "assistant") {
        const t = textOf(d.content);
        if (t.trim()) lastReply = t;
      }
    } else if (provider === "claude") {
      const c = d.message?.content;
      if (d.type === "user" && (typeof c === "string" ? !c.startsWith("<") : Array.isArray(c) && c.some((x: Json) => x?.type === "text" && !String(x.text).startsWith("<")))) turns += 1;
      if (d.type === "assistant" && Array.isArray(c)) {
        const t = c.filter((x: Json) => x?.type === "text").map((x: Json) => String(x.text)).join("");
        if (t.trim()) lastReply = t;
      }
    }
  }
  return { facts: { turns, lastReply: lastReply.slice(-3000) }, badLines };
}

const factsMemo = new Map<string, { mtimeMs: number; facts: TranscriptFacts }>();

export async function transcriptFacts(rec: AgentRecord): Promise<TranscriptFacts | null> {
  if (!rec.sessionId || !["codex", "grok", "claude"].includes(rec.provider)) return null;
  const path = (await index(rec.provider)).get(rec.sessionId);
  if (!path) return null;
  const st = await statOrNull(path);
  if (!st) return null;
  const hit = factsMemo.get(path);
  if (hit && hit.mtimeMs === st.mtimeMs) return hit.facts;
  const read = await readText(path);
  if (!read) return null;
  const { facts, badLines } = parseTranscript(rec.provider, read.text);
  if (badLines > 0) console.error(`[afc] transcripts: ${path} has ${badLines} line(s) that are not valid JSON, skipped`);
  factsMemo.set(path, { mtimeMs: st.mtimeMs, facts });
  return facts;
}
