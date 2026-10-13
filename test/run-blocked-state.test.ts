// Default immutable admission and current card display, using anonymous local fixtures only.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import { invalidateAgentIndex } from "../server/agent-index";
import { runKanban } from "../server/cli";
import { DEFAULT_CONCURRENCY, saveConfig } from "../server/config";
import { closeDb, getDb } from "../server/db";
import { startTask, type AgentLauncher } from "../server/dispatch";
import { applyFailure } from "../server/failures";
import { recoverLostCreate } from "../server/lost-agent";
import type { Profile } from "../server/profiles";
import { appendEvent, createTask, getTask, type TaskRow } from "../server/store";
import { setLanguage } from "../shared/i18n";
import { publishAnonymousPolicy } from "./helpers/anonymous-policy";

const root = mkdtempSync(join(tmpdir(), "run-state-"));
const saved = { ...process.env };
Object.assign(process.env, { KANBAN_DATA_DIR: join(root, "data"), PASEO_HOME: join(root, "host"),
  KANBAN_PASEO_CONFIG: join(root, "host/config.json"), KANBAN_AGENTS_DIR: join(root, "agents"),
  KANBAN_TMP_ROOT: join(root, "tmp"), KANBAN_CREATE_RECOVER_MS: "10" });
for (const key of ["PASEO_AGENT_ID", "KANBAN_TOKEN", "AFC_DATA_DIR", "ROLES_STATE_DIR", "AFC_LEGACY_DATA_DIR", "KANBAN_POOL_STATUS", "KANBAN_DISPATCH_MATRIX"]) delete process.env[key];
for (const name of ["data/fleet", "host", "agents", "work", "tmp"]) mkdirSync(join(root, name), { recursive: true });
const executor: Profile = { id: "demo-ex", name: "Demo Executor", role: "executor", provider: "demo", family: "demo", model: "demo-a", pool: "demo" };
const reviewer: Profile = { id: "demo-rv", name: "Demo Reviewer", role: "reviewer", provider: "demo", family: "demo", model: "demo-b", pool: "demo" };
const profiles = [executor, reviewer];
let calls = 0;
const launcher: AgentLauncher = { async create() { return { id: `demo-agent-${++calls}` }; }, async send() {},
  async listModels() { return { models: profiles.map(p => ({ id: p.model!, thinkingOptions: [{ id: "low" }] })) }; } };
beforeEach(() => {
  setLanguage("en");
  getDb().prepare("UPDATE tasks SET status = 'archived' WHERE status != 'archived'").run();
  saveConfig({ autoStart: {}, supervisorAgentId: null, supervisors: {},
    projects: { demo: { code: "DEMO", defaultWorkspace: "dir", alwaysTemp: false, baseBranch: "main", lanesEnabled: false, worktreeLanes: 1 } },
    concurrency: { global: 10, pools: { demo: 10 }, roles: { ...DEFAULT_CONCURRENCY.roles } } });
  writeFileSync(process.env.KANBAN_PASEO_CONFIG!, JSON.stringify({ daemon: { agentProfiles: profiles } }));
  publishAnonymousPolicy({ roles: { executor: { L1: [{ profile: executor.name, effort: "low" }] },
    reviewer: { byExecutorModel: { "demo-a": { L1: [{ profile: reviewer.name, effort: "low" }] } } } } }, { demo: {} });
});
after(() => { closeDb(); for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); rmSync(root, { recursive: true, force: true }); });

