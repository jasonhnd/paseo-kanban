import assert from "node:assert/strict";
import type { PaseoApi } from "@getpaseo/client";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, it } from "node:test";
import { runKanban } from "./helpers/compat-cli";
import { saveConfig, type KanbanConfig } from "../server/config";
import { closeDb, getDb } from "../server/db";
import { applyFailure, type FailureClass } from "../server/failures";
import { applyLoginBlip } from "../server/login-blip";
import { launcherFrom } from "../server/paseo";
import type { Profile } from "../server/profiles";
import { resetReconcileForTests } from "../server/schedule";
import { runTick } from "./helpers/compat-schedule";
import { appendEvent, createTask, getTask, type TaskRow } from "../server/store";
import { resetAgentAliveCheck, setAgentAliveCheck } from "../server/wake";
import { setWakeSender } from "../server/bus";
import { scanAcceptance, resetAcceptanceBackoffForTests } from "../server/acceptance-watch";
import { scanPrerequisiteAttention } from "../server/dependency-attention";
import { loadAcceptanceReviewWaits } from "../server/acceptance-review-wait";
import { boardSnapshot } from "../server/board-cards";
import { acceptTask, approveTask, completeTask } from "../server/flow";
import { cardMark } from "../server/card-ref";
import { round, takePerfSummary } from "../server/perf";

import { setLanguage } from "../shared/i18n";

const root = mkdtempSync(join(tmpdir(), "acceptance-retry-"));
const work = join(root, "work"); mkdirSync(work);
process.env.KANBAN_DATA_DIR = join(root, "data");
process.env.KANBAN_TMP_ROOT = join(root, "card-tmp");
process.env.KANBAN_POOL_STATUS = join(root, "pools.json");
process.env.KANBAN_DISPATCH_MATRIX = join(root, "matrix.json");
process.env.KANBAN_PASEO_CONFIG = join(root, "paseo.json");
const worker: Profile = { id: "anon-work", name: "Anonymous work", role: "batch", family: "openai", provider: "codex", model: "gpt-6.1-sol", pool: "work" };
const reviewer: Profile = { id: "anon-review", name: "Anonymous review", role: "reviewer", family: "xai", provider: "grok", model: "grok-4.7", pool: "review" };
const profiles = [worker, reviewer];
const config: KanbanConfig = { autoStart: { anonymous: true }, supervisors: { anonymous: "anonymous-leader" }, supervisorAgentId: "anonymous-board-leader",
  projects: { anonymous: { code: "ANON", defaultWorkspace: "dir", baseBranch: "main", alwaysTemp: false, worktreeLanes: 1, lanesEnabled: false } },
  concurrency: { global: 20, roles: { batch: 10, reviewer: 10 }, pools: { work: 10, review: 10 } } };
