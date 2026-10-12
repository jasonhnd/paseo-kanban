import { zhCN, zhCNPart, localePattern } from "./helpers/locale";
import { execFile } from "node:child_process";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { after, beforeEach, it, mock } from "node:test";
import { closeDb, getDb } from "../server/db";
import { appendEvent, createTask } from "../server/store";
import { nativeSessionAfterArchive, nativeRetryDelayMs, NATIVE_MAX_ATTEMPTS, NATIVE_TRANSIENT_RETRY_MS, nativeSessionsCommand, prepareNativeSession, processNativeSessionBatch, removeArchivedClaudeProjects } from "../server/native-sessions";
import { indexNativeAgents, sessionKey } from "../server/native-agent-index";
import { purgeAgent, setMissingCwdHooks } from "../server/missing-cwd";
import { drainCleanups, installCleanup } from "../server/cleanup";
import { runKanban } from "../server/cli";
import { loadConfig, saveConfig } from "../server/config";
import { assertNativePerformance, calibrateIo, measureIoProbe, performanceLoadGate, samplePerformanceLoad } from "./helpers/performance-load";

const root = fs.mkdtempSync(join(tmpdir(), "kanban-native-"));
const original = { ...process.env };
let home: string; let serial = 0;
beforeEach(() => {
  closeDb(); mock.restoreAll(); syncBuiltinESMExports(); setMissingCwdHooks(null);
  home = join(root, String(++serial)); fs.mkdirSync(home, { recursive: true });
  process.env.HOME = home;
  process.env.KANBAN_DATA_DIR = join(home, "db");
  process.env.KANBAN_AGENTS_DIR = join(home, "agents");
  fs.mkdirSync(join(home, "agents", "test"), { recursive: true });
});
after(() => { closeDb(); mock.restoreAll(); syncBuiltinESMExports(); setMissingCwdHooks(null); process.env = original; fs.rmSync(root, { recursive: true, force: true }); });
function fixture(provider = "claude", overrides: Record<string, unknown> = {}, owned = true) {
  const task = createTask({ project: "native-test", title: "Native archive", role: "executor", workspacePath: "/work/test_dir" });
  const agentId = `agent-${task.id}`; const sessionId = `session-${task.id}`;
  const agent = { id: agentId, provider, cwd: "/work/test_dir", title: zhCN("labels.role.executor"), labels: {}, persistence: { sessionId }, archivedAt: "2026-01-01", ...overrides };
  const path = join(home, "agents/test", `${agentId}.json`); fs.writeFileSync(path, JSON.stringify(agent));
  if (owned) appendEvent(task.id, "agent_opened", null, null, "kanban", { agentId });
  getDb().prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(task.id);
  appendEvent(task.id, "cleanup", null, null, "kanban", { action: "archive_agent", agentId, ok: true });
  appendEvent(task.id, "cleanup_finished", null, null, "kanban", {});
  return { task, agentId, sessionId, agent, path };
}
function claudeFiles(sessionId: string) {
  const dir = join(home, ".claude/projects/-work-test-dir");
  fs.mkdirSync(join(dir, sessionId), { recursive: true });
  const source = join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(source, "{\"test\":true}\n"); fs.writeFileSync(join(dir, sessionId, "attachment.txt"), "preserved");
  return { dir, source, companion: join(dir, sessionId) };
}
function codexThread(sessionId: string, cwd = "/work/test_dir") {
  fs.mkdirSync(join(home, ".codex"), { recursive: true });
  const db = new DatabaseSync(join(home, ".codex/state_5.sqlite"));
  db.exec("CREATE TABLE IF NOT EXISTS threads(id TEXT PRIMARY KEY, cwd TEXT, archived INTEGER)");
  db.prepare("INSERT INTO threads VALUES (?, ?, 0)").run(sessionId, cwd); db.close();
}
function events(id: number, kind: string) {
  return (getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = ? ORDER BY id").all(id, kind) as Array<{ data_json: string }>).map(row => JSON.parse(row.data_json));
}
async function queue(f: ReturnType<typeof fixture>) { await prepareNativeSession(f.task.id, f.agentId); nativeSessionAfterArchive(f.task.id, f.agentId); }
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

it("Kanban leader sweeps all projects; project leaders stay scoped and foreign or empty projects fail explicitly", async () => {
  const a = fixture(); claudeFiles(a.sessionId);
  const b = fixture(); claudeFiles(b.sessionId);
  getDb().prepare("UPDATE tasks SET project = 'foreign' WHERE id = ?").run(b.task.id);
  saveConfig({ ...loadConfig(), supervisorAgentId: "board-leader", supervisors: { "native-test": "project-leader", foreign: "foreign-leader" } });
  const board = { PASEO_AGENT_ID: "board-leader" }; const project = { PASEO_AGENT_ID: "project-leader" };
  for (const input of [{ sweep: true }, { sweep: true, project: "foreign" }]) {
    const result = await nativeSessionsCommand(input, board); assert.ok("summary" in result);
    assert.equal(result.summary.tasks, input.project ? 1 : 2);
  }
  const own = await nativeSessionsCommand({ sweep: true }, project); assert.ok("summary" in own); assert.equal(own.summary.tasks, 1);
  for (const apply of [false, true]) for (const name of ["foreign", "empty-foreign"]) {
    await assert.rejects(nativeSessionsCommand({ sweep: true, project: name, apply }, project), new RegExp(localePattern(zhCNPart("nativeSessions.scope.otherProject", 0, 8))));
  }
  await assert.rejects(nativeSessionsCommand({ sweep: true }, { PASEO_AGENT_ID: "unregistered" }), new RegExp(localePattern(zhCNPart("nativeSessions.scope.mustRegister", 0, 3))));
  await nativeSessionsCommand({ sweep: true, apply: true, project: "foreign" }, board);
  assert.equal(events(b.task.id, "native_session_archived").length, 1);
  await assert.rejects(nativeSessionsCommand({ restore: b.sessionId }, project), new RegExp(localePattern(zhCNPart("nativeSessions.scope.otherProject", 0, 8))));
  await nativeSessionsCommand({ restore: b.sessionId }, board);
  await nativeSessionsCommand({ sweep: true, apply: true }, board);
  assert.equal(events(a.task.id, "native_session_archived").length, 1);
});

it("unsupported providers are skipped on capture, including an earlier unknown handle; old pending rows migrate once", async () => {
  for (const provider of ["cursor", "grok", "antigravity"]) {
    const f = fixture(provider);
    getDb().prepare("INSERT INTO native_session_queue(agent_id, task_id, home) VALUES (?, ?, ?)").run(f.agentId, f.task.id, home);
    await queue(f);
    const row = getDb().prepare("SELECT status, provider FROM native_session_queue WHERE agent_id = ?").get(f.agentId);
    assert.deepEqual({ ...row }, { status: "skipped", provider });
    assert.equal(events(f.task.id, "native_session_skipped")[0].reason, zhCN("nativeSessions.skip.noNativeSession"));
    await queue(f); assert.equal(events(f.task.id, "native_session_skipped").length, 1);
    getDb().prepare("UPDATE native_session_queue SET status = 'pending', retry_at = 999, attempts = 2, last_error = 'old' WHERE agent_id = ?").run(f.agentId);
  }
  const unknown = fixture("codex");
  getDb().prepare("INSERT INTO native_session_queue(agent_id, task_id, home, status) VALUES (?, ?, ?, 'pending')").run(unknown.agentId, unknown.task.id, home);
  closeDb();
  const migrated = getDb().prepare("SELECT status, retry_at, last_error FROM native_session_queue WHERE provider != ''").all();
  assert.equal(migrated.length, 3); for (const row of migrated) assert.deepEqual({ ...row }, { status: "skipped", retry_at: 0, last_error: null });
  const count = getDb().prepare("SELECT count(*) AS n FROM events WHERE kind = 'native_session_skipped'").get(); closeDb();
  assert.deepEqual(getDb().prepare("SELECT count(*) AS n FROM events WHERE kind = 'native_session_skipped'").get(), count);
  assert.equal((getDb().prepare("SELECT status FROM native_session_queue WHERE agent_id = ?").get(unknown.agentId) as { status: string }).status, "pending");
});
it("a cold sweep dry-run does not migrate unsupported pending providers", async () => {
  const f = fixture("cursor");
  getDb().prepare("INSERT INTO native_session_queue(agent_id, task_id, home, provider, status) VALUES (?, ?, ?, 'cursor', 'pending')").run(f.agentId, f.task.id, home);
  closeDb(); await nativeSessionsCommand({ sweep: true, dryRun: true }, {});
  const check = new DatabaseSync(join(home, "db/kanban.db"), { readOnly: true });
  try {
    assert.equal(check.prepare("SELECT status FROM native_session_queue WHERE agent_id = ?").get(f.agentId)!.status, "pending");
    assert.equal(check.prepare("SELECT count(*) AS n FROM events WHERE kind = 'native_session_skipped'").get()!.n, 0);
  } finally { check.close(); }
  assert.equal(getDb().prepare("SELECT status FROM native_session_queue WHERE agent_id = ?").get(f.agentId)!.status, "skipped");
});

function tempClaude(cleaned = true) {
  const next = Number(getDb().prepare("SELECT count(*) AS n FROM tasks").get()!.n) + 1;
  const cwd = `/Users/example/.paseo/worktrees/abc/kanban-TEST-0101-${next}`;
  const f = fixture("claude", { cwd });
  appendEvent(f.task.id, "temp_workspace", null, null, "kanban", { directory: cwd });
  if (cleaned) appendEvent(f.task.id, "temp_workspace_cleaned", null, null, "kanban", { directory: cwd });
  const dir = join(home, ".claude/projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  fs.mkdirSync(dir, { recursive: true }); const source = join(dir, `${f.sessionId}.jsonl`); fs.writeFileSync(source, "keep exact bytes");
  return { ...f, dir, source };
}
it("automatic and sweep archive remove only empty Claude dirs for successfully cleaned temp workspaces, and restore recreates them", async () => {
  for (const sweep of [false, true]) {
    const f = tempClaude();
    if (sweep) await nativeSessionsCommand({ sweep: true, apply: true }, {});
    else { await queue(f); await processNativeSessionBatch(); }
    assert.equal(fs.existsSync(f.dir), false);
    assert.equal(events(f.task.id, "native_session_project_dir_removed")[0].directory, f.dir);
    assert.equal(events(f.task.id, "native_session_archived")[0].removedProjectDir, f.dir);
    await nativeSessionsCommand({ restore: f.sessionId }, {});
    assert.equal(fs.readFileSync(f.source, "utf8"), "keep exact bytes");
  }
});
it("nonempty, uncleaned, falsely matched and reused Claude worktree dirs are retained", async () => {
  for (const scenario of ["nonempty", "uncleaned", "different-cleanup", "reused"]) {
    const f = tempClaude(false);
    if (scenario !== "uncleaned") appendEvent(f.task.id, "temp_workspace_cleaned", null, null, "kanban", { directory: scenario === "different-cleanup" ? "/other/.paseo/worktrees/copy" : f.agent.cwd });
    if (scenario === "nonempty") fs.writeFileSync(join(f.dir, "unrelated.txt"), "retain");
    if (scenario === "reused") appendEvent(f.task.id, "temp_workspace", null, null, "kanban", { directory: f.agent.cwd });
    await queue(f); await processNativeSessionBatch();
    assert.ok(fs.existsSync(f.dir)); assert.equal(events(f.task.id, "native_session_project_dir_removed").length, 0);
  }
  const ordinary = fixture(); const paths = claudeFiles(ordinary.sessionId);
  appendEvent(ordinary.task.id, "temp_workspace", null, null, "kanban", { directory: ordinary.agent.cwd });
  appendEvent(ordinary.task.id, "temp_workspace_cleaned", null, null, "kanban", { directory: ordinary.agent.cwd });
  await queue(ordinary); await processNativeSessionBatch(); assert.ok(fs.existsSync(paths.dir));
});
it("workspace cleanup after native archive and historical sweep apply also remove the empty project directory", async () => {
  for (const sweep of [false, true]) {
    const f = tempClaude(false); await queue(f); await processNativeSessionBatch(); assert.ok(fs.existsSync(f.dir));
    appendEvent(f.task.id, "temp_workspace_cleaned", null, null, "kanban", { directory: f.agent.cwd });
    if (sweep) {
      const dry = await nativeSessionsCommand({ sweep: true }, {}); assert.ok("summary" in dry); assert.ok(fs.existsSync(f.dir));
      await nativeSessionsCommand({ sweep: true, apply: true }, {});
    } else await removeArchivedClaudeProjects(f.agent.cwd);
    assert.equal(fs.existsSync(f.dir), false); assert.equal(events(f.task.id, "native_session_project_dir_removed").length, 1);
    await nativeSessionsCommand({ restore: f.sessionId }, {}); assert.ok(fs.existsSync(f.source));
    await removeArchivedClaudeProjects(f.agent.cwd); assert.ok(fs.existsSync(f.dir));
  }
});

function manualManifest(fixtures: ReturnType<typeof tempClaude>[], companion = false) {
  const items = fixtures.map(f => {
    const archive = join(home, ".claude/projects-archive", f.agent.cwd.replace(/[^a-zA-Z0-9]/g, "-"));
    fs.mkdirSync(archive, { recursive: true });
    const moves = [[f.source, join(archive, `${f.sessionId}.jsonl`)]];
    if (companion) {
      const source = join(f.dir, f.sessionId); fs.mkdirSync(source); fs.writeFileSync(join(source, "attachment"), "manual attachment");
      moves.push([source, join(archive, f.sessionId)]);
    }
    for (const [source, target] of moves) fs.renameSync(source, target);
    fs.rmdirSync(f.dir);
    return { sessionId: f.sessionId, project: f.agent.cwd.replace(/[^a-zA-Z0-9]/g, "-"), moves };
  });
  const path = join(home, "manual-archive.json");
  fs.writeFileSync(path, JSON.stringify({ at: "2026-10-02", items, removedEmptyProjectDirs: fixtures.map(f => f.dir) }));
  return { path, items };
}
it("restore-manifest CLI dry-run is read-only; apply recreates dirs, restores jsonl/companion, and prevents recapture", async () => {
  const f = tempClaude(); const manifest = manualManifest([f], true);
  const changes = getDb().prepare("SELECT total_changes() AS n").get();
  const dry = await runKanban(["native-sessions", "--restore-manifest", manifest.path, "--dry-run"], {});
  assert.equal((dry as { dryRun: boolean }).dryRun, true); assert.equal(fs.existsSync(f.dir), false);
  assert.deepEqual(getDb().prepare("SELECT total_changes() AS n").get(), changes);
  const restored = await runKanban(["native-sessions", "--restore-manifest", manifest.path], {});
  assert.equal((restored as { restored: number }).restored, 2);
  assert.equal(fs.readFileSync(f.source, "utf8"), "keep exact bytes");
  assert.equal(fs.readFileSync(join(f.dir, f.sessionId, "attachment"), "utf8"), "manual attachment");
  assert.equal(fs.existsSync(manifest.items[0].moves[0][1]), false);
  await queue(f); await processNativeSessionBatch(); assert.ok(fs.existsSync(f.source));
  assert.equal(getDb().prepare("SELECT status FROM native_session_queue WHERE agent_id = ?").get(f.agentId)!.status, "restored");
  const repeated = await nativeSessionsCommand({ restoreManifest: manifest.path }, {}); assert.ok("restored" in repeated); assert.equal(repeated.restored, 0);
});
it("manifest restore is leader-only, checks actual project ownership, and board leader can restore across projects", async () => {
  const a = tempClaude(); const b = tempClaude(); const manifest = manualManifest([a, b]);
  getDb().prepare("UPDATE tasks SET project = 'foreign' WHERE id = ?").run(b.task.id);
  getDb().prepare("INSERT INTO runs(task_id, agent_id, role, started_at) VALUES (?, ?, 'executor', '2026-01-01')").run(a.task.id, a.agentId);
  saveConfig({ ...loadConfig(), supervisorAgentId: "board-leader", supervisors: { "native-test": "project-leader" } });
  for (const dryRun of [true, false]) {
    await assert.rejects(nativeSessionsCommand({ restoreManifest: manifest.path, dryRun }, { PASEO_AGENT_ID: a.agentId }), new RegExp(localePattern(zhCNPart("cli.onlyLeader.rebind", 0, 10))));
    await assert.rejects(nativeSessionsCommand({ restoreManifest: manifest.path, dryRun }, { PASEO_AGENT_ID: "project-leader" }), new RegExp(localePattern(zhCNPart("doctorConfig.code.global", 14, 18))));
    await assert.rejects(nativeSessionsCommand({ restoreManifest: manifest.path, dryRun }, { PASEO_AGENT_ID: "unregistered" }), new RegExp(localePattern(zhCNPart("nativeSessions.scope.mustRegister", 0, 3))));
  }
  assert.equal(fs.existsSync(a.source), false);
  fs.writeFileSync(manifest.path, JSON.stringify({ items: [manifest.items[0]] }));
  await nativeSessionsCommand({ restoreManifest: manifest.path }, { PASEO_AGENT_ID: "project-leader" }); assert.ok(fs.existsSync(a.source));
  fs.writeFileSync(manifest.path, JSON.stringify({ items: manifest.items }));
  await nativeSessionsCommand({ restoreManifest: manifest.path }, { PASEO_AGENT_ID: "board-leader" }); assert.ok(fs.existsSync(b.source));
});
it("manifest preflights the whole list, rejects conflicts, missing files, malformed/outside/link paths, and incompatible modes", async () => {
  const a = tempClaude(); const b = tempClaude(); const manifest = manualManifest([a, b]);
  const save = (items: unknown) => fs.writeFileSync(manifest.path, JSON.stringify({ items }));
  fs.mkdirSync(b.dir); fs.writeFileSync(b.source, "user data");
  await assert.rejects(nativeSessionsCommand({ restoreManifest: manifest.path }, {}), new RegExp(localePattern(zhCNPart("nativeSessions.archive.targetExists", 2, 7))));
  assert.equal(fs.existsSync(a.dir), false); assert.ok(fs.existsSync(manifest.items[0].moves[0][1]));
  fs.rmSync(b.source); fs.rmdirSync(b.dir);
  const tests = [
    { items: [manifest.items[0], manifest.items[0]], error: new RegExp(localePattern(zhCNPart("nativeSessions.manifest.duplicateMove", 3, 5))) },
    { items: [{ moves: [[join(home, "outside.jsonl"), manifest.items[0].moves[0][1]]] }], error: new RegExp(localePattern(zhCNPart("nativeSessions.archive.pathMismatch", 2, 10))) },
    { items: [{ moves: [[a.source, join(home, ".claude/projects-archive/other", `${a.sessionId}.jsonl`)]] }], error: new RegExp(localePattern(zhCNPart("nativeSessions.archive.pathMismatch", 2, 10))) },
    { items: [{ moves: [[a.source, `${home}/.claude/projects-archive/missing/../${a.sessionId}.jsonl`]] }], error: new RegExp(localePattern(zhCNPart("nativeSessions.manifest.movesNotAbsolute", 12, 18))) },
    { items: [{ moves: [[`/outside/.claude/projects/${manifest.items[0].project}/${a.sessionId}.jsonl`, manifest.items[0].moves[0][1]]] }], error: new RegExp(localePattern(zhCNPart("nativeSessions.archive.pathMismatch", 2, 10))) },
    { items: [{ ...manifest.items[0], sessionId: "different" }], error: new RegExp("sessionId " + localePattern(zhCNPart("nativeSessions.manifest.sessionIdMismatch", 13, 19))) },
    { items: [{ moves: [[a.source]] }], error: new RegExp(localePattern(zhCNPart("nativeSessions.manifest.movesNotAbsolute", 12, 18))) },
    { items: [{ moves: [] }], error: new RegExp(localePattern(zhCNPart("nativeSessions.manifest.oneJsonl", 5, 20))) },
    { items: null, error: /items/ },
  ];
  for (const t of tests) { save(t.items); await assert.rejects(nativeSessionsCommand({ restoreManifest: manifest.path, dryRun: true }, {}), t.error); }
  save(manifest.items);
  const target = manifest.items[1].moves[0][1]; fs.renameSync(target, join(home, "missing-backup"));
  await assert.rejects(nativeSessionsCommand({ restoreManifest: manifest.path }, {}), new RegExp(localePattern(zhCNPart("nativeSessions.move.conflict", 2, 5)))); assert.equal(fs.existsSync(a.dir), false);
  fs.renameSync(join(home, "missing-backup"), target);
  fs.symlinkSync(join(home, "external"), a.dir);
  await assert.rejects(nativeSessionsCommand({ restoreManifest: manifest.path }, {}), new RegExp(localePattern(zhCNPart("nativeAgentIndex.error.dirSymlink", 9, 13)))); fs.rmSync(a.dir);
  for (const input of [{ restoreManifest: manifest.path, sweep: true }, { restoreManifest: manifest.path, restore: a.sessionId }, { restoreManifest: manifest.path, apply: true }, { restoreManifest: manifest.path, project: "native-test" }]) {
    await assert.rejects(nativeSessionsCommand(input, {}), new RegExp(localePattern(zhCNPart("nativeSessions.cli.pickOne", 121, 127)) + "|" + localePattern(zhCNPart("nativeSessions.cli.resetDryRunOnly", 15, 18))));
  }
});
it("manifest partial moves resume from the durable plan without overwriting", async () => {
  const f = tempClaude(); const manifest = manualManifest([f], true); const rename = fsPromises.rename;
  let n = 0; mock.method(fsPromises, "rename", async (...args: Parameters<typeof fsPromises.rename>) => {
    if (++n === 2) throw new Error("interrupted"); return rename(...args);
  }); syncBuiltinESMExports();
  await assert.rejects(nativeSessionsCommand({ restoreManifest: manifest.path }, {}), /interrupted/);
  mock.restoreAll(); syncBuiltinESMExports(); closeDb();
  const result = await nativeSessionsCommand({ restoreManifest: manifest.path }, {}); assert.ok("restored" in result); assert.equal(result.restored, 1);
  assert.equal(fs.readFileSync(f.source, "utf8"), "keep exact bytes");
  assert.equal(fs.readFileSync(join(f.dir, f.sessionId, "attachment"), "utf8"), "manual attachment");
});
it("manifest restore respects project leases and releases earlier leases when a later claim fails", async () => {
  const a = tempClaude(); const b = tempClaude(); const manifest = manualManifest([a, b]);
  getDb().prepare("INSERT INTO native_session_locks VALUES (?, 'other-process', ?)").run(JSON.stringify([home, "claude", manifest.items[1].project]), Date.now() + 60_000);
  await nativeSessionsCommand({ restoreManifest: manifest.path, dryRun: true }, {});
  await assert.rejects(nativeSessionsCommand({ restoreManifest: manifest.path }, {}), new RegExp(localePattern(zhCNPart("nativeSessions.lock.busy", 7, 12))));
  assert.equal(getDb().prepare("SELECT count(*) AS n FROM native_session_locks").get()!.n, 1);
  for (const f of [a, b]) { assert.equal(fs.existsSync(f.source), false); assert.equal(events(f.task.id, "native_session_manifest_restore_planned").length, 0); }
});

it("Claude archives jsonl and companion without overwriting old archives; restores exact contents", async () => {
  const f = fixture(); const paths = claudeFiles(f.sessionId);
  const archive = join(home, ".claude/projects-archive/-work-test-dir"); fs.mkdirSync(archive, { recursive: true });
  fs.writeFileSync(join(archive, `${f.sessionId}.jsonl`), "old archive");
  await queue(f); assert.ok(fs.existsSync(paths.source));
  await processNativeSessionBatch();
  const archived = events(f.task.id, "native_session_archived")[0]; assert.equal(archived.moves.length, 2);
  assert.equal(fs.existsSync(paths.source), false);
  await nativeSessionsCommand({ restore: f.sessionId }, {});
  assert.equal(fs.readFileSync(paths.source, "utf8"), "{\"test\":true}\n");
  assert.equal(fs.readFileSync(join(paths.companion, "attachment.txt"), "utf8"), "preserved");
  assert.equal(fs.readFileSync(join(archive, `${f.sessionId}.jsonl`), "utf8"), "old archive");
  await nativeSessionsCommand({ restore: f.sessionId }, {}); await queue(f); await processNativeSessionBatch();
  assert.equal(events(f.task.id, "native_session_restored").length, 1); assert.ok(fs.existsSync(paths.source));
});
it("Codex uses official commands and serializes every session, with a five-item batch cap", async () => {
  const fixtures = Array.from({ length: 8 }, () => fixture("codex")); for (const f of fixtures) await queue(f);
  let active = 0; let peak = 0; const calls: string[] = [];
  const command = async (action: "archive" | "unarchive", id: string) => { active++; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 2)); calls.push(`${action} ${id}`); active--; };
  const [a, b] = await Promise.all([processNativeSessionBatch({ command }), processNativeSessionBatch({ command })]);
  assert.equal(a.processed, 5); assert.equal(b.processed, 5); assert.equal(calls.length, 5); assert.equal(peak, 1);
  await processNativeSessionBatch({ command }); assert.equal(calls.length, 8);
  await nativeSessionsCommand({ restore: fixtures[0].sessionId }, {}, { command });
  assert.equal(calls.at(-1), `unarchive ${fixtures[0].sessionId}`);
});
it("real async executable receives temporary HOME and no timeout blocks the event loop", async () => {
  const f = fixture("codex", { persistence: { nativeHandle: "native-codex-id" } });
  const bin = join(home, "bin"); fs.mkdirSync(bin);
  fs.writeFileSync(join(bin, "codex"), '#!/bin/sh\nprintf "%s %s\\n" "$1" "$2" >> "$HOME/codex-calls"\n'); fs.chmodSync(join(bin, "codex"), 0o755);
  process.env.PATH = `${bin}:${original.PATH}`;
  await queue(f); await processNativeSessionBatch(); await nativeSessionsCommand({ restore: "native-codex-id" }, {});
  assert.equal(fs.readFileSync(join(home, "codex-calls"), "utf8"), "archive native-codex-id\nunarchive native-codex-id\n");
  process.env.PATH = original.PATH;
});
it("unowned, leader, shared user, live self and symlink sessions fail closed", async () => {
  const foreign = fixture("claude", {}, false); const a = claudeFiles(foreign.sessionId); await queue(foreign);
  const leader = fixture("claude", { title: "<leader> · native-test" }); const b = claudeFiles(leader.sessionId); await queue(leader);
  const shared = fixture(); const c = claudeFiles(shared.sessionId); await queue(shared);
  fs.writeFileSync(join(home, "agents/test/user.json"), JSON.stringify({ id: "user", provider: "claude", cwd: "/work/test_dir", persistence: { sessionId: shared.sessionId }, labels: {} }));
  const live = fixture("claude", { archivedAt: null, lastStatus: "running" }); const d = claudeFiles(live.sessionId); await queue(live);
  const linked = fixture("claude", { cwd: "/linked" }); await queue(linked);
  const external = join(home, "external"); fs.mkdirSync(external); fs.writeFileSync(join(external, `${linked.sessionId}.jsonl`), "keep");
  fs.symlinkSync(external, join(home, ".claude/projects/-linked"));
  await processNativeSessionBatch();
  for (const path of [a.source, b.source, c.source, d.source]) assert.ok(fs.existsSync(path));
  assert.match(events(shared.task.id, "native_session_archive_failed")[0].error, new RegExp(zhCN("labels.assigner.user")));
  assert.match(events(linked.task.id, "native_session_archive_failed")[0].error, new RegExp(localePattern(zhCNPart("nativeAgentIndex.error.dirSymlink", 9, 13))));
});
it("unreadable peer metadata prevents archive and missing handles retry with exponential backoff", async () => {
  const f = fixture("codex", { persistence: null }); await queue(f); const now = new Date(); let calls = 0;
  const command = async () => { calls++; };
  await processNativeSessionBatch({ command, now });
  assert.equal(calls, 0); assert.equal(events(f.task.id, "native_session_archive_failed").length, 1);
  fs.writeFileSync(f.path, JSON.stringify({ ...f.agent, persistence: { sessionId: f.sessionId } }));
  fs.writeFileSync(join(home, "agents/test/broken.json"), "{");
  const second = new Date(+now + nativeRetryDelayMs(1));
  await processNativeSessionBatch({ command, now: second }); assert.equal(calls, 0);
  // The unreadable peer is a transient condition: no new failure, attempts unchanged, retry deferred.
  assert.equal(events(f.task.id, "native_session_archive_failed").length, 1);
  assert.equal(queueRow(f.agentId).attempts, 1); assert.equal(queueRow(f.agentId).retry_at, +second + NATIVE_TRANSIENT_RETRY_MS);
  fs.renameSync(join(home, "agents/test/broken.json"), join(home, "broken-backup"));
  await processNativeSessionBatch({ command, now: new Date(+second + NATIVE_TRANSIENT_RETRY_MS) }); assert.equal(calls, 1);
});
it("purge saves the handle before deletion, queues only successful deletion, and survives restart", async () => {
  const f = fixture(); const paths = claudeFiles(f.sessionId); let fail = true;
  setMissingCwdHooks({ deleteAgent: async () => { if (fail) throw new Error("purge failed"); fs.renameSync(f.path, join(home, "removed-agent.json")); } });
  const agent = { id: f.agentId, provider: "claude", cwd: f.agent.cwd, title: zhCN("labels.role.executor"), labels: { kanban: "1", kanban_task: String(f.task.id) }, archived: true, lastActivityAt: null };
  assert.equal(await purgeAgent(agent), "kept"); await processNativeSessionBatch(); assert.ok(fs.existsSync(paths.source));
  fail = false; assert.equal(await purgeAgent(agent), "purged"); assert.ok(fs.existsSync(paths.source)); closeDb();
  await processNativeSessionBatch(); assert.equal(fs.existsSync(paths.source), false);
  await nativeSessionsCommand({ restore: f.sessionId }, {}); assert.ok(fs.existsSync(paths.source));
});
it("restore conflict and partial archive replay preserve both sides", async () => {
  const f = fixture(); const paths = claudeFiles(f.sessionId); await queue(f);
  const archive = join(home, ".claude/projects-archive/-work-test-dir"); fs.mkdirSync(archive, { recursive: true });
  const moves = [{ source: paths.source, target: join(archive, `${f.sessionId}.fixture.jsonl`) }, { source: paths.companion, target: join(archive, `${f.sessionId}.fixture`) }];
  getDb().prepare("UPDATE native_session_queue SET moves_json = ? WHERE agent_id = ?").run(JSON.stringify(moves), f.agentId);
  fs.renameSync(moves[0].source, moves[0].target); await processNativeSessionBatch();
  assert.equal(events(f.task.id, "native_session_archived").length, 1);
  fs.writeFileSync(paths.source, "new user content");
  await assert.rejects(nativeSessionsCommand({ restore: f.sessionId }, {}), new RegExp(localePattern(zhCNPart("nativeSessions.archive.targetExists", 2, 7))));
  assert.equal(fs.readFileSync(paths.source, "utf8"), "new user content"); assert.ok(fs.existsSync(moves[0].target));
});
it("a held cross-process lease prevents archive; expiry permits retry", async () => {
  const f = fixture("codex"); await queue(f); const now = new Date(); let calls = 0;
  getDb().prepare("INSERT INTO native_session_locks VALUES (?, 'other-process', ?)").run(JSON.stringify([home, "codex", "command"]), Date.now() + 60_000);
  await processNativeSessionBatch({ command: async () => { calls++; }, now }); assert.equal(calls, 0);
  getDb().prepare("UPDATE native_session_locks SET expires_at = 0").run();
  await processNativeSessionBatch({ command: async () => { calls++; }, now: new Date(+now + nativeRetryDelayMs(1)) }); assert.equal(calls, 1);
});
it("sweep is read-only, batches by project/offset/limit and reads Codex thread metadata", async () => {
  const a = fixture(); const paths = claudeFiles(a.sessionId); const b = fixture("codex"); codexThread(b.sessionId);
  const c = fixture(); claudeFiles(c.sessionId); getDb().prepare("UPDATE tasks SET status = 'running' WHERE id = ?").run(c.task.id);
  const before = getDb().prepare("SELECT count(*) AS n FROM events").get();
  const progress: string[] = [];
  const result = await nativeSessionsCommand({ sweep: true }, {}, { progress: message => progress.push(message) });
  assert.ok("summary" in result);
  assert.equal(result.dryRun, true); assert.equal(result.summary.checked, 2); assert.equal(result.summary.counts.archive, 2);
  assert.ok(progress.length >= 3); assert.ok(fs.existsSync(paths.source)); assert.deepEqual(getDb().prepare("SELECT count(*) AS n FROM events").get(), before);
  assert.equal(fs.existsSync(join(home, ".claude/projects-archive")), false);
  const page = await nativeSessionsCommand({ sweep: true, project: "native-test", limit: 1, offset: 1 }, {}); assert.ok("summary" in page); assert.deepEqual(page.lines.map(l => l.agentId), [b.agentId]);
  const env = { PASEO_AGENT_ID: b.agentId }; getDb().prepare("INSERT INTO runs(task_id, agent_id, role, started_at) VALUES (?, ?, 'executor', '2026-01-01')").run(b.task.id, b.agentId);
  await assert.rejects(nativeSessionsCommand({ sweep: true, apply: true }, env), new RegExp(localePattern(zhCNPart("cli.onlyLeader.rebind", 0, 10))));
  await assert.rejects(nativeSessionsCommand({ restore: b.sessionId }, env), new RegExp(localePattern(zhCNPart("cli.onlyLeader.rebind", 0, 10))));
  await assert.rejects(nativeSessionsCommand({ sweep: true, project: "other" }, env), new RegExp(localePattern(zhCNPart("nativeSessions.cli.ownProjectOnly", 0, 4))));
  await runKanban(["native-sessions", "--sweep", "--apply", "--dry-run"], env);
  await nativeSessionsCommand({ sweep: true, apply: true, limit: 1 }, {}); assert.equal(fs.existsSync(paths.source), false);
});
it("normal cleanup finishes independently of native failure and schedules a bounded next round", async () => {
  const f = fixture("claude", { persistence: null });
  getDb().prepare("UPDATE events SET kind = 'other' WHERE task_id = ? AND kind IN ('cleanup','cleanup_finished')").run(f.task.id);
  const stop = installCleanup({ archiveAgent: async () => {}, archiveWorkspace: async () => {}, listAgents: async () => [], inspectWorkspace: async () => null });
  try {
    await drainCleanups(); assert.ok(getDb().prepare("SELECT 1 FROM events WHERE task_id = ? AND kind = 'cleanup_finished'").get(f.task.id));
    fs.writeFileSync(f.path, JSON.stringify({ ...f.agent, persistence: { sessionId: f.sessionId } })); const paths = claudeFiles(f.sessionId);
    await drainCleanups(new Date(Date.now() + 360_000)); assert.equal(fs.existsSync(paths.source), false);
  } finally { stop(); }
});

