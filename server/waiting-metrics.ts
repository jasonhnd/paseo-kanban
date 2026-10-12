import type { DatabaseSync } from "node:sqlite";
import { t } from "../shared/i18n";

/** Status slices use every non-null to_status, matching the workflow-week audit. */
export const WAITING_CARD_HOURS_SQL = `
WITH bounds AS (
  SELECT julianday($windowStart) AS lo, julianday($windowEnd) AS hi
), timeline AS (
  SELECT e.task_id, e.to_status, julianday(e.at) AS at,
         LEAD(julianday(e.at), 1, b.hi) OVER (
           PARTITION BY e.task_id ORDER BY julianday(e.at), e.id
         ) AS until
  FROM events e CROSS JOIN bounds b
  WHERE e.to_status IS NOT NULL AND julianday(e.at) < b.hi
), slices AS (
  SELECT t.project, MAX(0, MIN(s.until, b.hi) - MAX(s.at, b.lo)) * 24 AS hours
  FROM timeline s JOIN tasks t ON t.id = s.task_id CROSS JOIN bounds b
  WHERE s.to_status = 'waiting' AND s.until > b.lo
)
SELECT project, SUM(hours) AS waitingCardHours FROM slices
GROUP BY project ORDER BY project
`;

/** Pass a read-only snapshot connection; this helper neither opens nor migrates a DB. */
export function waitingCardHours(db: DatabaseSync, windowStart: string, windowEnd: string): Array<{ project: string; waitingCardHours: number }> {
  const lo = Date.parse(windowStart);
  const hi = Date.parse(windowEnd);
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) throw new Error(t("waitingMetrics.badWindow"));
  return db.prepare(WAITING_CARD_HOURS_SQL).all({ windowStart: new Date(lo).toISOString(), windowEnd: new Date(hi).toISOString() }) as unknown as Array<{ project: string; waitingCardHours: number }>;
}
