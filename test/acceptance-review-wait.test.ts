import { seedLegacyLinkedReview } from "./helpers/legacy-review";
/// <reference types="node" />
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, it } from "node:test";
import { scanAcceptance, resetAcceptanceBackoffForTests } from "../server/acceptance-watch";
import { loadAcceptanceReviewWaits } from "../server/acceptance-review-wait";
import { boardSnapshot } from "../server/board-cards";
import { cardMark } from "../server/card-ref";
import { setWakeSender } from "../server/bus";
import { saveConfig, type KanbanConfig } from "../server/config";
import { closeDb, getDb } from "../server/db";
import { scanPrerequisiteAttention } from "../server/dependency-attention";
import { LEADER_UNRESPONSIVE_TAG } from "../server/leader-activity";
import { addComment, appendEvent, blockTask, createTask, getTask } from "../server/store";
import { approveTask, requestChanges } from "../server/flow";
import { notifyAcceptance, resetAgentAliveCheck, setAgentAliveCheck } from "../server/wake";
import { cardSchema } from "../shared/rpc";
import { setLanguage } from "../shared/i18n";
import { round, takePerfSummary } from "../server/perf";

const dir = mkdtempSync(join(tmpdir(), "acceptance-review-wait-"));
process.env.KANBAN_DATA_DIR = dir;
process.env.KANBAN_AGENTS_DIR = join(dir, "agents");
mkdirSync(process.env.KANBAN_AGENTS_DIR);
const decisionsPath = join(dir, "decisions.json");
const epoch = Date.parse("2026-10-02T03:00:00Z");
const stamp = (minutes: number) => new Date(epoch + minutes * 60_000).toISOString();
const config: KanbanConfig = { autoStart: { demo: false }, supervisors: { demo: "leader" }, supervisorAgentId: null,
  concurrency: { global: 10, roles: {}, pools: {} } };
const sent: Array<{ id: string; text: string }> = [];
const count = (task: number, kind: string) => (getDb().prepare("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND kind = ?").get(task, kind) as { n: number }).n;
const marked = (id: number) => JSON.parse(getTask(id).tags ?? "[]").includes(LEADER_UNRESPONSIVE_TAG);

