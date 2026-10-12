import { setLanguage } from "../shared/i18n";
import assert from "node:assert/strict";
import type { PaseoApi } from "@getpaseo/client";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, it } from "node:test";
import { runKanban } from "./helpers/compat-cli";
import { DEFAULT_CONCURRENCY, saveConfig, type KanbanConfig } from "../server/config";
import { cardMark } from "../server/card-ref";
import { startTask } from "./helpers/compat-dispatch";
import { executionFamily } from "../server/execution-family";
import { resolveReviewTarget } from "../server/review-target";
import { closeDb, getDb } from "../server/db";
import { setWakeSender } from "../server/bus";
import { launcherFrom } from "../server/paseo";
import type { Profile } from "../server/profiles";
import type { DispatchMatrix } from "../server/matrix";
import { resetReconcileForTests } from "../server/schedule";
import { runTick } from "./helpers/compat-schedule";
import { createTask, getTask, type TaskRow } from "../server/store";
import { setAgentAliveCheck, resetAgentAliveCheck } from "../server/wake";

import { loadAcceptanceReviewWaits } from "../server/acceptance-review-wait";
import { scanAcceptance, resetAcceptanceBackoffForTests } from "../server/acceptance-watch";
import { scanPrerequisiteAttention } from "../server/dependency-attention";
import { boardSnapshot } from "../server/board-cards";
import { appendEvent } from "../server/store";

setLanguage("en");
process.env.KANBAN_LANGUAGE = "en";

const root = mkdtempSync(join(tmpdir(), "review-target-"));
process.env.KANBAN_DATA_DIR = join(root, "data");
process.env.KANBAN_POOL_STATUS = join(root, "pools.json");
process.env.KANBAN_DISPATCH_MATRIX = join(root, "matrix.json");
process.env.KANBAN_PASEO_CONFIG = join(root, "paseo.json");
process.env.KANBAN_TMP_ROOT = join(root, "card-tmp");
const work = join(root, "work");
mkdirSync(work);
const batch: Profile = { id: "batch-gpt", name: "Batch GPT", role: "batch", family: "openai", provider: "codex", model: "gpt-6.1-sol", pool: "gpt" };
const gpt: Profile = { ...batch, id: "review-gpt", name: "Review GPT", role: "reviewer" };
const fable: Profile = { id: "review-fable", name: "Review Fable", role: "candidate", candidateFor: "reviewer", family: "anthropic", provider: "claude", model: "claude-fable-5-1", pool: "fable" };
const profiles = [batch, gpt, fable];
const items = [{ profile: fable.name, effort: "xhigh" as const, paused: false }, { profile: gpt.name, effort: "xhigh" as const, paused: false }];
const matrix: DispatchMatrix = {
  version: 1, generatedAt: new Date().toISOString(), defaultTier: "L2", downgradeWhenTight: ["L1", "L2"],
  executor: { L1: [], L2: [], L3: [], L4: [] },
  reviewerFamilies: {
    xai: { L1: items, L2: items, L3: items, L4: items },
    openai: { L1: items, L2: items, L3: items, L4: items },
    anthropic: { L1: [{ profile: gpt.name, effort: "high", paused: false }], L2: items, L3: items, L4: items },
  },
  star: { reader: [], decision: [], batch: [{ profile: batch.name, effort: null, paused: false }] },
};
const config: KanbanConfig = {
  autoStart: { anonymous: true }, supervisorAgentId: null, supervisors: {},
  projects: { anonymous: { code: "ANON", defaultWorkspace: "dir", baseBranch: "main", alwaysTemp: false, worktreeLanes: 1, lanesEnabled: false } },
  // Anonymous opt-in policy; public defaults remain unrestricted.
  families: { openai: { providers: ["codex"], modelPrefixes: ["gpt-6.1-"], noFast: true, noUltra: true, requirePoolSeen: true } },
  concurrency: { global: 20, roles: { ...DEFAULT_CONCURRENCY.roles, reviewer: 10 }, pools: { gpt: 10, fable: 1 } },
};
let serial = 0;
function run(task: TaskRow, profile: Profile, role = task.role, agent = `anonymous-worker-${++serial}`): number {
  const row = getDb().prepare(`INSERT INTO runs (task_id, agent_id, role, profile_name, provider, model, family, started_at, ended_at, end_kind)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'complete')`).run(task.id, agent, role, profile.name, profile.provider, profile.model ?? null, profile.family ?? null, "2026-10-01T00:00:00Z", "2026-10-01T00:01:00Z");
  return Number(row.lastInsertRowid);
}
function target(role = "batch", profile = batch): TaskRow {
  const task = createTask({ project: "anonymous", title: "Anonymous delivery", role, workspacePath: work });
  run(task, profile);
  getDb().prepare("UPDATE tasks SET status = 'acceptance', executor_family = ?, executor_profile = ? WHERE id = ?").run(profile.family ?? null, profile.name, task.id);
  return getTask(task.id);
}
async function review(task: TaskRow, profile?: string): Promise<TaskRow> {
  // Real create command/handler using --reviews, with synthetic terminal identity only.
  return await runKanban(["create", "--project", "anonymous", "--title", "Anonymous review", "--role", "reviewer", "--workspace", work,
    "--reviews", String(task.id), "--tier", "L4", "--tag", "high-risk", ...(profile ? ["--profile", profile] : [])], {}) as TaskRow;
}
function handler(available = profiles) {
  const calls: Array<{ provider: string; family: string | null }> = [];
  const sends: string[] = [];
  const create = async (input: { config: { provider: string } }) => {
    const selected = available.find(p => `${p.provider}/${p.model}` === input.config.provider);
    calls.push({ provider: input.config.provider, family: selected ? executionFamily(selected) : null });
    return { id: `anonymous-review-${++serial}`, workspaceId: "anonymous-workspace" };
  };
  // Production launcherFrom adapter, synthetic Paseo endpoints: no real provider or model is started.
  const api = {
    agents: { create, ref: (id: string) => ({ send: async () => { sends.push(id); } }) },
    providers: { listModels: async (provider: string) => ({ models: available.filter(p => p.provider === provider).map(p => ({ id: p.model, thinkingOptions: [{ id: "high" }, { id: "xhigh" }] })) }) },
    workspaces: {
      list: async () => ({ entries: [], pageInfo: { nextCursor: null } }),
      ref: () => ({ agents: { create } }),
      create: async () => ({ id: "anonymous-workspace", directory: work, current: () => ({ workspaceDirectory: work, name: "anonymous" }) }),
    },
  } as unknown as PaseoApi;
  return { calls, sends, launcher: launcherFrom(api) };
}
function occupyFable() {
  const busy = createTask({ project: "occupied", title: "Anonymous occupied reviewer", role: "reviewer", workspacePath: work });
  run(busy, fable);
  getDb().prepare("UPDATE tasks SET status = 'reviewing' WHERE id = ?").run(busy.id);
  return busy.id;
}
function writeMatrix(value: DispatchMatrix) {
  writeFileSync(process.env.KANBAN_DISPATCH_MATRIX!, JSON.stringify({ ...value, roles: {
    executor: value.executor, reviewer: { byExecutorFamily: value.reviewerFamilies }, batch: { "*": value.star.batch },
  } }));
}
beforeEach(() => {
  resetReconcileForTests();
  resetAcceptanceBackoffForTests();
  getDb().prepare("UPDATE tasks SET status = 'archived' WHERE status != 'archived'").run();
  saveConfig(config);
  writeFileSync(process.env.KANBAN_POOL_STATUS!, JSON.stringify({ generatedAt: new Date().toISOString(), pools: { gpt: { dispatchable: true, usedPct: 10 }, fable: { dispatchable: true } } }));
  writeMatrix(matrix);
  writeFileSync(process.env.KANBAN_PASEO_CONFIG!, JSON.stringify({ daemon: { agentProfiles: profiles } }));
  setWakeSender(() => {});
  setAgentAliveCheck(() => true);
});
after(() => { resetAgentAliveCheck(); closeDb(); rmSync(root, { recursive: true, force: true }); });

