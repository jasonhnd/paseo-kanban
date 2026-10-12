/// <reference types="node" />
import { getDb } from "./db";
import type { AgentLauncher } from "./dispatch";
import { KanbanError } from "./errors";
import { pickWorkspace } from "./placement";
import { appendEvent } from "./store";
import { worktreeDirectoryLost } from "./workspace-recreate";
import { t } from "../shared/i18n";

/**
 * How long a start waits for Paseo to finish archiving a card's workspace (archivingAt set, or the record archived
 * with the directory still on disk) before it blocks the card for a person. Paseo removes the directory within seconds.
 */
export const PASEO_ARCHIVE_SETTLE_MS = 2 * 60_000;

/** Error code: Paseo archived the card's workspace but the directory stayed. The start blocks the card as needs_human. */
export const PASEO_ARCHIVED = "paseo_workspace_archived";

export type LiveWorkspace = { workspaceId?: string } | { hold: string };

function firstSeenAt(taskId: number, workspaceId: string): number | null {
  const row = getDb()
    .prepare(`SELECT at FROM events WHERE task_id = ? AND kind = 'paseo_workspace_archiving'
      AND json_extract(data_json, '$.workspaceId') = ? ORDER BY id LIMIT 1`)
    .get(taskId, workspaceId) as { at: string } | undefined;
  return row ? Date.parse(row.at) : null;
}

/**
 * Check a card's recorded worktree workspace before a start puts an agent in it.
 * Paseo archives a workspace in this order: mark it archiving, archive its agents, archive the record, remove the
 * directory. Its auto-archive-on-merge did that to DEMO_0001 while the card ran; the agent.archived hook reclaimed the
 * card and the restart opened a new agent in the same workspace, whose directory vanished six seconds later.
 * - live: the workspace id to use (a record that moved to another id at the same path is followed);
 * - archiving, or archived with the directory still on disk: a hold; once the directory is gone the next start rebuilds;
 * - still so after PASEO_ARCHIVE_SETTLE_MS: throws PASEO_ARCHIVED and the caller blocks the card. The board deletes nothing.
 * Without a workspace list, or with no recorded id and nothing at the path, the caller keeps its own rule.
 */
export async function liveWorkspace(input: {
  taskId: number;
  workspaceId?: string | null;
  directory: string;
  launcher: AgentLauncher;
  actor: string;
  now?: number;
}): Promise<LiveWorkspace> {
  const { taskId, directory, launcher, actor } = input;
  const recorded = input.workspaceId ?? undefined;
  if (!launcher.listWorkspaces) return { workspaceId: recorded };
  const listed = await launcher.listWorkspaces();
  // Paseo may have removed the directory while the list was on its way: that is the rebuild case, never "still there".
  if (worktreeDirectoryLost({ directory })) {
    return { hold: t("paseoArchiving.hold.directoryGone", { directory }) };
  }
  const entry = recorded ? listed.find((item) => item.id === recorded) : undefined;
  if (entry && !entry.archived) return { workspaceId: recorded };
  if (!entry) {
    const picked = pickWorkspace(listed, directory);
    if (picked || !recorded) return { workspaceId: picked?.id };
  }
  const workspaceId = recorded as string;
  const state = entry ? "archiving" : "archived";
  const since = firstSeenAt(taskId, workspaceId);
  if (since === null) {
    appendEvent(taskId, "paseo_workspace_archiving", null, null, actor, { workspaceId, directory, state });
  } else if ((input.now ?? Date.now()) - since > PASEO_ARCHIVE_SETTLE_MS) {
    throw new KanbanError(
      PASEO_ARCHIVED,
      t("paseoArchiving.error.directoryLeft", { workspaceId, directory }),
    );
  }
  const what = state === "archiving" ? t("paseoArchiving.state.archiving") : t("paseoArchiving.state.archived");
  return { hold: t("paseoArchiving.hold.archiving", { workspaceId, state: what }) };
}
