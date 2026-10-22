/// <reference types="node" />
import { zhCN, zhCNPart, localePattern } from "./helpers/locale";
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { setAgentAliveCheck, resetAgentAliveCheck } from '../server/alive';
import { runKanban } from '../server/cli';
import { saveConfig, type KanbanConfig } from '../server/config';
import { closeDb, getDb } from '../server/db';
import { completeTask, leaderReworkTask, pendingReworkReplacement, rejectTask, requestChanges } from '../server/flow';
import { openEntry, type PoolSnapshot } from '../server/pools';
import type { Profile } from '../server/profiles';
import { resetReconcileForTests, type TickOptions } from "../server/schedule";
import { runTick } from "./helpers/compat-schedule";
import { addComment, appendEvent, createTask, getTask, requestAgentReleases } from '../server/store';
import { issueToken, identityFromToken } from '../server/tokens';

const original: Profile = { id: 'old', name: zhCN("labels.identity.executor"), role: 'executor', family: 'xai', provider: 'cursor', model: 'grok-4.7', pool: 'cursor' };
const candidate: Profile = { id: 'candidate', name: "Candidate executor", role: 'candidate', candidateFor: 'executor', family: 'anthropic', provider: 'claude', model: 'sonnet', pool: 'claude-max' };
const reviewer: Profile = { id: 'reviewer', name: zhCN("labels.role.reviewer"), role: 'reviewer', family: 'anthropic', provider: 'claude', model: 'sonnet', pool: 'claude-max' };
const crossReviewer: Profile = { id: 'cross', name: "Cross-family review", role: 'candidate', candidateFor: 'reviewer', family: 'xai', provider: 'grok', model: 'grok-4.7', pool: 'supergrok' };
const profiles = [original, candidate, reviewer, crossReviewer];
const start = new Date('2026-10-02T01:00:00.000Z');
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'test-0103-reopen-'));
  process.env.KANBAN_DATA_DIR = dir;
  process.env.KANBAN_AGENTS_DIR = join(dir, 'agents');
  mkdirSync(process.env.KANBAN_AGENTS_DIR);
  resetReconcileForTests();
  setAgentAliveCheck(() => true);
});
afterEach(() => {
  resetAgentAliveCheck();
  closeDb();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.KANBAN_AGENTS_DIR;
});

function pools(closed: string[] = []): PoolSnapshot {
  return { state: 'fresh', message: '', generatedAt: start.toISOString(), hasPool: () => true,
    dispatchable: pool => !closed.includes(pool ?? ''), entry: pool => ({ ...openEntry(), dispatchable: !closed.includes(pool ?? '') }) };
}
function fixture() {
  const cwd = join(dir, 'original-copy');
  mkdirSync(cwd);
  mkdirSync(join(cwd, '.git'));
  writeFileSync(join(cwd, 'prior.txt'), 'previous submission');
  const task = createTask({ project: 'reopen', title: "Resume rework", role: 'executor', workspacePath: cwd, brief: "Original request", profileOverride: original.name });
  getDb().prepare("UPDATE tasks SET status = 'reviewing', workspace_kind = 'worktree', agent_id = 'review-agent', executor_agent_id = 'old-agent', executor_profile = ?, executor_family = ?, handoff_json = ? WHERE id = ?")
    .run(original.name, original.family!, JSON.stringify({ summary: "Earlier delivery" }), task.id);
  getDb().prepare("INSERT INTO runs (task_id, agent_id, role, profile_name, provider, family, started_at, ended_at, end_kind) VALUES (?, 'old-agent', 'executor', ?, ?, ?, ?, ?, 'complete')")
    .run(task.id, original.name, original.provider, original.family!, start.toISOString(), start.toISOString());
  appendEvent(task.id, 'worktree_created', null, null, 'test', { directory: cwd, workspaceId: 'original-ws', root: dir, branch: 'kanban/original', base: 'main', temp: true });
  const config: KanbanConfig = { autoStart: { reopen: true }, supervisorAgentId: null, supervisors: {}, concurrency: { global: 20, roles: {}, pools: {} } };
  saveConfig(config);
  const opened: Parameters<TickOptions['launcher']['create']>[0][] = [];
  const sent: string[] = [];
  const launcher: TickOptions['launcher'] = {
    async create(options) { opened.push(options); return { id: options.labels?.role === 'reviewer' ? 'new-reviewer' : 'new-executor' }; },
    async send(id) { sent.push(id); },
    async createWorktree() { assert.fail('must reuse original copy'); },
  };
  const tick = (extra: Partial<TickOptions> = {}) => runTick({ now: start, profiles, launcher, config, matrix: { state: 'missing' }, pools: pools(), agentState: id => id === 'old-agent' ? 'archived' : 'alive', ...extra });
  const oldToken = issueToken('executor', task.id, 'old-agent');
  return { task, cwd, config, opened, sent, launcher, tick, oldToken };
}
function events(id: number, kind: string) {
  return (getDb().prepare('SELECT data_json FROM events WHERE task_id = ? AND kind = ? ORDER BY id').all(id, kind) as Array<{ data_json: string }>).map(row => JSON.parse(row.data_json));
}

