import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, beforeEach, test } from "node:test";
import { createPolicyChannel, injectPolicyChannel, policyDigest, policySnapshotPath, publishPolicySnapshot, readPersistedPolicy, readPolicy, validatePolicySnapshot } from "../server/application/policy-snapshot";
import { PoolStatus, DispatchMatrix, type Envelope } from "../server/contract";
import { envelopeFor } from "../server/contract";
import { loadDispatchMatrix } from "../server/matrix";
import { readPoolSnapshot } from "../server/pools";
import { closeDb } from "../server/db";

const root = mkdtempSync(join(tmpdir(), "policy-snapshot-"));
const saved = { ...process.env };
process.env.KANBAN_DATA_DIR = root;
process.env.PASEO_HOME = join(root, "host");
process.env.KANBAN_PASEO_CONFIG = join(root, "host", "config.json");
for (const name of ["AFC_DATA_DIR", "ROLES_STATE_DIR", "AFC_LEGACY_DATA_DIR", "KANBAN_POOL_STATUS", "KANBAN_DISPATCH_MATRIX"]) delete process.env[name];
mkdirSync(join(root, "host")); mkdirSync(join(root, "fleet"));
const NOW = Date.parse("2030-01-01T00:00:00Z");
function payload(now = NOW) {
  const date = new Date(now);
  return {
    policyDigest: policyDigest(),
    pools: PoolStatus.parse({ ...envelopeFor("poolStatus", "0", date), quotaConfigured: true,
      pools: { demo: { dispatchable: true, deprioritize: false, prefer: true, usedPct: 15, resetsAt: null, onlyRoles: ["reviewer"], reason: null, quotaProtection: "pause" as const, readingExpiresAt: new Date(now + 7 * 60_000).toISOString() } }, priority: null }),
    matrix: DispatchMatrix.parse({ ...envelopeFor("dispatchMatrix", "0", date), version: 1, defaultTier: "L2", downgradeWhenTight: ["L1"],
      roles: { reviewer: { byExecutorModel: { "demo-a": { L2: [{ profile: "Reviewer", effort: "high" }] } } } }, priority: null }),
  };
}
beforeEach(() => {
  closeDb();
  delete process.env.KANBAN_POOL_STATUS;
  delete process.env.KANBAN_DISPATCH_MATRIX;
  rmSync(policySnapshotPath(), { force: true });
  writeFileSync(process.env.KANBAN_PASEO_CONFIG!, JSON.stringify({ daemon: { agentProfiles: [{ name: "Executor", role: "executor", provider: "demo", model: "Demo-A", family: "shared" }] } }));
  for (const name of ["plans.json", "afc.config.json", "paused-projects.json"]) writeFileSync(join(root, "fleet", name), name === "paused-projects.json" ? "[]" : "{}");
});
after(() => { closeDb(); for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); rmSync(root, { recursive: true, force: true }); });

test("absent and malformed policy fails closed despite green compatibility files", () => {
  const input = payload();
  process.env.KANBAN_POOL_STATUS = join(root, "legacy-pools.json");
  process.env.KANBAN_DISPATCH_MATRIX = join(root, "legacy-matrix.json");
  writeFileSync(process.env.KANBAN_POOL_STATUS, JSON.stringify(input.pools));
  writeFileSync(process.env.KANBAN_DISPATCH_MATRIX, JSON.stringify(input.matrix));
  assert.equal(readPersistedPolicy(NOW).state, "absent");
  assert.equal(readPoolSnapshot(NOW).dispatchable("demo"), false);
  assert.equal(loadDispatchMatrix(NOW).state, "invalid");
  writeFileSync(policySnapshotPath(), "{broken");
  assert.equal(readPersistedPolicy(NOW).state, "invalid");
  assert.equal(readPoolSnapshot(NOW).dispatchable("demo"), false);
});
test("publication is immutable, monotonic and available to an independent Node CLI process", () => {
  const input = payload(); const first = publishPolicySnapshot(input, input.policyDigest);
  assert.equal(first.revision, 1); assert.ok(Object.isFrozen(first)); assert.ok(Object.isFrozen(first.pools.pools.demo));
  assert.throws(() => { first.pools.pools.demo.dispatchable = false; }, TypeError);
  const second = publishPolicySnapshot(payload(NOW + 1), input.policyDigest); assert.equal(second.revision, 2);
  const module = resolve("server/application/policy-snapshot.ts");
  const out = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `const {readPersistedPolicy}=await import(${JSON.stringify(module)}); console.log(JSON.stringify(readPersistedPolicy(${NOW + 1})));`], { env: process.env, encoding: "utf8" });
  assert.equal(out.status, 0, out.stderr); assert.equal(JSON.parse(out.stdout).snapshot.revision, 2);
  assert.equal(readPersistedPolicy(NOW + 1).state, "ok");
});
test("schema, future dates, digest and incompatible model branches refuse publication", () => {
  const input = payload(), valid = { ...input, schema: "paseo-policy/v1", revision: 1 };
  for (const raw of [{ ...valid, revision: 0 }, { ...valid, policyDigest: "0".repeat(64) }, { ...valid, matrix: { ...valid.matrix, roles: { reviewer: { byExecutorModel: null, byExecutorFamily: {} } } } }]) assert.equal(validatePolicySnapshot(raw, input.policyDigest, NOW).state, "invalid");
  assert.equal(validatePolicySnapshot(valid, input.policyDigest, NOW - 31_000).state, "invalid");
  const bad = { ...input, matrix: { ...input.matrix, generatedAt: new Date(NOW + 1).toISOString() } };
  assert.throws(() => publishPolicySnapshot(bad, input.policyDigest));
  assert.equal(readPersistedPolicy(NOW).state, "absent");
});
test("policy edits during collection reject the new revision and invalidate persisted and injected state", () => {
  const input = payload(), snapshot = publishPolicySnapshot(input, input.policyDigest);
  const channel = createPolicyChannel(); channel.accept(snapshot); const remove = injectPolicyChannel(channel);
  try {
    assert.equal(readPolicy(NOW).state, "ok");
    writeFileSync(join(root, "fleet", "paused-projects.json"), '[{"project":"demo"}]');
    assert.equal(readPolicy(NOW).state, "invalid"); assert.equal(readPersistedPolicy(NOW).state, "invalid");
    assert.throws(() => publishPolicySnapshot(input, input.policyDigest), /changed/);
    assert.equal(JSON.parse(readFileSync(policySnapshotPath(), "utf8")).revision, 1);
    assert.throws(() => channel.accept(snapshot), /regressed/);
  } finally { channel.dispose(); remove(); }
});
test("protected quota expires at seven minutes, unknown pools stop, envelope TTL and models remain separate", () => {
  const input = payload(); publishPolicySnapshot(input, input.policyDigest);
  const fresh = readPoolSnapshot(NOW); assert.equal(fresh.dispatchable("demo"), true); assert.equal(fresh.dispatchable("unknown"), false);
  assert.deepEqual(fresh.entry("demo").onlyRoles, ["reviewer"]);
  assert.equal(readPoolSnapshot(NOW + 7 * 60_000).dispatchable("demo"), false);
  const matrix = loadDispatchMatrix(NOW); assert.equal(matrix.state, "ok");
  if (matrix.state === "ok") { assert.deepEqual(Object.keys(matrix.matrix.reviewerModels!), ["demo-a"]); assert.deepEqual(matrix.matrix.reviewerFamilies, {}); }
  assert.equal(readPoolSnapshot(NOW + 2 * 60 * 60_000).dispatchable("demo"), false);
});
