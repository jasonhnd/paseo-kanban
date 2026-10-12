/// <reference types="node" />
import { setLanguage } from "../shared/i18n";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, beforeEach, it, mock } from "node:test";
import { fileURLToPath } from "node:url";
import { cardMark } from "../server/card-ref";
import { kanbanHelp, runKanban } from "../server/cli";
import { loadConfig, saveConfig } from "../server/config";
import { closeDb, getDb } from "../server/db";
import { KanbanError } from "../server/errors";
import { requestChanges, settleQuietHandoff } from "../server/flow";
import { resolveCliIdentity } from "../server/identity";
import { canonicalKanbanTool } from "../server/permissions";
import { changeReadGrant } from "../server/read-grants";
import { archiveTask, createTask, getTask } from "../server/store";
import { addComment, appendEvent } from "../server/task-record";
import { issueToken, type Identity } from "../server/tokens";
import { formatResult, handleTool, toolDefs } from "../server/tools";
import type { RelatedView } from "../server/related-view";
import { SUBPROCESS_TIMEOUT_MS } from "./helpers/subprocess-timeout";

const root = mkdtempSync(join(tmpdir(), "kanban-read-grants-"));
const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const saved = { ...process.env };
let dir: string;
let serial = 0;
const leader: Identity = { role: "supervisor", taskId: null, agentId: "project-leader" };
const board: Identity = { ...leader, agentId: "board-leader" };
beforeEach(() => {
  closeDb(); process.env = { ...saved }; setLanguage("en"); process.env.KANBAN_LANGUAGE = "en";
  dir = join(root, String(++serial));
  process.env.KANBAN_DATA_DIR = dir;
  process.env.PASEO_HOME = dir;
  process.env.KANBAN_AGENTS_DIR = dir;
  const workspace = { defaultWorkspace: "dir" as const, baseBranch: "main", worktreeLanes: 1, lanesEnabled: false };
  saveConfig({ ...loadConfig(), supervisorAgentId: board.agentId,
    supervisors: { "read-project": leader.agentId!, "other-project": "other-leader" },
    projects: { "read-project": { ...workspace, code: "RDP" }, "other-project": { ...workspace, code: "OTP" } } });
});
after(() => { closeDb(); process.env = saved; rmSync(root, { recursive: true, force: true }); });
function card(title = "reference", project = "read-project", role = "reader") {
  return createTask({ project, title, role, workspacePath: dir, createdByAgent: "creator" });
}
function worker(role = "reader") {
  const own = card("summary", "read-project", role);
  getDb().prepare("UPDATE tasks SET status = 'running', agent_id = 'read-worker' WHERE id = ?").run(own.id);
  return { id: own.id, token: issueToken(role, own.id, "read-worker") };
}
const grant = (id: number, identity = leader) => handleTool("kanban_grant_read", { id, scope: "project" }, null, identity);
const revoke = (id: number, identity = leader) => handleTool("kanban_revoke_read", { id }, null, identity);
const forbidden = (work: Promise<unknown>) => assert.rejects(work, (error: unknown) => error instanceof KanbanError && error.code === "forbidden");

it("grants show/list of all same-project statuses, preserves list redaction and revokes immediately", async () => {
  const own = worker();
  const cards = [card("active"), card("done"), card("archived")];
  getDb().prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(cards[1].id);
  archiveTask(cards[2].id, "supervisor");
  const foreign = card("other project", "other-project");
  for (const other of cards) await forbidden(handleTool("kanban_show", { id: other.id }, own.token));
  const originalList = await handleTool("kanban_list", {}, own.token);
  await grant(own.id);
  for (const other of cards) {
    const shown = await handleTool("kanban_show", { id: other.id }, own.token) as RelatedView;
    assert.equal(shown.id, other.id);
    assert.ok(shown.events);
  }
  const list = await handleTool("kanban_list", { project: "read-project" }, own.token) as { projects: string[]; tasks: Array<{ id: number; status: string }> };
  assert.deepEqual(list.projects, ["read-project"]);
  assert.deepEqual(new Set(list.tasks.map(t => t.id)), new Set([own.id, ...cards.map(t => t.id)]));
  assert.deepEqual(new Set(list.tasks.map(t => t.status)), new Set(["running", "ready", "done", "archived"]));
  assert.equal(JSON.stringify(list).includes("read-worker"), false);
  await forbidden(handleTool("kanban_show", { id: foreign.id }, own.token));
  await forbidden(handleTool("kanban_list", { project: "other-project" }, own.token));
  assert.deepEqual(await handleTool("kanban_list", { project: "RDP" }, own.token), list);
  const ownView = await handleTool("kanban_show", {}, own.token) as { task: { readScope: unknown } };
  assert.equal(ownView.task.readScope, "project");
  await revoke(own.id);
  assert.equal(getTask(own.id).project_read_scope, null);
  for (const other of cards) await forbidden(handleTool("kanban_show", { id: other.id }, own.token));
  assert.deepEqual(await handleTool("kanban_list", {}, own.token), originalList);
  assert.equal((await handleTool("kanban_show", {}, own.token) as { task: { readScope: unknown } }).task.readScope, null);
});