describe('automatic reopening of departed executors', () => {
  for (const changedList of [2, 3]) it(`keeps rework pending when workspace list ${changedList} starts archiving the selected copy`, async () => {
    const f = fixture();
    await leaderReworkTask(f.task.id, 'Fix the archive race', { presence: () => 'archived' });
    let lists = 0;
    f.launcher.listWorkspaces = async () => [{
      id: 'original-ws', directory: f.cwd, name: 'original', projectRoot: dir,
      projectId: 'demo', kind: 'worktree', archived: ++lists >= changedList,
    }];
    await f.tick();
    assert.equal(lists, changedList);
    assert.equal(f.opened.length, 0);
    assert.equal(getTask(f.task.id).status, 'ready');
    assert.ok(pendingReworkReplacement(f.task.id));
    assert.equal(events(f.task.id, 'rework_reopened').length, 0);
    assert.equal(events(f.task.id, 'paseo_workspace_archiving').length, 1);
  });

  for (const source of ['request_changes', 'rejected', 'leader_rework', 'land_conflict']) {
    for (const presence of ['archived', 'missing'] as const) {
      it(`${source} reopens an ${presence} executor immediately in its original copy`, async () => {
        const f = fixture();
        appendEvent(f.task.id, 'land_conflict', 'acceptance', 'rework', 'test', { reason: "Previous conflict is not current request" });
        if (source === 'request_changes') requestChanges(f.task.id, "Current fix", "Tests required");
        else if (source === 'leader_rework') await leaderReworkTask(f.task.id, "Current fix", { presence: () => presence });
        else if (source === 'rejected') {
          getDb().prepare("UPDATE tasks SET status = 'acceptance' WHERE id = ?").run(f.task.id);
          rejectTask(f.task.id, "Current fix");
        } else {
          // Same durable transition emitted by accept's conflict path (also covered with real git in land-conflict.test).
          getDb().prepare("UPDATE tasks SET status = 'rework', review_round = 1 WHERE id = ?").run(f.task.id);
          appendEvent(f.task.id, 'land_conflict', 'acceptance', 'rework', 'test', { reason: "Current fix: conflicting file a.ts", files: ['a.ts'] });
        }
        addComment(f.task.id, 'executor', (zhCNPart("settings.thresholds.progressGraceMs", 0, 2) + "Demo text"));
        await f.tick({ agentState: id => id === 'old-agent' ? presence : 'alive' });
        assert.equal(getTask(f.task.id).status, 'running');
        assert.equal(getTask(f.task.id).executor_agent_id, 'new-executor');
        assert.equal(getTask(f.task.id).executor_profile, original.name);
        assert.equal(getTask(f.task.id).hold_reason, null);
        assert.equal(events(f.task.id, 'held').length, 0);
        assert.equal(events(f.task.id, 'rework_wait_started').length, 0);
        assert.equal(f.opened.length, 1);
        assert.deepEqual(f.sent, []);
        assert.equal(f.opened[0].cwd, f.cwd);
        assert.equal(f.opened[0].workspaceId, 'original-ws');
        assert.equal(readFileSync(join(f.cwd, 'prior.txt'), 'utf8'), 'previous submission');
        assert.match(f.opened[0].prompt!, new RegExp(localePattern(zhCNPart("flow.brief.thisRound", 3, 11)) + "\\n" + "Current fix"));
        assert.match(f.opened[0].prompt!, new RegExp(localePattern(zhCNPart("reworkReassign.takeoverNote", 25, 37))));
        if (source === 'request_changes') assert.match(f.opened[0].prompt!, /Tests required/);
        if (source === 'land_conflict') assert.match(f.opened[0].prompt!, /conflicting file a\.ts/);
        assert.doesNotMatch(f.opened[0].prompt!, new RegExp(localePattern(zhCNPart("workspace.freshCopy", 0, 8))));
        const data = events(f.task.id, 'rework_reopened');
        assert.equal(data.length, 1);
        assert.equal(data[0].oldAgentId, 'old-agent');
        assert.equal(data[0].newProfile, original.name);
        assert.equal(data[0].directory, f.cwd);
        assert.throws(() => identityFromToken(f.oldToken));
        await f.tick();
        assert.equal(f.opened.length, 1);
        assert.equal(events(f.task.id, 'rework_reopened').length, 1);
      });
    }
  }

  for (const source of ['request_changes', 'rejected', 'land_conflict']) {
    for (const presence of ['archived', 'missing'] as const) {
      it(`${source} confirms ${presence} via Paseo despite a stale live record and a release request (EX_0063)`, async () => {
        const f = fixture();
        requestAgentReleases(f.task.id, [{ agentId: 'old-agent', role: 'executor' }]);
        if (source === 'request_changes') requestChanges(f.task.id, "Current fix", "Add archive takeover coverage");
        else if (source === 'rejected') {
          getDb().prepare("UPDATE tasks SET status = 'acceptance' WHERE id = ?").run(f.task.id);
          rejectTask(f.task.id, "Current fix");
        } else {
          getDb().prepare("UPDATE tasks SET status = 'rework', agent_id = NULL, executor_agent_id = NULL WHERE id = ?").run(f.task.id);
          appendEvent(f.task.id, 'land_conflict', 'acceptance', 'rework', 'test', {
            reason: "Current fix: EX_0065 conflicts with client/home.tsx", files: ['client/home.tsx'],
          });
        }
        // Rejection's release marker may have already cleared both bindings.
        assert.equal(getTask(f.task.id).executor_agent_id, null);
        const inspected: string[] = [];
        f.launcher.inspectAgent = async id => { inspected.push(id); return presence === 'missing' ? null : { archived: true }; };
        await f.tick({ agentState: () => 'alive' });
        assert.deepEqual(inspected, ['old-agent']);
        assert.equal(getTask(f.task.id).status, 'running');
        assert.equal(getTask(f.task.id).hold_reason, null);
        assert.deepEqual(f.sent, []);
        assert.equal(f.opened.length, 1);
        assert.equal(f.opened[0].cwd, f.cwd);
        assert.match(f.opened[0].prompt!, new RegExp(localePattern(zhCNPart("flow.brief.thisRound", 3, 11)) + "\\n" + "Current fix"));
        if (source === 'land_conflict') assert.match(f.opened[0].prompt!, /EX_0065 conflicts with client\/home\.tsx/);
        assert.equal(events(f.task.id, 'held').length, 0);
        assert.equal(events(f.task.id, 'rework_wait_started').length, 0);
        assert.equal(events(f.task.id, 'rework_reopened')[0].presence, presence);
      });
    }
  }

  for (const presence of ['archived', 'missing'] as const) {
    it(`allows CLI rework on rework with an ${presence} executor, appending the latest verdict and reopening in place`, async () => {
      const f = fixture();
      requestAgentReleases(f.task.id, [{ agentId: 'old-agent', role: 'executor' }]);
      requestChanges(f.task.id, "Previous review findings", (zhCNPart("nativeSessions.kept.leader", 9, 11) + "Demo text"));
      f.config.supervisors.reopen = 'project-leader';
      saveConfig(f.config);
      const checked: string[] = [];
      await runKanban(['rework', String(f.task.id), '--reason', (zhCNPart("cardDrawer.handoff.title", 0, 2) + zhCNPart("boardView.cmd.ruling", 1, 3) + zhCN("common.colon") + zhCNPart("boardView.done.conflictTitle", 0, 3) + "home.tsx " + zhCN("labels.badge.conflictWord"))],
        { PASEO_AGENT_ID: 'project-leader' },
        { agentPresence: id => { checked.push(id); return presence; } });
      assert.deepEqual(checked, ['old-agent']);
      assert.equal(getTask(f.task.id).status, 'ready');
      assert.equal(getTask(f.task.id).review_round, 1);
      assert.equal(getTask(f.task.id).hold_reason, null);
      await f.tick();
      assert.equal(getTask(f.task.id).status, 'running');
      assert.equal(f.opened[0].cwd, f.cwd);
      assert.match(f.opened[0].prompt!, new RegExp(localePattern(zhCNPart("flow.brief.thisRound", 3, 11)) + "\\n" + localePattern(zhCNPart("cardDrawer.handoff.title", 0, 2)) + localePattern(zhCNPart("boardView.cmd.ruling", 1, 3)) + zhCN("common.colon") + localePattern(zhCNPart("boardView.done.conflictTitle", 0, 3)) + "home.tsx " + zhCN("labels.badge.conflictWord")));
      assert.equal(events(f.task.id, 'held').length, 0);
      assert.equal(events(f.task.id, 'rework_reopened')[0].oldAgentId, 'old-agent');
    });
  }

  it('does not classify an unconfirmed archive as quota or start a duplicate executor', async () => {
    const f = fixture();
    requestAgentReleases(f.task.id, [{ agentId: 'old-agent', role: 'executor' }]);
    requestChanges(f.task.id, "Current fix", "Add tests");
    f.launcher.inspectAgent = async () => ({ archived: false });
    await f.tick({ agentState: () => 'alive' });
    assert.equal(getTask(f.task.id).status, 'rework');
    assert.deepEqual(f.opened, []);
    assert.deepEqual(f.sent, []);
    assert.equal(events(f.task.id, 'held')[0].kind, 'transient');
    assert.match(events(f.task.id, 'held')[0].reason, new RegExp(localePattern(zhCNPart("reworkReassign.agentRetired", 10, 15))));
    await f.tick({ agentState: () => 'alive' });
    assert.equal(events(f.task.id, 'held').length, 1);
  });

  it('classifies a missing original profile as capability rather than quota', async () => {
    const f = fixture();
    requestChanges(f.task.id, "Current fix", "Add tests");
    await f.tick({ agentState: () => 'alive', profiles: [candidate, reviewer, crossReviewer] });
    assert.equal(getTask(f.task.id).status, 'rework');
    assert.deepEqual(f.opened, []);
    assert.equal(events(f.task.id, 'held')[0].kind, 'capability');
    assert.match(events(f.task.id, 'held')[0].reason, new RegExp(localePattern(zhCNPart("reworkReassign.profileGone", 0, 8))));
  });

  it('recovers the original profile from the executor run when its task column is absent', async () => {
    const f = fixture();
    getDb().prepare('UPDATE tasks SET executor_profile = NULL, profile_override = ? WHERE id = ?').run(candidate.name, f.task.id);
    requestChanges(f.task.id, "Current fix", "Add tests");
    await f.tick();
    assert.equal(getTask(f.task.id).executor_profile, original.name);
    assert.equal(events(f.task.id, 'rework_reopened')[0].oldProfile, original.name);
    assert.equal(f.opened[0].cwd, f.cwd);
  });

  it('uses an available same-role candidate and reserves a reviewer from a different family', async () => {
    const f = fixture();
    requestChanges(f.task.id, "Current fix", "Add tests");
    await f.tick({ pools: pools(['cursor']) });
    assert.equal(getTask(f.task.id).executor_profile, candidate.name);
    assert.equal(getTask(f.task.id).executor_family, candidate.family);
    completeTask(f.task.id, 'executor', "Fixed", null);
    await f.tick();
    assert.equal(f.opened[1].config.provider, `${crossReviewer.provider}/${crossReviewer.model}`);
  });

  it('retries quota holds and failed creates without duplicating the brief or counting unsuccessful reopens', async () => {
    const f = fixture();
    requestChanges(f.task.id, "Current fix", "Add tests");
    await f.tick({ pools: pools(['cursor', 'claude-max', 'supergrok']) });
    assert.equal(getTask(f.task.id).status, 'ready');
    assert.equal(getTask(f.task.id).executor_agent_id, null);
    assert.equal(f.opened.length, 0);
    assert.equal(events(f.task.id, 'rework_reopened').length, 0);
    const brief = getTask(f.task.id).brief;
    const create = f.launcher.create;
    f.launcher.create = async () => { throw new Error('create failed'); };
    await f.tick();
    assert.equal(getTask(f.task.id).status, 'ready');
    assert.equal(events(f.task.id, 'rework_reopened').length, 0);
    closeDb();
    f.launcher.create = create;
    await f.tick();
    assert.equal(f.opened.length, 1);
    assert.equal(getTask(f.task.id).brief, brief);
    assert.equal(events(f.task.id, 'rework_reopen_pending').length, 1);
    assert.equal(events(f.task.id, 'rework_reopened').length, 1);
  });

  it('does not reopen a living executor or a project with automatic execution disabled', async () => {
    const f = fixture();
    requestChanges(f.task.id, "Current fix", "Add tests");
    f.config.autoStart.reopen = false;
    await f.tick();
    assert.equal(getTask(f.task.id).status, 'rework');
    f.config.autoStart.reopen = true;
    await f.tick({ agentState: () => 'alive' });
    assert.deepEqual(f.sent, ['old-agent']);
    assert.deepEqual(f.opened, []);
    assert.equal(events(f.task.id, 'rework_reopened').length, 0);
  });

  it('does not reopen during API outages, or when Paseo says a locally missing agent is alive', async () => {
    const f = fixture();
    requestChanges(f.task.id, "Current fix", "Add tests");
    f.launcher.inspectAgent = async () => { throw new Error('Paseo reconnecting'); };
    await f.tick({ agentState: () => 'missing' });
    assert.equal(getTask(f.task.id).status, 'rework');
    assert.deepEqual(f.opened, []);
    f.launcher.inspectAgent = async () => ({ archived: false });
    await f.tick({ agentState: () => 'missing' });
    assert.deepEqual(f.sent, ['old-agent']);
    assert.deepEqual(f.opened, []);
  });

  for (const result of ['missing', 'alive', 'unknown']) {
    it(`leaves a concurrent leader decision intact when the old executor lookup returns ${result}`, async () => {
      const f = fixture();
      requestChanges(f.task.id, "Current fix", "Add tests");
      f.launcher.inspectAgent = async () => {
        getDb().prepare("UPDATE tasks SET status = 'acceptance', updated_at = 'later' WHERE id = ?").run(f.task.id);
        if (result === 'unknown') throw new Error('Paseo reconnecting');
        return result === 'missing' ? null : { archived: false };
      };
      await f.tick({ agentState: () => 'missing' });
      assert.equal(getTask(f.task.id).status, 'acceptance');
      assert.equal(getTask(f.task.id).hold_reason, null);
      assert.deepEqual(f.opened, []);
      assert.deepEqual(f.sent, []);
      assert.equal(events(f.task.id, 'rework_reopen_queued').length, 0);
    });
  }

  it('preserves standalone-review and third-round safeguards', async () => {
    const f = fixture();
    getDb().prepare('UPDATE tasks SET review_round = 2 WHERE id = ?').run(f.task.id);
    requestChanges(f.task.id, "Third round", (zhCNPart("blocked.kind.needsHuman", 0, 2) + zhCNPart("boardView.cmd.ruling", 1, 3)));
    await f.tick();
    assert.equal(getTask(f.task.id).status, 'blocked');
    const standalone = createTask({ project: 'reopen', title: "Independent review", role: 'reviewer', workspacePath: f.cwd });
    getDb().prepare("UPDATE tasks SET status = 'rework' WHERE id = ?").run(standalone.id);
    await f.tick();
    assert.equal(getTask(standalone.id).status, 'acceptance');
    assert.deepEqual(f.opened, []);
  });
});
