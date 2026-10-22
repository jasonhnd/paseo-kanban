import { getDb } from "../../server/db";
import { createTask, getTask, type CreateInput, type TaskRow } from "../../server/store";

/** Import-only fixtures retain old duplicate rows to test lifecycle and alarm recovery.
 * Public create/CLI tests must use createTask and exercise the duplicate guard.
 */
export function seedLegacyLinkedReview(input: CreateInput & { reviewOf: number }): TaskRow {
  const { reviewOf, ...rest } = input;
  const task = createTask(rest);
  getDb().prepare("UPDATE tasks SET review_of = ? WHERE id = ?").run(reviewOf, task.id);
  return getTask(task.id);
}

/** Run the real start producer, then restore the other imported reservations to
 * represent an old database with already-concurrent reviews. Never used by
 * admission tests: those must observe the production duplicate refusal.
 */
export async function startLegacyLinkedReview<T>(review: TaskRow, start: () => Promise<T>): Promise<T> {
  const others = getDb().prepare(`SELECT id, status FROM tasks WHERE role = 'reviewer'
    AND review_of = ? AND id != ? AND status NOT IN ('acceptance', 'done', 'archived')`)
    .all(review.review_of, review.id) as unknown as Array<{ id: number; status: string }>;
  for (const row of others) getDb().prepare("UPDATE tasks SET status = 'acceptance' WHERE id = ?").run(row.id);
  try { return await start(); }
  finally { for (const row of others) getDb().prepare("UPDATE tasks SET status = ? WHERE id = ?").run(row.status, row.id); }
}
