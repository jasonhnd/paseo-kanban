/// <reference types="node" />
import fsPromises, { lstat, readdir } from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import { join } from "node:path";
import { t } from "../shared/i18n";
import { agentsDir } from "./open";

export interface NativeAgent {
  id: string;
  provider: string;
  cwd: string;
  title?: string;
  labels?: Record<string, string>;
  persistence?: { sessionId?: unknown; nativeHandle?: unknown } | null;
  archivedAt?: string | null;
  lastStatus?: string;
}
export const SAFE_NATIVE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

async function readRecord(path: string, id: string, stat?: BigIntStats): Promise<NativeAgent> {
  stat ??= await lstat(path, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error(t("nativeAgentIndex.error.unsafeRecord"));
  const agent = JSON.parse(await fsPromises.readFile(path, "utf8")) as NativeAgent;
  if (agent.id !== id || typeof agent.provider !== "string" || typeof agent.cwd !== "string") throw new Error(t("nativeAgentIndex.error.badFields"));
  if ((agent.archivedAt != null && typeof agent.archivedAt !== "string") || (agent.labels != null && (typeof agent.labels !== "object" || Array.isArray(agent.labels)))) throw new Error(t("nativeAgentIndex.error.badArchiveOrLabels"));
  return agent;
}

export type NativeAgentReader = (id: string) => Promise<NativeAgent | null>;

/** Lazy root snapshot shared only within one reconcile round, including failures. */
export function createNativeAgentReader(): NativeAgentReader {
  const root = agentsDir();
  let directories: Promise<string[]> | undefined;
  return async id => {
    if (!SAFE_NATIVE_ID.test(id)) throw new Error(t("nativeAgentIndex.error.badAgentId"));
    directories ??= (async () => {
      if ((await lstat(root)).isSymbolicLink()) throw new Error(t("nativeAgentIndex.error.rootSymlink"));
      const dirs = await readdir(root, { withFileTypes: true });
      if (dirs.some(dir => dir.isSymbolicLink())) throw new Error(t("nativeAgentIndex.error.dirSymlink"));
      return dirs.filter(dir => dir.isDirectory()).map(dir => dir.name);
    })();
    let found: NativeAgent | null = null;
    for (const dir of await directories) {
      try {
        const agent = await readRecord(join(root, dir, `${id}.json`), id);
        if (found) throw new Error(t("nativeAgentIndex.error.duplicate"));
        found = agent;
      } catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
    }
    return found;
  };
}
/** Capture only the retiring agent, before purge. No native storage access. */
export async function readNativeAgent(id: string): Promise<NativeAgent | null> {
  return createNativeAgentReader()(id);
}

export interface NativeAgentIndex {
  agents: Map<string, NativeAgent>;
  sessions: Map<string, NativeAgent[]>;
  error?: string;
}
export function sessionKey(provider: string, sessionId: string): string { return JSON.stringify([provider, sessionId]); }

// Cache metadata, never native contents. Every use still lists directories and lstats
// every record; directory mtime alone cannot detect edits to an existing JSON.
let cachedRoot: string | undefined;
let records = new Map<string, { signature: string; agent: NativeAgent }>();
export function signature(stat: BigIntStats): string {
  return [stat.dev, stat.ino, stat.mode, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
}
export interface NativeBatchTargets { agentIds: string[]; sessions: Array<{ provider: string; sessionId: string }> }

/** One async metadata validation pass; parse only changed records. Never opens jsonl. */
export async function indexNativeAgents(targets?: NativeBatchTargets): Promise<NativeAgentIndex> {
  const index: NativeAgentIndex = { agents: new Map(), sessions: new Map() };
  try {
    const root = agentsDir();
    if ((await lstat(root)).isSymbolicLink()) throw new Error(t("nativeAgentIndex.error.rootSymlink"));
    if (cachedRoot !== root) { records = new Map(); cachedRoot = root; }
    const next = new Map<string, { signature: string; agent: NativeAgent }>();
    const dirs = await readdir(root, { withFileTypes: true });
    const files: Array<{ path: string; id: string }> = [];
    for (const dir of dirs) {
      if (dir.isSymbolicLink()) throw new Error(t("nativeAgentIndex.error.dirSymlink"));
      if (!dir.isDirectory()) continue;
      for (const file of await readdir(join(root, dir.name), { withFileTypes: true })) {
        if (!file.name.endsWith(".json")) continue;
        const id = file.name.slice(0, -5);
        if (!SAFE_NATIVE_ID.test(id) || !file.isFile()) throw new Error(t("nativeAgentIndex.error.unsafeFile"));
        files.push({ path: join(root, dir.name, file.name), id });
      }
    }
    const indexFile = async (file: { path: string; id: string }) => {
      const stat = await lstat(file.path, { bigint: true });
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error(t("nativeAgentIndex.error.unsafeRecord"));
      const stamp = signature(stat);
      const saved = records.get(file.path);
      const agent = saved?.signature === stamp ? saved.agent : await readRecord(file.path, file.id, stat);
      if (targets && saved?.signature !== stamp && signature(await lstat(file.path, { bigint: true })) !== stamp) throw new Error(t("nativeAgentIndex.error.changedWhileReading"));
      next.set(file.path, { signature: stamp, agent });
      if (index.agents.has(agent.id)) throw new Error(t("nativeAgentIndex.error.duplicate"));
      index.agents.set(agent.id, agent);
    };
    let cursor = 0;
    const reads = await Promise.allSettled(Array.from({ length: Math.min(16, files.length) }, async () => {
      while (cursor < files.length) {
        try { await indexFile(files[cursor++]); }
        catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; /* removed mid-scan: skip only this file */ }
      }
    }));
    const failed = reads.find(result => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
    records = next;
    const wanted = targets ? new Set(targets.sessions.map(s => sessionKey(s.provider, s.sessionId))) : undefined;
    // A queued owner may have acquired a new handle since capture. Include that
    // handle too, so a stale queue cannot bypass protection of a shared session.
    for (const id of targets?.agentIds ?? []) {
      const agent = index.agents.get(id);
      for (const sid of [agent?.persistence?.sessionId, agent?.persistence?.nativeHandle]) {
        if (agent && typeof sid === "string" && sid) wanted?.add(sessionKey(agent.provider, sid));
      }
    }
    for (const agent of index.agents.values()) {
      for (const sid of new Set([agent.persistence?.sessionId, agent.persistence?.nativeHandle])) {
        if (typeof sid !== "string" || !sid) continue;
        const key = sessionKey(agent.provider, sid);
        if (wanted && !wanted.has(key)) continue;
        const group = index.sessions.get(key) ?? [];
        group.push(agent); index.sessions.set(key, group);
      }
    }
    if (targets) for (const id of index.agents.keys()) if (!targets.agentIds.includes(id)) index.agents.delete(id);
  } catch (err) { records.clear(); index.error = t("nativeAgentIndex.error.sharedSessionUnknown", { error: err instanceof Error ? err.message : String(err) }); }
  return index;
}