it("600 jsonl (three 50MB), 1000 agents: cached batch <50ms, cold <200ms, no jsonl reads/native traversal; sweep <10s", async t => {
  // COLD_RUNS cold batches + CACHED_RUNS cached batches + one leftover pending item.
  const COLD_RUNS = 3, CACHED_RUNS = 3, FIXTURES = (COLD_RUNS + CACHED_RUNS) * 5 + 1;
  const fixtures = Array.from({ length: FIXTURES }, () => fixture()); for (const f of fixtures) claudeFiles(f.sessionId);
  const dir = join(home, ".claude/projects/-work-test-dir");
  for (let i = FIXTURES; i < 600; i++) {
    const path = join(dir, `unused-${i}.jsonl`); fs.writeFileSync(path, "");
    if (i < FIXTURES + 3) { const fd = fs.openSync(path, "r+"); fs.ftruncateSync(fd, 50 * 1024 * 1024); fs.closeSync(fd); }
  }
  assert.equal(fs.readdirSync(dir).filter(n => fs.statSync(join(dir, n)).size === 50 * 1024 * 1024).length, 3, "three 50MB jsonl must exist");
  for (let i = FIXTURES; i < 1000; i++) fs.writeFileSync(join(home, "agents/test", `unused-${i}.json`), JSON.stringify({ id: `unused-${i}`, provider: "claude", cwd: "/other", persistence: { sessionId: `unused-${i}` }, labels: {} }));
  // Amplify the former due()/claimSession() full event parsing failure mode.
  const insert = getDb().prepare("INSERT INTO events(task_id, at, kind, data_json) VALUES (?, '2026-01-01', 'native_session_archive_failed', ?)");
  getDb().exec("BEGIN"); for (let i = 0; i < 10_000; i++) insert.run(fixtures[0].task.id, JSON.stringify({ agentId: `old-${i}`, error: "x".repeat(300) })); getDb().exec("COMMIT");
  for (const f of fixtures) await queue(f);
  // The agent index cache is keyed by its root, so an identical copy of the agents directory makes
  // the next batch cold again. One cold sample is a single wall-clock reading that one I/O stall
  // from another process can push over the gate; the median of several real cold batches cannot.
  const agentsRoots = [process.env.KANBAN_AGENTS_DIR!, ...Array.from({ length: COLD_RUNS - 1 }, (_, i) => {
    const copy = join(home, `agents-cold-${i + 1}`); fs.cpSync(process.env.KANBAN_AGENTS_DIR!, copy, { recursive: true }); return copy;
  })];
  const asyncRead = fsPromises.readFile; const syncRead = fs.readFileSync;
  mock.method(fsPromises, "readFile", (...args: Parameters<typeof fsPromises.readFile>) => { assert.ok(!String(args[0]).endsWith(".jsonl"), "must not read jsonl"); return asyncRead(...args); });
  mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => { assert.ok(!String(args[0]).endsWith(".jsonl"), "must not read jsonl"); return syncRead(...args); });
  const list = fsPromises.readdir;
  const traversal = mock.method(fsPromises, "readdir", (...args: Parameters<typeof fsPromises.readdir>) => { assert.ok(!String(args[0]).includes("/.claude") && !String(args[0]).includes("/.codex"), "plugin cannot traverse native directories"); return list(...args); });
  syncBuiltinESMExports();
  const loadSamples = [samplePerformanceLoad()];
  const probePaths = Array.from({ length: 1000 }, (_, i) => join(home, "agents/test", i < FIXTURES ? "missing.json" : `unused-${i}.json`));
  const probeDir = join(root, `probe-${serial}`);
  const probeBefore = await measureIoProbe(probePaths, probeDir);
  const coldRuns: number[] = [];
  for (const agentsRoot of agentsRoots) {
    process.env.KANBAN_AGENTS_DIR = agentsRoot;
    const started = performance.now(); const cold = await processNativeSessionBatch(); coldRuns.push(performance.now() - started);
    assert.equal(cold.processed, 5); loadSamples.push(samplePerformanceLoad());
  }
  const coldMs = median(coldRuns);
  const readsBefore = (fsPromises.readFile as typeof fsPromises.readFile & { mock: { callCount(): number } }).mock.callCount();
  // The last cold batch builds the cache for its root. Measure the next
  // CACHED_RUNS real five-item batches (no index-only prewarm) and compare the
  // median, so one I/O stall from another process cannot fail the gate alone.
  const batchRuns: number[] = [];
  for (let run = 0; run < CACHED_RUNS; run++) {
    const started = performance.now(); const result = await processNativeSessionBatch(); batchRuns.push(performance.now() - started);
    assert.equal(result.processed, 5); loadSamples.push(samplePerformanceLoad());
  }
  const batchMs = median(batchRuns);
  assert.equal((fsPromises.readFile as typeof fsPromises.readFile & { mock: { callCount(): number } }).mock.callCount(), readsBefore, "unchanged agent JSON must not be read again");
  assert.equal(getDb().prepare("SELECT count(*) AS n FROM native_session_queue WHERE status = 'pending'").get()!.n, 1);
  traversal.mock.restore(); syncBuiltinESMExports();
  const probeAfter = await measureIoProbe(probePaths, probeDir);
  const sweepStarted = performance.now(); const sweep = await nativeSessionsCommand({ sweep: true }, {}); const sweepMs = performance.now() - sweepStarted;
  assert.ok("summary" in sweep);
  loadSamples.push(samplePerformanceLoad()); assert.equal(sweep.summary.agents, 1000); assert.equal(sweep.summary.counts.archive, 1);
  const cliStarted = performance.now();
  const stdout = await new Promise<string>((resolve, reject) => execFile(process.execPath, ["--import", "tsx", "server/cli.ts", "native-sessions", "--sweep", "--dry-run", "--json"], {
    env: { ...process.env, HOME: home, KANBAN_TOKEN: "", PASEO_AGENT_ID: "" }, timeout: 9000, maxBuffer: 1024 * 1024,
  }, (err, output) => err ? reject(err) : resolve(output)));
  const cliMs = performance.now() - cliStarted;
  loadSamples.push(samplePerformanceLoad()); assert.equal(JSON.parse(stdout).summary.agents, 1000);
  t.diagnostic(`PERFORMANCE batch=${batchMs.toFixed(1)}ms(median of [${batchRuns.map(n => n.toFixed(1)).join(",")}]) cold=${coldMs.toFixed(1)}ms(median of [${coldRuns.map(n => n.toFixed(1)).join(",")}]) sweep=${sweepMs.toFixed(1)}ms cli=${cliMs.toFixed(1)}ms agents=1000 jsonl=600 large=3x50MB`);
  const gate = performanceLoadGate(loadSamples);
  t.diagnostic(`PERFORMANCE LOAD ${gate.reason}`);
  // loadavg cannot see disk/filesystem contention from other agents, so also
  // calibrate against a business-independent I/O probe taken before and after the batches.
  const io = calibrateIo([probeBefore, probeAfter]);
  t.diagnostic(`PERFORMANCE IO ${io.reason}; cached ${batchMs.toFixed(1)}ms vs limit 50 -> ${(50 * io.scale).toFixed(1)}ms; cold ${coldMs.toFixed(1)}ms vs limit 200 -> ${(200 * io.scale).toFixed(1)}ms`);
  const skipReason = gate.skip ? gate.reason : io.skip ? io.reason : false;
  // Run every functional/I/O assertion above even on a busy machine. A skipped
  // child test is visible in TAP and cannot masquerade as timing acceptance.
  await t.test("wall-clock performance thresholds", { skip: skipReason }, () => {
    assertNativePerformance({ coldMs, batchMs, sweepMs, cliMs }, io.scale);
  });
});

