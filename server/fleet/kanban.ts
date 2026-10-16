/// <reference types="node" />
// Read-only view of the Paseo Kanban board. Task flow belongs to Kanban; AFC only needs
// column counts, which blocked cards are waiting on a person, which agents still
// belong to an unfinished card (so the idle sweep does not archive them), and why an
// unfinished card is waiting (queue.ts classifies that).
//
// Kanban is found through its contract files (kanban-source.ts): column counts come from
// board-summary.json, and the deeper reads below open the database the summary names, read-only.
// When Kanban is absent every reader returns its empty, hidden result.
import { existsSync, readFileSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { BoardSummary } from "../contract";
import { displayCardCode, type ProjectCodes } from "../../shared/fleet/card-code";
import type { LeaderCard } from "../../shared/fleet/leader-panel";
import type { QueueTask } from "./queue";
import { type KanbanPresence, kanbanDeepDb, kanbanSource, staleNote } from "./kanban-source";
import { kanbanConfigPath } from "./paths";
import { cached } from "./util";
import { escapeRegExp } from "../../shared/fleet/decision-parse";
import { type MessageKey, t, tAll } from "../../shared/fleet/i18n";

const CONFIG_PATH = kanbanConfigPath();

/** A database path is usable only when it is set and the file exists. */
function usableDb(dbPath: string | null): dbPath is string {
  return dbPath !== null && existsSync(dbPath);
}

let codeCache: { path: string; mtimeMs: number; codes: ProjectCodes } | null = null;

function codesFromConfig(parsed: unknown): ProjectCodes {
  if (!parsed || typeof parsed !== "object") return {};
  const projects = (parsed as { projects?: unknown }).projects;
  if (!projects || typeof projects !== "object") return {};
  const codes: Record<string, string> = {};
  for (const [name, row] of Object.entries(projects)) {
    if (!row || typeof row !== "object") continue;
    const code = (row as { code?: unknown }).code;
    if (typeof code !== "string") continue;
    const trimmed = code.trim();
    if (trimmed) codes[name] = trimmed;
  }
  return codes;
}

/** Project short codes. Re-reads `kanban.config.json` only when the file's mtime changes. Missing or broken file → {}. */
export function projectCodes(configPath = CONFIG_PATH): ProjectCodes {
  let mtimeMs = -1;
  try {
    mtimeMs = statSync(configPath).mtimeMs;
  } catch {
    codeCache = codeCache?.path === configPath && codeCache.mtimeMs === -1 ? codeCache : { path: configPath, mtimeMs: -1, codes: {} };
    return codeCache.codes;
  }
  if (codeCache && codeCache.path === configPath && codeCache.mtimeMs === mtimeMs) return codeCache.codes;
  let codes: ProjectCodes = {};
  try {
    codes = codesFromConfig(JSON.parse(readFileSync(configPath, "utf8")) as unknown);
  } catch {
    codes = {};
  }
  codeCache = { path: configPath, mtimeMs, codes };
  return codes;
}

/** Display number for one card. Falls back to `#<id>` when the sequence or the short code is missing. */
export function formatCardCode(
  project: string,
  id: number,
  codeSeq: number | null | undefined,
  configPath = CONFIG_PATH,
): string {
  return displayCardCode(project, id, codeSeq, projectCodes(configPath));
}

function codeSeqOf(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value >= 1) return value;
  if (typeof value === "bigint" && value >= 1n && value <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(value);
  if (typeof value === "string" && /^[1-9]\d*$/.test(value)) {
    const n = Number(value);
    if (Number.isSafeInteger(n)) return n;
  }
  return null;
}

/** Expression for tasks.code_seq. Older databases have no such column; callers alias it. */
function codeSeqExpr(names: Set<string>, qualified = ""): string {
  return names.has("code_seq") ? `${qualified}code_seq` : "NULL";
}

/** Columns worth showing in the cockpit, in board order (labels match Kanban's own). */
const COLUMNS: ReadonlyArray<readonly [string, MessageKey]> = [
  ["triage", "kanban.column.triage"],
  ["ready", "kanban.column.ready"],
  ["running", "kanban.column.running"],
  ["in_review", "kanban.column.inReview"],
  ["reviewing", "kanban.column.reviewing"],
  ["rework", "kanban.column.rework"],
  ["acceptance", "kanban.column.acceptance"],
  ["blocked", "kanban.column.blocked"],
];

/**
 * Blocked kinds that clear by themselves (a parent finishing, a retry, a quota reset) — not the user's job.
 * Kanban writes them in English; older boards may hold the Chinese names, so every language matches.
 */
function selfClearingRe(): RegExp {
  const keys: MessageKey[] = ["kanban.blockedKind.dependency", "kanban.blockedKind.transient", "kanban.blockedKind.quota"];
  const words = ["rate_limit", "scheduled", ...keys.flatMap((key) => tAll(key))];
  return new RegExp(`^(${words.map(escapeRegExp).join("|")})$`, "i");
}

export interface KanbanBlocked {
  id: number;
  /** `<CODE>_0001`, or `#<id>` when the sequence or short code is missing. */
  code: string;
  project: string;
  title: string;
  kind: string | null;
  reason: string;
  blockedAt: string | null;
  agentId: string | null;
}

const loggedReadFailures = new Set<string>();

/** Logs a degraded read once per reader and message, so polling never floods the log. */
function logReadFailure(reader: string, error: unknown): void {
  const message = String(error).slice(0, 120);
  const key = `${reader}|${message}`;
  if (loggedReadFailures.has(key)) return;
  loggedReadFailures.add(key);
  console.error(`[afc] kanban ${reader} read failed`, message);
}

/**
 * Opens the Kanban database read-only, runs `fn`, and always closes it.
 * Open and query errors propagate to the caller; a failed close is logged, never silent.
 */
function withKanbanDb<T>(dbPath: string, fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return fn(db);
  } finally {
    try {
      db.close();
    } catch (error) {
      console.error("[afc] kanban.db close failed", String(error).slice(0, 120));
    }
  }
}

