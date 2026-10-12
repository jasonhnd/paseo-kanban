/// <reference types="node" />
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, readdir, rename, rmdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { t, type MessageKey } from "../shared/i18n";
import { loadConfig } from "./config";
import { getDb, getReadOnlyDb } from "./db";
import { KanbanError } from "./errors";
import { upsertSummaryEvent } from "./event-summary";
import { GUEST_ROLE, SCHEDULE_ROLE, assertSupervisorScope, resolveCompactIdentity } from "./identity";
import { indexNativeAgents, readNativeAgent, SAFE_NATIVE_ID, sessionKey, type NativeAgent, type NativeAgentIndex, type NativeAgentReader } from "./native-agent-index";
import type { Identity } from "./tokens";
import { appendEvent, type TaskRow } from "./store";
import { isLeaderSessionTitle } from "./supervisor";
import { findTmpResidueSessions } from "./native-tmp-sessions";

type Move = { source: string; target: string };
type Session = { agentId: string; provider: string; sessionId: string; cwd: string };
interface QueueRow { agent_id: string; task_id: number; provider: string; session_id: string; cwd: string; home: string; status: string; retirement: string | null; moves_json: string | null; attempts: number; retry_at: number; last_error: string | null }
export interface NativeSessionOptions {
  home?: string;
  now?: Date;
  command?: (action: "archive" | "unarchive", sessionId: string, home: string) => Promise<void>;
  progress?: (message: string) => void;
  readAgent?: NativeAgentReader;
  /** Test hook: roots treated as /tmp when looking for test-residue project directories. */
  tmpRoots?: readonly string[];
}
/** Sessions whose agent belongs to no card (hand-opened, schedule, sub-agent, old leader) or that are /tmp test residue use this journal id. */
export const UNCARDED_TASK_ID = 0;
export const NATIVE_BATCH_LIMIT = 5;
export const NATIVE_MAX_ATTEMPTS = 12;
export const NATIVE_TRANSIENT_RETRY_MS = 5 * 60_000;
/** Temporary conditions: defer the next try, never count an attempt or journal a failure. */
class TransientNativeError extends Error {}
/** Same agent + same kind of error share one failure event, whatever the detail after the colon. */
export function nativeErrorClass(error: string | null | undefined): string {
  // Split on the full-width colon (\uff1a, Chinese messages) or the ASCII colon (English messages).
  return (error ?? "").split(/[\uff1a:]/)[0].trim();
}
export function nativeRetryDelayMs(attempts: number): number {
  return Math.min(24 * 60 * 60_000, 5 * 60_000 * 2 ** Math.min(Math.max(0, attempts - 1), 20));
}
let processing: Promise<{ processed: number }> | null = null;
function record(taskId: number, kind: string, data: object): void { appendEvent(taskId, kind, null, null, "kanban", { ...data }); }
const SUMMARY_SESSION_CAP = 200;
/** One summary row per card and reason (DEMO_0001): later skipped sessions of the card add themselves to `sessions` and `count`. */
function recordSkipped(taskId: number, data: { agentId: string; reason: string } & Partial<Session>): void {
  const { agentId, provider, sessionId, cwd } = data;
  const entry = Object.fromEntries(Object.entries({ agentId, provider, sessionId, cwd }).filter(([, value]) => value !== undefined));
  upsertSummaryEvent(taskId, "native_session_skipped", "kanban", data.reason, { ...data }, { list: { field: "sessions", entry, cap: SUMMARY_SESSION_CAP } });
}
function protectedAgent(agent: NativeAgent): boolean {
  const config = loadConfig();
  return config.supervisorAgentId === agent.id || Object.values(config.supervisors).includes(agent.id) || isLeaderSessionTitle(agent.title ?? "") || ["supervisor", "leader"].includes(agent.labels?.role ?? "");
}
/** Why a session is kept; sweep counts by this instead of parsing messages. */
export type SkipCategory = "provider_unsupported" | "no_session_id" | "leader_kept" | "shared_kept" | "excluded" | "running" | "no_native_files" | "other";
class NativeKept extends Error { constructor(message: string, readonly category: SkipCategory) { super(message); } }
/** Only agents registered in config count as a current leader; an archived, replaced leader is ordinary history. */
function currentLeader(agent: NativeAgent): boolean {
  const config = loadConfig();
  return config.supervisorAgentId === agent.id || Object.values(config.supervisors).includes(agent.id);
}
const guarded = (agent: NativeAgent, uncarded: boolean) => uncarded ? currentLeader(agent) : protectedAgent(agent);
function owned(db: DatabaseSync, taskId: number, agentId: string, agent?: NativeAgent | null): boolean {
  if (!db.prepare("SELECT 1 FROM tasks WHERE id = ?").get(taskId)) return false;
  if (db.prepare("SELECT 1 FROM runs WHERE task_id = ? AND agent_id = ?").get(taskId, agentId)) return true;
  if (db.prepare("SELECT 1 FROM events WHERE task_id = ? AND kind IN ('agent_opened','native_session_identified') AND json_extract(data_json, '$.agentId') = ? LIMIT 1").get(taskId, agentId)) return true;
  return ["1", "true"].includes(agent?.labels?.kanban ?? "") && agent?.labels?.kanban_task === String(taskId);
}
function identify(agent: NativeAgent): Session {
  const sid = agent.persistence?.sessionId || agent.persistence?.nativeHandle;
  if (["codex", "claude"].includes(agent.provider) && (typeof sid !== "string" || !SAFE_NATIVE_ID.test(sid))) throw new NativeKept(t("nativeSessions.noValidSessionId"), "no_session_id");
  return { agentId: agent.id, provider: agent.provider, sessionId: typeof sid === "string" ? sid : "", cwd: agent.cwd };
}
function fromRow(row: QueueRow): Session { return { agentId: row.agent_id, provider: row.provider, sessionId: row.session_id, cwd: row.cwd }; }
/** Terminal rows never need recapture, even if the archived agent is later promoted to leader. */
export function nativeSessionSettled(agentId: string): boolean {
  const row = getDb().prepare("SELECT status FROM native_session_queue WHERE agent_id = ?").get(agentId) as { status: string } | undefined;
  return Boolean(row && ["archived", "restored", "skipped", "failed"].includes(row.status));
}

