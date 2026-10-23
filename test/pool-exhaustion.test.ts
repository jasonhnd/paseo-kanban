import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { notifyPoolExhaustion } from "../server/fleet/pool-exhaustion";
import type { RankingPool } from "../shared/fleet/pool-ranking";
const root = mkdtempSync(join(tmpdir(), "pool-exhaustion-"));
after(() => rmSync(root, { recursive: true, force: true }));
const now = Date.parse("2030-06-01T00:00:00Z");
const reset = "2030-06-08T00:00:00Z";
const row: RankingPool = { state: "known", dispatchable: true, usedPct: 20, resetsAt: reset,
  projectedPct: 350, runsOutAt: "2030-06-03T00:00:00Z", forecastConfidence: "high" };

test("AFC warns once per pool/reset/recipient, serializes calls and retries only failed sends", async () => {
  const path = join(root, "notices.json");
  const sent: string[] = [];
  let fail = true;
  const notify = async (id: string, text: string) => { if (id === "demo-two" && fail) throw new Error("Demo failed send");
    assert.match(text, /L3\/L4/); sent.push(id); };
  const send = (pools = { demo: row }) => notifyPoolExhaustion(pools, ["demo-one", "demo-two", "demo-one"], notify, path, now);
  await send(); fail = false;
  await Promise.all(Array.from({ length: 4 }, () => send()));
  assert.deepEqual(sent, ["demo-one", "demo-two"]);
  // Forecast oscillation and unknown reads cannot re-arm a notice in the same cycle.
  await send({ demo: { ...row, projectedPct: 30, runsOutAt: null } });
  await send({ demo: { ...row, state: "unknown" } });
  await send();
  assert.equal(sent.length, 2);
  await send({ demo: { ...row, resetsAt: "2030-06-15T00:00:00Z" } });
  assert.equal(sent.length, 4);
});

test("no messages from unknown, stale, stopped, insufficient forecasts or already reset cycles", async () => {
  const sent: string[] = [];
  for (const extra of [{ state: "unknown" as const }, { quotaStateExpiresAt: new Date(now).toISOString() },
    { dispatchable: false }, { forecastConfidence: "none" as const }, { resetsAt: new Date(now).toISOString() }]) {
    await notifyPoolExhaustion({ demo: { ...row, ...extra } }, ["demo"], async id => { sent.push(id); }, join(root, "quiet.json"), now);
  }
  assert.deepEqual(sent, []);
});
