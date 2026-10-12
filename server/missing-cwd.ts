/// <reference types="node" />
import { createNativeAgentReader, type NativeAgentReader } from "./native-agent-index";
import { prepareNativeSessionsForPurge, nativeSessionAfterPurge } from "./native-sessions";
import { execFile } from "node:child_process";
import { commandInvocation } from "./command-invocation";
import { createHash } from "node:crypto";
import { agentIndexGeneration, agentIndexTtlMs, forgetAgentRecord, invalidateAgentIndex } from "./agent-index";
import { pruneCachedRecords, readCachedRecord } from "./agent-snapshot";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "./perf-fs";
import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { archiveSucceeded, cleanupFinished, readCleanupEvents } from "./archive-book";
import { addBoardWakeMark, hasBoardWakeMark } from "./board-wake-marks";
import { DEFAULT_MISSING_CWD_PATROL_MS, loadConfig, loadConfigForReport } from "./config";
import { getDb } from "./db";
import { cardMark } from "./card-ref";
import { KanbanError } from "./errors";
import { agentsDir, findAgentFile } from "./open";
import { SAFE_AGENT_ID } from "./agent-id";
import { checkoutsRoot, dataDir, paseoWorktreesRoot, pluginRoot } from "./paths";
import { addDecision, listDecisions } from "./decisions";
import { statusLabel } from "../shared/labels";
import { LANGUAGES, t, translate, type MessageKey, type MessageVars } from "../shared/i18n";
import { addComment, appendEvent, getTask } from "./store";

export const PLACEHOLDER_NAME = "README-placeholder.txt";

const PASEO_BIN = join(homedir(), ".local", "bin", "paseo");

export interface CwdAgent {
  id: string;
  cwd: string;
  provider: string;
  title: string;
  archived: boolean;
  lastActivityAt: string | null;
  labels: Record<string, string>;
}

export type DirectoryState = "missing" | "placeholder" | "present";

export interface ProblemAgent {
  agent: CwdAgent;
  state: "missing" | "placeholder";
  kanban: boolean;
}

export interface MissingCwdItem {
  agentId: string;
  cwd: string;
  title: string;
  archived: boolean;
}

/** Shape AFC reads from `bin/check-missing-cwd --json`. `items` are only the missing directories, so `items.length === count`. */
export interface MissingCwdReport {
  checkedAt: string;
  count: number;
  placeholder: number;
  listPath: string;
  items: MissingCwdItem[];
}

interface CardLink {
  id: number;
  status: string;
  title: string;
  handoff_json: string | null;
}

export interface MissingCwdHooks {
  listAgents?: () => CwdAgent[] | null;
  deleteAgent?: (agentId: string) => Promise<void>;
  recordPurge?: (taskId: number, agent: CwdAgent, summary: string) => void;
  decideList?: () => Promise<string>;
  decideAdd?: (input: { title: string; detail: string }) => Promise<void>;
  log?: (line: string) => void;
}

interface Notice {
  foreignAgents: number;
  skippedWakes: number;
}

const notice: Notice = { foreignAgents: 0, skippedWakes: 0 };
const skippedWakes = new Set<string>();
const skippedPlaceholders = new Set<string>();
let hooks: MissingCwdHooks = {};
let patrolTimer: ReturnType<typeof setInterval> | null = null;

export function setMissingCwdHooks(next: MissingCwdHooks | null): void {
  hooks = next ?? {};
}

export function resetMissingCwdForTests(): void {
  hooks = {};
  notice.foreignAgents = 0;
  notice.skippedWakes = 0;
  skippedWakes.clear();
  skippedPlaceholders.clear();
  snapshot = null;
  if (patrolTimer) {
    clearInterval(patrolTimer);
    patrolTimer = null;
  }
}

export function missingCwdMessage(): string | null {
  const count = notice.foreignAgents > 0 ? notice.foreignAgents : notice.skippedWakes;
  if (count <= 0) return null;
  return t("missingCwd.message", { count });
}

function logLine(line: string): void {
  if (hooks.log) hooks.log(line);
  else console.error(`[paseo-kanban] missing-cwd ${line}`);
}

export function pathWithin(parent: string, child: string): boolean {
  if (!parent.trim() || !child.trim()) return false;
  const base = resolve(parent);
  const dir = resolve(child);
  if (base === dir) return true;
  const rel = relative(base, dir);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

export function directoryState(cwd: string): DirectoryState {
  if (!cwd.trim() || !existsSync(cwd)) return "missing";
  if (existsSync(join(cwd, PLACEHOLDER_NAME))) return "placeholder";
  return "present";
}

export function autoPlaceholderPath(cwd: string): boolean {
  return pathWithin(paseoWorktreesRoot(), cwd) || pathWithin(checkoutsRoot(), cwd);
}

export function pathSetKey(paths: string[]): string {
  return [...new Set(paths.map((item) => resolve(item)))].sort().join("\n");
}

export function pathSetFingerprint(paths: string[]): string {
  return createHash("sha256").update(pathSetKey(paths)).digest("hex").slice(0, 8);
}

/** Reason a placeholder stays because the agent list could not be read. Callers compare against it in the same process. */
export function agentListUnreadReason(): string {
  return t("missingCwd.unreadAgentList");
}

function fsErrorCode(err: unknown): string {
  return err && typeof err === "object" && "code" in err && typeof err.code === "string" ? err.code : "";
}

/** The name was listed, then disappeared or was not a directory. That is not a failed read. */
function entryGone(err: unknown): boolean {
  return fsErrorCode(err) === "ENOENT" || fsErrorCode(err) === "ENOTDIR";
}

interface AgentScan {
  agents: CwdAgent[];
  byId: Map<string, CwdAgent>;
  /** The root could not be listed. */
  rootUnreadable: boolean;
  /** A bucket or agent file could not be read or parsed. */
  partial: boolean;
}

function parseCwdAgent(name: string, data: unknown): CwdAgent | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  const id = typeof record.id === "string" && record.id ? record.id : name.slice(0, -".json".length);
  const labels =
    record.labels && typeof record.labels === "object" && !Array.isArray(record.labels)
      ? (record.labels as Record<string, string>)
      : {};
  const lastActivity =
    typeof record.lastActivityAt === "string"
      ? record.lastActivityAt
      : typeof record.updatedAt === "string"
        ? record.updatedAt
        : null;
  return {
    id,
    cwd: typeof record.cwd === "string" ? record.cwd : "",
    provider: typeof record.provider === "string" ? record.provider : "",
    title: typeof record.title === "string" ? record.title : "",
    archived: typeof record.archivedAt === "string" && record.archivedAt.length > 0,
    lastActivityAt: lastActivity,
    labels,
  };
}