const fields = ["blocked_kind", "blocked_reason", "blocked_from", "blocked_at", "cooldown_until"] as const;
function state(task: TaskRow) { return Object.fromEntries(fields.map(key => [key, task[key]])); }
function assertClear(id: number) { assert.deepEqual(state(getTask(id)), Object.fromEntries(fields.map(key => [key, null]))); }
function stamp(id: number) {
  getDb().prepare("UPDATE tasks SET blocked_from = 'running', blocked_at = ? WHERE id = ?").run(new Date(Date.now() - 6 * 60_000).toISOString(), id);
}
async function failedRun(path: "executor" | "standalone-reviewer" | "automatic-review", kind: "quota" | "rate_limit") {
  const task = createTask({ project: "demo", title: "Anonymous run", role: path === "standalone-reviewer" ? "reviewer" : "executor", tier: "L1", workspacePath: join(root, "work") });
  await startTask(task.id, launcher, "fixture");
  assert.equal(getTask(task.id).status, "running");
  if (path === "automatic-review") {
    getDb().prepare("UPDATE runs SET ended_at = ?, end_kind = 'complete' WHERE task_id = ?").run(new Date().toISOString(), task.id);
    getDb().prepare("UPDATE tasks SET status = 'in_review' WHERE id = ?").run(task.id);
    await startTask(task.id, launcher, "fixture");
    assert.equal(getTask(task.id).status, "reviewing");
  }
  const oldAgent = getTask(task.id).agent_id;
  assert.equal(applyFailure(task.id, `Anonymous old ${kind}`, kind, new Date(Date.now() - 6 * 60_000)), "requeue");
  stamp(task.id);
  return { id: task.id, oldAgent, before: state(getTask(task.id)) };
}
for (const path of ["executor", "standalone-reviewer", "automatic-review"] as const) {
  for (const kind of ["quota", "rate_limit"] as const) {
    test(`${path} clears current ${kind} fields only after a successful new binding`, async () => {
      const f = await failedRun(path, kind);
      const result = await startTask(f.id, { ...launcher, async create(options) {
        assert.deepEqual(state(getTask(f.id)), f.before, "claim must retain the failure until create succeeds");
        return launcher.create(options);
      } }, "fixture");
      assert.notEqual(result.agentId, f.oldAgent);
      assert.equal(getTask(f.id).status, path === "automatic-review" ? "reviewing" : "running");
      assertClear(f.id);
      const shown = await runKanban(["show", String(f.id)], {}) as { task: { blockedKind: unknown; blockedReason: unknown; blockedAt: unknown } };
      assert.equal(shown.task.blockedKind, null); assert.equal(shown.task.blockedReason, null); assert.equal(shown.task.blockedAt, null);
      const old = getDb().prepare("SELECT end_kind FROM runs WHERE task_id = ? AND agent_id = ?").get(f.id, f.oldAgent!);
      assert.equal(old!.end_kind, kind);
      const event = getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'requeued'").get(f.id);
      assert.equal(JSON.parse(String(event!.data_json)).message, `Anonymous old ${kind}`);
    });
    test(`${path} retains current ${kind} fields when create fails`, async () => {
      const f = await failedRun(path, kind);
      await assert.rejects(startTask(f.id, { ...launcher, async create() { throw new Error("Anonymous create failed"); } }, "fixture"), /Anonymous create failed/);
      assert.deepEqual(state(getTask(f.id)), f.before);
      assert.equal(getTask(f.id).status, path === "automatic-review" ? "in_review" : "ready");
    });
  }
}
for (const role of ["executor", "reviewer"] as const) {
  for (const succeeds of [true, false]) {
    test(`${role} resume ${succeeds ? "clears" : "retains"} old fields after send ${succeeds ? "success" : "failure"}`, async () => {
      const f = await failedRun(role === "reviewer" ? "standalone-reviewer" : "executor", "quota");
      getDb().prepare("UPDATE tasks SET status = 'rework', executor_agent_id = ? WHERE id = ?").run(f.oldAgent, f.id);
      await (succeeds ? startTask(f.id, launcher, "fixture") : assert.rejects(startTask(f.id, { ...launcher, async send() { throw new Error("Anonymous send failed"); } }, "fixture"), /Anonymous send failed/));
      if (succeeds) { assertClear(f.id); assert.equal(getTask(f.id).status, "running"); }
      else { assert.deepEqual(state(getTask(f.id)), f.before); assert.equal(getTask(f.id).status, "rework"); }
    });
  }
  test(`${role} lost-create recovery clears old fields on adoption`, async () => {
    const f = await failedRun(role === "reviewer" ? "automatic-review" : "executor", "rate_limit");
    const claimedAt = new Date(Date.now() - 10_000).toISOString();
    getDb().prepare("UPDATE tasks SET status = ?, agent_id = NULL WHERE id = ?").run(role === "reviewer" ? "reviewing" : "running", f.id);
    appendEvent(f.id, "agent_creating", null, null, "fixture", { role, profile: role === "reviewer" ? reviewer.name : executor.name, provider: "demo", model: role === "reviewer" ? "demo-b" : "demo-a", family: "demo" }, claimedAt);
    const id = `recovered-${f.id}`;
    writeFileSync(join(root, "agents", `${id}.json`), JSON.stringify({ id, cwd: join(root, "work"), labels: { kanban: "1", kanban_task: String(f.id), role }, archivedAt: null, createdAt: new Date().toISOString(), provider: "demo" }));
    invalidateAgentIndex();
    assert.equal(recoverLostCreate(f.id, new Date()), "adopted");
    assert.equal(getTask(f.id).agent_id, id); assertClear(f.id);
  });
}