/** Return true only for a new row, changed location, or the first transition to skipped. */
function queueSession(taskId: number, agentId: string, home: string, session?: Session, skip = false): boolean {
  const db = getDb();
  const result = db.prepare(`INSERT INTO native_session_queue(agent_id, task_id, home, provider, session_id, cwd, status) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(agent_id) DO UPDATE SET
    provider = CASE WHEN excluded.status = 'skipped' AND excluded.provider = '' THEN native_session_queue.provider ELSE excluded.provider END,
    session_id = CASE WHEN excluded.status = 'skipped' AND excluded.provider = '' THEN native_session_queue.session_id ELSE excluded.session_id END,
    cwd = CASE WHEN excluded.status = 'skipped' AND excluded.provider = '' THEN native_session_queue.cwd ELSE excluded.cwd END,
    status = CASE WHEN excluded.status = 'skipped' THEN 'skipped' ELSE native_session_queue.status END
    WHERE native_session_queue.status NOT IN ('archived','restored','skipped','failed')
      AND (excluded.status = 'skipped' OR (? = 1 AND
        (native_session_queue.provider != excluded.provider OR native_session_queue.session_id != excluded.session_id OR native_session_queue.cwd != excluded.cwd)))`)
    .run(agentId, taskId, home, session?.provider ?? "", session?.sessionId ?? "", session?.cwd ?? "", skip ? "skipped" : "prepared", session ? 1 : 0);
  return Boolean(result.changes);
}
/** No native files touched. Capture only this agent before its Paseo record can disappear. */
export async function prepareNativeSession(taskId: number, agentId: string, options: NativeSessionOptions = {}): Promise<void> {
  if (!SAFE_NATIVE_ID.test(agentId) || nativeSessionSettled(agentId)) return;
  try {
    const agent = await (options.readAgent ?? readNativeAgent)(agentId);
    if (!owned(getDb(), taskId, agentId, agent)) return;
    if (agent && protectedAgent(agent)) {
      if (queueSession(taskId, agentId, options.home ?? homedir(), undefined, true)) {
        recordSkipped(taskId, { agentId, reason: t("nativeSessions.kept.leader") });
      }
      return;
    }
    const session = agent ? identify(agent) : undefined;
    if (session && !["claude", "codex"].includes(session.provider)) {
      if (queueSession(taskId, agentId, options.home ?? homedir(), session, true)) {
        recordSkipped(taskId, { ...session, reason: t("nativeSessions.skip.noNativeSession") });
      }
      return;
    }
    if (session) {
      const previous = getDb().prepare("SELECT provider, session_id, cwd FROM native_session_queue WHERE agent_id = ?").get(agentId) as Pick<QueueRow, "provider" | "session_id" | "cwd"> | undefined;
      if (previous?.provider === session.provider && previous.session_id === session.sessionId && previous.cwd === session.cwd) return;
    }
    if (!queueSession(taskId, agentId, options.home ?? homedir(), session)) return;
    if (session) {
      // Import a prior successful journal entry for this exact handle after an upgrade/revert.
      // This is task-local indexed SQL, not the old full-history scan on every tick.
      const previous = getDb().prepare(`SELECT kind FROM events WHERE task_id = ?
        AND kind IN ('native_session_archived','native_session_restored')
        AND json_extract(data_json,'$.provider') = ? AND json_extract(data_json,'$.sessionId') = ? ORDER BY id DESC LIMIT 1`)
        .get(taskId, session.provider, session.sessionId) as { kind: string } | undefined;
      if (previous) getDb().prepare("UPDATE native_session_queue SET status = ? WHERE agent_id = ? AND status IN ('prepared','pending')")
        .run(previous.kind === "native_session_restored" ? "restored" : "archived", agentId);
      else record(taskId, "native_session_identified", session);
    }
  } catch {
    // Keep a durable candidate even when the handle is not available until after archive.
    if (owned(getDb(), taskId, agentId)) queueSession(taskId, agentId, options.home ?? homedir());
  }
}
function ready(taskId: number, agentId: string, action: string): void {
  const result = getDb().prepare("UPDATE native_session_queue SET status = 'pending', retirement = ? WHERE task_id = ? AND agent_id = ? AND status = 'prepared'").run(action, taskId, agentId);
  if (result.changes) record(taskId, "native_session_ready", { agentId, action });
}
export function nativeSessionAfterArchive(taskId: number, agentId: string): void { ready(taskId, agentId, "archive_succeeded"); }
export function nativeSessionAfterPurge(taskId: number, agentId: string): void { ready(taskId, agentId, "purge_succeeded"); }
export async function prepareNativeSessionsForPurge(agentId: string, readAgent: NativeAgentReader = readNativeAgent): Promise<number[]> {
  const db = getDb(); const agent = await readAgent(agentId);
  const rows = db.prepare(`SELECT task_id AS id FROM runs WHERE agent_id = ? UNION
    SELECT task_id FROM events WHERE kind IN ('agent_opened','native_session_identified') AND json_extract(data_json, '$.agentId') = ?`).all(agentId, agentId) as Array<{ id: number }>;
  const label = Number(agent?.labels?.kanban_task);
  const ids = new Set(rows.map(row => row.id)); if (Number.isSafeInteger(label) && label > 0) ids.add(label);
  const result = [...ids].filter(id => owned(db, id, agentId, agent));
  for (const id of result) await prepareNativeSession(id, agentId, { readAgent });
  return result;
}
function retirementAllowed(row: QueueRow): boolean {
  if (row.task_id === UNCARDED_TASK_ID) return true; // no card to wait for; archiveOne still checks the agent record
  const db = getDb();
  const task = db.prepare("SELECT status, agent_id FROM tasks WHERE id = ?").get(row.task_id) as { status: string; agent_id: string | null } | undefined;
  if (!task || !row.retirement) return false;
  if (["done", "archived"].includes(task.status) || task.agent_id !== row.agent_id) return true;
  const release = db.prepare("SELECT kind FROM events WHERE task_id = ? AND kind IN ('release_agent','release_agent_canceled') AND json_extract(data_json, '$.agentId') = ? ORDER BY id DESC LIMIT 1").get(row.task_id, row.agent_id) as { kind: string } | undefined;
  return release?.kind === "release_agent";
}
function protectShared(session: Session, index: NativeAgentIndex, db: DatabaseSync, uncarded = false): void {
  if (index.error) throw new TransientNativeError(index.error);
  for (const agent of index.sessions.get(sessionKey(session.provider, session.sessionId)) ?? []) {
    if (guarded(agent, uncarded)) throw new NativeKept(t("nativeSessions.kept.leader"), "leader_kept");
    if (agent.id === session.agentId) { if (!agent.archivedAt && agent.lastStatus === "running") throw new NativeKept(t("nativeSessions.kept.running"), "running"); continue; }
    // Uncarded sessions have no card to prove ownership: any other archived, idle agent sharing it is also retired.
    if (uncarded && agent.archivedAt && agent.lastStatus !== "running") continue;
    if (!agent.archivedAt || !["1", "true"].includes(agent.labels?.kanban ?? "") || !owned(db, Number(agent.labels?.kanban_task), agent.id, agent)) throw new NativeKept(t("nativeSessions.kept.shared"), "shared_kept");
  }
}
async function stat(path: string) {
  try { return await lstat(path); } catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return null; throw err; }
}
/** Metadata checks only; reject links in all parents, never open session contents. */
async function safePath(home: string, path: string): Promise<void> {
  const rel = relative(home, path);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error(t("nativeSessions.path.outside"));
  let current = home; const paths = [home];
  for (const part of rel.split("/")) { current = join(current, part); paths.push(current); }
  // Ancestor metadata reads are independent; check all before any move. Keep
  // every symlink check, without serial round trips for each path component.
  const entries = await Promise.all(paths.map(stat));
  if (entries.some(entry => entry?.isSymbolicLink())) throw new Error(t("nativeSessions.path.symlink"));
}
async function claudePlan(session: Session, home: string): Promise<Move[]> {
  if (!isAbsolute(session.cwd)) throw new Error(t("nativeSessions.claude.cwdNotAbsolute"));
  const project = session.cwd.replace(/[^a-zA-Z0-9]/g, "-");
  const dir = join(home, ".claude", "projects", project); const archive = join(home, ".claude", "projects-archive", project);
  const source = join(dir, `${session.sessionId}.jsonl`); await safePath(home, source);
  if (!(await stat(source))?.isFile()) throw new NativeKept(t("nativeSessions.claude.noJsonl"), "no_native_files");
  const sources = [source]; const companion = join(dir, session.sessionId); await safePath(home, companion);
  const extra = await stat(companion);
  if (extra) { if (!extra.isDirectory()) throw new Error(t("nativeSessions.claude.companionNotDir")); sources.push(companion); }
  // A UUID avoids the previous unbounded suffix search and directory enumeration.
  const suffix = randomUUID();
  const moves = sources.map(item => ({ source: item, target: join(archive, item === source ? `${session.sessionId}.${suffix}.jsonl` : `${session.sessionId}.${suffix}`) }));
  for (const move of moves) { await safePath(home, move.target); if (await stat(move.target)) throw new Error(t("nativeSessions.archive.targetExists")); }
  return moves;
}
function checkMoveRoots(session: Session, moves: Move[], home: string): void {
  const project = session.cwd.replace(/[^a-zA-Z0-9]/g, "-");
  const dir = join(home, ".claude", "projects", project); const archive = join(home, ".claude", "projects-archive", project);
  if (!isAbsolute(session.cwd)) throw new Error(t("nativeSessions.restore.recordMissing"));
  checkClaudeMoves(session.sessionId, moves, dir, archive);
}
function checkClaudeMoves(sessionId: string, moves: Move[], dir: string, archive: string): void {
  if (!moves.length || moves.length > 2) throw new Error(t("nativeSessions.restore.recordMissing"));
  const sources = new Set<string>(); const suffixes = new Set<string>();
  for (const move of moves) {
    const isFile = move.source === join(dir, `${sessionId}.jsonl`);
    if ((!isFile && move.source !== join(dir, sessionId)) || dirname(move.target) !== archive || sources.has(move.source)) throw new Error(t("nativeSessions.archive.pathMismatch"));
    sources.add(move.source);
    const name = move.target.slice(archive.length + 1);
    if (!name.startsWith(sessionId) || (isFile && !name.endsWith(".jsonl"))) throw new Error(t("nativeSessions.archive.pathMismatch"));
    const suffix = name.slice(sessionId.length, isFile ? -6 : undefined);
    // Empty/numeric suffixes were used by DEMO_0001; UUID suffixes are used now.
    if (suffix !== "" && !/^\.[A-Za-z0-9-]+$/.test(suffix)) throw new Error(t("nativeSessions.archive.badSuffix"));
    suffixes.add(suffix);
  }
  if (!sources.has(join(dir, `${sessionId}.jsonl`)) || suffixes.size !== 1) throw new Error(t("nativeSessions.archive.companionMismatch"));
}
async function moveAll(session: Session, moves: Move[], home: string, restore = false, replay = true): Promise<void> {
  checkMoveRoots(session, moves, home);
  for (const move of moves) {
    const source = restore ? move.target : move.source; const target = restore ? move.source : move.target;
    await safePath(home, source); await safePath(home, target);
    const from = await stat(source); const to = await stat(target);
    if (!from && to && replay) continue;
    if (!from || to) throw new Error(t("nativeSessions.move.conflict"));
  }
  for (const move of moves) {
    const source = restore ? move.target : move.source; const target = restore ? move.source : move.target;
    if (!(await stat(source))) continue;
    await mkdir(dirname(target), { recursive: true });
    await safePath(home, target);
    if (await stat(target)) throw new Error(t("nativeSessions.move.targetExists"));
    await rename(source, target);
  }
}
async function removeEmptyClaudeProject(session: Session, home: string, taskId: number): Promise<string | null> {
  const project = session.cwd.replace(/[^a-zA-Z0-9]/g, "-");
  if (!project.includes("paseo-worktrees")) return null;
  // Match an actual temporary workspace and its successful cleanup, not merely
  // a cwd-shaped string or an agent archive. Borrowed review copies use the
  // owning card's workspace journal rather than the review card's status.
  const db = getDb();
  const temp = db.prepare(`SELECT task_id, id FROM events WHERE kind = 'temp_workspace'
    AND json_extract(data_json, '$.directory') = ? ORDER BY id DESC LIMIT 1`).get(session.cwd) as { task_id: number; id: number } | undefined;
  if (!temp || !db.prepare(`SELECT 1 FROM events WHERE task_id = ? AND id > ? AND kind = 'temp_workspace_cleaned'
    AND json_extract(data_json, '$.directory') = ? LIMIT 1`).get(temp.task_id, temp.id, session.cwd)) return null;
  const dir = join(home, ".claude", "projects", project);
  await safePath(home, dir);
  try {
    // rmdir checks emptiness atomically; no native directory traversal or
    // recursive deletion. Other sessions and unrelated files retain the dir.
    await rmdir(dir);
  } catch (err) {
    if (["ENOENT", "ENOTEMPTY", "EEXIST"].includes((err as NodeJS.ErrnoException).code ?? "")) return null;
    throw err;
  }
  upsertSummaryEvent(taskId, "native_session_project_dir_removed", "kanban", dir, { ...session, home, directory: dir, workspaceTaskId: temp.task_id }, { list: { field: "sessions", entry: { agentId: session.agentId, sessionId: session.sessionId }, cap: SUMMARY_SESSION_CAP } });
  return dir;
}
/** Agent retirement can finish before its temporary workspace. Retry the exact
 * archived project directories when that workspace's cleanup journal lands. */