it("cold dry-run never migrates the board, even with a shared archived Kanban session", async () => {
  const f = fixture(); claudeFiles(f.sessionId);
  const g = fixture("claude", { persistence: { sessionId: f.sessionId } });
  fs.writeFileSync(g.path, JSON.stringify({ ...g.agent, labels: { kanban: "1", kanban_task: String(g.task.id) } }));
  getDb().exec("DROP TABLE native_session_queue; DROP TABLE native_session_locks"); closeDb();
  const result = await nativeSessionsCommand({ sweep: true }, {}); assert.ok("summary" in result);
  const readonly = new DatabaseSync(join(home, "db/kanban.db"), { readOnly: true });
  assert.equal(readonly.prepare("SELECT 1 FROM sqlite_master WHERE name = 'native_session_queue'").get(), undefined); readonly.close();
});
it("failed commands leave cleanup finished and report failure instead of a claimed archive", async () => {
  const f = fixture("codex"); codexThread(f.sessionId);
  const result = await nativeSessionsCommand({ sweep: true, apply: true }, {}, { command: async () => { throw new Error("fake codex error"); } });
  assert.ok("summary" in result); assert.equal(result.summary.counts.archive_failed, 1);
  assert.equal(events(f.task.id, "native_session_archived").length, 0);
  assert.equal(events(f.task.id, "cleanup_finished").length, 1);
});

