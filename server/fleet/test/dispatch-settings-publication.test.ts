import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const home = mkdtempSync(join(tmpdir(), "dispatch-settings-publication-"));
const data = join(join(home, "data"), "fleet");
const saved = { ...process.env };
let dispatch: typeof import("../dispatch");
let settings: typeof import("../settings-dispatch");
before(async () => {
  const plugin = resolve(import.meta.dirname, "../../..");
  for (const dir of [data, join(home, "paseo"), join(home, ".local/bin")]) mkdirSync(dir, { recursive: true });
  Object.assign(process.env, { HOME: home, PASEO_HOME: join(home, "paseo"), KANBAN_DATA_DIR: join(data, ".."),   AFC_HOME: plugin });
  process.env.KANBAN_PASEO_CONFIG = join(process.env.PASEO_HOME!, "config.json");
  writeFileSync(join(home, ".local/bin/paseo"), `#!/usr/bin/env node
if (process.argv[2] !== "provider" || process.argv[3] !== "models" || !process.argv.includes("--thinking")) process.exit(1);
console.log(JSON.stringify(["demo-model","demo-exec-model","demo-review-model"].map(id=>({id,thinkingOptionIds:["low","medium","high","xhigh"]}))));
`, { mode: 0o700 });
  const { PROFILE_SLOTS } = await import("../../../shared/fleet/dispatch-slots");
  writeFileSync(join(home, "paseo/config.json"), JSON.stringify({ daemon: { agentProfiles: Object.keys(PROFILE_SLOTS).map(slot => ({ name: `Demo ${slot}`, dispatchId: slot, role: slot.split(".")[0], provider: "demo", model: slot.startsWith("reviewer") ? "demo-review-model" : slot.startsWith("executor") ? "demo-exec-model" : "demo-model", pool: slot === "reviewer.fable" ? "demo-secondary" : "demo-primary" })) } }));
  writeFileSync(join(data, "afc.config.json"), JSON.stringify({ language: "en", extension: { keep: true } }));
  writeFileSync(join(data, "plans.json"), JSON.stringify({ plans: [] }));
  writeFileSync(join(data, "pool-status.json"), JSON.stringify({ generatedAt: new Date().toISOString(), pools: {
    "demo-primary": { dispatchable: true, prefer: true }, "demo-secondary": { dispatchable: true, prefer: false, deprioritize: true },
  } }));
  dispatch = await import("../dispatch");
  settings = await import("../settings-dispatch");
});

test("saving reviewer order publishes it in legacy and contract matrices despite quota preferences", async () => {
  await dispatch.publishFromSnapshotFile();
  const before = JSON.parse(readFileSync(dispatch.DISPATCH_MATRIX, "utf8")).roles;
  const first = await settings.readSettingsWithDispatch("config");
  const result = await settings.writeSettingsWithDispatch({ file: "config", revision: first.revision,
    document: { ...first.document, dispatchOverrides: { reviewer: { L4: { "reviewer.fable": { order: 1 } } } } } });
  assert.equal(result.status, "saved");
  if (result.status !== "saved") return;
  const legacy = JSON.parse(readFileSync(dispatch.DISPATCH_MATRIX, "utf8"));
  const contract = JSON.parse(readFileSync(join(data, "..", "exports/fleet/dispatch-matrix.json"), "utf8"));
  for (const model of ["demo-exec-model", "demo-model"]) for (const matrix of [legacy, contract]) {
    assert.equal(matrix.roles.reviewer.byExecutorModel[model].L4[0].profile, "Demo reviewer.fable");
    assert.equal(matrix.roles.reviewer.byExecutorModel[model].L4[0].order, 1);
  }
  assert.deepEqual(contract.roles, legacy.roles);
  assert.equal(contract.contractVersion, "1.3.0");
  assert.deepEqual(legacy.roles.reviewer.byExecutorModel["demo-review-model"].L4, []);
  const cleared = await settings.writeSettingsWithDispatch({ file: "config", revision: result.snapshot.revision,
    document: { ...result.snapshot.document, dispatchOverrides: {} } });
  assert.equal(cleared.status, "saved");
  assert.deepEqual(JSON.parse(readFileSync(dispatch.DISPATCH_MATRIX, "utf8")).roles, before);
});
after(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
  rmSync(home, { recursive: true, force: true });
});

test("settings RPC implementation publishes saved overrides and clearing restores defaults in both exports", async () => {
  const first = await settings.readSettingsWithDispatch("config");
  assert.ok(first.dispatchRows?.length);
  assert.ok(first.dispatchRows?.find(row => row.slot === "executor")?.supportedEfforts.includes("high"));
  const dispatchOverrides = { executor: { L1: { "executor.sonnet": { effort: "high", order: 1 }, "missing.slot": { effort: "low" } } } };
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (...args) => { warnings.push(args.join(" ")); };
  try {
    const result = await settings.writeSettingsWithDispatch({ file: "config", revision: first.revision, document: { ...first.document, dispatchOverrides } });
    assert.equal(result.status, "saved");
    const read = (file: string) => JSON.parse(readFileSync(file, "utf8"));
    assert.equal(read(dispatch.DISPATCH_MATRIX).roles.executor.L1[0].profile, "Demo executor.sonnet");
    assert.equal(read(dispatch.DISPATCH_MATRIX).roles.executor.L1[0].effort, "high");
    assert.deepEqual(read(join(data, "..", "exports/fleet/dispatch-matrix.json")).roles, read(dispatch.DISPATCH_MATRIX).roles);
    assert.match(warnings[0], /missing.slot.*unresolved slot/);
    assert.equal(/[^\u0000-\u007F]/.test(warnings[0]), false);
    assert.deepEqual(result.snapshot.document.extension, { keep: true });
    const beforeConflict = readFileSync(dispatch.DISPATCH_MATRIX, "utf8");
    assert.equal((await settings.writeSettingsWithDispatch({ file: "config", revision: first.revision, document: first.document })).status, "conflict");
    assert.equal(readFileSync(dispatch.DISPATCH_MATRIX, "utf8"), beforeConflict);
    await settings.writeSettingsWithDispatch({ file: "config", revision: result.snapshot.revision, document: { ...result.snapshot.document, dispatchOverrides: {} } });
    assert.equal(read(dispatch.DISPATCH_MATRIX).roles.executor.L1[0].profile, "Demo executor.gpt-6-luna");
    assert.equal(read(dispatch.DISPATCH_MATRIX).roles.executor.L1[0].effort, "medium");
    assert.deepEqual(read(join(data, "..", "exports/fleet/dispatch-matrix.json")).roles, read(dispatch.DISPATCH_MATRIX).roles);
    await dispatch.publishFromSnapshotFile();
    assert.equal(read(dispatch.DISPATCH_MATRIX).roles.executor.L1.find((row: { profile: string }) => row.profile === "Demo executor.sonnet").effort, "low");
  } finally { console.warn = warn; }
});
