/// <reference types="node" />
import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, it, mock } from "node:test";
import { setLanguage } from "../shared/i18n";
import { readCleanupEvents } from "../server/archive-book";
import { cardMark } from "../server/card-ref";
import { runKanban } from "../server/cli";
import { loadConfig, parseConfig, saveConfig } from "../server/config";
import { closeDb, getDb } from "../server/db";
import { resolveTokenIdentity } from "../server/identity";
import { startMcpServer } from "../server/mcp";
import { resetMissingCwdForTests, setMissingCwdHooks } from "../server/missing-cwd";
import { isOpsCleanupWorker } from "../server/ops-cleanup";
import { changeReadGrant } from "../server/read-grants";
import type { RelatedView } from "../server/related-view";
import { appendEvent, archiveTask, createTask, getTask } from "../server/store";
import { issueToken } from "../server/tokens";
import { handleTool, toolDefs } from "../server/tools";
import { startTask } from "./helpers/compat-dispatch";

const root = mkdtempSync(join(tmpdir(), "ops-cleanup-"));
const saved = { ...process.env };
let dir: string;
let serial = 0;
beforeEach(() => {
  closeDb(); process.env = { ...saved }; setLanguage("en");
  dir = join(root, String(++serial));
  process.env.KANBAN_DATA_DIR = join(dir, "data");
  process.env.PASEO_HOME = join(dir, "paseo");
  process.env.KANBAN_AGENTS_DIR = join(dir, "agents");
  mkdirSync(join(dir, "agents", "bucket"), { recursive: true });
  const workspace = { defaultWorkspace: "dir" as const, baseBranch: "main", worktreeLanes: 1, lanesEnabled: false };
  saveConfig({ ...loadConfig(), opsProject: "Demo operations", supervisorAgentId: "board-leader",
    supervisors: { "Demo operations": "ops-leader", application: "app-leader" },
    projects: { "Demo operations": { ...workspace, code: "OPS" }, application: { ...workspace, code: "APP" } } });
  setMissingCwdHooks({ listAgents: () => [] });
});
after(() => { resetMissingCwdForTests(); closeDb(); process.env = saved; rmSync(root, { recursive: true, force: true }); });

function card(project = "application", status = "done", role = "executor") {
  const task = createTask({ project, title: "Cleanup fixture", role, workspacePath: dir, brief: "Reference text" });
  getDb().prepare("UPDATE tasks SET status = ? WHERE id = ?").run(status, task.id);
  return getTask(task.id);
}
function worker(project = "Demo operations", role = "batch", launched = true) {
  const own = card(project, "running", role);
  const agentId = `worker-${own.id}`;
  getDb().prepare("UPDATE tasks SET agent_id = ?, executor_agent_id = ? WHERE id = ?").run(agentId, agentId, own.id);
  getDb().prepare("INSERT INTO runs (task_id, agent_id, role, started_at) VALUES (?, ?, ?, ?)").run(own.id, agentId, role, new Date().toISOString());
  if (launched) appendEvent(own.id, "agent_opened", null, null, "scheduler", { agentId });
  const token = issueToken(role, own.id, agentId);
  const identity = resolveTokenIdentity(token);
  return { ...own, identity, token, env: { PASEO_AGENT_ID: agentId, KANBAN_TOKEN: token } };
}
function stopped(id: number) {
  appendEvent(id, "cleanup", null, null, "kanban", { action: "skip_worktree", ok: false, reason: "not_merged", stopped: true, attempts: 12 });
}
const forbidden = (work: Promise<unknown>) => assert.rejects(work, { code: "forbidden" });
type List = { projects: string[]; tasks: Array<{ id: number; project: string; status: string }> };

it("recognizes the real dispatcher run and launch event without an added client capability field", async () => {
  const own = card("Demo operations", "ready", "batch");
  process.env.KANBAN_DISPATCH_MATRIX = join(dir, "absent-matrix.json");
  process.env.KANBAN_POOL_STATUS = join(dir, "absent-pools.json");
  let token = "";
  await startTask(own.id, { create: async input => { token = input.env?.KANBAN_TOKEN ?? ""; return { id: "dispatched-worker" }; }, send: async () => {} }, "scheduler", {
    profiles: [{ id: "batch-fixture", name: "Batch fixture", role: "batch", family: "xai", provider: "cursor", model: "grok-4.7", pool: "cursor" }],
    snapshot: { state: "fresh", generatedAt: new Date().toISOString(), message: "Fixture", dispatchable: () => true,
      entry: () => ({ dispatchable: true, deprioritize: false, prefer: false, resetsAt: null, reason: null, onlyRoles: null }) },
  });
  const target = card();
  assert.ok(token);
  const result = await runKanban(["show", cardMark(target.id)], { PASEO_AGENT_ID: "dispatched-worker", KANBAN_TOKEN: token }) as RelatedView;
  assert.equal(result.id, target.id);
});