it("restored journals from the reverted version and former workers promoted to leader stay protected", async () => {
  const f = fixture(); const a = claudeFiles(f.sessionId);
  appendEvent(f.task.id, "native_session_restored", null, null, "kanban", { agentId: f.agentId, provider: "claude", sessionId: f.sessionId });
  await queue(f);
  const leader = fixture(); const b = claudeFiles(leader.sessionId); await prepareNativeSession(leader.task.id, leader.agentId);
  fs.writeFileSync(leader.path, JSON.stringify({ ...leader.agent, title: "<leader> · native-test" }));
  await prepareNativeSession(leader.task.id, leader.agentId); fs.renameSync(leader.path, join(home, "retired-leader.json"));
  nativeSessionAfterArchive(leader.task.id, leader.agentId); await processNativeSessionBatch();
  assert.ok(fs.existsSync(a.source)); assert.ok(fs.existsSync(b.source));
});

it("restore accepts old unsuffixed jsonl/companion journals and rejects changed restore roots", async () => {
  const f = fixture(); const paths = claudeFiles(f.sessionId);
  const archive = join(home, ".claude/projects-archive/-work-test-dir"); fs.mkdirSync(archive, { recursive: true });
  const moves = [{ source: paths.source, target: join(archive, `${f.sessionId}.jsonl`) }, { source: paths.companion, target: join(archive, f.sessionId) }];
  for (const move of moves) fs.renameSync(move.source, move.target);
  appendEvent(f.task.id, "native_session_archived", null, null, "kanban", { agentId: f.agentId, provider: "claude", sessionId: f.sessionId, cwd: f.agent.cwd, moves });
  await nativeSessionsCommand({ restore: f.sessionId }, {});
  assert.ok(fs.existsSync(paths.source)); assert.ok(fs.existsSync(paths.companion));
  appendEvent(f.task.id, "native_session_archived", null, null, "kanban", { agentId: f.agentId, provider: "claude", sessionId: f.sessionId, cwd: f.agent.cwd, moves: [{ source: join(home, "outside"), target: join(home, "other") }] });
  await assert.rejects(nativeSessionsCommand({ restore: f.sessionId }, {}), new RegExp(localePattern(zhCNPart("nativeSessions.restore.notUnique", 11, 18))));
});