for (const capacity of ["pool", "role", "global", "cli-pool", "pinned-pool"] as const) {
  it(`records normal ${capacity} capacity waiting for a linked review without acceptance or prerequisite alarms, then starts`, async () => {
    const delivery = target();
    const card = await review(delivery, capacity === "pinned-pool" ? fable.name : undefined);
    const busy = occupyFable();
    const cfg = { ...config, supervisors: { anonymous: "anonymous-leader" }, concurrency: {
      global: capacity === "global" ? 1 : 20,
      roles: { ...config.concurrency.roles, reviewer: capacity === "role" ? 1 : 10 },
      pools: { gpt: 10, fable: capacity.endsWith("pool") ? 1 : 10 },
    } };
    saveConfig(cfg);
    createTask({ project: "anonymous", title: "waiting descendant", role: "batch", parentIds: [delivery.id], actor: "scheduler" });
    const h = handler();
    if (capacity === "cli-pool") await runKanban(["start", String(card.id)], {}, { launcher: h.launcher });
    else await runTick({ profiles, launcher: h.launcher, config: cfg, agentState: () => "alive" });
    assert.equal(h.calls.length, 0);
    assert.equal(getTask(card.id).status, "ready");
    const wakes: string[] = [];
    setWakeSender((_id, text) => { wakes.push(text); });
    const now = Date.now();
    for (const minutes of [32, 121, 181]) {
      const date = new Date(now + minutes * 60_000);
      await scanAcceptance({ config: cfg, now: date });
      await scanPrerequisiteAttention({ config: cfg, now: date, agentState: () => "archived", send: async (_id, text) => { wakes.push(text); } });
    }
    assert.equal(wakes.length, 0, "normal capacity queues are handled, not absent executors");
    assert.equal(JSON.parse(getTask(delivery.id).tags ?? "[]").includes("leader-unresponsive"), false);
    assert.equal(loadAcceptanceReviewWaits().get(delivery.id)?.reviews[0].reason, "concurrency");
    const projected = boardSnapshot("anonymous").tasks.find(t => t.id === delivery.id)!;
    assert.match(projected.nextStep ?? "", /concurrency/);
    const held = () => getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'held'").all(card.id) as { data_json: string }[];
    assert.equal(held().length, 1);
    assert.equal(JSON.parse(held()[0].data_json).kind, "concurrency");
    await runTick({ profiles, launcher: h.launcher, config: cfg, agentState: () => "alive" });
    assert.equal(held().length, 1, "unchanged queue must not log on every tick");
    getDb().prepare("UPDATE tasks SET status = 'blocked', blocked_kind = 'needs_human' WHERE id = ?").run(card.id);
    appendEvent(card.id, "blocked", "ready", "blocked", "reviewer", { kind: "needs_human" });
    assert.equal(loadAcceptanceReviewWaits().has(delivery.id), false, "capacity must not hide a real review block");
    getDb().prepare("UPDATE tasks SET status = 'ready', blocked_kind = NULL WHERE id = ?").run(card.id);
    appendEvent(card.id, "reopened", "blocked", "ready", "supervisor", {});
    await runTick({ profiles, launcher: h.launcher, config: cfg, agentState: () => "alive" });
    assert.equal(held().length, 2, "reopen needs fresh structured evidence even when the reason is unchanged");
    assert.equal(loadAcceptanceReviewWaits().get(delivery.id)?.reviews[0].reason, "concurrency");
    getDb().prepare("UPDATE tasks SET status = 'acceptance' WHERE id = ?").run(busy);
    await runTick({ profiles, launcher: h.launcher, config: cfg, agentState: () => "alive" });
    assert.deepEqual(h.calls.map(x => x.family), ["anthropic"]);
    assert.equal(getTask(card.id).status, "reviewing");
    assert.equal(loadAcceptanceReviewWaits().get(delivery.id)?.reviews[0].reason, "running");
  });
}

