import assert from "node:assert/strict";
import { test } from "node:test";
import type { BoardSnapshot } from "../../../shared/fleet/board";
import { reconcilePanelClosedRows, type PanelClosedRow } from "../../../client/fleet/panel-closed-rows";

const row = { id: "demo-item" };
const atClose = "2026-06-01T12:00:00.000Z";

function decisions(ids: string[], generatedAt: string): Pick<BoardSnapshot, "decisions" | "generatedAt"> {
  return {
    generatedAt,
    decisions: ids.map((id) => ({ id, kind: "decide" as const })) as BoardSnapshot["decisions"],
  };
}

function held(closed: boolean, generatedAt = atClose, confirmed = false): ReadonlyMap<string, PanelClosedRow<typeof row>> {
  return new Map([[row.id, {
    row,
    closed,
    confirmed,
    generatedAt,
    decisions: decisions([row.id], generatedAt).decisions,
  }]]);
}

test("a newer snapshot that omits the id drops a restored row", () => {
  const next = reconcilePanelClosedRows(held(false), decisions([], "2026-06-01T12:00:01.000Z"));
  assert.equal(next.has(row.id), false);
});

test("an older or same-generation omission keeps a restored row", () => {
  const older = reconcilePanelClosedRows(held(false), decisions([], "2026-06-01T11:00:00.000Z"));
  assert.equal(older.get(row.id)?.closed, false);
  const same = reconcilePanelClosedRows(held(false), decisions([], atClose));
  assert.equal(same.get(row.id)?.closed, false);
});

test("a same-generation open snapshot releases a restored row", () => {
  const next = reconcilePanelClosedRows(held(false), decisions([row.id], atClose));
  assert.equal(next.has(row.id), false);
});

test("an older omission does not confirm a local close, so the following open snapshot keeps Undo", () => {
  const afterStale = reconcilePanelClosedRows(held(true), decisions([], "2026-06-01T11:00:00.000Z"));
  assert.equal(afterStale.get(row.id)?.closed, true);
  assert.equal(afterStale.get(row.id)?.confirmed, false);
  const afterOpen = reconcilePanelClosedRows(afterStale, decisions([row.id], atClose));
  assert.equal(afterOpen.get(row.id)?.closed, true);
  assert.equal(afterOpen.get(row.id)?.confirmed, false);
});

test("a same-generation open list keeps an unconfirmed close", () => {
  const next = reconcilePanelClosedRows(held(true), decisions([row.id], atClose));
  assert.equal(next.get(row.id)?.closed, true);
  assert.equal(next.get(row.id)?.confirmed, false);
});

test("a newer omission confirms a local close and keeps Undo", () => {
  const next = reconcilePanelClosedRows(held(true), decisions([], "2026-06-01T12:00:02.000Z"));
  assert.equal(next.get(row.id)?.closed, true);
  assert.equal(next.get(row.id)?.confirmed, true);
});

test("a snapshot older than the close readback keeps Undo, and a newer open snapshot releases it", () => {
  const readback = reconcilePanelClosedRows(held(true), decisions([], "2026-06-01T12:00:05.000Z"));
  assert.equal(readback.get(row.id)?.confirmed, true);
  const staleOpen = reconcilePanelClosedRows(readback, decisions([row.id], "2026-06-01T12:00:03.000Z"));
  assert.equal(staleOpen.get(row.id)?.closed, true);
  const reopened = reconcilePanelClosedRows(staleOpen, decisions([row.id], "2026-06-01T12:00:06.000Z"));
  assert.equal(reopened.has(row.id), false);
});

test("a different decisions array does not make an older snapshot fresh", () => {
  const older = decisions([], "2026-06-01T11:00:00.000Z");
  const first = reconcilePanelClosedRows(held(true), older);
  const second = reconcilePanelClosedRows(first, { generatedAt: older.generatedAt, decisions: [] as BoardSnapshot["decisions"] });
  assert.equal(second.get(row.id)?.confirmed, false);
  assert.equal(second.get(row.id)?.closed, true);
});