it("allows active dispatched ops batches to show and list other projects through CLI and MCP with existing redaction", async () => {
  const own = worker();
  const targets = ["running", "done", "archived"].map(status => card("application", status));
  const secret = "private-agent-fixture";
  appendEvent(targets[1].id, "cleanup", null, null, secret, { reason: "not_merged", token: "secret-fixture", agentId: secret, env: { sensitive: "secret-fixture" } });
  for (const target of targets) {
    const shown = await handleTool("kanban_show", { id: cardMark(target.id) }, own.token) as RelatedView;
    assert.equal(shown.related, true);
    assert.equal(shown.id, target.id);
    assert.equal(shown.status, target.status);
    assert.ok(shown.events);
    assert.equal(shown.brief, "Reference text");
    assert.ok(!("runs" in shown) && !("task" in shown));
    assert.ok(!JSON.stringify(shown).includes(secret));
    assert.ok(!JSON.stringify(shown).includes("secret-fixture"));
    assert.deepEqual(await runKanban(["show", cardMark(target.id)], own.env), shown);
  }
  for (const query of [{}, { project: "application" }, { project: "APP" }]) {
    const list = await handleTool("kanban_list", query, own.token) as List;
    assert.ok(targets.every(target => list.tasks.some(row => row.id === target.id)));
    assert.ok(!JSON.stringify(list).includes(own.identity.agentId!));
    assert.ok(list.tasks.every(row => !("brief" in row) && !("handoff" in row) && !("agentId" in row)));
  }
  const filtered = await runKanban(["list", "--project", "APP"], own.env) as List;
  assert.ok(filtered.tasks.every(task => task.project === "application"));
  // The narrower existing grant must not override this independent cleanup capability.
  changeReadGrant(own.id, "project", { role: "supervisor", taskId: null, agentId: "ops-leader" });
  assert.equal((await handleTool("kanban_show", { id: targets[0].id }, own.token) as RelatedView).id, targets[0].id);
});

for (const status of ["done", "archived"]) {
  it(`resumes stopped cleanup on a foreign ${status} card without changing business state, and audits the worker run`, async () => {
    const own = worker(); const target = card("application", status); stopped(target.id);
    const before = getTask(target.id);
    const result = await runKanban(["resume-cleanup", cardMark(target.id)], { KANBAN_TOKEN: own.token }) as { resumed: number };
    assert.equal(result.resumed, 1);
    assert.ok(readCleanupEvents(target.id).every(row => !row.stopped));
    assert.deepEqual(getTask(target.id), before);
    const audit = getDb().prepare("SELECT task_id, role, source_json, outcome FROM write_audits WHERE operation = 'resume-cleanup' ORDER BY id DESC LIMIT 1").get()!;
    assert.equal(audit.task_id, own.id); assert.equal(audit.role, "batch"); assert.equal(audit.outcome, "returned");
    const source = JSON.parse(String(audit.source_json));
    assert.equal(source.agentId, own.identity.agentId); assert.ok(source.runId);
    stopped(target.id);
    assert.equal((await runKanban(["resume-cleanup", String(target.id)], own.env) as { resumed: number }).resumed, 1);
  });

  it(`keeps missing-land settlement leader-only for a foreign ${status} card`, async () => {
    const own = worker(); const target = card("application", status); stopped(target.id);
    const before = getTask(target.id);
    assert.ok(isOpsCleanupWorker(own.identity));
    await assert.rejects(runKanban(["resume-cleanup", cardMark(target.id), "--settle-missing-land", "--reason", "Checked queued tip"], own.env), {
      code: "forbidden", message: /Only this project's registered <leader> or the Kanban <leader>/,
    });
    assert.deepEqual(getTask(target.id), before);
    assert.ok(readCleanupEvents(target.id).some(row => row.stopped));
    assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND kind = 'land_settled'").get(target.id)?.n, 0);
  });

  it(`purges only eligible archived agents recorded on a foreign ${status} card and preserves its status`, async () => {
    const own = worker(); const target = card("application", status);
    const agentId = `retired-${target.id}`;
    appendEvent(target.id, "agent_opened", null, null, "scheduler", { agentId });
    const path = join(dir, "agents", "bucket", `${agentId}.json`);
    writeFileSync(path, JSON.stringify({ id: agentId, provider: "cursor", cwd: join(dir, "missing"), title: "Retired fixture", archivedAt: "2026-09-01T00:00:00Z", lastStatus: "closed", labels: { kanban: "1", kanban_task: String(target.id) } }));
    const deleted: string[] = [];
    setMissingCwdHooks({ deleteAgent: async id => { deleted.push(id); rmSync(path); } });
    const before = getTask(target.id);
    const dry = await runKanban(["purge-agents", cardMark(target.id), "--dry-run"], own.env) as { deleted: string[] };
    assert.deepEqual(dry.deleted, []); assert.deepEqual(deleted, []);
    const actual = await runKanban(["purge-agents", cardMark(target.id)], { KANBAN_TOKEN: own.token }) as { deleted: string[] };
    assert.deepEqual(actual.deleted, [agentId]); assert.deepEqual(deleted, [agentId]);
    assert.deepEqual(getTask(target.id), before);
  });
}

