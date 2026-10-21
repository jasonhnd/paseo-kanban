import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setLanguage } from "../../../shared/fleet/i18n";
import { alertsFromState, inspectCompatPlugin, normalizeState, readCompatAlerts, reconcileCompatState, runUpgradeCheck, type CompatPlugin, type CompatState, type PluginCompatResult } from "../upgrade-check";

setLanguage("en");
const at = "2026-01-02T00:00:00Z";
const plugin: CompatPlugin = { id: "demo", label: "Demo", dir: "/demo/plugin", cwdMatch: "demo", project: "demo" };
const result = (status: PluginCompatResult["status"] = "pass") => ({ id: "demo", label: "Demo", status, conclusion: "Demo result", at, supervisorId: null, notified: false, identity: "install-1" });
const snapshot = (status: PluginCompatResult["status"] = "pass"): CompatState => ({ version: "0.12.0", recordedAt: at, checkedAt: at, results: [result(status)] });

function harness(initial: CompatState | null = snapshot()) {
  let state = initial;
  const writes: CompatState[] = [];
  const runs: string[] = [];
  const notices: string[] = [];
  const inspection = { identity: "install-1" as string | null, hasCompatScript: true as boolean | null };
  const deps = {
    readState: async () => state,
    writeState: async (value: CompatState) => { state = value; writes.push(value); },
    currentVersion: async () => "0.12.0",
    plugins: [plugin],
    inspectPlugin: async (_dir: string) => inspection,
    runCompat: async (dir: string) => { runs.push(dir); return { ok: true, timedOut: false, output: "passed" }; },
    listAgents: async () => [],
    readSupervisors: async () => null,
    send: async (_id: string, text: string) => { notices.push(text); },
    now: () => "2026-01-02T01:00:00Z",
  };
  return { deps, inspection, runs, notices, writes };
}

test("upgrade alerts distinguish pass, fail and unverified missing coverage", () => {
  assert.deepEqual(alertsFromState(snapshot("pass")), []);
  assert.equal(alertsFromState(snapshot("fail"))[0]?.level, "red");
  const missing = alertsFromState(snapshot("missing"));
  assert.equal(missing[0]?.level, "info");
  assert.match(missing[0]!.text, /unverified/i);
});

test("unknown persisted coverage is retained as unverified instead of silently discarded", () => {
  const state = normalizeState({ ...snapshot(), results: [{ ...result(), status: "future-status" }] });
  assert.equal(state?.results.length, 1);
  const alerts = alertsFromState(state);
  assert.equal(alerts[0]?.level, "info");
  assert.match(alerts[0]!.text, /unverified/i);
});

test("a stale pass warns, and a stale failure remains red", () => {
  for (const status of ["pass", "fail"] as const) {
    const state = { ...snapshot(status), results: [{ ...result(status), stale: true }] };
    const alerts = alertsFromState(state);
    assert.equal(alerts[0]?.level, status === "fail" ? "red" : "info");
    assert.match(alerts.map(row => row.text).join(" "), /stale|unverified/i);
  }
});

test("unchanged version and installation reuse the snapshot without executing checks", async () => {
  const h = harness();
  const outcome = await runUpgradeCheck(h.deps, { force: false });
  assert.equal(outcome.ran, false);
  assert.deepEqual(h.runs, []);
  assert.deepEqual(h.writes, []);
});

test("plugin rename at an unchanged host version replaces the old snapshot entry", async () => {
  const h = harness();
  h.deps.plugins = [{ ...plugin, id: "renamed", label: "Renamed" }];
  const outcome = await runUpgradeCheck(h.deps, { force: false });
  assert.equal(outcome.ran, true);
  assert.deepEqual(outcome.state?.results.map(row => row.id), ["renamed"]);
  assert.deepEqual(h.runs, [plugin.dir]);
  assert.equal(h.writes[0]?.results[0]?.status, "pending");
});

test("replacement or changed check identity rechecks only the affected plugin", async () => {
  const initial = snapshot();
  initial.results.push({ ...result(), id: "other" });
  const h = harness(initial);
  h.deps.plugins.push({ ...plugin, id: "other", label: "Other", dir: "/demo/other" });
  h.deps.inspectPlugin = async dir => ({ identity: dir === plugin.dir ? "install-2" : "install-1", hasCompatScript: true });
  const outcome = await runUpgradeCheck(h.deps, { force: false });
  assert.equal(outcome.ran, true);
  assert.deepEqual(h.runs, [plugin.dir]);
  assert.equal(h.writes[0]?.results[0]?.stale, true);
  assert.equal(outcome.state?.results[0]?.identity, "install-2");
});