function scanAgentFiles(root: string): AgentScan {
  const agents: CwdAgent[] = [];
  const seen = new Set<string>();
  const finish = (rootUnreadable: boolean, partial: boolean): AgentScan => {
    // A failed root listing proves nothing about the files, so only a real listing prunes.
    if (!rootUnreadable) pruneCachedRecords(seen);
    return { agents, byId: new Map(agents.map((agent) => [agent.id, agent])), rootUnreadable, partial };
  };
  let dirs: string[] = [];
  try {
    dirs = readdirSync(root);
  } catch (err) {
    if (fsErrorCode(err) === "ENOENT") return finish(false, false);
    logLine(`cannot read agent directory ${root}: ${err instanceof Error ? err.message : err}`);
    return finish(true, false);
  }
  let partial = false;
  for (const dir of dirs) {
    const bucket = join(root, dir);
    let info: ReturnType<typeof statSync>;
    try {
      info = statSync(bucket);
    } catch (err) {
      if (entryGone(err)) continue;
      logLine(`cannot read ${bucket}: ${err instanceof Error ? err.message : err}`);
      partial = true;
      continue;
    }
    if (!info.isDirectory()) continue;
    let names: string[] = [];
    try {
      names = readdirSync(bucket);
    } catch (err) {
      if (entryGone(err)) continue;
      logLine(`cannot read agent directory ${bucket}: ${err instanceof Error ? err.message : err}`);
      partial = true;
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const path = join(bucket, name);
      try {
        const agent = readCachedRecord(path, (data) => parseCwdAgent(name, data));
        seen.add(path);
        if (agent) agents.push(agent);
      } catch (err) {
        if (entryGone(err)) continue;
        logLine(`cannot read ${name}: ${err instanceof Error ? err.message : err}`);
        partial = true;
      }
    }
  }
  return finish(false, partial);
}

let snapshot: { root: string; at: number; generation: number; scan: AgentScan } | null = null;

/**
 * One listing shared by every caller within the agent-index TTL (zero under tests), and dropped
 * whenever cleanup calls invalidateAgentIndex(). Records themselves come from the signature cache.
 */
function agentScan(root: string): AgentScan {
  const now = Date.now();
  if (snapshot && snapshot.root === root && snapshot.generation === agentIndexGeneration() && now - snapshot.at < agentIndexTtlMs()) {
    return snapshot.scan;
  }
  const scan = scanAgentFiles(root);
  snapshot = { root, at: now, generation: agentIndexGeneration(), scan };
  return scan;
}

/**
 * An agent record was just deleted. Take it out of the shared listing and the bucket index in place, so a
 * batch of deletions does not make every following lookup list and stat the whole agents directory again.
 */
export function forgetPurgedAgent(agentId: string): void {
  forgetAgentRecord(agentId);
  if (!snapshot) return;
  const agents = snapshot.scan.agents.filter((agent) => agent.id !== agentId);
  const byId = new Map(snapshot.scan.byId);
  byId.delete(agentId);
  snapshot = { ...snapshot, scan: { ...snapshot.scan, agents, byId } };
}

/**
 * null when the agent directory cannot be listed.
 * [] means every entry was read and there are no agent files, or the directory itself is missing (ENOENT).
 * Other errors listing the root stay null so cleanup keeps the placeholder.
 * In strict mode a real directory or agent file that cannot be read or parsed is null,
 * so a deletion does not treat a partial list as "nobody is here".
 * A file sitting next to the buckets, or an entry that is already gone, is skipped.
 */
function readAgentFiles(root = agentsDir(), strict = false): CwdAgent[] | null {
  const scan = agentScan(root);
  if (scan.rootUnreadable || (strict && scan.partial)) return null;
  return scan.agents;
}

/** O(1) lookup by id against the shared snapshot. Undefined when unknown or the list cannot be read. */
export function findCwdAgent(agentId: string): CwdAgent | undefined {
  if (hooks.listAgents) return hooks.listAgents()?.find((agent) => agent.id === agentId);
  const scan = agentScan(agentsDir());
  return scan.rootUnreadable ? undefined : scan.byId.get(agentId);
}

/**
 * null when the agent directory cannot be read. A hook that returns a list is a successful read.
 * [] means the directory was read and no agents are on disk, or the directory itself is missing (ENOENT).
 */
export function loadCwdAgentList(): CwdAgent[] | null {
  if (hooks.listAgents) return hooks.listAgents();
  return readAgentFiles();
}

/**
 * null when the list cannot be read, a bucket or agent file cannot be read, or the hook throws.
 * A hook that returns a list is a successful read. Deletion uses this, not the lenient patrol list.
 */
