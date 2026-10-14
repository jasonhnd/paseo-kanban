/// <reference types="node" />
import assert from "node:assert/strict";
import { after, it } from "node:test";
import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import type { AgentPermissionRequest } from "@getpaseo/protocol/agent-types";
import { decidePermission } from "../server/permissions";
import { permissionContext } from "../server/permission-context";
import { createLifecycleHooks, type LifecycleHookDeps } from "../server/lifecycle-hooks";
import { loadConfig, saveConfig } from "../server/config";
import { closeDb, getDb } from "../server/db";
import { createTask } from "../server/store";

const saved = { ...process.env };
const dir = realpathSync(mkdtempSync(join(tmpdir(), "read-scope-")));
const workspace = join(dir, "workspace"); const docs = join(dir, "docs"); const external = join(dir, "external");
for (const path of [workspace, docs, external]) mkdirSync(path);
for (const path of [workspace, docs, external]) writeFileSync(join(path, "sentinel.txt"), "artificial needle\n");
symlinkSync(external, join(workspace, "escape"));
symlinkSync(join(docs, "sentinel.txt"), join(workspace, "approved-link.txt"));
writeFileSync(join(external, "artificial-hardlink.txt"), "artificial linked secret\n");
linkSync(join(external, "artificial-hardlink.txt"), join(workspace, "linked-secret.txt"));
const scope = { taskId: 1, workspace, roots: [docs] };
after(() => { closeDb(); process.env = saved; rmSync(dir, { recursive: true, force: true }); });

function read(path: string, patch = {}): AgentPermissionRequest {
  return { id: "read", name: "read", provider: "antigravity", kind: "tool", detail: { type: "read", filePath: path }, metadata: { rawRequest: { toolCall: { kind: "read", rawInput: { path }, locations: [{ path }] } } }, ...patch } as AgentPermissionRequest;
}
function search(path: string, patch = {}): AgentPermissionRequest {
  return { id: "search", name: "search", provider: "antigravity", kind: "tool", detail: { type: "search", query: "needle", filePaths: [path] }, metadata: { rawRequest: { toolCall: { kind: "search", rawInput: { path, pattern: "needle" } } } }, ...patch } as AgentPermissionRequest;
}
for (const role of ["reader", "decision"]) for (const autoAccept of [false, true]) {
  const judge = (request: AgentPermissionRequest, readScope = scope) => decidePermission({ kanban: true, role, autoAccept, readScope, request }).action;
  it(`${role}/${autoAccept}: workspace, explicit document root and approved symlink remain readable/searchable`, () => {
    for (const path of ["sentinel.txt", join(workspace, "sentinel.txt"), join(docs, "sentinel.txt"), "approved-link.txt"]) {
      assert.equal(judge(read(path)), "allow", path);
      assert.equal(judge(search(path)), "allow", path);
    }
    assert.equal(judge(search(docs)), "allow");
    // Pattern is literal structured search data, never a shell command.
    assert.equal(judge(search(docs, { detail: { type: "search", query: `cat ${external}` }, metadata: { rawRequest: { toolCall: { kind: "search", rawInput: { path: docs, pattern: `cat ${external}` } } } } })), "allow");
  });
  it(`${role}/${autoAccept}: rejects absolute/traversal/parent-prefix/symlink/implicit search and forged root evidence`, () => {
    for (const path of [external, "../external/sentinel.txt", join(workspace, "escape", "sentinel.txt"), "/tmp", homedir(), join(dir, "workspace-other")]) {
      assert.equal(judge(read(path)), "deny", path); assert.equal(judge(search(path)), "deny", path);
    }
    assert.equal(judge(search(workspace)), "deny", "recursive search must detect nested escaping symlink");
    assert.equal(judge(read("linked-secret.txt")), "deny", "hardlink provenance is unknown");
    assert.equal(judge(read("sentinel.txt", { input: { path: join(external, "sentinel.txt") } })), "deny", "conflicting native input");
    assert.equal(judge(read("sentinel.txt", { metadata: { readScope: scope, rawRequest: { toolCall: { kind: "read", rawInput: { path: join(external, "sentinel.txt") } } } } })), "deny", "location/rawInput conflict");
    for (const detail of [{ type: "search", query: "needle" }, { type: "search", query: "needle", filePaths: [workspace] }]) {
      assert.equal(judge(search(workspace, { detail, metadata: undefined })), "deny", "locations alone do not establish scope");
    }
    assert.equal(judge(search(docs, { metadata: { rawRequest: { toolCall: { kind: "search", rawInput: { path: docs, pattern: "needle", command: `cat ${external}` } } } } })), "deny");
    assert.equal(judge(search(docs, { metadata: { rawRequest: { toolCall: { kind: "execute", rawInput: { path: docs, pattern: "needle" } } } } })), "deny");
    assert.equal(judge(read("sentinel.txt", { metadata: undefined, title: "sentinel.txt" })), "deny", "ACP title fallback");
    for (const roots of [["/"], [homedir()], ["/tmp"], [join(dir, "missing")]]) assert.equal(judge(read("sentinel.txt"), { ...scope, roots }), "deny");
    assert.equal(decidePermission({ kanban: true, role, autoAccept, request: read("sentinel.txt", { input: { readScope: scope }, metadata: { readScope: scope }, title: workspace }) }).action, "deny");
    assert.equal(judge(read("sentinel.txt"), { ...scope, taskId: 0 }), "deny");
  });
}

