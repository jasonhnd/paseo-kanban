/// <reference types="node" />
/**
 * The migration check for the observation period after `paseo-kanban migrate` (server/migrate.ts):
 * the MIGRATION.json record, the check itself (the board only grew, the old directory is as the
 * migration left it), and doctor's findings for it. Rollback and finish run the same check.
 * Kept apart from migrate.ts so doctor does not load the migration commands.
 */
import { createHash } from "node:crypto";
import { closeSync, lstatSync, openSync, readFileSync, readSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { DoctorFinding, DoctorSeverity } from "./doctor";
import { KanbanError } from "./errors";

export const MIGRATION_FILE = "MIGRATION.json";
export const MIGRATION_SCHEMA = "paseo-kanban/migration/v1";
export const DB_FILE = "kanban.db";
/** The database's content: raw-copied together so the copy holds every committed write. */
export const DB_CONTENT_FILES = [DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-journal`];
/** Everything SQLite keeps for kanban.db. -shm is only an index SQLite rebuilds from the WAL. */
export const DB_FILES = [...DB_CONTENT_FILES, `${DB_FILE}-shm`];
export const STAMP_PATTERN = /^\d{8}T\d{6}Z$/;
const HASH_CHUNK = 1 << 20;
/** The tables the observation check follows. */
const OBSERVED_TABLES = ["tasks", "events"];

export interface FileStamp {
  size: number;
  mtimeMs: number;
  sha256: string;
}

export interface TableRows {
  count: number;
  /** MAX(id), 0 for an empty table; null when the table has no id column. */
  maxId: number | null;
}

export interface ManifestEntry {
  /** Relative to the old directory, "/"-separated. */
  path: string;
  kind: "file" | "symlink";
  size: number;
  mode: number;
  mtimeMs: number;
  /** Of the old file; the backup and the installed copy were checked against it. Null for a symlink. */
  sha256: string | null;
  linkTarget?: string;
  known: boolean;
}

export type MigrationState = "active" | "rolled-back" | "finished";

export interface MigrationRecord {
  schema: typeof MIGRATION_SCHEMA;
  timestamp: string;
  migratedAt: string;
  source: string;
  target: string;
  /** Relative to the target. */
  backup: string;
  state: MigrationState;
  database: {
    file: typeof DB_FILE;
    /** kanban.db and, when present, its -wal/-journal in the old directory as the migration left them. */
    source: Record<string, FileStamp>;
    /** Every kanban.db* file present in the old directory, -shm included. */
    present: string[];
    snapshotSha256: string;
    integrity: "ok";
  };
  rows: Record<string, TableRows>;
  files: ManifestEntry[];
  unknownFiles: string[];
  skipped: Array<{ path: string; reason: string }>;
  /** Top-level entries of the target before the migration. Rollback leaves them where they are. */
  targetBefore: string[];
  rolledBackAt?: string;
  rollbackExport?: string;
  rollbackDir?: string;
  finishedAt?: string;
  legacyArchive?: string;
  removedFromSource?: string[];
  leftInSource?: string[];
}

export type ObservationKind = "new-board" | "old-board" | "old-files";

export interface ObservationProblem {
  kind: ObservationKind;
  severity: "red" | "yellow";
  detail: string;
}

// ---------------------------------------------------------------------------------------------
// Files and rows

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function sha256File(path: string): string {
  const hash = createHash("sha256");
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(HASH_CHUNK);
    for (;;) {
      const read = readSync(fd, buffer, 0, HASH_CHUNK, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

/** Size, mtime and (with `hash`) sha256 of a file or symlink; null when it is not there. */
export function stampOf(path: string, hash = true): FileStamp | null {
  try {
    const stat = lstatSync(path);
    return { size: stat.size, mtimeMs: stat.mtimeMs, sha256: hash ? sha256File(path) : "" };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

function sameStamp(a: FileStamp, b: FileStamp, hash: boolean): boolean {
  return a.size === b.size && a.mtimeMs === b.mtimeMs && (!hash || a.sha256 === b.sha256);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** Row count and MAX(id) of every table, or of the `only` tables that exist. */
export function tableRows(db: DatabaseSync, only?: readonly string[]): Record<string, TableRows> {
  const all = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>;
  const rows: Record<string, TableRows> = {};
  for (const { name } of all.filter(table => !only || only.includes(table.name))) {
    const table = quoteIdent(name);
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    const hasId = columns.some(column => column.name === "id");
    const row = db.prepare(`SELECT COUNT(*) AS n${hasId ? ", MAX(id) AS m" : ""} FROM ${table}`).get() as { n: number; m?: number | null };
    rows[name] = { count: Number(row.n), maxId: hasId ? Number(row.m ?? 0) : null };
  }
  return rows;
}

export function readRows(file: string, only?: readonly string[]): Record<string, TableRows> {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return tableRows(db, only);
  } finally {
    db.close();
  }
}

/** Changes to the old database since `recorded`. A zero-byte -wal or -journal that appeared only means something opened it. */
export function sourceDbChanges(dir: string, recorded: Record<string, FileStamp>, hash: boolean): string[] {
  const changes: string[] = [];
  for (const name of DB_CONTENT_FILES) {
    const before = recorded[name];
    const now = stampOf(join(dir, name), hash);
    if (!before && now && now.size > 0) changes.push(`${name} appeared (${formatBytes(now.size)})`);
    else if (before && !now) changes.push(`${name} is gone`);
    else if (before && now && !sameStamp(before, now, hash)) changes.push(`${name} changed (size ${before.size} -> ${now.size}, mtime ${new Date(before.mtimeMs).toISOString()} -> ${new Date(now.mtimeMs).toISOString()})`);
  }
  return changes;
}

// ---------------------------------------------------------------------------------------------
// Record and observation check

/** MIGRATION.json in `dir`, or null when there is none. A record that cannot be read is an error. */
export function readMigrationRecord(dir: string): MigrationRecord | null {
  const path = join(dir, MIGRATION_FILE);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const record = JSON.parse(text) as MigrationRecord;
  if (!record || record.schema !== MIGRATION_SCHEMA || !STAMP_PATTERN.test(record.timestamp ?? "") || !Array.isArray(record.files)) {
    throw new KanbanError("invalid", `${path} is not a migration record this version understands.`);
  }
  const unsafe = unsafeRecordPaths(record);
  if (unsafe.length > 0) throw new KanbanError("invalid", `${path} names paths outside the migrated directories: ${unsafe.join(", ")}`);
  return record;
}

/** A relative, "/"-separated path that stays inside its directory. */
function safeRelative(path: unknown): boolean {
  return typeof path === "string" && path !== "" && !isAbsolute(path) && !path.includes("\\")
    && path.split("/").every(part => part !== "" && part !== "." && part !== "..");
}

/** Paths finish deletes and rollback moves: every one must stay inside the old or the new directory. */
function unsafeRecordPaths(record: MigrationRecord): string[] {
  const unsafe: string[] = [];
  if (typeof record.source !== "string" || !isAbsolute(record.source)) unsafe.push(`source ${String(record.source)}`);
  for (const entry of record.files) if (!safeRelative(entry?.path)) unsafe.push(String(entry?.path));
  for (const name of record.database?.present ?? []) if (!DB_FILES.includes(name)) unsafe.push(name);
  for (const name of record.targetBefore ?? []) if (!safeRelative(name) || name.includes("/")) unsafe.push(name);
  return unsafe;
}

function newBoardProblems(record: MigrationRecord, db: DatabaseSync | null): ObservationProblem[] {
  const file = join(record.target, DB_FILE);
  let rows: Record<string, TableRows>;
  try {
    rows = db ? tableRows(db, OBSERVED_TABLES) : readRows(file, OBSERVED_TABLES);
  } catch (err) {
    return [{ kind: "new-board", severity: "red", detail: `cannot read ${file}: ${message(err)}` }];
  }
  const problems: ObservationProblem[] = [];
  for (const table of OBSERVED_TABLES) {
    const before = record.rows[table];
    const now = rows[table];
    if (!before) continue;
    if (!now) {
      problems.push({ kind: "new-board", severity: "red", detail: `table ${table} is missing` });
      continue;
    }
    if (before.maxId != null && (now.maxId ?? 0) < before.maxId) problems.push({ kind: "new-board", severity: "red", detail: `${table} MAX(id) went down: ${before.maxId} -> ${now.maxId ?? "none"}` });
    // Only growth passes. Rows deleted on purpose (compact-events included) still count as fewer rows.
    if (now.count < before.count) problems.push({ kind: "new-board", severity: "red", detail: `${table} went from ${before.count} to ${now.count} rows` });
  }
  return problems;
}

/** The old directory against the record: its database files, then every other migrated file. */
export function oldDirProblems(record: MigrationRecord, hash: boolean): ObservationProblem[] {
  const problems: ObservationProblem[] = [];
  const db = sourceDbChanges(record.source, record.database.source, hash);
  if (db.length > 0) problems.push({ kind: "old-board", severity: "red", detail: `old database ${join(record.source, DB_FILE)}: ${db.join("; ")}` });
  const files: string[] = [];
  for (const entry of record.files) {
    const path = join(record.source, ...entry.path.split("/"));
    const now = stampOf(path, hash && entry.kind === "file");
    if (!now) files.push(`${entry.path} is gone`);
    else if (now.size !== entry.size || now.mtimeMs !== entry.mtimeMs || (hash && entry.sha256 && now.sha256 !== entry.sha256)) files.push(`${entry.path} changed`);
  }
  if (files.length > 0) problems.push({ kind: "old-files", severity: "yellow", detail: `old directory ${record.source}: ${files.join("; ")}` });
  return problems;
}

/**
 * The observation-period check: the new board only grew (tasks and events, rows and MAX(id)),
 * and the old directory is as the migration left it. `hash` also compares checksums; doctor
 * runs often and compares size and mtime only. `board` is an open connection to the new board,
 * "skip" when the caller already reports that the board cannot be read, or absent to open it here.
 */
export function checkObservation(record: MigrationRecord, options: { hash: boolean; board?: DatabaseSync | "skip" }): ObservationProblem[] {
  const board = options.board === "skip" ? [] : newBoardProblems(record, options.board ?? null);
  return [...board, ...oldDirProblems(record, options.hash)];
}

// ---------------------------------------------------------------------------------------------
// Doctor findings

/** Ids start with "migration:", so a red is dropped from alertedIds as soon as a later run no longer reports it. */
export const MIGRATION_FINDING_PREFIX = "migration:";

const SYMPTOM: Record<ObservationKind, string> = {
  "new-board": "The migrated board lost data since the migration",
  "old-board": "The old board database changed after the migration",
  "old-files": "Files in the old data directory changed after the migration",
};

const SUGGESTION: Record<ObservationKind, string> = {
  "new-board": "migrate --finish refuses while this holds. Find out which board the plugin is using (doctor shows the data directory) and compare it with the backup named in MIGRATION.json; compact-events during the observation period also counts as lost rows. If the migrated board is broken, roll back with paseo-kanban migrate --rollback <timestamp>.",
  "old-board": "Something still writes to the old directory, and those writes are not in the migrated board. Stop that process (lsof on the old kanban.db). migrate --rollback and --finish both refuse until the old directory matches the record again; a person has to decide what to keep.",
  "old-files": "Check what changed in the old directory. migrate --rollback and --finish both refuse while a migrated file there differs from the record.",
};

function finding(record: MigrationRecord, dir: string, kind: ObservationKind, problems: ObservationProblem[]): DoctorFinding {
  const severity: DoctorSeverity = problems.some(problem => problem.severity === "red") ? "red" : "yellow";
  const object = kind === "old-board" || kind === "old-files" ? record.source : join(dir, record.database.file);
  return {
    id: `${MIGRATION_FINDING_PREFIX}${kind}`,
    severity,
    check: "board",
    project: null,
    card: null,
    taskId: null,
    object,
    symptom: SYMPTOM[kind],
    evidence: `${problems.map(problem => problem.detail).join("; ")} (migration ${record.timestamp}, ${join(dir, MIGRATION_FILE)})`,
    suggestion: SUGGESTION[kind],
  };
}

function rowsLine(record: MigrationRecord): string {
  return OBSERVED_TABLES.map(name => `${name} ${record.rows[name]?.count ?? 0}`).join(", ");
}

/**
 * Doctor's check of the migration recorded in `dir` (the data directory in use). No MIGRATION.json,
 * or a migration already rolled back or finished: nothing is reported. `board` is the open board,
 * or "skip" when it could not be read (doctor reports that already). Compares size and mtime only;
 * finish compares checksums too.
 */
export function checkMigration(add: (finding: DoctorFinding) => void, dir: string, board: DatabaseSync | "skip", now: Date = new Date()): void {
  let record: MigrationRecord | null;
  try {
    record = readMigrationRecord(dir);
  } catch (err) {
    add({
      id: `${MIGRATION_FINDING_PREFIX}record`,
      severity: "yellow",
      check: "board",
      project: null,
      card: null,
      taskId: null,
      object: join(dir, MIGRATION_FILE),
      symptom: "The migration record cannot be read",
      evidence: message(err),
      suggestion: "Restore MIGRATION.json from the backup directory it names, or move it away if no migration is in progress.",
    });
    return;
  }
  if (!record || record.state !== "active") return;
  const problems = checkObservation({ ...record, target: dir }, { hash: false, board });
  const kinds = [...new Set(problems.map(problem => problem.kind))];
  for (const kind of kinds) add(finding(record, dir, kind, problems.filter(problem => problem.kind === kind)));
  if (kinds.length > 0) return;
  const days = Math.max(0, (now.getTime() - Date.parse(record.migratedAt)) / 86_400_000).toFixed(1);
  add({
    id: `${MIGRATION_FINDING_PREFIX}observing`,
    severity: "info",
    check: "board",
    project: null,
    card: null,
    taskId: null,
    object: join(dir, MIGRATION_FILE),
    symptom: `Migration ${record.timestamp} under observation (${days} days)`,
    evidence: `Board has not lost rows since the migration (then: ${rowsLine(record)}); old directory ${record.source} unchanged by size and mtime.`,
    suggestion: `Nothing to do. When the observation period is over: paseo-kanban migrate --finish ${record.timestamp} --to ${dir}`,
  });
}