it("preserves every write restriction and still lets a worker write its own card", async () => {
  const own = worker("executor");
  const other = card();
  await grant(own.id);
  for (const [tool, args] of [
    ["kanban_comment", { text: "forbidden comment" }],
    ["kanban_complete", { summary: "forbidden handoff", handoff: { files: [], verification: [], risks: [] } }],
    ["kanban_block", { kind: "needs_human", reason: "forbidden block" }],
    ["kanban_archive", {}], ["kanban_accept", {}], ["kanban_link", { parent: own.id }],
  ] as Array<[string, Record<string, unknown>]>) {
    await forbidden(handleTool(tool, { id: other.id, ...args }, own.token));
  }
  await forbidden(handleTool("kanban_create", { project: "read-project", title: "forbidden create", role: "executor" }, own.token));
  await handleTool("kanban_comment", { id: own.id, text: "own comment" }, own.token);
  assert.equal(getTask(other.id).status, "ready");
  assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM comments WHERE task_id = ?").get(other.id)!.n, 0);
  assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM comments WHERE task_id = ?").get(own.id)!.n, 1);
});

it("requires the registered project or board leader, including for revocation", async () => {
  const own = worker();
  const identities: Identity[] = [
    { ...leader, agentId: "other-leader" }, { ...leader, agentId: "creator" },
    { ...leader, agentId: "unregistered" }, { ...leader, agentId: null },
    { ...leader, taskId: own.id },
    ...["executor", "reviewer", "reader", "decision", "batch", "schedule", "guest"].map(role => ({ role, taskId: null, agentId: leader.agentId })),
  ];
  for (const identity of identities) {
    await forbidden(grant(own.id, identity));
    await forbidden(revoke(own.id, identity));
  }
  await forbidden(handleTool("kanban_grant_read", { id: own.id, scope: "project" }, own.token));
  await forbidden(handleTool("kanban_revoke_read", { id: own.id }, own.token));
  assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM events WHERE kind IN ('grant_read', 'revoke_read')").get()!.n, 0);
  await grant(own.id, board);
  await revoke(own.id, leader);
  await grant(own.id, leader);
  await revoke(own.id, board);
});

it("PASEO_AGENT_ID and card tokens cannot promote workers or scheduled agents to grantors", async () => {
  const own = worker();
  const bucket = join(dir, "agents-fixture");
  mkdirSync(bucket);
  const scheduleFile = join(bucket, "scheduled-agent.json");
  writeFileSync(scheduleFile, JSON.stringify({ id: "scheduled-agent", labels: { "paseo.schedule-id": "fixture" } }));
  process.env.KANBAN_AGENTS_DIR = dir;
  assert.equal(resolveCliIdentity({ PASEO_AGENT_ID: "scheduled-agent" }).role, "schedule");
  for (const env of [{ PASEO_AGENT_ID: "read-worker" }, { KANBAN_TOKEN: own.token }, { PASEO_AGENT_ID: "scheduled-agent" }]) {
    for (const cmd of ["grant-read", "revoke-read"]) {
      await forbidden(runKanban([cmd, String(own.id), ...(cmd === "grant-read" ? ["--scope", "project"] : [])], env));
    }
  }
  const config = loadConfig();
  saveConfig({ ...config, supervisors: { ...config.supervisors, "read-project": "scheduled-agent" } });
  // Identity resolution prefers a leader registration, but the grant still refuses the schedule label.
  assert.equal(resolveCliIdentity({ PASEO_AGENT_ID: "scheduled-agent" }).role, "supervisor");
  await forbidden(runKanban(["grant-read", String(own.id), "--scope", "project"], { PASEO_AGENT_ID: "scheduled-agent" }));
  await forbidden(runKanban(["revoke-read", String(own.id)], { PASEO_AGENT_ID: "scheduled-agent" }));
  saveConfig(config);
  await runKanban(["grant-read", cardMark(own.id), "--scope", "project"], { PASEO_AGENT_ID: leader.agentId! });
  assert.equal(getTask(own.id).project_read_scope, "project");
  await runKanban(["revoke-read", cardMark(own.id)], { PASEO_AGENT_ID: board.agentId! });
});