export interface KanbanView {
  /** absent: Kanban is not installed (no kanban.json); the board panels hide. */
  presence: KanbanPresence;
  available: boolean;
  counts: Array<{ status: string; label: string; count: number }>;
  /** Same counts split by project, so paused projects can be taken out. */
  byProject: Array<{ project: string; status: string; count: number }>;
  needsPerson: KanbanBlocked[];
  warning: string | null;
}

type ProjectCount = { project: string; status: string; count: number };

/** Cards per (project, status) from the board summary. Finished cards in the summary are counted too; columns drop them. */
export function countsFromSummary(summary: BoardSummary): ProjectCount[] {
  const counts = new Map<string, ProjectCount>();
  for (const card of summary.cards) {
    const key = `${card.project}\u0000${card.status}`;
    const row = counts.get(key) ?? { project: card.project, status: card.status, count: 0 };
    counts.set(key, { ...row, count: row.count + 1 });
  }
  return [...counts.values()];
}

function columnCounts(byProject: readonly ProjectCount[]): KanbanView["counts"] {
  const byStatus = new Map<string, number>();
  for (const r of byProject) byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + r.count);
  return COLUMNS.map(([status, label]) => ({ status, label: t(label), count: byStatus.get(status) ?? 0 }));
}

/** Blocked cards that need a person. Deep query: titles and reasons are not in the board summary. */
function readNeedsPerson(db: DatabaseSync, codes: ProjectCodes): KanbanBlocked[] {
  const taskCols = columnNames(db, "tasks");
  const blocked = db
    .prepare(`SELECT id, project, title, blocked_kind, blocked_reason, blocked_at, agent_id, ${codeSeqExpr(taskCols)} AS code_seq FROM tasks WHERE status = 'blocked' ORDER BY blocked_at`)
    .all() as Array<Record<string, string | number | null>>;
  const selfClearing = selfClearingRe();
  return blocked
    .filter((b) => !selfClearing.test(String(b.blocked_kind ?? "")))
    .map((b) => {
      const id = Number(b.id);
      const project = String(b.project);
      return {
        id,
        code: displayCardCode(project, id, codeSeqOf(b.code_seq), codes),
        project,
        title: String(b.title),
        kind: b.blocked_kind === null ? null : String(b.blocked_kind),
        reason: String(b.blocked_reason ?? ""),
        blockedAt: b.blocked_at === null ? null : String(b.blocked_at),
        agentId: b.agent_id === null ? null : String(b.agent_id),
      };
    });
}

const HIDDEN_VIEW: KanbanView = { presence: "absent", available: false, counts: [], byProject: [], needsPerson: [], warning: null };