export function readCwdAgentList(): CwdAgent[] | null {
  try {
    if (hooks.listAgents) return hooks.listAgents();
    return readAgentFiles(agentsDir(), true);
  } catch (err) {
    logLine(`cannot read the agent list: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

export function loadCwdAgents(): CwdAgent[] {
  return loadCwdAgentList() ?? [];
}

export function agentsTouching(directory: string, agents: CwdAgent[]): CwdAgent[] {
  return agents.filter((agent) => agent.cwd.trim() && pathWithin(directory, agent.cwd));
}

function loadKanbanAgentIds(): Set<string> {
  const ids = new Set<string>();
  const path = join(dataDir(), "kanban.db");
  if (!existsSync(path)) return ids;
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path, { readOnly: true });
  } catch (err) {
    logLine(`cannot open the board database read-only: ${err instanceof Error ? err.message : err}`);
    return ids;
  }
  try {
    const runs = db.prepare("SELECT agent_id FROM runs WHERE agent_id IS NOT NULL").all() as Array<{ agent_id: string }>;
    for (const row of runs) ids.add(row.agent_id);
    const tasks = db.prepare("SELECT agent_id, executor_agent_id FROM tasks").all() as Array<{
      agent_id: string | null;
      executor_agent_id: string | null;
    }>;
    for (const row of tasks) {
      if (row.agent_id) ids.add(row.agent_id);
      if (row.executor_agent_id) ids.add(row.executor_agent_id);
    }
    const tokens = db.prepare("SELECT agent_id FROM tokens WHERE agent_id IS NOT NULL").all() as Array<{ agent_id: string }>;
    for (const row of tokens) ids.add(row.agent_id);
  } catch (err) {
    logLine(`cannot read agents from the board database: ${err instanceof Error ? err.message : err}`);
  } finally {
    db.close();
  }
  return ids;
}

export function labelSaysKanban(labels: Record<string, string>): boolean {
  return labels.kanban === "1" || labels.kanban === "true";
}

const PARENT_LABEL = "paseo.parent-agent-id";

/** The agent this one was spawned from, when it carries Paseo's parent label. */
function parentAgentId(labels: Record<string, string>): string | null {
  const parent = labels[PARENT_LABEL];
  return typeof parent === "string" && parent.trim() ? parent.trim() : null;
}

export function kanbanOpened(agentId: string, labels: Record<string, string> = {}, ids?: Set<string>): boolean {
  if (labelSaysKanban(labels)) return true;
  if (ids) {
    const parent = parentAgentId(labels);
    return ids.has(agentId) || (parent !== null && ids.has(parent));
  }
  const parent = parentAgentId(labels);
  if (parent && kanbanOpened(parent)) return true;
  const db = getDb();
  const run = db.prepare("SELECT 1 AS n FROM runs WHERE agent_id = ? LIMIT 1").get(agentId);
  if (run) return true;
  const task = db.prepare("SELECT 1 AS n FROM tasks WHERE agent_id = ? OR executor_agent_id = ? LIMIT 1").get(agentId, agentId);
  if (task) return true;
  const token = db.prepare("SELECT 1 AS n FROM tokens WHERE agent_id = ? LIMIT 1").get(agentId);
  return Boolean(token);
}

function cardsForAgent(agentId: string, labels: Record<string, string>): CardLink[] {
  const db = getDb();
  const map = new Map<number, CardLink>();
  const take = (rows: CardLink[]) => {
    for (const row of rows) map.set(row.id, row);
  };
  take(
    db
      .prepare("SELECT id, status, title, handoff_json FROM tasks WHERE agent_id = ? OR executor_agent_id = ?")
      .all(agentId, agentId) as unknown as CardLink[],
  );
  take(
    db
      .prepare(
        `SELECT t.id, t.status, t.title, t.handoff_json FROM runs r JOIN tasks t ON t.id = r.task_id WHERE r.agent_id = ?`,
      )
      .all(agentId) as unknown as CardLink[],
  );
  take(
    db
      .prepare(
        `SELECT t.id, t.status, t.title, t.handoff_json FROM tokens k JOIN tasks t ON t.id = k.task_id WHERE k.agent_id = ?`,
      )
      .all(agentId) as unknown as CardLink[],
  );
  const parent = parentAgentId(labels);
  if (parent) for (const row of cardsForAgent(parent, {})) map.set(row.id, row);
  const labeled = labels.kanban_task;
  if (labeled && /^\d+$/.test(labeled)) {
    const row = db.prepare("SELECT id, status, title, handoff_json FROM tasks WHERE id = ?").get(Number(labeled)) as unknown as CardLink | undefined;
    if (row) map.set(row.id, row);
  }
  return [...map.values()];
}

function handoffText(raw: string | null): string {
  if (!raw?.trim()) return t("missingCwd.handoff.none");
  try {
    const parsed = JSON.parse(raw) as { summary?: unknown; handoff?: unknown };
    const summary = typeof parsed.summary === "string" ? parsed.summary : "";
    const body = parsed.handoff == null ? "" : typeof parsed.handoff === "string" ? parsed.handoff : JSON.stringify(parsed.handoff);
    return [summary, body].filter(Boolean).join("\n") || raw;
  } catch {
    return raw;
  }
}

export function purgeSummary(agent: CwdAgent, cards: CardLink[]): string {
  const handoff = cards.map((card) => `${cardMark(card.id)} ${handoffText(card.handoff_json)}`).join("\n");
  return [
    t("missingCwd.purge.title", { value: agent.title || t("missingCwd.purge.noTitle") }),
    t("missingCwd.purge.provider", { value: agent.provider || t("missingCwd.none") }),
    t("missingCwd.purge.lastActivity", { value: agent.lastActivityAt || t("missingCwd.none") }),
    t("missingCwd.purge.handoff", { value: handoff || t("missingCwd.handoff.none") }),
    t("missingCwd.purge.source"),
  ].join("\n");
}

function defaultRecordPurge(taskId: number, agent: CwdAgent, summary: string): void {
  addComment(taskId, "kanban", t("missingCwd.purge.comment", { summary }));
  appendEvent(taskId, "agent_purged", null, null, "kanban", {
    agentId: agent.id,
    provider: agent.provider,
    title: agent.title,
    lastActivityAt: agent.lastActivityAt,
    summary,
  });
}

function finished(status: string): boolean {
  return status === "done" || status === "archived";
}

export function purgeDecision(agent: CwdAgent): { ok: true; cards: CardLink[]; summary: string } | { ok: false; reason: string } {
  if (!kanbanOpened(agent.id, agent.labels)) return { ok: false, reason: t("missingCwd.purge.notKanban") };
  const cards = cardsForAgent(agent.id, agent.labels);
  if (cards.length === 0) return { ok: false, reason: t("missingCwd.purge.noCards") };
  const open = cards.filter((card) => !finished(card.status));
  if (open.length > 0) return { ok: false, reason: t("missingCwd.purge.openCards", { cards: open.map((card) => cardMark(card.id)).join(t("common.listSep")) }) };
  return { ok: true, cards, summary: purgeSummary(agent, cards) };
}

async function runFile(cmd: string, args: string[], timeoutMs: number): Promise<string> {
  return await new Promise((resolvePromise, reject) => {
    const invocation = commandInvocation(cmd, args);
    execFile(invocation.command, invocation.args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const reason = [err.message, String(stderr).trim(), String(stdout).trim()]
          .filter(Boolean).map((part) => part.slice(0, 400)).join(t("common.semicolon"));
        reject(new Error(reason));
      }
      else resolvePromise(String(stdout));
    });
  });
}

/** Delete one agent by id. Never passes --all or --cwd. */
export async function deletePaseoAgent(agentId: string, exec: (cmd: string, args: string[]) => Promise<string> = (cmd, args) => runFile(cmd, args, 20_000)): Promise<void> {
  if (!SAFE_AGENT_ID.test(agentId)) throw new Error(t("missingCwd.error.unsafeId", { agent: agentId }));
  await exec(PASEO_BIN, ["agent", "delete", agentId, "--json"]);
}

async function deleteAgentRecord(agentId: string, readAgent?: NativeAgentReader): Promise<"purged" | "kept"> {
  let nativeCards: number[] = [];
  try { nativeCards = await prepareNativeSessionsForPurge(agentId, readAgent); } catch (err) { logLine(`native session lookup failed ${agentId}: ${String(err)}`); }
  try {
    await (hooks.deleteAgent ?? deletePaseoAgent)(agentId);
  } catch (err) {
    logLine(`delete failed ${agentId}: ${err instanceof Error ? err.message : err}`);
    return "kept";
  }
  // The record is gone now; the next listing must not still show it. Only this one entry is taken out.
  forgetPurgedAgent(agentId);
  for (const taskId of nativeCards) nativeSessionAfterPurge(taskId, agentId);
  return "purged";
}

export async function purgeAgent(agent: CwdAgent, readAgent?: NativeAgentReader): Promise<"purged" | "kept"> {
  const decision = purgeDecision(agent);
  if (!decision.ok) return "kept";
  const record = hooks.recordPurge ?? defaultRecordPurge;
  const fresh = decision.cards.filter((card) => !alreadyPurged(card.id, agent.id));
  try {
    for (const card of fresh) record(card.id, agent, decision.summary);
  } catch (err) {
    logLine(`writing notes failed, not deleting ${agent.id}: ${err instanceof Error ? err.message : err}`);
    return "kept";
  }
  return deleteAgentRecord(agent.id, readAgent);
}

export type AgentRunState = "busy" | "idle" | "gone" | "unknown";

/**
 * Delete agents that still point at a directory which is about to disappear.
 * A running agent is left in `waiting` and not deleted. The caller records that once
 * and looks again next round. A failed activity query, or an unreadable agent list, is left in `unread`:
 * the caller keeps the directory and retries with backoff. Agents that cannot be deleted stay in `kept`.
 */
export async function retainAgentsBeforeDirectoryRemoval(
  directory: string,
  running?: (agentId: string) => Promise<AgentRunState>,
): Promise<{ kept: CwdAgent[]; purged: string[]; waiting: string[]; unread: string[] }> {
  const listed = readCwdAgentList();
  if (listed == null) return { kept: [], purged: [], waiting: [], unread: [agentListUnreadReason()] };
  const touching = agentsTouching(directory, listed);
  const kept: CwdAgent[] = [];
  const purged: string[] = [];
  const waiting: string[] = [];
  const unread: string[] = [];
  const readAgent = createNativeAgentReader();
  for (const agent of touching) {
    if (running) {
      let state: AgentRunState;
      try {
        state = await running(agent.id);
      } catch (err) {
        logLine(`cannot tell whether ${agent.id} is running: ${err instanceof Error ? err.message : err}`);
        unread.push(agent.id);
        continue;
      }
      if (state === "busy") {
        waiting.push(agent.id);
        continue;
      }
      if (state === "unknown") {
        unread.push(agent.id);
        continue;
      }
    }
    const outcome = await purgeAgent(agent, readAgent);
    // An archived agent the board never opened cannot run again from here; it must not hold the directory.
    if (outcome === "kept" && agent.archived && !kanbanOpened(agent.id, agent.labels)) continue;
    if (outcome === "purged") purged.push(agent.id);
    else kept.push(agent);
  }
  return { kept, purged, waiting, unread };
}

function placeholderText(reason: string, agentIds: string[]): string {
  const who = agentIds.length > 0 ? agentIds.join(t("common.listSep")) : t("missingCwd.placeholder.unlisted");
  return [
    t("missingCwd.placeholder.intro"),
    t("missingCwd.placeholder.reason", { reason }),
    t("missingCwd.placeholder.agents", { agents: who }),
    t("missingCwd.placeholder.keep"),
    "",
  ].join("\n");
}

/** Creates the directory and README when needed. Returns false when the placeholder was already there. */
export function ensurePlaceholder(directory: string, reason: string, agentIds: string[]): boolean {
  if (!directory.trim()) return false;
  const readme = join(directory, PLACEHOLDER_NAME);
  if (existsSync(readme)) return false;
  mkdirSync(directory, { recursive: true });
  writeFileSync(readme, placeholderText(reason, agentIds));
  return true;
}

function recordPlaceholder(taskId: number | null, agentId: string | null, path: string, reason: string): void {
  if (taskId == null) {
    logLine(`placeholder agent=${agentId ?? "unknown"} path=${path} ${reason}`);
    return;
  }
  try {
    appendEvent(taskId, "cwd_placeholder", null, null, "kanban", { agentId, path, reason });
  } catch (err) {
    logLine(`cannot write cwd_placeholder to ${cardMark(taskId)}: ${err instanceof Error ? err.message : err}`);
  }
}

export function placeholderAfterRemoval(directory: string, kept: CwdAgent[] | "unknown", reason: string, taskId: number | null): void {
  if (existsSync(directory) && directoryState(directory) !== "missing") return;
  if (kept !== "unknown" && kept.length === 0) return;
  const agents = kept === "unknown" ? [] : kept;
  const paths = new Set<string>([directory]);
  for (const agent of agents) {
    if (pathWithin(directory, agent.cwd)) paths.add(resolve(agent.cwd));
  }
  const ids = agents.map((agent) => agent.id);
  let created = false;
  for (const path of paths) {
    if (ensurePlaceholder(path, reason, ids)) created = true;
  }
  if (!created) return;
  if (agents.length === 0) {
    recordPlaceholder(taskId, null, directory, reason);
    return;
  }
  for (const agent of agents) {
    const cards = cardsForAgent(agent.id, agent.labels);
    const targets = new Set<number>();
    if (taskId != null) targets.add(taskId);
    for (const card of cards) targets.add(card.id);
    if (targets.size === 0) recordPlaceholder(null, agent.id, agent.cwd, reason);
    for (const id of targets) recordPlaceholder(id, agent.id, agent.cwd || directory, reason);
  }
}

export function agentCwdMissing(agentId: string | null | undefined): string | null {
  if (!agentId) return null;
  const file = findAgentFile(agentId);
  if (!file?.cwd.trim()) return null;
  return directoryState(file.cwd) === "missing" ? file.cwd : null;
}

export function noteWakeSkipped(taskId: number | null, agentId: string, cwd: string, kind: string): void {
  const key = `${taskId ?? "board"}:${agentId}:${kind}`;
  if (skippedWakes.has(key)) return;
  skippedWakes.add(key);
  notice.skippedWakes += 1;
  if (taskId == null) {
    // No card to hang an event on: the persisted board mark keeps the log line from repeating after a reload.
    const mark = `skip:${agentId}:${kind}`;
    if (hasBoardWakeMark(mark)) return;
    addBoardWakeMark(mark);
    logLine(`wake skipped agent=${agentId} path=${cwd} kind=${kind}`);
    return;
  }
  try {
    // The set above is lost on a plugin reload; the card's own event log is the lasting record.
    const written = getDb()
      .prepare(`SELECT 1 AS n FROM events WHERE task_id = ? AND kind = 'wake_skipped_missing_cwd'
        AND json_extract(data_json, '$.agentId') = ? AND json_extract(data_json, '$.kind') = ? LIMIT 1`)
      .get(taskId, agentId, kind);
    if (written) return;
    const status = getTask(taskId).status;
    appendEvent(taskId, "wake_skipped_missing_cwd", null, status, "kanban", { agentId, cwd, kind });
  } catch (err) {
    logLine(`cannot write wake_skipped_missing_cwd to ${cardMark(taskId)}: ${err instanceof Error ? err.message : err}`);
  }
}

function registeredPath(): string {
  return join(dataDir(), "missing-cwd-registered.json");
}

/** Old files stored one newline-joined set. Each path is remembered on its own. */
function expandRegisteredKey(key: string): string[] {
  return key
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => resolve(item));
}

function readRegistered(): Set<string> {
  try {
    const data = JSON.parse(readFileSync(registeredPath(), "utf8")) as { keys?: unknown };
    if (!Array.isArray(data.keys)) return new Set();
    const paths = new Set<string>();
    for (const item of data.keys) {
      if (typeof item !== "string" || !item.trim()) continue;
      for (const path of expandRegisteredKey(item)) paths.add(path);
    }
    return paths;
  } catch {
    return new Set();
  }
}

function writeRegistered(paths: Set<string>): void {
  mkdirSync(dataDir(), { recursive: true });
  writeFileSync(registeredPath(), `${JSON.stringify({ keys: [...paths].sort() }, null, 2)}\n`);
}

function rememberPaths(paths: string[]): void {
  const stored = readRegistered();
  let changed = false;
  for (const path of paths) {
    const resolved = resolve(path);
    if (stored.has(resolved)) continue;
    stored.add(resolved);
    changed = true;
  }
  if (!changed) return;
  try {
    writeRegistered(stored);
  } catch (err) {
    logLine(`cannot write the registered paths: ${err instanceof Error ? err.message : err}`);
  }
}

/** Decisions about the board itself are filed under the project named after the plugin's checkout. */
export function boardProjectName(): string {
  return basename(pluginRoot());
}

async function defaultDecideList(): Promise<string> {
  const list = await listDecisions();
  return list.leftovers.length > 0 ? `${list.output}\n${JSON.stringify(list.leftovers, null, 2)}` : list.output;
}

async function defaultDecideAdd(title: string, detail: string): Promise<void> {
  await addDecision({ project: boardProjectName(), title, detail, source: "kanban" });
}

/** Register one decision for the paths not already recorded. One new path does not re-register the rest. */
export async function registerMissingPaths(paths: string[]): Promise<boolean> {
  if (paths.length === 0) return false;
  let listing = "";
  try {
    listing = await (hooks.decideList ?? defaultDecideList)();
  } catch (err) {
    logLine(`decide ls failed, not filing this time: ${err instanceof Error ? err.message : err}`);
    return false;
  }
  const resolved = [...new Set(paths.map((item) => resolve(item)))].sort();
  const novel = resolved.filter((item) => !readRegistered().has(item));
  if (novel.length === 0) return false;
  const fingerprint = pathSetFingerprint(novel);
  if (listing.includes(fingerprint)) {
    rememberPaths(novel);
    return false;
  }
  const title = t("missingCwd.decide.title", { count: novel.length, fingerprint });
  const detail = [
    t("missingCwd.decide.intro", { worktrees: paseoWorktreesRoot(), checkouts: checkoutsRoot() }),
    ...novel,
    "",
    t("missingCwd.decide.optionA"),
    t("missingCwd.decide.optionB"),
    t("missingCwd.decide.recommend"),
  ].join("\n");
  try {
    await (hooks.decideAdd ?? ((input) => defaultDecideAdd(input.title, input.detail)))({ title, detail });
  } catch (err) {
    logLine(`decide add failed: ${err instanceof Error ? err.message : err}`);
    return false;
  }
  rememberPaths(novel);
  return true;
}

/** README lines written before the catalogs existed: the Chinese "agent:" prefix and "(could not list)" marker. */
const LEGACY_AGENTS_PREFIX = "agent\uff1a";
const LEGACY_UNLISTED_AGENTS = "\uff08\u672a\u80fd\u5217\u51fa\uff09";

/** A message in every shipped language, plus its legacy form; a README may have been written in any of them. */
function allLanguages(key: MessageKey, legacy: string, vars?: MessageVars): string[] {
  return [...new Set([...LANGUAGES.map((language) => translate(language, key, vars)), legacy])];
}

/** Agent ids named on the placeholder README agent line (missingCwd.placeholder.agents). An unlisted marker contributes nothing. */
export function placeholderAgentIdsFromText(text: string): string[] {
  const prefixes = allLanguages("missingCwd.placeholder.agents", LEGACY_AGENTS_PREFIX, { agents: "" });
  const unlisted = allLanguages("missingCwd.placeholder.unlisted", LEGACY_UNLISTED_AGENTS);
  const ids: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const prefix = prefixes.find((item) => line.startsWith(item));
    if (prefix === undefined) continue;
    const body = line.slice(prefix.length).trim();
    if (!body || unlisted.includes(body)) continue;
    // Ids are joined with the list separator: the ideographic comma (\u3001) or ", ".
    for (const part of body.split(/\u3001|,/)) {
      const id = part.trim();
      if (id && !unlisted.includes(id)) ids.push(id);
    }
  }
  return ids;
}

function readmeAgentIds(directory: string): string[] {
  const readme = join(directory, PLACEHOLDER_NAME);
  if (!existsSync(readme)) return [];
  try {
    return placeholderAgentIdsFromText(readFileSync(readme, "utf8"));
  } catch (err) {
    logLine(`cannot read placeholder README ${readme}: ${err instanceof Error ? err.message : err}`);
    return [];
  }
}

function eventAgentIds(directory: string): string[] {
  const rows = getDb().prepare("SELECT data_json FROM events WHERE kind = 'cwd_placeholder'").all() as unknown as Array<{ data_json: string }>;
  const target = resolve(directory);
  const ids: string[] = [];
  for (const row of rows) {
    try {
      const data = JSON.parse(row.data_json) as { agentId?: unknown; path?: unknown };
      if (typeof data.path !== "string" || resolve(data.path) !== target) continue;
      if (typeof data.agentId === "string" && data.agentId) ids.push(data.agentId);
    } catch {
      // a broken event does not name an agent
    }
  }
  return ids;
}

/**
 * Cleared only by an explicit purge or successful archive on this card, or by a
 * successful agent-list read that does not contain the agent. The caller must not
 * pass a failed read: absence is not the same as an unreadable directory.
 */
function agentCleared(taskId: number, agentId: string, listed: CwdAgent[]): boolean {
  if (alreadyPurged(taskId, agentId)) return true;
  if (archiveSucceeded(readCleanupEvents(taskId), "archive_agent", agentId)) return true;
  return !listed.some((agent) => agent.id === agentId);
}

/**
 * Why a placeholder directory must stay, or null when every registered agent is gone
 * and the directory may be removed. No named agent means it stays.
 * An unreadable agent list stays, even when this card already recorded a purge.
 */
export function placeholderBlocksRemoval(directory: string, taskId: number): string | null {
  if (directoryState(directory) !== "placeholder") return null;
  const listed = readCwdAgentList();
  if (listed == null) return agentListUnreadReason();
  const ids = new Set<string>([...readmeAgentIds(directory), ...eventAgentIds(directory)]);
  for (const agent of agentsTouching(directory, listed)) ids.add(agent.id);
  if (ids.size === 0) return t("missingCwd.placeholder.blocks");
  const live = [...ids].filter((id) => !agentCleared(taskId, id, listed));
  if (live.length > 0) return t("missingCwd.placeholder.blocks");
  return null;
}

/**
 * Finished cards whose cleanup has not recorded cleanup_finished.
 * Cleanup purges those agents before it removes the directory, and Kanban does not
 * start or message an agent whose cwd is missing. An open card, or a finished card
 * whose cleanup already ended with the agent still here, still needs a placeholder.
 */
function cleanupWillCollect(agent: CwdAgent): boolean {
  let cards: CardLink[] = [];
  try {
    cards = cardsForAgent(agent.id, agent.labels);
  } catch (err) {
    logLine(`cannot look up the cards of ${agent.id}: ${err instanceof Error ? err.message : err}`);
    return false;
  }
  if (cards.length === 0) return false;
  if (cards.some((card) => !finished(card.status))) return false;
  return cards.some((card) => !cleanupFinished(card.id));
}

function notePlaceholderSkipped(agent: CwdAgent, reason: string): void {
  const key = `${agent.id}:${resolve(agent.cwd)}`;
  if (skippedPlaceholders.has(key)) return;
  skippedPlaceholders.add(key);
  logLine(`no placeholder agent=${agent.id} path=${agent.cwd} ${reason}`);
  let cards: CardLink[] = [];
  try {
    cards = cardsForAgent(agent.id, agent.labels);
  } catch (err) {
    logLine(`cannot write the skipped placeholder to the cards of ${agent.id}: ${err instanceof Error ? err.message : err}`);
    return;
  }
  for (const card of cards) {
    try {
      const written = getDb()
        .prepare(`SELECT 1 AS n FROM events WHERE task_id = ? AND kind = 'cwd_placeholder_skipped'
          AND json_extract(data_json, '$.agentId') = ? AND json_extract(data_json, '$.path') = ? LIMIT 1`)
        .get(card.id, agent.id, agent.cwd);
      if (written) continue;
      appendEvent(card.id, "cwd_placeholder_skipped", null, card.status, "kanban", {
        agentId: agent.id,
        path: agent.cwd,
        reason,
      });
    } catch (err) {
      logLine(`cannot write cwd_placeholder_skipped to ${cardMark(card.id)}: ${err instanceof Error ? err.message : err}`);
    }
  }
}

function notePatrolPlaceholder(agent: CwdAgent, reason: string): void {
  let cards: CardLink[] = [];
  try {
    cards = cardsForAgent(agent.id, agent.labels);
  } catch (err) {
    logLine(`cannot look up the cards of ${agent.id}: ${err instanceof Error ? err.message : err}`);
  }
  if (cards.length === 0) {
    recordPlaceholder(null, agent.id, agent.cwd, reason);
    return;
  }
  for (const card of cards) recordPlaceholder(card.id, agent.id, agent.cwd, reason);
}

export async function patrolMissingCwds(): Promise<void> {
  const foreign: CwdAgent[] = [];
  for (const agent of loadCwdAgents()) {
    // An archived agent is not started or messaged, so its missing directory is not worth a placeholder.
    if (agent.archived || !agent.cwd.trim()) continue;
    if (directoryState(agent.cwd) !== "missing") continue;
    if (autoPlaceholderPath(agent.cwd)) {
      if (cleanupWillCollect(agent)) {
        notePlaceholderSkipped(agent, t("missingCwd.patrol.skipDone"));
        continue;
      }
      const reason = t("missingCwd.patrol.placed");
      if (ensurePlaceholder(agent.cwd, reason, [agent.id])) notePatrolPlaceholder(agent, reason);
      continue;
    }
    foreign.push(agent);
  }
  notice.foreignAgents = foreign.length;
  if (foreign.length === 0) return;
  await registerMissingPaths(foreign.map((agent) => agent.cwd));
}

export function startMissingCwdPatrol(options?: { intervalMs?: number; run?: () => Promise<void> }): () => void {
  const run = options?.run ?? patrolMissingCwds;
  const tick = () => {
    void Promise.resolve()
      .then(() => run())
      .catch((err) => {
        logLine(`patrol failed: ${err instanceof Error ? err.message : err}`);
      });
  };
  tick();
  // Runs while the plugin loads: a lost config file must not stop it (DEMO_0001).
  const interval = options?.intervalMs ?? loadConfigForReport().missingCwdPatrolMs ?? DEFAULT_MISSING_CWD_PATROL_MS;
  const timer = setInterval(tick, interval);
  (timer as unknown as { unref?: () => void }).unref?.();
  patrolTimer = timer;
  return () => {
    clearInterval(timer);
    if (patrolTimer === timer) patrolTimer = null;
  };
}

export function listPathForReport(): string {
  return process.env.KANBAN_MISSING_CWD_LIST?.trim() || join(dataDir(), "missing-cwd-list.md");
}

export function scanProblemAgents(root?: string): ProblemAgent[] {
  const ids = loadKanbanAgentIds();
  const listed = root ? readAgentFiles(root) : loadCwdAgentList();
  const agents = listed ?? [];
  const problems: ProblemAgent[] = [];
  for (const agent of agents) {
    if (!agent.cwd.trim()) continue;
    const state = directoryState(agent.cwd);
    if (state === "present") continue;
    problems.push({ agent, state, kanban: kanbanOpened(agent.id, agent.labels, ids) });
  }
  problems.sort((left, right) => left.agent.cwd.localeCompare(right.agent.cwd) || left.agent.id.localeCompare(right.agent.id));
  return problems;
}

/** Report column headers, in order. */
function reportColumns(): string[] {
  return [
    "agentId",
    "provider",
    t("missingCwd.report.title"),
    "cwd",
    t("missingCwd.report.lastActivity"),
    t("missingCwd.report.archived"),
    t("missingCwd.report.board"),
    t("missingCwd.report.directory"),
  ];
}

/** The three state cells of a report row: archived, who opened it, directory state. */
function reportStates(item: ProblemAgent): string[] {
  return [
    item.agent.archived ? t("missingCwd.report.isArchived") : t("missingCwd.report.notArchived"),
    item.kanban ? t("missingCwd.report.kanbanOpened") : t("missingCwd.report.notKanban"),
    item.state === "missing" ? t("missingCwd.report.missing") : t("missingCwd.report.placeholder"),
  ];
}

function humanList(problems: ProblemAgent[], checkedAt: string, listPath: string): string {
  const lines = [
    `${t("missingCwd.report.checkedAt")}\t${checkedAt}`,
    reportColumns().join("\t"),
  ];
  for (const item of problems) {
    lines.push(
      [
        item.agent.id,
        item.agent.provider,
        item.agent.title.replace(/\s+/g, " "),
        item.agent.cwd,
        item.agent.lastActivityAt ?? "",
        ...reportStates(item),
      ].join("\t"),
    );
  }
  if (problems.length === 0) lines.push(t("missingCwd.report.empty"));
  lines.push(`${t("missingCwd.report.listFile")}\t${listPath}`);
  return lines.join("\n");
}

function markdownList(problems: ProblemAgent[], checkedAt: string): string {
  const rows = problems.map((item) => {
    const cells = [
      item.agent.id,
      item.agent.provider,
      item.agent.title.replace(/\|/g, "\\|"),
      item.agent.cwd,
      item.agent.lastActivityAt ?? "",
      ...reportStates(item),
    ];
    return `| ${cells.join(" | ")} |`;
  });
  return [
    t("missingCwd.report.heading"),
    "",
    `${t("missingCwd.report.checkedAt")}${t("common.colon")}${checkedAt}`,
    "",
    `| ${reportColumns().join(" | ")} |`,
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...(rows.length > 0 ? rows : [`| ${t("missingCwd.none")} | | | | | | | |`]),
    "",
  ].join("\n");
}

export function buildMissingCwdReport(options?: { agentsRoot?: string; now?: Date; listPath?: string }): {
  report: MissingCwdReport;
  human: string;
  code: number;
} {
  const checkedAt = (options?.now ?? new Date()).toISOString();
  const listPath = options?.listPath ?? listPathForReport();
  const problems = scanProblemAgents(options?.agentsRoot);
  const missing = problems.filter((item) => item.state === "missing");
  const report: MissingCwdReport = {
    checkedAt,
    count: missing.length,
    placeholder: problems.filter((item) => item.state === "placeholder").length,
    listPath,
    items: missing.map((item) => ({
      agentId: item.agent.id,
      cwd: item.agent.cwd,
      title: item.agent.title,
      archived: item.agent.archived,
    })),
  };
  mkdirSync(resolve(listPath, ".."), { recursive: true });
  writeFileSync(listPath, markdownList(problems, checkedAt));
  return { report, human: humanList(problems, checkedAt, listPath), code: report.count > 0 ? 1 : 0 };
}

function alreadyPurged(taskId: number, agentId: string): boolean {
  const rows = getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'agent_purged'").all(taskId) as unknown as Array<{
    data_json: string;
  }>;
  return rows.some((row) => {
    try {
      const data = JSON.parse(row.data_json) as { agentId?: unknown };
      return data.agentId === agentId;
    } catch {
      return false;
    }
  });
}

export interface PurgePlanLine {
  agentId: string;
  action: "delete" | "skip";
  reason: string;
}

export async function purgeCardAgents(taskId: number, options?: { dryRun?: boolean }): Promise<{ text: string; deleted: string[]; lines: PurgePlanLine[] }> {
  const task = getTask(taskId);
  if (!finished(task.status)) {
    throw new KanbanError("invalid", t("missingCwd.purge.notFinished", { card: cardMark(taskId), status: statusLabel(task.status) }));
  }
  const ids = new Set<string>();
  const db = getDb();
  if (task.agent_id) ids.add(task.agent_id);
  if (task.executor_agent_id) ids.add(task.executor_agent_id);
  const runs = db.prepare("SELECT agent_id FROM runs WHERE task_id = ? AND agent_id IS NOT NULL").all(taskId) as Array<{ agent_id: string }>;
  for (const row of runs) ids.add(row.agent_id);
  const tokens = db.prepare("SELECT agent_id FROM tokens WHERE task_id = ? AND agent_id IS NOT NULL").all(taskId) as Array<{ agent_id: string }>;
  for (const row of tokens) ids.add(row.agent_id);
  for (const agent of loadCwdAgents()) {
    if (agent.labels.kanban_task === String(taskId)) ids.add(agent.id);
  }
  const readAgent = createNativeAgentReader();
  const lines: PurgePlanLine[] = [];
  const deleted: string[] = [];
  for (const agentId of [...ids].sort()) {
    const agent = findCwdAgent(agentId);
    if (!agent) {
      lines.push({ agentId, action: "skip", reason: t("missingCwd.purge.gone") });
      continue;
    }
    if (alreadyPurged(taskId, agentId)) {
      if (options?.dryRun) {
        lines.push({ agentId, action: "delete", reason: t("missingCwd.purge.notesWritten") });
        continue;
      }
      const outcome = await deleteAgentRecord(agentId, readAgent);
      if (outcome === "purged") {
        deleted.push(agentId);
        lines.push({ agentId, action: "delete", reason: t("missingCwd.purge.notesWritten") });
      } else lines.push({ agentId, action: "skip", reason: t("missingCwd.purge.deleteFailed") });
      continue;
    }
    const decision = purgeDecision(agent);
    if (!decision.ok) {
      lines.push({ agentId, action: "skip", reason: decision.reason });
      continue;
    }
    if (!decision.cards.some((card) => card.id === taskId)) {
      lines.push({ agentId, action: "skip", reason: t("missingCwd.purge.notThisCard") });
      continue;
    }
    if (options?.dryRun) {
      lines.push({ agentId, action: "delete", reason: "dry-run" });
      continue;
    }
    const outcome = await purgeAgent(agent, readAgent);
    if (outcome === "purged") {
      deleted.push(agentId);
      lines.push({ agentId, action: "delete", reason: t("missingCwd.purge.deleted") });
    } else lines.push({ agentId, action: "skip", reason: t("missingCwd.purge.writeFailed") });
  }
  const text = [
    ...lines.map((line) => t(line.action === "delete" ? "missingCwd.purge.lineDelete" : "missingCwd.purge.lineKeep", { agent: line.agentId, reason: line.reason })),
    options?.dryRun ? t("missingCwd.purge.dryRunNone") : t("missingCwd.purge.deletedCount", { count: deleted.length }),
  ].join("\n");
  return { text, deleted, lines };
}
