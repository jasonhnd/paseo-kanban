/// <reference types="node" />
import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig } from "../server/config";
import { closeDb, getDb } from "../server/db";
import { type AgentLauncher } from "../server/dispatch";
import { startTask } from "./helpers/compat-dispatch";
import { approveTask, completeTask, settleQuietHandoff } from "../server/flow";
import { type DispatchMatrix } from "../server/matrix";
import type { PaseoApi } from "@getpaseo/client";
import { launcherFrom } from "../server/paseo";
import { readCompatibilityPoolSnapshot as readPoolSnapshot, type PoolSnapshot } from "../server/pools";
import { resetReconcileForTests } from "../server/schedule";
import { runTick } from "./helpers/compat-schedule";
import { createLifecycleHooks, type LifecycleHookDeps } from "../server/lifecycle-hooks";
import { permissionContext } from "../server/permission-context";
import { decidePermission } from "../server/permissions";
import { actualFamily, type Profile } from "../server/profiles";
import { routeProfile, type RouteInput } from "../server/routing";
import { createTask, getTask } from "../server/store";

// All quota/provider data below is synthetic. No daemon, provider or real card is started.
const dir = mkdtempSync(join(tmpdir(), "antigravity-boundary-"));
const agentsDir = join(dir, "agents");
mkdirSync(agentsDir);
process.env.KANBAN_AGENTS_DIR = agentsDir;
process.env.KANBAN_DATA_DIR = dir;
process.env.KANBAN_PASEO_CONFIG = join(dir, "paseo.json");
process.env.KANBAN_POOL_STATUS = join(dir, "missing-pools.json");
process.env.KANBAN_DISPATCH_MATRIX = join(dir, "missing-matrix.json");
const banned = { providers: [], families: [], pools: [], models: [] };
const now = Date.now();
const reviewer: Profile = { id: "r", name: "Synthetic non-Google review", provider: "grok", model: "grok-4.7", role: "reviewer", family: "xai", pool: "other" };
function google(role = "executor", patch: Partial<Profile> = {}): Profile {
  return { id: "g", name: "Synthetic Google", provider: "antigravity", model: "gemini-3.8-flash-medium", modeId: "default", role: "candidate", candidateFor: role, family: "google", pool: "antigravity-gemini", ...patch };
}
function snapshot(patch: Partial<PoolSnapshot> = {}, entry = {}): PoolSnapshot {
  return { state: "fresh", message: "SYNTHETIC known quota, not actual ACP evidence", generatedAt: new Date(now).toISOString(), hasPool: () => true, dispatchable: () => true,
    entry: () => ({ dispatchable: true, usedPct: 10, quotaProtection: "pause", readingExpiresAt: new Date(now + 3600_000).toISOString(), prefer: false, deprioritize: false, resetsAt: null, reason: null, onlyRoles: null, ...entry }), ...patch };
}
function matrix(p: Profile): DispatchMatrix {
  const item = { profile: p.name, effort: null, paused: false };
  const reviews = Object.fromEntries(["L1", "L2", "L3", "L4"].map(tier => [tier, [{ profile: reviewer.name, effort: null, paused: false }]]));
  return { version: 1, generatedAt: new Date(now).toISOString(), defaultTier: "L2", downgradeWhenTight: [],
    executor: { L1: [item], L2: [item], L3: [item], L4: [item] }, reviewerFamilies: { google: reviews }, star: { reader: [item], batch: [item], decision: [item] } };
}
function route(p = google(), patch: Partial<RouteInput> = {}) {
  return routeProfile({ profiles: [p, reviewer], role: p.candidateFor ?? p.role ?? "executor", review: false, tier: "L1", byPool: {}, poolLimits: {}, snapshot: snapshot(), now, ...patch });
}
function host(provider: unknown = { extends: "acp", enabled: true, command: ["/synthetic/agy-acp-server/1.3.0/agy_acp_server.par"] }) {
  writeFileSync(process.env.KANBAN_PASEO_CONFIG!, JSON.stringify({ agents: { providers: { antigravity: provider } } }));
}
function writeMatrix(m: DispatchMatrix) {
  writeFileSync(process.env.KANBAN_DISPATCH_MATRIX!, JSON.stringify({ ...m, roles: {
    executor: m.executor, reviewer: { byExecutorFamily: m.reviewerFamilies },
    ...Object.fromEntries(Object.entries(m.star).map(([role, items]) => [role, { "*": items }])),
  } }));
}
function noneQuota(entry: Record<string, unknown> = {}) {
  writeFileSync(process.env.KANBAN_POOL_STATUS!, JSON.stringify({ generatedAt: new Date().toISOString(), pools: {
    "antigravity-gemini": { dispatchable: true, quotaProtection: "none", usedPct: null, readingExpiresAt: null, ...entry },
    other: { dispatchable: true },
  } }));
  return readPoolSnapshot();
}
function endpoint(cwd: string, taskId: number) {
  const calls: Parameters<AgentLauncher["create"]>[0][] = [];
  const sends: string[] = [];
  const create = async (input: Parameters<AgentLauncher["create"]>[0]) => {
    calls.push(input);
    return { id: `anonymous-${taskId}-${calls.length}`, workspaceId: "anonymous-workspace" };
  };
  // Real launcher adapter, synthetic endpoints. No SDK connection or provider process.
  const api = { agents: { create, ref: (id: string) => ({ send: async () => { sends.push(id); } }) }, workspaces: {
    list: async () => ({ entries: [], pageInfo: { nextCursor: null } }),
    ref: () => ({ agents: { create } }),
    create: async () => ({ id: "anonymous-workspace", directory: cwd, current: () => ({ workspaceDirectory: cwd, name: "anonymous" }) }),
  } } as unknown as PaseoApi;
  return { calls, sends, launcher: launcherFrom(api) };
}
beforeEach(() => {
  resetReconcileForTests();
  closeDb();
  rmSync(join(dir, "kanban.db"), { force: true });
  rmSync(process.env.KANBAN_POOL_STATUS!, { force: true });
  rmSync(process.env.KANBAN_DISPATCH_MATRIX!, { force: true });
  saveConfig({ autoStart: {}, supervisorAgentId: null, supervisors: {}, concurrency: { global: 100, roles: {}, pools: {} }, projects: { isolation: { alwaysTemp: false, defaultWorkspace: "dir", baseBranch: "main", worktreeLanes: 1, lanesEnabled: false } }, bannedProviders: banned, profileRules: {} });
  host();
});
after(() => { closeDb(); rmSync(dir, { recursive: true, force: true }); });