let epoch = Date.now(); let serial = 0;
const date = (minutes: number) => new Date(epoch + minutes * 60_000);
const sent: string[] = [];
function pools(open: boolean) {
  writeFileSync(process.env.KANBAN_POOL_STATUS!, JSON.stringify({ generatedAt: new Date().toISOString(), pools: {
    work: { dispatchable: true, usedPct: 10 }, review: { dispatchable: open, reason: open ? null : "synthetic window" },
  } }));
}
beforeEach(() => {
  setLanguage("en");
  epoch = Date.now(); resetReconcileForTests(); resetAcceptanceBackoffForTests();
  getDb().prepare("UPDATE tasks SET status = 'archived'").run(); saveConfig(config); pools(true);
  const items = [{ profile: reviewer.name, effort: "high", paused: false }];
  writeFileSync(process.env.KANBAN_DISPATCH_MATRIX!, JSON.stringify({ version: 1, defaultTier: "L2", downgradeWhenTight: ["L1", "L2"], generatedAt: new Date().toISOString(), roles: {
    executor: { L1: [], L2: [], L3: [], L4: [] }, reviewer: { byExecutorFamily: { openai: { L1: items, L2: items, L3: items, L4: items } } },
    batch: { "*": [{ profile: worker.name, effort: null, paused: false }] },
  } }));
  writeFileSync(process.env.KANBAN_PASEO_CONFIG!, JSON.stringify({ daemon: { agentProfiles: profiles } }));
  sent.length = 0; setWakeSender((_id, text) => { sent.push(text); }); setAgentAliveCheck(() => true);
});
after(() => { setWakeSender(() => {}); resetAgentAliveCheck(); closeDb(); rmSync(root, { recursive: true, force: true }); });
function handler() {
  const families: string[] = [];
  const create = async (input: { config: { provider: string } }) => {
    const picked = profiles.find(p => `${p.provider}/${p.model}` === input.config.provider)!;
    families.push(picked.family!); return { id: `anonymous-${++serial}`, workspaceId: "anonymous-workspace" };
  };
  const api = { agents: { create, ref: () => ({ send: async () => {} }) }, providers: { listModels: async (provider: string) => ({ models:
    profiles.filter(p => p.provider === provider).map(p => ({ id: p.model, thinkingOptions: [{ id: "high" }] })) }) },
    workspaces: { list: async () => ({ entries: [], pageInfo: { nextCursor: null } }), ref: () => ({ agents: { create } }),
      create: async () => ({ id: "anonymous-workspace", directory: work, current: () => ({ workspaceDirectory: work, name: "anonymous" }) }) },
  } as unknown as PaseoApi;
  return { families, launcher: launcherFrom(api) };
}
function delivery() {
  const task = createTask({ project: "anonymous", title: "Anonymous delivery", role: "batch", workspacePath: work, actor: "scheduler" });
  getDb().prepare("INSERT INTO runs(task_id, agent_id, role, provider, model, family, started_at, ended_at, end_kind) VALUES (?, 'anonymous-work', 'batch', 'codex', 'gpt-6.1-sol', 'openai', ?, ?, 'complete')")
    .run(task.id, date(-2).toISOString(), date(-1).toISOString());
  getDb().prepare("UPDATE tasks SET status = 'acceptance' WHERE id = ?").run(task.id);
  appendEvent(task.id, "complete", "running", "acceptance", "batch", {}, date(0).toISOString());
  createTask({ project: "anonymous", title: "Anonymous descendant", role: "batch", parentIds: [task.id], actor: "scheduler" });
  return getTask(task.id);
}
async function review(target: TaskRow, parents: number[] = []) {
  return await runKanban(["create", "--project", "anonymous", "--title", "Anonymous independent review", "--role", "reviewer", "--workspace", work,
    "--reviews", String(target.id), "--tier", "L4", "--tag", "high-risk", ...(parents.length ? ["--parents", parents.join(",")] : [])], {}) as TaskRow;
}
const tick = (h: ReturnType<typeof handler>, minutes = 0) => runTick({ profiles, launcher: h.launcher, config, now: date(minutes), agentState: () => "alive" });
async function checkQuiet(target: TaskRow, minutes = [32, 121, 242]) {
  sent.length = 0; // Preserve command notifications; measure only the two watchers below.
  for (const minute of minutes) {
    await scanAcceptance({ config, now: date(minute) });
    await scanPrerequisiteAttention({ config, now: date(minute), agentState: () => "archived", send: async (_id, text) => { sent.push(text); } });
  }
  const events = getDb().prepare("SELECT kind FROM events WHERE task_id = ? AND kind IN ('wake_acceptance_repeat','wake_prerequisite','leader_unresponsive')").all(target.id);
  console.log("ANONYMOUS RETRY", JSON.stringify({ wakes: sent.length, events, tags: getTask(target.id).tags }));
  assert.equal(sent.length, 0); assert.equal(events.length, 0);
  assert.equal(JSON.parse(getTask(target.id).tags ?? "[]").includes("leader-unresponsive"), false);
  assert.equal(boardSnapshot("anonymous").tasks.find(t => t.id === target.id)!.badge, "Ruling recorded, awaiting review");
}

function productionRetry(card: TaskRow, kind: 'other' | 'login_blip', attempt = 1) {
  const current = getTask(card.id);
  assert.ok(current.agent_id);
  const result = kind === 'other' ? applyFailure(card.id, 'anonymous counted retry', 'other', new Date()) :
    applyLoginBlip(card.id, current.agent_id, attempt, new Date());
  assert.equal(result, 'requeue');
  assert.equal(getTask(card.id).status, current.status === 'reviewing' ? 'in_review' : 'ready');
  return getTask(card.id);
}