export async function removeArchivedClaudeProjects(cwd: string): Promise<void> {
  if (!cwd.replace(/[^a-zA-Z0-9]/g, "-").includes("paseo-worktrees")) return;
  const rows = getDb().prepare("SELECT * FROM native_session_queue WHERE provider = 'claude' AND status = 'archived' AND cwd = ?").all(cwd) as unknown as QueueRow[];
  const homes = new Set<string>();
  for (const row of rows) {
    if (homes.has(row.home)) continue; homes.add(row.home);
    let release: (() => void) | undefined;
    try { release = claim(row.home, fromRow(row)); await removeEmptyClaudeProject(fromRow(row), row.home, row.task_id); }
    catch (err) { record(row.task_id, "native_session_project_dir_remove_failed", { ...fromRow(row), error: err instanceof Error ? err.message : String(err) }); }
    finally { release?.(); }
  }
}
/** Indexed, constant-size lock lookup. Codex commands across CLI/plugin are globally serialized. */
function claim(home: string, session: Session): () => void {
  const resource = JSON.stringify([home, session.provider, session.provider === "codex" ? "command" : session.cwd.replace(/[^a-zA-Z0-9]/g, "-")]);
  const db = getDb(); const owner = randomUUID(); const now = Date.now();
  const result = db.prepare(`INSERT INTO native_session_locks(resource, owner, expires_at) VALUES (?, ?, ?)
    ON CONFLICT(resource) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at WHERE native_session_locks.expires_at <= ?`).run(resource, owner, now + 60_000, now);
  if (!result.changes) throw new TransientNativeError(t("nativeSessions.lock.busy"));
  return () => { db.prepare("DELETE FROM native_session_locks WHERE resource = ? AND owner = ?").run(resource, owner); };
}
async function codex(action: "archive" | "unarchive", sessionId: string, home: string): Promise<void> {
  await new Promise<void>((resolve, reject) => execFile("codex", [action, sessionId], {
    timeout: 15_000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024, env: { ...process.env, HOME: home, CODEX_HOME: join(home, ".codex") },
  }, err => err ? reject(new Error(t("nativeSessions.codex.commandFailed", { action, code: err.code ?? "unknown" }))) : resolve()));
}
async function codexArchived(home: string, sessionId: string): Promise<boolean> {
  const thread = (await codexIndex(home)).threads.get(sessionId);
  return Boolean(thread?.archived);
}
function markCodexArchived(row: QueueRow, session: Session, action: string): void {
  record(row.task_id, "native_session_archived", { ...session, home: row.home, moves: [], removedProjectDir: null, action, targetPath: null });
  getDb().prepare("UPDATE native_session_queue SET status = 'archived' WHERE agent_id = ?").run(row.agent_id);
}
async function archiveOne(row: QueueRow, index: NativeAgentIndex, options: NativeSessionOptions): Promise<void> {
  const db = getDb(); const now = options.now ?? new Date(); let release: (() => void) | undefined;
  let session = fromRow(row);
  try {
    if (row.attempts >= NATIVE_MAX_ATTEMPTS) throw new Error(row.last_error ?? t("nativeSessions.retry.limit"));
    if (!retirementAllowed(row)) throw new TransientNativeError(t("nativeSessions.retry.noEvidence"));
    const agent = index.agents.get(row.agent_id); const uncarded = row.task_id === UNCARDED_TASK_ID;
    if (agent) {
      if (guarded(agent, uncarded)) throw new NativeKept(t("nativeSessions.kept.leader"), "leader_kept");
      if (uncarded && (!agent.archivedAt || agent.lastStatus === "running")) throw new TransientNativeError(t("nativeSessions.retry.revived"));
      session = identify(agent);
    }
    if (!session.provider || (["claude", "codex"].includes(session.provider) && !SAFE_NATIVE_ID.test(session.sessionId))) throw new Error(t("nativeSessions.retry.noRecord"));
    if (!["claude", "codex"].includes(session.provider)) {
      db.prepare("UPDATE native_session_queue SET status = 'skipped' WHERE agent_id = ?").run(row.agent_id);
      recordSkipped(row.task_id, { ...session, reason: t("nativeSessions.skip.noNativeSession") }); return;
    }
    if (session.provider === "codex" && await codexArchived(row.home, session.sessionId)) { markCodexArchived(row, session, "codex already archived"); return; }
    protectShared(session, index, db, uncarded);
    release = claim(row.home, session);
    const previous = db.prepare("SELECT status FROM native_session_queue WHERE provider = ? AND session_id = ? AND status IN ('archived','restored') LIMIT 1").get(session.provider, session.sessionId) as { status: string } | undefined;
    if (previous) { db.prepare("UPDATE native_session_queue SET status = ? WHERE agent_id = ?").run(previous.status, row.agent_id); return; }
    db.prepare("UPDATE native_session_queue SET provider = ?, session_id = ?, cwd = ? WHERE agent_id = ?").run(session.provider, session.sessionId, session.cwd, row.agent_id);
    let moves: Move[] = row.moves_json ? JSON.parse(row.moves_json) : [];
    let removedProjectDir: string | null = null;
    if (session.provider === "codex") {
      try { await (options.command ?? codex)("archive", session.sessionId, row.home); }
      catch (err) {
        // The thread may have been archived by codex itself or by a racing run.
        if (!(await codexArchived(row.home, session.sessionId))) throw err;
        markCodexArchived(row, session, "codex already archived"); return;
      }
    } else {
      if (!moves.length) {
        moves = await claudePlan(session, row.home);
        db.prepare("UPDATE native_session_queue SET moves_json = ? WHERE agent_id = ?").run(JSON.stringify(moves), row.agent_id);
        record(row.task_id, "native_session_archive_planned", { ...session, moves });
      }
      await moveAll(session, moves, row.home);
      removedProjectDir = await removeEmptyClaudeProject(session, row.home, row.task_id);
    }
    record(row.task_id, "native_session_archived", { ...session, home: row.home, moves, removedProjectDir, action: session.provider === "codex" ? "codex archive" : "move", targetPath: moves[0]?.target ?? null });
    db.prepare("UPDATE native_session_queue SET status = 'archived' WHERE agent_id = ?").run(row.agent_id);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    if (err instanceof TransientNativeError) {
      db.prepare("UPDATE native_session_queue SET retry_at = ? WHERE agent_id = ? AND status = 'pending'").run(+now + NATIVE_TRANSIENT_RETRY_MS, row.agent_id);
      return;
    }
    // Another CLI/worker may have failed while the native command was awaited.
    // Count from durable state and journal the transition in the same transaction.
    db.exec("BEGIN IMMEDIATE");
    try {
      const current = db.prepare("SELECT attempts, last_error FROM native_session_queue WHERE agent_id = ? AND status = 'pending'").get(row.agent_id) as Pick<QueueRow, "attempts" | "last_error"> | undefined;
      if (current) {
        const attempts = current.attempts + 1;
        const terminal = attempts >= NATIVE_MAX_ATTEMPTS;
        const retryAt = terminal ? null : new Date(now.getTime() + nativeRetryDelayMs(attempts));
        db.prepare("UPDATE native_session_queue SET attempts = ?, retry_at = ?, status = ?, last_error = ? WHERE agent_id = ?")
          .run(attempts, retryAt ? +retryAt : 0, terminal ? "failed" : "pending", error, row.agent_id);
        if (terminal || nativeErrorClass(error) !== nativeErrorClass(current.last_error)) {
          record(row.task_id, "native_session_archive_failed", { ...session, error, attempts, terminal, retryAt: retryAt?.toISOString() ?? null });
        }
      }
      db.exec("COMMIT");
    } catch (failure) { db.exec("ROLLBACK"); throw failure; }
  } finally { release?.(); }
}
/** Only queued successful retirements; never enumerates historical cards or native directories. */
export function processNativeSessionBatch(options: NativeSessionOptions = {}): Promise<{ processed: number }> {
  if (processing) return processing;
  processing = new Promise<void>(resolve => setImmediate(resolve)).then(async () => {
    const rows = getDb().prepare("SELECT * FROM native_session_queue WHERE status = 'pending' AND retry_at <= ? ORDER BY retry_at, agent_id LIMIT ?").all(+(options.now ?? new Date()), NATIVE_BATCH_LIMIT) as unknown as QueueRow[];
    if (!rows.length) return { processed: 0 };
    const index = await indexNativeAgents({ agentIds: rows.map(row => row.agent_id), sessions: rows.map(row => ({ provider: row.provider, sessionId: row.session_id })) });
    for (const row of rows) await archiveOne(row, index, options);
    return { processed: rows.length };
  }).finally(() => { processing = null; });
  return processing;
}

