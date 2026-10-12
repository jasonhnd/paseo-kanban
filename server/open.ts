/// <reference types="node" />
import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "./perf-fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { getDb } from "./db";
import { isProjectMain, projectMain, samePath, type ListedWorkspace } from "./placement";
import { projectRoot } from "./paths";
import { isLeaderSessionTitle } from "./supervisor";
import { bucketsHolding, listAgentRecords } from "./agent-index";
import { t } from "../shared/i18n";

const PASEO_DIR = join(homedir(), ".paseo");
const PASEO_BIN = join(homedir(), ".local", "bin", "paseo");

export function agentsDir(): string {
  return process.env.KANBAN_AGENTS_DIR ?? join(PASEO_DIR, "agents");
}

export interface AgentFile {
  id: string;
  cwd: string;
  workspaceId: string | null;
  labels: Record<string, string>;
  featureValues: Record<string, unknown> | null;
  createdAt: string | null;
  archivedAt: string | null;
  lastStatus: string | null;
  updatedAt: string | null;
  lastActivityAt: string | null;
  lastUserMessageAt: string | null;
  attentionReason: string | null;
  attentionTimestamp: string | null;
  /** Provider text for the last error, when the record has it. Empty means the field was absent. */
  lastError: string | null;
  title: string;
  provider: string;
  model: string | null;
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr || err.message).slice(0, 300)));
      else resolve(stdout);
    });
  });
}

export type AgentRecordRead = { state: "ok"; file: AgentFile } | { state: "missing" } | { state: "unreadable" };

/** True only when the agent root directory itself is absent. A path that exists but cannot be listed is not this. */
export function agentsRootMissing(): boolean {
  try {
    readdirSync(agentsDir());
    return false;
  } catch (err) {
    return Boolean(err && typeof err === "object" && "code" in err && err.code === "ENOENT");
  }
}

/** Which bucket directory an agent file was last found in, so repeat reads go straight to it. */
const bucketCache = new Map<string, string>();

/** Read one agent record. A missing directory or a half-written file is unreadable, not proof the agent is gone. */
export function readAgentRecord(agentId: string): AgentRecordRead {
  const root = agentsDir();
  const key = `${root}\0${agentId}`;
  const cached = bucketCache.get(key);
  if (cached) {
    const hit = readAgentAt(root, cached, agentId);
    if (hit) return hit;
    bucketCache.delete(key);
  }
  const dirs = bucketsHolding(root, agentId);
  if (dirs == null) return { state: "unreadable" };
  for (const dir of dirs) {
    if (dir === cached) continue;
    const hit = readAgentAt(root, dir, agentId);
    if (!hit) continue;
    bucketCache.set(key, dir);
    return hit;
  }
  return { state: "missing" };
}

/** The record in one bucket, or null when that bucket has no file for this agent. */
function readAgentAt(root: string, dir: string, agentId: string): AgentRecordRead | null {
  const path = join(root, dir, `${agentId}.json`);
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as {
      id?: string;
      cwd?: string;
      workspaceId?: string | null;
      labels?: Record<string, string>;
      title?: string;
      provider?: string;
      archivedAt?: string | null;
      lastStatus?: string | null;
      config?: { featureValues?: Record<string, unknown>; model?: string };
      createdAt?: string;
      updatedAt?: string;
      lastActivityAt?: string;
      lastUserMessageAt?: string;
      attentionReason?: string | null;
      attentionTimestamp?: string | null;
      lastError?: string | null;
    };
    if (data.archivedAt != null && typeof data.archivedAt !== "string") {
      console.error("[paseo-kanban] agent file", `${agentId}: archivedAt is not a string; treating it as not archived`);
    }
    const labels = data.labels && typeof data.labels === "object" && !Array.isArray(data.labels) ? data.labels : {};
    if (data.labels != null && (typeof data.labels !== "object" || Array.isArray(data.labels))) {
      console.error("[paseo-kanban] agent file", `${agentId}: labels is not an object; treating it as no labels`);
    }
    return {
      state: "ok",
      file: {
        id: String(data.id ?? agentId),
        cwd: String(data.cwd ?? ""),
        workspaceId: data.workspaceId ?? null,
        labels,
        featureValues:
          data.config?.featureValues && typeof data.config.featureValues === "object" && !Array.isArray(data.config.featureValues)
            ? data.config.featureValues
            : null,
        createdAt: typeof data.createdAt === "string" ? data.createdAt : null,
        archivedAt: typeof data.archivedAt === "string" ? data.archivedAt : null,
        lastStatus: typeof data.lastStatus === "string" ? data.lastStatus : null,
        updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : null,
        lastActivityAt: typeof data.lastActivityAt === "string" ? data.lastActivityAt : null,
        lastUserMessageAt: typeof data.lastUserMessageAt === "string" && data.lastUserMessageAt ? data.lastUserMessageAt : null,
        attentionReason: typeof data.attentionReason === "string" ? data.attentionReason : null,
        attentionTimestamp: typeof data.attentionTimestamp === "string" ? data.attentionTimestamp : null,
        lastError: typeof data.lastError === "string" && data.lastError ? data.lastError : null,
        title: typeof data.title === "string" ? data.title : "",
        provider: typeof data.provider === "string" ? data.provider : "",
        model: typeof data.config?.model === "string" ? data.config.model : null,
      },
    };
  } catch (err) {
    console.error("[paseo-kanban] agent file", `${agentId} is unreadable: ${err instanceof Error ? err.message : err}`);
    return { state: "unreadable" };
  }
}