for (const change of ["source-completed", "source-archived", "target-reopened", "unfinished-reference-added"]) {
  it(`rechecks authority after asynchronous native lookup when ${change} before agent deletion`, async () => {
    const own = worker(); const target = card();
    const agentId = `retired-${target.id}`;
    const path = join(dir, "agents", "bucket", `${agentId}.json`);
    appendEvent(target.id, "agent_opened", null, null, "scheduler", { agentId });
    writeFileSync(path, JSON.stringify({ id: agentId, provider: "cursor", cwd: join(dir, "gone"), title: "Retired fixture", archivedAt: "2026-09-01T00:00:00Z", labels: { kanban: "1", kanban_task: String(target.id) } }));
    const deleted: string[] = [];
    setMissingCwdHooks({ deleteAgent: async id => { deleted.push(id); } });
    const readFile = fs.promises.readFile;
    let changed = false;
    const read = mock.method(fs.promises, "readFile", async (...args: Parameters<typeof readFile>) => {
      const value = await readFile(...args);
      if (String(args[0]) === path && !changed) {
        changed = true;
        if (change === "unfinished-reference-added") {
          const active = card("application", "running");
          getDb().prepare("UPDATE tasks SET agent_id = ? WHERE id = ?").run(agentId, active.id);
        } else getDb().prepare("UPDATE tasks SET status = ? WHERE id = ?")
          .run(change === "source-completed" ? "done" : change === "source-archived" ? "archived" : "running", change === "target-reopened" ? target.id : own.id);
      }
      return value;
    });
    try {
      await forbidden(runKanban(["purge-agents", String(target.id)], own.env));
      assert.equal(changed, true); assert.deepEqual(deleted, []);
    } finally { read.mock.restore(); }
  });
}

it("keeps an agent also referenced by an unfinished card under the existing purge safeguards", async () => {
  const own = worker(); const target = card(); const active = card("application", "running");
  const agentId = "shared-retired-agent";
  appendEvent(target.id, "agent_opened", null, null, "scheduler", { agentId });
  getDb().prepare("UPDATE tasks SET agent_id = ? WHERE id = ?").run(agentId, active.id);
  writeFileSync(join(dir, "agents", "bucket", `${agentId}.json`), JSON.stringify({ id: agentId, provider: "cursor", cwd: join(dir, "gone"), title: "Shared fixture", archivedAt: "2026-09-01T00:00:00Z", labels: { kanban: "1", kanban_task: String(target.id) } }));
  const deleted: string[] = []; setMissingCwdHooks({ deleteAgent: async id => { deleted.push(id); } });
  const result = await runKanban(["purge-agents", String(target.id)], own.env) as { deleted: string[] };
  assert.deepEqual(result.deleted, []); assert.deepEqual(deleted, []);
  assert.equal(getTask(active.id).status, "running");
});

