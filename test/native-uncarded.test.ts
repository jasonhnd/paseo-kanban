import { zhCN, zhCNPart, localePattern } from "./helpers/locale";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, it, mock } from "node:test";
import { syncBuiltinESMExports } from "node:module";
import { closeDb, getDb } from "../server/db";
import { appendEvent, createTask } from "../server/store";
import { nativeSessionsCommand, NATIVE_MAX_ATTEMPTS, UNCARDED_TASK_ID } from "../server/native-sessions";
import { loadConfig, saveConfig } from "../server/config";
import { runKanban } from "../server/cli";

// Sessions of agents that belong to no card, /tmp test residue and --reconcile-claude, all on a temporary HOME.
const root = fs.mkdtempSync(join(tmpdir(), "kanban-native-uncarded-"));
const original = { ...process.env };
let home: string; let tmpRoot: string; let serial = 0;
const DAY = 24 * 60 * 60_000;
const encode = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, "-");
beforeEach(() => {
  closeDb(); mock.restoreAll(); syncBuiltinESMExports();
  home = join(root, String(++serial)); fs.mkdirSync(home, { recursive: true });
  tmpRoot = join(home, "faketmp"); fs.mkdirSync(tmpRoot);
  process.env.HOME = home;
  process.env.KANBAN_DATA_DIR = join(home, "db");
  process.env.KANBAN_AGENTS_DIR = join(home, "agents");
  fs.mkdirSync(join(home, "agents", "test"), { recursive: true });
  getDb(); // create the board database so read-only sweeps can open it
});
after(() => { closeDb(); mock.restoreAll(); syncBuiltinESMExports(); process.env = original; fs.rmSync(root, { recursive: true, force: true }); });

