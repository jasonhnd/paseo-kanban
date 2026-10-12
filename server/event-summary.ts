import { getDb } from "./db";
import { appendEvent } from "./store";

/**
 * Summary events (DEMO_0001): flow events that used to be appended one by one (a skipped native session,
 * a removed Claude project dir, a cleaned tmp dir) become one row per card, kind and key. A repeat
 * updates that row: `count`, `lastAt`, the latest detail, and an optional list of the distinct items seen.
 * `summary: 1` marks such a row; readers that only look at the first occurrence still find its
 * original fields at the top level, and the latest values overwrite them.
 */
export interface SummaryOptions {
  /** Event time (tests). Defaults to now. */
  at?: string;
  /** Keep the row's own `at` at its first occurrence instead of moving it to the latest one. */
  keepAt?: boolean;
  /** Distinct entries collected in `data[field]`, newest `cap` kept. */
  list?: { field: string; entry: unknown; cap: number };
}

interface StoredSummary {
  count?: number;
  firstAt?: string;
  [field: string]: unknown;
}

function withEntry(previous: unknown, entry: unknown, cap: number): unknown[] {
  const items = Array.isArray(previous) ? [...previous] : [];
  const mark = JSON.stringify(entry);
  if (!items.some((item) => JSON.stringify(item) === mark)) items.push(entry);
  return items.slice(-cap);
}

/** Write or fold one summary event. Returns the row id. */
export function upsertSummaryEvent(
  taskId: number,
  kind: string,
  actor: string,
  key: string,
  data: Record<string, unknown>,
  options: SummaryOptions = {},
): number {
  const at = options.at ?? new Date().toISOString();
  const db = getDb();
  const previous = db
    .prepare(`SELECT id, at, data_json FROM events WHERE task_id = ? AND kind = ? AND json_extract(data_json, '$.summaryKey') = ? ORDER BY id DESC LIMIT 1`)
    .get(taskId, kind, key) as { id: number; at: string; data_json: string } | undefined;
  const list = options.list;
  if (!previous) {
    const first = { ...data, summary: 1, summaryKey: key, count: 1, firstAt: at, lastAt: at, ...(list ? { [list.field]: withEntry(undefined, list.entry, list.cap) } : {}) };
    return appendEvent(taskId, kind, null, null, actor, first, at);
  }
  const stored = JSON.parse(previous.data_json) as StoredSummary;
  const merged: StoredSummary = {
    ...stored,
    ...data,
    summary: 1,
    summaryKey: key,
    count: (typeof stored.count === "number" ? stored.count : 1) + 1,
    firstAt: stored.firstAt ?? previous.at,
    lastAt: at,
    ...(list ? { [list.field]: withEntry(stored[list.field], list.entry, list.cap) } : {}),
  };
  db.prepare("UPDATE events SET at = ?, data_json = ? WHERE id = ?").run(options.keepAt ? previous.at : at, JSON.stringify(merged), previous.id);
  return previous.id;
}
