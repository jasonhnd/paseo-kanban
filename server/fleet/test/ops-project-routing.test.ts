import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VALID } from "../../contract/test/fixtures";
import { emptyDailyState } from "../../../shared/fleet/doctor-daily";
import type { DoctorReport } from "../../../shared/fleet/doctor";

const root = await mkdtemp(join(tmpdir(), "ops-project-routing-"));
process.env.KANBAN_DATA_DIR = join(root, "data");


process.env.PASEO_HOME = join(root, "paseo");
process.env.KANBAN_PASEO_CONFIG = join(process.env.PASEO_HOME!, "config.json");
delete process.env.AFC_LEGACY_DATA_DIR;
const { kanbanConfigPath } = await import("../paths");
const { afcLeaderId, productionDailyDeps, runDailyOnce, summaryLeaderId } = await import("../doctor-daily");
const { clearKanbanSourceMemo } = await import("../kanban-source");
const { deliverEarlyResetNotices, EARLY_RESET_FILE, setEarlyResetNotify } = await import("../early-reset");
const { deliver } = await import("../reset-coupons-notify");
const { notifyDaemonCrash } = await import("../daemon-watch");
const { crashNotifyTargets } = await import("../../../shared/fleet/daemon-crash");
await mkdir(join(process.env.KANBAN_DATA_DIR!, "fleet"), { recursive: true });
await mkdir(join(process.env.KANBAN_DATA_DIR, "exports"), { recursive: true });
after(() => rm(root, { recursive: true, force: true }));
const legacy = "00000000-0000-4000-8000-000000000001";
const configured = "00000000-0000-4000-8000-000000000002";
const now = Date.parse("2030-01-02T01:00:00Z");
const table = { supervisors: { "paseo-fleet": legacy, "Demo operations": configured } };
const write = (path: string, value: unknown) => writeFile(path, JSON.stringify(value));
const cases = [{ config: {}, expected: legacy }, { config: { opsProject: " Demo operations " }, expected: configured },
  { config: { opsProject: 42 }, expected: legacy }];

test("coupon use notices read the operations project at delivery time and preserve broadcasts", async () => {
  await write(kanbanConfigPath(), table);
  for (const { config, expected } of cases) {
    await write(join(join(process.env.KANBAN_DATA_DIR!, "fleet")!, "afc.config.json"), config);
    const sent: { id: string; text: string }[] = [];
    const result = await deliver([
      { who: "afc", text: "Demo coupon use", legacy: "use", keys: ["demo-use"] },
      { who: "all", text: "Demo coupon broadcast", legacy: "announce" },
    ], async (id, text) => { sent.push({ id, text }); });
    assert.deepEqual(sent, [
      { id: expected, text: "Demo coupon use" },
      { id: legacy, text: "Demo coupon broadcast" },
      { id: configured, text: "Demo coupon broadcast" },
    ]);
    assert.deepEqual(result, { use: true, announce: true, keys: ["demo-use"] });
  }
  await write(join(join(process.env.KANBAN_DATA_DIR!, "fleet")!, "afc.config.json"), { opsProject: "Demo unregistered" });
  const sent: string[] = [];
  const result = await deliver([{ who: "afc", text: "Demo use", legacy: "use", keys: ["demo-use"] }],
    async id => { sent.push(id); });
  assert.deepEqual(sent, []);
  assert.equal(result.use, false);
  assert.deepEqual(result.keys, []);
});

test("daemon crash delivery reads the operations project and still notifies the board leader", async () => {
  const boardLeader = "00000000-0000-4000-8000-000000000003";
  await write(kanbanConfigPath(), { ...table, supervisorAgentId: boardLeader });
  for (const { config, expected } of cases) {
    await write(join(join(process.env.KANBAN_DATA_DIR!, "fleet")!, "afc.config.json"), config);
    const sent: { id: string; text: string }[] = [];
    await notifyDaemonCrash("Demo daemon crash", async (id, text) => { sent.push({ id, text }); });
    assert.deepEqual(sent, [
      { id: expected, text: "Demo daemon crash" },
      { id: boardLeader, text: "Demo daemon crash" },
    ]);
  }
  await write(join(join(process.env.KANBAN_DATA_DIR!, "fleet")!, "afc.config.json"), { opsProject: "Demo unregistered" });
  const sent: string[] = [];
  await notifyDaemonCrash("Demo daemon crash", async id => { sent.push(id); });
  assert.deepEqual(sent, [boardLeader]);
  assert.deepEqual(crashNotifyTargets({ ...table, supervisorAgentId: configured }, "Demo operations"), [configured]);
  assert.deepEqual(crashNotifyTargets({ supervisors: [] }, "Demo operations"), []);
});