function agentFile(id: string, over: Record<string, unknown> = {}) {
  const sessionId = `session-${id}`;
  const agent = { id, provider: "claude", cwd: "/work/hand", title: "Manual session", labels: {}, persistence: { sessionId }, archivedAt: "2026-01-01", lastStatus: "idle", ...over };
  fs.writeFileSync(join(home, "agents/test", `${id}.json`), JSON.stringify(agent));
  return { id, sessionId: String((agent.persistence as { sessionId: string }).sessionId), cwd: String(agent.cwd) };
}
function jsonl(cwd: string, sessionId: string, ageMs = 0) {
  const dir = join(home, ".claude/projects", encode(cwd));
  fs.mkdirSync(join(dir, sessionId), { recursive: true });
  const source = join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(source, "{\"test\":true}\n"); fs.writeFileSync(join(dir, sessionId, "attachment.txt"), "kept");
  const when = new Date(Date.now() - ageMs); fs.utimesSync(source, when, when);
  return { dir, source, companion: join(dir, sessionId) };
}
function sweep(extra: Record<string, unknown> = {}, env: NodeJS.ProcessEnv = {}) {
  return nativeSessionsCommand({ sweep: true, ...extra }, env, { home, tmpRoots: [tmpRoot, join(home, "private", "tmp")] });
}
function actions(result: Awaited<ReturnType<typeof sweep>>) {
  assert.ok("lines" in result);
  return Object.fromEntries((result.lines as Array<{ sessionId?: string; agentId?: string; action: string }>).map(line => [line.sessionId ?? line.agentId, line.action]));
}
function events(kind: string, taskId = UNCARDED_TASK_ID) {
  return (getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = ? ORDER BY id").all(taskId, kind) as Array<{ data_json: string }>).map(row => JSON.parse(row.data_json));
}

function failedUncardedSession() {
  const a = agentFile("failed-hand");
  const moves = JSON.stringify([{ source: "/original/session.jsonl", target: "/archive/session.jsonl" }]);
  getDb().prepare(`INSERT INTO native_session_queue
    (agent_id, task_id, provider, session_id, cwd, home, status, retirement, moves_json, attempts, retry_at, last_error)
    VALUES (?, ?, 'claude', ?, ?, ?, 'failed', 'sweep_confirmed', ?, ?, 123, 'inspect first')`)
    .run(a.id, UNCARDED_TASK_ID, a.sessionId, a.cwd, home, moves, NATIVE_MAX_ATTEMPTS);
  return { ...a, row: () => getDb().prepare("SELECT * FROM native_session_queue WHERE agent_id = ?").get(a.id)! };
}

for (const caller of ["terminal", "board-leader"]) {
  it(`reset-failed lets ${caller} preview and reset an uncarded failed session without losing recovery metadata`, async () => {
    saveConfig({ ...loadConfig(), supervisorAgentId: "board-leader", supervisors: { "native-test": "project-leader" } });
    const f = failedUncardedSession(); const before = f.row();
    const env = caller === "terminal" ? {} : { PASEO_AGENT_ID: caller };
    assert.equal(getDb().prepare("SELECT id FROM tasks WHERE id = ?").get(UNCARDED_TASK_ID), undefined);
    closeDb();
    const preview = await runKanban(["native-sessions", "--reset-failed", f.id, "--dry-run"], env);
    assert.ok(preview && typeof preview === "object" && "dryRun" in preview && preview.dryRun === true && "taskId" in preview && preview.taskId === UNCARDED_TASK_ID);
    assert.deepEqual(f.row(), before); assert.equal(events("native_session_reset").length, 0);
    const reset = await runKanban(["native-sessions", "--reset-failed", f.id], env);
    assert.ok(reset && typeof reset === "object" && "reset" in reset && reset.reset === true);
    assert.deepEqual({ ...f.row() }, { ...before, status: "pending", attempts: 0, retry_at: 0 });
    const audit = events("native_session_reset"); assert.equal(audit.length, 1);
    assert.equal(audit[0].previousAttempts, NATIVE_MAX_ATTEMPTS); assert.equal(audit[0].previousRetryAt, 123);
    assert.equal(audit[0].lastError, "inspect first"); assert.equal(audit[0].sessionId, f.sessionId);
    assert.equal(getDb().prepare("SELECT actor FROM events WHERE kind = 'native_session_reset'").get()!.actor, caller === "terminal" ? "supervisor" : caller);
    await assert.rejects(runKanban(["native-sessions", "--reset-failed", f.id], env), new RegExp(localePattern(zhCNPart("nativeSessions.reset.onlyFailed", 0, 11))));
    assert.equal(events("native_session_reset").length, 1);
  });
}

it("reset-failed denies project leaders access to uncarded sessions for both preview and apply", async () => {
  saveConfig({ ...loadConfig(), supervisorAgentId: "board-leader", supervisors: { "native-test": "project-leader" } });
  const f = failedUncardedSession(); const before = f.row();
  for (const dryRun of [true, false]) {
    await assert.rejects(nativeSessionsCommand({ resetFailed: f.id, dryRun }, { PASEO_AGENT_ID: "project-leader" }),
      { code: "forbidden", message: new RegExp(zhCN("tools.result.noCards") + ".*Kanban <leader>") });
    assert.deepEqual(f.row(), before); assert.equal(events("native_session_reset").length, 0);
  }
});

it("reset-failed still refuses a missing nonzero card", async () => {
  const f = failedUncardedSession();
  getDb().prepare("UPDATE native_session_queue SET task_id = 999 WHERE agent_id = ?").run(f.id);
  const before = f.row();
  for (const dryRun of [true, false]) {
    await assert.rejects(nativeSessionsCommand({ resetFailed: f.id, dryRun }, {}), new RegExp(localePattern(zhCNPart("nativeSessions.reset.cardMissing", 6, 14))));
    assert.deepEqual(f.row(), before);
  }
  assert.equal(events("native_session_reset", 999).length, 0);
});

it("an archived hand-opened agent without a card is collected on apply, journaled under the uncarded id, and restorable", async () => {
  const a = agentFile("hand-1"); const files = jsonl(a.cwd, a.sessionId);
  const dry = await sweep();
  assert.deepEqual(actions(dry), { [a.sessionId]: "archive" });
  assert.ok(fs.existsSync(files.source)); assert.equal(fs.existsSync(join(home, ".claude/projects-archive")), false);
  assert.equal(getDb().prepare("SELECT count(*) AS n FROM native_session_queue").get()!.n, 0);

  assert.deepEqual(actions(await sweep({ apply: true })), { [a.sessionId]: "archived" });
  assert.equal(fs.existsSync(files.source), false); assert.equal(fs.existsSync(files.companion), false);
  assert.equal(getDb().prepare("SELECT status FROM native_session_queue WHERE agent_id = ?").get(a.id)!.status, "archived");
  assert.equal(events("native_session_archived").length, 1);

  assert.deepEqual(actions(await sweep({ apply: true })), {}); // already queued: nothing to do, nothing re-collected
  await nativeSessionsCommand({ restore: a.sessionId }, {}, { home });
  assert.equal(fs.readFileSync(files.source, "utf8"), "{\"test\":true}\n"); assert.equal(fs.readFileSync(join(files.companion, "attachment.txt"), "utf8"), "kept");
  assert.equal(getDb().prepare("SELECT status FROM native_session_queue WHERE agent_id = ?").get(a.id)!.status, "restored");
  assert.deepEqual(actions(await sweep({ apply: true })), {}); // restored sessions are not collected again
  assert.ok(fs.existsSync(files.source));
});

it("current leaders and sessions shared with them, running and live agents, and card-owned agents are kept; a replaced old leader is collected", async () => {
  saveConfig({ ...loadConfig(), supervisorAgentId: "board-leader", supervisors: { "native-test": "project-leader" } });
  const board = agentFile("board-leader", { title: "<leader> · Kanban" }); const project = agentFile("project-leader", { title: "<leader> · native-test" });
  const sharing = agentFile("sharer", { persistence: { sessionId: project.sessionId } });
  const old = agentFile("old-leader", { title: "<leader> · native-test" });
  const running = agentFile("runner", { archivedAt: null, lastStatus: "running" });
  const idle = agentFile("idle-live", { archivedAt: null });
  const labelled = agentFile("labelled", { labels: { kanban: "1", kanban_task: "999" } });
  const task = createTask({ project: "native-test", title: "demo fixture", role: "executor", workspacePath: "/work/hand" });
  const owned = agentFile("card-agent"); appendEvent(task.id, "agent_opened", null, null, "kanban", { agentId: owned.id });
  const all = [board, project, sharing, old, running, idle, labelled, owned];
  for (const item of all) jsonl(item.cwd, item.sessionId);
  const result = await sweep({ apply: true });
  assert.deepEqual(actions(result), { [old.sessionId]: "archived", [project.sessionId]: "skip" /* sharer, keyed by its session */, [board.id]: "skip", [project.id]: "skip" });
  for (const item of all) assert.equal(fs.existsSync(join(home, ".claude/projects", encode(item.cwd), `${item.sessionId}.jsonl`)), item.id !== old.id);
  assert.ok("summary" in result);
  assert.equal(result.summary.skipReasons.leader_kept, 3);
  assert.equal(result.summary.uncarded!.cardOwned, 2);
});

it("only the board-wide Kanban leader collects uncarded sessions; project leaders and --project sweeps do not", async () => {
  saveConfig({ ...loadConfig(), supervisorAgentId: "board-leader", supervisors: { "native-test": "project-leader" } });
  const a = agentFile("hand-2"); const files = jsonl(a.cwd, a.sessionId);
  createTask({ project: "native-test", title: "placeholder", role: "executor", workspacePath: "/work/x" });
  assert.deepEqual(actions(await sweep({ apply: true }, { PASEO_AGENT_ID: "project-leader" })), {});
  assert.deepEqual(actions(await sweep({ apply: true, project: "native-test" }, { PASEO_AGENT_ID: "board-leader" })), {});
  assert.ok(fs.existsSync(files.source));
  assert.deepEqual(actions(await sweep({ apply: true }, { PASEO_AGENT_ID: "board-leader" })), { [a.sessionId]: "archived" });
  await assert.rejects(nativeSessionsCommand({ restore: a.sessionId }, { PASEO_AGENT_ID: "project-leader" }, { home }), /Kanban <leader>/);
  await nativeSessionsCommand({ restore: a.sessionId }, { PASEO_AGENT_ID: "board-leader" }, { home });
  assert.ok(fs.existsSync(files.source));
});

it("/tmp test residue is collected only with --include-tmp-sessions, only when the cwd is gone and the session is over a day old", async () => {
  const gone = join(tmpRoot, "harness-gone"); const live = join(tmpRoot, "harness-live"); const fresh = join(tmpRoot, "harness-fresh");
  fs.mkdirSync(live); // this cwd still exists
  const old = jsonl(gone, "sess-gone", 3 * DAY); const kept = jsonl(live, "sess-live", 3 * DAY); const recent = jsonl(fresh, "sess-fresh", DAY / 2);
  const outside = jsonl("/Users/example/projects/not-tmp", "sess-outside", 30 * DAY);

  assert.deepEqual(actions(await sweep({ apply: true })), {}); // off by default
  assert.ok(fs.existsSync(old.source));
  const dry = await sweep({ includeTmpSessions: true });
  assert.deepEqual(actions(dry), { "sess-gone": "archive" }); assert.ok(fs.existsSync(old.source));
  assert.deepEqual(actions(await sweep({ includeTmpSessions: true, apply: true })), { "sess-gone": "archived" });
  assert.equal(fs.existsSync(old.source), false);
  for (const item of [kept, recent, outside]) assert.ok(fs.existsSync(item.source));

  await nativeSessionsCommand({ restore: "sess-gone" }, {}, { home });
  assert.equal(fs.readFileSync(old.source, "utf8"), "{\"test\":true}\n"); assert.equal(fs.readFileSync(join(old.companion, "attachment.txt"), "utf8"), "kept");
  assert.deepEqual(actions(await sweep({ includeTmpSessions: true, apply: true })), {}); // restored: not collected again
  await assert.rejects(nativeSessionsCommand({ includeTmpSessions: true, restore: "x" }, {}, { home }), /--include-tmp-sessions/);
});

it("a still-existing cwd that only looks like /tmp (/tmp-work, /private/tmp-work, /tmp_x) is never collected, in dry-run or apply, while a deleted real tmp dir still is", async () => {
  // Same encoding as <root>/work/...: "-" stands for "/", "-", "_" alike, so only existence anywhere on disk can tell them apart.
  const sibling = `${tmpRoot}-work`; const privateSibling = join(home, "private", "tmp-work"); const underscore = `${tmpRoot}_x`;
  const lookalikes = [join(sibling, "live-project"), join(privateSibling, "live-project"), join(underscore, "live-project")];
  for (const cwd of lookalikes) fs.mkdirSync(cwd, { recursive: true });
  const kept = lookalikes.map((cwd, i) => jsonl(cwd, `sess-lookalike-${i}`, 5 * DAY));
  const gone = jsonl(join(tmpRoot, "work", "deleted-project"), "sess-deleted", 5 * DAY);
  const dry = await sweep({ includeTmpSessions: true });
  assert.deepEqual(actions(dry), { "sess-deleted": "archive" });
  assert.deepEqual(actions(await sweep({ includeTmpSessions: true, apply: true })), { "sess-deleted": "archived" });
  for (const item of kept) assert.ok(fs.existsSync(item.source));
  assert.equal(fs.existsSync(gone.source), false);
  for (const cwd of lookalikes) assert.ok(fs.existsSync(cwd));
  // The real root (/private/tmp style) with an existing cwd is also kept.
  const live = join(home, "private", "tmp", "work", "live-too"); fs.mkdirSync(live, { recursive: true });
  const liveFiles = jsonl(live, "sess-live-private", 5 * DAY);
  assert.deepEqual(actions(await sweep({ includeTmpSessions: true, apply: true })), {}); assert.ok(fs.existsSync(liveFiles.source));
});

it("a tmp residue session still shared by a live agent is kept", async () => {
  const gone = join(tmpRoot, "shared-gone"); const files = jsonl(gone, "sess-shared", 3 * DAY);
  agentFile("live-user", { cwd: gone, archivedAt: null, persistence: { sessionId: "sess-shared" } });
  const result = await sweep({ includeTmpSessions: true, apply: true });
  assert.deepEqual(actions(result), { "sess-shared": "skip" });
  assert.ok("summary" in result); assert.equal(result.summary.skipReasons.shared_kept, 1);
  assert.ok(fs.existsSync(files.source));
});

it("skip reasons are counted separately: provider unsupported, no sessionId, leader, shared", async () => {
  saveConfig({ ...loadConfig(), supervisorAgentId: "board-leader" });
  const task = createTask({ project: "native-test", title: "sample", role: "executor", workspacePath: "/work/card" });
  getDb().prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(task.id);
  appendEvent(task.id, "cleanup_finished", null, null, "kanban", {});
  const open = (id: string, over: Record<string, unknown>) => {
    const item = agentFile(id, { cwd: "/work/card", ...over }); appendEvent(task.id, "agent_opened", null, null, "kanban", { agentId: id });
    appendEvent(task.id, "cleanup", null, null, "kanban", { action: "archive_agent", agentId: id, ok: true }); return item;
  };
  open("c-cursor", { provider: "cursor" }); open("c-nosid", { persistence: {} });
  open("c-leader", { title: "<leader> · native-test" });
  const shared = open("c-shared", {}); jsonl("/work/card", shared.sessionId);
  agentFile("user-peer", { cwd: "/work/card", archivedAt: null, persistence: { sessionId: shared.sessionId } });
  const result = await sweep();
  assert.ok("summary" in result);
  assert.deepEqual(result.summary.skipReasons, { provider_unsupported: 1, no_session_id: 1, leader_kept: 1, shared_kept: 1 });
  for (const part of [(zhCN("nativeSessions.skipLabel.providerUnsupported") + " 1"), (zhCN("nativeSessions.skipLabel.noSessionId") + " 1"), (zhCN("nativeSessions.skipLabel.leaderKept") + " 1"), (zhCN("nativeSessions.skipLabel.sharedKept") + " 1")]) assert.ok(result.text.includes(part), part);
});

function pendingRow(sessionId: string, cwd: string, taskId: number) {
  getDb().prepare("INSERT INTO native_session_queue(agent_id, task_id, home, provider, session_id, cwd, status, retirement) VALUES (?, ?, ?, 'claude', ?, ?, 'pending', 'archive_succeeded')")
    .run(`agent-${sessionId}`, taskId, home, sessionId, cwd);
}
function archivedCopy(cwd: string, sessionId: string, suffix = ".11111111-aaaa") {
  const archive = join(home, ".claude/projects-archive", encode(cwd));
  fs.mkdirSync(join(archive, `${sessionId}${suffix}`), { recursive: true });
  fs.writeFileSync(join(archive, `${sessionId}${suffix}.jsonl`), "{\"moved\":true}\n"); fs.writeFileSync(join(archive, `${sessionId}${suffix}`, "attachment.txt"), "kept");
  return archive;
}
const rowStatus = (agentId: string) => (getDb().prepare("SELECT status FROM native_session_queue WHERE agent_id = ?").get(agentId) as { status: string }).status;

it("reconcile-claude dry-run lists, apply marks only rows whose jsonl moved to projects-archive, touches no files, and restore puts it back", async () => {
  const task = createTask({ project: "native-test", title: "demo fixture", role: "executor", workspacePath: "/work/rec" });
  const moved = "sess-moved"; const present = "sess-present"; const missing = "sess-missing"; const noCard = "sess-nocard";
  pendingRow(moved, "/work/rec", task.id); pendingRow(present, "/work/rec", task.id); pendingRow(missing, "/work/rec", task.id); pendingRow(noCard, "/work/hand", UNCARDED_TASK_ID);
  archivedCopy("/work/rec", moved); archivedCopy("/work/hand", noCard);
  const live = jsonl("/work/rec", present); archivedCopy("/work/rec", present, ".22222222-bbbb"); // live file still exists: leave pending
  saveConfig({ ...loadConfig(), supervisorAgentId: "board-leader", supervisors: { "native-test": "project-leader" } });
  const board = { PASEO_AGENT_ID: "board-leader" };
  const snapshot = () => JSON.stringify([fs.readdirSync(join(home, ".claude/projects-archive/-work-rec")).sort(), fs.existsSync(live.source)]);
  const before = snapshot();

  const dry = await nativeSessionsCommand({ reconcileClaude: true }, board, { home }); assert.ok("lines" in dry);
  assert.deepEqual(dry.lines.map(l => (l as { sessionId: string }).sessionId).sort(), [moved, noCard].sort());
  assert.equal(rowStatus(`agent-${moved}`), "pending"); assert.equal(events("native_session_archived", task.id).length, 0);

  await nativeSessionsCommand({ reconcileClaude: true, apply: true }, board, { home });
  assert.equal(rowStatus(`agent-${moved}`), "archived"); assert.equal(rowStatus(`agent-${noCard}`), "archived");
  assert.equal(rowStatus(`agent-${present}`), "pending"); assert.equal(rowStatus(`agent-${missing}`), "pending");
  assert.equal(snapshot(), before); // only the board database changed
  const [event] = events("native_session_archived", task.id); assert.equal(event.moves.length, 2); assert.match(event.action, /reconcile: claude/);
  const again = await nativeSessionsCommand({ reconcileClaude: true, apply: true }, board, { home }); assert.ok("lines" in again); assert.equal(again.lines.length, 0);

  await nativeSessionsCommand({ restore: moved }, board, { home });
  assert.equal(fs.readFileSync(join(home, ".claude/projects/-work-rec", `${moved}.jsonl`), "utf8"), "{\"moved\":true}\n");
  assert.equal(fs.readFileSync(join(home, ".claude/projects/-work-rec", moved, "attachment.txt"), "utf8"), "kept");
  assert.equal(rowStatus(`agent-${moved}`), "restored");
});

it("reconcile-claude is leader-only, project leaders see only their projects, and it rejects paging or sweep flags", async () => {
  const task = createTask({ project: "native-test", title: "demo fixture", role: "executor", workspacePath: "/work/rec" });
  pendingRow("sess-a", "/work/rec", task.id); pendingRow("sess-b", "/work/hand", UNCARDED_TASK_ID); archivedCopy("/work/rec", "sess-a"); archivedCopy("/work/hand", "sess-b");
  saveConfig({ ...loadConfig(), supervisorAgentId: "board-leader", supervisors: { "native-test": "project-leader" } });
  const own = await nativeSessionsCommand({ reconcileClaude: true }, { PASEO_AGENT_ID: "project-leader" }, { home }); assert.ok("lines" in own);
  assert.deepEqual(own.lines.map(l => (l as { sessionId: string }).sessionId), ["sess-a"]);
  await assert.rejects(nativeSessionsCommand({ reconcileClaude: true }, { PASEO_AGENT_ID: "nobody" }, { home }), new RegExp(localePattern(zhCNPart("nativeSessions.scope.mustRegister", 0, 3))));
  await assert.rejects(nativeSessionsCommand({ reconcileClaude: true, limit: 1 }, {}, { home }), new RegExp(localePattern(zhCNPart("nativeSessions.cli.applyOnly", 7, 18))));
  await assert.rejects(nativeSessionsCommand({ reconcileClaude: true, sweep: true }, {}, { home }), new RegExp(localePattern(zhCNPart("nativeSessions.cli.pickOne", 121, 127))));
  await runKanban(["native-sessions", "--reconcile-claude"], { PASEO_AGENT_ID: "board-leader" });
});
