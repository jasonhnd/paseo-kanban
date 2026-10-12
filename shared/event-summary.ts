/**
 * Read side of a summary event (DEMO_0001): a row that stands for `count` repeated flow events.
 * The writer is server/event-summary.ts (and cleanup.ts for repeated verify_agent). Summary rows keep the
 * ordinary fields of the latest event at the top level, plus `summary: 1`, `count`, `firstAt`, `lastAt`.
 */

/** The repeat count of a summary event's data, or null for an ordinary single-event row. */
export function summaryCount(data: Record<string, unknown> | null | undefined): number | null {
  if (!data || data.summary !== 1) return null;
  return typeof data.count === "number" && data.count > 0 ? data.count : null;
}