it("does not bypass unfinished references when an earlier purge already wrote its notes", async () => {
  const own = worker(); const target = card(); const active = card("application", "running");
  const agentId = "partially-purged-agent";
  appendEvent(target.id, "agent_opened", null, null, "scheduler", { agentId });
  appendEvent(target.id, "agent_purged", null, null, "kanban", { agentId });
  getDb().prepare("UPDATE tasks SET agent_id = ? WHERE id = ?").run(agentId, active.id);
  writeFileSync(join(dir, "agents", "bucket", `${agentId}.json`), JSON.stringify({ id: agentId, provider: "cursor", cwd: join(dir, "gone"), title: "Partial fixture", archivedAt: "2026-09-01T00:00:00Z", labels: { kanban: "1", kanban_task: String(target.id) } }));
  const deleted: string[] = []; setMissingCwdHooks({ deleteAgent: async id => { deleted.push(id); } });
  await forbidden(runKanban(["purge-agents", String(target.id)], own.env));
  assert.deepEqual(deleted, []); assert.equal(getTask(active.id).status, "running");
});

it("refuses every foreign business write, leader registration and unmerged discard from the same authorized card", async () => {
  const own = worker(); const target = card(); stopped(target.id);
  const before = getTask(target.id);
  const writes: Array<[string, Record<string, unknown>]> = [
    ["accept", {}], ["reject", { reason: "No" }], ["rework", { reason: "No" }], ["pass", { note: "No" }],
    ["approve", { summary: "No" }], ["complete", { summary: "No" }], ["archive", {}],
    ["comment", { text: "No" }], ["block", { kind: "needs_human", reason: "No" }],
    ["request_changes", { reason: "No" }], ["unblock", {}], ["link", { parent: own.id }], ["unlink", { parent: own.id }],
    ["grant_read", { scope: "project" }], ["revoke_read", {}], ["wait_user", { decision: "No" }], ["unwait", {}],
  ];
  for (const [tool, args] of writes) await forbidden(handleTool(`kanban_${tool}`, { id: target.id, ...args }, own.token));
  for (const tool of ["kanban_create", "kanban_supervise", "kanban_register"]) {
    await forbidden(handleTool(tool, { project: "application", title: "No", role: "batch" }, own.token));
  }
  for (const args of [["accept"], ["reject", "--reason", "No"], ["rework", "--reason", "No"], ["pass", "--note", "No"],
    ["approve", "--summary", "No"], ["complete", "--summary", "No"], ["archive"], ["start"], ["tag", "--tag", "cleanup"],
    ["resume-cleanup", "--discard-unmerged"]]) {
    await forbidden(runKanban([args[0], String(target.id), ...args.slice(1)], own.env));
  }
  await forbidden(runKanban(["supervise", "--project", "application"], own.env));
  await forbidden(runKanban(["create", "--project", "application", "--title", "No", "--role", "batch"], own.env));
  assert.deepEqual(getTask(target.id), before);
  assert.ok(readCleanupEvents(target.id).some(row => row.stopped));
});

for (const status of ["ready", "running", "blocked", "in_review", "reviewing", "acceptance", "rework"]) {
  it(`refuses cleanup of an unfinished ${status} target, including purge dry-run`, async () => {
    const own = worker(); const target = card("application", status); stopped(target.id);
    for (const args of [["resume-cleanup"], ["purge-agents"], ["purge-agents", "--dry-run"]]) {
      await forbidden(runKanban([args[0], String(target.id), ...args.slice(1)], own.env));
    }
    assert.ok(readCleanupEvents(target.id).some(row => row.stopped));
    assert.equal(getTask(target.id).status, status);
  });
}

async function noCrossProject(own: ReturnType<typeof worker>, target: ReturnType<typeof card>) {
  assert.equal(isOpsCleanupWorker(own.identity), false);
  for (const env of [own.env, { KANBAN_TOKEN: own.token }]) {
    await forbidden(runKanban(["show", String(target.id)], env));
    await forbidden(runKanban(["resume-cleanup", String(target.id)], env));
    await forbidden(runKanban(["purge-agents", String(target.id)], env));
    const list = await runKanban(["list", "--project", target.project], env) as List;
    assert.ok(!list.tasks.some(row => row.id === target.id));
  }
}

it("does not give ordinary projects cross-project access even with a project read grant", async () => {
  const own = worker("application"); const target = card("Demo operations");
  await noCrossProject(own, target);
  changeReadGrant(own.id, "project", { role: "supervisor", taskId: null, agentId: "app-leader" });
  await forbidden(handleTool("kanban_show", { id: target.id }, own.token));
  await forbidden(handleTool("kanban_list", { project: target.project }, own.token));
});

for (const role of ["executor", "reviewer", "reader", "decision"]) {
  it(`does not give ops ${role} cards maintenance authority`, async () => { await noCrossProject(worker("Demo operations", role), card()); });
}

