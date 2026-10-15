import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { CURSOR_API, MANUAL, companyCatalog } from "../../../shared/fleet/quota-adapters";
import { t, setLanguage } from "../../../shared/fleet/i18n";
import type { PaseoApi } from "../paseo-api";

const root = await mkdtemp(join(tmpdir(), "cursor-monitoring-"));
process.env.KANBAN_DATA_DIR = join(root, "data");
process.env.PASEO_HOME = join(root, "host");
process.env.KANBAN_PASEO_CONFIG = join(root, "host/config.json");
process.env.AFC_TRANSCRIPT_HOME = join(root, "transcripts");
const { buildUsage, PLANS } = await import("../usage");
const { adapterSwitches } = await import("../adapters/config");
const { clearCache } = await import("../util");
const fleet = join(process.env.KANBAN_DATA_DIR, "fleet");
after(() => rm(root, { recursive: true, force: true }));

// No provider method, token or login is available. An off reader must not need one.
const paseo = {} as PaseoApi;
test("fresh-root transfer keeps Cursor off and exposes that state through RPC and cached cards", async () => {
  setLanguage("en");
  await mkdir(fleet, { recursive: true });
  const config = { language: "en", disabledPools: ["demo-cursor"], extension: { demo: true } };
  await writeFile(join(fleet, "afc.config.json"), JSON.stringify(config));
  const plan = { id: "demo-cursor", name: "Cursor", adapter: CURSOR_API, providers: ["cursor"], dispatch: false,
    screenRead: false, priceUsdMonthly: null, manual: { usedPct: 23, at: new Date(Date.now() - 3 * 86400000).toISOString() } };
  await writeFile(PLANS, JSON.stringify({ plans: [plan] }));
  assert.equal(adapterSwitches(fleet)[CURSOR_API], false);
  const board = await buildUsage(paseo, "7d");
  assert.equal(board.plans[0].adapter, MANUAL);
  assert.equal(board.plans[0].cursorMonitoring, false);
  const card = board.companies![0];
  assert.equal(card.cursorMonitoring, false);
  assert.equal(card.notice, t("cursor.monitoring.off"));
  assert.equal(board.pools![plan.id].dispatchable, false);
  const cached = JSON.parse(await readFile(join(fleet, "quota-companies.json"), "utf8"));
  assert.equal(cached.companies[0].cursorMonitoring, false);
  assert.equal((await readdir(fleet)).includes("cursor-usage.json"), false);
  assert.equal((await readdir(fleet)).includes("cursor-login-state.json"), false);
  assert.equal((await readdir(fleet)).includes("quota-sampling.json"), false);
  assert.deepEqual(JSON.parse(await readFile(join(fleet, "afc.config.json"), "utf8")), config);
  clearCache();
});

test("legacy markers keep monitoring on independently of dispatch and disabledPools", async () => {
  const legacy = join(root, "legacy"); await mkdir(legacy);
  await writeFile(join(legacy, "afc.config.json"), JSON.stringify({ disabledPools: ["demo-cursor"] }));
  for (const marker of ["cursor-usage.json", "cursor-login-state.json"]) {
    await writeFile(join(legacy, marker), "{}");
    const switches = adapterSwitches(legacy);
    const entry = companyCatalog([{ id: "demo-cursor", adapter: CURSOR_API, providers: ["cursor"] }], switches)[0];
    assert.equal(entry.adapter, CURSOR_API);
    assert.equal(entry.cursorMonitoring, true);
    await rm(join(legacy, marker));
  }
  for (const dispatch of [true, false]) for (const disabledPools of [[], ["demo-cursor"]]) {
    await writeFile(join(legacy, "afc.config.json"), JSON.stringify({ disabledPools, adapters: { [CURSOR_API]: true } }));
    assert.equal(adapterSwitches(legacy)[CURSOR_API], true);
    const entry = companyCatalog([{ id: "demo-cursor", adapter: CURSOR_API, ...{ dispatch } }], adapterSwitches(legacy))[0];
    assert.equal(entry.cursorMonitoring, true);
  }
  const ordinary = companyCatalog([{ id: "demo-manual", adapter: MANUAL, providers: ["cursor"] }])[0];
  assert.equal(ordinary.cursorMonitoring, undefined);
});