it("records who, when and scope in grant/revoke events and rejects invalid scopes without mutation", async () => {
  const own = worker();
  for (const scope of [undefined, "all", "other-project", true]) {
    await assert.rejects(handleTool("kanban_grant_read", { id: own.id, scope }, null, leader), /--scope project/);
  }
  await grant(own.id);
  await revoke(own.id, board);
  const detail = await handleTool("kanban_show", { id: own.id }, own.token) as { events: Array<{ kind: string; actor: string; at: string; data: string }> };
  const events = detail.events.filter(e => e.kind === "grant_read" || e.kind === "revoke_read");
  assert.deepEqual(events.map(e => [e.kind, e.actor]), [["grant_read", leader.agentId], ["revoke_read", board.agentId]]);
  for (const event of events) {
    assert.ok(Number.isFinite(Date.parse(event.at)));
    assert.deepEqual(JSON.parse(event.data), { scope: "project", project: "read-project", agentId: event.actor });
  }
});

it("checks leader registration and agent files before taking the grant/revoke write lock", () => {
  const own = worker();
  const bucket = join(dir, "agents-fixture");
  mkdirSync(bucket);
  writeFileSync(join(bucket, `${leader.agentId}.json`), JSON.stringify({ id: leader.agentId, labels: {} }));
  const db = getDb();
  const read = fs.readFileSync;
  const paths: string[] = [];
  const trap = mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => {
    assert.equal(db.isTransaction, false, `read under write lock: ${args[0]}`);
    paths.push(String(args[0]));
    return read(...args);
  });
  syncBuiltinESMExports();
  try {
    for (const revoke of [false, true]) {
      db.prepare("UPDATE tasks SET tags = ? WHERE id = ?").run(JSON.stringify(["leader-unresponsive", "keep-tag"]), own.id);
      paths.length = 0;
      assert.equal(changeReadGrant(own.id, "project", leader, revoke).project_read_scope, revoke ? null : "project");
      assert.ok(paths.some(path => path.endsWith(`${leader.agentId}.json`)));
      assert.ok(paths.some(path => path.endsWith("kanban.config.json")));
      assert.equal(getTask(own.id).tags, JSON.stringify(["keep-tag"]));
    }
  } finally { trap.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(db.isTransaction, false);
});

it("rejects grant/revoke when quiet handoff wins between validation and the write transaction", () => {
  for (const revoke of [false, true]) {
    const own = worker("executor");
    changeReadGrant(own.id, "project", leader);
    const db = getDb();
    const other = new DatabaseSync(join(dir, "kanban.db"));
    const exec = db.exec.bind(db);
    let handedOff = false;
    const trap = mock.method(db, "exec", (sql: string) => {
      if (sql === "BEGIN IMMEDIATE" && !handedOff) {
        assert.equal(db.isTransaction, false);
        other.exec("BEGIN IMMEDIATE");
        other.prepare("UPDATE tasks SET status = 'in_review' WHERE id = ?").run(own.id);
        other.prepare("INSERT INTO events(task_id, at, kind) VALUES (?, 'now', 'auto_complete')").run(own.id);
        other.exec("COMMIT");
        handedOff = true;
      }
      return exec(sql);
    });
    try {
      assert.throws(() => changeReadGrant(own.id, "project", leader, revoke),
        (err: unknown) => err instanceof KanbanError && err.code === "conflict");
      assert.equal(handedOff, true);
      assert.equal(db.isTransaction, false);
      assert.equal(getTask(own.id).status, "in_review");
      assert.equal(getTask(own.id).project_read_scope, null);
      const events = db.prepare("SELECT kind FROM events WHERE task_id = ? AND kind IN ('grant_read', 'revoke_read') ORDER BY id").all(own.id);
      assert.deepEqual(events.map(event => event.kind), ["grant_read"]);
    } finally { trap.mock.restore(); other.close(); }
  }
});