for (const revoke of ["complete", "archive", "ended-run", "end-kind", "rebound", "new-run", "blocked", "done", "archived", "changed-project", "changed-role", "deleted-card", "expired-token", "revoked-token"]) {
  it(`revokes access immediately after ${revoke}, even while a worker token is valid`, async () => {
    const own = worker(); const target = card();
    assert.equal(isOpsCleanupWorker(own.identity), true);
    const db = getDb();
    if (revoke === "complete") await handleTool("kanban_complete", { summary: "Cleanup finished", handoff: { files: [], verification: [], risks: [] } }, own.token);
    else if (revoke === "archive") archiveTask(own.id, "supervisor");
    else if (revoke === "ended-run") db.prepare("UPDATE runs SET ended_at = ? WHERE task_id = ?").run(new Date().toISOString(), own.id);
    else if (revoke === "end-kind") db.prepare("UPDATE runs SET end_kind = 'reclaimed' WHERE task_id = ?").run(own.id);
    else if (revoke === "rebound") db.prepare("UPDATE tasks SET agent_id = 'replacement' WHERE id = ?").run(own.id);
    else if (revoke === "new-run") db.prepare("INSERT INTO runs (task_id, agent_id, role, started_at, ended_at) VALUES (?, ?, 'batch', 'later', 'ended')").run(own.id, own.identity.agentId);
    else if (revoke === "changed-project") db.prepare("UPDATE tasks SET project = 'application', code_seq = 100 WHERE id = ?").run(own.id);
    else if (revoke === "changed-role") db.prepare("UPDATE tasks SET role = 'executor' WHERE id = ?").run(own.id);
    else if (revoke === "deleted-card") db.prepare("DELETE FROM tasks WHERE id = ?").run(own.id);
    else if (revoke === "expired-token") db.prepare("UPDATE tokens SET expires_at = '2026-01-01T00:00:00Z' WHERE token = ?").run(own.token);
    else if (revoke === "revoked-token") db.prepare("DELETE FROM tokens WHERE token = ?").run(own.token);
    else db.prepare("UPDATE tasks SET status = ? WHERE id = ?").run(revoke, own.id);
    assert.equal(isOpsCleanupWorker(own.identity), false);
    // The same bearer cannot retain the exception. Some lifecycle paths revoke the bearer altogether.
    for (const action of [() => handleTool("kanban_show", { id: target.id }, own.token),
      () => runKanban(["resume-cleanup", String(target.id)], { KANBAN_TOKEN: own.token }),
      () => runKanban(["purge-agents", String(target.id)], { KANBAN_TOKEN: own.token })]) {
      await assert.rejects(action, (err: { code?: string }) => ["forbidden", "unauthorized", "not_found"].includes(err.code ?? ""));
    }
    if (!["deleted-card", "archive", "expired-token", "revoked-token"].includes(revoke)) {
      const list = await handleTool("kanban_list", {}, own.token) as List;
      // Moving the source card preserves ordinary same-project list access only.
      assert.ok(list.tasks.every(row => row.project === getTask(own.id).project));
    }
  });
}

it("requires actual dispatch evidence and an exact task/run/agent binding, not token or agent labels", async () => {
  const own = worker("Demo operations", "batch", false); const target = card();
  writeFileSync(join(dir, "agents", "bucket", `${own.identity.agentId}.json`), JSON.stringify({ id: own.identity.agentId,
    labels: { kanban: "1", kanban_task: String(own.id), role: "batch", opsProject: "Demo operations" } }));
  await noCrossProject(own, target);
  appendEvent(own.id, "agent_opened", null, null, "scheduler", { agentId: own.identity.agentId });
  assert.equal(isOpsCleanupWorker(own.identity), true);
  getDb().prepare("DELETE FROM runs WHERE task_id = ?").run(own.id);
  await noCrossProject(own, target);
  const copied = issueToken("batch", own.id, "forged-agent");
  await forbidden(handleTool("kanban_show", { id: target.id }, copied));
  await forbidden(runKanban(["show", String(target.id)], { KANBAN_TOKEN: copied, PASEO_AGENT_ID: own.identity.agentId! }));
});