export function kanbanView(): Promise<KanbanView> {
  return cached("kanban", 10_000, async () => {
    const source = kanbanSource();
    if (source.presence === "absent") return HIDDEN_VIEW;
    const note = staleNote(source);
    // Counts need a readable summary; a database is only ever named by one.
    if (!source.summary) return { ...HIDDEN_VIEW, presence: source.presence, warning: note };
    const byProject = countsFromSummary(source.summary);
    if (!usableDb(source.dbPath)) {
      return { presence: source.presence, available: true, counts: columnCounts(byProject), byProject, needsPerson: [], warning: note };
    }
    try {
      return withKanbanDb(source.dbPath, (db) => {
        return {
          presence: source.presence,
          available: true,
          counts: columnCounts(byProject),
          byProject,
          needsPerson: readNeedsPerson(db, projectCodes()),
          warning: note,
        };
      });
    } catch (e) {
      // Kanban is still evolving; a schema change must not take the cockpit down.
      return { ...HIDDEN_VIEW, presence: source.presence, warning: t("kanban.readFailed", { error: String(e).slice(0, 160) }) };
    }
  });
}

export interface QueueRead {
  /** False when the database or the queue columns cannot be read. Callers hide the section and do not warn. */
  shown: boolean;
  tasks: QueueTask[];
}

const QUEUE_TASK_COLUMNS = ["id", "project", "title", "status", "role", "hold_reason", "cooldown_until", "agent_id", "blocked_kind"] as const;
const QUEUE_EVENT_COLUMNS = ["task_id", "at", "to_status"] as const;

function columnNames(db: DatabaseSync, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>;
  return new Set(rows.map((row) => String(row.name ?? "")));
}

function hasColumns(names: Set<string>, required: readonly string[]): boolean {
  return required.every((name) => names.has(name));
}

/** tasks.tags is a JSON array string; empty, NULL or malformed values mean "not flagged". */
export function hasUnresponsiveTag(raw: unknown): boolean {
  if (typeof raw !== "string" || !raw.trim()) return false;
  try { const tags: unknown = JSON.parse(raw); return Array.isArray(tags) && tags.includes("leader-unresponsive"); }
  catch { return false; }
}

/** One bounded read for the entire Leader tab; never opens Kanban for writing. */
export function readLeaderCards(dbPath: string | null = kanbanDeepDb(), configPath = CONFIG_PATH, now = Date.now()): { cards: LeaderCard[]; wakes24h: Record<string, number>; warning: string | null } {
  try {
    if (!usableDb(dbPath)) {
      // Kanban not installed: nothing to warn about, the board parts are simply hidden.
      const absent = kanbanSource().presence === "absent";
      return { cards: [], wakes24h: {}, warning: absent ? null : t("home.summary.kanbanUnreadable") };
    }
    return withKanbanDb(dbPath, (db) => {
      const cols = columnNames(db, "tasks");
      if (!hasColumns(cols, ["id", "project", "title", "status"])) throw new Error(t("kanban.missingCardColumns"));
      const expr = (name: string) => cols.has(name) ? `t.${name}` : "NULL";
      const events = columnNames(db, "events");
      const since = hasColumns(events, ["task_id", "at", "to_status"])
        ? `(SELECT MAX(e.at) FROM events e WHERE e.task_id = t.id AND e.to_status = t.status ${events.has("from_status") ? "AND (e.from_status IS NULL OR e.from_status != e.to_status)" : ""})`
        : "NULL";
      const links = columnNames(db, "links");
      const waiting = hasColumns(links, ["task_id", "parent_id"])
        ? "EXISTS (SELECT 1 FROM links l JOIN tasks p ON p.id = l.parent_id WHERE l.task_id = t.id AND p.status NOT IN ('done', 'archived'))"
        : "0";
      const rows = db.prepare(`
        SELECT t.id, t.project, t.title, t.status, ${codeSeqExpr(cols, "t.")} AS code_seq,
               ${expr("blocked_reason")} AS reason, ${expr("blocked_kind")} AS blocked_kind,
               COALESCE(${since}, CASE WHEN t.status = 'blocked' THEN ${expr("blocked_at")} END, ${expr("created_at")}) AS since,
               ${waiting} AS parents, ${expr("tags")} AS tags
        FROM tasks t WHERE t.status NOT IN ('done', 'archived')
      `).all() as Array<Record<string, unknown>>;
      // Older boards have no wake_acceptance_repeat events yet: every count is simply zero.
      const wakes = new Map<number, number>();
      const wakes24h: Record<string, number> = {};
      if (hasColumns(events, ["task_id", "at", "kind"])) {
        const since24h = new Date(now - 24 * 3600_000).toISOString();
        for (const e of db.prepare("SELECT e.task_id, e.at, t.project FROM events e JOIN tasks t ON t.id = e.task_id WHERE e.kind = 'wake_acceptance_repeat'").all() as Array<{ task_id: number; at: string; project: string }>) {
          wakes.set(Number(e.task_id), (wakes.get(Number(e.task_id)) ?? 0) + 1);
          const key = String(e.project).toLowerCase();
          if (e.at >= since24h) wakes24h[key] = (wakes24h[key] ?? 0) + 1;
        }
      }
      return {
        wakes24h,
        cards: rows.map((r) => ({
          id: Number(r.id), code: formatCardCode(String(r.project), Number(r.id), codeSeqOf(r.code_seq), configPath),
          project: String(r.project), title: String(r.title), status: String(r.status),
          since: typeof r.since === "string" ? r.since : null, reason: String(r.reason ?? ""),
          blockedKind: typeof r.blocked_kind === "string" ? r.blocked_kind : null,
          waitingParents: Boolean(r.parents) && (["waiting", "triage", "ready"].includes(String(r.status)) || (r.status === "blocked" && r.blocked_kind === "dependency")),
          unresponsive: hasUnresponsiveTag(r.tags), repeatWakes: wakes.get(Number(r.id)) ?? 0,
        })), warning: null,
      };
    });
  } catch (error) {
    return { cards: [], wakes24h: {}, warning: t("kanban.unreadableWithError", { error: String(error).slice(0, 120) }) };
  }
}