test("snapshot readers reconcile the host version and installation before rendering alerts", async () => {
  for (const status of ["pass", "fail", "missing"] as const) {
    for (const context of [
      { version: "0.13.0", plugins: [{ ...plugin, identity: "install-1", hasCompatScript: true }] },
      { version: "0.12.0", plugins: [{ ...plugin, identity: "install-2", hasCompatScript: true }] },
      { version: null, plugins: null },
    ]) {
      const state = reconcileCompatState(snapshot(status), context);
      assert.equal(state.results[0]?.stale, true);
      const alerts = await readCompatAlerts({ readState: async () => snapshot(status), context: async () => context });
      assert.equal(alerts[0]?.level, status === "fail" ? "red" : "info");
      assert.match(alerts[0]!.text, /stale|unverified/i);
    }
  }
});

test("snapshot readers replace renamed plugins with pending coverage", async () => {
  const context = { version: "0.12.0", plugins: [{ ...plugin, id: "renamed", label: "Renamed", identity: "install-1", hasCompatScript: true }] };
  const alerts = await readCompatAlerts({ readState: async () => snapshot(), context: async () => context });
  assert.equal(alerts.length, 1);
  assert.match(alerts[0]!.text, /Renamed.*unverified.*pending/i);
});

test("renaming the same installation retains executed failure evidence in upgrade alerts", async () => {
  const context = { version: "0.12.0", plugins: [{ ...plugin, id: "renamed", label: "Renamed", identity: "install-1", hasCompatScript: true }] };
  for (const status of ["fail", "timeout"] as const) {
    const state = reconcileCompatState(snapshot(status), context);
    assert.deepEqual(state.results, [{ ...result(status), id: "renamed", label: "Renamed", stale: true }]);
    const alerts = await readCompatAlerts({ readState: async () => snapshot(status), context: async () => context });
    assert.equal(alerts[0]?.level, "red");
    assert.match(alerts[0]!.text, /Renamed.*Demo result.*stale/i);
  }
});

test("renamed failures stay red before a recheck and are replaced only by its result", async () => {
  for (const status of ["fail", "timeout"] as const) {
    const h = harness(snapshot(status));
    h.deps.plugins = [{ ...plugin, id: "renamed", label: "Renamed" }];
    let executed = false;
    let pending: CompatState | undefined;
    h.deps.runCompat = async () => {
      executed = true;
      pending = h.writes.at(-1);
      return { ok: true, timedOut: false, output: "current check passed" };
    };
    const outcome = await runUpgradeCheck(h.deps, { force: false });
    assert.equal(executed, true);
    assert.equal(pending?.results[0]?.id, "renamed");
    assert.equal(pending?.results[0]?.status, status);
    assert.equal(pending?.results[0]?.stale, true);
    assert.equal(alertsFromState(pending ?? null)[0]?.level, "red");
    assert.deepEqual(outcome.state?.results.map(row => [row.id, row.status, row.stale]), [["renamed", "pass", undefined]]);
    assert.deepEqual(outcome.alerts, []);
  }
});

test("renamed failures remain visible when the current check cannot run", async () => {
  const h = harness(snapshot("fail"));
  h.deps.plugins = [{ ...plugin, id: "renamed", label: "Renamed" }];
  h.inspection.hasCompatScript = null;
  const outcome = await runUpgradeCheck(h.deps, { force: false });
  assert.equal(outcome.state?.results[0]?.status, "fail");
  assert.equal(outcome.state?.results[0]?.stale, true);
  assert.equal(outcome.alerts[0]?.level, "red");
  assert.deepEqual(h.runs, []);
});

test("a renamed plugin cannot inherit a failure from a different or unknown installation", () => {
  for (const identity of ["install-2", null]) {
    const context = { version: "0.12.0", plugins: [{ ...plugin, id: "renamed", label: "Renamed", identity, hasCompatScript: true }] };
    assert.equal(reconcileCompatState(snapshot("fail"), context).results[0]?.status, "pending");
  }
});

test("removing a failed check cannot replace its evidence with missing coverage", async () => {
  const h = harness(snapshot("fail"));
  h.inspection.identity = "install-2";
  h.inspection.hasCompatScript = false;
  const outcome = await runUpgradeCheck(h.deps, { force: false });
  assert.equal(outcome.state?.results[0]?.status, "fail");
  assert.equal(outcome.state?.results[0]?.stale, true);
  assert.equal(outcome.alerts[0]?.level, "red");
  assert.deepEqual(h.runs, []);
});

test("an unreadable inventory retains failures and cannot reuse passes", async () => {
  for (const status of ["pass", "fail"] as const) {
    const h = harness(snapshot(status));
    const outcome = await runUpgradeCheck({ ...h.deps, plugins: null }, { force: false });
    assert.equal(outcome.state?.results[0]?.stale, true);
    assert.equal(outcome.alerts[0]?.level, status === "fail" ? "red" : "info");
    assert.deepEqual(h.runs, []);
  }
});

