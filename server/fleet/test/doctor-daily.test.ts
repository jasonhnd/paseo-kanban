import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyDailyState, type DoctorDailyState } from "../../../shared/fleet/doctor-daily";
import type { DoctorReport } from "../../../shared/fleet/doctor";

const home = await mkdtemp(join(tmpdir(), "afc-daily-"));
process.env.PASEO_HOME = join(home, "daemon");
process.env.KANBAN_PASEO_CONFIG = join(process.env.PASEO_HOME!, "config.json");
process.env.KANBAN_DATA_DIR = join(home, "data");

const { runDailyOnce } = await import("../doctor-daily");
const now = Date.parse("2026-01-02T01:00:00Z");

function harness() {
  let state: DoctorDailyState = emptyDailyState();
  let leader: string | null = null;
  let runs = 0, histories = 0, notices = 0;
  const report = { at: new Date(now).toISOString(), worst: "red", counts: {}, items: [
    { id: "demo", title: "Demo check", status: "red", summary: "Needs setup",
      findings: [{ key: "demo", status: "red", text: "Needs setup" }] },
  ] } as DoctorReport;
  const deps = {
    now: () => now,
    run: async () => { runs++; return report; },
    loadState: async () => state,
    saveState: async (value: DoctorDailyState) => { state = value; },
    appendHistory: async () => { histories++; },
    leaderId: async () => leader,
    notify: async () => { notices++; },
  };
  return { deps, state: () => state, counts: () => [runs, histories, notices], setLeader: () => { leader = "demo-leader"; } };
}

test("daily findings wait quietly for leader registration without losing the notice", async (context) => {
  const errors = context.mock.method(console, "error", () => {});
  const h = harness();
  assert.equal(await runDailyOnce(h.deps), true);
  const pending = h.state().pending;
  assert.ok(pending);
  assert.equal(await runDailyOnce(h.deps), false);
  assert.equal(h.state().pending, pending);
  assert.deepEqual(h.counts(), [1, 1, 0]);
  assert.equal(errors.mock.callCount(), 0);
  h.setLeader();
  assert.equal(await runDailyOnce(h.deps), true);
  assert.equal(h.state().pending, null);
  assert.deepEqual(h.state().notified.keys, ["demo"]);
  assert.deepEqual(h.counts(), [1, 1, 1]);
});

test("a registered leader's delivery failure remains retryable and observable", async (context) => {
  const errors = context.mock.method(console, "error", () => {});
  const h = harness();
  h.setLeader();
  h.deps.notify = async () => { throw new Error("demo delivery failure"); };
  assert.equal(await runDailyOnce(h.deps), true);
  assert.ok(h.state().pending);
  assert.equal(errors.mock.callCount(), 1);
  await assert.rejects(runDailyOnce(h.deps), /demo delivery failure/);
  assert.ok(h.state().pending);
  assert.deepEqual(h.counts(), [1, 1, 0]);
  await rm(home, { recursive: true, force: true });
});