for (const kind of ['other', 'login_blip'] as const) {
  for (const phase of ['reviewing', 'running'] as const) {
    it(`production ${kind} ${phase} requeue stays quiet without a later tick or hold`, async () => {
      const target = delivery(); const card = await review(target); const h = handler();
      if (phase === 'running') {
        getDb().prepare("UPDATE tasks SET status = 'rework' WHERE id = ?").run(card.id);
        appendEvent(card.id, 'leader_rework', 'ready', 'rework', 'supervisor', {});
      }
      await tick(h); assert.equal(getTask(card.id).status, phase);
      const queued = productionRetry(card, kind);
      await checkQuiet(target, [1, 32, 121, 242]);
      assert.equal(h.families.length, 1, 'watchers cannot mask the requeue with a new run');
      assert.equal(getTask(card.id).fail_count, kind === 'other' ? 1 : 0);
      assert.equal(getTask(card.id).cooldown_until, queued.cooldown_until);
    });
  }
  it(`production ${kind} ancestor requeue stays quiet without a later tick or hold`, async () => {
    const target = delivery();
    const parent = createTask({ project: 'anonymous', title: 'Anonymous prerequisite', role: 'batch', workspacePath: work, actor: 'scheduler' });
    const h = handler(); await tick(h); productionRetry(parent, kind);
    const card = await review(target, [parent.id]); assert.equal(getTask(card.id).status, 'waiting');
    await checkQuiet(target, [1, 32, 121, 242]);
    assert.deepEqual(h.families, ['openai']);
  });
  it(`production ${kind} reviewing ancestor requeue stays quiet`, async () => {
    const target = delivery(); const parentTarget = delivery(); const parent = await review(parentTarget);
    const h = handler(); await tick(h); productionRetry(parent, kind);
    const card = await review(target, [parent.id]); assert.equal(getTask(card.id).status, 'waiting');
    await checkQuiet(target, [1, 32, 121, 242]);
    assert.deepEqual(h.families, ['xai']);
  });
}

for (const kind of ['other', 'login_blip'] as const) {
  it(`${kind} survives repeated scans/restart, resumes a run, then restores both reminder clocks`, async () => {
    const target = delivery(); const card = await review(target); const h = handler(); await tick(h);
    productionRetry(card, kind);
    await checkQuiet(target, [1, 32, 121, 242, 242]);
    closeDb(); resetAcceptanceBackoffForTests(); await checkQuiet(target, [243, 243]);
    assert.equal((getDb().prepare("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND kind = 'acceptance_review_wait_started'").get(target.id) as { n: number }).n, 1);
    await tick(h, 244); assert.equal(getTask(card.id).status, 'reviewing');
    assert.deepEqual(h.families, ['xai', 'xai']); await checkQuiet(target, [275, 365]);
    await approveTask(card.id, 'Anonymous closed review');
    await acceptTask(card.id); // Anonymous non-Git directory: no branch can be merged.
    sent.length = 0;
    const scanBoth = async (minutes: number) => {
      await scanAcceptance({ config, now: date(minutes) });
      await scanPrerequisiteAttention({ config, now: date(minutes), agentState: () => 'archived', send: async (_id, text) => { sent.push(text); } });
    };
    await scanBoth(366); assert.equal(sent.length, 0);
    closeDb(); resetAcceptanceBackoffForTests(); await scanBoth(395.99); assert.equal(sent.length, 0);
    await scanBoth(396.01); assert.ok(sent.length > 0);
    assert.equal(JSON.parse(getTask(target.id).tags ?? '[]').includes('leader-unresponsive'), false);
    await scanBoth(485.99); assert.equal(JSON.parse(getTask(target.id).tags ?? '[]').includes('leader-unresponsive'), false);
    await scanBoth(486.01); assert.equal(JSON.parse(getTask(target.id).tags ?? '[]').includes('leader-unresponsive'), true);
    const events = getDb().prepare("SELECT kind FROM events WHERE task_id = ? AND kind IN ('wake_acceptance_repeat','wake_prerequisite')").all(target.id) as Array<{ kind: string }>;
    assert.ok(events.some(e => e.kind === 'wake_acceptance_repeat'));
    assert.ok(events.some(e => e.kind === 'wake_prerequisite'));
    assert.equal((getDb().prepare("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND kind = 'acceptance_review_wait_ended'").get(target.id) as { n: number }).n, 1);
  });
  it(`real ${kind} failure takes priority over another proven queued review`, async () => {
    const target = delivery(); const card = await review(target); const h = handler(); await tick(h); productionRetry(card, kind);
    const second = await review(target); await runKanban(['start', String(second.id)], {}, { launcher: h.launcher });
    sent.length = 0;
    assert.equal(kind === 'login_blip' ? applyLoginBlip(second.id, getTask(second.id).agent_id!, 3) :
      applyFailure(second.id, 'anonymous credential failure', 'credential'), 'block');
    assert.equal(getTask(second.id).blocked_kind, 'needs_human'); assert.ok(sent.length > 0);
    assert.equal(loadAcceptanceReviewWaits().has(target.id), false);
    assert.equal(boardSnapshot('anonymous').tasks.find(c => c.id === target.id)!.badge, 'Waiting for acceptance');
  });
}
it('login requeue uses the configured cooldown and accepts the second allowed attempt', async () => {
  saveConfig({ ...config, loginBlipRetryMs: 600_000 });
  const target = delivery(); const card = await review(target); const h = handler(); await tick(h);
  productionRetry(card, 'login_blip', 2);
  await checkQuiet(target, [1, 9, 32, 121, 242]);
});