type EventRow = { task_id: number; kind: string; data_json: string };
/** A native_session_skipped summary row (DEMO_0001) stands for every agent in its `sessions` list: read it as one row per agent. */
function expandSkipped(row: EventRow): EventRow[] {
  if (row.kind !== "native_session_skipped") return [row];
  const data = JSON.parse(row.data_json) as { sessions?: unknown };
  if (!Array.isArray(data.sessions)) return [row];
  return [row, ...data.sessions.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .map(item => ({ ...row, data_json: JSON.stringify({ ...data, ...item, sessions: undefined }) }))];
}
interface History { kind: string; taskId: number; agentId?: string; provider?: string; sessionId?: string; cwd?: string; home?: string; moves?: Move[]; action?: string; ok?: boolean }
async function codexIndex(home: string): Promise<{ threads: Map<string, { cwd: string; archived: number }>; error?: string }> {
  const threads = new Map<string, { cwd: string; archived: number }>();
  try {
    const dir = join(home, ".codex"); await safePath(home, dir);
    const files = (await readdir(dir)).filter(name => /^state_\d+\.sqlite$/.test(name)).sort((a, b) => Number(b.match(/\d+/)![0]) - Number(a.match(/\d+/)![0]));
    if (!files.length) throw new Error(t("nativeSessions.codex.noIndex"));
    const path = join(dir, files[0]); await safePath(home, path);
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      db.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 1000");
      // Only metadata. Do not read title, prompt, rollout contents or credentials.
      for (const row of db.prepare("SELECT id, cwd, archived FROM threads").all() as Array<{ id: string; cwd: string; archived: number }>) threads.set(row.id, row);
    } finally { db.close(); }
    return { threads };
  } catch (err) { return { threads, error: err instanceof Error ? err.message : String(err) }; }
}
function latestRetirement(history: History[]): boolean {
  const last = history.filter(e => e.kind === "native_session_ready" || (e.kind === "cleanup" && ["archive_agent", "verify_agent", "wait_turn"].includes(e.action ?? ""))).at(-1);
  return Boolean(last && (last.kind === "native_session_ready" || (last.ok === true && last.action !== "wait_turn")));
}
function resetFailedSession(input: NativeSweepInput, agentId: string, db: DatabaseSync, identity: Identity) {
  if (identity.role !== "supervisor") throw new KanbanError("forbidden", t("nativeSessions.reset.leaderOnly"));
  const row = db.prepare("SELECT * FROM native_session_queue WHERE agent_id = ?").get(agentId) as QueueRow | undefined;
  if (!row) throw new KanbanError("not_found", t("nativeSessions.reset.notFound"));
  if (row.task_id === UNCARDED_TASK_ID) {
    // Match restore: uncarded sessions have no project for a project leader to manage.
    if (nativeLeaderProjects(identity)) throw new KanbanError("forbidden", t("nativeSessions.reset.uncardedKanbanLeader"));
  } else {
    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(row.task_id) as TaskRow | undefined;
    if (!task) throw new KanbanError("not_found", t("nativeSessions.reset.cardMissing"));
    if (!identity.agentId || identity.agentId !== loadConfig().supervisorAgentId) assertSupervisorScope(identity, task, t("nativeSessions.reset.action"));
  }
  if (row.status !== "failed") throw new KanbanError("conflict", t("nativeSessions.reset.onlyFailed", { status: row.status }));
  const dryRun = input.dryRun === true;
  if (!dryRun) {
    const writable = getDb();
    writable.exec("BEGIN IMMEDIATE");
    try {
      const changed = writable.prepare("UPDATE native_session_queue SET status = 'pending', attempts = 0, retry_at = 0 WHERE agent_id = ? AND status = 'failed'").run(row.agent_id);
      if (changed.changes !== 1) throw new KanbanError("conflict", t("nativeSessions.reset.changed"));
      appendEvent(row.task_id, "native_session_reset", null, null, identity.agentId ?? "supervisor", { ...fromRow(row), previousAttempts: row.attempts, previousRetryAt: row.retry_at, lastError: row.last_error });
      writable.exec("COMMIT");
    } catch (err) { writable.exec("ROLLBACK"); throw err; }
  }
  return { ok: true, dryRun, reset: !dryRun, agentId: row.agent_id, taskId: row.task_id, from: "failed", to: "pending", attempts: 0, retryAt: 0, lastError: row.last_error };
}
export interface NativeSweepInput { reconcileCodex?: boolean; reconcileClaude?: boolean; includeTmpSessions?: boolean; resetFailed?: string; restore?: string; restoreManifest?: string; sweep?: boolean; apply?: boolean; dryRun?: boolean; project?: string; limit?: number; offset?: number }
/** Native-session maintenance is board-wide for the Kanban leader only. */
function nativeLeaderProjects(identity: ReturnType<typeof resolveCompactIdentity>): Set<string> | undefined {
  const config = loadConfig();
  if (!identity.agentId || identity.agentId === config.supervisorAgentId) return undefined;
  const projects = new Set(Object.entries(config.supervisors).filter(([, id]) => id === identity.agentId).map(([project]) => project));
  if (!projects.size) throw new KanbanError("forbidden", t("nativeSessions.scope.mustRegister"));
  return projects;
}
function assertNativeLeaderScope(identity: ReturnType<typeof resolveCompactIdentity>, project: string): void {
  const projects = nativeLeaderProjects(identity);
  if (projects && !projects.has(project)) throw new KanbanError("forbidden", t("nativeSessions.scope.otherProject", { project }));
}
const projectsFor = (identity: ReturnType<typeof resolveCompactIdentity>) => identity.role === "supervisor" ? nativeLeaderProjects(identity) : undefined;
/** One-off, idempotent: pending codex queue rows whose thread codex already marks archived become 'archived'.
 * Reads only the codex index (metadata); never runs codex or touches codex data. Default dry-run. */
