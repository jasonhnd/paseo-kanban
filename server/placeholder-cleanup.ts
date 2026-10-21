/// <reference types="node" />
import type { DatabaseSync } from "node:sqlite";
import { isAbsolute, join, resolve } from "node:path";
import { lstatSync, readdirSync } from "./perf-fs";
import { t } from "../shared/i18n";
import { PLACEHOLDER_NAME, pathWithin } from "./missing-cwd";
import { samePath } from "./placement";
import { isUnderWorktrees } from "./worktree-gc";

/** Exact recorded paths, including discarded attempts. Never infer siblings from a slug. */
export function recordedPlaceholderPaths(db: DatabaseSync): Map<string, Set<number>> {
  const paths = new Map<string, Set<number>>();
  const rows = db.prepare(`SELECT task_id, kind, data_json FROM events WHERE kind IN
    ('worktree_created', 'temp_workspace', 'cwd_placeholder', 'worktree_directory_corrected', 'temp_workspace_recreated')`)
    .all() as Array<{ task_id: number; kind: string; data_json: string }>;
  for (const row of rows) {
    try {
      const data = JSON.parse(row.data_json);
      const values = row.kind === "cwd_placeholder" ? [data.path]
        : row.kind === "worktree_directory_corrected" ? [data.from]
        : row.kind === "temp_workspace_recreated" ? [data.oldDirectory, data.directory] : [data.directory];
      for (const value of values) {
        if (typeof value !== "string" || !isAbsolute(value)) continue;
        const path = resolve(value);
        const owners = paths.get(path) ?? new Set<number>();
        owners.add(row.task_id);
        paths.set(path, owners);
      }
    } catch {
      // Malformed events do not prove ownership.
    }
  }
  return paths;
}

/** Shared by cleanup and doctor: only a plain directory with one plain README qualifies. */
export function barePlaceholderError(directory: string): string | null {
  try {
    if (!lstatSync(directory).isDirectory()) return t("tempWorkspace.placeholder.notDirectory");
    const others = readdirSync(directory).filter(name => name !== PLACEHOLDER_NAME);
    if (others.length > 0) return t("tempWorkspace.placeholder.otherFiles", {
      files: others.slice(0, 5).join(t("common.listSep")), more: others.length > 5 ? t("tempWorkspace.placeholder.more") : "",
    });
    if (!lstatSync(join(directory, PLACEHOLDER_NAME)).isFile()) return t("tempWorkspace.placeholder.readmeNotFile");
    return null;
  } catch (err) {
    return t("tempWorkspace.placeholder.removeFailedWith", { error: err instanceof Error ? err.message : String(err) });
  }
}

/** The caller supplies a successful git worktree listing; a registered copy never qualifies. */
export function recordedPlaceholderError(input: {
  directory: string;
  taskId: number;
  paths: Map<string, Set<number>>;
  worktrees: string[];
  worktreesRoot: string;
  db: DatabaseSync;
}): string | null {
  const { directory, taskId, paths, worktrees, worktreesRoot, db } = input;
  const owners = paths.get(resolve(directory));
  if (!owners?.has(taskId) || owners.size !== 1) return t("tempWorkspace.settle.unowned");
  if (!isUnderWorktrees(directory, worktreesRoot)) return t("tempWorkspace.drop.notOwnedPath");
  if (worktrees.some(path => samePath(path, directory))) return t("tempWorkspace.drop.stillRegistered");
  const open = db.prepare("SELECT id, workspace_path FROM tasks WHERE id != ? AND status NOT IN ('done', 'archived') AND workspace_path IS NOT NULL")
    .all(taskId) as Array<{ id: number; workspace_path: string }>;
  const users = open.filter(row => pathWithin(directory, row.workspace_path));
  if (users.length) return t("tempWorkspace.missingGit.openCards", { cards: users.map(row => `#${row.id}`).join(t("common.listSep")) });
  return barePlaceholderError(directory);
}
