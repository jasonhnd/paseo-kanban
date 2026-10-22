/// <reference types="node" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { configuredOpsProject } from "../shared/fleet/ops-project";
import { t } from "../shared/i18n";
import { assertConfigReadable, loadConfig, type KanbanConfig } from "./config";
import { getDb } from "./db";
import { KanbanError } from "./errors";
import { dataDir } from "./paths";
import type { TaskRow } from "./task-record";
import { hasLiveCardCredential, type Identity } from "./tokens";

function cleanupProject(config: KanbanConfig): string | null {
  // A present but invalid board setting disables access instead of reviving an older Fleet setting.
  if (Object.hasOwn(config, "opsProject")) return config.opsProject ?? null;
  try {
    return configuredOpsProject(JSON.parse(readFileSync(join(dataDir(), "fleet", "afc.config.json"), "utf8")));
  } catch { return null; }
}

/** Derived on every call from host-owned state; labels, request fields and role env vars grant nothing. */
export function isOpsCleanupWorker(identity: Identity): boolean {
  if (identity.role !== "batch" || !identity.agentId || identity.taskId == null) return false;
  try {
    if (!hasLiveCardCredential(identity)) return false;
    assertConfigReadable();
    const config = loadConfig();
    const project = cleanupProject(config);
    if (!project) return false;
    // Match full configured names, never a short code, title, tag or a guessed default project.
    const names = Object.keys(config.projects ?? {});
    const matches = names.filter(value => value.toLowerCase() === project.toLowerCase());
    const name = names.includes(project) ? project : matches.length === 1 ? matches[0] : null;
    if (!name) return false;
    const row = getDb().prepare(`SELECT 1 FROM tasks t JOIN runs r ON r.task_id = t.id
      WHERE t.id = ? AND t.project = ? AND t.role = 'batch' AND t.status = 'running'
        AND t.agent_id = ? AND r.agent_id = t.agent_id AND r.role = 'batch'
        AND r.ended_at IS NULL AND r.end_kind IS NULL
        AND r.id = (SELECT MAX(id) FROM runs WHERE task_id = t.id)
        AND r.id = (SELECT MAX(id) FROM runs WHERE agent_id = t.agent_id)
        AND EXISTS (SELECT 1 FROM events e WHERE e.task_id = t.id AND e.kind = 'agent_opened'
          AND json_valid(e.data_json) AND json_extract(e.data_json, '$.agentId') = t.agent_id)`)
      .get(identity.taskId, name, identity.agentId);
    return Boolean(row);
  } catch { return false; }
}

/** Cleanup may retire resources of finished cards only; it never changes their business status. */
export function assertOpsCleanupTarget(task: TaskRow): void {
  if (task.status !== "done" && task.status !== "archived") {
    throw new KanbanError("forbidden", t("opsCleanup.finishedOnly"));
  }
}