test("coupon and crash delivery match project keys case-insensitively with exact keys taking priority", async () => {
  const configPath = join(join(process.env.KANBAN_DATA_DIR!, "fleet")!, "afc.config.json");
  await write(configPath, { opsProject: "Demo operations" });
  for (const supervisors of [
    { "DEMO OPERATIONS": configured, "paseo-fleet": legacy },
    { "DEMO OPERATIONS": legacy, "Demo operations": configured },
  ]) {
    await write(kanbanConfigPath(), { supervisors, supervisorAgentId: legacy });
    const coupons: string[] = [];
    const result = await deliver([{ who: "afc", text: "Demo coupon use", legacy: "use", keys: ["demo-use"] }],
      async id => { coupons.push(id); });
    assert.deepEqual(coupons, [configured]);
    assert.equal(result.use, true);
    assert.deepEqual(result.keys, ["demo-use"]);
    const crashes: string[] = [];
    await notifyDaemonCrash("Demo daemon crash", async id => { crashes.push(id); });
    assert.deepEqual(crashes, [configured, legacy]);
  }
  assert.deepEqual(crashNotifyTargets({ supervisors: { "DEMO OPERATIONS": configured }, supervisorAgentId: configured },
    "Demo operations"), [configured]);
  await write(kanbanConfigPath(), { supervisors: { "DEMO OPERATIONS": "short", demo: configured, other: configured } });
  const sent: string[] = [];
  const result = await deliver([
    { who: "afc", text: "Demo coupon use", legacy: "use", keys: ["demo-use"] },
    { who: "all", text: "Demo coupon broadcast", legacy: "announce" },
  ], async id => { sent.push(id); });
  assert.deepEqual(sent, [configured], "Only the broadcast goes out; short ids are rejected and duplicate ids are skipped");
  assert.deepEqual(result, { use: false, announce: true, keys: [] });
});

test("early-reset delivery reads the configured supervisors entry and marks only successful sends", async () => {
  await write(kanbanConfigPath(), table);
  for (const { config, expected } of cases) {
    await write(join(join(process.env.KANBAN_DATA_DIR!, "fleet")!, "afc.config.json"), config);
    await write(EARLY_RESET_FILE, { last: {}, events: [{ pool: "demo", at: new Date(now).toISOString(),
      detectedAt: new Date(now).toISOString(), beforePct: 80, afterPct: 0,
      beforeResetsAt: "2030-01-05T01:00:00Z", afterResetsAt: "2030-01-09T01:00:00Z", couponCount: null, notifiedAt: null }] });
    const sent: string[] = [];
    setEarlyResetNotify(async id => { sent.push(id); });
    assert.equal(await deliverEarlyResetNotices(now), 1);
    assert.deepEqual(sent, [expected]);
    assert.equal(await deliverEarlyResetNotices(now), 0);
    assert.equal(JSON.parse(await readFile(EARLY_RESET_FILE, "utf8")).events[0].notifiedAt, new Date(now).toISOString());
  }
});

test("daily health delivery uses the configured project in supervisors and in board summaries", async () => {
  await write(kanbanConfigPath(), table);
  await write(join(process.env.KANBAN_DATA_DIR!, "exports/kanban.json"), VALID.kanban);
  const summary = { ...VALID.boardSummary, projects: [
    { name: "paseo-fleet", code: "LEGACY", leaderAgentId: legacy, root: null },
    { name: "Demo operations", code: "DEMO", leaderAgentId: configured, root: null },
  ] };
  for (const { config, expected } of cases) {
    await write(join(join(process.env.KANBAN_DATA_DIR!, "fleet")!, "afc.config.json"), config);
    assert.equal(afcLeaderId(table), expected);
    assert.equal(summaryLeaderId(summary), expected);
    // No summary project: the production dependency falls back to supervisors.
    await write(join(process.env.KANBAN_DATA_DIR!, "exports/board-summary.json"), { ...summary, projects: [] });
    clearKanbanSourceMemo();
    const deps = productionDailyDeps();
    assert.equal(await deps.leaderId(), expected);
    const sent: string[] = [];
    let state = emptyDailyState();
    const report = { at: new Date(now).toISOString(), worst: "red", counts: {}, items: [{ id: "demo", title: "Demo",
      status: "red", summary: "Demo setup needed", findings: [{ key: "demo", status: "red", text: "Demo setup needed" }] }] } as DoctorReport;
    assert.equal(await runDailyOnce({ ...deps, now: () => now, run: async () => report,
      loadState: async () => state, saveState: async next => { state = next; }, appendHistory: async () => {},
      notify: async id => { sent.push(id); } }), true);
    assert.deepEqual(sent, [expected]);
    await write(join(process.env.KANBAN_DATA_DIR!, "exports/board-summary.json"), summary);
    clearKanbanSourceMemo();
    assert.equal(await deps.leaderId(), expected);
  }
  await write(join(join(process.env.KANBAN_DATA_DIR!, "fleet")!, "afc.config.json"), { opsProject: "Demo operations" });
  assert.equal(afcLeaderId({ supervisors: { "DEMO OPERATIONS": configured } }), configured);
  assert.equal(afcLeaderId({ supervisors: [] }), null);
  const noLeader = { ...summary, projects: [{ ...summary.projects[1], leaderAgentId: null }] };
  await write(join(process.env.KANBAN_DATA_DIR!, "exports/board-summary.json"), noLeader);
  clearKanbanSourceMemo();
  assert.equal(await productionDailyDeps().leaderId(), null, "An explicitly unregistered summary leader must not use a stale registration");
});
