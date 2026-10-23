/// <reference types="node" />
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { tightenDataDir, tightenFile } from "./data-perms";
import { KanbanError } from "./errors";
import { KEEP_BACKUPS, pruneKanbanBackups } from "./backup-retention";
import { assertTestDataPath, canMigrateDataDir, dataDir, requestedDataDir } from "./paths";
import { countIo } from "./perf-count";
import { syncProjectCodes } from "./project-codes";
import { t } from "../shared/i18n";
import { bindRunCostFunctions, RUN_COST_TRIGGERS } from "./run-cost";

let current: DatabaseSync | null = null;
let currentDir: string | null = null;
let currentHome: string | undefined = undefined;
let readOnly: DatabaseSync | null = null;
let readOnlyDir: string | null = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS run_cost_snapshots (
  run_id INTEGER PRIMARY KEY,
  start_json TEXT NOT NULL,
  record_json TEXT
);
CREATE TABLE IF NOT EXISTS run_budget_state (
  task_id INTEGER PRIMARY KEY,
  generation TEXT NOT NULL,
  state_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS run_budget_turns (
  task_id INTEGER NOT NULL,
  generation TEXT NOT NULL,
  source TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  at TEXT NOT NULL,
  turn_json TEXT NOT NULL,
  PRIMARY KEY(task_id, generation, source, turn_id)
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  title TEXT NOT NULL,
  brief TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL,
  profile_override TEXT,
  status TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  idempotency_key TEXT,
  max_retries INTEGER NOT NULL DEFAULT 2,
  max_runtime_sec INTEGER,
  workspace_path TEXT,
  contract_json TEXT,
  created_by TEXT,
  created_by_agent TEXT,
  agent_id TEXT,
  executor_agent_id TEXT,
  executor_profile TEXT,
  executor_family TEXT,
  review_round INTEGER NOT NULL DEFAULT 0,
  land_conflict_count INTEGER NOT NULL DEFAULT 0,
  handoff_json TEXT,
  blocked_kind TEXT,
  blocked_reason TEXT,
  blocked_from TEXT,
  blocked_at TEXT,
  scheduled_until TEXT,
  scheduled_wake_id TEXT,
  scheduled_wake_text TEXT,
  scheduled_claim_id TEXT,
  scheduled_claim_until TEXT,
  background_wait_json TEXT,
  nudge_count INTEGER NOT NULL DEFAULT 0,
  fail_count INTEGER NOT NULL DEFAULT 0,
  cooldown_until TEXT,
  hold_reason TEXT,
  workspace_kind TEXT NOT NULL DEFAULT 'dir',
  workspace_base TEXT,
  paseo_workspace_id TEXT,
  paseo_workspace_name TEXT,
  unattended_at TEXT,
  tags TEXT,
  effort TEXT,
  tier TEXT,
  review_of INTEGER,
  code_seq INTEGER,
  wait_decision TEXT,
  project_read_scope TEXT CHECK (project_read_scope IS NULL OR project_read_scope = 'project'),
  tmp_work_bytes INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS tasks_idempotency ON tasks(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE TABLE IF NOT EXISTS native_session_queue (
  agent_id TEXT PRIMARY KEY,
  task_id INTEGER NOT NULL,
  provider TEXT NOT NULL DEFAULT '',
  session_id TEXT NOT NULL DEFAULT '',
  cwd TEXT NOT NULL DEFAULT '',
  home TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'prepared',
  retirement TEXT,
  moves_json TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  retry_at INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS native_session_due ON native_session_queue(status, retry_at, agent_id);
CREATE INDEX IF NOT EXISTS native_session_handle ON native_session_queue(provider, session_id, status);
CREATE TABLE IF NOT EXISTS native_session_locks (
  resource TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  parent_id INTEGER NOT NULL,
  UNIQUE(task_id, parent_id)
);
CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  actor TEXT,
  data_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS events_task ON events(task_id);
CREATE INDEX IF NOT EXISTS events_task_kind ON events(task_id, kind, id);
CREATE INDEX IF NOT EXISTS events_kind ON events(kind, task_id);
CREATE INDEX IF NOT EXISTS events_task_to_status ON events(task_id, to_status, id);
CREATE INDEX IF NOT EXISTS events_cleanup_verify
  ON events(task_id, json_extract(data_json, '$.agentId'), id)
  WHERE kind = 'cleanup' AND json_extract(data_json, '$.action') = 'verify_agent';
CREATE INDEX IF NOT EXISTS events_cleanup_other
  ON events(task_id, id)
  WHERE kind = 'cleanup' AND IFNULL(json_extract(data_json, '$.action'), '') != 'verify_agent';
-- Failed archive_agent lines only: the due scan reads these instead of every cleanup row of every card.
CREATE INDEX IF NOT EXISTS events_cleanup_archive_failed
  ON events(task_id, id)
  WHERE kind = 'cleanup' AND json_extract(data_json, '$.action') = 'archive_agent' AND json_extract(data_json, '$.ok') = 0;
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  agent_id TEXT,
  role TEXT NOT NULL,
  profile_name TEXT,
  provider TEXT,
  model TEXT,
  family TEXT,
  auto_accept INTEGER NOT NULL DEFAULT 0,
  thinking_option_id TEXT,
  effort TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  end_kind TEXT
);
CREATE TABLE IF NOT EXISTS tokens (
  token TEXT PRIMARY KEY,
  task_id INTEGER,
  role TEXT NOT NULL,
  agent_id TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT
);
-- Call provenance is deliberately identity-only until Paseo supplies a trusted per-call broker.
CREATE TABLE IF NOT EXISTS write_audits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  operation TEXT NOT NULL,
  task_id INTEGER,
  role TEXT NOT NULL,
  source_json TEXT NOT NULL,
  outcome TEXT NOT NULL,
  error_code TEXT
);
CREATE INDEX IF NOT EXISTS write_audits_task ON write_audits(task_id, id);
CREATE TABLE IF NOT EXISTS start_claims (
  task_id INTEGER PRIMARY KEY,
  token TEXT NOT NULL,
  pid INTEGER NOT NULL,
  at TEXT NOT NULL
);
-- Per-card lookups on runs, comments and links were full table scans, repeated for every card of every board read and tick.
CREATE INDEX IF NOT EXISTS runs_task ON runs(task_id, id);
CREATE INDEX IF NOT EXISTS runs_agent ON runs(agent_id, task_id);
CREATE INDEX IF NOT EXISTS comments_task ON comments(task_id);
CREATE INDEX IF NOT EXISTS links_parent ON links(parent_id);
CREATE INDEX IF NOT EXISTS tasks_status ON tasks(status);
-- "newest action by this leader" scanned every event of the project on each board read.
CREATE INDEX IF NOT EXISTS events_actor ON events(actor, task_id, at);
-- Acceptance watch asks for the newest supervisor/leader event: a backwards walk that stops at the first match.
CREATE INDEX IF NOT EXISTS events_actor_id ON events(actor, id);
-- Who changed a project's <leader> (project) or the Kanban <leader> (project NULL). Not tied to a card.
CREATE TABLE IF NOT EXISTS supervisor_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  project TEXT,
  actor TEXT,
  data_json TEXT NOT NULL DEFAULT '{}'
);
`;

/** Statements kept per connection. Board and tick code re-prepares the same few hundred SQL strings thousands of times per round. */
const STATEMENT_CACHE_LIMIT = 400;

/**
 * Count prepared statements and exec calls so a round summary can say how many queries it ran,
 * and reuse the compiled statement for a repeated SQL string. Preparing was the largest single
 * cost of a board read. A node:sqlite statement rebinds its parameters on every call, so sharing
 * one between callers is safe as long as nobody iterates two results of it at once; none does.
 */
function countSql(db: DatabaseSync): DatabaseSync {
  const prepare = db.prepare.bind(db);
  const exec = db.exec.bind(db);
  const cache = new Map<string, ReturnType<DatabaseSync["prepare"]>>();
  db.prepare = ((sql: string) => {
    countIo("sql");
    const hit = cache.get(sql);
    if (hit) return hit;
    const statement = prepare(sql);
    if (cache.size >= STATEMENT_CACHE_LIMIT) {
      const oldest = cache.keys().next();
      if (!oldest.done) cache.delete(oldest.value);
    }
    cache.set(sql, statement);
    return statement;
  }) as DatabaseSync["prepare"];
  db.exec = ((sql: string) => {
    countIo("sql");
    return exec(sql);
  }) as DatabaseSync["exec"];
  return db;
}

export function getDb(): DatabaseSync {
  const dir = requestedDataDir();
  const home = process.env.KANBAN_HOME;
  // The open handle was checked when it was opened, and keeps its file even if the directory is later
  // swapped for a symlink. Rechecking here resolved the path thousands of times per board read under
  // test (~80% of its wall time), a cost production never pays. Any other directory is checked first.
  if (current && currentDir === dir && currentHome === home) return current;
  assertTestDataPath(dir);
  if (current) {
    current.close();
    current = null;
  }
  const migrate = canMigrateDataDir(dir);
  if (!migrate) {
    // Validate through a read-only handle before any pragma, DDL or backfill can write.
    if (!existsSync(join(dir, "kanban.db"))) throw migrationRequired(t("db.migration.noDatabase"));
    const check = new DatabaseSync(join(dir, "kanban.db"), { readOnly: true });
    try { assertCurrentSchema(check); } finally { check.close(); }
  } else {
    mkdirSync(dir, { recursive: true });
  }
  const db = countSql(new DatabaseSync(join(dir, "kanban.db")));
  bindRunCostFunctions(db, dir);
  try {
    // WAL setup itself needs a lock, including when reopening an existing board.
    db.exec("PRAGMA busy_timeout = 5000");
    if (migrate) {
      enableWal(db);
      // Read schema/version and backfill sequence numbers under the same write lock.
      // Otherwise two first opens can both decide an ALTER/backfill is needed.
      db.exec("BEGIN IMMEDIATE");
      try {
        migrateDb(db);
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
      // Config has its own lock; do not hold the board lock while acquiring it.
      syncProjectCodes(db);
    }
    if (migrate) tightenDataDir(dir);
    current = db;
    currentDir = dir;
    currentHome = home;
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}

/** Journal-mode changes can return SQLITE_BUSY without invoking SQLite's busy handler. */
function enableWal(db: DatabaseSync): void {
  const deadline = performance.now() + 5000;
  const sleep = new Int32Array(new SharedArrayBuffer(4));
  try {
    for (;;) {
      // Each attempt shares the deadline, rather than restarting a five-second wait.
      db.exec(`PRAGMA busy_timeout = ${Math.max(1, Math.ceil(deadline - performance.now()))}`);
      try {
        db.exec("PRAGMA journal_mode = WAL");
        return;
      } catch (err) {
        const code = (err as { errcode?: number }).errcode;
        const remaining = deadline - performance.now();
        // Retry only BUSY (including extended BUSY codes), and keep a finite wait.
        if (typeof code !== "number" || (code & 0xff) !== 5 || remaining <= 0) throw err;
        Atomics.wait(sleep, 0, 0, Math.min(25, remaining));
        if (performance.now() >= deadline) throw err;
      }
    }
  } finally {
    db.exec("PRAGMA busy_timeout = 5000");
  }
}

function migrateDb(db: DatabaseSync): void {
  db.exec(SCHEMA);
  const columns = db.prepare("PRAGMA table_info(tasks)").all() as unknown as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "nudge_count")) {
    db.exec("ALTER TABLE tasks ADD COLUMN nudge_count INTEGER NOT NULL DEFAULT 0");
  }
  for (const statement of [
    "ALTER TABLE tasks ADD COLUMN created_by_agent TEXT",
    "ALTER TABLE tasks ADD COLUMN fail_count INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE tasks ADD COLUMN cooldown_until TEXT",
    "ALTER TABLE tasks ADD COLUMN scheduled_until TEXT",
    "ALTER TABLE tasks ADD COLUMN scheduled_wake_id TEXT",
    "ALTER TABLE tasks ADD COLUMN scheduled_wake_text TEXT",
    "ALTER TABLE tasks ADD COLUMN scheduled_claim_id TEXT",
    "ALTER TABLE tasks ADD COLUMN scheduled_claim_until TEXT",
    "ALTER TABLE tasks ADD COLUMN background_wait_json TEXT",
    "ALTER TABLE tasks ADD COLUMN hold_reason TEXT",
    "ALTER TABLE tasks ADD COLUMN workspace_kind TEXT NOT NULL DEFAULT 'dir'",
    "ALTER TABLE tasks ADD COLUMN workspace_base TEXT",
    "ALTER TABLE tasks ADD COLUMN paseo_workspace_id TEXT",
    "ALTER TABLE tasks ADD COLUMN paseo_workspace_name TEXT",
    "ALTER TABLE tasks ADD COLUMN unattended_at TEXT",
    "ALTER TABLE tasks ADD COLUMN tags TEXT",
    "ALTER TABLE tasks ADD COLUMN effort TEXT",
    "ALTER TABLE tasks ADD COLUMN tier TEXT",
    "ALTER TABLE tasks ADD COLUMN review_of INTEGER",
    "ALTER TABLE tasks ADD COLUMN land_conflict_count INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE tasks ADD COLUMN code_seq INTEGER",
    "ALTER TABLE tasks ADD COLUMN wait_decision TEXT",
    "ALTER TABLE tasks ADD COLUMN project_read_scope TEXT CHECK (project_read_scope IS NULL OR project_read_scope = 'project')",
    "ALTER TABLE tasks ADD COLUMN tmp_work_bytes INTEGER",
  ]) {
    const name = statement.split("COLUMN ")[1]?.split(" ")[0];
    if (name && !columns.some((column) => column.name === name)) db.exec(statement);
  }
  const nativeColumns = db.prepare("PRAGMA table_info(native_session_queue)").all() as unknown as Array<{ name: string }>;
  if (!nativeColumns.some(column => column.name === "last_error")) {
    db.exec("ALTER TABLE native_session_queue ADD COLUMN last_error TEXT");
    // Preserve the last logged reason when upgrading old pending retries.
    db.exec(`UPDATE native_session_queue SET last_error = (
      SELECT json_extract(data_json, '$.error') FROM events
      WHERE task_id = native_session_queue.task_id AND kind = 'native_session_archive_failed'
      AND json_extract(data_json, '$.agentId') = native_session_queue.agent_id ORDER BY id DESC LIMIT 1
    ) WHERE attempts > 0`);
  }
  // Known providers without a native store must not consume every worker batch.
  // Leave an empty provider pending: its agent metadata may become available later.
  // The reason is the same text native-sessions.ts writes when it skips such a provider.
  const noNativeReason = t("nativeSessions.skip.noNativeSession").replaceAll("'", "''");
  db.exec(`INSERT INTO events(task_id, at, kind, actor, data_json)
      SELECT task_id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'native_session_skipped', 'kanban',
        json_object('agentId', agent_id, 'provider', provider, 'sessionId', session_id,
          'cwd', cwd, 'reason', '${noNativeReason}', 'migration', 1)
      FROM native_session_queue WHERE status IN ('prepared','pending') AND provider NOT IN ('','claude','codex');
      UPDATE native_session_queue SET status = 'skipped', retry_at = 0, last_error = NULL
      WHERE status IN ('prepared','pending') AND provider NOT IN ('','claude','codex');`);
  const runColumns = db.prepare("PRAGMA table_info(runs)").all() as unknown as Array<{ name: string }>;
  if (!runColumns.some((column) => column.name === "thinking_option_id")) {
    db.exec("ALTER TABLE runs ADD COLUMN thinking_option_id TEXT");
  }
  if (!runColumns.some((column) => column.name === "effort")) {
    db.exec("ALTER TABLE runs ADD COLUMN effort TEXT");
  }
  const tokenColumns = db.prepare("PRAGMA table_info(tokens)").all() as unknown as Array<{ name: string }>;
  if (!tokenColumns.some((column) => column.name === "expires_at")) db.exec("ALTER TABLE tokens ADD COLUMN expires_at TEXT");
  revokeFinishedCardTokens(db);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS tasks_reopen_restores_worker_tokens
    AFTER UPDATE OF status ON tasks
    FOR EACH ROW
    WHEN OLD.status = 'done' AND NEW.status NOT IN ('done', 'archived')
    BEGIN
      UPDATE tokens SET expires_at = NULL
      WHERE task_id = NEW.id AND role != 'supervisor' AND expires_at IS NOT NULL
        AND (agent_id = NEW.executor_agent_id OR agent_id = NEW.agent_id);
    END;
  `);
  db.exec(RUN_COST_TRIGGERS);
  backfillCodeSeq(db);
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS tasks_project_code_seq ON tasks(project, code_seq)");
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS tasks_finished_clears_project_read
    AFTER UPDATE OF status ON tasks
    FOR EACH ROW
    WHEN NEW.status IN ('done', 'archived') AND NEW.project_read_scope IS NOT NULL
    BEGIN
      UPDATE tasks SET project_read_scope = NULL WHERE id = NEW.id;
    END;
    DROP TRIGGER IF EXISTS tasks_complete_clears_project_read;
    CREATE TRIGGER tasks_complete_clears_project_read
    AFTER INSERT ON events
    FOR EACH ROW
    WHEN NEW.kind IN ('complete', 'auto_complete')
    BEGIN
      UPDATE tasks SET project_read_scope = NULL WHERE id = NEW.task_id AND project_read_scope IS NOT NULL;
    END;
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS tasks_status_clears_unattended
    AFTER UPDATE OF status ON tasks
    FOR EACH ROW
    WHEN NEW.status <> OLD.status AND NEW.unattended_at IS NOT NULL
    BEGIN
      UPDATE tasks SET unattended_at = NULL WHERE id = NEW.id;
    END;
  `);
}

/** `PRAGMA user_version` once the legacy finished-card tokens have been cleared. */
const TOKEN_CLEANUP_VERSION = 1;

/**
 * Worker tokens on a finished card, or on a card that no longer exists, are dead weight: nothing a finished
 * card's agent does needs them. Archiving now revokes them; this clears the ones left from before.
 * It runs once (marked by user_version): afterwards a card entering done keeps its tokens for the grace
 * period, and `expires_at` alone ends them.
 */
function revokeFinishedCardTokens(db: DatabaseSync): void {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  if (row.user_version >= TOKEN_CLEANUP_VERSION) return;
  db.exec(`DELETE FROM tokens WHERE role != 'supervisor' AND task_id IS NOT NULL
      AND (task_id NOT IN (SELECT id FROM tasks) OR task_id IN (SELECT id FROM tasks WHERE status IN ('done', 'archived')))`);
  db.exec(`PRAGMA user_version = ${TOKEN_CLEANUP_VERSION}`);
}

function migrationRequired(detail: string): KanbanError {
  return new KanbanError("conflict", t("db.migration.required", { detail }));
}

/** Derive all required tables/columns from SCHEMA, including future additions. */
function assertCurrentSchema(db: DatabaseSync): void {
  const expected = new DatabaseSync(":memory:");
  try {
    expected.exec(SCHEMA);
    const tables = expected.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>;
    for (const { name } of tables) {
      const quoted = name.replaceAll('"', '""');
      const columns = db.prepare(`PRAGMA table_info("${quoted}")`).all() as Array<{ name: string }>;
      const required = expected.prepare(`PRAGMA table_info("${quoted}")`).all() as Array<{ name: string }>;
      const missing = required.filter(column => !columns.some(actual => actual.name === column.name));
      if (missing.length) throw migrationRequired(t("db.migration.missingColumns", { table: name, columns: missing.map(column => column.name).join(", ") }));
    }
  } finally { expected.close(); }
}

/** Number cards that have no sequence yet, oldest first, then by id. Existing numbers stay. */
function backfillCodeSeq(db: DatabaseSync): void {
  const pending = db
    .prepare("SELECT id, project FROM tasks WHERE code_seq IS NULL ORDER BY created_at ASC, id ASC")
    .all() as unknown as Array<{ id: number; project: string }>;
  if (pending.length === 0) return;
  const maxRows = db
    .prepare("SELECT project, MAX(code_seq) AS n FROM tasks WHERE code_seq IS NOT NULL GROUP BY project")
    .all() as unknown as Array<{ project: string; n: number }>;
  const next = new Map(maxRows.map((row) => [row.project, row.n]));
  const update = db.prepare("UPDATE tasks SET code_seq = ? WHERE id = ? AND code_seq IS NULL");
  for (const row of pending) {
    const seq = (next.get(row.project) ?? 0) + 1;
    next.set(row.project, seq);
    update.run(seq, row.id);
  }
}

/**
 * A second connection that cannot migrate, backfill, or write.
 * Doctor uses this so a cold or old database is only read.
 * Opening a missing file throws. It does not create the directory or the database.
 */
export function getReadOnlyDb(): DatabaseSync {
  const dir = dataDir();
  if (readOnly && readOnlyDir === dir) return readOnly;
  if (readOnly) {
    readOnly.close();
    readOnly = null;
  }
  const db = new DatabaseSync(join(dir, "kanban.db"), { readOnly: true });
  db.exec("PRAGMA query_only = ON");
  readOnly = db;
  readOnlyDir = dir;
  return db;
}

export function closeDb(): void {
  current?.close();
  current = null;
  currentDir = null;
  currentHome = undefined;
  readOnly?.close();
  readOnly = null;
  readOnlyDir = null;
}

/** Read the board without creating the directory, migrating, or writing tokens. */
export function openReadonlyDb(): DatabaseSync {
  const file = join(dataDir(), "kanban.db");
  if (!existsSync(file)) throw new KanbanError("not_found", t("db.noBoardDatabase"));
  const db = new DatabaseSync(file, { readOnly: true });
  db.exec("PRAGMA query_only = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}

function backupIsComplete(dest: string): void {
  const backup = new DatabaseSync(dest, { readOnly: true });
  try {
    const integrity = backup.prepare("PRAGMA integrity_check").all() as unknown as Array<{ integrity_check: string }>;
    const ok = integrity.length === 1 && integrity[0]?.integrity_check === "ok";
    if (!ok) throw new KanbanError("conflict", t("db.backup.integrityFailed"));
  } finally {
    backup.close();
  }
}

/**
 * Consistent snapshot before an apply migrates or deletes.
 * VACUUM INTO reads committed WAL pages, so a reader holding an older snapshot
 * cannot leave those commits out of the backup. The snapshot passes integrity_check
 * before deletion; its IDs define the deletion set, so newer live commits need not match.
 */
export function backupKanbanDb(): string {
  return backupKanbanDbDetailed().backup;
}

/**
 * Same snapshot, then keeps only the newest KEEP_BACKUPS `kanban.db.bak-*` files in data/
 * (the new one always counts). Other files, such as the codex state backups, are not touched.
 * A snapshot that cannot be deleted is reported in `pruneFailed` and does not fail the backup.
 */
export function backupKanbanDbDetailed(): { backup: string; pruned: string[]; pruneFailed: string[] } {
  const file = join(dataDir(), "kanban.db");
  if (!existsSync(file)) throw new KanbanError("not_found", t("db.noBoardDatabase"));
  const stamp = `${new Date().toISOString().replace(/[:.]/g, "")}-${randomBytes(4).toString("hex")}`;
  const dest = join(dataDir(), `kanban.db.bak-${stamp}`);
  const live = new DatabaseSync(file);
  try {
    live.exec("PRAGMA busy_timeout = 5000");
    live.exec(`VACUUM INTO '${dest.replaceAll("'", "''")}'`);
  } catch (err) {
    if (existsSync(dest)) unlinkSync(dest);
    const detail = err instanceof Error ? err.message : String(err);
    throw new KanbanError("conflict", t("db.backup.failed", { detail }));
  } finally {
    live.close();
  }
  tightenFile(dest);
  try {
    backupIsComplete(dest);
  } catch (err) {
    if (existsSync(dest)) unlinkSync(dest);
    throw err;
  }
  const { removed, failed } = pruneKanbanBackups(KEEP_BACKUPS, dest);
  return { backup: dest, pruned: removed.map((item) => item.path), pruneFailed: failed.map((item) => `${item.file.path}: ${item.error}`) };
}