test("context inspection errors do not hide persisted failures", async context => {
  context.mock.method(console, "error", () => {});
  const alerts = await readCompatAlerts({
    readState: async () => snapshot("fail"),
    context: async () => { throw new Error("Demo inspection error"); },
  });
  assert.equal(alerts[0]?.level, "red");
  assert.match(alerts[0]!.text, /stale/i);
});

test("real installation fingerprints detect package/check edits, directory replacement and symlink retargeting", async () => {
  const root = await mkdtemp(join(tmpdir(), "compat-identity-"));
  try {
    const dir = join(root, "plugin");
    await mkdir(dir);
    const pkg = { name: "demo-plugin", version: "1.0.0", scripts: { compat: "node check.mjs" } };
    await writeFile(join(dir, "package.json"), JSON.stringify(pkg));
    const first = await inspectCompatPlugin(dir);
    assert.equal(first.hasCompatScript, true);
    assert.deepEqual(await inspectCompatPlugin(dir), first);
    await writeFile(join(dir, "package.json"), JSON.stringify({ ...pkg, version: "2.0.0" }));
    const updated = await inspectCompatPlugin(dir);
    assert.notEqual(updated.identity, first.identity);
    await writeFile(join(dir, "package.json"), JSON.stringify({ ...pkg, scripts: { compat: "node next.mjs" } }));
    const scriptChanged = await inspectCompatPlugin(dir);
    assert.notEqual(scriptChanged.identity, updated.identity);
    await rename(dir, join(root, "old"));
    await mkdir(dir);
    await writeFile(join(dir, "package.json"), JSON.stringify(pkg));
    assert.notEqual((await inspectCompatPlugin(dir)).identity, first.identity);
    const link = join(root, "current");
    await symlink(dir, link, "dir");
    const linked = await inspectCompatPlugin(link);
    await rm(link);
    await symlink(join(root, "old"), link, "dir");
    assert.notEqual((await inspectCompatPlugin(link)).identity, linked.identity);
    await writeFile(join(dir, "package.json"), JSON.stringify({ scripts: { compat: "   " } }));
    assert.equal((await inspectCompatPlugin(dir)).hasCompatScript, false);
    await writeFile(join(dir, "package.json"), "null");
    await assert.rejects(inspectCompatPlugin(dir));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("removed plugins disappear even when the host version is unchanged", async () => {
  const h = harness();
  h.deps.plugins = [];
  const outcome = await runUpgradeCheck(h.deps, { force: false });
  assert.deepEqual(outcome.state?.results, []);
  assert.ok(h.writes.length);
  assert.deepEqual(h.runs, []);
});

test("host version mismatch executes checks and exposes stale failures while running", async () => {
  const h = harness(snapshot("fail"));
  h.deps.currentVersion = async () => "0.13.0";
  await runUpgradeCheck(h.deps, { force: false });
  assert.equal(h.writes[0]?.results[0]?.status, "fail");
  assert.equal(h.writes[0]?.results[0]?.stale, true);
  assert.equal(h.runs.length, 1);
});

test("legacy snapshots without an installation identity are rechecked", async () => {
  const old = snapshot();
  old.results = old.results.map(({ identity: _identity, ...row }) => row);
  const h = harness(old);
  assert.equal((await runUpgradeCheck(h.deps, { force: false })).ran, true);
});

test("first sight records pending coverage without running a script", async () => {
  const h = harness(null);
  const outcome = await runUpgradeCheck(h.deps, { force: false });
  assert.equal(outcome.ran, false);
  assert.equal(outcome.state?.results[0]?.status, "pending");
  assert.match(outcome.alerts[0]!.text, /unverified/i);
  assert.deepEqual(h.runs, []);
});

test("missing scripts never execute, pass, or notify; timeouts stay red", async () => {
  const h = harness();
  h.inspection.hasCompatScript = false;
  let outcome = await runUpgradeCheck(h.deps, { force: true });
  assert.equal(outcome.state?.results[0]?.status, "missing");
  assert.deepEqual(h.runs, []);
  assert.deepEqual(h.notices, []);
  h.inspection.hasCompatScript = true;
  h.deps.runCompat = async () => ({ ok: true, timedOut: true, output: "" });
  outcome = await runUpgradeCheck(h.deps, { force: true });
  assert.equal(outcome.state?.results[0]?.status, "fail");
  assert.equal(outcome.alerts[0]?.level, "red");
});

test("unreadable identity cannot reuse a pass or execute an unknown script", async () => {
  const h = harness();
  h.inspection.identity = null;
  h.inspection.hasCompatScript = null;
  const outcome = await runUpgradeCheck(h.deps, { force: false });
  assert.deepEqual(h.runs, []);
  assert.equal(outcome.state?.results[0]?.stale, true);
  assert.match(outcome.alerts[0]!.text, /unverified/i);
});