for (const kind of ['other', 'login_blip'] as const) {
  for (const path of ['review', 'ancestor'] as const) {
    const common = ['missing-transition', 'missing-start', 'missing-run', 'wrong-agent', 'wrong-run-role', 'wrong-start-role', 'wrong-run-id',
      'open-run', 'wrong-end-kind', 'wrong-entry', 'wrong-actor', 'bare-kind', 'wrong-row-agent', 'needs-human', 'wait-decision', 'blocked',
      'wrong-project', 'wrong-role', 'wrong-target', 'old-round', 'old-history'];
    const specific = kind === 'other' ? ['wrong-count', 'wrong-max', 'at-limit', 'wrong-kind', 'wrong-cooldown', 'wrong-reason'] :
      ['wrong-login-agent', 'wrong-login-kind', 'wrong-cooldown', 'no-cooldown', 'third-blip', 'zero-attempt', 'fractional-attempt', 'config-changed'];
    for (const invalid of [...common, ...specific]) {
      it(`rejects ${kind} ${path} ${invalid} evidence and still notifies`, async () => {
        const target = delivery(); const h = handler();
        const source = path === 'review' ? await review(target) :
          createTask({ project: 'anonymous', title: 'Anonymous prerequisite', role: 'batch', workspacePath: work, actor: 'scheduler' });
        await tick(h); productionRetry(source, kind);
        const linked = path === 'review' ? source : await review(target, [source.id]);
        const db = getDb();
        if (invalid === 'missing-transition' || invalid === 'bare-kind') db.prepare("DELETE FROM events WHERE task_id = ? AND kind = ?").run(source.id, kind === 'other' ? 'requeued' : kind);
        if (invalid === 'missing-start' || invalid === 'bare-kind') db.prepare("DELETE FROM events WHERE task_id = ? AND kind = 'started'").run(source.id);
        if (invalid === 'missing-run') db.prepare('DELETE FROM runs WHERE task_id = ?').run(source.id);
        if (invalid === 'wrong-agent') db.prepare("UPDATE runs SET agent_id = 'other-agent' WHERE task_id = ?").run(source.id);
        if (invalid === 'wrong-run-role') db.prepare("UPDATE runs SET role = 'executor' WHERE task_id = ?").run(source.id);
        if (invalid === 'wrong-start-role') db.prepare("UPDATE events SET data_json = json_set(data_json, '$.role', 'executor') WHERE task_id = ? AND kind = 'started'").run(source.id);
        if (invalid === 'wrong-run-id') db.prepare('UPDATE runs SET id = id + 100000 WHERE task_id = ?').run(source.id);
        if (invalid === 'open-run') db.prepare('UPDATE runs SET ended_at = NULL WHERE task_id = ?').run(source.id);
        if (invalid === 'wrong-end-kind') db.prepare("UPDATE runs SET end_kind = 'complete' WHERE task_id = ?").run(source.id);
        if (invalid === 'wrong-entry' || invalid === 'old-history') appendEvent(source.id, 'reopened', 'blocked', getTask(source.id).status, 'supervisor', {});
        if (invalid === 'wrong-actor') db.prepare("UPDATE events SET actor = 'supervisor' WHERE task_id = ? AND kind = ?").run(source.id, kind === 'other' ? 'requeued' : kind);
        if (invalid === 'wrong-row-agent') db.prepare("UPDATE tasks SET agent_id = 'unbound-agent' WHERE id = ?").run(source.id);
        if (invalid === 'needs-human') db.prepare("UPDATE tasks SET blocked_kind = 'needs_human' WHERE id = ?").run(source.id);
        if (invalid === 'wait-decision') db.prepare("UPDATE tasks SET wait_decision = 'anonymous-decision' WHERE id = ?").run(source.id);
        if (invalid === 'blocked') db.prepare("UPDATE tasks SET status = 'blocked' WHERE id = ?").run(source.id);
        if (invalid === 'wrong-project') db.prepare("UPDATE tasks SET project = 'other' WHERE id = ?").run(linked.id);
        if (invalid === 'wrong-role') db.prepare("UPDATE tasks SET role = 'batch' WHERE id = ?").run(linked.id);
        if (invalid === 'wrong-target') db.prepare('UPDATE tasks SET review_of = NULL WHERE id = ?').run(linked.id);
        if (invalid === 'old-round') appendEvent(target.id, 'complete', 'running', 'acceptance', 'batch', {}, date(1).toISOString());
        if (invalid === 'wrong-count') db.prepare('UPDATE tasks SET fail_count = fail_count + 1 WHERE id = ?').run(source.id);
        if (invalid === 'wrong-max') db.prepare('UPDATE tasks SET max_retries = max_retries + 1 WHERE id = ?').run(source.id);
        if (invalid === 'at-limit') {
          db.prepare('UPDATE tasks SET fail_count = max_retries WHERE id = ?').run(source.id);
          db.prepare("UPDATE events SET data_json = json_set(data_json, '$.failCount', ?) WHERE task_id = ? AND kind = 'requeued'").run(getTask(source.id).max_retries, source.id);
        }
        if (invalid === 'wrong-kind') db.prepare("UPDATE events SET data_json = json_set(data_json, '$.kind', 'quota') WHERE task_id = ? AND kind = 'requeued'").run(source.id);
        if (invalid === 'wrong-cooldown') db.prepare('UPDATE tasks SET cooldown_until = ? WHERE id = ?').run(date(6).toISOString(), source.id);
        if (invalid === 'wrong-reason') db.prepare("UPDATE tasks SET blocked_reason = 'unrelated block' WHERE id = ?").run(source.id);
        if (invalid === 'wrong-login-agent') db.prepare("UPDATE events SET data_json = json_set(data_json, '$.agentId', 'other-agent') WHERE task_id = ? AND kind = 'login_blip'").run(source.id);
        if (invalid === 'wrong-login-kind') db.prepare("UPDATE tasks SET blocked_kind = 'quota' WHERE id = ?").run(source.id);
        if (invalid === 'no-cooldown') db.prepare('UPDATE tasks SET cooldown_until = NULL WHERE id = ?').run(source.id);
        if (invalid === 'third-blip' || invalid === 'zero-attempt' || invalid === 'fractional-attempt') db.prepare("UPDATE events SET data_json = json_set(data_json, '$.attempt', ?) WHERE task_id = ? AND kind = 'login_blip'").run(invalid === 'third-blip' ? 3 : invalid === 'zero-attempt' ? 0 : 1.5, source.id);
        if (invalid === 'config-changed') saveConfig({ ...config, loginBlipRetryMs: 600_000 });
        // Batch starts have no reviewerRunId: changing the numeric run ID alone is not an identity mismatch.
        if (invalid === 'wrong-run-id' && path === 'ancestor') db.prepare("UPDATE runs SET agent_id = 'other-agent' WHERE task_id = ?").run(source.id);
        assert.equal(loadAcceptanceReviewWaits().has(target.id), false);
        sent.length = 0;
        for (const minute of [32, 62.01, 153, 242]) {
          await scanAcceptance({ config, now: date(minute) });
          await scanPrerequisiteAttention({ config, now: date(minute), agentState: () => 'archived', send: async (_id, text) => { sent.push(text); } });
        }
        assert.ok(sent.length > 0);
        assert.equal(JSON.parse(getTask(target.id).tags ?? '[]').includes('leader-unresponsive'), true);
        assert.ok((db.prepare("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND kind = 'wake_acceptance_repeat'").get(target.id) as { n: number }).n > 0);
      });
    }
  }
}
for (const kind of ['other', 'login_blip'] as const) {
  it(`${kind} thirty linked dependency waits still use only two SQL statements`, async () => {
    const target = delivery();
    const parent = createTask({ project: 'anonymous', title: 'Anonymous prerequisite', role: 'batch', workspacePath: work, actor: 'scheduler' });
    const h = handler(); await tick(h); productionRetry(parent, kind);
    for (let n = 0; n < 30; n++) await review(target, [parent.id]);
    takePerfSummary();
    round('retry.dependencies', () => assert.equal(loadAcceptanceReviewWaits(target.id).get(target.id)!.reviews.length, 30));
    assert.equal(takePerfSummary()!.loops['retry.dependencies'].io.sql, 2);
  });
}