function laterIso(current: string | null, next: string): string {
  if (!current) return next;
  const a = Date.parse(current);
  const b = Date.parse(next);
  if (Number.isNaN(a)) return next;
  if (Number.isNaN(b)) return current;
  return b >= a ? next : current;
}

/** task id → parent ids. A missing or unreadable `links` table degrades to no parents; the reason is logged. */
function readParentLinks(db: DatabaseSync): Map<number, number[]> {
  const parents = new Map<number, number[]>();
  try {
    const linkTable = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'links'").get() as { name?: string } | undefined;
    if (linkTable?.name !== "links") return parents;
    const links = db.prepare("SELECT task_id, parent_id FROM links").all() as Array<{ task_id: number | null; parent_id: number | null }>;
    for (const link of links) {
      if (link.task_id === null || link.parent_id === null) continue;
      const list = parents.get(Number(link.task_id)) ?? [];
      list.push(Number(link.parent_id));
      parents.set(Number(link.task_id), list);
    }
  } catch (error) {
    // Parents only name who is blocking a waiter; the table still shows without them.
    console.error("[afc] kanban links read failed; not showing blocking parents", String(error).slice(0, 120));
  }
  return parents;
}

/**
 * Unfinished cards plus the time they entered their current status.
 * A missing database, a missing column, or any read error returns an empty hidden section.
 * `unattended_at` alone may be absent (older boards): those cards are treated as attended.
 * Parent links are optional; without them the table still shows and "held up by card X" is skipped.
 * `code_seq` may be absent on older databases: those cards display as `#<id>`.
 */
export function readWaitingTasks(dbPath: string | null = kanbanDeepDb(), configPath = CONFIG_PATH): QueueRead {
  const empty: QueueRead = { shown: false, tasks: [] };
  if (!usableDb(dbPath)) return empty;
  try {
    return withKanbanDb(dbPath, (db) => {
      const taskCols = columnNames(db, "tasks");
      const eventCols = columnNames(db, "events");
      if (!hasColumns(taskCols, QUEUE_TASK_COLUMNS) || !hasColumns(eventCols, QUEUE_EVENT_COLUMNS)) return empty;
      const unattended = taskCols.has("unattended_at") ? "unattended_at" : "NULL AS unattended_at";
      const tasks = db.prepare(`
        SELECT id, project, title, status, role, hold_reason, cooldown_until, agent_id, blocked_kind, ${unattended}, ${codeSeqExpr(taskCols)} AS code_seq
        FROM tasks
        WHERE status NOT IN ('done', 'archived')
      `).all() as Array<Record<string, string | number | null>>;
      const events = db.prepare(`
        SELECT task_id, to_status, at FROM events WHERE to_status IS NOT NULL AND at IS NOT NULL
      `).all() as Array<{ task_id: number | null; to_status: string | null; at: string | null }>;
      const since = new Map<string, string>();
      for (const event of events) {
        if (event.task_id === null || event.to_status === null || event.at === null) continue;
        const key = `${Number(event.task_id)}|${String(event.to_status)}`;
        since.set(key, laterIso(since.get(key) ?? null, String(event.at)));
      }
      const parents = readParentLinks(db);
      return {
        shown: true,
        tasks: tasks.map((row) => {
          const id = Number(row.id);
          const status = String(row.status ?? "");
          const project = String(row.project ?? "");
          return {
            id,
            code: formatCardCode(project, id, codeSeqOf(row.code_seq), configPath),
            project,
            title: String(row.title ?? ""),
            status,
            role: String(row.role ?? ""),
            holdReason: row.hold_reason === null || row.hold_reason === undefined ? null : String(row.hold_reason),
            cooldownUntil: row.cooldown_until === null || row.cooldown_until === undefined ? null : String(row.cooldown_until),
            agentId: row.agent_id === null || row.agent_id === undefined || row.agent_id === "" ? null : String(row.agent_id),
            blockedKind: row.blocked_kind === null || row.blocked_kind === undefined ? null : String(row.blocked_kind),
            unattendedAt: row.unattended_at === null || row.unattended_at === undefined ? null : String(row.unattended_at),
            statusSince: since.get(`${id}|${status}`) ?? null,
            parentIds: parents.get(id) ?? [],
          };
        }),
      };
    });
  } catch (error) {
    logReadFailure("readWaitingTasks", error);
    return empty;
  }
}

