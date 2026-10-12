import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import { cockpitStateDirs, cockpitStateFile, cockpitStateTarget } from "../server/afc-sources";
import { findDecision } from "../server/decisions";
import { isProjectPaused } from "../server/paused";
import { assertDecisionDecided } from "../server/wait-user";
const root = mkdtempSync(join(tmpdir(), "unified-state-"));
const saved = { ...process.env };
process.env.KANBAN_DATA_DIR = join(root, "board");
for (const key of ["AFC_DATA_DIR", "AFC_LEGACY_DATA_DIR", "ROLES_STATE_DIR"]) delete process.env[key];
const fleet = join(process.env.KANBAN_DATA_DIR, "fleet");
const outside = join(root, "outside");
const info = join(process.env.KANBAN_DATA_DIR, "exports", "fleet", "cockpit.json");
for (const path of [fleet, outside, join(info, "..")]) mkdirSync(path, { recursive: true });
const state = (dir: string) => { writeFileSync(join(dir, "decisions.json"), '[{"id":"demo-done","status":"done"}]'); writeFileSync(join(dir, "paused-projects.json"), '[{"project":"demo"}]'); };
beforeEach(() => { for (const name of ["decisions.json", "paused-projects.json"]) rmSync(join(fleet, name), { force: true }); rmSync(info, { recursive: true, force: true }); });
after(() => { for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); rmSync(root, { recursive: true, force: true }); });
for (const body of [null, "{broken", JSON.stringify({ dataDir: outside }), JSON.stringify({ schema: "fleet-quota/v1", producer: "agent-fleet-cockpit", producerVersion: "0", generatedAt: "2020-01-01T00:00:00Z", ttlSeconds: 1, dataDir: outside, cli: null, features: [] })]) {
  test(`declared state paths never widen the fresh root (${body === null ? "absent" : body === "{broken" ? "corrupt" : "external"})`, () => {
    state(outside); if (body) writeFileSync(info, body);
    assert.deepEqual(cockpitStateDirs(), [fleet]); assert.equal(cockpitStateFile("decisions.json"), null);
    assert.equal(cockpitStateTarget("decisions.json"), join(fleet, "decisions.json"));
    assert.equal(isProjectPaused("demo"), false); assert.equal(findDecision("demo-done").found, false); assert.throws(() => assertDecisionDecided("demo-done"));
    state(fleet); assert.equal(isProjectPaused("demo"), true); assert.deepEqual(findDecision("demo-done"), { found: true, status: "done", source: "cockpit" });
    assert.doesNotThrow(() => assertDecisionDecided("demo-done")); assert.equal(readFileSync(join(outside, "decisions.json"), "utf8"), '[{"id":"demo-done","status":"done"}]');
  });
}
test("all retired overrides diagnose before discovery, and traversal is refused", () => {
  for (const name of ["ROLES_STATE_DIR", "AFC_DATA_DIR", "AFC_LEGACY_DATA_DIR"]) assert.throws(() => cockpitStateDirs({ KANBAN_DATA_DIR: root, [name]: outside }), new RegExp(name));
  for (const name of ["../decisions.json", "nested/file", "nested\\file", ".."]) assert.throws(() => cockpitStateFile(name), /Invalid/);
});
test("explicit and default roots select exactly one namespace without legacy reads", () => {
  assert.deepEqual(cockpitStateDirs({ KANBAN_DATA_DIR: "~/demo" }, root), [join(root, "demo", "fleet")]);
  assert.deepEqual(cockpitStateDirs({ PASEO_HOME: join(root, "host") }, root), [join(root, "host", "plugin-data", "paseo-kanban", "fleet")]);
});