it("keeps a new matching live reviewer run handled after applyFailure counted a retry", async () => {
  const target = delivery(); const card = await review(target); const h = handler(); await tick(h);
  assert.equal(applyFailure(card.id, "synthetic retryable failure", "other", new Date(), "review"), "requeue");
  assert.equal(getTask(card.id).fail_count, 1); await tick(h, 1);
  assert.equal(getTask(card.id).status, "reviewing"); assert.equal(getTask(card.id).fail_count, 1);
  getDb().prepare("UPDATE tasks SET cooldown_until = ? WHERE id = ?").run(date(-1).toISOString(), card.id);
  assert.deepEqual(h.families, ["xai", "xai"]); await checkQuiet(target);
  assert.equal(getTask(card.id).cooldown_until, date(-1).toISOString(), "history is not erased to grant a wait");
});
for (const phase of ["reviewing", "running"] as const) {
for (const kind of ["quota", "rate_limit", "transient"] as FailureClass[]) {
  it(`recognizes production ${kind} requeue from ${phase} before and after cooldown, then resumes the different family`, async () => {
    const target = delivery(); const card = await review(target); const h = handler();
    if (phase === "running") {
      // Imported standalone review rework enters its work phase through the real start handler.
      getDb().prepare("UPDATE tasks SET status = 'rework' WHERE id = ?").run(card.id);
      appendEvent(card.id, "leader_rework", "ready", "rework", "supervisor", {});
    }
    await tick(h); assert.equal(getTask(card.id).status, phase);
    assert.equal(applyFailure(card.id, "synthetic queue", kind, new Date(), "review"), "requeue");
    assert.equal(getTask(card.id).status, phase === "running" ? "ready" : "in_review");
    await checkQuiet(target, [1, 32, 121]);
    pools(false); await tick(h, 6); await checkQuiet(target, [242]);
    assert.equal(getTask(card.id).status, phase === "running" ? "ready" : "in_review"); assert.equal(h.families.length, 1);
    pools(true); await tick(h, 243);
    assert.equal(getTask(card.id).status, "reviewing"); assert.deepEqual(h.families, ["xai", "xai"]);
    await checkQuiet(target, [274, 364]);
  });
}
}
it("does not let another review's historical counted retry cancel a matching active review", async () => {
  const target = delivery(); const first = await review(target); const h = handler(); await tick(h);
  applyFailure(first.id, "synthetic historical retry", "other", new Date());
  await tick(h, 1);
  const second = await review(target);
  await runKanban(["start", String(second.id)], {}, { launcher: h.launcher });
  assert.equal(getTask(first.id).fail_count, 1); assert.equal(getTask(second.id).status, "reviewing");
  await checkQuiet(target);
});
it("does not let an unproven retry string and historical count cancel another matching active review", async () => {
  const target = delivery(); const first = await review(target); const h = handler(); await tick(h);
  applyFailure(first.id, "synthetic historical retry", "transient", new Date());
  getDb().prepare("UPDATE tasks SET blocked_kind = 'transient' WHERE id = ?").run(first.id);
  const second = await review(target); await runKanban(["start", String(second.id)], {}, { launcher: h.launcher });
  assert.deepEqual(loadAcceptanceReviewWaits().get(target.id)!.reviews.map(r => r.id), [second.id]);
  await checkQuiet(target);
});
it("rejects a mismatched current started/run identity even with historical retry evidence", async () => {
  const target = delivery(); const card = await review(target); const h = handler(); await tick(h);
  applyFailure(card.id, "synthetic retry", "other", new Date()); await tick(h, 1);
  getDb().prepare("UPDATE events SET data_json = json_set(data_json, '$.reviewerRunId', -1) WHERE task_id = ? AND kind = 'started'").run(card.id);
  assert.equal(loadAcceptanceReviewWaits().has(target.id), false);
  await scanAcceptance({ config, now: date(32) }); sent.length = 0;
  await scanAcceptance({ config, now: date(62.01) }); assert.equal(sent.length, 1);
});
it("recognizes a production transient ancestor requeue but remains conservative without its current evidence", async () => {
  const target = delivery(); const parent = createTask({ project: "anonymous", title: "Anonymous prerequisite", role: "batch", workspacePath: work, actor: "scheduler" });
  const h = handler(); await tick(h); applyFailure(parent.id, "synthetic transient", "transient", new Date());
  const card = await review(target, [parent.id]); assert.equal(getTask(card.id).status, "waiting");
  await checkQuiet(target);
  getDb().prepare("DELETE FROM events WHERE task_id = ? AND kind = 'requeued'").run(parent.id);
  assert.equal(loadAcceptanceReviewWaits().has(target.id), false);
});
it("does not treat an ancestor's historical fail_count as a current dependency fault when its replacement run is healthy", async () => {
  const target = delivery(); const parent = createTask({ project: "anonymous", title: "Anonymous prerequisite", role: "batch", workspacePath: work, actor: "scheduler" });
  const h = handler(); await tick(h); applyFailure(parent.id, "synthetic retry", "other", new Date()); await tick(h, 1);
  assert.equal(getTask(parent.id).fail_count, 1); assert.equal(getTask(parent.id).status, "running");
  const other = createTask({ project: "anonymous", title: "Anonymous remaining prerequisite", role: "batch", workspacePath: work, actor: "scheduler" });
  const card = await review(target, [parent.id, other.id]); assert.equal(getTask(card.id).status, "waiting");
  await checkQuiet(target);
  await completeTask(parent.id, "batch", "Anonymous delivery after retry", {});
  assert.equal(getTask(parent.id).status, "acceptance"); assert.equal(getTask(parent.id).fail_count, 1);
  assert.equal(loadAcceptanceReviewWaits().has(target.id), true);
  sent.length = 0; await scanAcceptance({ config, now: date(274) });
  assert.equal(sent.length, 1, "the unrelated parent delivery still needs acceptance");
  assert.ok(sent[0].includes(cardMark(parent.id))); assert.ok(!sent[0].includes(cardMark(target.id)));
  assert.equal((getDb().prepare("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND kind IN ('wake_acceptance_repeat','wake_prerequisite','leader_unresponsive')").get(target.id) as { n: number }).n, 0);
  assert.equal(boardSnapshot("anonymous").tasks.find(t => t.id === target.id)!.badge, "Ruling recorded, awaiting review");
  await acceptTask(parent.id); assert.equal(getTask(parent.id).status, "done");
  assert.equal(getTask(card.id).status, "waiting");
  await checkQuiet(target, [305, 395]);
});