it("repeated prepare does not append events or update unchanged pending/skipped rows", async () => {
  const cursor = fixture("cursor", { persistence: null });
  await queue(cursor); await processNativeSessionBatch();
  const failed = fixture(); await queue(failed); await processNativeSessionBatch(); // missing jsonl
  const leader = fixture("claude", { title: "<leader> · native-test" }); await prepareNativeSession(leader.task.id, leader.agentId);
  const missing = fixture("claude", { persistence: null }); await prepareNativeSession(missing.task.id, missing.agentId);
  const cases = [cursor, failed, leader, missing];
  const snapshot = () => getDb().prepare("SELECT * FROM native_session_queue ORDER BY agent_id").all();
  const before = snapshot(); const changes = getDb().prepare("SELECT total_changes() AS n").get()!.n;
  for (let n = 0; n < 20; n++) await Promise.all(cases.map(f => prepareNativeSession(f.task.id, f.agentId)));
  assert.deepEqual(snapshot(), before);
  assert.equal(getDb().prepare("SELECT total_changes() AS n").get()!.n, changes, "unchanged capture must not perform a queue or event write");
  assert.equal(events(cursor.task.id, "native_session_identified").length, 0);
  assert.equal(events(cursor.task.id, "native_session_skipped").length, 1);
  assert.equal(events(failed.task.id, "native_session_identified").length, 1);
  assert.equal(events(leader.task.id, "native_session_skipped").length, 1);
  assert.equal(events(missing.task.id, "native_session_identified").length, 0);
});
it("concurrent capture journals a location only once and still records handle/provider/cwd changes", async () => {
  const f = fixture();
  const repeat = () => Promise.all(Array.from({ length: 20 }, () => prepareNativeSession(f.task.id, f.agentId)));
  await repeat(); assert.equal(events(f.task.id, "native_session_identified").length, 1);
  fs.writeFileSync(f.path, JSON.stringify({ ...f.agent, persistence: { sessionId: "changed-handle" } }));
  await repeat(); assert.equal(events(f.task.id, "native_session_identified").length, 2);
  fs.writeFileSync(f.path, JSON.stringify({ ...f.agent, cwd: "/changed", persistence: { sessionId: "changed-handle" } }));
  await repeat(); assert.equal(events(f.task.id, "native_session_identified").length, 3);
  fs.writeFileSync(f.path, JSON.stringify({ ...f.agent, provider: "cursor", cwd: "/changed", persistence: null }));
  await repeat(); assert.equal(events(f.task.id, "native_session_identified").length, 3);
  assert.equal(events(f.task.id, "native_session_skipped").length, 1);
  const row = getDb().prepare("SELECT provider, session_id, cwd FROM native_session_queue WHERE agent_id = ?").get(f.agentId);
  assert.deepEqual({ ...row }, { provider: "cursor", session_id: "", cwd: "/changed" });
});
it("promotion to leader records skipped once without erasing a captured handle or terminal archive", async () => {
  const f = fixture(); await prepareNativeSession(f.task.id, f.agentId);
  fs.writeFileSync(f.path, JSON.stringify({ ...f.agent, title: "<leader> · native-test" }));
  await Promise.all(Array.from({ length: 20 }, () => prepareNativeSession(f.task.id, f.agentId)));
  const row = getDb().prepare("SELECT status, session_id FROM native_session_queue WHERE agent_id = ?").get(f.agentId);
  assert.deepEqual({ ...row }, { status: "skipped", session_id: f.sessionId });
  assert.equal(events(f.task.id, "native_session_skipped").length, 1);
  const archived = fixture(); claudeFiles(archived.sessionId); await queue(archived); await processNativeSessionBatch();
  fs.writeFileSync(archived.path, JSON.stringify({ ...archived.agent, title: "<leader> · native-test" }));
  await prepareNativeSession(archived.task.id, archived.agentId);
  assert.equal(getDb().prepare("SELECT status FROM native_session_queue WHERE agent_id = ?").get(archived.agentId)!.status, "archived");
  assert.equal(events(archived.task.id, "native_session_skipped").length, 0);
});
it("ten periodic reconcile sweeps leave native events and queue unchanged, without terminal recapture I/O", async () => {
  const cursor = fixture("cursor", { persistence: null }); await queue(cursor); await processNativeSessionBatch();
  const leader = fixture("claude", { title: "<leader> · native-test" }); await prepareNativeSession(leader.task.id, leader.agentId);
  const archived = fixture(); claudeFiles(archived.sessionId); await queue(archived); await processNativeSessionBatch();
  const restored = fixture(); claudeFiles(restored.sessionId); await queue(restored); await processNativeSessionBatch();
  await nativeSessionsCommand({ restore: restored.sessionId }, {});
  const cases = [cursor, leader, archived, restored]; let inspections = 0;
  for (const f of cases) getDb().prepare("UPDATE tasks SET agent_id = ? WHERE id = ?").run(f.agentId, f.task.id);
  const stop = installCleanup({ archiveAgent: async () => { assert.fail("still-archived agents must not rearchive"); }, archiveWorkspace: async () => {}, listAgents: async () => [], inspectWorkspace: async () => null,
    inspectAgent: async () => { inspections++; return { archived: true, busy: false }; } });
  const counts = () => getDb().prepare("SELECT kind, count(*) AS n FROM events WHERE kind LIKE 'native_session_%' GROUP BY kind ORDER BY kind").all();
  const rows = () => getDb().prepare("SELECT * FROM native_session_queue ORDER BY agent_id").all();
  const beforeEvents = counts(); const beforeRows = rows();
  const traversal = mock.method(fsPromises, "readdir", () => { assert.fail("terminal native queue rows must not reread agent directories"); });
  syncBuiltinESMExports();
  try {
    const start = Date.now();
    for (let n = 0; n < 10; n++) await drainCleanups(new Date(start + n * 660_000));
    assert.equal(inspections, cases.length * 10, "actually exercise all ten periodic reconcile sweeps");
    assert.equal(traversal.mock.callCount(), 0);
    assert.deepEqual(counts(), beforeEvents); assert.deepEqual(rows(), beforeRows);
    assert.equal(events(cursor.task.id, "native_session_identified").length, 0);
  assert.equal(events(cursor.task.id, "native_session_skipped").length, 1);
    assert.equal(events(leader.task.id, "native_session_skipped").length, 1);
  } finally { stop(); traversal.mock.restore(); syncBuiltinESMExports(); }
});

