/// <reference types="node" />
// How the cockpit finds Paseo Kanban: the fleet-quota/v1 files Kanban writes into its exports directory.
//
// - kanban.json says whether Kanban is installed. Missing or unreadable: Kanban is "absent", and the board
//   panels and the idle sweep switch off.
// - board-summary.json lists open cards and cards finished in the last day, and may name the board database.
//   Deep queries (runs, events, links) open only the database a readable summary names, read-only. There is no
//   guessing: a missing or invalid summary, or `dbPath: null`, means no deep queries, so anything that needs the
//   full board (the idle sweep's "still on a card" set) reads as unknown and does nothing.
// - A file older than three times its TTL makes the source "stale": data is still shown, with a note. A missing
//   or invalid summary also makes it stale (Kanban is installed but its board cannot be read).
//
// No command line and no daemon call: each read is two stats, plus a parse only when a file changed.
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import type { z } from "zod";
import {
  BoardSummary,
  classifyFreshness,
  type Env,
  type Envelope,
  envelopeAgeSeconds,
  exportPath,
  KanbanInfo,
  onceLogger,
  parseContract,
  type ReadResult,
} from "../contract";
import type { KanbanPresence } from "../../shared/fleet/kanban-presence";

export type { KanbanPresence };

export interface KanbanSource {
  presence: KanbanPresence;
  info: KanbanInfo | null;
  /** Null when Kanban is absent or its board summary cannot be read. */
  summary: BoardSummary | null;
  /** Board database for read-only deep queries; null when there is none to open. */
  dbPath: string | null;
  /** Age in seconds of the oldest stale contract file; null when no file is past its TTL. */
  staleSeconds: number | null;
}

export const ABSENT_SOURCE: KanbanSource = { presence: "absent", info: null, summary: null, dbPath: null, staleSeconds: null };

/** Line written to the sweep log and the server log when a round is skipped because Kanban is not installed. */
export const KANBAN_ABSENT = "kanban absent";

type Exists = (path: string) => boolean;

function valueOf<T>(result: ReadResult<T>): T | null {
  return result.state === "fresh" || result.state === "stale" ? result.value : null;
}

/** Pure: combine the two contract reads into one view of Kanban. The database comes only from a readable summary. */
export function resolveKanbanSource(
  info: ReadResult<KanbanInfo>,
  summary: ReadResult<BoardSummary>,
  exists: Exists = existsSync,
): KanbanSource {
  const infoValue = valueOf(info);
  if (!infoValue) return ABSENT_SOURCE;
  const summaryValue = valueOf(summary);
  const staleAges = [info, summary].flatMap((read) => (read.state === "stale" ? [read.ageSeconds] : []));
  const candidate = summaryValue?.dbPath ?? null;
  return {
    presence: staleAges.length > 0 || !summaryValue ? "stale" : "fresh",
    info: infoValue,
    summary: summaryValue,
    dbPath: candidate && exists(candidate) ? candidate : null,
    staleSeconds: staleAges.length > 0 ? Math.round(Math.max(...staleAges)) : null,
  };
}

type Parsed<T> = { kind: "value"; value: T } | { kind: "invalid"; reason: string };

interface FileMemo {
  mtimeMs: number;
  size: number;
  parsed: Parsed<unknown>;
}

const fileMemo = new Map<string, FileMemo>();
const logInvalid = onceLogger((message) => console.error(`[afc] ${message}`));

/**
 * Synchronous contract read with a per-file memo keyed on mtime and size, so polling costs one stat.
 * Freshness is recomputed against `now` on every call.
 */
function readContractSync<T extends Envelope>(file: string, schema: z.ZodType<Envelope>, now: Date): ReadResult<T> {
  let mtimeMs: number;
  let size: number;
  try {
    const stat = statSync(file);
    mtimeMs = stat.mtimeMs;
    size = stat.size;
  } catch {
    fileMemo.delete(file);
    return { state: "absent" };
  }
  let memo = fileMemo.get(file);
  if (!memo || memo.mtimeMs !== mtimeMs || memo.size !== size) {
    let parsed: Parsed<unknown>;
    try {
      const result = parseContract(readFileSync(file, "utf8"), schema, now);
      parsed = result.state === "invalid" ? { kind: "invalid", reason: result.reason } : result.state === "absent" ? { kind: "invalid", reason: "empty" } : { kind: "value", value: result.value };
    } catch (error) {
      parsed = { kind: "invalid", reason: `unreadable: ${String(error).slice(0, 120)}` };
    }
    memo = { mtimeMs, size, parsed };
    fileMemo.set(file, memo);
  }
  if (memo.parsed.kind === "invalid") {
    logInvalid(file, memo.parsed.reason);
    return { state: "invalid", reason: memo.parsed.reason };
  }
  const value = memo.parsed.value as T;
  return { state: classifyFreshness(value, now), value, ageSeconds: envelopeAgeSeconds(value, now) };
}

export interface KanbanSourceOptions {
  env?: Env;
  home?: string;
  now?: Date;
}

/** Current view of Kanban, read from its contract files. Cheap enough to call on every request. */
export function kanbanSource(options: KanbanSourceOptions = {}): KanbanSource {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const now = options.now ?? new Date();
  const info = readContractSync<KanbanInfo>(exportPath("kanban", env, home), KanbanInfo, now);
  if (info.state === "absent" || info.state === "invalid") return ABSENT_SOURCE;
  const summary = readContractSync<BoardSummary>(exportPath("boardSummary", env, home), BoardSummary, now);
  return resolveKanbanSource(info, summary);
}

/** The board database deep queries may open read-only, or null when Kanban is absent or published none. */
export function kanbanDeepDb(): string | null {
  return kanbanSource().dbPath;
}

/** Short English note for a stale source, shown in the panel; null when the source is fresh or absent. */
export function staleNote(source: KanbanSource): string | null {
  if (source.presence !== "stale") return null;
  if (!source.summary) return "Kanban board summary is unavailable";
  const minutes = source.staleSeconds === null ? null : Math.round(source.staleSeconds / 60);
  return minutes === null ? "Kanban data is stale" : `Kanban data is stale (last update ${minutes} min ago)`;
}

/** Tests write contract files in quick succession; this drops the memo so a rewrite within one mtime tick is seen. */
export function clearKanbanSourceMemo(): void {
  fileMemo.clear();
}