export function findAgentFile(agentId: string): AgentFile | null {
  const read = readAgentRecord(agentId);
  return read.state === "ok" ? read.file : null;
}

/** When the agent was created. Backfill uses this instead of the registration clock. */
export function agentCreatedAt(agentId: string): string | null {
  return findAgentFile(agentId)?.createdAt ?? null;
}

export async function openAgent(agentId: string): Promise<{ ok: boolean; message: string }> {
  const rec = findAgentFile(agentId);
  if (rec && rec.cwd && !existsSync(rec.cwd)) {
    return { ok: false, message: t("open.cwdMissing", { cwd: rec.cwd }) };
  }
  try {
    const out = await run(PASEO_BIN, ["agent", "open", agentId, "--json"], 15_000);
    return { ok: /"opened"/.test(out), message: out.trim().slice(0, 200) };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

export type AgentLiveness = "alive" | "closed" | "error" | "archived" | "missing";

export function agentLiveness(agentId: string | null): AgentLiveness {
  if (!agentId) return "missing";
  const file = findAgentFile(agentId);
  if (!file) return "missing";
  if (file.archivedAt) return "archived";
  if (file.lastStatus === "error") return "error";
  if (file.lastStatus === "closed") return "closed";
  return "alive";
}

/** Archived or missing agents cannot take a wake-up message. Closed ones still can. */
export function agentRecordUsable(agentId: string): boolean {
  const file = findAgentFile(agentId);
  return Boolean(file && !file.archivedAt);
}

export interface AgentChoice {
  id: string;
  title: string;
  archived: boolean;
  closed: boolean;
  createdAt: string | null;
  role: string | null;
}

function readAgentFiles(): AgentFile[] {
  const records = listAgentRecords(agentsDir()) ?? [];
  const found: AgentFile[] = [];
  for (const { id } of records) {
    const file = findAgentFile(id);
    if (file) found.push(file);
  }
  return found;
}

function openedByHand(file: AgentFile): boolean {
  const label = file.labels.kanban;
  return label === undefined || label === "";
}

function supervisorLike(file: AgentFile): boolean {
  return file.labels.role === "supervisor" || isLeaderSessionTitle(file.title);
}

/** `listed` comes from the daemon API (listPaseoWorkspaces); this module no longer reads Paseo's private workspaces.json. */
/** Directory of a Kanban project's main checkout, using a card path or a workspace named like the project. */
export function directoryForProject(project: string, listed: ListedWorkspace[]): string | null {
  const name = project.trim();
  if (!name) return null;
  let rows: Array<{ workspace_path: string | null }> = [];
  try {
    rows = getDb()
      .prepare(`SELECT workspace_path FROM tasks WHERE project = ? AND workspace_path IS NOT NULL ORDER BY id DESC`)
      .all(name) as Array<{ workspace_path: string | null }>;
  } catch {
    rows = [];
  }
  for (const row of rows) {
    if (!row.workspace_path) continue;
    const hit = listed.find((entry) => samePath(entry.directory, row.workspace_path));
    const root = hit?.projectRoot || row.workspace_path;
    const main = projectMain(listed, root);
    if (main?.directory) return main.directory;
  }
  const named = listed.find((entry) => isProjectMain(entry) && entry.directory && basename(entry.directory) === name);
  return named?.directory ?? null;
}

/** Agents the user opened by hand in a project's main workspace. Kanban workers stay off the list. */
export function listAgentChoices(listed: ListedWorkspace[], directory = projectRoot()): { suggestedId: string | null; agents: AgentChoice[] } {
  const main = projectMain(listed, directory);
  if (!main) return { suggestedId: null, agents: [] };
  const found = readAgentFiles().filter((file) => file.workspaceId === main.id && !file.archivedAt && openedByHand(file));
  found.sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")));
  const visible = found.slice(0, 40);
  const suggested = visible.find((file) => supervisorLike(file) && file.lastStatus !== "closed") ?? visible.find((file) => supervisorLike(file));
  return {
    suggestedId: suggested?.id ?? null,
    agents: visible.map((file) => ({
      id: file.id,
      title: file.title || file.id,
      archived: false,
      closed: file.lastStatus === "closed",
      createdAt: file.createdAt,
      role: file.labels.role ?? null,
    })),
  };
}

export function agentLink(agentId: string): { url: string | null; message: string } {
  const rec = findAgentFile(agentId);
  if (!rec?.workspaceId) return { url: null, message: t("open.noProject") };
  if (rec.cwd && !existsSync(rec.cwd)) {
    return { url: null, message: t("open.cwdMissing", { cwd: rec.cwd }) };
  }
  let serverId = "";
  try {
    serverId = readFileSync(join(PASEO_DIR, "server-id"), "utf8").trim();
  } catch {
    return { url: null, message: t("open.noServerId") };
  }
  const url = `paseo://h/${encodeURIComponent(serverId)}/workspace/${encodeURIComponent(rec.workspaceId)}?open=${encodeURIComponent(`agent:${agentId}`)}`;
  return { url, message: "" };
}