it("omits both real reviewing and capacity-ready targets from a mixed batch while chasing an unhandled target", async () => {
  const cfg = { ...config, supervisors: { anonymous: "anonymous-leader" } };
  saveConfig(cfg);
  const runningTarget = target();
  const runningReview = await review(runningTarget);
  const h = handler();
  await runTick({ profiles, launcher: h.launcher, config: cfg, agentState: () => "alive" });
  assert.equal(getTask(runningReview.id).status, "reviewing");
  const readyTarget = target();
  const readyReview = await review(readyTarget);
  await runTick({ profiles, launcher: h.launcher, config: cfg, agentState: () => "alive" });
  assert.equal(getTask(readyReview.id).status, "ready");
  assert.equal(h.calls.length, 1);
  const unhandled = target();
  const wakes: string[] = [];
  setWakeSender((_id, text) => { wakes.push(text); });
  await scanAcceptance({ config: cfg, now: new Date(Date.now() + 121 * 60_000) });
  assert.equal(wakes.length, 1);
  assert.ok(wakes[0].includes(cardMark(unhandled.id)));
  for (const card of [runningTarget, readyTarget]) {
    assert.ok(!wakes[0].includes(cardMark(card.id)));
    assert.equal(JSON.parse(getTask(card.id).tags ?? "[]").includes("leader-unresponsive"), false);
  }
  const event = getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'wake_acceptance_repeat'").get(unhandled.id) as { data_json: string };
  assert.deepEqual(JSON.parse(event.data_json).cards, [cardMark(unhandled.id)]);
});

it("refreshes identical quota evidence after a blocked reviewer reopens", async () => {
  const delivery = target();
  const card = await review(delivery);
  writeFileSync(process.env.KANBAN_POOL_STATUS!, JSON.stringify({ generatedAt: new Date().toISOString(), pools: {
    gpt: { dispatchable: true, usedPct: 10 }, fable: { dispatchable: false, reason: "synthetic normal window" },
  } }));
  const h = handler();
  await runTick({ profiles, launcher: h.launcher, config, agentState: () => "alive" });
  const before = getTask(card.id).hold_reason;
  getDb().prepare("UPDATE tasks SET status = 'blocked' WHERE id = ?").run(card.id);
  appendEvent(card.id, "blocked", "ready", "blocked", "scheduler", {});
  getDb().prepare("UPDATE tasks SET status = 'ready' WHERE id = ?").run(card.id);
  appendEvent(card.id, "reopened", "blocked", "ready", "supervisor", {});
  assert.equal(loadAcceptanceReviewWaits().has(delivery.id), false, "old held is not current evidence");
  await runTick({ profiles, launcher: h.launcher, config, agentState: () => "alive" });
  assert.equal(getTask(card.id).hold_reason, before);
  assert.equal(loadAcceptanceReviewWaits().has(delivery.id), true);
  const heldCount = () => (getDb().prepare("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND kind = 'held'").get(card.id) as { n: number }).n;
  assert.equal(heldCount(), 2);
  await runTick({ profiles, launcher: h.launcher, config, agentState: () => "alive" });
  assert.equal(heldCount(), 2);
  assert.equal(h.calls.length, 0);
  writeFileSync(process.env.KANBAN_POOL_STATUS!, JSON.stringify({ generatedAt: new Date().toISOString(), pools: {
    gpt: { dispatchable: true, usedPct: 10 }, fable: { dispatchable: true },
  } }));
  await runTick({ profiles, launcher: h.launcher, config, agentState: () => "alive" });
  assert.deepEqual(h.calls.map(x => x.family), ["anthropic"]);
  assert.equal(getTask(card.id).status, "reviewing");
  assert.equal(loadAcceptanceReviewWaits().get(delivery.id)?.reviews[0].reason, "running");
});