describe("explicit none quota authorization (anonymous production launch chain)", () => {
  for (const role of ["executor", "batch", "reader"]) for (const tier of ["L1", "L2"]) for (const modeId of ["default", undefined]) for (const autoAccept of [false, true]) {
    it(`none/null ${role}/${tier}/mode=${modeId ?? "omitted"}/autoAccept=${autoAccept} reaches runTick/startTask/launcherFrom`, async () => {
      const p = google(role, { modeId, family: "openai", featureValues: { auto_accept: autoAccept } });
      const m = matrix(p);
      writeMatrix(m);
      const pools = noneQuota();
      const cwd = mkdtempSync(join(dir, "anonymous-work-"));
      const task = createTask({ project: "isolation", title: "Anonymous none quota", role, workspacePath: cwd, tier });
      const { calls, launcher } = endpoint(cwd, task.id);
      const config = { ...loadConfig(), autoStart: { isolation: true } };
      saveConfig(config);
      const result = await runTick({ profiles: [p, reviewer], launcher, config, pools, matrix: { state: "ok", matrix: m, path: process.env.KANBAN_DISPATCH_MATRIX! } });
      assert.deepEqual(result.errors, []);
      assert.ok(result.started.includes(task.id), JSON.stringify(result.held));
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.config.provider, "antigravity/gemini-3.8-flash-medium");
      assert.equal(calls[0]?.config.modeId, "default");
      assert.equal(getTask(task.id).executor_family, "google");
      const run = getDb().prepare("SELECT provider, model, family, auto_accept FROM runs WHERE task_id = ? ORDER BY id DESC LIMIT 1").get(task.id);
      assert.deepEqual({ ...run }, { provider: "antigravity", model: "gemini-3.8-flash-medium", family: "google", auto_accept: role === "reader" ? 0 : Number(autoAccept) });
      if (role === "reader") assert.equal(calls[0]?.config.featureValues?.auto_accept, false);
      assert.equal(p.featureValues?.auto_accept, autoAccept);
      assert.equal(pools.entry(p.pool!).usedPct, null);
      assert.equal(pools.entry(p.pool!).readingExpiresAt, null);
      if (role !== "reader") {
        await completeTask(task.id, role, "Synthetic complete", { files: [], verification: [], risks: [] });
        assert.equal(getTask(task.id).status, "in_review");
        // Mutable task/profile labels cannot turn the recorded Google work into OpenAI work.
        getDb().prepare("UPDATE tasks SET executor_family = 'openai' WHERE id = ?").run(task.id);
        const bad = google("reviewer", { id: "bad", name: "Disguised Google review", role: "reviewer", family: "xai" });
        await startTask(task.id, launcher, "anonymous", { profiles: [p, bad, reviewer], chosen: bad, snapshot: pools });
        assert.equal(calls.length, 1);
        assert.equal(getTask(task.id).status, "in_review");
        const review = await runTick({ profiles: [p, reviewer], launcher, config, pools, matrix: { state: "ok", matrix: m, path: process.env.KANBAN_DISPATCH_MATRIX! } });
        assert.deepEqual(review.errors, []);
        assert.ok(review.started.includes(task.id));
        assert.equal(calls[1]?.config.provider, "grok/grok-4.7");
        const reviewRun = getDb().prepare("SELECT provider, model, family FROM runs WHERE task_id = ? AND role = 'reviewer' ORDER BY id DESC LIMIT 1").get(task.id);
        assert.deepEqual({ ...reviewRun }, { provider: "grok", model: "grok-4.7", family: "xai" });
      }
    });
  }
  for (const autoAccept of [false, true]) it(`none reader autoAccept=${autoAccept} uses production DB roots and permission hook`, async () => {
    const p = google("reader", { modeId: undefined, featureValues: { auto_accept: autoAccept } });
    const cwd = mkdtempSync(join(dir, "permission-work-"));
    const docs = mkdtempSync(join(dir, "approved-docs-"));
    const outside = mkdtempSync(join(dir, "unapproved-"));
    for (const path of [cwd, docs, outside]) writeFileSync(join(path, "sentinel.txt"), "artificial unchanged sentinel\n");
    saveConfig({ ...loadConfig(), projects: { isolation: { ...loadConfig().projects!.isolation!, permissionReadRoots: [docs] } } });
    const task = createTask({ project: "isolation", title: "Anonymous reader permissions", role: "reader", workspacePath: cwd, tier: "L1" });
    writeMatrix(matrix(p));
    const f = endpoint(cwd, task.id);
    await startTask(task.id, f.launcher, "test", { profiles: [p, reviewer], chosen: p, snapshot: noneQuota() });
    assert.equal(f.calls[0]?.config.featureValues?.auto_accept, false);
    const agentId = getTask(task.id).agent_id!;
    const agents = join(agentsDir, "anonymous");
    mkdirSync(agents, { recursive: true });
    const agentFile = join(agents, `${agentId}.json`);
    try {
      // Untrusted file labels cannot replace the live DB role or grant an external root.
      writeFileSync(agentFile, JSON.stringify({ id: agentId, cwd: outside,
        config: { featureValues: { auto_accept: autoAccept } }, labels: { kanban: "1", role: "executor", readRoots: outside } }));
      const ctx = permissionContext(agentId);
      assert.equal(ctx.role, "reader");
      assert.equal(ctx.autoAccept, autoAccept);
      assert.equal(ctx.readScope?.workspace, cwd);
      assert.deepEqual(ctx.readScope?.roots, [docs]);
      const replies: Array<{ response: { behavior: string } }> = [];
      const hooks = createLifecycleHooks({ hookObjects: { agent: () => true }, bind() {}, permissionContext, decidePermission,
        getDb, addComment() {}, appendEvent() {}, console: { error(message: unknown) { throw Error(String(message)); } },
      } as unknown as LifecycleHookDeps);
      const context = { paseo: { agents: { ref: () => ({ respondToPermission: async (reply: unknown) => { replies.push(reply as typeof replies[number]); } }) } } };
      const read = (path: string) => ({ name: "read", kind: "tool", provider: "antigravity", detail: { type: "read", filePath: path },
        metadata: { rawRequest: { toolCall: { kind: "read", rawInput: { path }, locations: [{ path }] } } } });
      const cases: Array<[unknown, string]> = [
        [read(join(cwd, "sentinel.txt")), "allow"], [read(join(docs, "sentinel.txt")), "allow"],
        [read(join(outside, "sentinel.txt")), "deny"],
        [{ name: "edit", kind: "tool", detail: { type: "edit", filePath: join(cwd, "sentinel.txt") } }, "deny"],
        [{ name: "switch_mode", kind: "mode", detail: { type: "unknown", input: { mode: "yolo" } } }, "deny"],
        [{ name: "execute", kind: "tool", detail: { type: "shell", command: "pwd" } }, "deny"],
      ];
      for (const [request, behavior] of cases) {
        await hooks.permission({ agent: { id: agentId }, request: { id: "anonymous-permission", ...(request as object) } } as never, context as never);
        assert.equal(replies.at(-1)?.response.behavior, behavior);
      }
      for (const path of [cwd, docs, outside]) assert.equal(readFileSync(join(path, "sentinel.txt"), "utf8"), "artificial unchanged sentinel\n");
    } finally {
      rmSync(agentFile, { force: true });
    }
  });
  for (const role of ["executor", "batch", "reader"]) for (const tier of ["L3", "L4", "unknown"]) {
    it(`none ${role}/${tier} refuses automatic, explicit and preselected starts`, async () => {
      const p = google(role); const m = matrix(p); const pools = noneQuota(); writeMatrix(m);
      for (const explicit of [false, true]) assert.equal(route(p, { role, tier, matrix: m, snapshot: pools, profileOverride: explicit ? p.id : null }).ok, false);
      const f = fixture(role, p);
      // Model a legacy corrupt stored tier; createTask itself already rejects unknown tiers.
      getDb().prepare("UPDATE tasks SET tier = ? WHERE id = ?").run(tier, f.task.id);
      await startTask(f.task.id, f.launcher, "test", { ...f.options, snapshot: pools });
      assert.equal(f.opened.length, 0);
    });
  }
  const negatives: Array<[string, Partial<Profile>, Record<string, unknown>, (m: DispatchMatrix) => void]> = [
    ["missing policy", {}, { quotaProtection: undefined }, () => {}],
    ["unknown policy", {}, { quotaProtection: "unknown" }, () => {}],
    ["missing dispatch", {}, { dispatchable: undefined }, () => {}],
    ["nonboolean dispatch", {}, { dispatchable: "true" }, () => {}],
    ["closed dispatch", {}, { dispatchable: false }, () => {}],
    ["pause without usage", {}, { quotaProtection: "pause", readingExpiresAt: new Date(now + 3600_000).toISOString() }, () => {}],
    ["pause without expiry", {}, { quotaProtection: "pause", usedPct: 10 }, () => {}],
    ["pause with expired usage", {}, { quotaProtection: "pause", usedPct: 10, readingExpiresAt: new Date(now - 1).toISOString() }, () => {}],
    ["pool role restriction", {}, { onlyRoles: ["reviewer"] }, () => {}],
    ["other pool none", { pool: "other" }, {}, () => {}],
    ["other provider none", { provider: "gemini-cli" }, {}, () => {}],
    ["other model none", { model: "gemini-3.8-flash-high" }, {}, () => {}],
    ["edit mode none", { modeId: "auto_edit" }, {}, () => {}],
    ["paused profile none", { paused: true }, {}, () => {}],
    ["paused matrix none", {}, {}, m => { m.executor.L1![0]!.paused = true; }],
    ["unlisted matrix none", {}, {}, m => { m.executor.L1 = []; }],
    ["stale matrix none", {}, {}, m => { m.stale = true; }],
  ];
  for (const [label, patch, entry, change] of negatives) it(`${label} refuses automatic/explicit/preselected none routes`, async () => {
    const p = google("executor", patch); const pools = noneQuota(entry); const m = matrix(p); change(m); writeMatrix(m);
    for (const explicit of [false, true]) assert.equal(route(p, { snapshot: pools, matrix: m, profileOverride: explicit ? p.id : null }).ok, false);
    const f = fixture("executor", p);
    await startTask(f.task.id, f.launcher, "test", { ...f.options, snapshot: pools,
      routing: { profiles: [p, reviewer], role: "executor", review: false, tier: "L1", byPool: {}, poolLimits: {}, snapshot: pools, matrix: m } });
    assert.equal(f.opened.length, 0);
  });
  for (const missing of ["absent", "stale", "unlisted"] as const) it(`none ${missing} pool snapshot cannot inherit the open fallback`, async () => {
    const p = google(); const m = matrix(p); noneQuota(); writeMatrix(m);
    if (missing === "absent") rmSync(process.env.KANBAN_POOL_STATUS!);
    if (missing === "stale") utimesSync(process.env.KANBAN_POOL_STATUS!, new Date(0), new Date(0));
    if (missing === "unlisted") writeFileSync(process.env.KANBAN_POOL_STATUS!, JSON.stringify({ pools: { other: { dispatchable: true, quotaProtection: "none" } } }));
    const pools = readPoolSnapshot();
    for (const explicit of [false, true]) assert.equal(route(p, { snapshot: pools, matrix: m, profileOverride: explicit ? p.id : null }).ok, false);
    const f = fixture("executor"); await startTask(f.task.id, f.launcher, "test", { ...f.options, snapshot: pools }); assert.equal(f.opened.length, 0);
  });
  it("none refuses missing matrix, nonofficial ACP and each retained ban", () => {
    const p = google(); const pools = noneQuota(); const m = matrix(p);
    assert.equal(route(p, { snapshot: pools, matrix: null }).ok, false);
    host({ extends: "acp", command: ["/synthetic/agy-acp-server/1.4.0/agy_acp_server.par"] });
    assert.equal(route(p, { snapshot: pools, matrix: m }).ok, false); host();
    for (const gate of [{ providers: ["antigravity"] }, { families: ["google"] }, { models: ["gemini"] }, { pools: ["antigravity-gemini"] }]) {
      saveConfig({ ...loadConfig(), bannedProviders: { ...banned, ...gate } });
      for (const explicit of [false, true]) assert.equal(route(p, { snapshot: pools, matrix: m, profileOverride: explicit ? p.id : null }).ok, false);
    }
  });
  for (const role of ["decision", "reviewer"]) it(`none cannot authorize ${role}`, async () => {
    const p = google(role); const pools = noneQuota(); const m = matrix(p); writeMatrix(m);
    const f = fixture(role, p); await startTask(f.task.id, f.launcher, "test", { ...f.options, snapshot: pools });
    assert.equal(f.opened.length, 0);
  });
  for (const role of ["executor", "batch", "reader"] as const) it(`none ${role} resume rechecks current policy/matrix and allows compliant default agent`, async () => {
    const p = google(role, { modeId: undefined }); const m = matrix(p); writeMatrix(m);
    const pools = noneQuota(); const f = fixture(role, p);
    await startTask(f.task.id, f.launcher, "test", { ...f.options, snapshot: pools }); assert.equal(f.opened.length, 1);
    getDb().prepare("UPDATE tasks SET status = 'rework' WHERE id = ?").run(f.task.id);
    await startTask(f.task.id, f.launcher, "test", { ...f.options, snapshot: noneQuota({ dispatchable: false }) });
    assert.equal(f.sent.length, 0);
    if (role === "executor") m.executor.L1![0]!.paused = true; else m.star[role]![0]!.paused = true;
    writeMatrix(m);
    await startTask(f.task.id, f.launcher, "test", { ...f.options, snapshot: pools }); assert.equal(f.sent.length, 0);
    writeMatrix(matrix(p));
    await startTask(f.task.id, f.launcher, "test", { ...f.options, snapshot: pools }); assert.equal(f.sent.length, 1);
    assert.equal(f.opened.length, 1); assert.equal(getTask(f.task.id).status, "running");
  });
});

