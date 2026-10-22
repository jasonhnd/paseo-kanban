import { t } from "../shared/i18n";
import { cardMark } from "./card-ref";
import type { TaskRow } from "./task-record";

/** Legacy standalone reviewers have no original work binding. Offer a conditional
 * recovery command without inferring a target or interpreting free-text block reasons.
 */
export function legacyReviewRecoveryHint(task: TaskRow): string | null {
  if (task.role !== "reviewer" || task.review_of != null || task.status !== "blocked" ||
      task.blocked_kind !== "needs_human" || task.executor_agent_id || task.executor_profile) return null;
  return t("reviewRecovery.standaloneGuidance", { card: cardMark(task.id) });
}