it("queues a batch openai --reviews L4 card when Fable is full, then starts only the different family through launcherFrom", async () => {
  const delivery = target();
  const card = await review(delivery);
  assert.equal(card.executor_family, null);
  const busy = occupyFable();
  const h = handler();
  await runTick({ profiles, launcher: h.launcher, config, agentState: () => "alive" });
  console.log("ANONYMOUS HANDLER (simulated endpoints, no provider):", JSON.stringify(h.calls));
  assert.equal(h.calls.length, 0, "a full different-family pool must never fall back to openai");
  assert.equal(getTask(card.id).status, "ready");
  assert.match(getTask(card.id).hold_reason ?? "", /fable/);
  getDb().prepare("UPDATE tasks SET status = 'acceptance' WHERE id = ?").run(busy);
  await runTick({ profiles, launcher: h.launcher, config, agentState: () => "alive" });
  assert.deepEqual(h.calls.map(x => x.family), ["anthropic"]);
  assert.equal(getTask(card.id).status, "reviewing");
  const event = getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'started' ORDER BY id DESC LIMIT 1").get(card.id) as { data_json: string };
  const evidence = JSON.parse(event.data_json).reviewTarget;
  assert.equal(evidence.taskId, delivery.id);
  assert.equal(evidence.source, "run");
  assert.equal(evidence.family, "openai");
  assert.equal(evidence.role, "batch");
  assert.equal(evidence.provider, "codex");
  assert.equal(evidence.model, "gpt-6.1-sol");
  console.log("ANONYMOUS HANDLER RELEASED (simulated endpoints):", JSON.stringify(h.calls), "target run", evidence.runId);
});

for (const role of ["executor", "batch", "reader", "decision", "reviewer", "ops_github"]) {
  it(`uses actual ${role} work evidence for automatic linked review`, async () => {
    const delivery = target(role);
    const card = await review(delivery);
    const h = handler();
    await runTick({ profiles, launcher: h.launcher, config, agentState: () => "alive" });
    assert.deepEqual(h.calls.map(x => x.family), ["anthropic"]);
    assert.equal(getTask(card.id).status, "reviewing");
  });
}

it("refuses explicit same actual model in the real CLI start handler", async () => {
  const delivery = target();
  const card = await review(delivery, gpt.name);
  const h = handler();
  await runKanban(["start", String(card.id)], {}, { launcher: h.launcher });
  assert.equal(h.calls.length, 0);
  assert.equal(getTask(card.id).status, "blocked");
  assert.match(getTask(card.id).blocked_reason ?? "", new RegExp(`${cardMark(delivery.id)}.*openai`));
});

it("starts a same-family reviewer with a distinct actual model through the real CLI handler", async () => {
  const distinct: Profile = { ...gpt, id: "distinct-reviewer", name: "Distinct reviewer", model: "gpt-6.1-second" };
  const available = [batch, distinct];
  const rows = [{ profile: distinct.name, effort: "xhigh" as const, paused: false }];
  writeFileSync(process.env.KANBAN_PASEO_CONFIG!, JSON.stringify({ daemon: { agentProfiles: available } }));
  writeMatrix({ ...matrix, reviewerFamilies: { openai: { L1: rows, L2: rows, L3: rows, L4: rows } } });
  const delivery = target();
  const card = await review(delivery, distinct.name);
  const h = handler(available);
  await runKanban(["start", String(card.id)], {}, { launcher: h.launcher });
  assert.deepEqual(h.calls, [{ provider: "codex/gpt-6.1-second", family: "openai" }]);
  assert.equal(getTask(card.id).status, "reviewing");
});

it("family metadata differences do not invalidate nonempty actual delivery model evidence", () => {
  const delivery = target();
  getDb().prepare("UPDATE tasks SET executor_family = 'unrelated' WHERE id = ?").run(delivery.id);
  const resolved = resolveReviewTarget(getTask(delivery.id), true);
  assert.equal(resolved?.ok, true);
  if (resolved?.ok) assert.equal(resolved.model, batch.model);
});