async function reconcileCodexQueue(dryRun: boolean, projects: Set<string> | undefined, options: NativeSessionOptions) {
  const home = options.home ?? homedir();
  const db = dryRun ? getReadOnlyDb() : getDb();
  const hasQueue = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'native_session_queue'").get());
  const rows = (hasQueue ? db.prepare("SELECT q.*, t.project AS project FROM native_session_queue q JOIN tasks t ON t.id = q.task_id WHERE q.provider = 'codex' AND q.status = 'pending' ORDER BY q.task_id, q.agent_id").all() : []) as unknown as Array<QueueRow & { project: string }>;
  const indexes = new Map<string, Awaited<ReturnType<typeof codexIndex>>>();
  const lines: Array<Record<string, unknown>> = []; let unreadable = 0;
  for (const row of rows) {
    if (projects && !projects.has(row.project)) continue;
    if (!indexes.has(row.home)) indexes.set(row.home, await codexIndex(row.home));
    const index = indexes.get(row.home)!;
    if (index.error) { unreadable++; continue; }
    if (!index.threads.get(row.session_id)?.archived) continue;
    lines.push({ taskId: row.task_id, agentId: row.agent_id, provider: row.provider, sessionId: row.session_id, action: dryRun ? "mark_archived" : "marked_archived" });
    if (!dryRun) markCodexArchived(row, fromRow(row), "reconcile: codex already archived");
  }
  const text = t("nativeSessions.reconcile.codexSummary", { mode: dryRun ? t("nativeSessions.mode.dryRun") : t("nativeSessions.mode.reconciled"), pending: rows.length, archived: lines.length, unreadable: unreadable ? t("nativeSessions.reconcile.codexUnreadable", { count: unreadable }) : "" });
  options.progress?.(text);
  return { text, dryRun, pending: rows.length, unreadable, lines };
}
const SKIP_LABEL_KEYS: Record<SkipCategory, MessageKey> = {
  provider_unsupported: "nativeSessions.skipLabel.providerUnsupported", no_session_id: "nativeSessions.skipLabel.noSessionId", leader_kept: "nativeSessions.skipLabel.leaderKept",
  shared_kept: "nativeSessions.skipLabel.sharedKept", excluded: "nativeSessions.skipLabel.excluded", running: "nativeSessions.kept.running", no_native_files: "nativeSessions.skipLabel.noNativeFiles", other: "nativeSessions.skipLabel.other",
};
const skipCategory = (err: unknown): SkipCategory => err instanceof NativeKept ? err.category : "other";
type UncardedCandidate = { kind: "agent"; agentId: string } | { kind: "tmp"; sessionId: string; cwd: string };
interface UncardedContext { db: DatabaseSync; index: NativeAgentIndex; home: string; dryRun: boolean; options: NativeSessionOptions; claudeDirs: Set<string>; claudeError?: string; seen: Set<string> }
/** Archived Claude agents with no card (and optionally /tmp test residue). Metadata only; the per-candidate checks run in sweepUncarded. */
async function findUncarded(db: DatabaseSync, index: NativeAgentIndex, carded: Array<{ agentId: string }>,
  scan: { home: string; claudeDirs: Set<string>; includeTmp: boolean; now: Date; tmpRoots?: readonly string[] }) {
  const known = new Set(carded.map(item => item.agentId));
  const queuedSessions = new Set<string>();
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'native_session_queue'").get()) {
    for (const row of db.prepare("SELECT agent_id, provider, session_id FROM native_session_queue").all() as Array<{ agent_id: string; provider: string; session_id: string }>) { known.add(row.agent_id); queuedSessions.add(sessionKey(row.provider, row.session_id)); }
  }
  // Any agent a card ever opened belongs to that card's own path, whatever the card's state.
  for (const row of db.prepare(`SELECT agent_id AS id FROM runs WHERE agent_id IS NOT NULL UNION
    SELECT json_extract(data_json, '$.agentId') FROM events WHERE kind IN ('agent_opened','native_session_identified')`).all() as Array<{ id: string | null }>) if (row.id) known.add(row.id);
  const stats = { agents: 0, tmp: 0, otherProvider: 0, cardOwned: 0 };
  const candidates: UncardedCandidate[] = []; const handled = new Set<string>();
  for (const agent of [...index.agents.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!agent.archivedAt) continue;
    if (agent.provider !== "claude") { stats.otherProvider++; continue; }
    if (known.has(agent.id) || ["1", "true"].includes(agent.labels?.kanban ?? "")) { stats.cardOwned++; continue; }
    stats.agents++; candidates.push({ kind: "agent", agentId: agent.id });
    for (const sid of [agent.persistence?.sessionId, agent.persistence?.nativeHandle]) if (typeof sid === "string" && sid) handled.add(sessionKey("claude", sid));
  }
  if (scan.includeTmp) {
    for (const found of await findTmpResidueSessions(join(scan.home, ".claude", "projects"), scan.claudeDirs, scan.now, scan.tmpRoots)) {
      const key = sessionKey("claude", found.sessionId);
      if (handled.has(key) || queuedSessions.has(key)) continue;
      stats.tmp++; candidates.push({ kind: "tmp", sessionId: found.sessionId, cwd: found.cwd });
    }
  }
  return { candidates: candidates as Array<UncardedCandidate>, stats };
}
async function sweepUncarded(candidate: UncardedCandidate, ctx: UncardedContext): Promise<Record<string, unknown>> {
  const { db, index, home, dryRun, options } = ctx;
  const agent = candidate.kind === "agent" ? index.agents.get(candidate.agentId) : undefined;
  let session: Session | undefined;
  try {
    if (index.error) throw new Error(index.error);
    if (candidate.kind === "agent") {
      if (!agent) throw new Error(t("nativeSessions.uncarded.recordGone"));
      if (currentLeader(agent)) throw new NativeKept(t("nativeSessions.kept.currentLeader"), "leader_kept");
      if (agent.lastStatus === "running") throw new NativeKept(t("nativeSessions.kept.running"), "running");
      session = identify(agent);
    } else session = { agentId: `tmp-session-${candidate.sessionId}`, provider: "claude", sessionId: candidate.sessionId, cwd: candidate.cwd };
    const key = sessionKey(session.provider, session.sessionId);
    if (ctx.seen.has(key)) throw new Error(t("nativeSessions.uncarded.seen"));
    ctx.seen.add(key);
    protectShared(session, index, db, true);
    if (ctx.claudeError) throw new Error(ctx.claudeError);
    if (!ctx.claudeDirs.has(session.cwd.replace(/[^a-zA-Z0-9]/g, "-"))) throw new NativeKept(t("nativeSessions.claude.noProjectDir"), "no_native_files");
    const moves = await claudePlan(session, home);
    const line: Record<string, unknown> = { taskId: UNCARDED_TASK_ID, ...session, source: candidate.kind === "agent" ? "archived_agent" : "tmp_residue", action: "archive", moves };
    if (dryRun) return line;
    if (queueSession(UNCARDED_TASK_ID, session.agentId, home, session)) record(UNCARDED_TASK_ID, "native_session_identified", { ...session, source: line.source });
    ready(UNCARDED_TASK_ID, session.agentId, "sweep_confirmed");
    getDb().prepare("UPDATE native_session_queue SET moves_json = ? WHERE agent_id = ?").run(JSON.stringify(moves), session.agentId);
    const row = getDb().prepare("SELECT * FROM native_session_queue WHERE agent_id = ? AND status = 'pending'").get(session.agentId) as QueueRow | undefined;
    if (row) {
      await archiveOne(row, index, options);
      const state = getDb().prepare("SELECT status FROM native_session_queue WHERE agent_id = ?").get(session.agentId) as { status: string };
      line.action = state.status === "archived" ? "archived" : state.status === "restored" ? "restored" : "archive_failed";
    }
    return line;
  } catch (err) {
    return { taskId: UNCARDED_TASK_ID, agentId: session?.agentId ?? (candidate.kind === "agent" ? candidate.agentId : ""), sessionId: session?.sessionId, action: "skip", category: skipCategory(err), reason: err instanceof Error ? err.message : String(err) };
  }
}
/** One-off, idempotent: pending claude queue rows whose live jsonl is gone but whose exact jsonl sits in projects-archive become 'archived'.
 * Reads directory metadata only (no jsonl contents) and writes only the board database; moves nothing. Default dry-run.
 * The moves it records let --restore put the session back. Uncarded rows (task 0) are the Kanban leader's only. */