beforeEach(() => {
  getDb().exec("DELETE FROM events; DELETE FROM links; DELETE FROM runs; DELETE FROM tasks");
  saveConfig(config);
  writeFileSync(decisionsPath, "[]");
  resetAcceptanceBackoffForTests();
  setAgentAliveCheck(() => true);
  sent.length = 0;
  setLanguage("en");
  setWakeSender((id, text) => { sent.push({ id, text }); });
});
after(() => { setWakeSender(() => {}); resetAgentAliveCheck(); closeDb(); rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const target = createTask({ project: "demo", title: "anonymous batch delivery", role: "batch", workspacePath: dir, actor: "scheduler" });
  getDb().prepare("UPDATE tasks SET status = 'acceptance', created_at = ?, updated_at = ? WHERE id = ?").run(stamp(-60), stamp(0), target.id);
  appendEvent(target.id, "complete", "running", "acceptance", "batch", {}, stamp(0));
  const review = createTask({ project: "demo", title: "anonymous independent review", role: "reviewer", reviewOf: target.id, workspacePath: dir, actor: "supervisor" });
  getDb().prepare("UPDATE tasks SET created_at = ?, updated_at = ?, hold_reason = ? WHERE id = ?").run(stamp(1), stamp(1), "synthetic window 71%", review.id);
  getDb().prepare("UPDATE events SET at = ? WHERE task_id = ?").run(stamp(1), review.id);
  appendEvent(review.id, "held", "ready", "ready", "scheduler", {
    kind: "quota", quotaWait: true, reason: "synthetic window 71%",
    quota: { state: "fresh", pool: "anonymous", dispatchable: false, usedPct: 71, generatedAt: stamp(1) },
  }, stamp(1));
  return { target: getTask(target.id), review: getTask(review.id) };
}
const scan = (minutes: number) => scanAcceptance({ now: new Date(stamp(minutes)), config, decisionsPath });
const prerequisites = (minutes: number) => scanPrerequisiteAttention({ now: new Date(stamp(minutes)), config,
  agentState: () => "archived", send: async (id, text) => { sent.push({ id, text }); } });

it("does not chase an acceptance batch waiting for its linked quota-held reviewer after 30 minutes", async () => {
  const { target } = fixture();
  await scan(32);
  assert.equal(sent.length, 0);
  assert.equal(count(target.id, "wake_acceptance_repeat"), 0);
});
it("does not mark the same normal review wait leader-unresponsive after two hours or restart", async () => {
  const { target } = fixture();
  await scan(121);
  closeDb(); resetAcceptanceBackoffForTests();
  await scan(180);
  assert.equal(marked(target.id), false);
  assert.equal(count(target.id, "leader_unresponsive"), 0);
  assert.equal(sent.length, 0);
});
it("does not mistake normal linked review waiting for an absent prerequisite agent delaying three cards", async () => {
  const { target } = fixture();
  const left = createTask({ project: "demo", title: "left", role: "batch", parentIds: [target.id], actor: "scheduler" });
  const right = createTask({ project: "demo", title: "right", role: "batch", parentIds: [target.id], actor: "scheduler" });
  createTask({ project: "demo", title: "bottom", role: "batch", parentIds: [left.id, right.id], actor: "scheduler" });
  await prerequisites(32);
  await prerequisites(121);
  assert.equal(sent.length, 0);
  assert.equal(count(target.id, "wake_prerequisite"), 0);
});

function activeReview(id: number, status = 'reviewing') {
  getDb().prepare("UPDATE tasks SET status = ?, agent_id = ?, hold_reason = NULL WHERE id = ?").run(status, `review-${id}`, id);
  appendEvent(id, 'started', 'ready', status, 'scheduler', {}, stamp(2));
  getDb().prepare("INSERT INTO runs(task_id, agent_id, role, provider, model, family, started_at) VALUES (?, ?, 'reviewer', 'fixture', 'anonymous', 'anthropic', ?)")
    .run(id, `review-${id}`, stamp(2));
}
function endReview(id: number, status = 'archived', minutes = 40) {
  const previous = getTask(id).status;
  getDb().prepare("UPDATE tasks SET status = ? WHERE id = ?").run(status, id);
  appendEvent(id, status, previous, status, 'reviewer', {}, stamp(minutes));
  getDb().prepare("UPDATE runs SET ended_at = ? WHERE task_id = ?").run(stamp(minutes), id);
}

for (const status of ['running', 'reviewing']) {
  it(`recognizes a live ${status} reviewer run and stops exempting an ended run`, async () => {
    const { target, review } = fixture(); activeReview(review.id, status);
    await scan(121); assert.equal(sent.length, 0);
    getDb().prepare("UPDATE runs SET ended_at = ? WHERE task_id = ?").run(stamp(122), review.id);
    await scan(123); assert.equal(sent.length, 0); assert.equal(marked(target.id), false);
    closeDb(); await scan(153); assert.equal(sent.length, 0);
    await scan(153.01); assert.equal(sent.length, 1); assert.equal(marked(target.id), false);
    await scan(243.01); assert.equal(marked(target.id), true);
  });
}
it("recognizes structural dependency waiting, but not a missing dependency or a cycle on its own target", async () => {
  const { target, review } = fixture();
  const parent = createTask({ project: 'demo', title: 'prerequisite', role: 'reader', actor: 'scheduler' });
  getDb().prepare("UPDATE tasks SET status = 'waiting', hold_reason = NULL WHERE id = ?").run(review.id);
  getDb().prepare("INSERT INTO links(task_id, parent_id) VALUES (?, ?)").run(review.id, parent.id);
  await scan(121); assert.equal(sent.length, 0);
  getDb().prepare("UPDATE links SET parent_id = ? WHERE task_id = ?").run(target.id, review.id);
  await scan(122); assert.equal(sent.length, 0);
  await scan(152.01); assert.equal(sent.length, 1);
  getDb().prepare("DELETE FROM links WHERE task_id = ?").run(review.id);
  assert.equal(loadAcceptanceReviewWaits().has(target.id), false);
});
it("does not mask needs_human deeper in the review's dependency chain or a cycle", async () => {
  const { target, review } = fixture();
  const root = createTask({ project: 'demo', title: 'root prerequisite', role: 'reader', actor: 'scheduler' });
  const parent = createTask({ project: 'demo', title: 'middle prerequisite', role: 'reader', parentIds: [root.id], actor: 'scheduler' });
  getDb().prepare("UPDATE tasks SET status = 'waiting', hold_reason = NULL WHERE id = ?").run(review.id);
  getDb().prepare("INSERT INTO links(task_id, parent_id) VALUES (?, ?)").run(review.id, parent.id);
  assert.equal(loadAcceptanceReviewWaits().has(target.id), true);
  getDb().prepare("UPDATE tasks SET status = 'blocked', blocked_kind = 'needs_human' WHERE id = ?").run(root.id);
  assert.equal(loadAcceptanceReviewWaits().has(target.id), false);
  getDb().prepare("UPDATE tasks SET status = 'ready', blocked_kind = NULL WHERE id = ?").run(root.id);
  getDb().prepare("INSERT INTO links(task_id, parent_id) VALUES (?, ?)").run(root.id, review.id);
  assert.equal(loadAcceptanceReviewWaits().has(target.id), false);
  await scan(121); assert.equal(count(target.id, 'wake_acceptance_repeat'), 1);
});
it("keeps waiting when one of multiple linked reviews is archived, then resumes when the last one ends", async () => {
  const { target, review } = fixture();
  const second = seedLegacyLinkedReview({ project: 'demo', title: 'second review', role: 'reviewer', reviewOf: target.id, actor: 'scheduler' });
  activeReview(second.id);
  await scan(32); endReview(review.id);
  await scan(121); assert.equal(sent.length, 0);
  assert.equal(count(target.id, 'acceptance_review_wait_started'), 1);
  endReview(second.id, 'done', 122); await scan(123);
  assert.equal(sent.length, 0); assert.equal(count(target.id, 'acceptance_review_wait_ended'), 1);
  await scan(153.01); assert.equal(sent.length, 1);
});
for (const status of ['done', 'archived', 'acceptance', 'draft', 'triage', 'in_review', 'rework', 'blocked']) {
  it(`does not permanently exempt a ${status} review`, async () => {
    const { target, review } = fixture(); await scan(32);
    endReview(review.id, status);
    await scan(121);
    assert.equal(count(target.id, 'wake_acceptance_repeat'), 0);
    assert.equal(marked(target.id), false);
    assert.equal(boardSnapshot('demo').tasks.find(card => card.id === target.id)!.badge, 'Waiting for acceptance');
    await scan(151.01);
    assert.equal(count(target.id, 'wake_acceptance_repeat'), 1);
    assert.equal(marked(target.id), false);
    await scan(241.01);
    assert.equal(marked(target.id), true);
  });
}
for (const mutate of ['project', 'role', 'target', 'comment-only', 'quota-text-only', 'superseded-hold', 'old-held', 'terminal-failure', 'decision', 'quota-false', 'invalid-json', 'missing-creation', 'no-run', 'wrong-run']) {
  it(`rejects ${mutate} as normal review-wait evidence`, async () => {
    const { target, review } = fixture();
    if (mutate === 'project') getDb().prepare("UPDATE tasks SET project = 'other' WHERE id = ?").run(review.id);
    if (mutate === 'role') getDb().prepare("UPDATE tasks SET role = 'batch' WHERE id = ?").run(review.id);
    if (mutate === 'target') getDb().prepare("UPDATE tasks SET review_of = ? WHERE id = ?").run(review.id, review.id);
    if (mutate === 'comment-only') {
      getDb().prepare("UPDATE tasks SET review_of = NULL WHERE id = ?").run(review.id);
      addComment(target.id, 'leader', `already ruled; review ${cardMark(review.id)} quota 71%`);
      appendEvent(target.id, 'comment', null, 'acceptance', 'leader', {}, stamp(1));
    }
    if (mutate === 'quota-text-only') getDb().prepare("DELETE FROM events WHERE task_id = ? AND kind = 'held'").run(review.id);
    if (mutate === 'superseded-hold') getDb().prepare("UPDATE tasks SET hold_reason = 'requires authorization' WHERE id = ?").run(review.id);
    if (mutate === 'old-held') appendEvent(review.id, 'reopened', 'blocked', 'ready', 'scheduler', {}, stamp(2));
    if (mutate === 'terminal-failure') blockTask(review.id, 'needs_human', 'fixture terminal failure', 'reviewer');
    if (mutate === 'decision') getDb().prepare("UPDATE tasks SET wait_decision = 'fixture-decision' WHERE id = ?").run(review.id);
    if (mutate === 'quota-false') getDb().prepare("UPDATE events SET data_json = json_set(data_json, '$.quotaWait', json('false')) WHERE task_id = ? AND kind = 'held'").run(review.id);
    if (mutate === 'invalid-json') getDb().prepare("UPDATE events SET data_json = '{' WHERE task_id = ? AND kind = 'held'").run(review.id);
    if (mutate === 'missing-creation') getDb().prepare("DELETE FROM events WHERE task_id = ? AND kind = 'created'").run(review.id);
    if (mutate === 'no-run') getDb().prepare("UPDATE tasks SET status = 'reviewing', agent_id = 'fixture-reviewer' WHERE id = ?").run(review.id);
    if (mutate === 'wrong-run') { activeReview(review.id); getDb().prepare("UPDATE runs SET agent_id = 'another-agent' WHERE task_id = ?").run(review.id); }
    await scan(121);
    assert.equal(count(target.id, 'wake_acceptance_repeat'), 1);
    assert.equal(marked(target.id), true);
    assert.deepEqual(loadAcceptanceReviewWaits().get(target.id), undefined);
  });
}
it("never lets evidence from an older acceptance round swallow a new submission", async () => {
  const { target } = fixture(); await scan(32);
  appendEvent(target.id, 'rejected', 'acceptance', 'rework', 'supervisor', {}, stamp(33));
  appendEvent(target.id, 'complete', 'running', 'acceptance', 'batch', {}, stamp(34));
  closeDb(); resetAcceptanceBackoffForTests();
  await scan(65);
  assert.equal(count(target.id, 'wake_acceptance_repeat'), 1);
  assert.equal(loadAcceptanceReviewWaits().has(target.id), false);
});
it("projects an old false marker away without writing on a board read, then clears only that target once", async () => {
  const { target, review } = fixture();
  getDb().prepare("UPDATE tasks SET tags = ?, unattended_at = ? WHERE id = ?").run(JSON.stringify(['keep', LEADER_UNRESPONSIVE_TAG]), stamp(1), target.id);
  const eventsBefore = count(target.id, 'leader_responsive');
  const card = cardSchema.parse(boardSnapshot('demo').tasks.find(card => card.id === target.id));
  assert.equal(card.badge, 'Ruling recorded, awaiting review');
  assert.match(card.nextStep!, /quota queue/); assert.ok(card.nextStep!.includes(cardMark(review.id)));
  assert.equal(card.leaderUnresponsive, false); assert.equal(card.unattended, false);
  assert.equal(count(target.id, 'leader_responsive'), eventsBefore); assert.equal(marked(target.id), true);
  await scan(121); await scan(180);
  assert.equal(count(target.id, 'leader_responsive'), 1);
  assert.equal(count(target.id, 'acceptance_review_wait_started'), 1);
  assert.deepEqual(JSON.parse(getTask(target.id).tags!), ['keep']);
  setLanguage('en');
  const en = boardSnapshot('demo').tasks.find(card => card.id === target.id)!;
  assert.equal(en.badge, 'Ruling recorded, awaiting review'); assert.match(en.nextStep!, /quota queue/);
});
it("chases only due actionable cards in mixed project batches", async () => {
  const { target } = fixture();
  const actionable = createTask({ project: 'demo', title: 'unhandled batch', role: 'batch', actor: 'scheduler' });
  const young = createTask({ project: 'demo', title: 'young batch', role: 'batch', actor: 'scheduler' });
  const other = createTask({ project: 'other', title: 'other project', role: 'batch', actor: 'scheduler' });
  for (const card of [actionable, young, other]) {
    getDb().prepare("UPDATE tasks SET status = 'acceptance' WHERE id = ?").run(card.id);
    appendEvent(card.id, 'complete', 'running', 'acceptance', 'batch', {}, stamp(card.id === young.id ? 120 : 0));
  }
  await scan(121);
  assert.equal(sent.length, 1); assert.ok(sent[0].text.includes(cardMark(actionable.id)));
  for (const card of [target, young, other]) assert.ok(!sent[0].text.includes(cardMark(card.id)));
  const data = JSON.parse((getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'wake_acceptance_repeat'").get(actionable.id) as { data_json: string }).data_json);
  assert.deepEqual(data.cards, [cardMark(actionable.id)]);
  assert.equal(marked(target.id), false); assert.equal(marked(actionable.id), true);
});
it("preserves the needs_human review alarm and does not hide it behind a second valid review", async () => {
  const { target, review } = fixture(); await scan(32);
  const second = seedLegacyLinkedReview({ project: 'demo', title: 'another review', role: 'reviewer', reviewOf: target.id, actor: 'scheduler' });
  activeReview(second.id);
  blockTask(review.id, 'needs_human', 'fixture authorization needed', 'reviewer');
  assert.equal(sent.length, 1); assert.match(sent[0].text, /fixture authorization needed/);
  const blocked = boardSnapshot('demo').tasks.find(card => card.id === review.id)!;
  assert.equal(blocked.blockedKind, 'needs_human'); assert.equal(blocked.blockedReason, 'fixture authorization needed');
  assert.equal(loadAcceptanceReviewWaits().has(target.id), false);
  await scan(121); assert.equal(count(target.id, 'wake_acceptance_repeat'), 0);
  assert.equal(sent.length, 1, 'the real needs_human alarm remains delivered immediately');
  await scan(151.01); assert.equal(count(target.id, 'wake_acceptance_repeat'), 1);
});
it("preserves initial target delivery and the real approved review notification, then restores target reminders", async () => {
  const { target, review } = fixture();
  notifyAcceptance(target.id, false, decisionsPath);
  assert.equal(count(target.id, 'wake_acceptance'), 1); assert.equal(sent.length, 1);
  await scan(32); assert.equal(sent.length, 1);
  activeReview(review.id);
  await approveTask(review.id, 'fixture verified');
  assert.equal(count(review.id, 'wake_acceptance'), 1); assert.equal(sent.length, 2); assert.match(sent[1].text, /Review verdict: approved/);
  await scan(121); assert.equal(count(target.id, 'wake_acceptance_repeat'), 0);
  assert.equal(sent.length, 2, 'approval notification is not followed by an immediate stale repeat');
  await scan(151.01); assert.equal(count(target.id, 'wake_acceptance_repeat'), 1);
});
it("a real request_changes returns the target for rework without keeping the wait projection", async () => {
  const { target, review } = fixture(); await scan(32); activeReview(review.id);
  requestChanges(review.id, 'fixture fix needed', '', 'reviewer');
  assert.equal(getTask(target.id).status, 'rework'); assert.equal(getTask(review.id).status, 'done');
  assert.equal(loadAcceptanceReviewWaits().has(target.id), false);
  assert.match(boardSnapshot('demo').tasks.find(card => card.id === target.id)!.badge, /Rework/);
});
it("resets an exhausted old reminder cap after a valid wait ends, across restart", async () => {
  const { target, review } = fixture(); endReview(review.id, 'archived', 1);
  await scan(32); await scan(63); assert.equal(count(target.id, 'wake_acceptance_repeat'), 2);
  getDb().prepare("UPDATE tasks SET status = 'ready' WHERE id = ?").run(review.id);
  await scan(100); endReview(review.id, 'archived', 110);
  closeDb(); resetAcceptanceBackoffForTests(); await scan(121);
  assert.equal(count(target.id, 'wake_acceptance_repeat'), 2);
  assert.equal(count(target.id, 'acceptance_review_wait_ended'), 1);
  await scan(151); assert.equal(count(target.id, 'wake_acceptance_repeat'), 2);
  await scan(151.01); assert.equal(count(target.id, 'wake_acceptance_repeat'), 3);
  await scan(181.01); assert.equal(count(target.id, 'wake_acceptance_repeat'), 4);
  await scan(212); assert.equal(count(target.id, 'wake_acceptance_repeat'), 4);
});
it("restarts the prerequisite absence clock when a valid wait ends, not the original old delivery", async () => {
  const { target, review } = fixture();
  createTask({ project: 'demo', title: 'descendant', role: 'batch', parentIds: [target.id], actor: 'scheduler' });
  await prerequisites(32); endReview(review.id); await prerequisites(40);
  closeDb(); await prerequisites(70); assert.equal(sent.length, 0);
  await prerequisites(70.01); assert.equal(sent.length, 1);
  await prerequisites(121); assert.equal(count(target.id, 'wake_prerequisite'), 1);
});
it("deduplicates overlapping acceptance scans and does not record an obsolete round during send", async () => {
  const { target, review } = fixture(); endReview(review.id, 'archived', 1);
  let release!: () => void;
  setWakeSender(async () => { sent.push({ id: 'leader', text: 'pending' }); await new Promise<void>(resolve => { release = resolve; }); });
  const pending = scan(32);
  await new Promise(resolve => setImmediate(resolve));
  await scan(32); assert.equal(sent.length, 1);
  appendEvent(target.id, 'rejected', 'acceptance', 'rework', 'scheduler', {}, stamp(33));
  appendEvent(target.id, 'complete', 'running', 'acceptance', 'batch', {}, stamp(34));
  release(); await pending;
  assert.equal(count(target.id, 'wake_acceptance_repeat'), 0);
  setWakeSender((id, text) => { sent.push({ id, text }); });
  await scan(65); assert.equal(count(target.id, 'wake_acceptance_repeat'), 1);
});
it("rechecks linked review closure in a later project after an earlier asynchronous delivery", async () => {
  const earlier = createTask({ project: 'first', title: 'first due', role: 'batch', actor: 'scheduler' });
  getDb().prepare("UPDATE tasks SET status = 'acceptance' WHERE id = ?").run(earlier.id);
  appendEvent(earlier.id, 'complete', 'running', 'acceptance', 'batch', {}, stamp(0));
  const { target, review } = fixture();
  setWakeSender(async (id, text) => { sent.push({ id, text }); endReview(review.id); });
  await scanAcceptance({ now: new Date(stamp(121)), config: { ...config, supervisors: { demo: 'leader', first: 'leader' } }, decisionsPath });
  assert.equal(sent.length, 2);
  assert.equal(count(target.id, 'wake_acceptance_repeat'), 1);
});
it("refreshes prerequisite evidence after an earlier send closes a later review", async () => {
  const first = fixture(); endReview(first.review.id, 'archived', 1);
  const second = fixture();
  for (const { target } of [first, second]) createTask({ project: 'demo', title: 'descendant', role: 'batch', parentIds: [target.id], actor: 'scheduler' });
  await scanPrerequisiteAttention({ now: new Date(stamp(121)), config, agentState: () => 'archived',
    send: async (id, text) => { sent.push({ id, text }); endReview(second.review.id); } });
  assert.equal(sent.length, 2);
  assert.equal(count(second.target.id, 'wake_prerequisite'), 1);
});
it("rechecks a newly valid review after awaited agent inspection", async () => {
  const { target, review } = fixture(); endReview(review.id, 'archived', 1);
  getDb().prepare("UPDATE tasks SET executor_agent_id = 'fixture-executor' WHERE id = ?").run(target.id);
  createTask({ project: 'demo', title: 'descendant', role: 'batch', parentIds: [target.id], actor: 'scheduler' });
  await scanPrerequisiteAttention({ now: new Date(stamp(121)), config, agentState: () => 'archived',
    inspectAgent: async () => {
      getDb().prepare("UPDATE tasks SET status = 'ready' WHERE id = ?").run(review.id);
      return { archived: true };
    }, send: async (id, text) => { sent.push({ id, text }); } });
  assert.equal(sent.length, 0); assert.equal(count(target.id, 'wake_prerequisite'), 0);
  assert.equal(count(target.id, 'acceptance_review_wait_started'), 1);
});
it("deduplicates overlapping prerequisite scans and skips a target closed during send", async () => {
  const { target, review } = fixture(); endReview(review.id, 'archived', 1);
  createTask({ project: 'demo', title: 'descendant', role: 'batch', parentIds: [target.id], actor: 'scheduler' });
  let release!: () => void;
  const options = { now: new Date(stamp(121)), config, agentState: () => 'archived' as const,
    send: async () => { sent.push({ id: 'leader', text: 'pending' }); await new Promise<void>(resolve => { release = resolve; }); } };
  const pending = scanPrerequisiteAttention(options);
  await new Promise(resolve => setImmediate(resolve));
  await scanPrerequisiteAttention(options); assert.equal(sent.length, 1);
  getDb().prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(target.id);
  release(); await pending;
  assert.equal(count(target.id, 'wake_prerequisite'), 0);
});
it("keeps the batch evidence query bounded when finished-card history grows", () => {
  const { target } = fixture();
  getDb().exec("BEGIN");
  for (let n = 0; n < 500; n++) getDb().prepare("INSERT INTO tasks(project, title, role, status, created_at, updated_at) VALUES ('history', 'finished', 'batch', 'archived', ?, ?)").run(stamp(-100), stamp(-100));
  getDb().exec("COMMIT");
  takePerfSummary();
  round('reviewWait.query', () => assert.equal(loadAcceptanceReviewWaits().has(target.id), true));
  assert.equal(takePerfSummary()!.loops['reviewWait.query'].io.sql, 1);
});
it("loads dependency facts in one additional batch regardless of the number of linked reviews", () => {
  const { target, review } = fixture();
  const parent = createTask({ project: 'demo', title: 'anonymous parent', role: 'batch', actor: 'scheduler' });
  for (let n = 0; n < 30; n++) {
    const candidate = n === 0 ? review : seedLegacyLinkedReview({ project: 'demo', title: 'anonymous waiting review', role: 'reviewer', reviewOf: target.id, actor: 'scheduler' });
    getDb().prepare("UPDATE tasks SET status = 'waiting' WHERE id = ?").run(candidate.id);
    getDb().prepare("INSERT INTO links(task_id, parent_id) VALUES (?, ?)").run(candidate.id, parent.id);
  }
  takePerfSummary();
  round('reviewWait.dependencies', () => assert.equal(loadAcceptanceReviewWaits(target.id).get(target.id)!.reviews.length, 30));
  assert.equal(takePerfSummary()!.loops['reviewWait.dependencies'].io.sql, 2);
});
