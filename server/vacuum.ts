/// <reference types="node" />
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { planBackupPruneAfterNewBackup } from "./backup-retention";
import { backupKanbanDbDetailed, openReadonlyDb } from "./db";
import { t } from "../shared/i18n";
import { KanbanError } from "./errors";
import { resolveCompactIdentity } from "./identity";
import { dataDir } from "./paths";

export interface DbHolder {
  pid: number;
  command: string;
}

/** Who has kanban.db (or its WAL/SHM) open right now, apart from this process. */
export type HolderLister = (files: string[]) => DbHolder[];

export interface VacuumResult {
  dryRun: boolean;
  sizeBefore: number;
  sizeAfter: number | null;
  /** Free pages as a share of the file, in percent. */
  freePercent: number;
  tables: Record<string, number>;
  backup: string | null;
  prunedBackups: string[];
  text: string;
}

/** Stop and start the plugin with these. Shown when something still holds the database. */
export const PLUGIN_STOP_HINT = "paseo plugin disable paseo-kanban";
export const PLUGIN_START_HINT = "paseo plugin enable paseo-kanban";

/** `lsof` is the only way to see another process's open handle on the file. No answer means refuse. */
export function lsofHolders(files: string[]): DbHolder[] {
  const present = files.filter((file) => existsSync(file));
  if (present.length === 0) return [];
  const out = spawnSync("lsof", ["-F", "pcf", "--", ...present], { encoding: "utf8", timeout: 15_000 });
  const fail = (error: string): never => { throw new KanbanError("conflict", t("vacuum.lsofMissing", { error })); };
  if (out.error) fail(out.error.message);
  // lsof uses exit 1 for a successful search with no matches. Diagnostics or
  // partial records make the inspection uncertain, even when its status is 0.
  if (out.status === 1 && out.stdout === "" && out.stderr === "") return [];
  if (out.status !== 0 || out.stderr !== "") fail(`lsof inspection failed (exit ${out.status ?? "signal"})`);
  const holders = new Map<number, string>();
  let pid: number | null = null;
  let command: string | null = null;
  let hasFile = false;
  for (const line of out.stdout.split("\n")) {
    if (line === "") continue;
    if (/^p[1-9]\d*$/.test(line) && Number.isSafeInteger(Number(line.slice(1))) && (pid === null || hasFile)) {
      pid = Number(line.slice(1));
      command = null;
      hasFile = false;
    } else if (line.startsWith("c") && pid !== null && command === null && line.length > 1) {
      command = line.slice(1);
    } else if (line.startsWith("f") && pid !== null && command !== null && line.length > 1) {
      // Select file markers explicitly: newer lsof versions no longer emit
      // them for -F pc. File descriptors need not be numeric.
      hasFile = true;
      holders.set(pid, command);
    } else fail("lsof returned malformed process records");
  }
  if (!hasFile || holders.size === 0) fail("lsof returned incomplete process records");
  holders.delete(process.pid);
  return [...holders.entries()].map(([id, command]) => ({ pid: id, command }));
}

function dbFiles(): string[] {
  const file = join(dataDir(), "kanban.db");
  return [file, `${file}-wal`, `${file}-shm`];
}

function totalSize(): number {
  return dbFiles().reduce((sum, file) => (existsSync(file) ? sum + statSync(file).size : sum), 0);
}

function assertNoHolders(list: HolderLister): void {
  const holders = list(dbFiles());
  if (holders.length === 0) return;
  const who = holders.map((holder) => `${holder.command}(pid ${holder.pid})`).join(t("common.listSep"));
  throw new KanbanError(
    "conflict",
    t("vacuum.held", { who, stopHint: PLUGIN_STOP_HINT, dbFile: join(dataDir(), "kanban.db"), startHint: PLUGIN_START_HINT }),
    { holders },
  );
}

function tableCounts(db: DatabaseSync): Record<string, number> {
  const names = (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>
  ).map((row) => row.name);
  const counts: Record<string, number> = {};
  for (const name of names) counts[name] = (db.prepare(`SELECT COUNT(*) AS n FROM "${name.replaceAll('"', '""')}"`).get() as { n: number }).n;
  return counts;
}

function quickCheck(db: DatabaseSync): string {
  const rows = db.prepare("PRAGMA quick_check").all() as unknown as Array<{ quick_check: string }>;
  return rows.map((row) => row.quick_check).join("; ");
}