export interface DispatchRunRow {
  id: string;
  profile: string;
  effort: string | null;
  startedAt: string;
  endedAt: string | null;
  agentId: string | null;
}

/**
 * Runs since `sinceIso`, including effort when that column exists.
 * Older databases have no effort column: those rows come back with effort null.
 */
export function readDispatchRuns(sinceIso: string, dbPath: string | null = kanbanDeepDb()): DispatchRunRow[] {
  if (!usableDb(dbPath)) return [];
  try {
    return withKanbanDb(dbPath, (db) => {
      const cols = columnNames(db, "runs");
      if (!cols.has("profile_name") || !cols.has("started_at")) return [];
      const id = cols.has("id") ? "id" : "rowid AS id";
      const effort = cols.has("effort") ? "effort" : "NULL AS effort";
      const ended = cols.has("ended_at") ? "ended_at" : "NULL AS ended_at";
      const agent = cols.has("agent_id") ? "agent_id" : "NULL AS agent_id";
      const rows = db.prepare(`
        SELECT ${id} AS id, profile_name AS profile, ${effort} AS effort, started_at AS startedAt, ${ended} AS endedAt, ${agent} AS agentId
        FROM runs WHERE started_at >= ?
      `).all(sinceIso) as Array<Record<string, unknown>>;
      const out: DispatchRunRow[] = [];
      for (const row of rows) {
        if (!row.profile || !row.startedAt) continue;
        out.push({
          id: String(row.id ?? out.length),
          profile: String(row.profile),
          effort: row.effort === null || row.effort === undefined || row.effort === "" ? null : String(row.effort),
          startedAt: String(row.startedAt),
          endedAt: row.endedAt === null || row.endedAt === undefined ? null : String(row.endedAt),
          agentId: row.agentId === null || row.agentId === undefined || row.agentId === "" ? null : String(row.agentId),
        });
      }
      return out;
    });
  } catch (error) {
    logReadFailure("readDispatchRuns", error);
    return [];
  }
}

/** Runs started at or after `sinceIso`, for the daily "cost per run" estimate. Empty when the table cannot be read. */
export function readRunsSince(sinceIso: string, dbPath: string | null = kanbanDeepDb()): Array<{ profile: string; at: string }> {
  if (!usableDb(dbPath)) return [];
  try {
    return withKanbanDb(dbPath, (db) => {
      const rows = db.prepare("SELECT profile_name AS profile, started_at AS at FROM runs WHERE started_at >= ?").all(sinceIso) as Array<{ profile?: string | null; at?: string | null }>;
      const out: Array<{ profile: string; at: string }> = [];
      for (const row of rows) {
        if (row.profile && row.at) out.push({ profile: String(row.profile), at: String(row.at) });
      }
      return out;
    });
  } catch (error) {
    logReadFailure("readRunsSince", error);
    return [];
  }
}

