/// <reference types="node" />
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { closeDb, getDb } from '../server/db';
import { appendEvent, createTask } from '../server/store';
import { waitingCardHours } from '../server/waiting-metrics';

const lo = new Date('2026-10-01T00:00:00.000Z');
const at = (hours: number) => new Date(lo.getTime() + hours * 3_600_000).toISOString();
const bounds = { window_start: at(0), window_end: at(4) };
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'test-0103-metrics-'));
  process.env.KANBAN_DATA_DIR = dir;
});
afterEach(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

function card(project: string) {
  const task = createTask({ project, title: "Metrics fixture", role: 'executor', workspacePath: dir });
  getDb().prepare("UPDATE events SET at = ? WHERE task_id = ? AND kind = 'created'").run(at(-2), task.id);
  return task;
}

/** Execute the deliverable SQL itself, so next Monday's documented query has regression coverage. */
function sql(name: string): string {
  const design = readFileSync(new URL('../docs/WORKFLOW-METRICS.md', import.meta.url), 'utf8');
  const marker = design.match(new RegExp(`^-- ${name}\n`, "m"))?.[0];
  assert.ok(marker);
  return design.split(marker)[1].split('```')[0].trim();
}

describe('weekly event metrics', () => {
  it('clips waiting intervals to the window, includes old cards and open intervals, and sums reentries', () => {
    const first = card('A');
    appendEvent(first.id, 'status', 'ready', 'waiting', 'test', {}, at(-2));
    appendEvent(first.id, 'wake_placeholder', null, 'waiting', 'test', {}, at(0.5));
    appendEvent(first.id, 'status', 'waiting', 'ready', 'test', {}, at(1));
    appendEvent(first.id, 'status', 'ready', 'waiting', 'test', {}, at(2));
    appendEvent(first.id, 'held', 'waiting', 'waiting', 'test', {}, at(3));
    appendEvent(first.id, 'status', 'waiting', 'running', 'test', {}, at(5));
    const second = card('A');
    appendEvent(second.id, 'status', 'ready', 'waiting', 'test', {}, at(3));
    // Unfinished waiting contributes one hour at the end of the window.
    const third = card('B');
    appendEvent(third.id, 'status', 'ready', 'waiting', 'test', {}, at(-1));
    appendEvent(third.id, 'status', 'waiting', 'ready', 'test', {}, at(0.5));
    const outside = card('B');
    appendEvent(outside.id, 'status', 'ready', 'waiting', 'test', {}, at(5));
    const rows = waitingCardHours(getDb(), bounds.window_start, bounds.window_end)
      .map(row => ({ project: row.project, waiting_card_hours: Math.round(row.waitingCardHours * 1e6) / 1e6 }));
    assert.deepEqual(rows.map(row => ({ ...row })), [
      { project: 'A', waiting_card_hours: 4 },
      { project: 'B', waiting_card_hours: 0.5 },
    ]);
  });

  it('counts only successful prerequisite wakes and executor reopens in the UTC half-open window', () => {
    const task = card('A');
    for (const [kind, hours] of [
      ['wake_prerequisite', -1], ['wake_prerequisite', 0], ['wake_prerequisite', 2], ['wake_prerequisite', 4],
      ['rework_reopened', 1], ['rework_reopened', 4], ['rework_reopen_pending', 2],
      ['rework_reopen_queued', 2], ['rework_reassigned', 2], ['wake_acceptance', 2], ['resumed', 2], ['started', 2],
    ] as const) appendEvent(task.id, kind, null, null, 'test', {}, at(hours));
    assert.deepEqual(getDb().prepare(sql('wake_and_reopen_counts')).all(bounds).map(row => ({ ...row })), [
      { project: 'A', prerequisite_wakes: 2, automatic_executor_reopens: 1 },
    ]);
    assert.deepEqual(getDb().prepare(sql('wake_and_reopen_counts')).all({ window_start: at(6), window_end: at(7) }), []);
  });
});
