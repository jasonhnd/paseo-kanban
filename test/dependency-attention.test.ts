/// <reference types="node" />
import { zhCNPart, localePattern } from "./helpers/locale";
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { setAgentAliveCheck, resetAgentAliveCheck } from '../server/alive';
import { cardMark } from '../server/card-ref';
import { saveConfig, type KanbanConfig } from '../server/config';
import { closeDb, getDb } from '../server/db';
import { PREREQUISITE_IDLE_MS, scanPrerequisiteAttention, waitingSuccessors } from '../server/dependency-attention';
import { runTick } from "./helpers/compat-schedule";
import { addComment, appendEvent, createTask } from '../server/store';

const start = new Date('2026-10-02T00:00:00.000Z');
let dir: string;
let config: KanbanConfig;
let sent: Array<{ id: string; text: string }>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'test-0103-attention-'));
  process.env.KANBAN_DATA_DIR = dir;
  process.env.KANBAN_AGENTS_DIR = join(dir, 'agents');
  mkdirSync(process.env.KANBAN_AGENTS_DIR);
  config = { autoStart: { chain: false }, supervisors: { chain: 'project-leader' }, supervisorAgentId: 'kanban-leader', concurrency: { global: 10, roles: {}, pools: {} } };
  saveConfig(config);
  setAgentAliveCheck(id => id === 'project-leader' || id === 'kanban-leader' || id === 'creator');
  sent = [];
});

afterEach(() => {
  resetAgentAliveCheck();
  closeDb();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.KANBAN_AGENTS_DIR;
});

function fixture(status = 'acceptance') {
  const parent = createTask({ project: 'chain', title: "Parent", role: 'executor', workspacePath: dir, createdByAgent: 'creator' });
  getDb().prepare('UPDATE tasks SET status = ? WHERE id = ?').run(status, parent.id);
  appendEvent(parent.id, 'fixture_entry', 'reviewing', status, 'test', {}, start.toISOString());
  const child = createTask({ project: 'chain', title: "Child", role: 'executor', workspacePath: dir, parentIds: [parent.id] });
  return { parent, child };
}

const send = async (id: string, text: string) => { sent.push({ id, text }); };
const tick = (elapsed: number, extra: Partial<Parameters<typeof scanPrerequisiteAttention>[0]> = {}) =>
  scanPrerequisiteAttention({ now: new Date(start.getTime() + elapsed), config, send, ...extra });
const count = (kind: string) => (getDb().prepare('SELECT count(*) AS n FROM events WHERE kind = ?').get(kind) as { n: number }).n;

