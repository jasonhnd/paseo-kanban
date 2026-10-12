/// <reference types="node" />
// Fake legacy boards for the migrate tests. Every name and value here is made up.
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { closeDb, getDb } from "../../server/db";
import { sha256File } from "../../server/doctor-migration";
import { defaultPluginDataDir } from "../../server/paths";

export const DEMO_PROJECT = "ZZDEMO";

/** A fake installation: `<home>/plugin/data` is the legacy board, `<home>/paseo` is PASEO_HOME. */
export interface MigrateFixture {
  home: string;
  pluginRoot: string;
  legacy: string;
  target: string;
  env: NodeJS.ProcessEnv;
}

let seq = 0;

export function insertCards(db: DatabaseSync, from: number, count: number, eventsPerCard: number): void {
  const at = "2026-10-01T00:00:00.000Z";
  for (let id = from; id < from + count; id++) {
    db.prepare("INSERT INTO tasks(id, project, title, role, status, code_seq, created_at, updated_at) VALUES (?, ?, ?, 'executor', 'done', ?, ?, ?)")
      .run(id, DEMO_PROJECT, `Demo card ${id}`, id, at, at);
    for (let n = 0; n < eventsPerCard; n++) {
      db.prepare("INSERT INTO events(task_id, at, kind, actor) VALUES (?, ?, 'demo', 'tester')").run(id, at);
    }
  }
}

/**
 * The board's real schema with three cards (four events each) in the database file, and two more
 * cards (three events each) and a comment only in its WAL. `KANBAN_DATA_DIR` is restored afterwards.
 */
export function legacyBoard(root: string, dir: string): void {
  const previous = process.env.KANBAN_DATA_DIR;
  const build = join(root, `build-${++seq}`);
  process.env.KANBAN_DATA_DIR = build;
  try {
    insertCards(getDb(), 1, 3, 4);
    closeDb();
  } finally {
    process.env.KANBAN_DATA_DIR = previous;
  }
  const live = new DatabaseSync(join(build, "kanban.db"));
  try {
    live.exec("PRAGMA wal_autocheckpoint = 0");
    insertCards(live, 4, 2, 3);
    live.prepare("INSERT INTO comments(task_id, author, body, created_at) VALUES (5, 'tester', 'demo comment', '2026-10-01T00:00:00.000Z')").run();
    mkdirSync(dir, { recursive: true });
    for (const name of ["kanban.db", "kanban.db-wal", "kanban.db-shm"]) copyFileSync(join(build, name), join(dir, name));
  } finally {
    live.close();
  }
}

/** A legacy board with the files §3.1 lists, an unknown file, a symlink, and a target that already has exports/. */
export function migrateFixture(root: string, options: { targetFiles?: Record<string, string> } = {}): MigrateFixture {
  const home = join(root, `home-${++seq}`);
  const pluginRoot = join(home, "plugin");
  const legacy = join(pluginRoot, "data");
  const env: NodeJS.ProcessEnv = { PASEO_HOME: join(home, "paseo") };
  const target = defaultPluginDataDir(env, home);
  legacyBoard(root, legacy);
  writeFileSync(join(legacy, "kanban.config.json"), JSON.stringify({ projects: { [DEMO_PROJECT]: { code: "ZZD" } } }));
  writeFileSync(join(legacy, "supervisor.token"), "demo-token\n", { mode: 0o600 });
  writeFileSync(join(legacy, "mcp.port"), "40123");
  writeFileSync(join(legacy, "doctor-report.json"), "{}");
  copyFileSync(join(legacy, "kanban.db"), join(legacy, "kanban.db.bak-20261001T000000000Z-0000"));
  mkdirSync(join(legacy, "readonly-leftovers", "DEMO_0001"), { recursive: true });
  writeFileSync(join(legacy, "readonly-leftovers", "DEMO_0001", "note.txt"), "left over");
  writeFileSync(join(legacy, "notes-unknown.txt"), "a file the board does not know");
  symlinkSync("kanban.config.json", join(legacy, "config-link"));
  mkdirSync(join(target, "exports"), { recursive: true });
  writeFileSync(join(target, "exports", "kanban.json"), "{\"schema\":\"demo\"}");
  for (const [name, body] of Object.entries(options.targetFiles ?? {})) writeFileSync(join(target, name), body);
  return { home, pluginRoot, legacy, target, env };
}

/** Every entry under `dir` with what would show a change: size, mtime, checksum or link target. */
export function tree(dir: string): Record<string, string> {
  if (!existsSync(dir)) return {};
  const out: Record<string, string> = {};
  for (const name of readdirSync(dir, { recursive: true }).map(String).sort()) {
    const path = join(dir, name);
    const stat = lstatSync(path);
    if (stat.isDirectory()) out[name] = "dir";
    else if (stat.isSymbolicLink()) out[name] = `link:${readlinkSync(path)}`;
    else out[name] = `${stat.size}:${stat.mtimeMs}:${sha256File(path)}`;
  }
  return out;
}

export function countRows(file: string, table: string): number {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
  } finally {
    db.close();
  }
}