describe("Google authorization invariants (synthetic routing)", () => {
  for (const role of ["executor", "batch", "reader"]) for (const tier of ["L1", "L2"]) for (const useMatrix of [false, true]) for (const explicit of [false, true]) {
    it(`${role}/${tier}/${useMatrix ? "matrix" : "roster"}/${explicit ? "explicit" : "automatic"} allows only with other gates satisfied`, () => {
      const p = google(role);
      assert.equal(route(p, { role, tier, matrix: useMatrix ? matrix(p) : null, profileOverride: explicit ? p.id : null }).ok, true);
    });
  }
  const negatives: Array<[string, Partial<Profile>, Partial<RouteInput>]> = [
    ["L3", {}, { tier: "L3" }], ["L4", {}, { tier: "L4" }],
    ["decision", { candidateFor: "decision" }, { role: "decision" }],
    ["reviewer", { role: "reviewer", candidateFor: undefined }, { role: "reviewer", review: true }],
    ["wrong model", { model: "gemini-3.8-pro" }, {}], ["wrong version", { model: "gemini-3.8-flash-high" }, {}],
    ["wrong provider", { provider: "gemini-cli" }, {}], ["Cursor", { provider: "cursor" }, {}],
    ["Google alias", { provider: "google-ai", family: "openai", pool: "other" }, {}],
    ["Gemini disguised as grok", { provider: "grok", family: "xai", pool: "other" }, {}],
    ["pool alias", { pool: "other" }, {}],
    ["personal paused", { role: "personal", candidateFor: undefined, pausedCandidateFor: "executor" }, { role: "executor" }],
    ["personal", { role: "personal", candidateFor: undefined }, { role: "executor" }],
    ["paused", { paused: true }, {}], ["pause notes", { notes: "[Paused]" }, {}],
    ["role mismatch", { candidateFor: "reader" }, { role: "executor" }],
    ["yolo", { modeId: "yolo" }, {}], ["auto edit", { modeId: "auto_edit" }, {}],
    ["unknown pool", {}, { snapshot: snapshot({ hasPool: () => false }) }],
    ["missing quota", {}, { snapshot: snapshot({ state: "missing" }) }],
    ["stale quota", {}, { snapshot: snapshot({ state: "stale" }) }],
    ["unknown usage", {}, { snapshot: snapshot({}, { usedPct: null }) }],
    ["exhausted", {}, { snapshot: snapshot({}, { usedPct: 100 }) }],
    ["closed pool", {}, { snapshot: snapshot({}, { dispatchable: false }) }],
    ["unknown protection", {}, { snapshot: snapshot({}, { quotaProtection: undefined }) }],
    ["undeclared dispatch", {}, { snapshot: snapshot({}, { dispatchableExplicit: false }) }],
    ["unknown tier", {}, { tier: "unknown" }],
    ["expired", {}, { snapshot: snapshot({}, { readingExpiresAt: new Date(now - 1).toISOString() }) }],
  ];
  for (const [label, change, patch] of negatives) for (const useMatrix of [false, true]) for (const explicit of [false, true]) {
    it(`${label}/${useMatrix ? "matrix" : "roster"}/${explicit ? "explicit" : "automatic"} refuses`, () => {
      const p = google("executor", change);
      const checked = route(p, { matrix: useMatrix ? matrix(p) : null, profileOverride: explicit ? p.id : null, ...patch });
      // Automatic review may still select the eligible non-Google reviewer.
      assert.ok(!checked.ok || (patch.role === "reviewer" && checked.profile.id === reviewer.id));
    });
  }
  it("explicit selection cannot bypass an empty, missing or stale-paused matrix slot", () => {
    const p = google();
    for (const items of [[], [{ profile: p.name, effort: null, paused: true }]]) {
      const m = matrix(p); m.executor.L1 = items; m.stale = true;
      assert.equal(route(p, { matrix: m, profileOverride: p.id }).ok, false);
    }
  });
  it("keeps every existing ban, including a factual Google family disguised as openai", () => {
    const p = google("reader", { family: "openai" });
    for (const gate of [{ providers: ["antigravity"] }, { families: ["google"] }, { models: ["gemini"] }, { pools: ["antigravity-gemini"] }]) {
      saveConfig({ autoStart: {}, supervisorAgentId: null, supervisors: {}, concurrency: { global: 100, roles: {}, pools: {} }, bannedProviders: { ...banned, ...gate }, families: {} });
      for (const explicit of [false, true]) assert.equal(route(p, { profileOverride: explicit ? p.id : null }).ok, false);
    }
  });
  it("refuses built-in CLI drivers, disabled providers, other ACP versions and extra arguments", () => {
    for (const config of [undefined, { extends: "acp", command: ["agy"] }, { extends: "antigravity", command: ["agy"] }, { extends: "acp", enabled: false, command: ["/synthetic/agy-acp-server/1.3.0/agy_acp_server.par"] }, { extends: "acp", command: ["/synthetic/agy-acp-server/1.4.0/agy_acp_server.par"] }, { extends: "acp", command: ["/synthetic/agy-acp-server/1.3.0/agy_acp_server.par", "--dangerously-skip-permissions"] }]) {
      host(config ?? {}); assert.equal(route().ok, false);
    }
  });
  it("preserves non-Google automatic and explicit routing, including the legacy explicit scope", () => {
    const p: Profile = { id: "other-ex", name: "Other", provider: "synthetic-other", model: "synthetic-model", family: "anthropic", role: "executor" };
    for (const explicit of [false, true]) assert.equal(route(p, { tier: "L4", profileOverride: explicit ? p.id : null }).ok, true);
    assert.equal(route({ ...p, role: "personal" }, { role: "reader", tier: "L3", profileOverride: p.id }).ok, true);
  });
  for (const role of ["executor", "batch"]) for (const useMatrix of [false, true]) {
    it(`${role}/${useMatrix ? "matrix" : "roster"} requires a non-Google reviewer, with no same-family fallback`, () => {
      const p = google(role); const disguised = google("reviewer", { id: "bad", name: reviewer.name, role: "reviewer", family: "openai" });
      const result = route(p, { profiles: [p, disguised], role, matrix: useMatrix ? matrix(p) : null });
      assert.equal(result.ok, false);
      assert.equal(route(p, { role, matrix: useMatrix ? matrix(p) : null }).ok, true);
    });
  }
  it("actual review uses stored Google run facts and rejects disguised explicit reviewers", () => {
    const bad = google("reviewer", { id: "bad", name: "Disguised review", family: "openai", role: "reviewer" });
    const input = { role: "reviewer", review: true, executorFamily: "openai", executorProvider: "antigravity", executorModel: "gemini-3.8-flash-medium", reviewsExecutor: true, profiles: [bad, reviewer] };
    for (const m of [null, matrix(google())]) {
      const good = route(google(), { ...input, matrix: m }); assert.equal(good.ok, true); if (good.ok) assert.equal(good.profile.id, reviewer.id);
      const no = route(google(), { ...input, matrix: m, profileOverride: bad.id }); assert.equal(no.ok, false); if (!no.ok) assert.equal(no.action, "hold");
    }
    assert.equal(actualFamily(bad), "google");
  });
});