it("starts explicit different-family high-risk profile with matrix depth, and respects its pool", async () => {
  const delivery = target();
  const card = await review(delivery, fable.id);
  const h = handler();
  const busy = occupyFable();
  await runKanban(["start", String(card.id)], {}, { launcher: h.launcher });
  assert.equal(h.calls.length, 0);
  assert.equal(getTask(card.id).status, "ready");
  getDb().prepare("UPDATE tasks SET status = 'acceptance' WHERE id = ?").run(busy);
  await runKanban(["start", String(card.id)], {}, { launcher: h.launcher });
  assert.deepEqual(h.calls.map(x => x.family), ["anthropic"]);
  const current = getDb().prepare("SELECT effort FROM runs WHERE task_id = ? ORDER BY id DESC LIMIT 1").get(card.id) as { effort: string };
  assert.equal(current.effort, "xhigh");
});

it("rejects a same-family scheduler preselection and forged cached target context", async () => {
  const delivery = target();
  const card = await review(delivery);
  const h = handler();
  await startTask(card.id, h.launcher, "scheduler", { profiles, chosen: gpt, routing: {
    profiles, role: "reviewer", review: true, executorFamily: "anthropic", reviewsExecutor: false,
    reviewTarget: null, byPool: {}, poolLimits: {}, snapshot: {
      state: "fresh", message: "synthetic", generatedAt: null, dispatchable: () => true,
      hasPool: () => true, entry: () => ({ dispatchable: true, deprioritize: false, prefer: false, resetsAt: null, reason: null, onlyRoles: null }),
    },
  } });
  assert.equal(h.calls.length, 0);
  assert.match(getTask(card.id).blocked_reason ?? "", /openai/);
});

it("queues when every automatic candidate is the same family, including the legacy roster", async () => {
  const delivery = target();
  const card = await review(delivery);
  const h = handler();
  await runTick({ profiles: [batch, gpt], launcher: h.launcher, config, agentState: () => "alive", matrix: { state: "missing" } });
  assert.equal(h.calls.length, 0);
  assert.equal(getTask(card.id).status, "ready");
  assert.match(getTask(card.id).hold_reason ?? "", /openai/);
});

it("queues when only same-family profiles remain in the actual L4 matrix", async () => {
  const delivery = target();
  const card = await review(delivery);
  const onlyGpt = [{ profile: gpt.name, effort: "xhigh" as const, paused: false }];
  writeMatrix({ ...matrix, reviewerFamilies: { ...matrix.reviewerFamilies, openai: { L1: onlyGpt, L2: onlyGpt, L3: onlyGpt, L4: onlyGpt } } });
  const h = handler();
  const tick = await runTick({ profiles, launcher: h.launcher, config, agentState: () => "alive" });
  assert.deepEqual(tick.errors, []);
  assert.equal(h.calls.length, 0);
  assert.equal(getTask(card.id).status, "ready");
  assert.match(getTask(card.id).hold_reason ?? "", /openai/);
});

for (const inline of [false, true]) {
  for (const failure of ["login", "gemini-ban"] as const) {
    it(`keeps ${failure} needs_human for ${inline ? "normal inline" : "linked batch"} automatic review with actual target evidence`, async () => {
      const delivery = target(inline ? "executor" : "batch");
      const card = inline ? delivery : await review(delivery);
      if (inline) getDb().prepare("UPDATE tasks SET status = 'in_review', tier = 'L4', tags = ? WHERE id = ?").run(JSON.stringify(["high-risk"]), card.id);
      const candidate = failure === "login" ? fable : { ...fable, provider: "antigravity", model: "gemini-3.8-flash-medium", family: "xai" };
      if (failure === "gemini-ban") saveConfig({ ...config, bannedProviders: { providers: ["antigravity"], families: [], pools: [], models: [] } });
      if (failure === "login") writeFileSync(process.env.KANBAN_POOL_STATUS!, JSON.stringify({ generatedAt: new Date().toISOString(), pools: {
        gpt: { dispatchable: true, usedPct: 10 }, fable: { dispatchable: false, reason: "not logged in" },
      } }));
      const available = [batch, gpt, candidate];
      const h = handler(available);
      const tick = await runTick({ profiles: available, launcher: h.launcher, config, agentState: () => "alive" });
      assert.deepEqual(tick.errors, []);
      assert.equal(h.calls.length, 0);
      const stopped = getTask(card.id);
      assert.equal(stopped.status, "blocked");
      assert.equal(stopped.blocked_kind, "needs_human");
      assert.match(stopped.blocked_reason ?? "", failure === "login" ? /not logged in/ : /configured dispatch policy/i);
      assert.match(stopped.blocked_reason ?? "", new RegExp(`${cardMark(delivery.id)}.*openai`));
      const blocked = getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'blocked' ORDER BY id DESC LIMIT 1").get(card.id) as { data_json: string };
      assert.equal(JSON.parse(blocked.data_json).kind, "needs_human");
      console.log("ANONYMOUS PERMANENT FAILURE (simulated endpoints, no provider):", JSON.stringify({ inline, failure, creates: h.calls, status: stopped.status, kind: stopped.blocked_kind }));
    });
  }
}