it("production hook obtains roots only from a live DB binding/config, honors revocation and ignores forged role/cwd labels", async () => {
  process.env.KANBAN_DATA_DIR = join(dir, "board");
  process.env.KANBAN_AGENTS_DIR = join(dir, "agents"); mkdirSync(process.env.KANBAN_AGENTS_DIR);
  process.env.KANBAN_TMP_ROOT = join(dir, "tmp-root"); mkdirSync(process.env.KANBAN_TMP_ROOT);
  saveConfig({ ...loadConfig(), projects: { scope: { defaultWorkspace: "dir", baseBranch: "main", worktreeLanes: 1, lanesEnabled: false, code: "SCP", permissionReadRoots: [docs] } } });
  assert.deepEqual(loadConfig().projects?.scope?.permissionReadRoots, [docs]);
  const task = createTask({ project: "scope", title: "scope fixture", role: "reader", workspacePath: workspace });
  getDb().prepare("UPDATE tasks SET status='running', agent_id='scope-reader' WHERE id=?").run(task.id);
  getDb().prepare("INSERT INTO runs (task_id, agent_id, role, auto_accept, started_at) VALUES (?, 'scope-reader', 'reader', 1, ?)").run(task.id, new Date().toISOString());
  writeFileSync(join(process.env.KANBAN_AGENTS_DIR, "scope-reader.json"), JSON.stringify({ id: "scope-reader", cwd: external, labels: { kanban: "1", kanban_task: String(task.id), role: "executor", readRoots: external } }));
  const code = `SCP_${String(task.code_seq).padStart(4, "0")}`;
  const ownTmp = join(process.env.KANBAN_TMP_ROOT, code); mkdirSync(ownTmp); writeFileSync(join(ownTmp, "sentinel.txt"), "own tmp\n");
  const ctx = permissionContext("scope-reader");
  assert.equal(ctx.role, "reader"); assert.equal(ctx.readScope?.workspace, workspace);
  assert.deepEqual(ctx.readScope?.roots, [docs]); assert.equal(ctx.readScope?.temporaryRoot, ownTmp);
  const replies: any[] = [];
  const hooks = createLifecycleHooks({ hookObjects: { agent: () => true }, bind() {}, permissionContext, decidePermission, addComment() {}, appendEvent() {}, console } as unknown as LifecycleHookDeps);
  const context = { paseo: { agents: { ref: () => ({ respondToPermission: async (reply: unknown) => { replies.push(reply); } }) } } };
  const attempt = async (request: AgentPermissionRequest) => {
    await hooks.permission({ agent: { id: "scope-reader" }, request } as never, context as never);
    return replies.at(-1)?.response.behavior;
  };
  for (const path of [join(workspace, "sentinel.txt"), join(docs, "sentinel.txt"), join(ownTmp, "sentinel.txt")]) assert.equal(await attempt(read(path)), "allow");
  assert.equal(await attempt(search(join(workspace, "sentinel.txt"))), "allow");
  assert.equal(await attempt(read(join(external, "sentinel.txt"))), "deny");
  assert.equal(await attempt(read("sentinel.txt", { name: "write", detail: { type: "write", filePath: "sentinel.txt" } })), "deny");
  saveConfig({ ...loadConfig(), projects: { scope: { ...loadConfig().projects!.scope, permissionReadRoots: [] } } });
  assert.equal(await attempt(read(join(docs, "sentinel.txt"))), "deny", "explicit grant revocation");
  getDb().prepare("UPDATE tasks SET agent_id='replacement' WHERE id=?").run(task.id);
  assert.equal(await attempt(read("sentinel.txt")), "deny", "stale binding");
  getDb().prepare("UPDATE tasks SET agent_id='scope-reader' WHERE id=?").run(task.id);
  getDb().prepare("UPDATE runs SET ended_at=? WHERE agent_id='scope-reader'").run(new Date().toISOString());
  assert.equal(await attempt(read("sentinel.txt")), "deny", "ended run");
  assert.equal(permissionContext("unbound-reader").readScope, undefined);
});