it("preserves the immediate real needs_human alarm and cancels a second otherwise valid review wait", async () => {
  const target = delivery(); const first = await review(target); const h = handler(); await tick(h);
  const second = await review(target); await runKanban(["start", String(second.id)], {}, { launcher: h.launcher });
  sent.length = 0;
  assert.equal(applyFailure(first.id, "synthetic credential failure", "credential"), "block");
  assert.equal(getTask(first.id).blocked_kind, "needs_human");
  assert.ok(sent.some(text => text.includes("synthetic credential failure")));
  assert.equal(loadAcceptanceReviewWaits().has(target.id), false);
  assert.equal(boardSnapshot("anonymous").tasks.find(t => t.id === target.id)!.badge, "Waiting for acceptance");
  await scanAcceptance({ config, now: date(32) }); sent.length = 0;
  await scanAcceptance({ config, now: date(62.01) }); assert.equal(sent.length, 1);
});

for (const invalid of ["missing-requeued", "wrong-run", "wrong-kind", "wrong-cooldown", "stale-entry", "no-closed-run", "bare-kind", "bare-transient", "wrong-start-binding", "needs-human", "decision", "blocked", "old-round"] as const) {
  it(`does not exempt ${invalid} retry evidence`, async () => {
    const target = delivery(); const card = await review(target); const h = handler(); await tick(h);
    applyFailure(card.id, "synthetic queue", "quota", new Date(), "review");
    if (invalid === "missing-requeued") getDb().prepare("DELETE FROM events WHERE task_id = ? AND kind = 'requeued'").run(card.id);
    if (invalid === "wrong-run") getDb().prepare("UPDATE runs SET role = 'executor' WHERE task_id = ?").run(card.id);
    if (invalid === "wrong-kind") getDb().prepare("UPDATE runs SET end_kind = 'complete' WHERE task_id = ?").run(card.id);
    if (invalid === "wrong-cooldown") getDb().prepare("UPDATE tasks SET cooldown_until = ? WHERE id = ?").run(date(6).toISOString(), card.id);
    if (invalid === "stale-entry") appendEvent(card.id, "reopened", "blocked", "in_review", "supervisor", {});
    if (invalid === "no-closed-run") getDb().prepare("UPDATE runs SET ended_at = NULL WHERE task_id = ?").run(card.id);
    if (invalid === "bare-kind") { getDb().prepare("DELETE FROM events WHERE task_id = ? AND kind IN ('requeued','started')").run(card.id); }
    if (invalid === "bare-transient") { getDb().prepare("UPDATE tasks SET blocked_kind = 'transient' WHERE id = ?").run(card.id); }
    if (invalid === "wrong-start-binding") getDb().prepare("UPDATE events SET data_json = json_set(data_json, '$.reviewerRunId', -1) WHERE task_id = ? AND kind = 'started'").run(card.id);
    if (invalid === "needs-human") getDb().prepare("UPDATE tasks SET blocked_kind = 'needs_human' WHERE id = ?").run(card.id);
    if (invalid === "decision") getDb().prepare("UPDATE tasks SET wait_decision = 'anonymous-decision' WHERE id = ?").run(card.id);
    if (invalid === "blocked") getDb().prepare("UPDATE tasks SET status = 'blocked' WHERE id = ?").run(card.id);
    if (invalid === "old-round") appendEvent(target.id, "complete", "running", "acceptance", "batch", {}, date(1).toISOString());
    assert.equal(loadAcceptanceReviewWaits().has(target.id), false);
    sent.length = 0;
    await scanAcceptance({ config, now: date(121) });
    assert.equal(sent.length, invalid === "old-round" ? 1 : 0);
    await scanAcceptance({ config, now: date(151.01) });
    assert.equal(sent.length, invalid === "old-round" ? 2 : 1);
    await scanAcceptance({ config, now: date(242) });
    assert.equal(JSON.parse(getTask(target.id).tags ?? "[]").includes("leader-unresponsive"), true);
  });
}