it("includes comments and event history without exposing raw identities or sensitive event fields", async () => {
  const own = worker();
  const other = card();
  addComment(other.id, "executor", "comment body");
  addComment(other.id, "hidden-agent-identity", "another comment");
  appendEvent(other.id, "request_changes", "reviewing", "rework", "hidden-agent-identity", {
    reason: "review reason", findings: "review findings", agentId: "hidden-agent-identity", token: "hidden-secret-token", env: { API_KEY: "hidden-secret-key" },
  });
  appendEvent(other.id, "other_event", null, null, "hidden-agent-identity", { password: "hidden-password" });
  getDb().prepare("INSERT INTO events(task_id, at, kind, data_json) VALUES (?, '2026-10-09T00:00:00Z', 'legacy_event', 'broken-json')").run(other.id);
  await grant(own.id);
  const shown = await handleTool("kanban_show", { id: other.id }, own.token) as RelatedView;
  assert.deepEqual(shown.comments.map(c => [c.author, c.body]), [["Executor", "comment body"], ["Board", "another comment"]]);
  assert.ok(shown.events!.some(e => e.kind === "other_event"));
  const verdict = shown.events!.find(e => e.kind === "request_changes")!;
  assert.deepEqual(verdict.data, { reason: "review reason", findings: "review findings" });
  assert.equal(verdict.fromStatus, "reviewing");
  assert.equal(verdict.toStatus, "rework");
  assert.deepEqual(shown.events!.find(e => e.kind === "legacy_event")!.data, {});
  assert.match(formatResult(shown), /Events:[\s\S]*other_event/);
  assert.doesNotMatch(JSON.stringify(shown), /hidden-|"runs"|"agentId"|"token"|"env"/);
});

it("clears the grant at complete, done and archive and never resurrects it on reopen", async () => {
  const other = card();
  const submitted = worker("executor");
  await grant(submitted.id);
  await handleTool("kanban_complete", { id: submitted.id, summary: "finished", handoff: { files: [], verification: [], risks: [] } }, submitted.token);
  assert.equal(getTask(submitted.id).status, "in_review");
  assert.equal(getTask(submitted.id).project_read_scope, null);
  await forbidden(handleTool("kanban_show", { id: other.id }, submitted.token));
  for (const status of ["done", "archived"]) {
    const own = worker();
    await grant(own.id);
    if (status === "archived") archiveTask(own.id, "supervisor");
    else getDb().prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(own.id);
    assert.equal(getTask(own.id).project_read_scope, null);
    await assert.rejects(grant(own.id), /completed or archived/);
    getDb().prepare("UPDATE tasks SET status = 'running' WHERE id = ?").run(own.id);
    assert.equal(getTask(own.id).project_read_scope, null);
    await forbidden(handleTool("kanban_show", { id: other.id }, null, { role: "reader", taskId: own.id, agentId: "read-worker" }));
  }
});

it("quiet handoff clears project reads and rework does not restore the executor's grant", async () => {
  const other = card();
  const own = worker("executor");
  getDb().prepare("UPDATE tasks SET executor_agent_id = agent_id WHERE id = ?").run(own.id);
  await grant(own.id);
  assert.equal((await handleTool("kanban_show", { id: other.id }, own.token) as RelatedView).id, other.id);
  assert.equal(settleQuietHandoff(own.id, { lastText: "Finished; handoff omitted" }), "auto_completed");
  assert.equal(getTask(own.id).status, "in_review");
  assert.equal(getTask(own.id).project_read_scope, null);
  await forbidden(handleTool("kanban_show", { id: other.id }, own.token));
  getDb().prepare("UPDATE tasks SET status = 'reviewing', agent_id = 'review-worker' WHERE id = ?").run(own.id);
  const returned = requestChanges(own.id, "Add regression coverage", "Quiet handoff must not restore grants");
  assert.equal(returned.status, "rework");
  assert.equal(returned.agent_id, "read-worker");
  assert.equal(returned.project_read_scope, null);
  await forbidden(handleTool("kanban_show", { id: other.id }, own.token));
  assert.equal((await handleTool("kanban_show", {}, own.token) as { task: { id: number } }).task.id, own.id);
});

