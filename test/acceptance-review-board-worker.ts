/// <reference types="node" />
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, mock } from "node:test";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { PaseoApi } from "@getpaseo/client";

// Mount the real server contribution and invoke its registered handlers. Only
// external/background bindings are disabled; there is no provider or daemon.
mock.module(new URL("../server/mcp.ts", import.meta.url).href, {
  namedExports: { startMcpServer: async () => ({ url: "http://fixture", port: 0, replaced: false, close: async () => {} }) },
});
mock.module(new URL("../server/loop.ts", import.meta.url).href, {
  namedExports: { bindScheduler: () => ({ reused: false, kick: async () => {}, release() {} }) },
});
mock.module(new URL("../server/early-bind.ts", import.meta.url).href, {
  namedExports: { startEarlyBind: () => ({ stop() {} }) },
});
const missing = await import("../server/missing-cwd");
mock.module(new URL("../server/missing-cwd.ts", import.meta.url).href, {
  namedExports: { ...missing, startMissingCwdPatrol: () => () => {} },
});
const exportsModule = await import("../server/exports");
mock.module(new URL("../server/exports.ts", import.meta.url).href, {
  namedExports: { ...exportsModule, startExports: () => () => {} },
});
const { default: contribute } = await import("../index.server");
const { saveConfig } = await import("../server/config");
const { closeDb, getDb } = await import("../server/db");
const { createTask, appendEvent } = await import("../server/store");
const { boardRpc, taskRpc } = await import("../shared/rpc");
const { setLanguage, translate } = await import("../shared/i18n");
const { applyFailure } = await import("../server/failures");
const { applyLoginBlip } = await import("../server/login-blip");