for (const failure of ["missing-profile", "cursor", "gpt-series", "gpt-fast", "gpt-ultra"] as const) {
  it(`does not turn ${failure} into quota when a same-family target candidate is available`, async () => {
    const delivery = target();
    const card = await review(delivery);
    const candidate = failure === "cursor" ? { ...fable, provider: "cursor", model: "grok-4.7", family: "xai" }
      : failure.startsWith("gpt-") ? { ...fable, provider: "codex", model: failure === "gpt-series" ? "gpt-5.6-sol" : "gpt-6.1-sol", family: "openai", pool: "gpt", ...(failure === "gpt-fast" ? { featureValues: { fast_mode: true } } : {}), ...(failure === "gpt-ultra" ? { thinkingOptionId: "ultra" } : {}) }
      : fable;
    if (failure === "gpt-ultra") {
      const restricted = [{ profile: fable.name, effort: null, paused: false }, items[1]];
      writeMatrix({ ...matrix, reviewerFamilies: { ...matrix.reviewerFamilies, openai: { L1: restricted, L2: restricted, L3: restricted, L4: restricted } } });
    }
    const available = failure === "missing-profile" ? [batch, gpt] : [batch, gpt, candidate];
    const h = handler(available);
    const tick = await runTick({ profiles: available, launcher: h.launcher, config, agentState: () => "alive" });
    assert.deepEqual(tick.errors, []);
    assert.equal(h.calls.length, 0);
    assert.equal(getTask(card.id).status, "blocked");
    assert.equal(getTask(card.id).blocked_kind, "needs_human");
    assert.match(getTask(card.id).blocked_reason ?? "", /Review Fable/);
  });
}

for (const inline of [false, true]) {
  it(`does not dispatch an unlisted legacy reviewer when the actual Google target has no matrix family bucket (${inline ? "inline" : "linked"})`, async () => {
    const delivery = target(inline ? "executor" : "batch", { ...batch, provider: "antigravity", model: "gemini-3.8-flash-medium", family: "openai" });
    const card = inline ? delivery : await review(delivery);
    if (inline) getDb().prepare("UPDATE tasks SET status = 'in_review', tier = 'L4', tags = ? WHERE id = ?").run(JSON.stringify(["high-risk"]), card.id);
    const unlisted: Profile = { ...fable, id: "review-unlisted", name: "Unlisted old roster", role: "reviewer", family: "xai", provider: "grok", model: "grok-4.7" };
    const banned: Profile = { ...unlisted, id: "review-disguised", name: "Disguised old roster", provider: "antigravity", model: "gemini-3.8-flash-medium" };
    const available = [batch, unlisted, banned];
    const h = handler(available);
    const tick = await runTick({ profiles: available, launcher: h.launcher, config, agentState: () => "alive" });
    assert.deepEqual(tick.errors, []);
    assert.equal(resolveReviewTarget(getTask(card.id), true)?.ok, true);
    assert.equal(h.calls.length, 0, "a missing actual-family bucket must not bypass the L4 matrix through old roster");
    assert.equal(getTask(card.id).status, inline ? "in_review" : "ready");
    assert.match(getTask(card.id).hold_reason ?? "", /google/);
    assert.doesNotMatch(getTask(card.id).hold_reason ?? "", /old rules/i);
    console.log("ANONYMOUS MISSING FAMILY MATRIX (simulated endpoints, no provider):", JSON.stringify({ inline, creates: h.calls, status: getTask(card.id).status, family: "google" }));
  });
}

it("keeps L2 downgrade inside the different-family constraint", async () => {
  const delivery = target();
  const card = await review(delivery);
  getDb().prepare("UPDATE tasks SET tier = 'L2', tags = NULL WHERE id = ?").run(card.id);
  occupyFable();
  const h = handler();
  await runTick({ profiles, launcher: h.launcher, config, agentState: () => "alive" });
  assert.equal(h.calls.length, 0);
  assert.equal(getTask(card.id).status, "ready");
});

it("uses the latest takeover work run, ignoring later automatic review runs and edited labels", async () => {
  const delivery = target("executor");
  const takeover = { ...fable, name: "Former executor name", role: "executor" };
  const workRun = run(delivery, takeover, "executor", "anonymous-takeover");
  run(delivery, gpt, "reviewer");
  getDb().prepare("UPDATE tasks SET executor_agent_id = 'anonymous-takeover', executor_family = 'xai', executor_profile = 'Renamed executor' WHERE id = ?").run(delivery.id);
  getDb().prepare("UPDATE runs SET family = 'openai' WHERE id = ?").run(workRun);
  const card = await review(getTask(delivery.id));
  const evidence = resolveReviewTarget(card, true);
  assert.equal(evidence?.ok, true);
  if (evidence?.ok) {
    assert.equal(evidence.runId, workRun);
    assert.equal(evidence.family, "anthropic");
    assert.equal(evidence.recordedFamily, "openai");
    assert.equal(evidence.agentId, "anonymous-takeover");
  }
  const h = handler();
  await runTick({ profiles, launcher: h.launcher, config, agentState: () => "alive" });
  assert.deepEqual(h.calls.map(x => x.family), ["openai"]);
});