it("reconcile does not re-identify unchanged failed sessions while preserving their retry state", async () => {
  const f = fixture(); await queue(f); await processNativeSessionBatch();
  getDb().prepare("UPDATE tasks SET agent_id = ? WHERE id = ?").run(f.agentId, f.task.id);
  const start = Date.now();
  // Keep the existing failure outside this reconcile-only observation window.
  getDb().prepare("UPDATE native_session_queue SET retry_at = ? WHERE agent_id = ?").run(start + 2 * 24 * 60 * 60_000, f.agentId);
  const before = getDb().prepare("SELECT * FROM native_session_queue WHERE agent_id = ?").get(f.agentId); let inspections = 0;
  const stop = installCleanup({ archiveAgent: async () => { assert.fail("archived agent"); }, archiveWorkspace: async () => {}, listAgents: async () => [], inspectWorkspace: async () => null,
    inspectAgent: async () => { inspections++; return { archived: true, busy: false }; } });
  try {
    for (let n = 0; n < 10; n++) await drainCleanups(new Date(start + n * 660_000));
    assert.equal(inspections, 10);
    assert.deepEqual(getDb().prepare("SELECT * FROM native_session_queue WHERE agent_id = ?").get(f.agentId), before);
    assert.equal(events(f.task.id, "native_session_identified").length, 1);
    assert.equal(events(f.task.id, "native_session_archive_failed").length, 1);
  } finally { stop(); }
});

it("cache revalidates changed/new/deleted JSON and fails closed on unreadable or duplicate records", async () => {
  const f = fixture("codex"); await queue(f);
  const other = fixture("codex", { persistence: { sessionId: "unrelated" } }, false);
  const warm = await indexNativeAgents(); assert.equal(warm.error, undefined);
  const reads = mock.method(fsPromises, "readFile"); syncBuiltinESMExports();
  let calls = 0;
  // Change an existing record without changing its directory listing. Restore
  // mtime to prove ctime/size/inode checks also invalidate the cached value.
  const stat = fs.statSync(other.path);
  fs.writeFileSync(other.path, JSON.stringify({ ...other.agent, persistence: { sessionId: f.sessionId } }));
  fs.utimesSync(other.path, stat.atime, stat.mtime);
  await processNativeSessionBatch({ command: async () => { calls++; } });
  assert.equal(calls, 0); assert.equal(reads.mock.callCount(), 1, "only changed JSON is read");
  assert.match(events(f.task.id, "native_session_archive_failed")[0].error, new RegExp(zhCN("labels.assigner.otherAgent")));
  fs.renameSync(other.path, join(home, "removed-user.json"));
  const newUser = fixture("codex", { persistence: { nativeHandle: f.sessionId } }, false);
  await processNativeSessionBatch({ now: new Date(Date.now() + nativeRetryDelayMs(1)), command: async () => { calls++; } });
  assert.equal(calls, 0, "new records and nativeHandle aliases must be checked");
  fs.renameSync(newUser.path, join(home, "removed-new-user.json"));
  fs.mkdirSync(join(home, "agents/duplicate"));
  fs.writeFileSync(join(home, "agents/duplicate", `${f.agentId}.json`), JSON.stringify(f.agent));
  assert.match((await indexNativeAgents()).error!, new RegExp(localePattern(zhCNPart("nativeAgentIndex.error.duplicate", 8, 11))));
  fs.renameSync(join(home, "agents/duplicate", `${f.agentId}.json`), join(home, "removed-duplicate.json"));
  const invalid = join(home, "agents/test/broken.json"); fs.writeFileSync(invalid, "not JSON");
  const retry = new Date(Date.now() + 24 * 60 * 60_000);
  await processNativeSessionBatch({ now: retry, command: async () => { calls++; } });
  assert.equal(calls, 0); assert.equal(queueRow(f.agentId).attempts, 2, "unreadable index is transient: no attempt counted");
  fs.renameSync(invalid, join(home, "removed-invalid.json"));
  await processNativeSessionBatch({ now: new Date(+retry + NATIVE_TRANSIENT_RETRY_MS), command: async () => { calls++; } });
  assert.equal(calls, 1, "removed records must not survive in the cache");
});
it("changed queued owner handles still check the new session for shared users", async () => {
  const f = fixture("codex"); await queue(f); await indexNativeAgents();
  const other = fixture("codex", { persistence: { sessionId: "new-owner-handle" } }, false);
  fs.writeFileSync(f.path, JSON.stringify({ ...f.agent, persistence: { sessionId: other.agent.persistence.sessionId } }));
  let calls = 0; await processNativeSessionBatch({ command: async () => { calls++; } });
  assert.equal(calls, 0); assert.match(events(f.task.id, "native_session_archive_failed")[0].error, new RegExp(zhCN("labels.assigner.otherAgent")));
});
it("nonterminal reconcile shares one root listing per round and refreshes it next round", async () => {
  const cases = Array.from({ length: 4 }, () => fixture());
  for (const f of cases) {
    await queue(f); getDb().prepare("UPDATE tasks SET agent_id = ? WHERE id = ?").run(f.agentId, f.task.id);
    getDb().prepare("UPDATE native_session_queue SET retry_at = ? WHERE agent_id = ?").run(Date.now() + 3 * 24 * 60 * 60_000, f.agentId);
  }
  const list = fsPromises.readdir;
  let roots = 0;
  mock.method(fsPromises, "readdir", (...args: Parameters<typeof fsPromises.readdir>) => { if (String(args[0]) === join(home, "agents")) roots++; return list(...args); });
  syncBuiltinESMExports();
  const stop = installCleanup({ archiveAgent: async () => {}, archiveWorkspace: async () => {}, listAgents: async () => [], inspectWorkspace: async () => null,
    inspectAgent: async () => ({ archived: true, busy: false }) });
  try {
    const start = Date.now(); await drainCleanups(new Date(start)); assert.equal(roots, 1);
    await drainCleanups(new Date(start + 660_000)); assert.equal(roots, 2);
  } finally { stop(); }
});
it("permanent native failures back off exponentially, deduplicate reasons and settle at twelve attempts", async () => {
  const f = fixture("codex"); await queue(f);
  let now = new Date(); let calls = 0; let reason = "offline";
  const command = async () => { calls++; throw new Error(reason); };
  for (let attempt = 1; attempt <= NATIVE_MAX_ATTEMPTS; attempt++) {
    if (attempt === 3) reason = "unavailable";
    await processNativeSessionBatch({ now, command });
    const row = getDb().prepare("SELECT * FROM native_session_queue WHERE agent_id = ?").get(f.agentId)!;
    assert.equal(row.attempts, attempt);
    if (attempt < NATIVE_MAX_ATTEMPTS) {
      assert.equal(row.status, "pending");
      const delay = Math.min(24 * 60 * 60_000, 5 * 60_000 * 2 ** (attempt - 1));
      assert.equal(row.retry_at, +now + delay);
      await processNativeSessionBatch({ now: new Date(Number(row.retry_at) - 1), command });
      assert.equal(calls, attempt, "must wait until due");
      now = new Date(Number(row.retry_at));
    } else { assert.equal(row.status, "failed"); assert.equal(row.retry_at, 0); }
  }
  const failures = events(f.task.id, "native_session_archive_failed");
  assert.deepEqual(failures.map(e => [e.error, e.attempts, e.terminal]), [["offline", 1, false], ["unavailable", 3, false], ["unavailable", 12, true]]);
  assert.equal(failures.at(-1).retryAt, null);
  const snapshot = getDb().prepare("SELECT * FROM native_session_queue WHERE agent_id = ?").get(f.agentId);
  const traversal = mock.method(fsPromises, "readdir", () => { assert.fail("failed rows must not recapture"); }); syncBuiltinESMExports();
  for (let n = 0; n < 3; n++) {
    await prepareNativeSession(f.task.id, f.agentId); nativeSessionAfterArchive(f.task.id, f.agentId);
    await processNativeSessionBatch({ now: new Date(+now + 7 * 24 * 60 * 60_000), command });
  }
  assert.equal(calls, NATIVE_MAX_ATTEMPTS);
  assert.deepEqual(getDb().prepare("SELECT * FROM native_session_queue WHERE agent_id = ?").get(f.agentId), snapshot);
  traversal.mock.restore(); syncBuiltinESMExports();
  const sweep = await nativeSessionsCommand({ sweep: true, apply: true }, {}, { command });
  assert.ok("summary" in sweep); assert.equal(sweep.summary.counts.archive_failed, 1); assert.equal(calls, NATIVE_MAX_ATTEMPTS);
});
it("upgrading an old queue keeps retry state and the last logged failure reason", async () => {
  const f = fixture("codex"); await queue(f);
  await processNativeSessionBatch({ command: async () => { throw new Error("offline"); } });
  const before = getDb().prepare("SELECT attempts, retry_at FROM native_session_queue WHERE agent_id = ?").get(f.agentId)!;
  getDb().exec("ALTER TABLE native_session_queue DROP COLUMN last_error"); closeDb();
  const row = getDb().prepare("SELECT * FROM native_session_queue WHERE agent_id = ?").get(f.agentId)!;
  assert.equal(row.last_error, "offline"); assert.equal(row.attempts, before.attempts); assert.equal(row.retry_at, before.retry_at);
  await processNativeSessionBatch({ now: new Date(Number(row.retry_at)), command: async () => { throw new Error("offline"); } });
  assert.equal(events(f.task.id, "native_session_archive_failed").length, 1);
});

