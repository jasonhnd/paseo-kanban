import { strict as assert } from "node:assert";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDispatchPriority } from "../../../shared/fleet/dispatch-priority";
import { afcSettingsSchema, plansSchema } from "../../../shared/fleet/settings";
import { adapterOn, IN_USE_MARKERS } from "../adapters/config";
import { chooseDataDir, legacyStateDir } from "../paths";
import { initializeSettings, readSettings, writeSettings } from "../settings";
import { opsProject, DEFAULT_OPS_PROJECT } from "../../../shared/fleet/ops-project";
import { readOpsProject } from "../adapters/config";
async function fixture(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "settings-"));
  try { initializeSettings(dir, fileURLToPath(new URL("../../../examples/", import.meta.url))); await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
test("first run creates examples and never replaces existing files", async () => fixture(async dir => {
  const config = await readSettings("config", dir);
  assert.equal(config.document.language, "system");
  assert.equal((config.document.adapters as Record<string, boolean>)["cursor-api"], false);
  assert.equal((config.document.adapters as Record<string, boolean>)["antigravity-cli"], false);
  assert.equal(config.effectiveAdapters?.["antigravity-cli"], false);
  await writeFile(join(dir, "plans.json"), "invalid demo configuration");
  initializeSettings(dir, fileURLToPath(new URL("../../../examples/", import.meta.url)));
  assert.equal(await readFile(join(dir, "plans.json"), "utf8"), "invalid demo configuration");
}));

test("operations project defaults, validates names and refuses invalid writes without changing bytes", async () => fixture(async dir => {
  await writeFile(join(dir, "afc.config.json"), "{}");
  assert.equal(afcSettingsSchema.parse({}).opsProject, undefined);
  assert.equal(readOpsProject(dir), DEFAULT_OPS_PROJECT);
  const before = await readSettings("config", dir);
  const saved = await writeSettings({ file: "config", revision: before.revision, document: { opsProject: " Demo operations ", extension: { keep: true } } }, dir);
  assert.equal(saved.status, "saved");
  assert.equal(saved.snapshot.document.opsProject, "Demo operations");
  assert.equal(readOpsProject(dir), "Demo operations");
  const bytes = await readFile(join(dir, "afc.config.json"), "utf8");
  for (const invalid of [null, 42, false, {}, [], "", "   ", "Demo\noperations", "Demo\u0000", "\nDemo"]) {
    assert.equal(opsProject({ opsProject: invalid }), DEFAULT_OPS_PROJECT);
    await assert.rejects(writeSettings({ file: "config", revision: saved.snapshot.revision, document: { opsProject: invalid } }, dir));
    assert.equal(await readFile(join(dir, "afc.config.json"), "utf8"), bytes);
    await writeFile(join(dir, "afc.config.json"), JSON.stringify({ opsProject: invalid }));
    assert.equal(readOpsProject(dir), DEFAULT_OPS_PROJECT);
    await writeFile(join(dir, "afc.config.json"), bytes);
  }
  await writeFile(join(dir, "afc.config.json"), "invalid demo configuration");
  assert.equal(readOpsProject(dir), DEFAULT_OPS_PROJECT);
  assert.equal(opsProject(null), DEFAULT_OPS_PROJECT);
  assert.equal(opsProject([]), DEFAULT_OPS_PROJECT);
}));
test("concurrent writes conflict and preserve the winning document", async () => fixture(async dir => {
  const first = await readSettings("config", dir);
  const results = await Promise.all(["en", "zh-CN"].map(language => writeSettings({ file: "config", revision: first.revision, document: { ...first.document, language, extension: { demo: true } } }, dir)));
  assert.deepEqual(results.map(row => row.status), ["saved", "conflict"]);
  const after = await readSettings("config", dir);
  assert.equal(after.document.language, "en");
  assert.deepEqual(after.document.extension, { demo: true });
  assert.equal(results[1].snapshot.revision, after.revision);
}));
test("external edits invalidate revision and invalid writes preserve bytes", async () => fixture(async dir => {
  const before = await readSettings("plans", dir);
  const bytes = JSON.stringify({ plans: [{ id: "demo", name: "Demo pool" }] });
  await writeFile(join(dir, "plans.json"), bytes);
  assert.equal((await writeSettings({ file: "plans", revision: before.revision, document: before.document }, dir)).status, "conflict");
  const current = await readSettings("plans", dir);
  await assert.rejects(writeSettings({ file: "plans", revision: current.revision, document: { plans: [{ id: "demo" }] } }, dir));
  assert.equal(await readFile(join(dir, "plans.json"), "utf8"), bytes);
  assert.equal((await writeSettings({ file: "plans", revision: current.revision, document: { ...current.document, dispatchPriority: { order: ["demo"], until: "2099-01-01T00:00:00Z" } } }, dir)).status, "saved");
}));

test("initializing a fresh root does not import legacy adapters or plans", async () => {
  for (const [adapter, markers] of Object.entries(IN_USE_MARKERS)) {
    for (const marker of markers) {
      const home = await mkdtemp(join(tmpdir(), "legacy-settings-"));
      try {
        const dir = legacyStateDir(home);
        await mkdir(dir, { recursive: true });
        const bytes = JSON.stringify({ plans: [{ id: "demo", name: "Demo pool" }] });
        await writeFile(join(dir, "plans.json"), bytes);
        await writeFile(join(dir, marker), "{}");
        const choice = chooseDataDir({ PASEO_HOME: join(home, "demo-daemon") }, home);
        assert.equal(choice.source, "data-dir");
        assert.notEqual(choice.dir, dir);
        initializeSettings(choice.dir, fileURLToPath(new URL("../../../examples/", import.meta.url)));
        assert.equal(adapterOn(adapter as keyof typeof IN_USE_MARKERS, dir), true);
        const config = await readSettings("config", choice.dir);
        assert.equal((config.document.adapters as Record<string, unknown>)[adapter], false);
        assert.equal(config.effectiveAdapters?.[adapter as keyof typeof IN_USE_MARKERS], false);
        assert.equal(await readFile(join(dir, "plans.json"), "utf8"), bytes);
        const updated = await writeSettings({ file: "config", revision: config.revision, document: { ...config.document, hiddenPlans: ["demo"] } }, choice.dir);
        assert.equal(updated.status, "saved");
        assert.equal(adapterOn(adapter as keyof typeof IN_USE_MARKERS, dir), true);
      } finally { await rm(home, { recursive: true, force: true }); }
    }
  }
});

test("priority validation matches runtime and saves derived or unknown pools", async () => fixture(async dir => {
  const priorities = [
    { order: ["demo", "claude-fable"], until: "2099-01-01T00:00:00Z" },
    { order: ["future-pool"], until: "2099-01-01" },
    { order: ["demo", "demo"], until: "2099-01-01" },
    { order: [], until: "2099-01-01" },
    { order: [""], until: "2099-01-01" },
    { order: ["demo"], until: "invalid" },
  ];
  for (const dispatchPriority of priorities) {
    const document = { plans: [{ id: "demo", name: "Demo updated" }], dispatchPriority };
    assert.equal(plansSchema.safeParse(document).success, parseDispatchPriority(dispatchPriority) !== null);
  }
  const before = await readSettings("plans", dir);
  const document = { plans: [{ id: "demo", name: "Demo updated" }], dispatchPriority: priorities[0] };
  assert.equal((await writeSettings({ file: "plans", revision: before.revision, document }, dir)).status, "saved");
  assert.deepEqual((await readSettings("plans", dir)).document, document);
}));


test("provider policy accepts only string arrays and normalizes empty or duplicate ids", () => {
  assert.deepEqual(afcSettingsSchema.parse({ bannedProviders: [" demo-provider ", "", "  ", "demo-provider", "future-provider"] }).bannedProviders, ["demo-provider", "future-provider"]);
  for (const bannedProviders of ["demo-provider", null, [123], [false], [{}]]) {
    assert.equal(afcSettingsSchema.safeParse({ bannedProviders }).success, false);
  }
  assert.equal(afcSettingsSchema.parse({}).bannedProviders, undefined);
});

test("unrelated settings edits preserve provider policy, hidden pools and unknown fields", async () => fixture(async dir => {
  const document = { language: "en", bannedProviders: ["demo-provider", "future-provider"], hiddenPlans: [" demo-pool ", "demo-pool"], adapters: { keychain: false, futureAdapter: { mode: "demo" } }, extension: { nested: ["demo", { enabled: true }] } };
  await writeFile(join(dir, "afc.config.json"), JSON.stringify(document));
  const before = await readSettings("config", dir);
  const saved = await writeSettings({ file: "config", revision: before.revision, document: { ...before.document, language: "zh-CN" } }, dir);
  assert.equal(saved.status, "saved");
  assert.notEqual(saved.snapshot.revision, before.revision);
  assert.deepEqual((await readSettings("config", dir)).document, { ...document, language: "zh-CN" });
  const bytes = await readFile(join(dir, "afc.config.json"), "utf8");
  await assert.rejects(writeSettings({ file: "config", revision: saved.snapshot.revision, document: { ...saved.snapshot.document, bannedProviders: [42] } }, dir));
  assert.equal(await readFile(join(dir, "afc.config.json"), "utf8"), bytes);
}));

test("dispatch overrides save atomically, conflict on stale revisions, and clear to defaults", async () => fixture(async dir => {
  const before = await readSettings("config", dir);
  const dispatchOverrides = { executor: { L1: { "executor.gpt-6.1-sol": { effort: "medium", order: 2 } } } };
  const saved = await writeSettings({ file: "config", revision: before.revision, document: { ...before.document, dispatchOverrides } }, dir);
  assert.equal(saved.status, "saved");
  assert.deepEqual(saved.snapshot.document.dispatchOverrides, dispatchOverrides);
  assert.equal((await writeSettings({ file: "config", revision: before.revision, document: before.document }, dir)).status, "conflict");
  const bytes = await readFile(join(dir, "afc.config.json"), "utf8");
  await assert.rejects(writeSettings({ file: "config", revision: saved.snapshot.revision, document: { dispatchOverrides: { executor: { L1: { executor: { order: 0 } } } } } }, dir));
  assert.equal(await readFile(join(dir, "afc.config.json"), "utf8"), bytes);
  const cleared = await writeSettings({ file: "config", revision: saved.snapshot.revision, document: { ...saved.snapshot.document, dispatchOverrides: {} } }, dir);
  assert.equal(cleared.status, "saved");
  assert.deepEqual(cleared.snapshot.document.dispatchOverrides, {});
}));

test("routing reserves accept only finite percentages", () => {
  for (const reservePct of [-1, 101, "20", null]) {
    assert.equal(plansSchema.safeParse({ plans: [{ id: "demo", name: "Demo", reservePct }] }).success, false);
  }
  for (const reservePct of [0, 20, 100]) {
    assert.equal(plansSchema.parse({ plans: [{ id: "demo", name: "Demo", reservePct }] }).plans[0].reservePct, reservePct);
  }
});
