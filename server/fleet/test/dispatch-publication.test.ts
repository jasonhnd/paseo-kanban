// Publication safety uses only isolated demo config and data directories.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { applyDispatchMatrix, type DispatchMatrix, type DispatchProfile } from "../../../shared/fleet/dispatch";
import { PROFILE_SLOTS } from "../../../shared/fleet/dispatch-slots";

const home = mkdtempSync(join(tmpdir(), "afc-dispatch-publication-"));
const data = join(join(home, "data"), "fleet");
const plugin = join(home, "plugin");
const config = join(home, ".paseo", "config.json");
const exported = join(data, "..", "exports", "fleet", "dispatch-matrix.json");
const saved = { ...process.env };
const now = Date.parse("2026-10-08T00:00:00.000Z");
const base: DispatchMatrix = {
  version: 1, defaultTier: "L2", downgradeWhenTight: [],
  roles: { executor: { L2: [
    { profile: "executor", effort: "medium" },
    { profile: "executor.sonnet", effort: "high" },
  ] } },
};
const profiles = [
  { name: "Demo executor", role: "executor", provider: "codex", dispatchId: "executor" },
  { name: "Demo sonnet", role: "candidate", candidateFor: "executor", provider: "claude", dispatchId: "executor.sonnet" },
];
let dispatch: typeof import("../dispatch");
before(async () => {
  for (const dir of [data, plugin, join(home, ".paseo")]) mkdirSync(dir, { recursive: true });
  Object.assign(process.env, { HOME: home, PASEO_HOME: join(home, ".paseo"), KANBAN_PASEO_CONFIG: join(home, ".paseo", "config.json"), KANBAN_DATA_DIR: join(data, ".."), KANBAN_HOME: plugin,  AFC_LANGUAGE: "zh-CN" });

  mkdirSync(join(plugin, "shared", "fleet"), { recursive: true });
  writeFileSync(join(plugin, "shared/fleet/default-dispatch.example.json"), JSON.stringify(base));
  dispatch = await import("../dispatch");
});
after(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
  rmSync(home, { recursive: true, force: true });
});
const configure = (rows: typeof profiles) => writeFileSync(config, JSON.stringify({ daemon: { agentProfiles: rows } }));

test("resolved publication matches legacy names; unreadable or partial config preserves both files", async () => {
  configure(profiles);
  await dispatch.publishDispatch({}, now, []);
  const expected = [{ profile: "Demo executor", effort: "medium" }, { profile: "Demo sonnet", effort: "high" }];
  const output = () => JSON.parse(readFileSync(exported, "utf8"));
  assert.deepEqual(output().roles.executor.L2, expected);
  const oldExport = readFileSync(exported);
  const oldLegacy = readFileSync(dispatch.DISPATCH_MATRIX);
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.join(" ")); };
  try {
    for (const missing of [false, true]) {
      if (missing) rmSync(config); else writeFileSync(config, "{");
      await assert.rejects(dispatch.publishDispatch({}, now + 1000, []), /unresolved/);
      assert.deepEqual(readFileSync(exported), oldExport);
      assert.deepEqual(readFileSync(dispatch.DISPATCH_MATRIX), oldLegacy);
    }
    configure(profiles.slice(0, 1));
    await assert.rejects(dispatch.publishDispatch({}, now + 2000, []), /unresolved/);
    assert.deepEqual(readFileSync(exported), oldExport);
    assert.deepEqual(readFileSync(dispatch.DISPATCH_MATRIX), oldLegacy);
    assert.match(warnings.at(-1)!, /Warning:.*executor.sonnet/);
    assert.equal(/[^\u0000-\u007F]/.test(warnings.join("")), false);
    assert.match(warnings[0], /executor, executor.sonnet/);

    // First publication with a partial config contains only resolved entries.
    rmSync(exported);
    rmSync(dispatch.DISPATCH_MATRIX);
    await assert.rejects(dispatch.publishDispatch({}, now + 3000, []), /unresolved/);
    assert.deepEqual(output().roles.executor.L2, expected.slice(0, 1));
    assert.equal(JSON.stringify(output()).includes("executor.sonnet"), false);
    assert.deepEqual(JSON.parse(readFileSync(dispatch.DISPATCH_MATRIX, "utf8")).roles.executor.L2, expected.slice(0, 1));

    // First publication without config cannot leak any slot.
    rmSync(config);
    rmSync(exported);
    rmSync(dispatch.DISPATCH_MATRIX);
    await assert.rejects(dispatch.publishDispatch({}, now + 4000, []), /unresolved/);
    assert.deepEqual(output().roles.executor.L2, []);
    configure(profiles);
    await dispatch.publishDispatch({}, now + 5000, []);
    assert.deepEqual(output().roles.executor.L2, expected);
  } finally {
    console.warn = warn;
  }
});

test("every shipped slot matches the demo name and effort in a named legacy base", () => {
  const shipped = JSON.parse(readFileSync(new URL("../../../shared/fleet/default-dispatch.example.json", import.meta.url), "utf8")) as DispatchMatrix;
  const demo: DispatchProfile[] = Object.keys(PROFILE_SLOTS).map((slot) => ({ name: `Demo ${slot}`, provider: "demo", notes: "", dispatchId: slot }));
  // Model the old base with names, preserving list order and effort.
  const legacy = JSON.parse(JSON.stringify(shipped), (key, value) => key === "profile" ? `Demo ${value}` : value) as DispatchMatrix;
  const options = { profiles: demo, knownNames: new Set(demo.map((row) => row.name)), pools: null, generatedAt: new Date(now).toISOString() };
  const unresolved: string[] = [];
  const resolved = applyDispatchMatrix(shipped, { ...options, onUnresolvedSlot: (slot) => unresolved.push(slot) });
  assert.deepEqual(unresolved, []);
  assert.deepEqual(resolved, applyDispatchMatrix(legacy, options));
});
