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

test("a real pool-status rename failure rejects the publication rather than reporting success", async () => {
  await fs.rm(POOL_STATUS);
  await fs.mkdir(POOL_STATUS);
  await assert.rejects(writePoolStatus(plans, null, now), (error: NodeJS.ErrnoException) => ["EISDIR", "EPERM", "ENOTEMPTY"].includes(error.code ?? ""));
  assert.equal((await fs.readdir(join(root, "afc"))).some(name => name.endsWith(".tmp")), false);
});
