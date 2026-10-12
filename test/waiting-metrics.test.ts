import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { after, beforeEach, it } from "node:test";
import { waitingCardHours } from "../server/waiting-metrics";

const db = new DatabaseSync(":memory:");
db.exec(`CREATE TABLE tasks(id INTEGER PRIMARY KEY, project TEXT);
  CREATE TABLE events(id INTEGER PRIMARY KEY, task_id INTEGER, at TEXT, kind TEXT, to_status TEXT);`);
beforeEach(() => db.exec("DELETE FROM tasks; DELETE FROM events"));
after(() => db.close());
function event(task: number, hour: number, status: string | null, kind = "claim") {
  db.prepare("INSERT INTO events(task_id, at, kind, to_status) VALUES (?, ?, ?, ?)")
    .run(task, new Date(Date.UTC(2026, 9, 1, hour)).toISOString(), kind, status);
}
function hours(start = "2026-10-01T00:00:00Z", end = "2026-10-01T12:00:00Z") {
  return waitingCardHours(db, start, end);
}
function close(actual: number, expected: number) { assert.ok(Math.abs(actual - expected) < 0.000001, `${actual} != ${expected}`); }

it("clips a pre-window waiting period, includes open tails and repeated entries, and sums card-hours", () => {
  db.exec("INSERT INTO tasks VALUES(1, 'chain'), (2, 'chain'), (3, 'other')");
  event(1, -2, "waiting", "created");
  event(1, 2, "ready");
  event(1, 5, "waiting");
  event(1, 7, "ready");
  event(2, 4, "waiting", "created");
  event(3, 1, "ready", "created");
  close(hours()[0]!.waitingCardHours, 12); // 2 + 2 + 8; ready in other contributes zero.
  assert.equal(hours().length, 1);
});

it("ignores noise and same-status slices without counting ready, blocked or acceptance as waiting", () => {
  db.exec("INSERT INTO tasks VALUES(1, 'chain')");
  event(1, 0, "waiting", "created");
  event(1, 1, "waiting", "held");
  event(1, 2, null, "downstream_dispatched");
  event(1, 3, "ready");
  event(1, 4, "blocked");
  event(1, 5, "acceptance");
  event(1, 6, "done");
  close(hours()[0]!.waitingCardHours, 3);
});

it("uses event id to resolve equal timestamps and cuts at the window end", () => {
  db.exec("INSERT INTO tasks VALUES(1, 'chain')");
  event(1, 0, "waiting", "created");
  event(1, 2, "ready");
  event(1, 2, "waiting");
  event(1, 6, "ready");
  event(1, 12, "waiting");
  close(hours(undefined, "2026-10-01T04:00:00Z")[0]!.waitingCardHours, 4);
});

it("rejects invalid windows and returns zero for an empty event stream", () => {
  assert.deepEqual(hours(), []);
  assert.throws(() => waitingCardHours(db, "bad", "2026-10-01T12:00:00Z"));
  assert.throws(() => waitingCardHours(db, "2026-10-01T12:00:00Z", "2026-10-01T00:00:00Z"));
});
