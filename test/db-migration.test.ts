import { zhCN, zhCNPart, localePattern } from "./helpers/locale";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, beforeEach, it, mock } from "node:test";
import { SUBPROCESS_TIMEOUT_MS } from "./helpers/subprocess-timeout";
import { closeDb, getDb } from "../server/db";
import { checkoutRoot, isPluginCheckout } from "../server/paths";
import { runKanban } from "../server/cli";
import { createTask } from "../server/store";
import { issueToken } from "../server/tokens";
import { smokeDatabase, runCompatChecked } from "../server/compat";

const sourceRoot = checkoutRoot();
assert.ok(sourceRoot, "test runner must execute ESM checkout code");
const root = mkdtempSync(join(tmpdir(), "kanban-migration-"));
const saved = { ...process.env };
let installation: string;
let serial = 0;
beforeEach(() => {
  closeDb(); process.env = { ...saved };
  installation = join(root, String(++serial));
  // Seed a current board as an explicitly isolated fixture, then designate its plugin installation.
  delete process.env.KANBAN_HOME;
  process.env.KANBAN_DATA_DIR = join(installation, "data");
  getDb(); closeDb();
  process.env.KANBAN_HOME = installation;
});
after(() => { closeDb(); process.env = saved; rmSync(root, { recursive: true, force: true }); });
function snapshot() {
  const db = new DatabaseSync(join(installation, "data/kanban.db"), { readOnly: true });
  try { return db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY name").all(); }
  finally { db.close(); }
}
// Node 22 keeps type stripping on, and a copied tree with no package manifest is CommonJS.
// The eval named import then cannot see closeDb. Mark only this disposable installation as ESM.
const copyPluginSource = (): void => {
  cpSync(join(sourceRoot, "server"), join(installation, "server"), { recursive: true });
  cpSync(join(sourceRoot, "shared"), join(installation, "shared"), { recursive: true });
  symlinkSync(join(sourceRoot, "node_modules"), join(installation, "node_modules"));
  writeFileSync(join(installation, "package.json"), '{ "type": "module" }\n');
};
function makeOld() {
  const db = new DatabaseSync(join(installation, "data/kanban.db"));
  db.exec("ALTER TABLE native_session_queue DROP COLUMN last_error");
  db.close();
}
it("non-plugin checkout refuses an old production board without changing schema or file contents", () => {
  makeOld();
  const before = snapshot(); const file = join(installation, "data/kanban.db");
  const bytes = readFileSync(file);
  assert.throws(() => getDb(), new RegExp(zhCN("db.migration.missingColumns", {"table":"native_session_queue","columns":("last_error.*" + zhCNPart("db.migration.required", 19, 33))})));
  assert.deepEqual(snapshot(), before);
  assert.deepEqual(readFileSync(file), bytes);
  assert.equal(existsSync(join(installation, "data/kanban.config.json")), true);
});
it("the actual plugin source migrates an old production board and backfills the last error", () => {
  makeOld();
  const db = new DatabaseSync(join(installation, "data/kanban.db"));
  db.exec(`INSERT INTO native_session_queue(agent_id, task_id, home, attempts) VALUES ('retry', 42, '/fixture', 1);
    INSERT INTO events(task_id, at, kind, data_json) VALUES (42, 'now', 'native_session_archive_failed', '{"agentId":"retry","error":"old failure"}')`);
  db.close();
  copyPluginSource();
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `import { getDb, closeDb } from ${JSON.stringify(join(installation, "server/db.ts"))}; getDb(); closeDb();`], { env: process.env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const check = new DatabaseSync(join(installation, "data/kanban.db"), { readOnly: true });
  try { assert.equal((check.prepare("SELECT last_error FROM native_session_queue").get() as { last_error: string }).last_error, "old failure"); }
  finally { check.close(); }
});
it("plugin migration replaces the legacy complete trigger idempotently and revokes quiet handoffs", () => {
  delete process.env.KANBAN_HOME;
  const own = createTask({ project: "migration", title: "legacy read grant", role: "executor" });
  getDb().prepare("UPDATE tasks SET status = 'running', project_read_scope = 'project' WHERE id = ?").run(own.id);
  closeDb(); process.env.KANBAN_HOME = installation;
  const old = new DatabaseSync(join(installation, "data/kanban.db"));
  old.exec(`DROP TRIGGER tasks_complete_clears_project_read;
    CREATE TRIGGER tasks_complete_clears_project_read AFTER INSERT ON events
    FOR EACH ROW WHEN NEW.kind = 'complete'
    BEGIN UPDATE tasks SET project_read_scope = NULL WHERE id = NEW.task_id; END;`);
  old.close();
  copyPluginSource();
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    import { getDb, closeDb } from ${JSON.stringify(join(installation, "server/db.ts"))};
    const read = () => getDb().prepare('SELECT project_read_scope FROM tasks WHERE id = ?').get(${own.id}).project_read_scope;
    const schema = () => getDb().prepare('SELECT name, sql FROM sqlite_master ORDER BY name').all();
    assert.equal(read(), 'project');
    const upgraded = schema();
    for (let i = 0; i < 2; i++) {
      closeDb();
      assert.equal(read(), 'project');
      assert.deepEqual(schema(), upgraded);
    }
    for (const kind of ['complete', 'auto_complete']) {
      const db = getDb();
      db.prepare("UPDATE tasks SET status = 'running', project_read_scope = 'project' WHERE id = ?").run(${own.id});
      db.prepare("INSERT INTO events(task_id, at, kind, from_status, to_status) VALUES (?, 'now', ?, 'running', 'in_review')").run(${own.id}, kind);
      assert.equal(read(), null, kind);
      db.prepare("UPDATE tasks SET status = 'rework' WHERE id = ?").run(${own.id});
      assert.equal(read(), null, kind + ' rework');
    }
    closeDb();
  `], { env: process.env, encoding: "utf8", timeout: SUBPROCESS_TIMEOUT_MS });
  assert.equal(result.status, 0, result.stderr);
  const check = new DatabaseSync(join(installation, "data/kanban.db"), { readOnly: true });
  try {
    assert.equal(check.prepare("SELECT title FROM tasks WHERE id = ?").get(own.id)!.title, "legacy read grant");
    assert.equal(check.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'tasks_complete_clears_project_read'").get()!.n, 1);
  } finally { check.close(); }
});
it("latest production board supports worker complete/list/show/comment/block and skips backfills", async () => {
  // Create authorized worker fixtures while the board is still isolated.
  delete process.env.KANBAN_HOME;
  const done = createTask({ project: "migration", title: "complete", role: "executor" });
  const blocked = createTask({ project: "migration", title: "block", role: "executor" });
  const db = getDb();
  db.prepare("UPDATE tasks SET status = 'running', code_seq = NULL WHERE id IN (?, ?)").run(done.id, blocked.id);
  db.prepare("UPDATE tasks SET agent_id = ? WHERE id = ?").run("worker", done.id);
  db.prepare("UPDATE tasks SET agent_id = ? WHERE id = ?").run("block-worker", blocked.id);
  const token = issueToken("executor", done.id, "worker");
  const blockToken = issueToken("executor", blocked.id, "block-worker");
  closeDb(); process.env.KANBAN_HOME = installation;
  const before = snapshot();
  const configFile = join(installation, "data/kanban.config.json");
  const config = readFileSync(configFile);
  await runKanban(["ping"], { KANBAN_TOKEN: token });
  await runKanban(["list", "--json"], { KANBAN_TOKEN: token });
  await runKanban(["show", String(done.id)], { KANBAN_TOKEN: token });
  await runKanban(["comment", String(done.id), "--text", "fixture comment"], { KANBAN_TOKEN: token });
  await runKanban(["complete", String(done.id), "--summary", "fixture done", "--handoff", '{"files":[],"verification":[],"risks":[]}'], { KANBAN_TOKEN: token });
  await runKanban(["block", String(blocked.id), "--kind", "dependency", "--reason", "fixture blocked"], { KANBAN_TOKEN: blockToken });
  assert.deepEqual(snapshot(), before);
  assert.deepEqual(readFileSync(configFile), config);
  assert.equal((getDb().prepare("SELECT code_seq FROM tasks WHERE id = ?").get(done.id) as { code_seq: number | null }).code_seq, null);
});
it("realpaths recognize installation aliases and prevent data symlink bypass and project-root spoofing", () => {
  const alias = join(installation, "alias"); symlinkSync(join(installation, "data"), alias);
  process.env.KANBAN_DATA_DIR = alias;
  process.env.KANBAN_PROJECT_ROOT = installation;
  makeOld(); assert.throws(() => getDb(), new RegExp(localePattern(zhCNPart("db.migration.required", 25, 33))));
  process.env.KANBAN_HOME = sourceRoot;
  assert.equal(isPluginCheckout(), true);
  const sourceAlias = join(root, "source-alias"); symlinkSync(sourceRoot, sourceAlias);
  process.env.KANBAN_HOME = sourceAlias;
  assert.equal(isPluginCheckout(), true);
});
it("compat from a non-plugin checkout uses an empty disposable board without opening production", async () => {
  makeOld(); const before = snapshot();
  const env = { ...process.env }; delete env.KANBAN_DATA_DIR;
  const smoke = smokeDatabase(env);
  try {
    assert.notEqual(smoke.env.KANBAN_DATA_DIR, join(installation, "data"));
    assert.equal(existsSync(smoke.path), false);
    const result = spawnSync(join(sourceRoot, "bin/kanban"), ["list", "--json"], { env: smoke.env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).tasks, []);
    assert.deepEqual(snapshot(), before);
    const explicit = smokeDatabase({ ...env, KANBAN_DATA_DIR: join(installation, "data") });
    try { assert.notEqual(explicit.path, join(installation, "data/kanban.db")); }
    finally { explicit.cleanup(); }
  } finally { smoke.cleanup(); }
  assert.equal(existsSync(smoke.env.KANBAN_DATA_DIR!), false);
  const { realDeps } = await import("../server/compat");
  const deps = realDeps(env);
  // Run the real smoke commands, substituting unrelated daemon/offline checks.
  const result = await runCompatChecked(env, { ...deps,
    typecheck: async () => ({ ok: true, detail: "" }), offlineTest: async () => ({ ok: true, detail: "" }),
    pluginTable: async () => "PLUGIN  STATUS  ENABLED  SOURCE  REVISION  DIRECTORY  ERROR\npaseo-kanban  running  yes  /repo  -  /repo",
    pluginJson: async () => '[{"id":"paseo-kanban","status":"running"}]',
    version: async () => "fixture", openHelp: async () => "--json", deleteHelp: async () => "--all --cwd",
    files: () => [], daemon: async () => [{ name: "fixture", status: "pass", detail: "" }],
  });
  assert.equal(result.code, 0, result.lines.join("\n"));
  assert.ok(result.lines.some(line => line.includes(deps.databasePath!)));
  assert.equal(existsSync(deps.databasePath!), false);
  assert.deepEqual(snapshot(), before);
});

it("a dangling database symlink cannot create or migrate a missing production file", () => {
  const missingPlugin = join(root, "missing-plugin");
  const aliasDir = join(root, "dangling-alias");
  mkdirSync(join(missingPlugin, "data"), { recursive: true }); mkdirSync(aliasDir);
  const production = join(missingPlugin, "data/kanban.db");
  symlinkSync(production, join(aliasDir, "kanban.db"));
  process.env.KANBAN_HOME = missingPlugin; process.env.KANBAN_DATA_DIR = aliasDir;
  assert.throws(() => getDb(), new RegExp(zhCN("db.migration.noDatabase") + ".*" + localePattern(zhCNPart("db.migration.required", 25, 33))));
  assert.equal(existsSync(production), false);
});

it("Paseo CJS bundle eval migrates the installation's old board without a source URL or cwd", async () => {
  makeOld();
  const db = new DatabaseSync(join(installation, "data/kanban.db"));
  db.exec(`INSERT INTO native_session_queue(agent_id, task_id, home, attempts) VALUES ('bundled-retry', 42, '/fixture', 3);
    INSERT INTO events(task_id, at, kind, data_json) VALUES (42, 'now', 'native_session_archive_failed', '{"agentId":"bundled-retry","error":"bundled failure"}')`);
  db.close();
  // Same build options as Paseo compilePlugin: no define, banner or inject.
  const compiled = await build({
    entryPoints: [join(sourceRoot, "server/db.ts")], bundle: true, format: "cjs",
    platform: "node", target: "node20", write: false, logLevel: "silent",
  });
  assert.ok(compiled.warnings.some(warning => warning.id === "empty-import-meta"));
  const wrapped = `(function(require) { const module = { exports: {} }; const exports = module.exports;\n${compiled.outputFiles[0].text}\nreturn module.exports; })`;
  const script = join(installation, "eval-bundle.mjs");
  writeFileSync(script, `
    import assert from 'node:assert/strict';
    import { createRequire } from 'node:module';
    assert.equal(process.cwd(), '/');
    const { getDb, closeDb } = (0, eval)(${JSON.stringify(wrapped)})(createRequire(import.meta.url));
    const db = getDb();
    assert.equal(db.prepare("SELECT last_error FROM native_session_queue WHERE agent_id = 'bundled-retry'").get().last_error, 'bundled failure');
    assert.equal(db.prepare("SELECT attempts FROM native_session_queue WHERE agent_id = 'bundled-retry'").get().attempts, 3);
    assert.equal(getDb(), db);
    closeDb();
    assert.equal(getDb().prepare("SELECT last_error FROM native_session_queue WHERE agent_id = 'bundled-retry'").get().last_error, 'bundled failure');
    closeDb();
  `);
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [script], { env, cwd: "/", encoding: "utf8", timeout: 15_000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const check = new DatabaseSync(join(installation, "data/kanban.db"), { readOnly: true });
  try { assert.equal((check.prepare("SELECT last_error FROM native_session_queue").get() as { last_error: string }).last_error, "bundled failure"); }
  finally { check.close(); }
});
it("cached getDb performs no realpath I/O; closeDb and installation changes invalidate it", () => {
  // Exercise the production hot path against this temporary simulated installation.
  // The test-only isolation guard intentionally resolves paths on every test access.
  delete process.env.NODE_TEST_CONTEXT;
  delete process.env.KANBAN_TEST_TMP;
  process.env.TMPDIR = root.replace(/[/\\]kanban-test-\d+-.*$/, "");
  const db = getDb();
  const trap = mock.method(fs, "realpathSync", () => { throw new Error("fixture path resolution"); });
  syncBuiltinESMExports();
  try {
    assert.equal(getDb(), db);
    process.env.KANBAN_HOME = join(installation, "changed-installation");
    assert.throws(() => getDb(), /fixture path resolution/);
    process.env.KANBAN_HOME = installation;
    closeDb();
    assert.throws(() => getDb(), /fixture path resolution/);
  } finally { trap.mock.restore(); syncBuiltinESMExports(); }
});