async function reconcileClaudeQueue(dryRun: boolean, projects: Set<string> | undefined, options: NativeSessionOptions) {
  const db = dryRun ? getReadOnlyDb() : getDb();
  const hasQueue = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'native_session_queue'").get());
  const rows = (hasQueue ? db.prepare("SELECT q.*, t.project AS project FROM native_session_queue q LEFT JOIN tasks t ON t.id = q.task_id WHERE q.provider = 'claude' AND q.status = 'pending' ORDER BY q.task_id, q.agent_id").all() : []) as unknown as Array<QueueRow & { project: string | null }>;
  const lines: Array<Record<string, unknown>> = []; let unreadable = 0; let live = 0; let notArchived = 0;
  for (const row of rows) {
    if (projects && (!row.project || !projects.has(row.project))) continue;
    try {
      if (!isAbsolute(row.cwd) || !SAFE_NATIVE_ID.test(row.session_id)) throw new Error(t("nativeSessions.reconcile.rowIncomplete"));
      const project = row.cwd.replace(/[^a-zA-Z0-9]/g, "-");
      const dir = join(row.home, ".claude", "projects", project); const archive = join(row.home, ".claude", "projects-archive", project);
      const source = join(dir, `${row.session_id}.jsonl`); await safePath(row.home, source); await safePath(row.home, archive);
      if (await stat(source)) { live++; continue; }
      const names = await readdir(archive).catch(err => { if ((err as NodeJS.ErrnoException).code === "ENOENT") return [] as string[]; throw err; });
      const found = names.filter(name => name === `${row.session_id}.jsonl` || (name.startsWith(`${row.session_id}.`) && name.endsWith(".jsonl")));
      if (found.length !== 1) { if (found.length) throw new Error(t("nativeSessions.reconcile.duplicateJsonl")); notArchived++; continue; }
      const target = join(archive, found[0]); await safePath(row.home, target);
      if (!(await stat(target))?.isFile()) throw new Error(t("nativeSessions.reconcile.jsonlNotFile"));
      const moves: Move[] = [{ source, target }];
      const companion = join(archive, found[0].slice(0, -6)); await safePath(row.home, companion);
      if ((await stat(companion))?.isDirectory()) moves.push({ source: join(dir, row.session_id), target: companion });
      checkClaudeMoves(row.session_id, moves, dir, archive);
      lines.push({ taskId: row.task_id, agentId: row.agent_id, provider: row.provider, sessionId: row.session_id, targetPath: target, action: dryRun ? "mark_archived" : "marked_archived" });
      if (dryRun) continue;
      record(row.task_id, "native_session_archived", { ...fromRow(row), home: row.home, moves, removedProjectDir: null, action: "reconcile: claude already archived", targetPath: target });
      getDb().prepare("UPDATE native_session_queue SET status = 'archived', moves_json = ? WHERE agent_id = ?").run(JSON.stringify(moves), row.agent_id);
    } catch { unreadable++; }
  }
  const text = t("nativeSessions.reconcile.claudeSummary", {
    mode: dryRun ? t("nativeSessions.mode.dryRun") : t("nativeSessions.mode.reconciled"), pending: rows.length, archived: lines.length,
    live: live ? t("nativeSessions.reconcile.claudeLive", { count: live }) : "",
    notArchived: notArchived ? t("nativeSessions.reconcile.claudeNotArchived", { count: notArchived }) : "",
    unreadable: unreadable ? t("nativeSessions.reconcile.claudeUnreadable", { count: unreadable }) : "",
  });
  options.progress?.(text);
  return { text, dryRun, pending: rows.length, live, notArchived, unreadable, lines };
}
export async function nativeSessionsCommand(input: NativeSweepInput, env: NodeJS.ProcessEnv, options: NativeSessionOptions = {}) {
  if ([input.restore, input.restoreManifest, input.sweep, input.resetFailed, input.reconcileCodex, input.reconcileClaude].filter(Boolean).length !== 1) throw new KanbanError("invalid", t("nativeSessions.cli.pickOne"));
  for (const [flag, on] of [["--reconcile-codex", input.reconcileCodex], ["--reconcile-claude", input.reconcileClaude]] as const) {
    if (on && (input.project || input.limit != null || input.offset != null)) throw new KanbanError("invalid", t("nativeSessions.cli.applyOnly", { flag }));
  }
  if (input.includeTmpSessions && !input.sweep) throw new KanbanError("invalid", t("nativeSessions.cli.tmpNeedsSweep"));
  if (input.resetFailed && (input.resetFailed === "true" || !SAFE_NATIVE_ID.test(input.resetFailed))) throw new KanbanError("invalid", t("nativeSessions.cli.resetNeedsAgent"));
  if (input.resetFailed && (input.apply || input.project || input.limit != null || input.offset != null)) throw new KanbanError("invalid", t("nativeSessions.cli.resetDryRunOnly"));
  if (input.restore && (input.apply || input.dryRun || input.project || input.limit != null || input.offset != null)) throw new KanbanError("invalid", t("nativeSessions.cli.restoreNoSweepArgs"));
  if (input.restoreManifest && (input.apply || input.project || input.limit != null || input.offset != null)) throw new KanbanError("invalid", t("nativeSessions.cli.manifestDryRunOnly"));
  for (const [name, value, min] of [["limit", input.limit, 1], ["offset", input.offset, 0]] as const) if (value != null && (!Number.isSafeInteger(value) || value < min)) throw new KanbanError("invalid", t("nativeSessions.cli.badNumber", { name }));
  const started = performance.now(); const db = getReadOnlyDb(); const identity = resolveCompactIdentity(env, db);
  if (identity.role === GUEST_ROLE || identity.role === SCHEDULE_ROLE) throw new KanbanError("forbidden", t("nativeSessions.scope.mustRegister"));
  if (input.resetFailed) return resetFailedSession(input, input.resetFailed, db, identity);
  const dryRun = !input.apply || input.dryRun === true;
  if (identity.role !== "supervisor" && (!dryRun || input.restore || input.restoreManifest)) throw new KanbanError("forbidden", t("nativeSessions.cli.leaderOnlyChange"));
  if ((input.reconcileCodex || input.reconcileClaude) && identity.role !== "supervisor") throw new KanbanError("forbidden", t("nativeSessions.cli.leaderOnlyReconcile"));
  if (input.reconcileCodex) return reconcileCodexQueue(dryRun, projectsFor(identity), options);
  if (input.reconcileClaude) return reconcileClaudeQueue(dryRun, projectsFor(identity), options);
  if (input.restoreManifest) return restoreManifest(input.restoreManifest, input.dryRun === true, identity, options);
  if (input.restore) return restoreSession(input.restore, identity, options);
  let project = input.project;
  // A worker can perform the requested read-only acceptance check, confined to its project.
  if (identity.role !== "supervisor") {
    const task = db.prepare("SELECT project FROM tasks WHERE id = ?").get(identity.taskId) as { project: string } | undefined;
    if (!task || (project && project !== task.project)) throw new KanbanError("forbidden", t("nativeSessions.cli.ownProjectOnly"));
    project = task.project;
  } else if (project) {
    assertNativeLeaderScope(identity, project);
  }
  const projects = identity.role === "supervisor" ? nativeLeaderProjects(identity) : new Set([project!]);
  const progress = options.progress ?? (() => {});
  progress(t("nativeSessions.sweep.progressStart"));
  const tasks = db.prepare(`SELECT * FROM tasks WHERE status IN ('done','archived') ${project ? "AND project = ?" : ""}
    AND EXISTS (SELECT 1 FROM events e WHERE e.task_id = tasks.id AND e.kind IN ('cleanup_finished','temp_workspace_cleaned')) ORDER BY id`).all(...(project ? [project] : [])) as unknown as TaskRow[];
  const scoped = tasks.filter(task => !projects || projects.has(task.project));
  const taskMap = new Map(scoped.map(task => [task.id, task]));
  // One pass for all relevant events and runs; no per-agent historical SQL/JSON parsing.
  const history = new Map<string, History[]>(); const candidates = new Map<string, { taskId: number; agentId: string }>();
  const add = (taskId: number, agentId: string) => { if (taskMap.has(taskId) && SAFE_NATIVE_ID.test(agentId)) candidates.set(`${taskId}:${agentId}`, { taskId, agentId }); };
  const rows = db.prepare(`SELECT e.task_id, e.kind, e.data_json FROM events e JOIN tasks t ON t.id = e.task_id
    WHERE t.status IN ('done','archived') ${project ? "AND t.project = ?" : ""}
    AND (e.kind IN ('agent_opened','native_session_identified','native_session_ready','native_session_archive_planned','native_session_archived','native_session_restored','native_session_skipped')
      OR (e.kind = 'cleanup' AND json_extract(e.data_json,'$.action') IN ('archive_agent','verify_agent','wait_turn'))) ORDER BY e.id`).all(...(project ? [project] : [])) as Array<{ task_id: number; kind: string; data_json: string }>;
  const completed = new Map<string, string>();
  for (const row of rows.flatMap(expandSkipped)) {
    const e = { ...JSON.parse(row.data_json), kind: row.kind, taskId: row.task_id } as History;
    if (["native_session_archived", "native_session_restored"].includes(e.kind) && e.provider && e.sessionId) completed.set(sessionKey(e.provider, e.sessionId), e.kind);
    if (!e.agentId || !taskMap.has(e.taskId)) continue;
    if (["agent_opened", "native_session_identified"].includes(e.kind)) add(e.taskId, e.agentId);
    const key = `${e.taskId}:${e.agentId}`; const list = history.get(key) ?? []; list.push(e); history.set(key, list);
  }
  for (const run of db.prepare("SELECT task_id, agent_id FROM runs WHERE agent_id IS NOT NULL").all() as Array<{ task_id: number; agent_id: string }>) add(run.task_id, run.agent_id);
  const failedAgents = new Set<string>(); const skippedAgents = new Set<string>();
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'native_session_queue'").get()) {
    for (const row of db.prepare("SELECT agent_id FROM native_session_queue WHERE status = 'failed'").all() as Array<{ agent_id: string }>) failedAgents.add(row.agent_id);
    // The queue keeps the exclusion after compact-events has removed the old native_session_skipped rows.
    for (const row of db.prepare("SELECT agent_id FROM native_session_queue WHERE status = 'skipped'").all() as Array<{ agent_id: string }>) skippedAgents.add(row.agent_id);
  }
  const index = await indexNativeAgents();
  for (const agent of index.agents.values()) if (["1", "true"].includes(agent.labels?.kanban ?? "")) add(Number(agent.labels?.kanban_task), agent.id);
  progress(t("nativeSessions.sweep.progressIndex", { cards: scoped.length, agents: index.agents.size, candidates: candidates.size }));
  const home = options.home ?? homedir();
  const codex = await codexIndex(home); // One readonly threads query for the whole sweep.
  let claudeDirs = new Set<string>(); let claudeError: string | undefined;
  try {
    const dir = join(home, ".claude", "projects"); await safePath(home, dir);
    claudeDirs = new Set((await readdir(dir, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name));
  } catch (err) { claudeError = err instanceof Error ? err.message : String(err); }
  const carded = [...candidates.values()].sort((a, b) => a.taskId - b.taskId || a.agentId.localeCompare(b.agentId)).map(item => ({ kind: "card" as const, ...item }));
  // Uncarded sessions belong to no card, so only the board-wide Kanban leader (no project filter) may collect them.
  const boardWide = !projects && !project;
  const uncarded = boardWide ? await findUncarded(db, index, carded, { home, claudeDirs, includeTmp: input.includeTmpSessions === true, now: options.now ?? new Date(), tmpRoots: options.tmpRoots }) : null;
  const ordered = [...carded, ...(uncarded?.candidates ?? [])];
  const selected = ordered.slice(input.offset ?? 0, (input.offset ?? 0) + (input.limit ?? ordered.length));
  const lines: Array<Record<string, unknown>> = [];
  const seenUncarded = new Set<string>();
  for (const candidate of selected) {
    if (candidate.kind !== "card") { lines.push(await sweepUncarded(candidate, { db, index, home, dryRun, options, claudeDirs, claudeError, seen: seenUncarded })); continue; }
    const { taskId, agentId } = candidate; const events = history.get(`${taskId}:${agentId}`) ?? []; const agent = index.agents.get(agentId);
    try {
      if (index.error) throw new Error(index.error);
      if (agent && protectedAgent(agent)) throw new NativeKept(t("nativeSessions.kept.leader"), "leader_kept");
      if (skippedAgents.has(agentId) || events.some(e => e.kind === "native_session_skipped")) throw new NativeKept(t("nativeSessions.kept.excluded"), "excluded");
      const saved = events.filter(e => e.kind === "native_session_identified").at(-1);
      const session: Session = agent ? identify(agent) : { agentId, provider: saved?.provider ?? "", sessionId: saved?.sessionId ?? "", cwd: saved?.cwd ?? "" };
      if (!session.provider || (["claude", "codex"].includes(session.provider) && !SAFE_NATIVE_ID.test(session.sessionId))) throw new NativeKept(t("nativeSessions.kept.noSavedSessionId"), "no_session_id");
      if (completed.has(sessionKey(session.provider, session.sessionId))) {
        let removedProjectDir: string | null = null;
        if (!dryRun && session.provider === "claude" && completed.get(sessionKey(session.provider, session.sessionId)) === "native_session_archived") {
          protectShared(session, index, db);
          const release = claim(home, session);
          try { removedProjectDir = await removeEmptyClaudeProject(session, home, taskId); } finally { release(); }
        }
        lines.push({ taskId, ...session, action: "already_collected", removedProjectDir }); continue;
      }
      if (!latestRetirement(events) && !agent?.archivedAt) throw new Error(t("nativeSessions.sweep.noEvidence"));
      if (!["codex", "claude"].includes(session.provider)) { lines.push({ taskId, ...session, action: "skip_provider", category: "provider_unsupported" }); continue; }
      if (failedAgents.has(agentId)) { lines.push({ taskId, ...session, action: "archive_failed", reason: t("nativeSessions.sweep.retryLimit") }); continue; }
      protectShared(session, index, db);
      let moves: Move[] = [];
      if (session.provider === "claude") {
        if (claudeError) throw new Error(claudeError);
        if (!claudeDirs.has(session.cwd.replace(/[^a-zA-Z0-9]/g, "-"))) throw new Error(t("nativeSessions.claude.noProjectDir"));
        moves = events.filter(e => e.kind === "native_session_archive_planned").at(-1)?.moves ?? await claudePlan(session, home);
      } else {
        if (codex.error) throw new Error(t("nativeSessions.codex.indexUnreadable", { error: codex.error }));
        const thread = codex.threads.get(session.sessionId);
        if (!thread || thread.cwd !== session.cwd) throw new Error(t("nativeSessions.codex.threadMismatch"));
        if (thread.archived) { lines.push({ taskId, ...session, action: "already_archived" }); continue; }
      }
      lines.push({ taskId, ...session, action: "archive", moves });
      if (!dryRun) {
        if (queueSession(taskId, agentId, home, session)) record(taskId, "native_session_identified", session);
        ready(taskId, agentId, "sweep_confirmed");
        if (moves.length) getDb().prepare("UPDATE native_session_queue SET moves_json = ? WHERE agent_id = ?").run(JSON.stringify(moves), agentId);
        const row = getDb().prepare("SELECT * FROM native_session_queue WHERE agent_id = ? AND status = 'pending'").get(agentId) as QueueRow | undefined;
        if (row) {
          await archiveOne(row, index, options);
          const state = getDb().prepare("SELECT status FROM native_session_queue WHERE agent_id = ?").get(agentId) as { status: string };
          lines.at(-1)!.action = state.status === "archived" ? "archived" : state.status === "restored" ? "restored" : "archive_failed";
        }
      }
    } catch (err) { lines.push({ taskId, agentId, action: "skip", category: skipCategory(err), reason: err instanceof Error ? err.message : String(err) }); }
    if (lines.length % 100 === 0) progress(t("nativeSessions.sweep.progressChecked", { checked: lines.length, total: selected.length }));
  }
  const counts: Record<string, number> = {}; const skipReasons: Record<string, number> = {};
  for (const line of lines) {
    counts[String(line.action)] = (counts[String(line.action)] ?? 0) + 1;
    if (typeof line.category === "string") skipReasons[line.category] = (skipReasons[line.category] ?? 0) + 1;
  }
  const summary = { tasks: scoped.length, agents: index.agents.size, candidates: ordered.length, checked: lines.length, remaining: Math.max(0, ordered.length - (input.offset ?? 0) - lines.length), counts, skipReasons, uncarded: uncarded?.stats ?? null, elapsedMs: Math.round(performance.now() - started) };
  const reasonText = Object.entries(skipReasons).map(([key, n]) => {
    const labelKey = SKIP_LABEL_KEYS[key as SkipCategory];
    return `${labelKey ? t(labelKey) : key} ${n}`;
  }).join(t("nativeSessions.sweep.reasonSep"));
  const uncardedText = uncarded ? t("nativeSessions.sweep.uncarded", {
    agents: uncarded.stats.agents,
    tmp: input.includeTmpSessions ? t("nativeSessions.sweep.uncardedTmp", { count: uncarded.stats.tmp }) : t("nativeSessions.sweep.uncardedTmpOff"),
  }) : "";
  const text = t("nativeSessions.sweep.summary", {
    mode: dryRun ? t("nativeSessions.mode.dryRun") : t("nativeSessions.mode.swept"),
    cards: summary.tasks, agents: summary.agents, candidates: summary.candidates, checked: summary.checked, remaining: summary.remaining,
    counts: JSON.stringify(counts), reasons: reasonText ? t("nativeSessions.sweep.reasons", { reasons: reasonText }) : "", uncarded: uncardedText, elapsed: summary.elapsedMs,
  });
  progress(text);
  return { text, dryRun, summary, lines };
}

