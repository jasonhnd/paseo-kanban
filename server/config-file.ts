/// <reference types="node" />
import { assertTestSafePath } from "./storage/test-safety";
import { DatabaseSync } from "node:sqlite";
import { closeSync, existsSync, fsyncSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "./perf-fs";
import { dirname, join } from "node:path";
import { t } from "../shared/i18n";
import { KanbanError } from "./errors";
import { assertTestDataPath, dataDir } from "./paths";

/**
 * kanban.config.json as a file: where it is, what state it is in, whether this data directory has had one,
 * and how it is replaced. Parsing into KanbanConfig stays in config.ts.
 */

export const CONFIG_FILE = "kanban.config.json";
/** The file as it was before the board's last write. Restoring is `cp kanban.config.json.prev kanban.config.json`. */
export const CONFIG_PREV_FILE = `${CONFIG_FILE}.prev`;

const FILE_MODE = 0o600;
const TRACES_LISTED = 3;

export function configPath(): string {
  const path = join(dataDir(), CONFIG_FILE);
  assertTestDataPath(path);
  return path;
}

/** The config file is broken, or missing on a board that has had one. Callers must not replace it. */
export class ConfigFileError extends KanbanError {
  constructor(message: string) {
    super("invalid", message);
  }
}

export type ConfigFileRead =
  | { state: "ok"; raw: Record<string, unknown> }
  | { state: "missing" }
  | { state: "broken"; detail: string };

function errorCode(err: unknown): string | null {
  if (!err || typeof err !== "object" || !("code" in err)) return null;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

export function oneLine(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.replace(/\s+/g, " ").trim();
}

/** Missing means ENOENT. Anything else that stops a JSON object coming out is broken. */
export function readConfigFile(path: string = configPath()): ConfigFileRead {
  assertTestSafePath(path);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if (errorCode(err) === "ENOENT") return { state: "missing" };
    return { state: "broken", detail: oneLine(err) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { state: "broken", detail: oneLine(err) };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { state: "broken", detail: t("configFile.broken.notObject") };
  return { state: "ok", raw: parsed as Record<string, unknown> };
}

/**
 * Files next to the config that only a board write or a person's copy leaves behind:
 * kanban.config.json.prev, kanban.config.json.bak-*, kanban.config.backup-*.json, a leftover temp file.
 */
export function configTraceFiles(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter((name) => name.startsWith("kanban.config.") && name !== CONFIG_FILE).sort();
}

function hasRows(db: DatabaseSync, table: string): boolean {
  try {
    const row = db.prepare(`SELECT EXISTS(SELECT 1 FROM ${table}) AS n`).get() as { n: number } | undefined;
    return Number(row?.n ?? 0) > 0;
  } catch (err) {
    // A database that was never migrated has no cards. Any other failure is not proof of a fresh board.
    if (/no such table/i.test(oneLine(err))) return false;
    throw err;
  }
}

function cardsIn(db: DatabaseSync): boolean {
  return hasRows(db, "tasks") || hasRows(db, "supervisor_events");
}

/** "yes" when kanban.db holds cards or leader changes, "unreadable" when it exists but cannot be checked. */
function databaseHistory(dir: string, db?: DatabaseSync): "yes" | "no" | "unreadable" {
  try {
    if (db) return cardsIn(db) ? "yes" : "no";
    const file = join(dir, "kanban.db");
    if (!existsSync(file)) return "no";
    const probe = new DatabaseSync(file, { readOnly: true });
    try {
      return cardsIn(probe) ? "yes" : "no";
    } finally {
      probe.close();
    }
  } catch {
    return "unreadable";
  }
}

/** Why a data directory has had a config. `lasting` is false when the only reason is a database that could not be read just now. */
export interface ConfigEvidence {
  text: string;
  lasting: boolean;
}

/**
 * Why this data directory has had a config, or null for a fresh installation (no trace file, no card).
 * `db` is the handle being migrated, when the caller has one; otherwise kanban.db is opened read-only.
 */
export function priorConfigEvidence(dir: string, db?: DatabaseSync): ConfigEvidence | null {
  const reasons: string[] = [];
  const traces = configTraceFiles(dir);
  if (traces.length > 0) {
    const shown = traces.slice(0, TRACES_LISTED).join(t("common.listSep"));
    reasons.push(traces.length > TRACES_LISTED ? t("configFile.evidence.traces", { shown, count: traces.length }) : shown);
  }
  const history = databaseHistory(dir, db);
  if (history === "yes") reasons.push(t("configFile.evidence.hasCards"));
  const lasting = reasons.length > 0;
  if (history === "unreadable") reasons.push(t("configFile.evidence.unreadable"));
  return reasons.length > 0 ? { text: reasons.join(t("common.semicolon")), lasting } : null;
}

/** Create `path` (it must not exist), write `body`, and flush it to disk before returning. */
function writeDurable(path: string, body: string | Buffer): void {
  const fd = openSync(path, "wx", FILE_MODE);
  try {
    writeFileSync(fd, body);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Make the renames durable. Best effort: not every platform can fsync a directory. */
function syncDirectory(dir: string): void {
  let fd: number | null = null;
  try {
    fd = openSync(dir, "r");
    fsyncSync(fd);
  } catch {
    // The renames already happened; only their durability across a power cut is weaker here.
  } finally {
    if (fd != null) closeSync(fd);
  }
}

function currentBytes(path: string): Buffer | null {
  try {
    return readFileSync(path);
  } catch (err) {
    if (errorCode(err) === "ENOENT") return null;
    throw err;
  }
}

let writeSeq = 0;

/**
 * Replace the config file. The new body goes to a temp file in the same directory and is fsynced; the file
 * being replaced is kept as kanban.config.json.prev the same way; then the temp file is renamed over the config
 * and the directory is fsynced. A crash leaves the old file or the new one, never half of either.
 * The caller holds the config lock and has already checked that the current file may be replaced.
 */
export function writeConfigAtomic(body: string): void {
  const path = configPath();
  const dir = dirname(path);
  const seq = ++writeSeq;
  const tmp = `${path}.${process.pid}.${seq}.tmp`;
  const prevTmp = `${path}.prev.${process.pid}.${seq}.tmp`;
  try {
    writeDurable(tmp, body);
    const current = currentBytes(path);
    if (current && !current.equals(Buffer.from(body))) {
      writeDurable(prevTmp, current);
      renameSync(prevTmp, join(dir, CONFIG_PREV_FILE));
    }
    renameSync(tmp, path);
    syncDirectory(dir);
  } catch (err) {
    for (const leftover of [tmp, prevTmp]) {
      try {
        unlinkSync(leftover);
      } catch {
        // Not created, or already renamed into place.
      }
    }
    throw err;
  }
}

function mtimeOf(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * supervisorAgentId from kanban.config.json.prev, else from the newest copy that parses.
 * Temp files and copies a person set aside as broken are skipped.
 * Only used to know whom to wake about a lost config. Nothing runs on these files.
 */
export function kanbanLeaderFromCopies(dir: string): string | null {
  const copies = configTraceFiles(dir)
    .filter((name) => !name.endsWith(".tmp") && !/broken/i.test(name))
    .map((name) => ({ name, path: join(dir, name) }))
    .sort((a, b) => Number(b.name === CONFIG_PREV_FILE) - Number(a.name === CONFIG_PREV_FILE) || mtimeOf(b.path) - mtimeOf(a.path));
  for (const copy of copies) {
    const read = readConfigFile(copy.path);
    if (read.state !== "ok") continue;
    const id = read.raw.supervisorAgentId;
    if (typeof id === "string" && id.trim()) return id.trim();
  }
  return null;
}
