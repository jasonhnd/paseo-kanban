import { readFileSync } from "node:fs";
import { t } from "../shared/i18n";
import { parseTags } from "./profile-rules";
import { loadConfig, projectSupervisor } from "./config";
import { cardMark } from "./card-ref";
import { hasWakeSender, sendWake } from "./bus";
import { getDb } from "./db";
import { addEvent, taskById, type TaskRow } from "./task-record";

export function isQaReview(task: Pick<TaskRow, "role" | "tags">): boolean {
  return task.role === "reviewer" && parseTags(task.tags).includes("qa");
}

/** An explicit source line keeps admission deterministic; the reviewer checks its actual contents. */
export function qaSpecification(brief: string): string | null {
  return brief.match(/^(?:Specification|Spec source|\u89c4\u683c\u6765\u6e90)[ \t]*[:\uff1a][ \t]*(\S[^\r\n]*)$/im)?.[0].trim() ?? null;
}

function contact(file: string | undefined, project: string): string | null {
  if (!file) return null;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    const id = raw?.projects?.[project]?.sb_leader?.paseoAgentId;
    return typeof id === "string" && id.trim() ? id.trim() : null;
  } catch { return null; }
}

function comment(id: number, body: string): void {
  getDb().prepare("INSERT INTO comments(task_id, author, body, created_at) VALUES (?, 'scheduler', ?, ?)")
    .run(id, body, new Date().toISOString());
}

/** Reserve before sending, so repeated calls and concurrent approval hooks cannot send twice.
 * The durable claim is intentionally at-most-once: a transport error is recorded for the leader,
 * never automatically resent after an uncertain delivery or process crash.
 */
export function notifyQaSignoff(review: TaskRow, target: TaskRow, summary: string): void {
  if (!isQaReview(review)) return;
  const db = getDb();
  const approval = db.prepare("SELECT id FROM events WHERE task_id = ? AND kind = 'approve' ORDER BY id DESC LIMIT 1")
    .get(review.id) as { id: number } | undefined;
  if (!approval) return;
  const claimed = db.prepare(`INSERT INTO events(task_id, at, kind, from_status, to_status, actor, data_json)
    SELECT ?, ?, 'qa_signoff', NULL, NULL, 'scheduler', ? WHERE NOT EXISTS
    (SELECT 1 FROM events WHERE task_id = ? AND kind = 'qa_signoff' AND json_extract(data_json, '$.approvalEventId') = ?)`)
    .run(review.id, new Date().toISOString(), JSON.stringify({ approvalEventId: approval.id }), review.id, approval.id);
  if (!claimed.changes) return;
  let config;
  try { config = loadConfig(); }
  catch {
    comment(review.id, t("qa.deliveryFailed"));
    addEvent(review.id, "qa_signoff_result", null, review.status, "scheduler", { targetId: target.id, delivered: false, reason: "config_unavailable" });
    return;
  }
  const sb = contact(config.contactsFile, target.project);
  const agentId = sb ?? projectSupervisor(target.project, config);
  const fallback = !sb;
  const source = qaSpecification(review.brief) ?? t("qa.missingSpecification");
  const text = t("qa.signoff", { project: target.project, target: cardMark(target.id), review: cardMark(review.id), source, summary });
  if (fallback) {
    const note = t("qa.fallback");
    comment(review.id, note); comment(target.id, note);
  }
  const result = agentId && hasWakeSender() ? sendWake(agentId, text) : false;
  const record = (delivered: boolean) => {
    // Re-read for status only; the contact file is read anew by each notification above.
    addEvent(review.id, "qa_signoff_result", null, taskById(review.id).status, "scheduler", { approvalEventId: approval.id, targetId: target.id, agentId, fallback, delivered });
    if (!delivered) comment(review.id, t("qa.deliveryFailed"));
  };
  if (typeof result === "boolean") record(result);
  else void result.then(record);
}