interface ManifestPlan { project: string; sessionId: string; moves: Move[]; taskIds: number[]; cwdByTask: Map<number, string>; replay: boolean }
async function restoreManifest(path: string, dryRun: boolean, identity: ReturnType<typeof resolveCompactIdentity>, options: NativeSessionOptions) {
  const projects = nativeLeaderProjects(identity); const db = getReadOnlyDb(); const home = options.home ?? homedir();
  const manifest = resolve(path);
  const metadata = await stat(manifest);
  if (!metadata?.isFile() || metadata.isSymbolicLink() || metadata.size > 8 * 1024 * 1024) throw new KanbanError("invalid", t("nativeSessions.manifest.unsafe"));
  const data = JSON.parse(await readFile(manifest, "utf8")) as { items?: unknown };
  if (!data || !Array.isArray(data.items) || !data.items.length) throw new KanbanError("invalid", t("nativeSessions.manifest.noItems"));
  // Match project ownership from board metadata; never trust an item's project
  // field (the manual manifest uses that field for the encoded Claude cwd).
  const owners = db.prepare(`SELECT t.id, t.project, t.workspace_path AS directory FROM tasks t
    UNION SELECT t.id, t.project, json_extract(e.data_json, '$.directory') FROM events e JOIN tasks t ON t.id = e.task_id
    WHERE e.kind IN ('temp_workspace','worktree_created')`).all() as Array<{ id: number; project: string; directory: string | null }>;
  const plans: ManifestPlan[] = []; const sources = new Set<string>(); const targets = new Set<string>();
  for (const value of data.items) {
    if (!value || typeof value !== "object" || !Array.isArray(value.moves)) throw new KanbanError("invalid", t("nativeSessions.manifest.badMoves"));
    const moves: Move[] = value.moves.map((pair: unknown) => {
      if (!Array.isArray(pair) || pair.length !== 2 || pair.some(p => typeof p !== "string" || !isAbsolute(p) || resolve(p) !== p)) throw new KanbanError("invalid", t("nativeSessions.manifest.movesNotAbsolute"));
      return { source: pair[0], target: pair[1] };
    });
    const jsonl = moves.filter(move => move.source.endsWith(".jsonl"));
    if (jsonl.length !== 1) throw new KanbanError("invalid", t("nativeSessions.manifest.oneJsonl"));
    const sessionId = basename(jsonl[0].source, ".jsonl"); const project = basename(dirname(jsonl[0].source));
    if (!SAFE_NATIVE_ID.test(sessionId) || !/^[A-Za-z0-9-]+$/.test(project)) throw new KanbanError("invalid", t("nativeSessions.manifest.badSessionOrProject"));
    if (value.sessionId != null && value.sessionId !== sessionId) throw new KanbanError("invalid", t("nativeSessions.manifest.sessionIdMismatch"));
    const dir = join(home, ".claude", "projects", project); const archive = join(home, ".claude", "projects-archive", project);
    checkClaudeMoves(sessionId, moves, dir, archive);
    for (const move of moves) {
      if (sources.has(move.source) || targets.has(move.target)) throw new KanbanError("invalid", t("nativeSessions.manifest.duplicateMove"));
      sources.add(move.source); targets.add(move.target);
      await safePath(home, move.source); await safePath(home, move.target);
    }
    const matches = owners.filter(owner => owner.directory?.replace(/[^a-zA-Z0-9]/g, "-") === project);
    if (projects && (!matches.length || matches.some(owner => !projects.has(owner.project)))) throw new KanbanError("forbidden", t("nativeSessions.manifest.foreign"));
    const taskIds = [...new Set(matches.map(owner => owner.id))];
    const replay = taskIds.some(id => Boolean(db.prepare(`SELECT 1 FROM events WHERE task_id = ? AND kind = 'native_session_manifest_restore_planned'
      AND json_extract(data_json, '$.home') = ? AND json_extract(data_json, '$.moves') = ? LIMIT 1`).get(id, home, JSON.stringify(moves))));
    plans.push({ project, sessionId, moves, taskIds, cwdByTask: new Map(matches.map(owner => [owner.id, owner.directory!])), replay });
  }
  const preflight = async (plan: ManifestPlan) => {
    for (const move of plan.moves) {
      await safePath(home, move.source); await safePath(home, move.target);
      const from = await stat(move.target); const to = await stat(move.source);
      if ((!from && !(to && plan.replay)) || (from && to)) throw new Error(t("nativeSessions.move.conflict"));
      const file = move.source.endsWith(".jsonl"); const entry = from ?? to!;
      if (file ? !entry.isFile() : !entry.isDirectory()) throw new Error(t("nativeSessions.manifest.typeMismatch"));
    }
  };
  // Validate the entire manifest before any mkdir, migration, journal or move.
  for (const plan of plans) await preflight(plan);
  const releases: Array<() => void> = []; let restored = 0;
  try {
    if (!dryRun) {
      for (const project of [...new Set(plans.map(plan => plan.project))].sort()) releases.push(claim(home, { provider: "claude", cwd: project, sessionId: "", agentId: "" }));
      for (const plan of plans) await preflight(plan);
      for (const plan of plans) {
        for (const id of plan.taskIds) record(id, "native_session_manifest_restore_planned", { manifest, home, sessionId: plan.sessionId, moves: plan.moves });
        for (const move of plan.moves) {
          if (!(await stat(move.target))) continue; // only a journaled partial replay
          await mkdir(dirname(move.source), { recursive: true }); await safePath(home, move.source); await safePath(home, move.target);
          if (await stat(move.source)) throw new Error(t("nativeSessions.move.targetExists"));
          await rename(move.target, move.source); restored++;
        }
        for (const id of plan.taskIds) {
          record(id, "native_session_manifest_restored", { manifest, home, sessionId: plan.sessionId, moves: plan.moves });
          record(id, "native_session_restored", { provider: "claude", cwd: plan.cwdByTask.get(id), sessionId: plan.sessionId, home, moves: plan.moves, manifest });
        }
        // Protect manually restored sessions from subsequent automatic capture.
        const queued = getDb().prepare("SELECT agent_id, cwd FROM native_session_queue WHERE provider = 'claude' AND session_id = ? AND home = ?")
          .all(plan.sessionId, home) as Array<{ agent_id: string; cwd: string }>;
        for (const row of queued) if (row.cwd.replace(/[^a-zA-Z0-9]/g, "-") === plan.project) {
          getDb().prepare("UPDATE native_session_queue SET status = 'restored' WHERE agent_id = ?").run(row.agent_id);
        }
        options.progress?.(t("nativeSessions.manifest.progress", { checked: plans.indexOf(plan) + 1, total: plans.length }));
      }
    }
    const planned = plans.reduce((sum, plan) => sum + plan.moves.length, 0);
    return { text: t("nativeSessions.manifest.summary", { mode: dryRun ? t("nativeSessions.mode.dryRun") : t("nativeSessions.mode.manifestRestored"), sessions: plans.length, moves: planned, restored }), dryRun, manifest, planned, restored,
      lines: plans.map(plan => ({ sessionId: plan.sessionId, project: plan.project, moves: plan.moves, action: dryRun ? "restore" : "restored" })) };
  } finally { for (const release of releases.reverse()) release(); }
}

