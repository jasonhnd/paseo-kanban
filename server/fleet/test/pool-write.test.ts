import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { UsagePlan } from "../../../shared/fleet/usage";
import { EXPORTS } from "../../../shared/contract/schema";

const root = await fs.mkdtemp(join(tmpdir(), "pool-write-"));
process.env.KANBAN_DATA_DIR = join(root, "afc");
process.env.PASEO_HOME = join(root, "paseo");
process.env.KANBAN_PASEO_CONFIG = join(process.env.PASEO_HOME!, "config.json");


process.env.AFC_TRANSCRIPT_HOME = join(root, "transcripts");
const { POOL_STATUS, writePoolStatus } = await import("../pools-status");
after(() => fs.rm(root, { recursive: true, force: true }));

const now = Date.parse("2030-06-01T00:00:00Z");
const plans: UsagePlan[] = [
  { id: "demo-acp", name: "Antigravity", adapter: "antigravity-cli", quotaProtection: "pause",
    dispatch: false, providers: ["antigravity"], windows: [], priceUsdMonthly: null, note: "", api30dUsd: 0, roi30d: null, coverage: "" },
  { id: "demo-muse", name: "Muse", adapter: "muse-msp", dispatch: true, pacePause: false, providers: ["muse"],
    windows: [{ label: "Weekly", usedPct: 25, resetsAt: "2030-06-08T00:00:00Z", startsAt: "2030-06-01T00:00:00Z",
      elapsedPct: null, projectedPct: null, runsOutAt: null, verdict: "unknown", apiUsd: 0, fullWindowUsd: null, planUsd: null, source: "provider", manualAt: null }],
    priceUsdMonthly: null, note: "", api30dUsd: 0, roi30d: null, coverage: "" },
];

test("concurrent pool publications keep unknown ACP protected and legitimate provider quota dispatchable", async () => {
  const results = await Promise.all(Array.from({ length: 8 }, () => writePoolStatus(plans, null, now)));
  for (const pools of results) {
    assert.equal(pools["demo-acp"].usedPct, null);
    assert.equal(pools["demo-acp"].dispatchable, false);
    assert.equal(pools["demo-acp"].quotaProtection, "pause");
    assert.equal(pools["demo-muse"].usedPct, 25);
    assert.equal(pools["demo-muse"].dispatchable, true);
  }
  const legacy = JSON.parse(await fs.readFile(POOL_STATUS, "utf8"));
  assert.equal(legacy.generatedAt, new Date(now).toISOString());
  const exported = EXPORTS.poolStatus.schema.parse(JSON.parse(await fs.readFile(join(root, "afc", "exports", "fleet", "pool-status.json"), "utf8")));
  for (const id of ["demo-acp", "demo-muse"]) {
    assert.equal(exported.pools[id].usedPct, legacy.pools[id].usedPct);
    assert.equal(exported.pools[id].dispatchable, legacy.pools[id].dispatchable);
  }
  assert.equal((await fs.readdir(join(root, "afc"))).some(name => name.endsWith(".tmp")), false);
});

test("recent forecast survives publication, contract parsing and the quota panel view", async () => {
  const { poolView } = await import("../usage-view");
  const { poolForecastText } = await import("../../../shared/fleet/quota-plans-view");
  const { t } = await import("../../../shared/fleet/i18n");
  const hour = 3_600_000;
  let pools;
  for (const [offset, usedPct] of [[0, 10], [1, 20], [2, 30]]) {
    const plan = structuredClone(plans[1]);
    plan.windows[0].usedPct = usedPct;
    plan.windows[0].sampledAt = new Date(now + (offset + 3) * hour).toISOString();
    pools = await writePoolStatus([plan], null, now + (offset + 3) * hour);
  }
  const snapshot = JSON.parse(await fs.readFile(POOL_STATUS, "utf8"));
  const exported = EXPORTS.poolStatus.schema.parse(JSON.parse(await fs.readFile(join(root, "afc", "exports", "fleet", "pool-status.json"), "utf8")));
  const forecast = exported.pools["demo-muse"];
  assert.equal(forecast.burnRatePctPerHour, 10);
  assert.equal(forecast.forecastConfidence, "high");
  assert.equal(forecast.runsOutAt, new Date(now + 12 * hour).toISOString());
  assert.equal(forecast.projectedPct, snapshot.pools["demo-muse"].projectedPct);
  assert.equal(snapshot.pools["demo-muse"].wastePct, 0);
  assert.equal(snapshot.pools["demo-muse"].wasteRisk, 0);
  const view = poolView(pools!)["demo-muse"];
  assert.equal(view.projectedPct, forecast.projectedPct);
  assert.equal(poolForecastText(view), t("quota.forecast.runsOut", { when: (await import("../../../shared/fleet/quota-plans-view")).fmtWhen(forecast.runsOutAt!) }));
  assert.equal(poolForecastText({ forecastConfidence: "low", runsOutAt: null, projectedPct: 45 }), t("quota.forecast.atReset", { pct: 45 }));
  assert.equal(poolForecastText({ forecastConfidence: "none", runsOutAt: null, projectedPct: null }), t("quota.forecast.insufficient"));
});