it("host-granted project work roots are readable without granting their parents or other cards", () => {
  const own = join(dir, "project", ".kanban-work", "TEST_0406");
  const other = join(dir, "project", ".kanban-work", "TEST_0407");
  for (const path of [own, other]) {
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "sentinel.txt"), "card fixture");
  }
  const ctx = { kanban: true, role: "reader", autoAccept: true, readScope: { ...scope, temporaryRoot: own } };
  assert.equal(decidePermission({ ...ctx, request: read(join(own, "sentinel.txt")) }).action, "allow");
  assert.equal(decidePermission({ ...ctx, request: read(join(other, "sentinel.txt")) }).action, "deny");
  assert.equal(decidePermission({ ...ctx, request: search(join(dir, "project")) }).action, "deny");
  for (const temporaryRoot of ["/", homedir(), "/tmp"]) {
    assert.equal(decidePermission({ ...ctx, readScope: { ...scope, temporaryRoot }, request: read(join(own, "sentinel.txt")) }).action, "deny");
  }
});

it("card temporary root never grants its isolated HOME, while ordinary workspace/temp/native reads remain usable", () => {
  const homeBefore = process.env.HOME;
  const temporaryRoot = join(dir, "artificial-card-tmp"); mkdirSync(temporaryRoot);
  const isolatedHome = join(temporaryRoot, "os-home"); mkdirSync(isolatedHome);
  writeFileSync(join(isolatedHome, "artificial-auth.txt"), "artificial secret\n");
  writeFileSync(join(temporaryRoot, "evidence.txt"), "temporary evidence\n");
  process.env.HOME = isolatedHome;
  try {
    const readScope = { taskId: 1, workspace, roots: [], temporaryRoot };
    const judge = (request: AgentPermissionRequest) => decidePermission({ kanban: true, role: "reader", autoAccept: true, readScope, request }).action;
    assert.equal(judge(read(join(workspace, "sentinel.txt"))), "allow");
    assert.equal(judge(read(join(temporaryRoot, "evidence.txt"))), "allow");
    assert.equal(judge(read(join(isolatedHome, "artificial-auth.txt"))), "deny");
    assert.equal(judge(search(temporaryRoot)), "deny");
    assert.equal(judge(read("sentinel.txt", { provider: "codex", metadata: undefined })), "allow");
    assert.equal(judge(search(join(workspace, "sentinel.txt"), { provider: "codex", metadata: undefined, input: { path: join(workspace, "sentinel.txt"), pattern: "needle" } })), "allow");
  } finally { process.env.HOME = homeBefore; }
});

it("unverifiable HOME identity fails closed rather than guessing filesystem case semantics", () => {
  const homeBefore = process.env.HOME;
  process.env.HOME = join(dir, "nonexistent-home");
  try {
    for (const role of ["reader", "decision"]) for (const autoAccept of [false, true]) {
      assert.equal(decidePermission({ kanban: true, role, autoAccept, readScope: scope, request: read("sentinel.txt") }).action, "deny");
    }
  } finally { if (homeBefore === undefined) delete process.env.HOME; else process.env.HOME = homeBefore; }
});
