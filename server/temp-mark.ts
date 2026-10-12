/// <reference types="node" />
import { t } from "../shared/i18n";
import { cardMark } from "./card-ref";
import { getDb } from "./db";
import { cleanupMark } from "./cleanup-state";
import { describePendingLand, pendingLand } from "./land-pending";

export function isTempWorkspace(taskId: number): boolean {
  const row = getDb().prepare("SELECT id FROM events WHERE task_id = ? AND kind = 'temp_workspace' LIMIT 1").get(taskId);
  return Boolean(row);
}

export function tempCleaned(taskId: number): boolean {
  return cleanupMark(taskId, ["temp_workspace_cleaned"]);
}

/** Shown on the card until the temporary workspace has been cleaned up. */
export function tempNoteFor(taskId: number): string | null {
  if (!isTempWorkspace(taskId) || tempCleaned(taskId)) return null;
  const pending = pendingLand(taskId);
  if (pending) return t("tempMark.note.pending", { card: cardMark(taskId), detail: describePendingLand(pending) });
  return t("tempMark.note.temp", { card: cardMark(taskId) });
}
