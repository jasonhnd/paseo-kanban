import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { UsagePlan, UsageWindow } from "../../../shared/fleet/usage";

const root = await mkdtemp(join(tmpdir(), "closed-pool-window-"));
for (const [key, dir] of Object.entries({ KANBAN_DATA_DIR: "afc", PASEO_HOME: "host",
   AFC_TRANSCRIPT_HOME: "transcripts" })) process.env[key] = join(root, dir);
const { poolStatus, POOL_STATUS, writePoolStatus } = await import("../pools-status");
const { QUOTA_HISTORY_FILE } = await import("../quota-history");
const { EARLY_RESET_FILE } = await import("../early-reset");
after(() => rm(root, { recursive: true, force: true }));
const now = Date.parse("2030-06-01T00:13:20Z");
const iso = (at: number) => new Date(at).toISOString();
const window = (id: string, label: string, usedPct: number, resetsAt: string, sampledAt = iso(now)): UsageWindow => ({
  id, label, usedPct, resetsAt, sampledAt, startsAt: null, elapsedPct: null, projectedPct: null, runsOutAt: null,
  verdict: "unknown", apiUsd: 0, fullWindowUsd: null, planUsd: null, source: "provider", manualAt: null,
});
const session = window("five_hour", "Session", 4, iso(now + 3600000), iso(now - 1000));
const weekly = window("seven_day", "Weekly", 53, iso(now + 5 * 86400000), iso(now - 2000));
const fable = window("weekly_model_demo", "Weekly · Fable", 57, weekly.resetsAt!, iso(now - 3000));
const plan = (windows: UsageWindow[], adapter: UsagePlan["adapter"] = "claude-cli", dispatch = false): UsagePlan => ({
  id: "demo-pool", name: "Demo", adapter, windows, dispatch, pacePause: false, onlyRoles: ["reviewer"],
  providers: ["demo"], note: "Owner pause", priceUsdMonthly: null, api30dUsd: 0, roi30d: null, coverage: "",
});

for (const windows of [[session, weekly, fable], [weekly, session, fable]]) {
  test(`closed Claude pool keeps its selected weekly reading with ${windows[0].label} first`, () => {
    const pools = poolStatus([plan(windows)], { now });
    const row = pools["demo-pool"];
    assert.equal(row.window, "Weekly");
    assert.equal(row.usedPct, 53);
    assert.equal(row.resetsAt, weekly.resetsAt);
    assert.equal(row.observedAt, weekly.sampledAt);
    assert.equal(row.dispatchable, false);
    assert.equal(row.prefer, false);
    assert.equal(row.deprioritize, false);
    assert.equal(row.paceState, "closed");
    assert.equal(row.reason, "Owner pause");
    assert.deepEqual(row.onlyRoles, ["reviewer"]);
    const sub = Object.values(pools).find(p => /Fable/.test(p.window ?? ""))!;
    assert.equal(sub.usedPct, 57);
    assert.equal(sub.resetsAt, fable.resetsAt);
    assert.equal(sub.observedAt, fable.sampledAt);
  });
}

test("closed Claude without a main week never turns a session or subwindow into the weekly pool", () => {
  for (const windows of [[session], [session, fable], []]) {
    const row = poolStatus([plan(windows)], { now })["demo-pool"];
    assert.equal(row.window, null);
    assert.equal(row.usedPct, null);
    assert.equal(row.resetsAt, null);
    assert.equal(row.dispatchable, false);
  }
});

test("closed unjudged and configured pools use their existing adapter or primary window rule", () => {
  const primary = { ...window("one_month", "Monthly", 25, iso(now + 20 * 86400000)), primary: true };
  for (const adapter of ["codex-cli", "manual", "muse-msp"] as const) {
    const row = poolStatus([plan([session, primary, weekly], adapter)], { now })["demo-pool"];
    assert.equal(row.window, "Monthly");
    assert.equal(row.usedPct, 25);
    assert.equal(row.resetsAt, primary.resetsAt);
    assert.equal(row.observedAt, primary.sampledAt);
    assert.equal(row.dispatchable, false);
  }
  const codex = poolStatus([plan([session, weekly], "codex-cli")], { now })["demo-pool"];
  assert.equal(codex.window, "Weekly");
  assert.equal(codex.usedPct, 53);
});

test("real publication does not rewrite old history or fabricate resets when a pool closes and reopens", async ctx => {
  ctx.mock.timers.enable({ apis: ["Date"], now });
  await mkdir(join(process.env.KANBAN_DATA_DIR!, "fleet")!, { recursive: true });
  await writeFile(join(join(process.env.KANBAN_DATA_DIR!, "fleet")!, "plans.json"), JSON.stringify({ plans: [plan([session, weekly, fable], "claude-cli", true)] }));
  const old = { samples: [{ at: iso(now - 1000), pools: { "demo-pool": { usedPct: 4, resetsAt: session.resetsAt } } }] };
  await writeFile(QUOTA_HISTORY_FILE, JSON.stringify(old));
  const historyBefore = await readFile(QUOTA_HISTORY_FILE, "utf8");
  await writePoolStatus([plan([session, weekly, fable], "claude-cli", true)], null, now);
  for (const dispatch of [false, true]) {
    await writePoolStatus([plan([session, weekly, fable], "claude-cli", dispatch)], null, now + 1000);
    const saved = JSON.parse(await readFile(POOL_STATUS, "utf8"));
    assert.equal(saved.pools["demo-pool"].usedPct, 53);
    assert.equal(saved.pools["demo-pool"].resetsAt, weekly.resetsAt);
    assert.equal(saved.pools["demo-pool"].observedAt, weekly.sampledAt);
    assert.equal(saved.pools["demo-pool"].dispatchable, dispatch);
  }
  assert.equal(await readFile(QUOTA_HISTORY_FILE, "utf8"), historyBefore);
  assert.deepEqual(JSON.parse(await readFile(EARLY_RESET_FILE, "utf8")).events, []);
  await writePoolStatus([plan([session, weekly, fable])], null, now + 86400000);
  const appended = JSON.parse(await readFile(QUOTA_HISTORY_FILE, "utf8"));
  assert.deepEqual(appended.samples[0], old.samples[0]);
  assert.equal(appended.samples[1].pools["demo-pool"].usedPct, null);
  assert.equal(appended.samples[1].pools["demo-pool"].resetsAt, weekly.resetsAt);
  ctx.mock.timers.reset();
});