async function restoreSession(sessionId: string, identity: ReturnType<typeof resolveCompactIdentity>, options: NativeSessionOptions) {
  if (!SAFE_NATIVE_ID.test(sessionId)) throw new KanbanError("invalid", t("nativeSessions.restore.badSessionId"));
  const rows = getReadOnlyDb().prepare(`SELECT task_id, kind, data_json FROM events WHERE kind IN ('native_session_archived','native_session_restored','native_session_restore_planned')
    AND json_extract(data_json,'$.sessionId') = ? ORDER BY id`).all(sessionId) as Array<{ task_id: number; kind: string; data_json: string }>;
  const history = rows.map(row => ({ ...JSON.parse(row.data_json), kind: row.kind, taskId: row.task_id } as History));
  const archived = history.filter(e => e.kind === "native_session_archived");
  if (!archived.length || new Set(archived.map(e => JSON.stringify([e.provider, e.cwd, e.home, e.moves]))).size !== 1) throw new KanbanError("invalid", t("nativeSessions.restore.notUnique"));
  for (const e of archived) {
    if (e.taskId === UNCARDED_TASK_ID) {
      // No card, no project: only the Kanban leader (or a direct terminal user) may restore it.
      if (nativeLeaderProjects(identity)) throw new KanbanError("forbidden", t("nativeSessions.restore.uncardedKanbanLeader"));
      continue;
    }
    const task = getReadOnlyDb().prepare("SELECT project FROM tasks WHERE id = ?").get(e.taskId) as { project: string } | undefined;
    if (!task) throw new KanbanError("invalid", t("nativeSessions.restore.cardMissing"));
    assertNativeLeaderScope(identity, task.project);
  }
  const row = archived.at(-1)!; const home = row.home ?? options.home ?? homedir();
  if (options.home && options.home !== home) throw new Error(t("nativeSessions.restore.homeMismatch"));
  const session: Session = { agentId: row.agentId ?? "", provider: row.provider ?? "", cwd: row.cwd ?? "", sessionId };
  const release = claim(home, session);
  try {
    if (getDb().prepare("SELECT 1 FROM events WHERE kind = 'native_session_restored' AND json_extract(data_json,'$.sessionId') = ? LIMIT 1").get(sessionId)) return { text: t("nativeSessions.restore.already"), sessionId };
    if (session.provider === "codex") await (options.command ?? codex)("unarchive", sessionId, home);
    else if (session.provider === "claude" && row.moves?.length) {
      const replay = history.some(e => e.kind === "native_session_restore_planned");
      // Validate all originals before creating a replayable restore plan.
      if (!replay) for (const move of row.moves) { await safePath(home, move.source); if (await stat(move.source)) throw new Error(t("nativeSessions.move.targetExists")); }
      record(row.taskId, "native_session_restore_planned", { ...session, moves: row.moves });
      await moveAll(session, row.moves, home, true, replay);
    } else throw new Error(t("nativeSessions.restore.recordMissing"));
    record(row.taskId, "native_session_restored", { ...session, moves: row.moves });
    getDb().prepare("UPDATE native_session_queue SET status = 'restored' WHERE provider = ? AND session_id = ?").run(session.provider, sessionId);
    return { text: t("nativeSessions.restore.done"), sessionId };
  } catch (err) { record(row.taskId, "native_session_restore_failed", { ...session, error: err instanceof Error ? err.message : String(err) }); throw err; }
  finally { release(); }
}