test("a real pool-status rename failure rejects the publication rather than reporting success", async () => {
  await fs.rm(POOL_STATUS);
  await fs.mkdir(POOL_STATUS);
  await assert.rejects(writePoolStatus(plans, null, now), (error: NodeJS.ErrnoException) => ["EISDIR", "EPERM", "ENOTEMPTY"].includes(error.code ?? ""));
  assert.equal((await fs.readdir(join(root, "afc"))).some(name => name.endsWith(".tmp")), false);
});

test("routing metadata preserves pool-specific ordinary, coupon and reviewer reserve lines", async () => {
  const { poolStatus } = await import("../pools-status");
  const { buildPoolStatusExport } = await import("../exports");
  const { readCompatibilityPoolSnapshot } = await import("../../pools");
  const claude: UsagePlan = { ...structuredClone(plans[1]), id: "demo-claude", adapter: "claude-cli", providers: ["claude"],
    windows: [
      { ...structuredClone(plans[1].windows[0]), label: "Weekly", usedPct: 40 },
      { ...structuredClone(plans[1].windows[0]), label: "Fable weekly", usedPct: 80 },
    ] };
  const ordinary = poolStatus([claude], { now });
  const child = Object.values(ordinary).find(p => p.parent === claude.id)!;
  assert.equal(ordinary[claude.id].reservePct, 25); assert.equal(child.reservePct, 0); assert.equal(child.dispatchable, true);
  const double = poolStatus([claude], { now, claudeDoubleWeek: true });
  assert.equal(double[claude.id].reservePct, 10);
  const burn = poolStatus([claude], { now, claudeBurn: { phase: "front", startMs: now, endMs: now + 7 * 86400000, unpauseProfiles: [] } });
  assert.equal(burn[claude.id].reservePct, 0);
  const exception = { ...claude, reviewerException: { roles: ["reviewer"], stopPct: 98, until: "2030-06-03T00:00:00Z" } };
  exception.windows[0].usedPct = 78;
  const review = poolStatus([exception], { now });
  assert.equal(review[claude.id].reservePct, 2); assert.deepEqual(review[claude.id].onlyRoles, ["reviewer"]);
  const exported = EXPORTS.poolStatus.schema.parse(buildPoolStatusExport(review, null, "0", new Date(now)));
  const childId = Object.keys(exported.pools).find(id => exported.pools[id].parent === claude.id)!;
  assert.equal(exported.pools[childId].adapter, "claude-cli"); assert.deepEqual(exported.pools[childId].providers, ["claude"]);
  const path = join(root, "routing-metadata.json"); await fs.writeFile(path, JSON.stringify(exported));
  const saved = process.env.KANBAN_POOL_STATUS; process.env.KANBAN_POOL_STATUS = path;
  try {
    const snapshot = readCompatibilityPoolSnapshot();
    assert.equal(snapshot.entry(claude.id).reservePct, 2); assert.equal(snapshot.entry(childId).parent, claude.id);
    assert.equal(snapshot.entry(childId).reservePct, 0);
  } finally {
    if (saved === undefined) delete process.env.KANBAN_POOL_STATUS; else process.env.KANBAN_POOL_STATUS = saved;
  }
});
