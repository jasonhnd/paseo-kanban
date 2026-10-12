/// <reference types="node" />
import { lstatSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "./paths";

/** How many `kanban.db.bak-*` snapshots stay in data/ after a new one is written. */
export const KEEP_BACKUPS = 2;

const BACKUP_PREFIX = "kanban.db.bak-";
const SIDECARS = ["-wal", "-shm", "-journal"];

export interface BackupFile {
  path: string;
  name: string;
  size: number;
  mtimeMs: number;
}

function isSidecar(name: string): boolean {
  return SIDECARS.some((suffix) => name.endsWith(suffix));
}

/** Board database snapshots in data/, newest first (mtime, then name). Other files are never listed. */
export function listKanbanBackups(dir: string = dataDir()): BackupFile[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const files: BackupFile[] = [];
  for (const name of names) {
    if (!name.startsWith(BACKUP_PREFIX) || isSidecar(name)) continue;
    const path = join(dir, name);
    try {
      const stat = lstatSync(path);
      if (stat.isFile()) files.push({ path, name, size: stat.size, mtimeMs: stat.mtimeMs });
    } catch {
      // Vanished between readdir and lstat; nothing to keep or delete.
    }
  }
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.name < b.name ? 1 : -1));
}

/**
 * Snapshots that fall outside the newest `keep`. `protectPath` always counts as kept
 * (the one just written), so a clock skew can never delete it.
 */
export function planBackupPrune(keep: number = KEEP_BACKUPS, protectPath?: string, dir: string = dataDir()): BackupFile[] {
  const all = listKanbanBackups(dir);
  const kept = new Set<string>();
  if (protectPath) kept.add(protectPath);
  for (const file of all) {
    if (kept.size >= keep) break;
    kept.add(file.path);
  }
  return all.filter((file) => !kept.has(file.path));
}

/** Delete the snapshots outside the newest `keep`. A failed delete is reported, never thrown. */
export function pruneKanbanBackups(
  keep: number = KEEP_BACKUPS,
  protectPath?: string,
  dir: string = dataDir(),
): { removed: BackupFile[]; failed: Array<{ file: BackupFile; error: string }> } {
  const removed: BackupFile[] = [];
  const failed: Array<{ file: BackupFile; error: string }> = [];
  for (const file of planBackupPrune(keep, protectPath, dir)) {
    try {
      unlinkSync(file.path);
      for (const suffix of SIDECARS) {
        try {
          unlinkSync(file.path + suffix);
        } catch {
          // No sidecar for this snapshot.
        }
      }
      removed.push(file);
    } catch (err) {
      failed.push({ file, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { removed, failed };
}

/** Backups a coming `--apply` would delete once its own new snapshot exists (the newest KEEP-1 old ones stay). */
export function planBackupPruneAfterNewBackup(dir: string = dataDir()): BackupFile[] {
  return listKanbanBackups(dir).slice(KEEP_BACKUPS - 1);
}
