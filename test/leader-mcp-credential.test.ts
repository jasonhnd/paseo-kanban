import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = mkdtempSync(join(tmpdir(), "leader-mcp-"));
process.env.KANBAN_DATA_DIR = join(root, "data");
process.env.KANBAN_AGENTS_DIR = join(root, "agents");
process.env.PASEO_HOME = join(root, "paseo");
process.env.KANBAN_PASEO_CONFIG = join(root, "paseo", "config.json");
mkdirSync(join(root, "agents", "bucket"), { recursive: true });

const { runKanban } = await import("../server/cli");
const { closeDb, getDb } = await import("../server/db");
const { setProjectCode, setProjectSupervisor, setSupervisorAgentId } = await import("../server/config");
const { changeProjectLeader, changeKanbanLeader } = await import("../server/leader-registry");
const { agentIdentity, resolveCliIdentity, resolveCompactIdentity, resolveTokenIdentity } = await import("../server/identity");
const { issueToken } = await import("../server/tokens");
const { startMcpServer } = await import("../server/mcp");
const { writeSavedMcpPort } = await import("../server/mcp-port");
const { handleTool, toolDefs } = await import("../server/tools");
const { createTask } = await import("../server/store");
const { configPath } = await import("../server/config-file");
const { readSettings, writeSettings } = await import("../server/settings");
const server = await startMcpServer(toolDefs(), async (name, args, token) => {
  try { return { text: JSON.stringify(await handleTool(name, args, token)) }; }
  catch (error) { return { text: String(error), isError: true }; }
});
setProjectCode("demo", "DEMO");
setProjectCode("other", "EX");
writeSavedMcpPort(server.port);
let serial = 0;
const output = () => join(root, `credential-${++serial}.json`);
const env = (agentId: string) => ({ PASEO_AGENT_ID: agentId });
const register = (agentId: string, project = "demo") => runKanban(["supervise", "--project", project], env(agentId));
interface Credential { type: string; url: string; headers: { Authorization: string } }
async function credential(agentId: string) {
  const path = output();
  const result = await runKanban(["mcp-credential", "--out", path], env(agentId));
  return { path, result, config: JSON.parse(readFileSync(path, "utf8")) as Credential };
}
async function call(name: string, args: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  const response = await fetch(`${server.url}/mcp`, {
    method: "POST", headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  assert.equal(response.status, 200);
  return (await response.json() as { result: { isError?: boolean; content: { text: string }[] } }).result;
}
function tokenOf(config: Credential) { return config.headers.Authorization.slice("Bearer ".length); }
function assertRejected(result: Awaited<ReturnType<typeof call>>) { assert.equal(result.isError, true); }
beforeEach(() => {
  setProjectCode("demo", "DEMO");
  setProjectCode("other", "EX");
  setProjectSupervisor("demo", null);
  setProjectSupervisor("other", null);
  setSupervisorAgentId(null);
  getDb().prepare("DELETE FROM tokens").run();
});
after(async () => { await server.close(); closeDb(); rmSync(root, { recursive: true, force: true }); });

it("a manually registered, tokenless leader exports a private MCP credential and calls list/show with its real scope", async () => {
  await register("manual-leader");
  const card = createTask({ project: "demo", title: "Demo card", role: "executor" });
  const { path, result, config } = await credential("manual-leader");
  assert.equal(config.type, "http");
  assert.equal(config.url, `${server.url}/mcp`);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const token = tokenOf(config);
  assert.match(token, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(result).includes(token), "CLI output must never disclose the credential");
  const row = getDb().prepare("SELECT role, task_id, agent_id, expires_at FROM tokens WHERE token = ?").get(token)!;
  assert.equal(row.role, "leader-mcp");
  assert.equal(row.task_id, null);
  assert.equal(row.agent_id, "manual-leader");
  assert.ok(Date.parse(String(row.expires_at)) > Date.now());
  assert.ok(Date.parse(String(row.expires_at)) <= Date.now() + 8 * 60 * 60_000);
  assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM tokens WHERE role = 'supervisor'").get()!.n, 0);
  assert.deepEqual(agentIdentity("manual-leader"), { role: "supervisor", taskId: null, agentId: "manual-leader" });
  await register("manual-leader"); // Idempotent registration must not revoke a usable credential.
  assert.notEqual((await call("kanban_list", {}, config.headers)).isError, true);
  const shown = await call("kanban_show", { id: card.id }, config.headers);
  assert.notEqual(shown.isError, true);
  assert.equal(JSON.parse(shown.content[0].text).task.id, card.id);
  assert.notEqual((await call("kanban_create", { project: "demo", title: "Allowed", role: "executor" }, config.headers)).isError, true);
  assertRejected(await call("kanban_create", { project: "other", title: "Denied", role: "executor" }, config.headers));
  assert.equal(resolveCliIdentity({ KANBAN_TOKEN: token }).agentId, "manual-leader");
  assert.equal(resolveCompactIdentity({ KANBAN_TOKEN: token }, getDb()).role, "supervisor");
});

it("MCP still rejects missing/forged Bearers and caller-supplied identity hints, even for a registered leader", async () => {
  await register("manual-leader");
  assert.notEqual((await call("kanban_ping")).isError, true);
  for (const name of ["kanban_list", "kanban_show"]) {
    assertRejected(await call(name, { agentId: "manual-leader", id: 1 }, {
      "X-Paseo-Agent-Id": "manual-leader", "Mcp-Session-Id": "paseo-kanban",
    }));
    assertRejected(await call(name, {}, { Authorization: "Bearer invalid-demo-credential" }));
  }
  const { config } = await credential("manual-leader");
  const token = tokenOf(config);
  const changed = (token[0] === "a" ? "b" : "a") + token.slice(1);
  assertRejected(await call("kanban_list", {}, { Authorization: `Bearer ${changed}` }));
  assertRejected(await call("kanban_supervise", { project: "demo", agent: "forged-leader" }, config.headers));
});

it("the built Node CLI exports a tokenless leader's credential for real HTTP MCP calls without printing it", async () => {
  await register("bundled-cli-leader");
  const path = output();
  const entry = fileURLToPath(new URL("../bin/paseo-kanban.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [entry, "mcp-credential", "--out", path, "--json"], {
    env: { ...process.env, PASEO_AGENT_ID: "bundled-cli-leader", KANBAN_TOKEN: "" }, encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).agentId, "bundled-cli-leader");
  const config = JSON.parse(readFileSync(path, "utf8")) as Credential;
  assert.ok(!result.stdout.includes(tokenOf(config)));
  assert.ok(!result.stderr.includes(tokenOf(config)));
  assert.notEqual((await call("kanban_list", {}, config.headers)).isError, true);
});

it("only the calling registered leader can export: guests, workers, schedules, terminal and mismatched identities are refused", async () => {
  await register("manual-leader");
  const card = createTask({ project: "demo", title: "Worker", role: "executor" });
  getDb().prepare("UPDATE tasks SET agent_id = ? WHERE id = ?").run("demo-worker", card.id);
  writeFileSync(join(root, "agents", "bucket", "demo-schedule.json"), JSON.stringify({ id: "demo-schedule", labels: { "paseo.schedule-id": "demo" } }));
  const supervisor = issueToken("supervisor", null, null);
  const guest = issueToken("guest", null, "manual-leader");
  const cases = [env("unregistered"), env("demo-worker"), env("demo-schedule"), {},
    { PASEO_AGENT_ID: "../manual-leader" }, { KANBAN_TOKEN: supervisor, PASEO_AGENT_ID: "manual-leader" },
    { KANBAN_TOKEN: guest, PASEO_AGENT_ID: "different-session" }];
  for (const identityEnv of cases) {
    const path = output();
    await assert.rejects(runKanban(["mcp-credential", "--out", path], identityEnv));
    assert.equal(existsSync(path), false);
  }
  setProjectSupervisor("other", "demo-schedule");
  await assert.rejects(runKanban(["mcp-credential", "--out", output()], env("demo-schedule")));
  assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM tokens WHERE role = 'leader-mcp'").get()!.n, 0);
});

it("handover revokes the old credential even when that agent remains a leader of another project", async () => {
  await register("outgoing-leader");
  await register("outgoing-leader", "other");
  const old = await credential("outgoing-leader");
  await runKanban(["handover", "--project", "demo", "--to", "incoming-leader"], env("outgoing-leader"));
  assert.equal(agentIdentity("outgoing-leader").role, "supervisor");
  assertRejected(await call("kanban_list", {}, old.config.headers));
  assertRejected(await call("kanban_supervise", { project: "demo" }, old.config.headers));
  assert.throws(() => resolveCompactIdentity({ KANBAN_TOKEN: tokenOf(old.config) }, getDb()));
  const next = await credential("incoming-leader");
  assert.notEqual((await call("kanban_list", {}, next.config.headers)).isError, true);
  changeProjectLeader("demo", "outgoing-leader", { actor: "ui", via: "ui" });
  assertRejected(await call("kanban_list", {}, old.config.headers));
  assertRejected(await call("kanban_list", {}, next.config.headers));
});

it("project and board registration revocation invalidate credentials permanently, including after re-registration", async () => {
  for (const board of [false, true]) {
    if (board) changeKanbanLeader("revoked-leader", { actor: "ui", via: "ui" });
    else await register("revoked-leader");
    const old = await credential("revoked-leader");
    if (board) changeKanbanLeader(null, { actor: "ui", via: "ui" });
    else changeProjectLeader("demo", null, { actor: "ui", via: "ui" });
    assertRejected(await call("kanban_list", {}, old.config.headers));
    await assert.rejects(runKanban(["mcp-credential", "--out", output()], env("revoked-leader")));
    if (board) changeKanbanLeader("revoked-leader", { actor: "ui", via: "ui" });
    else await register("revoked-leader");
    assertRejected(await call("kanban_list", {}, old.config.headers));
    setProjectSupervisor("demo", null);
    setSupervisorAgentId(null);
  }
});

it("settings project deletion revokes the outgoing credential while the agent still leads another project", async () => {
  await register("settings-leader");
  await register("settings-leader", "other");
  const old = await credential("settings-leader");
  setSupervisorAgentId("unchanged-board-leader");
  const unaffected = await credential("unchanged-board-leader");
  const view = await readSettings(async () => []);
  const document = structuredClone(view.document!);
  delete document.projects.demo;
  const saved = await writeSettings({ revision: view.revision, document }, async () => []);
  assert.equal(saved.ok, true);
  assert.equal(saved.leaders.some(row => row.project === "demo"), false);
  assert.ok(saved.leaders.some(row => row.project === "other" && row.agentId === "settings-leader"));
  assert.equal(agentIdentity("settings-leader").role, "supervisor");
  assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM tokens WHERE token = ?").get(tokenOf(old.config))!.n, 0);
  assert.throws(() => resolveTokenIdentity(tokenOf(old.config)));
  assertRejected(await call("kanban_list", {}, old.config.headers));
  assert.notEqual((await call("kanban_list", {}, unaffected.config.headers)).isError, true);
});

it("settings project deletion permanently revokes a sole leader's credential across project re-addition and re-registration", async () => {
  await register("settings-returning-leader");
  const old = await credential("settings-returning-leader");
  const view = await readSettings(async () => []);
  const document = structuredClone(view.document!);
  delete document.projects.demo;
  const removed = await writeSettings({ revision: view.revision, document }, async () => []);
  assert.equal(removed.ok, true);
  assert.equal(removed.leaders.some(row => row.agentId === "settings-returning-leader"), false);
  assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM tokens WHERE token = ?").get(tokenOf(old.config))!.n, 0);
  const restored = await writeSettings({ revision: removed.revision, document: view.document! }, async () => []);
  assert.equal(restored.ok, true);
  await register("settings-returning-leader");
  assert.equal(agentIdentity("settings-returning-leader").role, "supervisor");
  // Do not use the old token until registration is restored: validation itself must not be what revokes it.
  assert.throws(() => resolveTokenIdentity(tokenOf(old.config)));
  assertRejected(await call("kanban_list", {}, old.config.headers));
  const fresh = await credential("settings-returning-leader");
  assert.notEqual((await call("kanban_list", {}, fresh.config.headers)).isError, true);
});

it("settings saves preserve credentials when registration is unchanged or a deletion edit is rejected", async () => {
  await register("settings-stable-leader");
  const current = await credential("settings-stable-leader");
  const view = await readSettings(async () => []);
  const document = structuredClone(view.document!);
  delete document.projects.demo;
  const changed = await writeSettings({ revision: view.revision,
    document: { ...view.document!, language: view.document!.language === "en" ? "zh-CN" : "en" } }, async () => []);
  assert.equal(changed.ok, true);
  const stale = await writeSettings({ revision: view.revision, document }, async () => []);
  assert.equal(stale.ok, false);
  assert.equal(stale.conflict, true);
  const invalid = await writeSettings({ revision: changed.revision,
    document: { ...document, concurrency: { ...document.concurrency, global: 0 } } }, async () => []);
  assert.equal(invalid.ok, false);
  assert.equal(invalid.conflict, false);
  assert.equal(resolveTokenIdentity(tokenOf(current.config)).agentId, "settings-stable-leader");
  assert.notEqual((await call("kanban_list", {}, current.config.headers)).isError, true);
});

it("each call rechecks real registration and worker/schedule identity, including changes outside the registration API", async () => {
  await register("dynamic-leader");
  const first = await credential("dynamic-leader");
  setProjectSupervisor("demo", null);
  assertRejected(await call("kanban_show", { id: 1 }, first.config.headers));
  await register("dynamic-leader");
  assertRejected(await call("kanban_list", {}, first.config.headers));
  const next = await credential("dynamic-leader");
  const card = createTask({ project: "demo", title: "Unexpected binding", role: "executor" });
  getDb().prepare("UPDATE tasks SET agent_id = ? WHERE id = ?").run("dynamic-leader", card.id);
  assertRejected(await call("kanban_list", {}, next.config.headers));
});

it("unbound, unregistered, newly scheduled and unreadable-registration credentials fail closed", async () => {
  for (const agentId of [null, "unregistered", "../invalid-agent"]) {
    const token = issueToken("leader-mcp", null, agentId);
    assertRejected(await call("kanban_list", {}, { Authorization: `Bearer ${token}` }));
  }
  await register("scheduled-later");
  const scheduled = await credential("scheduled-later");
  writeFileSync(join(root, "agents", "bucket", "scheduled-later.json"), JSON.stringify({ id: "scheduled-later", labels: { "paseo.schedule-id": "demo" } }));
  assertRejected(await call("kanban_list", {}, scheduled.config.headers));
  setProjectSupervisor("demo", "config-leader");
  const configured = await credential("config-leader");
  const saved = readFileSync(configPath(), "utf8");
  try {
    writeFileSync(configPath(), "{");
    assertRejected(await call("kanban_list", {}, configured.config.headers));
  } finally { writeFileSync(configPath(), saved); }
});

it("rotation, expiry and exclusive file creation bound the exported secret without overwriting files or following symlinks", async () => {
  await register("rotating-leader");
  const old = await credential("rotating-leader");
  const fresh = await credential("rotating-leader");
  assertRejected(await call("kanban_list", {}, old.config.headers));
  const count = () => getDb().prepare("SELECT COUNT(*) AS n FROM tokens WHERE role = 'leader-mcp'").get()!.n;
  assert.equal(count(), 1);
  const target = output(); writeFileSync(target, "keep");
  const link = output(); symlinkSync(target, link);
  for (const path of [target, link, "relative-credential.json", join(root, "absent", "credential.json")]) {
    await assert.rejects(runKanban(["mcp-credential", "--out", path], env("rotating-leader")));
    assert.equal(count(), 1);
  }
  assert.equal(readFileSync(target, "utf8"), "keep");
  assert.notEqual((await call("kanban_list", {}, fresh.config.headers)).isError, true);
  getDb().prepare("UPDATE tokens SET expires_at = ? WHERE token = ?").run(new Date(0).toISOString(), tokenOf(fresh.config));
  assertRejected(await call("kanban_list", {}, fresh.config.headers));
});

it("the board-started guest credential still self-registers and uses MCP without becoming a worker", async () => {
  const token = issueToken("guest", null, "board-started-leader");
  const headers = { Authorization: `Bearer ${token}` };
  assert.notEqual((await call("kanban_supervise", { project: "demo" }, headers)).isError, true);
  assert.notEqual((await call("kanban_list", {}, headers)).isError, true);
  assert.notEqual((await call("kanban_create", { project: "demo", title: "Existing path", role: "executor" }, headers)).isError, true);
  assert.equal(resolveCliIdentity({ KANBAN_TOKEN: token }).role, "supervisor");
});