it("ignores current execution profile family/name drift and the review card's own executor family", async () => {
  const delivery = target();
  const card = await review(delivery);
  getDb().prepare("UPDATE tasks SET executor_family = 'anthropic', executor_profile = 'Edited profile' WHERE id IN (?, ?)").run(delivery.id, card.id);
  writeFileSync(process.env.KANBAN_PASEO_CONFIG!, JSON.stringify({ daemon: { agentProfiles: [{ ...batch, family: "anthropic", name: "Renamed batch" }, gpt, fable] } }));
  const h = handler();
  await runTick({ profiles, launcher: h.launcher, config, agentState: () => "alive" });
  assert.deepEqual(h.calls.map(x => x.family), ["anthropic"]);
});

for (const facts of [
  { provider: "antigravity", model: "gemini-3.8-flash-medium", family: "openai" },
  { provider: "custom", model: "google/gemini-3.8-flash-medium", family: "anthropic" },
  { provider: "vertex-ai", model: "custom-model", family: "openai" },
  { provider: "agy-acp", model: "custom-model", family: "xai" },
]) {
  it(`recognizes Google execution facts despite false family: ${facts.provider}`, async () => {
    const delivery = target("batch", { ...batch, ...facts });
    const card = await review(delivery);
    const evidence = resolveReviewTarget(card, true);
    assert.equal(evidence?.ok && evidence.family, "google");
    assert.equal(executionFamily(facts), "google");
    saveConfig({ ...config, bannedProviders: { providers: [], families: [], pools: [], models: [] }, families: {} });
    const disguisedReviewer = { ...gpt, provider: "antigravity", model: "gemini-3.8-flash-medium", family: "xai" };
    const h = handler();
    await startTask(card.id, h.launcher, "scheduler", { profiles: [...profiles, disguisedReviewer], chosen: disguisedReviewer });
    assert.equal(h.calls.length, 0);
    // A real linked scheduling round uses the Google family bucket and still selects a legal reviewer.
    writeMatrix({ ...matrix, reviewerFamilies: { ...matrix.reviewerFamilies, google: matrix.reviewerFamilies.openai! } });
    await runTick({ profiles, launcher: h.launcher, config, agentState: () => "alive" });
    assert.deepEqual(h.calls.map(x => x.family), ["anthropic"]);
    const checked = getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'started' ORDER BY id DESC LIMIT 1").get(card.id) as { data_json: string };
    assert.equal(JSON.parse(checked.data_json).reviewTarget.family, "google");
  });
}

for (const missing of ["unexecuted", "model", "agent", "binding", "target"]) {
  it(`fails closed with explanatory target evidence: ${missing}`, async () => {
    const delivery = missing === "unexecuted"
      ? createTask({ project: "anonymous", title: "No execution", role: "batch", workspacePath: work }) : target();
    if (missing === "unexecuted") getDb().prepare("UPDATE tasks SET status = 'acceptance', executor_family = 'openai', executor_profile = ? WHERE id = ?").run(batch.name, delivery.id);
    const card = await review(delivery);
    if (missing === "model") getDb().prepare("UPDATE runs SET provider = NULL, model = NULL, family = NULL WHERE task_id = ?").run(delivery.id);
    if (missing === "agent") getDb().prepare("UPDATE runs SET agent_id = NULL WHERE task_id = ?").run(delivery.id);
    if (missing === "binding") getDb().prepare("UPDATE tasks SET executor_agent_id = 'unrecorded-takeover' WHERE id = ?").run(delivery.id);
    if (missing === "target") {
      getDb().exec("PRAGMA foreign_keys = OFF");
      getDb().prepare("UPDATE tasks SET review_of = 999999 WHERE id = ?").run(card.id);
      getDb().exec("PRAGMA foreign_keys = ON");
    }
    const h = handler();
    await runTick({ profiles, launcher: h.launcher, config, agentState: () => "alive" });
    assert.equal(h.calls.length, 0);
    assert.equal(getTask(card.id).status, "blocked");
    assert.match(getTask(card.id).blocked_reason ?? "", /Review target.*(not exist|run|evidence)|Actual executor or reviewer model is unresolved/);
  });
}

it("does not infer a target from an independent review title", async () => {
  const delivery = target();
  const card = createTask({ project: "anonymous", title: `Review ${cardMark(delivery.id)}`, role: "reviewer", workspacePath: work, tier: "L4" });
  occupyFable();
  const h = handler();
  await runTick({ profiles, launcher: h.launcher, config, agentState: () => "alive" });
  assert.deepEqual(h.calls.map(x => x.family), ["openai"]);
  assert.equal(resolveReviewTarget(card, true), null);
});

