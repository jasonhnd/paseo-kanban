/// <reference types="node" />
import { basename } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { getDb } from "./db";
import { samePath } from "./placement";

/** A lane directory is named `kanban-lane-<n>`, whether or not an event remembered it. */
export function isLaneDirectory(directory: string | null | undefined): boolean {
  if (!directory?.trim()) return false;
  return /^kanban-lane-\d+$/.test(basename(directory));
}

function rememberedLanes(db: DatabaseSync): { ids: Set<string>; directories: string[] } {
  const rows = db.prepare("SELECT data_json FROM events WHERE kind = 'lane_bound'").all() as unknown as Array<{ data_json: string }>;
  const ids = new Set<string>();
  const directories: string[] = [];
  for (const row of rows) {
    let data: { workspaceId?: unknown; directory?: unknown };
    try {
      data = JSON.parse(row.data_json) as { workspaceId?: unknown; directory?: unknown };
    } catch {
      continue;
    }
    if (typeof data.workspaceId === "string" && data.workspaceId) ids.add(data.workspaceId);
    if (typeof data.directory === "string" && data.directory) directories.push(data.directory);
  }
  return { ids, directories };
}

/**
 * A lane workspace stays for the life of the project.
 * Known from a lane_bound event (workspace id or directory) or from a lane directory name.
 */
export function isLaneWorkspace(workspaceId: string | null | undefined, directory?: string | null, db: DatabaseSync = getDb()): boolean {
  if (isLaneDirectory(directory)) return true;
  const remembered = rememberedLanes(db);
  if (workspaceId && remembered.ids.has(workspaceId)) return true;
  if (directory && remembered.directories.some((item) => samePath(item, directory))) return true;
  return false;
}
