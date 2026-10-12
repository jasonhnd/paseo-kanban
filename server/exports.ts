/// <reference types="node" />
// The board's side of the fleet-quota/v1 contract: `exports/kanban.json` (is the board installed,
// where is its data and command line) and `exports/board-summary.json` (projects and the cards the
// cockpit looks at). Both are written atomically into this plugin's exports directory. Only the
// plugin server writes them; the command line never does.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { envelopeFor, writeExport, type BoardCard, type BoardProject, type BoardSummary, type KanbanInfo } from "./contract";
import { cardMarkOf } from "./card-ref";
import { loadConfigForReport, type KanbanConfig } from "./config";
import { getReadOnlyDb } from "./db";
import { dataDir, kanbanCliPath, pluginRoot } from "./paths";
import { displayProjectCode } from "./project-codes";
import { readProfiles } from "./profiles";

/** kanban.json is rewritten this often (and at start). */
export const INFO_INTERVAL_MS = 10 * 60_000;
/** board-summary.json is rewritten this often even without a change (and at start). */
export const SUMMARY_INTERVAL_MS = 5 * 60_000;
/** A change is written once the board has been quiet this long. */
export const SUMMARY_DEBOUNCE_MS = 5_000;
/** Finished cards stay in the summary this long. */
export const FINISHED_WINDOW_MS = 24 * 60 * 60_000;
/** What the cockpit may rely on in this release. */
export const KANBAN_FEATURES = ["board-summary"];

const FINISHED = new Set(["done", "archived"]);

/** package.json version of the installation, or 0.0.0 when it cannot be read. */
export function producerVersion(root = pluginRoot()): string {
  try {
    const version = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: unknown }).version;
    return typeof version === "string" && version.trim() ? version.trim() : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export function buildKanbanInfo(now = new Date()): KanbanInfo {
  return {
    ...envelopeFor("kanban", producerVersion(), now),
    producer: "paseo-kanban",
    dataDir: dataDir(),
    cli: kanbanCliPath(),
    features: [...KANBAN_FEATURES],
  };
}

function isoOrNull(value: string | null | undefined): string | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function summaryProjects(config: KanbanConfig): BoardProject[] {
  const names = [...new Set([...Object.keys(config.projects ?? {}), ...Object.keys(config.supervisors ?? {})])].sort();
  return names.map((name) => ({
    name,
    code: displayProjectCode(name, config) ?? "",
    leaderAgentId: config.supervisors[name] ?? null,
    root: null,
  }));
}

interface CardRow {
  id: number;
  project: string;
  code_seq: number | null;
  status: string;
  role: string;
  agent_id: string | null;
  updated_at: string;
  profile: string | null;
  started_at: string | null;
  done_at: string | null;
}

function summaryCards(config: KanbanConfig, now: Date): BoardCard[] {
  const since = new Date(now.getTime() - FINISHED_WINDOW_MS).toISOString();
  const rows = getReadOnlyDb().prepare(`
    SELECT t.id, t.project, t.code_seq, t.status, t.role, t.agent_id, t.updated_at,
      (SELECT r.profile_name FROM runs r WHERE r.task_id = t.id ORDER BY r.id DESC LIMIT 1) AS profile,
      (SELECT MIN(r.started_at) FROM runs r WHERE r.task_id = t.id) AS started_at,
      (SELECT e.at FROM events e WHERE e.task_id = t.id AND e.to_status = 'done' ORDER BY e.id DESC LIMIT 1) AS done_at
    FROM tasks t
    WHERE t.status NOT IN ('done', 'archived') OR t.updated_at >= ?
    ORDER BY t.id`).all(since) as unknown as CardRow[];
  const pools = profilePools();
  return rows.map((row) => ({
    code: cardMarkOf(row, config),
    project: row.project,
    status: row.status,
    role: row.role,
    agentId: row.agent_id,
    pool: row.profile ? pools.get(row.profile) ?? null : null,
    profile: row.profile,
    startedAt: isoOrNull(row.started_at),
    finishedAt: FINISHED.has(row.status) ? isoOrNull(row.done_at ?? row.updated_at) : null,
  }));
}

/** Profile name → pool. Without readable Paseo profiles the summary still goes out, with pools unknown. */
function profilePools(): Map<string, string | null> {
  try {
    return new Map(readProfiles().map((profile) => [profile.name, profile.pool ?? null]));
  } catch {
    return new Map();
  }
}

export function buildBoardSummary(now = new Date()): BoardSummary {
  const config = loadConfigForReport();
  return {
    ...envelopeFor("boardSummary", producerVersion(), now),
    producer: "paseo-kanban",
    projects: summaryProjects(config),
    cards: summaryCards(config, now),
    dbPath: join(dataDir(), "kanban.db"),
  };
}

/**
 * Written where the cockpit looks: `$KANBAN_DATA_DIR/exports`, else plugin-data. A board still on its
 * legacy data directory exports to plugin-data too, because the cockpit cannot know the legacy path;
 * plugin-data without a kanban.db does not change which directory the board uses.
 */
export async function writeKanbanInfo(now = new Date()): Promise<void> {
  await writeExport("kanban", buildKanbanInfo(now));
}

export async function writeBoardSummary(now = new Date()): Promise<void> {
  await writeExport("boardSummary", buildBoardSummary(now));
}

/** Newest event id: any card change adds an event, so a new id means the board changed. */
function latestEventId(): number {
  const row = getReadOnlyDb().prepare("SELECT MAX(id) AS id FROM events").get() as { id: number | null } | undefined;
  return row?.id ?? 0;
}

export interface ExportTimers {
  infoMs?: number;
  summaryMs?: number;
  debounceMs?: number;
  log?: (line: string) => void;
}

/**
 * Write both exports now, then keep them current: kanban.json every INFO_INTERVAL_MS,
 * board-summary.json every SUMMARY_INTERVAL_MS and SUMMARY_DEBOUNCE_MS after the board stops
 * changing. A failed write is logged and retried on the next round. Returns a stop function.
 */
export function startExports(options: ExportTimers = {}): () => void {
  const log = options.log ?? ((line: string) => console.error(`[paseo-kanban] ${line}`));
  const debounceMs = options.debounceMs ?? SUMMARY_DEBOUNCE_MS;
  const attempt = (name: string, write: () => Promise<void>) => {
    void write().catch((err) => log(`export ${name} failed: ${err instanceof Error ? err.message : String(err)}`));
  };
  const info = () => attempt("kanban.json", () => writeKanbanInfo());
  const summary = () => attempt("board-summary.json", () => writeBoardSummary());
  let seen = -1;
  let dirty = false;
  // Poll the newest event id at the debounce interval: a change marks the summary dirty, and the
  // first poll that sees no further change writes it. This also catches command-line changes.
  const watch = () => {
    let current: number;
    try {
      current = latestEventId();
    } catch (err) {
      log(`export watch failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (seen === -1) {
      seen = current;
      return;
    }
    if (current !== seen) {
      seen = current;
      dirty = true;
      return;
    }
    if (dirty) {
      dirty = false;
      summary();
    }
  };
  info();
  summary();
  // Record the newest event now, so a change right after start is not mistaken for the baseline.
  watch();
  const timers = [
    setInterval(info, options.infoMs ?? INFO_INTERVAL_MS),
    setInterval(summary, options.summaryMs ?? SUMMARY_INTERVAL_MS),
    setInterval(watch, debounceMs),
  ];
  for (const timer of timers) (timer as unknown as { unref?: () => void }).unref?.();
  return () => {
    for (const timer of timers) clearInterval(timer);
  };
}