it("old pending rows beyond the retry cap terminate without native commands", async () => {
  const f = fixture("codex"); await queue(f);
  getDb().prepare("UPDATE native_session_queue SET attempts = ?, last_error = 'old failure' WHERE agent_id = ?").run(NATIVE_MAX_ATTEMPTS + 5, f.agentId);
  let calls = 0; await processNativeSessionBatch({ command: async () => { calls++; } });
  assert.equal(calls, 0); assert.equal(getDb().prepare("SELECT status FROM native_session_queue WHERE agent_id = ?").get(f.agentId)!.status, "failed");
  assert.equal(events(f.task.id, "native_session_archive_failed").at(-1).terminal, true);
});

it("failure counts and event deduplication use the durable state after awaiting a command", async () => {
  const f = fixture("codex"); await queue(f);
  await processNativeSessionBatch({ command: async () => {
    // Model a competing worker reporting the same failure while this command
    // was in flight. The later failure must not overwrite its count or log it twice.
    getDb().prepare("UPDATE native_session_queue SET attempts = ?, last_error = 'offline' WHERE agent_id = ?").run(NATIVE_MAX_ATTEMPTS - 2, f.agentId);
    throw new Error("offline");
  } });
  assert.equal(getDb().prepare("SELECT attempts FROM native_session_queue WHERE agent_id = ?").get(f.agentId)!.attempts, NATIVE_MAX_ATTEMPTS - 1);
  assert.equal(events(f.task.id, "native_session_archive_failed").length, 0);
  const retry = getDb().prepare("SELECT retry_at FROM native_session_queue WHERE agent_id = ?").get(f.agentId)!.retry_at;
  await processNativeSessionBatch({ now: new Date(Number(retry)), command: async () => { throw new Error("offline"); } });
  assert.equal(events(f.task.id, "native_session_archive_failed").length, 1);
  assert.equal(events(f.task.id, "native_session_archive_failed")[0].terminal, true);
});

it("reset-failed previews without writes, resets only failed rows and records one event", async () => {
  const f = fixture("codex"); await queue(f);
  const db = getDb();
  db.prepare("UPDATE native_session_queue SET status = 'failed', attempts = ?, retry_at = 123, last_error = 'inspect first', moves_json = '[]' WHERE agent_id = ?").run(NATIVE_MAX_ATTEMPTS, f.agentId);
  const before = db.prepare("SELECT * FROM native_session_queue WHERE agent_id = ?").get(f.agentId);
  closeDb();
  const preview = await runKanban(["native-sessions", "--reset-failed", f.agentId, "--dry-run"], {});
  assert.ok(preview && typeof preview === "object" && "dryRun" in preview && preview.dryRun === true);
  assert.deepEqual(getDb().prepare("SELECT * FROM native_session_queue WHERE agent_id = ?").get(f.agentId), before);
  assert.equal(events(f.task.id, "native_session_reset").length, 0);
  const other = fixture("codex"); await queue(other);
  getDb().prepare("UPDATE native_session_queue SET status = 'failed', attempts = 9, retry_at = 456 WHERE agent_id = ?").run(other.agentId);
  const otherBefore = getDb().prepare("SELECT * FROM native_session_queue WHERE agent_id = ?").get(other.agentId);
  await runKanban(["native-sessions", "--reset-failed", f.agentId], {});
  const row = getDb().prepare("SELECT status, attempts, retry_at, last_error, moves_json FROM native_session_queue WHERE agent_id = ?").get(f.agentId);
  assert.deepEqual({ ...row }, { status: "pending", attempts: 0, retry_at: 0, last_error: "inspect first", moves_json: "[]" });
  assert.deepEqual(getDb().prepare("SELECT * FROM native_session_queue WHERE agent_id = ?").get(other.agentId), otherBefore);
  assert.equal(events(f.task.id, "native_session_reset").length, 1);
  assert.equal(events(f.task.id, "native_session_reset")[0].previousAttempts, NATIVE_MAX_ATTEMPTS);
  await assert.rejects(runKanban(["native-sessions", "--reset-failed", f.agentId], {}), new RegExp(localePattern(zhCNPart("nativeSessions.reset.onlyFailed", 0, 11))));
  await assert.rejects(runKanban(["native-sessions", "--reset-failed", "missing"], {}), new RegExp(localePattern(zhCNPart("missingCwd.purge.gone", 9, 19))));
  for (const argv of [["--reset-failed"], ["--reset-failed", f.agentId, "--sweep"], ["--reset-failed", f.agentId, "--apply"], ["--reset-failed", f.agentId, "--restore", "session"]]) {
    await assert.rejects(runKanban(["native-sessions", ...argv], {}), new RegExp(localePattern(zhCNPart("routing.effortSource.card", 2, 4)) + "|" + localePattern(zhCNPart("nativeSessions.cli.resetDryRunOnly", 15, 18))));
  }
});
it("reset-failed requires a leader even for dry-run and enforces project scope", async () => {
  const f = fixture(); await queue(f);
  getDb().prepare("UPDATE native_session_queue SET status = 'failed', attempts = ? WHERE agent_id = ?").run(NATIVE_MAX_ATTEMPTS, f.agentId);
  getDb().prepare("INSERT INTO runs(task_id, agent_id, role, started_at) VALUES (?, ?, 'executor', 'now')").run(f.task.id, f.agentId);
  // TEST_0188: "foreign-leader" must be registered for another project to reach the project-scope check.
  saveConfig({ ...loadConfig(), supervisors: { ...loadConfig().supervisors, foreign: "foreign-leader" } });
  for (const dryRun of [true, false]) {
    await assert.rejects(nativeSessionsCommand({ resetFailed: f.agentId, dryRun }, { PASEO_AGENT_ID: f.agentId }), new RegExp(localePattern(zhCNPart("cli.onlyLeader.rebind", 0, 10))));
    await assert.rejects(nativeSessionsCommand({ resetFailed: f.agentId, dryRun }, { PASEO_AGENT_ID: "foreign-leader" }), new RegExp(localePattern(zhCNPart("doctorConfig.code.global", 14, 18))));
  }
  // Token identity must also retain worker permissions.
  getDb().prepare("INSERT INTO tokens(token, task_id, role, agent_id, created_at) VALUES ('reset-fixture', ?, 'reviewer', ?, 'now')").run(f.task.id, f.agentId);
  await assert.rejects(nativeSessionsCommand({ resetFailed: f.agentId }, { KANBAN_TOKEN: "reset-fixture" }), new RegExp(localePattern(zhCNPart("cli.onlyLeader.rebind", 0, 10))));
  getDb().prepare("UPDATE tasks SET created_by_agent = 'scoped-leader' WHERE id = ?").run(f.task.id);
  // TEST_0188: being the card's creator is not enough once the session is no longer a registered <leader>.
  await assert.rejects(nativeSessionsCommand({ resetFailed: f.agentId, dryRun: true }, { PASEO_AGENT_ID: "scoped-leader" }), new RegExp(localePattern(zhCNPart("nativeSessions.scope.mustRegister", 0, 3))));
  saveConfig({ ...loadConfig(), supervisors: { ...loadConfig().supervisors, elsewhere: "scoped-leader" } });
  await nativeSessionsCommand({ resetFailed: f.agentId, dryRun: true }, { PASEO_AGENT_ID: "scoped-leader" });
  await nativeSessionsCommand({ resetFailed: f.agentId }, { PASEO_AGENT_ID: "scoped-leader" });
  assert.equal((getDb().prepare("SELECT actor FROM events WHERE kind = 'native_session_reset' AND task_id = ?").get(f.task.id) as { actor: string }).actor, "scoped-leader");
});
it("reset-failed dry-run opens an old database read-only without migration or backfill", async () => {
  const f = fixture(); await queue(f);
  getDb().prepare("UPDATE native_session_queue SET status = 'failed', attempts = 12 WHERE agent_id = ?").run(f.agentId);
  closeDb();
  const file = join(home, "db/kanban.db");
  const db = new DatabaseSync(file); db.exec("ALTER TABLE native_session_queue DROP COLUMN last_error"); db.close();
  const before = fs.readFileSync(file);
  await nativeSessionsCommand({ resetFailed: f.agentId, dryRun: true }, {});
  closeDb(); assert.deepEqual(fs.readFileSync(file), before);
});