it("real board/detail handlers transmit the review wait through unchanged RPC schemas", async () => {
  const dir = mkdtempSync(join(tmpdir(), "acceptance-review-handler-"));
  process.env.KANBAN_DATA_DIR = dir;
  process.env.KANBAN_AGENTS_DIR = join(dir, "agents");
  mkdirSync(process.env.KANBAN_AGENTS_DIR);
  saveConfig({ language: 'zh-CN', autoStart: { demo: false }, supervisors: {}, supervisorAgentId: null,
    concurrency: { global: 1, pools: {}, roles: {} } });
  const target = createTask({ project: 'demo', title: 'anonymous delivered batch', role: 'batch', workspacePath: dir, actor: 'scheduler' });
  getDb().prepare("UPDATE tasks SET status = 'acceptance', tags = '[\"leader-unresponsive\"]' WHERE id = ?").run(target.id);
  appendEvent(target.id, 'complete', 'running', 'acceptance', 'batch');
  const review = createTask({ project: 'demo', title: 'anonymous review', role: 'reviewer', reviewOf: target.id, workspacePath: dir, actor: 'supervisor' });
  getDb().prepare("UPDATE tasks SET hold_reason = 'synthetic quota 71%' WHERE id = ?").run(review.id);
  appendEvent(review.id, 'held', 'ready', 'ready', 'scheduler', { kind: 'quota', quotaWait: true, reason: 'synthetic quota 71%',
    quota: { state: 'fresh', usedPct: 71, dispatchable: false } });
  getDb().prepare("UPDATE tasks SET tags = '[\"leader-unresponsive\"]' WHERE id = ?").run(target.id);
  const handlers = new Map<string, (input: unknown, context: { paseo: PaseoApi }) => unknown>();
  const server = {
    before: () => () => {}, on: () => () => {},
    handle: (rpc: { name: string }, fn: (input: unknown, context: { paseo: PaseoApi }) => unknown) => { handlers.set(rpc.name, fn); },
  } as unknown as PluginServerContext;
  let sends = 0;
  const paseo = { agents: { ref: () => ({ send: async () => { sends++; assert.fail('must not send'); } }) } } as unknown as PaseoApi;
  let unload: (() => Promise<void>) | undefined;
  try {
    unload = contribute(server);
    const board = boardRpc.output.parse(await handlers.get(boardRpc.name)!({ project: 'demo' }, { paseo }));
    const card = board.tasks.find(card => card.id === target.id)!;
    assert.equal(card.badge, translate('zh-CN', 'acceptanceReviewWait.badge')); assert.match(card.nextStep!, new RegExp(translate('zh-CN', 'acceptanceReviewWait.reason.quota')));
    assert.equal(card.leaderUnresponsive, false); assert.equal(card.status, 'acceptance');
    const detail = taskRpc.output.parse(await handlers.get(taskRpc.name)!({ id: target.id }, { paseo }));
    assert.equal(detail.task.badge, card.badge); assert.equal(detail.task.nextStep, card.nextStep);
    assert.equal(detail.task.leaderUnresponsive, false);
    setLanguage('en');
    const english = boardRpc.output.parse(await handlers.get(boardRpc.name)!({ project: 'demo' }, { paseo }));
    assert.equal(english.tasks.find(card => card.id === target.id)!.badge, 'Ruling recorded, awaiting review');
    getDb().prepare("UPDATE tasks SET hold_reason = 'synthetic capacity' WHERE id = ?").run(review.id);
    appendEvent(review.id, 'held', 'ready', 'ready', 'scheduler', { kind: 'concurrency', reason: 'synthetic capacity' });
    for (const language of ['en', 'zh-CN'] as const) {
      setLanguage(language);
      const capacity = boardRpc.output.parse(await handlers.get(boardRpc.name)!({ project: 'demo' }, { paseo }));
      const capacityCard = capacity.tasks.find(card => card.id === target.id)!;
      assert.match(capacityCard.nextStep!, language === 'en' ? /concurrency queue/ : new RegExp(translate('zh-CN', 'acceptanceReviewWait.reason.concurrency')));
      assert.equal(capacityCard.leaderUnresponsive, false);
      const capacityDetail = taskRpc.output.parse(await handlers.get(taskRpc.name)!({ id: target.id }, { paseo }));
      assert.equal(capacityDetail.task.nextStep, capacityCard.nextStep);
    }
    assert.equal((getDb().prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n, 0);
    let activeReview = review;
    const startSyntheticRun = () => {
      const agentId = 'anonymous-retry-reviewer';
      const prior = (getDb().prepare('SELECT status FROM tasks WHERE id = ?').get(activeReview.id) as { status: string }).status;
      const runId = Number(getDb().prepare("INSERT INTO runs(task_id, agent_id, role, family, started_at) VALUES (?, ?, 'reviewer', 'xai', ?)")
        .run(activeReview.id, agentId, new Date().toISOString()).lastInsertRowid);
      getDb().prepare("UPDATE tasks SET status = 'reviewing', agent_id = ?, blocked_kind = NULL, blocked_reason = NULL, cooldown_until = NULL WHERE id = ?").run(agentId, activeReview.id);
      appendEvent(activeReview.id, 'started', prior, 'reviewing', 'scheduler', { agentId, role: 'reviewer', reviewerRunId: runId });
      return agentId;
    };
    for (const kind of ['quota', 'rate_limit', 'transient', 'other', 'login_blip'] as const) {
      if (kind === 'other') {
        // A new card exercises its real default retry budget; never erase the prior counter.
        getDb().prepare("UPDATE tasks SET status = 'archived' WHERE id = ?").run(activeReview.id);
        activeReview = createTask({ project: 'demo', title: 'anonymous counted review', role: 'reviewer', reviewOf: target.id, workspacePath: dir, actor: 'supervisor' });
        getDb().prepare("UPDATE tasks SET tags = '[\"leader-unresponsive\"]' WHERE id = ?").run(target.id);
      }
      const agentId = startSyntheticRun();
      assert.equal(kind === 'login_blip' ? applyLoginBlip(activeReview.id, agentId, 1) :
        applyFailure(activeReview.id, 'anonymous synthetic queue', kind), 'requeue');
      for (const language of ['en', 'zh-CN'] as const) {
        setLanguage(language);
        const queued = boardRpc.output.parse(await handlers.get(boardRpc.name)!({ project: 'demo' }, { paseo }));
        const queuedCard = queued.tasks.find(card => card.id === target.id)!;
        const reason = kind === 'quota' ? (language === 'en' ? /quota queue/ : new RegExp(translate('zh-CN', 'acceptanceReviewWait.reason.quota'))) :
          kind === 'rate_limit' ? (language === 'en' ? /rate limit queue/ : new RegExp(translate('zh-CN', 'acceptanceReviewWait.reason.rate_limit'))) :
            (language === 'en' ? /retry queue/ : new RegExp(translate('zh-CN', 'acceptanceReviewWait.reason.retry')));
        assert.match(queuedCard.nextStep!, reason); assert.equal(queuedCard.leaderUnresponsive, false);
        const queuedDetail = taskRpc.output.parse(await handlers.get(taskRpc.name)!({ id: target.id }, { paseo }));
        assert.equal(queuedDetail.task.nextStep, queuedCard.nextStep);
      }
    }
    startSyntheticRun();
    getDb().prepare("UPDATE tasks SET cooldown_until = ? WHERE id = ?").run(new Date(Date.now() - 60_000).toISOString(), activeReview.id);
    const historical = boardRpc.output.parse(await handlers.get(boardRpc.name)!({ project: 'demo' }, { paseo }));
    assert.equal(historical.tasks.find(card => card.id === target.id)!.leaderUnresponsive, false);
    assert.match(historical.tasks.find(card => card.id === target.id)!.nextStep!, new RegExp(translate('zh-CN', 'acceptanceReviewWait.reason.running')));
    setLanguage('en');
    getDb().prepare("UPDATE tasks SET status = 'archived' WHERE id = ?").run(activeReview.id);
    const ended = boardRpc.output.parse(await handlers.get(boardRpc.name)!({ project: 'demo' }, { paseo }));
    assert.equal(ended.tasks.find(card => card.id === target.id)!.badge, 'Waiting for acceptance');
    assert.equal(ended.tasks.find(card => card.id === target.id)!.leaderUnresponsive, true);
    assert.equal(sends, 0);
    assert.equal((getDb().prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n, 6);
    assert.equal((getDb().prepare("SELECT COUNT(*) AS n FROM events WHERE kind LIKE 'acceptance_review_wait_%'").get() as { n: number }).n, 0);
    console.log(JSON.stringify({ evidence: 'real registered board/detail handlers, no phone UI claim', badge: card.badge, nextStep: card.nextStep,
      leaderUnresponsive: card.leaderUnresponsive, sends, syntheticRunRows: 6, providerRuns: 0, reviewWaitWrites: 0 }));
  } finally {
    await unload?.(); closeDb(); rmSync(dir, { recursive: true, force: true });
  }
});
