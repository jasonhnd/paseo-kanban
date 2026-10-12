/// <reference types="node" />
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { t } from "../shared/i18n";
import { KanbanError } from "./errors";
import { dataDir } from "./paths";

/** How long a writer waits for another process to finish its config change before giving up. */
export const CONFIG_LOCK_WAIT_MS = 10_000;

let depth = 0;
let held: DatabaseSync | null = null;

function lockPath(): string {
  return join(dataDir(), "config.lock.db");
}

function acquire(): DatabaseSync {
  mkdirSync(dataDir(), { recursive: true });
  const db = new DatabaseSync(lockPath());
  try {
    db.exec(`PRAGMA busy_timeout = ${CONFIG_LOCK_WAIT_MS}`);
    db.exec("BEGIN IMMEDIATE");
    return db;
  } catch (err) {
    db.close();
    const message = err instanceof Error ? err.message : String(err);
    if (/locked|busy/i.test(message)) {
      throw new KanbanError("conflict", t("configLock.busy", { seconds: CONFIG_LOCK_WAIT_MS / 1000 }));
    }
    throw err;
  }
}

/**
 * Run a read-modify-write of kanban.config.json (or a check that must hold until the write) while no other
 * process can change the file. The lock is an exclusive SQLite write lock on config.lock.db: the OS drops it if
 * the holder dies, so a crash cannot leave a stale lock. Nested calls in one process share the outer lock.
 */
export function withConfigLock<T>(fn: () => T): T {
  if (depth > 0) {
    depth += 1;
    try {
      return fn();
    } finally {
      depth -= 1;
    }
  }
  held = acquire();
  depth = 1;
  try {
    return fn();
  } finally {
    depth = 0;
    const db = held;
    held = null;
    try {
      db?.exec("ROLLBACK");
    } finally {
      db?.close();
    }
  }
}