function freePercent(db: DatabaseSync): number {
  const pages = (db.prepare("PRAGMA page_count").get() as { page_count: number }).page_count;
  const free = (db.prepare("PRAGMA freelist_count").get() as { freelist_count: number }).freelist_count;
  return pages === 0 ? 0 : Math.round((free / pages) * 1000) / 10;
}

function mb(bytes: number): string {
  return `${(bytes / 1_048_576).toFixed(1)}MB`;
}

function diffCounts(before: Record<string, number>, after: Record<string, number>): string[] {
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...names].filter((name) => before[name] !== after[name]).map((name) => `${name}: ${before[name]} -> ${after[name]}`);
}

/**
 * VACUUM kanban.db. Needs the plugin stopped: anything but this process holding the file means refuse.
 * Default is a dry-run (read-only: holders, sizes, free space, backups that would go).
 * `--apply` takes a backup, runs quick_check, VACUUM, checkpoint, quick_check and compares every table's row count.
 */
export function vacuumKanbanDb(options: { apply: boolean; env?: NodeJS.ProcessEnv; listHolders?: HolderLister }): VacuumResult {
  const env = options.env ?? process.env;
  const list = options.listHolders ?? lsofHolders;
  const readonly = openReadonlyDb();
  let tables: Record<string, number>;
  let free: number;
  try {
    const identity = resolveCompactIdentity(env, readonly);
    if (identity.role !== "supervisor") throw new KanbanError("forbidden", t("vacuum.leaderOnly"));
    tables = tableCounts(readonly);
    free = freePercent(readonly);
  } finally {
    readonly.close();
  }
  const sizeBefore = totalSize();
  if (!options.apply) {
    const stale = planBackupPruneAfterNewBackup().map((file) => file.path);
    let holderText: string;
    try {
      const holders = list(dbFiles());
      holderText = holders.length === 0
          ? t("vacuum.dry.noHolders")
          : t("vacuum.dry.holders", { holders: holders.map((h) => `${h.command} pid ${h.pid}`).join(t("common.listSep")), stopHint: PLUGIN_STOP_HINT });
    } catch (err) {
      holderText = err instanceof KanbanError ? err.message : String(err);
    }
    const backups = stale.length === 0 ? "" : t("vacuum.dry.backups", { count: stale.length, files: stale.join(t("common.listSep")) });
    const text = t("vacuum.dry.text", { size: mb(sizeBefore), free, holders: holderText, backups });
    return { dryRun: true, sizeBefore, sizeAfter: null, freePercent: free, tables, backup: null, prunedBackups: stale, text };
  }
  assertNoHolders(list);
  const { backup, pruned, pruneFailed } = backupKanbanDbDetailed();
  // The backup took a while; a plugin that started in the meantime must still be caught.
  assertNoHolders(list);
  const file = join(dataDir(), "kanban.db");
  const db = new DatabaseSync(file);
  let after: Record<string, number>;
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    const checkBefore = quickCheck(db);
    if (checkBefore !== "ok") throw new KanbanError("conflict", t("vacuum.checkBefore", { result: checkBefore, backup }));
    const before = tableCounts(db);
    db.exec("VACUUM");
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const checkAfter = quickCheck(db);
    if (checkAfter !== "ok") throw new KanbanError("conflict", t("vacuum.checkAfter", { result: checkAfter, backup }));
    after = tableCounts(db);
    const changed = diffCounts(before, after);
    if (changed.length > 0) {
      throw new KanbanError("conflict", t("vacuum.rowsChanged", { changes: changed.join(t("common.semicolon")), backup }));
    }
    tables = after;
  } finally {
    db.close();
  }
  const sizeAfter = totalSize();
  const prunedText = pruned.length === 0 ? "" : t("vacuum.pruned", { count: pruned.length });
  const failedText = pruneFailed.length === 0 ? "" : t("vacuum.pruneFailed", { count: pruneFailed.length, failures: pruneFailed.join(t("common.semicolon")) });
  const text = t("vacuum.done", { before: mb(sizeBefore), after: mb(sizeAfter), free, tables: Object.keys(tables).length, backup, pruned: prunedText, failed: failedText, startHint: PLUGIN_START_HINT });
  return { dryRun: false, sizeBefore, sizeAfter, freePercent: free, tables, backup, prunedBackups: pruned, text };
}