describe('prerequisites delaying waiting successors', () => {
  for (const status of ['acceptance', 'rework']) {
    it(`wakes only after 30 minutes in ${status}, once per state entry`, async () => {
      const { parent, child } = fixture(status);
      await tick(PREREQUISITE_IDLE_MS - 1);
      await tick(PREREQUISITE_IDLE_MS);
      assert.equal(sent.length, 0);
      await tick(PREREQUISITE_IDLE_MS + 1);
      assert.equal(sent.length, 1);
      assert.equal(sent[0].id, 'project-leader');
      assert.match(sent[0].text, new RegExp(localePattern(zhCNPart("dependencyAttention.wake.idle", 22, 26)) + "1 " + localePattern(zhCNPart("dependencyAttention.wake.idle", 34, 38))));
      assert.ok(sent[0].text.includes(cardMark(child.id)));
      addComment(parent.id, 'test', (zhCNPart("tools.emptyComment", 0, 3) + "Demo text"));
      appendEvent(parent.id, 'wake_acceptance', null, status, 'scheduler', {}, new Date(start.getTime() + PREREQUISITE_IDLE_MS * 2).toISOString());
      appendEvent(parent.id, 'held', status, status, 'scheduler', {}, new Date(start.getTime() + PREREQUISITE_IDLE_MS * 2).toISOString());
      await tick(PREREQUISITE_IDLE_MS * 3);
      assert.equal(count('wake_prerequisite'), 1);
      const other = status === 'acceptance' ? 'rework' : 'acceptance';
      getDb().prepare('UPDATE tasks SET status = ? WHERE id = ?').run(other, parent.id);
      appendEvent(parent.id, 'fixture_entry', status, other, 'test', {}, new Date(start.getTime() + PREREQUISITE_IDLE_MS * 3).toISOString());
      await tick(PREREQUISITE_IDLE_MS * 4 + 1);
      assert.equal(count('wake_prerequisite'), 2);
      getDb().prepare('UPDATE tasks SET status = ? WHERE id = ?').run(status, parent.id);
      appendEvent(parent.id, 'fixture_entry', other, status, 'test', {}, new Date(start.getTime() + PREREQUISITE_IDLE_MS * 4 + 1).toISOString());
      await tick(PREREQUISITE_IDLE_MS * 6);
      assert.equal(count('wake_prerequisite'), 3);
    });
  }

  it('counts transitive waiting cards once across a diamond and excludes finished cards', async () => {
    const { parent, child } = fixture();
    const right = createTask({ project: 'chain', title: "Right side", role: 'executor', workspacePath: dir, parentIds: [parent.id] });
    const bottom = createTask({ project: 'chain', title: "Summary", role: 'executor', workspacePath: dir, parentIds: [child.id, right.id] });
    const done = createTask({ project: 'chain', title: "Sample text", role: 'executor', workspacePath: dir, parentIds: [parent.id] });
    getDb().prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(done.id);
    assert.deepEqual(waitingSuccessors(parent.id), [child.id, right.id, bottom.id]);
    await tick(PREREQUISITE_IDLE_MS + 1);
    assert.match(sent[0].text, new RegExp(localePattern(zhCNPart("dependencyAttention.wake.idle", 22, 26)) + "3 " + localePattern(zhCNPart("dependencyAttention.wake.idle", 34, 38))));
    for (const id of [child.id, right.id, bottom.id]) assert.ok(sent[0].text.includes(cardMark(id)));
    const data = JSON.parse((getDb().prepare("SELECT data_json FROM events WHERE kind = 'wake_prerequisite'").get() as { data_json: string }).data_json);
    assert.equal(data.waitingCount, 3);
    assert.deepEqual(data.waitingTaskIds, [child.id, right.id, bottom.id]);
  });

  it('does not wake other states or parents with no waiting descendants', async () => {
    for (const status of ['ready', 'running', 'reviewing', 'blocked', 'done', 'archived']) fixture(status);
    const { child } = fixture();
    getDb().prepare("UPDATE tasks SET status = 'ready' WHERE id = ?").run(child.id);
    await tick(PREREQUISITE_IDLE_MS * 4);
    assert.equal(sent.length, 0);
  });

  it('starts a fresh absence clock after either assigned agent was alive', async () => {
    const { parent } = fixture();
    getDb().prepare("UPDATE tasks SET agent_id = 'reviewer', executor_agent_id = 'executor' WHERE id = ?").run(parent.id);
    await tick(PREREQUISITE_IDLE_MS * 2, { agentState: id => id === 'executor' ? 'alive' : 'archived' });
    assert.equal(sent.length, 0);
    await tick(PREREQUISITE_IDLE_MS * 3, { agentState: () => 'archived' });
    await tick(PREREQUISITE_IDLE_MS * 4, { agentState: () => 'archived' });
    assert.equal(sent.length, 0);
    await tick(PREREQUISITE_IDLE_MS * 4 + 1, { agentState: () => 'archived' });
    assert.equal(sent.length, 1);
  });

  it('uses archive time rather than an old acceptance entry as the absence boundary', async () => {
    const { parent } = fixture();
    getDb().prepare("UPDATE tasks SET executor_agent_id = 'executor' WHERE id = ?").run(parent.id);
    const bucket = join(process.env.KANBAN_AGENTS_DIR!, 'bucket');
    mkdirSync(bucket);
    writeFileSync(join(bucket, 'executor.json'), JSON.stringify({ id: 'executor', archivedAt: new Date(start.getTime() + PREREQUISITE_IDLE_MS).toISOString() }));
    await tick(PREREQUISITE_IDLE_MS * 2, { agentState: () => 'archived' });
    assert.equal(sent.length, 0);
    await tick(PREREQUISITE_IDLE_MS * 2 + 1, { agentState: () => 'archived' });
    assert.equal(sent.length, 1);
  });

  it('does not treat unreadable records or API failure as absence', async () => {
    const { parent } = fixture();
    getDb().prepare("UPDATE tasks SET executor_agent_id = 'executor' WHERE id = ?").run(parent.id);
    await tick(PREREQUISITE_IDLE_MS * 2);
    await tick(PREREQUISITE_IDLE_MS * 4, { agentState: () => 'missing', inspectAgent: async () => { throw new Error('offline'); } });
    assert.equal(sent.length, 0);
  });

  it('retries failed delivery, survives a database reopen, and falls back to Kanban leader', async () => {
    fixture();
    await tick(PREREQUISITE_IDLE_MS + 1, { send: async () => { throw new Error('send failed'); } });
    assert.equal(count('wake_prerequisite'), 0);
    closeDb();
    config.supervisors = {};
    saveConfig(config);
    await tick(PREREQUISITE_IDLE_MS + 2);
    assert.equal(sent[0].id, 'kanban-leader');
    closeDb();
    await tick(PREREQUISITE_IDLE_MS * 4);
    assert.equal(sent.length, 1);
  });

  it('does not count an unavailable recipient as a wake and retries when registered', async () => {
    fixture();
    setAgentAliveCheck(() => false);
    await tick(PREREQUISITE_IDLE_MS * 2);
    assert.equal(count('wake_prerequisite'), 0);
    setAgentAliveCheck(() => true);
    await tick(PREREQUISITE_IDLE_MS * 3);
    assert.equal(count('wake_prerequisite'), 1);
  });

  it('skips a later candidate that left acceptance while an earlier wake was being delivered', async () => {
    fixture();
    const second = fixture();
    getDb().prepare("UPDATE events SET at = ? WHERE task_id = ? AND kind = 'created'")
      .run(new Date(start.getTime() - PREREQUISITE_IDLE_MS * 2).toISOString(), second.parent.id);
    await tick(PREREQUISITE_IDLE_MS * 2, { send: async (id, text) => {
      sent.push({ id, text });
      getDb().prepare("UPDATE tasks SET status = 'ready' WHERE id = ?").run(second.parent.id);
    } });
    assert.equal(sent.length, 1);
    assert.equal(count('wake_prerequisite'), 1);
  });

  it('runs from the scheduler even when automatic execution is disabled', async () => {
    const { parent } = fixture();
    await runTick({ now: new Date(start.getTime() + PREREQUISITE_IDLE_MS + 1), config, profiles: [], matrix: { state: 'missing' }, send,
      launcher: { async create() { assert.fail('must not dispatch'); }, async send() {} } });
    assert.equal(count('wake_prerequisite'), 1);
    assert.ok(sent[0].text.includes(cardMark(parent.id)));
  });
});