function fixture(role: string, p = google(role), tier = "L1") {
  const cwd = mkdtempSync(join(dir, "work-"));
  const task = createTask({ project: "isolation", title: "Synthetic handler test", role, workspacePath: cwd, tier });
  const opened: Parameters<AgentLauncher["create"]>[0][] = [];
  const sent: string[] = [];
  const launcher: AgentLauncher = { async create(options) { opened.push(options); return { id: `synthetic-${task.id}-${opened.length}` }; }, async send(id) { sent.push(id); } };
  return { task, opened, sent, launcher, options: { profiles: [p, reviewer], chosen: p, snapshot: snapshot() } };
}
describe("dispatch/complete handlers (simulated launcher, NOT real ACP)", () => {
  it("a scheduler-preselected Google L3 profile cannot bypass routing", async () => {
    const f = fixture("executor", google(), "L3");
    await startTask(f.task.id, f.launcher, "test", f.options);
    assert.equal(f.opened.length, 0); assert.notEqual(getTask(f.task.id).status, "running");
  });
  it("Google batch completion enters real review state; non-Google batch retains direct acceptance", async () => {
    for (const p of [google("batch"), { ...reviewer, id: "other-batch", name: "Other batch", role: "batch", family: "xai", provider: "grok" }]) {
      const f = fixture("batch", p);
      await startTask(f.task.id, f.launcher, "test", f.options);
      assert.equal(getTask(f.task.id).status, "running");
      await completeTask(f.task.id, "batch", "Synthetic complete", { files: [], verification: [], risks: [] });
      assert.equal(getTask(f.task.id).status, p.provider === "antigravity" ? "in_review" : "acceptance");
    }
  });
  it("Google batch quiet completion also enters review", async () => {
    const f = fixture("batch"); await startTask(f.task.id, f.launcher, "test", f.options);
    assert.equal(settleQuietHandoff(f.task.id, { lastText: "Synthetic delivery", source: "test" }), "auto_completed");
    assert.equal(getTask(f.task.id).status, "in_review");
  });
  it("stores the factual family and refuses a preselected Google reviewer at actual start", async () => {
    const p = google("batch", { family: "openai" });
    // A spoofed family must not select the OpenAI rules or its review matrix.
    saveConfig({ autoStart: {}, supervisorAgentId: null, supervisors: {}, concurrency: { global: 100, roles: {}, pools: {} }, projects: { isolation: { alwaysTemp: false, defaultWorkspace: "dir", baseBranch: "main", worktreeLanes: 1, lanesEnabled: false } }, bannedProviders: banned, families: {} });
    const f = fixture("batch", p); await startTask(f.task.id, f.launcher, "test", f.options);
    assert.equal(getTask(f.task.id).executor_family, "google");
    await completeTask(f.task.id, "batch", "Synthetic complete", {});
    const bad = google("reviewer", { id: "bad", role: "reviewer", family: "openai" });
    await startTask(f.task.id, f.launcher, "test", { ...f.options, profiles: [p, bad, reviewer], chosen: bad });
    assert.equal(f.opened.length, 1); assert.equal(getTask(f.task.id).status, "in_review");
    await startTask(f.task.id, f.launcher, "test", { ...f.options, chosen: reviewer });
    assert.equal(getTask(f.task.id).status, "reviewing"); assert.equal(f.opened[1]?.config.provider, "grok/grok-4.7");
    await approveTask(f.task.id, "Synthetic non-Google review");
    assert.equal(getTask(f.task.id).status, "acceptance");
  });
  it("rework resume rechecks pauses and bans before sending to the original Google agent", async () => {
    const f = fixture("executor"); await startTask(f.task.id, f.launcher, "test", f.options);
    getDb().prepare("UPDATE tasks SET status = 'rework' WHERE id = ?").run(f.task.id);
    await startTask(f.task.id, f.launcher, "test", { ...f.options, profiles: [google("executor", { role: "personal", candidateFor: undefined, pausedCandidateFor: "executor" }), reviewer] });
    assert.equal(f.sent.length, 0); assert.equal(getTask(f.task.id).status, "rework");
  });
  it("forces reader default mode and host auto_accept=false without changing the stored profile", async () => {
    const p = google("reader", { featureValues: { auto_accept: true } }); const f = fixture("reader", p);
    await startTask(f.task.id, f.launcher, "test", f.options);
    assert.equal(f.opened[0]?.config.modeId, "default"); assert.equal(f.opened[0]?.config.featureValues?.auto_accept, false);
    assert.equal(p.featureValues?.auto_accept, true);
  });
  it("never resumes a historical Google agent without a checked ACP/default-mode start", async () => {
    const f = fixture("reader"); await startTask(f.task.id, f.launcher, "test", f.options);
    getDb().prepare("UPDATE events SET data_json = json_remove(data_json, '$.googleDispatchPolicy') WHERE task_id = ? AND kind = 'started'").run(f.task.id);
    getDb().prepare("UPDATE tasks SET status = 'rework' WHERE id = ?").run(f.task.id);
    await startTask(f.task.id, f.launcher, "test", f.options);
    assert.equal(f.sent.length, 0); assert.equal(getTask(f.task.id).status, "rework");
  });
});