it("requires a verified card bearer; a genuine running agent id or copied identity object alone cannot elevate", async () => {
  const own = worker(); const target = card();
  assert.equal(isOpsCleanupWorker(own.identity), true);
  assert.equal(isOpsCleanupWorker({ ...own.identity }), false);
  const env = { PASEO_AGENT_ID: own.identity.agentId! };
  for (const cmd of ["show", "resume-cleanup", "purge-agents"]) await forbidden(runKanban([cmd, String(target.id)], env));
  const list = await runKanban(["list"], env) as List;
  assert.ok(!list.tasks.some(row => row.id === target.id));
  await forbidden(handleTool("kanban_show", { id: target.id }, null, { ...own.identity }));
  const guest = issueToken("guest", own.id, own.identity.agentId);
  await forbidden(handleTool("kanban_show", { id: target.id }, guest));
  getDb().prepare("DELETE FROM tokens WHERE token = ?").run(own.token);
  assert.equal(isOpsCleanupWorker(own.identity), false);
});

it("uses explicit board config before Fleet config, rechecks changes and never grants the notification default", async () => {
  const own = worker(); const target = card();
  const fleet = join(process.env.KANBAN_DATA_DIR!, "fleet"); mkdirSync(fleet);
  const path = join(fleet, "afc.config.json");
  writeFileSync(path, JSON.stringify({ opsProject: "application" }));
  assert.equal(isOpsCleanupWorker(own.identity), true);
  const config = loadConfig(); delete config.opsProject; saveConfig(config);
  await noCrossProject(own, target);
  writeFileSync(path, JSON.stringify({ opsProject: " demo OPERATIONS " }));
  assert.equal(isOpsCleanupWorker(own.identity), true);
  for (const raw of [null, "", "OPS", "unconfigured", false, "bad\nproject"]) {
    saveConfig(parseConfig({ ...config, opsProject: raw }));
    await noCrossProject(own, target);
  }
  saveConfig(config);
  for (const raw of ["{broken", "{}", "[]", '{"opsProject":false}']) {
    writeFileSync(path, raw); assert.equal(isOpsCleanupWorker(own.identity), false);
  }
  rmSync(path); assert.equal(isOpsCleanupWorker(own.identity), false);
});

it("does not grant the legacy notification project implicitly, or guess an ambiguous operations name", async () => {
  const config = loadConfig(); delete config.opsProject;
  const workspace = config.projects!["Demo operations"];
  saveConfig({ ...config, projects: { ...config.projects, "paseo-fleet": { ...workspace, code: "LEG" } } });
  const legacy = worker("paseo-fleet"); const target = card();
  await noCrossProject(legacy, target);
  saveConfig({ ...config, opsProject: "DEMO OPERATIONS", projects: { ...config.projects, "demo OPERATIONS": { ...workspace, code: "DUP" } } });
  const own = worker();
  await noCrossProject(own, target);
  saveConfig({ ...loadConfig(), opsProject: "Demo operations" });
  assert.equal(isOpsCleanupWorker(own.identity), true);
  writeFileSync(join(process.env.KANBAN_DATA_DIR!, "kanban.config.json"), "{broken");
  assert.equal(isOpsCleanupWorker(own.identity), false);
});

it("ignores forged MCP identity headers, payload fields and CLI role/project environment labels", async () => {
  const ops = worker(); const ordinary = worker("application"); const target = card("Demo operations");
  const args = { id: target.id, role: "supervisor", taskId: ops.id, agentId: ops.identity.agentId, opsProject: "Demo operations", opsCleanup: true };
  await forbidden(handleTool("kanban_show", args, ordinary.token));
  await forbidden(runKanban(["show", String(target.id)], { ...ordinary.env, KANBAN_ROLE: "batch", KANBAN_TASK: String(ops.id), OPS_PROJECT: "Demo operations", KANBAN_OPS_CLEANUP: "1" }));
  const server = await startMcpServer(toolDefs(), async (name, input, token) => {
    try { return { text: JSON.stringify(await handleTool(name, input, token)) }; }
    catch (err) { return { text: (err as { code?: string }).code ?? "error", isError: true }; }
  });
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/`, { method: "POST",
      headers: { authorization: `Bearer ${ordinary.token}`, "content-type": "application/json", "x-kanban-role": "supervisor", "x-kanban-agent-id": ops.identity.agentId!, "x-kanban-task": String(ops.id), "x-ops-project": "Demo operations" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "kanban_show", arguments: args } }) });
    const reply = await response.json() as { result: { isError: boolean; content: Array<{ text: string }> } };
    assert.equal(reply.result.isError, true); assert.equal(reply.result.content[0].text, "forbidden");
  } finally { await server.close(); }
});
