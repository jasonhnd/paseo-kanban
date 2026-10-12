/// <reference types="node" />
import { providerBanned } from "../../shared/fleet/provider-policy";
import { readBannedProviders } from "./adapters/config";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { ROLE_ORDER } from "../../shared/fleet/board";
import { isLeaderTitle } from "../../shared/fleet/leader-title";
import { cached, CONFIG, type Json, PASEO_DIR, readJson } from "./util";

export { isLeaderTitle };

export interface Profile {
  id: string;
  role?: string;
  name: string;
  family?: string;
  provider: string;
  model?: string;
  modeId?: string;
  thinkingOptionId?: string;
  featureValues?: Record<string, unknown>;
  pool?: string;
}

export interface AgentRecord {
  id: string;
  title: string;
  labels: Record<string, string>;
  provider: string;
  model: string;
  cwd: string;
  status: string;
  createdAt: string | null;
  updatedAt: string | null;
  lastActivityAt: string | null;
  attentionReason: string | null;
  requiresAttention: boolean;
  lastError: string | null;
  finishedAt: string | null;
  archivedAt: string | null;
  parentId: string | null;
  sessionId: string | null;
  workspaceId: string | null;
  role: string | null;
  modeId: string | null;
  thinkingOptionId: string | null;
  featureValues: Record<string, unknown>;
}

export async function readRoleProfiles(): Promise<Profile[]> {
  const profiles = await readAllProfiles();
  return profiles.filter((p) => (ROLE_ORDER as readonly string[]).includes(p.role ?? ""));
}

/** Every named profile that spends a quota pool, including candidates the role list does not show. */
export async function readPoolProfiles(): Promise<Array<Pick<Profile, "name" | "pool" | "model" | "role">>> {
  const profiles = await readAllProfiles();
  return profiles
    .filter((p) => typeof p.pool === "string" && p.pool.length > 0)
    .map((p) => ({ name: p.name, pool: p.pool, model: p.model, role: p.role }));
}

export async function readAllProfiles(): Promise<Profile[]> {
  const cfg = await readJson<Json>(CONFIG, {});
  const raw = cfg?.daemon?.agentProfiles;
  const profiles: Profile[] = Array.isArray(raw) ? raw : [];
  return profiles.filter((p) => p && typeof p === "object" && typeof p.name === "string" && !providerBanned(p, readBannedProviders()));
}

export function nameToRoleKey(profiles: Profile[]): Map<string, string> {
  return new Map(profiles.map((p) => [p.name, p.role as string]));
}

const ROLE_ALIASES: Record<string, string> = {
  execute: "executor", exec: "executor", executor: "executor",
  review: "reviewer", reviewer: "reviewer",
  supervise: "supervisor", supervisor: "supervisor",
  read: "reader", reader: "reader",
  decide: "decision", decision: "decision",
  batch: "batch",
  ops_vercel: "ops_vercel", ops_cloudflare: "ops_cloudflare", ops_github: "ops_github", ops_notion: "ops_notion",
};

export function roleOf(title: string, labels: Record<string, string> | undefined, names: Map<string, string>): string | null {
  const label = labels?.role;
  if (label && label !== "personal") return ROLE_ALIASES[label] ?? names.get(label) ?? label;
  if (isLeaderTitle(title)) return "supervisor";
  const m = /^【([^】]+)】/.exec(title);
  return m ? (names.get(m[1]) ?? null) : null;
}

export function modelIdOf(p: Profile): string {
  return `${p.provider}/${p.model ?? "?"}`;
}

const isPlainObject = (value: unknown): value is Json => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/**
 * Every parseable JSON object under `<paseoDir>/agents/<dir>/*.json`.
 * A missing agents root (ENOENT) returns an empty list; other root read failures return null.
 * Unreadable sub-directories and files that are not JSON objects are skipped.
 */
export async function readAgentRecordFiles(paseoDir: string = PASEO_DIR): Promise<Json[] | null> {
  const root = join(paseoDir, "agents");
  let dirs: string[];
  try {
    dirs = await readdir(root);
  } catch (error) {
    // A new daemon has no records directory until its first agent is persisted.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    console.error("[afc] cannot read the agent records directory:", String(error).slice(0, 160));
    return null;
  }
  const out: Json[] = [];
  let badDirs = 0;
  let badFiles = 0;
  let lastError: unknown = null;
  for (const dir of dirs) {
    let files: string[];
    try {
      files = await readdir(join(root, dir));
    } catch (error) {
      badDirs += 1;
      lastError = error;
      continue;
    }
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const parsed: unknown = JSON.parse(await readFile(join(root, dir, file), "utf8"));
        if (isPlainObject(parsed)) out.push(parsed);
      } catch (error) {
        // A half-written or removed record: the next 15 s refresh picks it up.
        badFiles += 1;
        lastError = error;
      }
    }
  }
  if (badDirs + badFiles > 0) {
    console.error(`[afc] agent records: skipped ${badDirs} unreadable directories and ${badFiles} bad files; last error:`, String(lastError).slice(0, 160));
  }
  return out;
}

function toAgentRecord(d: Json, names: Map<string, string>): AgentRecord {
  const title = String(d.title ?? "");
  const labels = isPlainObject(d.labels) ? (d.labels as Record<string, string>) : {};
  const config = d.config && typeof d.config === "object" ? (d.config as Json) : {};
  const runtime = d.runtimeInfo && typeof d.runtimeInfo === "object" ? (d.runtimeInfo as Json) : {};
  const persistence = d.persistence && typeof d.persistence === "object" ? (d.persistence as Json) : {};
  return {
    id: d.id,
    title,
    labels,
    provider: String(d.provider ?? ""),
    model: String(config.model ?? runtime.model ?? ""),
    cwd: String(d.cwd ?? ""),
    status: String(d.lastStatus ?? "unknown"),
    createdAt: d.createdAt ?? null,
    updatedAt: d.updatedAt ?? null,
    lastActivityAt: d.lastActivityAt ?? d.updatedAt ?? null,
    attentionReason: d.attentionReason ?? null,
    requiresAttention: Boolean(d.requiresAttention),
    lastError: d.lastError ?? null,
    finishedAt: d.attentionReason === "finished" ? (d.attentionTimestamp ?? null) : null,
    archivedAt: d.archivedAt ?? null,
    parentId: labels["paseo.parent-agent-id"] ?? null,
    sessionId: persistence.nativeHandle ?? persistence.sessionId ?? null,
    workspaceId: d.workspaceId ?? null,
    role: roleOf(title, labels, names),
    modeId: typeof config.modeId === "string" ? config.modeId : (typeof d.lastModeId === "string" ? d.lastModeId : null),
    thinkingOptionId: typeof config.thinkingOptionId === "string" ? config.thinkingOptionId : null,
    featureValues: isPlainObject(config.featureValues) ? (config.featureValues as Record<string, unknown>) : {},
  };
}

/** Every agent record Paseo persisted on disk (includes archived ones). Cached 15 s. */
export function readAgentRecords(): Promise<AgentRecord[]> {
  return cached("records", 15_000, async () => {
    const profiles = await readRoleProfiles();
    const names = nameToRoleKey(profiles);
    const files = (await readAgentRecordFiles(PASEO_DIR)) ?? [];
    return files.filter((d) => typeof d.id === "string" && d.id).map((d) => toAgentRecord(d, names));
  });
}