it("reset-failed rolls back the queue update if its audit event cannot be written", async () => {
  const f = fixture(); await queue(f);
  getDb().prepare("UPDATE native_session_queue SET status = 'failed', attempts = 12, retry_at = 123 WHERE agent_id = ?").run(f.agentId);
  const before = getDb().prepare("SELECT * FROM native_session_queue WHERE agent_id = ?").get(f.agentId);
  getDb().exec("CREATE TRIGGER reject_reset_event BEFORE INSERT ON events WHEN NEW.kind = 'native_session_reset' BEGIN SELECT RAISE(ABORT, 'fixture event failure'); END");
  await assert.rejects(nativeSessionsCommand({ resetFailed: f.agentId }, {}), /fixture event failure/);
  assert.deepEqual(getDb().prepare("SELECT * FROM native_session_queue WHERE agent_id = ?").get(f.agentId), before);
  assert.equal(events(f.task.id, "native_session_reset").length, 0);
});

function setCodexArchived(sessionId: string, archived: number) {
  const db = new DatabaseSync(join(home, ".codex/state_5.sqlite"));
  db.prepare("UPDATE threads SET archived = ? WHERE id = ?").run(archived, sessionId); db.close();
}
function queueRow(agentId: string) { return getDb().prepare("SELECT status, attempts, retry_at, last_error FROM native_session_queue WHERE agent_id = ?").get(agentId)!; }

it("codex sessions already archived in the codex index are recorded as archived without running the command", async () => {
  const f = fixture("codex"); codexThread(f.sessionId); setCodexArchived(f.sessionId, 1); await queue(f);
  let calls = 0; await processNativeSessionBatch({ home, command: async () => { calls++; } });
  assert.equal(calls, 0); assert.equal(queueRow(f.agentId).status, "archived");
  assert.equal(events(f.task.id, "native_session_archived").length, 1);
});
it("a codex archive command that fails after the thread became archived still counts as archived", async () => {
  const f = fixture("codex"); codexThread(f.sessionId); await queue(f);
  await processNativeSessionBatch({ home, command: async () => { setCodexArchived(f.sessionId, 1); throw new Error(zhCN("nativeSessions.codex.commandFailed", {"action":"archive","code":"1"})); } });
  const row = queueRow(f.agentId); assert.equal(row.status, "archived"); assert.equal(row.attempts, 0);
  assert.equal(events(f.task.id, "native_session_archive_failed").length, 0);
});
it("transient conditions (index failure, lock conflict, retirement not allowed) only defer retry_at without counting attempts", async () => {
  const f = fixture("codex"); await queue(f); const now = new Date(); let calls = 0; const command = async () => { calls++; };
  fs.writeFileSync(join(home, "agents/test/broken.json"), "{");
  await processNativeSessionBatch({ command, now });
  let row = queueRow(f.agentId);
  assert.deepEqual([row.status, row.attempts], ["pending", 0]); assert.ok(Number(row.retry_at) > +now);
  assert.equal(events(f.task.id, "native_session_archive_failed").length, 0);
  fs.renameSync(join(home, "agents/test/broken.json"), join(home, "broken-backup"));
  // lock held by another process
  const when = new Date(Number(row.retry_at));
  getDb().prepare("INSERT INTO native_session_locks(resource, owner, expires_at) VALUES (?, 'other', ?)").run(JSON.stringify([home, "codex", "command"]), Date.now() + 60_000);
  await processNativeSessionBatch({ command, now: when, home }); row = queueRow(f.agentId);
  assert.deepEqual([row.status, row.attempts, calls], ["pending", 0, 0]); assert.ok(Number(row.retry_at) > +when);
  getDb().prepare("DELETE FROM native_session_locks").run();
  // retirement evidence missing
  getDb().prepare("UPDATE tasks SET status = 'running', agent_id = ? WHERE id = ?").run(f.agentId, f.task.id);
  const later = new Date(Number(row.retry_at));
  await processNativeSessionBatch({ command, now: later }); row = queueRow(f.agentId);
  assert.deepEqual([row.status, row.attempts, calls], ["pending", 0, 0]); assert.ok(Number(row.retry_at) > +later);
  assert.equal(events(f.task.id, "native_session_archive_failed").length, 0);
});
it("a record file that vanishes during indexing is skipped instead of failing the whole index", async () => {
  fixture("codex"); const gone = fixture("codex");
  const real = fsPromises.lstat;
  mock.method(fsPromises, "lstat", async (path: string, opts?: object) => {
    if (String(path).endsWith(`${gone.agentId}.json`)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return real(path, opts as never);
  }); syncBuiltinESMExports();
  const index = await indexNativeAgents();
  assert.equal(index.error, undefined); assert.equal(index.agents.has(gone.agentId), false);
});
it("failure events deduplicate by agent and error class, not by raw error text", async () => {
  const f = fixture("codex"); await queue(f); let now = new Date(); let n = 0;
  const command = async () => { throw new Error(`codex archive ${zhCNPart("audit.cleanupFailed", 2, 5)}${["1", "unknown", "ETIMEDOUT"][n++]}`); };
  for (let i = 0; i < 3; i++) {
    await processNativeSessionBatch({ now, command });
    now = new Date(Number(queueRow(f.agentId).retry_at));
  }
  assert.equal(events(f.task.id, "native_session_archive_failed").length, 1);
});
it("reconcile-codex dry-run lists, apply marks only rows archived in the codex index, and is idempotent", async () => {
  const done = fixture("codex"); codexThread(done.sessionId); setCodexArchived(done.sessionId, 1); await queue(done);
  const live = fixture("codex"); codexThread(live.sessionId); await queue(live);
  saveConfig({ ...loadConfig(), supervisorAgentId: "board-leader" }); const env = { PASEO_AGENT_ID: "board-leader" };
  const dry = await nativeSessionsCommand({ reconcileCodex: true }, env, { home }); assert.ok("lines" in dry);
  assert.ok("pending" in dry); assert.deepEqual(dry.lines.map(l => (l as { agentId: string }).agentId), [done.agentId]); assert.equal(queueRow(done.agentId).status, "pending");
  await nativeSessionsCommand({ reconcileCodex: true, apply: true }, env, { home });
  assert.equal(queueRow(done.agentId).status, "archived"); assert.equal(queueRow(live.agentId).status, "pending");
  assert.equal(events(done.task.id, "native_session_archived").length, 1);
  const again = await nativeSessionsCommand({ reconcileCodex: true, apply: true }, env, { home }); assert.ok("lines" in again);
  assert.equal(again.lines.length, 0); assert.equal(events(done.task.id, "native_session_archived").length, 1);
});

it("sweep leaves excluded sessions alone: listed in a skipped summary row, or still skipped in the queue after compact-events removed the row", async () => {
  const listed = fixture(); claudeFiles(listed.sessionId);
  // A second agent of the same card, named only inside the summary row's `sessions` list.
  const secondId = `agent-second-${listed.task.id}`; const secondSession = `session-second-${listed.task.id}`;
  fs.writeFileSync(join(home, "agents/test", `${secondId}.json`), JSON.stringify({ ...listed.agent, id: secondId, persistence: { sessionId: secondSession } }));
  claudeFiles(secondSession);
  appendEvent(listed.task.id, "agent_opened", null, null, "kanban", { agentId: secondId });
  appendEvent(listed.task.id, "cleanup", null, null, "kanban", { action: "archive_agent", agentId: secondId, ok: true });
  appendEvent(listed.task.id, "native_session_skipped", null, null, "kanban", {
    agentId: listed.agentId, reason: zhCN("nativeSessions.skip.noNativeSession"), summary: 1, summaryKey: zhCN("nativeSessions.skip.noNativeSession"), count: 2,
    sessions: [{ agentId: listed.agentId }, { agentId: secondId }],
  });
  const queued = fixture(); claudeFiles(queued.sessionId);
  getDb().prepare("INSERT INTO native_session_queue(agent_id, task_id, home, status) VALUES (?, ?, ?, 'skipped')").run(queued.agentId, queued.task.id, home);
  const plain = fixture(); claudeFiles(plain.sessionId);
  await nativeSessionsCommand({ sweep: true, apply: true }, {});
  assert.equal(events(listed.task.id, "native_session_archived").length, 0, "both agents named in the summary stay");
  assert.equal(events(queued.task.id, "native_session_archived").length, 0, "queue row skipped, no event needed");
  assert.equal(events(plain.task.id, "native_session_archived").length, 1, "an ordinary session is still collected");
});