for (const same of [true, false]) {
  it(`checks the actual resumed reviewer run against current target execution: same family=${same}`, async () => {
    const delivery = target();
    const card = await review(delivery);
    const priorAgent = `anonymous-resume-${++serial}`;
    run(card, { ...fable, family: "openai" }, "reviewer", priorAgent);
    getDb().prepare("UPDATE tasks SET status = 'rework', executor_agent_id = ?, agent_id = ?, executor_profile = ?, executor_family = 'openai' WHERE id = ?").run(priorAgent, priorAgent, fable.name, card.id);
    if (same) run(delivery, fable, "batch");
    const h = handler();
    await runTick({ profiles, launcher: h.launcher, config, agentState: () => "alive" });
    assert.equal(h.calls.length, 0);
    assert.equal(h.sends.length, same ? 0 : 1);
    assert.equal(getTask(card.id).status, same ? "blocked" : "running");
  });
}

it("keeps the Google resume safety boundary on the actual linked reviewer run despite edited labels", async () => {
  const delivery = target();
  const card = await review(delivery);
  const priorAgent = `anonymous-google-resume-${++serial}`;
  // Historical Google reviewer is unsupported, even though its family is different from the target.
  // Current profile/columns were edited to look non-Google; the actual own-role run is authoritative.
  run(card, { ...gpt, provider: "antigravity", model: "gemini-3.8-flash-medium", family: "xai" }, "reviewer", priorAgent);
  getDb().prepare("UPDATE tasks SET status = 'rework', executor_agent_id = ?, agent_id = ?, executor_profile = ?, executor_family = 'xai' WHERE id = ?").run(priorAgent, priorAgent, gpt.name, card.id);
  const h = handler();
  await runTick({ profiles, launcher: h.launcher, config, agentState: () => "alive" });
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.sends, []);
  assert.equal(getTask(card.id).status, "rework");
  assert.ok(getTask(card.id).hold_reason);
});

it("routes a departed linked reviewer rework through the target family constraint", async () => {
  const delivery = target();
  const card = await review(delivery);
  getDb().prepare("UPDATE tasks SET status = 'rework' WHERE id = ?").run(card.id);
  const h = handler();
  await startTask(card.id, h.launcher, "scheduler", { profiles });
  assert.deepEqual(h.calls.map(x => x.family), ["anthropic"]);
  assert.equal(getTask(card.id).status, "running");
});

it("keeps normal inline executor review on actual executor work evidence", async () => {
  const delivery = target("executor");
  run(delivery, fable, "reviewer");
  getDb().prepare("UPDATE tasks SET status = 'in_review' WHERE id = ?").run(delivery.id);
  const h = handler();
  await runTick({ profiles, launcher: h.launcher, config, agentState: () => "alive" });
  assert.deepEqual(h.calls.map(x => x.family), ["anthropic"]);
});

it("rejects an openai reviewer relabelled as anthropic", async () => {
  const delivery = target();
  const card = await review(delivery);
  const h = handler();
  await startTask(card.id, h.launcher, "scheduler", { profiles, chosen: { ...gpt, family: "anthropic" } });
  assert.equal(h.calls.length, 0);
  assert.match(getTask(card.id).blocked_reason ?? "", /openai/);
});

it("does not bypass different-family explicit capability or onlyRoles checks", async () => {
  const delivery = target();
  const card = await review(delivery, fable.name);
  const h = handler();
  h.launcher.listModels = async () => ({ models: [{ id: fable.model!, thinkingOptions: [{ id: "low" }] }] });
  await runKanban(["start", String(card.id)], {}, { launcher: h.launcher });
  assert.equal(h.calls.length, 0);
  assert.equal(getTask(card.id).status, "ready");
  assert.match(getTask(card.id).hold_reason ?? "", /xhigh/);
  writeFileSync(process.env.KANBAN_POOL_STATUS!, JSON.stringify({ generatedAt: new Date().toISOString(), pools: { fable: { dispatchable: true, onlyRoles: ["executor"] } } }));
  await runKanban(["start", String(card.id)], {}, { launcher: handler().launcher });
  assert.equal(getTask(card.id).status, "ready");
  assert.match(getTask(card.id).hold_reason ?? "", /fable/);
});

it("revalidates target evidence after awaited placement before launcher create", async () => {
  const delivery = target();
  const card = await review(delivery);
  const h = handler();
  h.launcher.listWorkspaces = async () => {
    run(delivery, fable, "batch");
    return [];
  };
  await assert.rejects(startTask(card.id, h.launcher, "scheduler", { profiles, chosen: fable }), /different actual model/);
  assert.equal(h.calls.length, 0);
  assert.equal(getTask(card.id).status, "ready");
});


it("does not treat a whitespace-only legacy inline family as execution evidence", async () => {
  const card = createTask({ project: "anonymous", title: "Anonymous legacy", role: "executor", workspacePath: work });
  getDb().prepare("UPDATE tasks SET status = 'in_review', executor_family = '   ' WHERE id = ?").run(card.id);
  const h = handler();
  await startTask(card.id, h.launcher, "scheduler", { profiles, chosen: fable });
  assert.equal(h.calls.length, 0);
  assert.equal(getTask(card.id).status, "blocked");
});
