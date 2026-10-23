import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setLanguage } from "../shared/i18n";
import { parseConfig, saveConfig } from "../server/config";
import { closeDb, getDb } from "../server/db";
import { startTask, type AgentLauncher } from "../server/dispatch";
import { createTask, getTask, listBoard, appendEvent } from "../server/store";
import { publishAnonymousPolicy } from "./helpers/anonymous-policy";
import { runTick, resetReconcileForTests } from "../server/schedule";
import type { PoolEntry, PoolSnapshot } from "../server/pools";
import type { Profile } from "../server/profiles";
import type { DispatchMatrix } from "../server/matrix";
const root = mkdtempSync(join(tmpdir(), "quota-start-"));
Object.assign(process.env, { KANBAN_DATA_DIR: join(root, "data"), PASEO_HOME: join(root, "host"),
  KANBAN_PASEO_CONFIG: join(root, "host/config.json"), KANBAN_AGENTS_DIR: join(root, "agents"), KANBAN_TMP_ROOT: join(root, "tmp") });
for (const d of ["work", "host", "agents"]) mkdirSync(join(root, d), { recursive: true });
after(() => { closeDb(); rmSync(root, { recursive: true, force: true }); });
const profiles: Profile[] = [
  { id: "sol", name: "Demo Sol", role: "reader", provider: "codex", model: "gpt-6.1-sol", pool: "codex-pro", thinkingOptionId: "xhigh" },
  { id: "grok", name: "Demo Grok", role: "reader", provider: "grok", model: "grok-4.7", pool: "supergrok", thinkingOptionId: "high" },
];
const matrix: DispatchMatrix = { version: 1, generatedAt: new Date().toISOString(), defaultTier: "L2", downgradeWhenTight: [], executor: {}, reviewerFamilies: {},
  star: { reader: profiles.map((p, n) => ({ profile: p.name, effort: "xhigh", paused: false, order: n + 1 })) } };
let pools: Record<string, PoolEntry>;
let creates: Array<Parameters<AgentLauncher["create"]>[0]>;
const snapshot: PoolSnapshot = { state: "fresh", generatedAt: new Date().toISOString(), message: "Demo",
  entry: pool => pools[pool ?? ""]!, dispatchable: pool => !!pools[pool ?? ""]?.dispatchable, hasPool: pool => !!pools[pool ?? ""] };
const settings = () => parseConfig({ autoStart: { demo: true }, families: {}, bannedProviders: { providers: [], families: [], pools: [], models: [] },
  projects: { demo: { defaultWorkspace: "dir", alwaysTemp: false, code: "DEMO" } }, concurrency: { global: 20, pools: {}, roles: { reader: 20 } } });
beforeEach(() => {
  setLanguage("en"); resetReconcileForTests(); creates = [];
  getDb().prepare("UPDATE tasks SET status = 'archived'").run(); saveConfig(settings());
  const base = { state: "known" as const, dispatchable: true, usedPct: 10, prefer: false, deprioritize: false, reason: null, onlyRoles: null,
    resetsAt: new Date(Date.now() + 6 * 86400000).toISOString() };
  pools = { "codex-pro": { ...base, projectedPct: 350, forecastConfidence: "high" },
    supergrok: { ...base, resetsAt: new Date(Date.now() + 86400000).toISOString() } };
});
const card = () => createTask({ project: "demo", title: "Inspect a change", role: "reader", tier: "L2", workspacePath: join(root, "work") });
const launcher = (): AgentLauncher => ({ async create(options) { creates.push(options); return { id: `demo-agent-${creates.length}` }; }, async send() {},
  async listModels(provider) { return { models: [{ id: provider === "grok" ? "grok-4.7" : "gpt-6.1-sol", thinkingOptions: ["low", "medium", "high", "xhigh"].map(id => ({ id })) }] }; } });
const options = () => ({ profiles, snapshot, readMatrix: () => ({ state: "ok" as const, path: "demo", matrix }), force: true });
test("manual start and scheduler both use the new gate and record the visible reason", async () => {
  const manual = card(); await startTask(manual.id, launcher(), "fixture", options());
  assert.equal(creates[0]?.config.provider, "grok/grok-4.7"); assert.equal(creates[0]?.config.thinkingOptionId, "low");
  const start = getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'started'").get(manual.id)!;
  const reason = JSON.parse(start.data_json as string).reason;
  assert.match(reason, /x-ultra/); assert.match(reason, /cost/);
  assert.equal(listBoard().tasks.find(t => t.id === manual.id)?.dispatchReason, reason);
  getDb().prepare("UPDATE tasks SET status = 'archived' WHERE id = ?").run(manual.id); creates = [];
  const scheduled = card();
  const result = await runTick({ profiles, launcher: launcher(), config: settings(), pools: snapshot, matrix: { state: "ok", path: "demo", matrix }, agentState: () => "alive" });
  assert.deepEqual(result.errors, []); assert.ok(result.started.includes(scheduled.id));
  assert.equal(creates[0]?.config.provider, "grok/grok-4.7"); assert.equal(creates[0]?.config.thinkingOptionId, "low");
});
test("preselected/manual profiles cannot bypass cost reserve admission", async () => {
  pools["codex-pro"] = { ...pools["codex-pro"], usedPct: 79, projectedPct: 40 };
  const task = card();
  await startTask(task.id, launcher(), "fixture", { ...options(), chosen: profiles[0], effort: "low", effortSource: "matrix" });
  assert.equal(creates.length, 0); assert.equal(getTask(task.id).status, "ready");
});
test("final create guard rechecks unknown pool-wide occupancy after awaited placement", async () => {
  pools.supergrok = { ...pools.supergrok, state: "unknown", usedPct: null };
  const task = card(); let seeded = false;
  const host = launcher(); host.listWorkspaces = async () => {
    if (!seeded) {
      seeded = true; const other = card();
      getDb().prepare("UPDATE tasks SET status = 'running' WHERE id = ?").run(other.id);
      appendEvent(other.id, "agent_creating", null, null, "fixture", { role: "reader", profile: profiles[1].name });
    }
    return [{ id: "demo-workspace", name: "Demo", directory: join(root, "work"), projectRoot: join(root, "work"), projectId: null, kind: "directory", archived: false }];
  };
  await startTask(task.id, host, "fixture", options());
  assert.equal(creates.length, 0); assert.equal(getTask(task.id).status, "ready");
});
test("rollback switch preserves old matrix order and profile depth", async () => {
  saveConfig({ ...settings(), quotaRouting: { enabled: false } });
  const task = card(); await startTask(task.id, launcher(), "fixture", options());
  assert.equal(creates[0]?.config.provider, "codex/gpt-6.1-sol"); assert.equal(creates[0]?.config.thinkingOptionId, "xhigh");
});