/** Runs started since `sinceIso` with their card id, for per-profile 7-day counts. Read-only; failures give []. */
export function readProfileRunsSince(sinceIso: string, dbPath: string | null = kanbanDeepDb()): Array<{ profile: string; at: string; taskId: number | null }> {
  if (!usableDb(dbPath)) return [];
  try {
    return withKanbanDb(dbPath, (db) => {
      const rows = db.prepare("SELECT profile_name AS profile, started_at AS at, task_id AS taskId FROM runs WHERE started_at >= ?").all(sinceIso) as Array<{ profile?: string | null; at?: string | null; taskId?: number | null }>;
      return rows.flatMap((row) => (row.profile && row.at ? [{ profile: String(row.profile), at: String(row.at), taskId: typeof row.taskId === "number" ? row.taskId : null }] : []));
    });
  } catch (error) {
    logReadFailure("readProfileRunsSince", error);
    return [];
  }
}

export interface RoleWorkRow {
  role: string;
  count: number;
  recent: Array<{ project: string; title: string; at: string; code: string }>;
}

/**
 * Cards a role actually ran in the window, newest first.
 * Read-only. A missing table or a bad file returns an empty list.
 */
export function readRoleWork(sinceIso: string, dbPath: string | null = kanbanDeepDb(), configPath = CONFIG_PATH): RoleWorkRow[] {
  if (!usableDb(dbPath)) return [];
  try {
    return withKanbanDb(dbPath, (db) => {
      const taskCols = columnNames(db, "tasks");
      const runCols = columnNames(db, "runs");
      if (!hasColumns(taskCols, ["id", "project", "title", "role"]) || !hasColumns(runCols, ["task_id", "role", "started_at"])) return [];
      const rows = db.prepare(`
        SELECT t.id AS id, t.project AS project, t.title AS title, ${codeSeqExpr(taskCols, "t.")} AS code_seq,
               CASE WHEN r.role IS NOT NULL AND r.role != '' THEN r.role ELSE t.role END AS role,
               r.started_at AS at
        FROM runs r
        JOIN tasks t ON t.id = r.task_id
        WHERE r.started_at >= ?
        ORDER BY r.started_at DESC
      `).all(sinceIso) as Array<Record<string, unknown>>;
      const groups = new Map<string, Map<number, { project: string; title: string; at: string; code: string }>>();
      for (const row of rows) {
        const role = String(row.role ?? "").trim();
        const id = Number(row.id);
        const at = String(row.at ?? "");
        if (!role || !Number.isFinite(id) || !at) continue;
        const project = String(row.project ?? "");
        const tasks = groups.get(role) ?? new Map();
        const prev = tasks.get(id);
        if (!prev || at > prev.at) {
          tasks.set(id, {
            project,
            title: String(row.title ?? ""),
            at,
            code: formatCardCode(project, id, codeSeqOf(row.code_seq), configPath),
          });
        }
        groups.set(role, tasks);
      }
      return [...groups.entries()].map(([role, tasks]) => {
        const recent = [...tasks.values()].sort((a, b) => b.at.localeCompare(a.at));
        return { role, count: recent.length, recent: recent.slice(0, 3) };
      });
    });
  } catch (error) {
    logReadFailure("readRoleWork", error);
    return [];
  }
}

export type KanbanAgentRead = { ok: true; ids: Set<string> } | { ok: false; error: string };

/**
 * Agent ids that appear on a card whose status is not done or archived.
 * null-shaped failure (`ok: false`) means the database could not be read:
 * callers must archive nothing this round.
 */
export function readUnfinishedAgentIds(dbPath: string | null = kanbanDeepDb()): KanbanAgentRead {
  if (!usableDb(dbPath)) return { ok: false, error: t("kanban.dbUnopenable") };
  try {
    return withKanbanDb(dbPath, (db) => {
      const rows = db.prepare(`
        SELECT agent_id AS id FROM tasks
          WHERE status NOT IN ('done', 'archived') AND agent_id IS NOT NULL AND agent_id != ''
        UNION
        SELECT executor_agent_id AS id FROM tasks
          WHERE status NOT IN ('done', 'archived') AND executor_agent_id IS NOT NULL AND executor_agent_id != ''
        UNION
        SELECT r.agent_id AS id FROM runs r
          JOIN tasks t ON t.id = r.task_id
          WHERE t.status NOT IN ('done', 'archived') AND r.agent_id IS NOT NULL AND r.agent_id != ''
      `).all() as Array<{ id: string | null }>;
      const ids = new Set<string>();
      for (const row of rows) if (row.id) ids.add(String(row.id));
      return { ok: true, ids };
    });
  } catch (e) {
    return { ok: false, error: t("kanban.dbReadFailed", { error: String(e).slice(0, 160) }) };
  }
}