it("does not lose existing one-hop and named-card access after revocation; grant cannot cross projects", async () => {
  const parent = card();
  const named = card();
  const foreign = card("foreign parent", "other-project");
  const own = createTask({ project: "read-project", title: `Read ${cardMark(named.id)}`, role: "reader", parentIds: [parent.id, foreign.id] });
  const token = issueToken("reader", own.id, "related-worker");
  await grant(own.id);
  await forbidden(handleTool("kanban_show", { id: foreign.id }, token));
  await revoke(own.id);
  for (const other of [parent, named]) assert.equal((await handleTool("kanban_show", { id: other.id }, token) as RelatedView).id, other.id);
});

it("upgrades an old database idempotently, preserves all data and keeps grants through reopen", async () => {
  const own = worker();
  addComment(own.id, "reader", "old comment");
  appendEvent(own.id, "old_event", null, null, "reader", { summary: "old event" });
  const before = ["tasks", "comments", "events", "tokens"].map(table => getDb().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n);
  closeDb();
  const old = new DatabaseSync(join(dir, "kanban.db"));
  old.exec("DROP TRIGGER tasks_finished_clears_project_read; DROP TRIGGER tasks_complete_clears_project_read; ALTER TABLE tasks DROP COLUMN project_read_scope;");
  old.close();
  assert.equal(getTask(own.id).project_read_scope, null);
  const columns = getDb().prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
  assert.equal(columns.filter(c => c.name === "project_read_scope").length, 1);
  const afterUpgrade = ["tasks", "comments", "events", "tokens"].map(table => getDb().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n);
  assert.deepEqual(afterUpgrade, before);
  assert.equal(getTask(own.id).title, "summary");
  await grant(own.id);
  const schema = getDb().prepare("SELECT name, sql FROM sqlite_master ORDER BY name").all();
  closeDb();
  assert.equal(getTask(own.id).project_read_scope, "project");
  assert.deepEqual(getDb().prepare("SELECT name, sql FROM sqlite_master ORDER BY name").all(), schema);
  closeDb();
  assert.equal(getTask(own.id).project_read_scope, "project");
});

it("runs the bundled public CLI and publishes both commands and MCP names", () => {
  const own = worker();
  const other = card();
  const env = { ...process.env, KANBAN_TOKEN: "", PASEO_AGENT_ID: leader.agentId! };
  const run = (args: string[], overrides: NodeJS.ProcessEnv = {}) => spawnSync(join(repo, "bin/kanban"), args, {
    cwd: root, env: { ...env, ...overrides }, encoding: "utf8", timeout: SUBPROCESS_TIMEOUT_MS,
  });
  const help = run(["--help"]);
  assert.equal(help.status, 0, help.stderr);
  assert.equal(help.stdout.trim(), kanbanHelp().trim());
  const result = run(["grant-read", cardMark(own.id), "--scope", "project", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).project_read_scope, "project");
  const shown = run(["show", cardMark(other.id), "--json"], { KANBAN_TOKEN: own.token });
  assert.equal(shown.status, 0, shown.stderr);
  assert.equal(JSON.parse(shown.stdout).id, other.id);
  const removed = run(["revoke-read", cardMark(own.id), "--json"]);
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(JSON.parse(removed.stdout).project_read_scope, null);
  const denied = run(["show", cardMark(other.id), "--json"], { KANBAN_TOKEN: own.token });
  assert.equal(denied.status, 1);
  assert.equal(JSON.parse(denied.stderr).error, "forbidden");
  for (const name of ["kanban_grant_read", "kanban_revoke_read"]) {
    assert.ok(toolDefs().some(tool => tool.name === name));
    assert.equal(canonicalKanbanTool(`mcp__kanban__${name}`), name);
  }
});