test("a known pool slot claimed during catalog lookup is rechecked before create", async () => {
  const config = settings(); config.concurrency.pools.supergrok = 1; saveConfig(config);
  const task = card(); const host = launcher(); const list = host.listModels!;
  host.listModels = async provider => {
    const other = card(); getDb().prepare("UPDATE tasks SET status = 'running' WHERE id = ?").run(other.id);
    appendEvent(other.id, "agent_creating", null, null, "fixture", { role: "reader", profile: profiles[1].name });
    return list(provider);
  };
  await startTask(task.id, host, "fixture", options());
  assert.equal(creates.length, 0); assert.equal(getTask(task.id).status, "ready");
});

test("linked high-risk review keeps actual-model separation through the real start gate", async () => {
  const reviewers = profiles.map(p => ({ ...p, role: "reviewer", id: `review-${p.id}`, name: `Review ${p.name}` }));
  pools["codex-pro"] = { ...pools["codex-pro"], projectedPct: 40 };
  const delivery = createTask({ project: "demo", title: "Delivered work", role: "batch", tier: "L4", workspacePath: join(root, "work") });
  getDb().prepare("INSERT INTO runs (task_id, agent_id, role, profile_name, provider, model, family, started_at, ended_at, end_kind) VALUES (?, 'delivered', 'batch', 'Demo executor', 'codex', 'gpt-6.1-sol', 'openai', ?, ?, 'complete')")
    .run(delivery.id, new Date(Date.now() - 60000).toISOString(), new Date().toISOString());
  getDb().prepare("UPDATE tasks SET status = 'acceptance', executor_profile = 'Demo executor', executor_family = 'openai' WHERE id = ?").run(delivery.id);
  const review = createTask({ project: "demo", title: "Review delivery", role: "reviewer", tier: "L4", reviewOf: delivery.id, workspacePath: join(root, "work") });
  const reviewMatrix: DispatchMatrix = { ...matrix, reviewerModels: { "gpt-6.1-sol": { L4: reviewers.map(p => ({ profile: p.name, effort: "xhigh", paused: false })) } } };
  const opt = { ...options(), profiles: reviewers, readMatrix: () => ({ state: "ok" as const, path: "demo", matrix: reviewMatrix }) };
  await startTask(review.id, launcher(), "fixture", { ...opt, chosen: reviewers[0] });
  assert.equal(creates.length, 0);
  await startTask(review.id, launcher(), "fixture", opt);
  assert.equal(creates.length, 1); assert.equal(creates[0].config.provider, "grok/grok-4.7"); assert.equal(creates[0].config.thinkingOptionId, "high");
});

test("immutable old snapshots wait for routing metadata before the default gate opens", async () => {
  mkdirSync(join(root, "data/fleet"), { recursive: true });
  writeFileSync(process.env.KANBAN_PASEO_CONFIG!, JSON.stringify({ daemon: { agentProfiles: profiles } }));
  for (const name of ["plans.json", "afc.config.json", "paused-projects.json"]) writeFileSync(join(root, "data/fleet", name), name === "paused-projects.json" ? "[]" : "{}");
  const raw = { roles: { reader: { "*": profiles.map(p => ({ profile: p.name, effort: "xhigh" })) } } };
  publishAnonymousPolicy(raw, pools);
  const task = card();
  await startTask(task.id, launcher(), "fixture", { profiles, force: true });
  assert.equal(creates.length, 0); assert.equal(getTask(task.id).status, "ready");
  publishAnonymousPolicy(raw, Object.fromEntries(Object.entries(pools).map(([id, row]) => [id, { ...row, parent: null, reservePct: id === "codex-pro" ? 20 : 0 }])));
  await startTask(task.id, launcher(), "fixture", { profiles, force: true });
  assert.equal(creates.length, 1); assert.equal(creates[0].config.provider, "grok/grok-4.7");
});

test("card reason follows the current agent after an older executor is resumed", async () => {
  const task = card(); const result = await startTask(task.id, launcher(), "fixture", options());
  const original = listBoard().tasks.find(t => t.id === task.id)!.dispatchReason;
  assert.ok(original?.includes("x-ultra"));
  const at = new Date(Date.now() + 1000).toISOString();
  appendEvent(task.id, "started", "in_review", "reviewing", "fixture", { agentId: "old-reviewer", reason: "Different review pool" });
  getDb().prepare("INSERT INTO runs (task_id, agent_id, role, profile_name, provider, model, started_at) VALUES (?, ?, 'reader', ?, 'grok', 'grok-4.7', ?)")
    .run(task.id, result.agentId!, profiles[1].name, at);
  assert.equal(listBoard().tasks.find(t => t.id === task.id)!.dispatchReason, original);
});
