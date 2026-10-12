import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_LEADER_THRESHOLDS, leaderThresholds } from "../../../shared/fleet/leader-usage";
import { contextLamp, buildSupervisorRows } from "../../../shared/fleet/supervisor-shift";
import { initializeSettings, readSettings, writeSettings } from "../settings";
import { readLeaderThresholds } from "../adapters/config";

test("context thresholds default to 500k reminder and 750k warning, with strict boundaries", () => {
  assert.deepEqual(leaderThresholds({}), DEFAULT_LEADER_THRESHOLDS);
  for (const [tokens, lamp] of [[null, "unknown"], [-1, "unknown"], [NaN, "unknown"], [500000, "green"], [500001, "yellow"], [750000, "yellow"], [750001, "red"]] as const) {
    assert.equal(contextLamp(tokens), lamp);
  }
  assert.deepEqual(leaderThresholds({ leaderUsage: { reminderTokens: 200, warningTokens: 100 } }), DEFAULT_LEADER_THRESHOLDS);
});

test("thresholds use revision writes, survive unrelated edits, and control homepage rows", async () => {
  const dir = await mkdtemp(join(tmpdir(), "leader-usage-"));
  try {
    initializeSettings(dir, fileURLToPath(new URL("../../../examples/", import.meta.url)));
    assert.deepEqual(readLeaderThresholds(dir), DEFAULT_LEADER_THRESHOLDS);
    const initial = await readSettings("config", dir);
    const thresholds = { reminderTokens: 100, warningTokens: 200 };
    const saved = await writeSettings({ file: "config", revision: initial.revision, document: { ...initial.document, leaderUsage: thresholds } }, dir);
    assert.equal(saved.status, "saved");
    assert.equal((await writeSettings({ file: "config", revision: initial.revision, document: initial.document }, dir)).status, "conflict");
    assert.deepEqual(readLeaderThresholds(dir), thresholds);
    const rows = buildSupervisorRows({ slots: ["normal", "reminder", "warning"].map(project => ({ project, code: project, agentId: project })),
      agents: [100, 101, 201].map((contextTokens, i) => ({ id: ["normal", "reminder", "warning"][i], status: "idle", createdAt: null, contextTokens, handoverPath: null, handoverPreview: null, found: true })), todayUsd: {}, now: 0, thresholds });
    assert.deepEqual(rows.map(row => row.lamp), ["green", "yellow", "red"]);
    assert.deepEqual(rows.map(row => row.highlight), [false, true, true]);
    assert.notEqual(rows[1].lampText, rows[2].lampText);
    const bytes = await readFile(join(dir, "afc.config.json"), "utf8");
    for (const leaderUsage of [{ reminderTokens: 0, warningTokens: 200 }, { reminderTokens: 100, warningTokens: 100 }, { reminderTokens: 1.5, warningTokens: 200 }]) {
      await assert.rejects(writeSettings({ file: "config", revision: saved.snapshot.revision, document: { leaderUsage } }, dir));
      assert.equal(await readFile(join(dir, "afc.config.json"), "utf8"), bytes);
    }
    await writeSettings({ file: "config", revision: saved.snapshot.revision, document: { ...saved.snapshot.document, hiddenPlans: ["demo"] } }, dir);
    assert.deepEqual(readLeaderThresholds(dir), thresholds);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
