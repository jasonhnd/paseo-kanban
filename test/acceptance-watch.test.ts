import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, it } from "node:test";
import { resetAcceptanceBackoffForTests, scanAcceptance } from "../server/acceptance-watch";
import { setWakeSender } from "../server/bus";
import { cardMark } from "../server/card-ref";
import { loadConfig, saveConfig } from "../server/config";
import { closeDb, getDb } from "../server/db";
import { runTick } from "./helpers/compat-schedule";
import { LEADER_UNRESPONSIVE_TAG } from "../server/leader-activity";
import { appendEvent, createTask, getTask, getDetail } from "../server/store";
import { notifyAcceptance, resetAgentAliveCheck, retryUnattended, setAgentAliveCheck } from "../server/wake";

const dir = mkdtempSync(join(tmpdir(), "acceptance-"));
const decisionsPath = join(dir, "decisions.json");
process.env.KANBAN_DATA_DIR = dir;
process.env.KANBAN_AGENTS_DIR = join(dir, "agents");
mkdirSync(process.env.KANBAN_AGENTS_DIR, { recursive: true });
const base = new Date("2026-10-02T03:00:00Z").getTime();
const minute = 60_000;
const ACCEPTANCE_BACKOFF_MINUTES = 5;
const stamp = (minutes: number) => new Date(base + minutes * minute).toISOString();
const sent: Array<{ id: string; text: string }> = [];
const events = (id: number, kind: string) => getDb().prepare("SELECT * FROM events WHERE task_id = ? AND kind = ?").all(id, kind);
const marked = (id: number) => JSON.parse(getTask(id).tags ?? "[]").includes(LEADER_UNRESPONSIVE_TAG);
function card(age = 31, project = "watch", status = "acceptance") {
  const task = createTask({ project, title: `Acceptance ${project}`, role: "executor", workspacePath: dir, actor: "scheduler", createdByAgent: "old-creator", tags: ["keep-me"] });
  getDb().prepare("UPDATE tasks SET status = ?, created_at = ?, updated_at = ? WHERE id = ?")
    .run(status, stamp(-age - 100), stamp(0), task.id);
  if (status === "acceptance") appendEvent(task.id, "approve", "reviewing", status, "reviewer", {}, stamp(-age));
  return task.id;
}
const scan = (minutes = 0) => scanAcceptance({ now: new Date(stamp(minutes)), decisionsPath });
const decision = (code: string, extra = {}) => ({ id: "d1", project: "watch", title: `\uff08${code}\uff09Release scope`, detail: "A Sample text B Sample text Sample textA", blocking: true, status: "open", createdAt: stamp(-10), ...extra });
beforeEach(() => {
  resetAcceptanceBackoffForTests();
  getDb().exec("DELETE FROM events; DELETE FROM tasks;");
  saveConfig({ ...loadConfig(), supervisors: { watch: "leader", other: "other-leader" }, supervisorAgentId: "fallback" });
  writeFileSync(decisionsPath, "[]");
  sent.length = 0;
  setAgentAliveCheck(() => true);
  setWakeSender((id, text) => { sent.push({ id, text }); });
});
after(() => { resetAgentAliveCheck(); closeDb(); rmSync(dir, { recursive: true, force: true }); });

it("batches every actionable acceptance card for the registered project leader, never its old creator", async () => {
  const old = card(); const young = card(1); const other = card(1, "other");
  card(100, "watch", "running");
  await scan();
  assert.equal(sent.length, 1); assert.equal(sent[0].id, "leader");
  assert.ok(sent[0].text.includes(cardMark(old))); assert.ok(!sent[0].text.includes(cardMark(young)));
  assert.ok(!sent[0].text.includes(cardMark(other))); assert.match(sent[0].text, /\u5148\u6e05\u5b8c\u8fd9\u4e00\u6279/);
  assert.match(sent[0].text, /\u5df2\u66ff\u4f60\u51b3\u5b9a\uff08\u53ef\u63a8\u7ffb\uff09/);
  assert.match(sent[0].text, /\u53ea\u6709\u4e0d\u53ef\u64a4\u56de/);
  assert.match(sent[0].text, /--role batch/);
  assert.equal(events(old, "wake_acceptance_repeat").length, 1);
  assert.equal(events(young, "wake_acceptance_repeat").length, 0);
});
it("requires both ages strictly over 30 minutes and ignores housekeeping updated_at", async () => {
  const id = card(30);
  await scan(); assert.equal(sent.length, 0);
  appendEvent(id, "comment", null, "acceptance", "leader", {}, stamp(0));
  await scan(30); assert.equal(sent.length, 0);
  await scan(30.01); assert.equal(sent.length, 1);
});
it("any supervisor event on another card in the same project postpones the wake", async () => {
  const id = card(150); const active = card(1);
  appendEvent(active, "created", null, null, "supervisor", {}, stamp(-10));
  await scan(); assert.equal(sent.length, 0); assert.equal(marked(id), false);
  await scan(20.01); assert.equal(sent.length, 1); assert.equal(marked(id), true);
});
it("other projects, executor comments and scheduler events do not count as this leader responding", async () => {
  const id = card(150); const other = card(1, "other");
  appendEvent(other, "comment", null, null, "supervisor", {}, stamp(0));
  appendEvent(id, "comment", null, null, "executor", {}, stamp(0));
  appendEvent(id, "hold", null, null, "scheduler", {}, stamp(0));
  await scan(); assert.equal(sent.length, 1); assert.equal(marked(id), true);
});
it("persists two wakes per acceptance round across reload, then resets after rework and approve", async () => {
  const id = card(); await scan();
  closeDb(); resetAcceptanceBackoffForTests();
  await scan(29.99); assert.equal(sent.length, 1);
  await scan(30); assert.equal(sent.length, 2);
  closeDb(); resetAcceptanceBackoffForTests();
  await scan(60); assert.equal(sent.length, 2);
  getDb().prepare("UPDATE tasks SET status = 'ready' WHERE id = ?").run(id);
  appendEvent(id, "rework", "acceptance", "ready", "supervisor", {}, stamp(61));
  await scan(62); assert.equal(sent.length, 2);
  getDb().prepare("UPDATE tasks SET status = 'acceptance' WHERE id = ?").run(id);
  appendEvent(id, "approve", "reviewing", "acceptance", "reviewer", {}, stamp(70));
  await scan(100); assert.equal(sent.length, 2);
  await scan(100.01); assert.equal(sent.length, 3);
  closeDb(); resetAcceptanceBackoffForTests();
  await scan(130); assert.equal(sent.length, 3);
  await scan(130.01); assert.equal(sent.length, 4);
  closeDb(); resetAcceptanceBackoffForTests();
  await scan(200); assert.equal(sent.length, 4);
  const rows = events(id, "wake_acceptance_repeat") as Array<{ data_json: string }>;
  const data = rows.map(row => JSON.parse(row.data_json));
  assert.deepEqual(data.map(row => row.repeat), [1, 2, 1, 2]);
  assert.equal(data[0].acceptanceEventId, data[1].acceptanceEventId);
  assert.equal(data[2].acceptanceEventId, data[3].acceptanceEventId);
  assert.notEqual(data[0].acceptanceEventId, data[2].acceptanceEventId);
});
it("counts legacy reminders only after the current acceptance entry", async () => {
  const id = card(150);
  appendEvent(id, "wake_acceptance_repeat", null, null, "scheduler", { repeat: 1 }, stamp(-140));
  appendEvent(id, "wake_acceptance_repeat", null, null, "scheduler", { repeat: 2 }, stamp(-110));
  appendEvent(id, "rework", "acceptance", "ready", "supervisor", {}, stamp(-100));
  appendEvent(id, "approve", "reviewing", "acceptance", "reviewer", {}, stamp(-90));
  appendEvent(id, "wake_acceptance_repeat", null, null, "scheduler", { repeat: 1 }, stamp(-10));
  closeDb(); resetAcceptanceBackoffForTests();
  await scan(); assert.equal(sent.length, 0);
  await scan(20); assert.equal(sent.length, 1);
  const rows = events(id, "wake_acceptance_repeat") as Array<{ data_json: string }>;
  assert.equal(JSON.parse(rows.at(-1)!.data_json).repeat, 2);
  closeDb(); resetAcceptanceBackoffForTests();
  await scan(60); assert.equal(sent.length, 1);
});
it("keeps the persisted cap for imported acceptance cards without an entry event", async () => {
  const id = card(150, "watch", "running");
  getDb().prepare("UPDATE tasks SET status = 'acceptance' WHERE id = ?").run(id);
  appendEvent(id, "wake_acceptance_repeat", null, null, "scheduler", { repeat: 1 }, stamp(-10));
  await scan(); assert.equal(sent.length, 0);
  await scan(20); assert.equal(sent.length, 1);
  closeDb(); resetAcceptanceBackoffForTests();
  await scan(60); assert.equal(sent.length, 1);
  const rows = events(id, "wake_acceptance_repeat") as Array<{ data_json: string }>;
  assert.equal(JSON.parse(rows.at(-1)!.data_json).repeat, 2);
});
it("does not consume a repeat on sender rejection, and awaits async delivery", async () => {
  const id = card(); setWakeSender(async () => { throw new Error("fixture rejected"); });
  await scan(); assert.equal(events(id, "wake_acceptance_repeat").length, 0);
  setWakeSender(async (id, text) => { sent.push({ id, text }); });
  await scan(ACCEPTANCE_BACKOFF_MINUTES + 0.01); assert.equal(events(id, "wake_acceptance_repeat").length, 1);
});
it("does not wake a dead/missing leader or fall back; still exposes the overdue marker", async () => {
  const id = card(121); setAgentAliveCheck(() => false);
  await scan(); assert.equal(sent.length, 0); assert.equal(marked(id), true);
  saveConfig({ ...loadConfig(), supervisors: {} }); setAgentAliveCheck(() => true);
  await scan(31); assert.equal(sent.length, 0); assert.equal(events(id, "wake_acceptance_repeat").length, 0);
});
it("marks strictly after two hours once, preserves tags/card age and clears all project marks immediately on leader action", async () => {
  const id = card(120); const second = card(130); const other = card(130, "other");
  await scan(); assert.equal(marked(id), false); assert.equal(marked(second), true); assert.equal(marked(other), true);
  await scan(0.01); assert.equal(marked(id), true); await scan(1);
  assert.equal(events(id, "leader_unresponsive").length, 1);
  assert.equal(getTask(id).updated_at, stamp(0));
  assert.ok(getDetail(id).task.tags.includes(LEADER_UNRESPONSIVE_TAG));
  appendEvent(second, "comment", null, null, "leader", {}, stamp(1));
  assert.equal(marked(id), false); assert.equal(marked(second), false); assert.equal(marked(other), true);
  assert.deepEqual(JSON.parse(getTask(id).tags!), ["keep-me"]);
  assert.equal(events(id, "leader_responsive").length, 1);
  await scan(2); assert.equal(marked(id), false);
});
it("create itself counts as an immediate supervisor action and clears marks", async () => {
  const id = card(121); await scan(); assert.equal(marked(id), true);
  createTask({ project: "watch", title: "New card", role: "reader", workspacePath: dir });
  assert.equal(marked(id), false);
});
it("removes marks when acceptance ends", async () => {
  const id = card(121); await scan();
  getDb().prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(id);
  await scan(1); assert.equal(marked(id), false);
});
it("open exact-code decisions suppress the whole card, then close/remove restores eligibility without editing decisions", async () => {
  const id = card(150); const young = card(31);
  const source = JSON.stringify([decision(cardMark(id).toLowerCase())]); writeFileSync(decisionsPath, source);
  await scan(); assert.equal(marked(id), false); assert.equal(events(id, "wake_acceptance_repeat").length, 0);
  assert.equal(sent.length, 1); assert.ok(!sent[0].text.includes(cardMark(id))); assert.ok(sent[0].text.includes(cardMark(young)));
  writeFileSync(decisionsPath, JSON.stringify([decision(cardMark(id), { status: "done" })]));
  await scan(1); assert.equal(marked(id), true); assert.equal(events(id, "wake_acceptance_repeat").length, 1);
  writeFileSync(decisionsPath, source); await scan(2); assert.equal(marked(id), false);
  writeFileSync(decisionsPath, "[]"); await scan(32); assert.equal(marked(id), true);
});
it("longer codes and unrelated decisions never exempt a card", async () => {
  const id = card(150);
  writeFileSync(decisionsPath, JSON.stringify([decision(`${cardMark(id)}0`)]));
  await scan(); assert.equal(marked(id), true); assert.equal(sent.length, 1);
});
for (const content of ["{broken", '[{"status":"open"}]']) it(`unreadable/invalid decision source is uncertain: nothing is woken or marked, ${content}`, async () => {
  const id = card(150); writeFileSync(decisionsPath, content);
  await scan(); assert.equal(marked(id), false); assert.equal(sent.length, 0);
  assert.equal(events(id, "wake_acceptance_repeat").length, 0);
  writeFileSync(decisionsPath, "[]");
  await scan(1); assert.equal(marked(id), true); assert.equal(sent.length, 1);
});
it("an uncertain decision source does not clear an existing overdue marker", async () => {
  const id = card(150); await scan(); assert.equal(marked(id), true);
  writeFileSync(decisionsPath, "{broken");
  await scan(1); assert.equal(marked(id), true); assert.equal(events(id, "leader_responsive").length, 0);
});
it("initial acceptance notices and unattended retries wait while the decision source is unreadable", () => {
  const id = card(150);
  writeFileSync(decisionsPath, "{broken");
  notifyAcceptance(id, false, decisionsPath); retryUnattended(decisionsPath);
  assert.equal(sent.length, 0); assert.equal(events(id, "wake_acceptance").length, 0);
  writeFileSync(decisionsPath, "[]"); retryUnattended(decisionsPath);
  assert.equal(sent.length, 1);
});
it("acceptance transition events, not later updated_at or original creation, define age", async () => {
  const id = card(1); await scan(); assert.equal(sent.length, 0); assert.equal(marked(id), false);
  const old = card(150); appendEvent(old, "approve", "reviewing", "acceptance", "reviewer", {}, stamp(-1));
  await scan(); assert.equal(sent.length, 0); assert.equal(marked(old), false);
});

it("initial acceptance notices and unattended retries also respect open decisions", () => {
  const id = card(150);
  writeFileSync(decisionsPath, JSON.stringify([decision(cardMark(id))]));
  notifyAcceptance(id, false, decisionsPath);
  retryUnattended(decisionsPath);
  assert.equal(sent.length, 0); assert.equal(events(id, "wake_acceptance").length, 0);
  writeFileSync(decisionsPath, "[]");
  retryUnattended(decisionsPath);
  assert.equal(sent.length, 1);
});

it("scheduler tick invokes the persistent acceptance scan", async () => {
  const id = card(150);
  appendEvent(id, "wake_acceptance", null, "acceptance", "scheduler", { agentId: "leader", fallback: false }, stamp(-150));
  await runTick({ now: new Date(stamp(0)), config: { ...loadConfig(), supervisorAgentId: null },
    profiles: [], launcher: { async create() { throw new Error("no work should start"); }, async send() {} } });
  assert.equal(events(id, "wake_acceptance_repeat").length, 1); assert.equal(marked(id), true);
});
it("a leader action during async delivery clears markers without restoring them afterwards", async () => {
  const id = card(150);
  setWakeSender(async () => { appendEvent(id, "comment", null, null, "leader", {}, stamp(0)); });
  await scan(); assert.equal(marked(id), false);
  assert.equal(events(id, "wake_acceptance_repeat").length, 1);
});
it("missing decision file restores the ordinary rule", async () => {
  const id = card(150);
  await scanAcceptance({ now: new Date(stamp(0)), decisionsPath: join(dir, "missing.json") });
  assert.equal(marked(id), true); assert.equal(events(id, "wake_acceptance_repeat").length, 1);
});

it("new reminders and marker events do not split legacy to_status duration metrics", async () => {
  const id = card(150);
  const slices = () => getDb().prepare("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND to_status IS NOT NULL").get(id)!.n;
  const before = slices(); await scan();
  appendEvent(id, "comment", null, null, "leader", {}, stamp(1));
  assert.equal(slices(), before);
  for (const kind of ["wake_acceptance_repeat", "leader_unresponsive", "leader_responsive"]) {
    const rows = events(id, kind) as Array<{ to_status: string | null }>;
    assert.equal(rows.length, 1); assert.equal(rows[0].to_status, null);
  }
});

it("the newest supervisor event by id decides how long the leader has been idle", async () => {
  const id = card(150);
  const recent = card(1);
  appendEvent(recent, "created", null, null, "supervisor", {}, stamp(-5));
  appendEvent(recent, "comment", null, null, "supervisor", {}, stamp(-40));
  await scan(); assert.equal(sent.length, 1); assert.equal(marked(id), true);
});
it("a refused wake backs off, doubling each time, and a success resets it", async () => {
  const id = card(150); let calls = 0;
  setWakeSender(async () => { calls += 1; throw new Error("down"); });
  await scan(0); assert.equal(calls, 1);
  await scan(1); assert.equal(calls, 1);
  await scan(5.01); assert.equal(calls, 2);
  await scan(10); assert.equal(calls, 2);
  await scan(15.02); assert.equal(calls, 3);
  setWakeSender(async (agent, text) => { sent.push({ id: agent, text }); });
  await scan(25); assert.equal(sent.length, 0);
  await scan(36); assert.equal(sent.length, 1); assert.equal(events(id, "wake_acceptance_repeat").length, 1);
});
it("overdue markers are written onto the tags as they are when the write happens", async () => {
  const first = card(31); const late = card(150, "other");
  setWakeSender(async (agent, text) => {
    sent.push({ id: agent, text });
    if (agent === "leader") getDb().prepare("UPDATE tasks SET tags = ? WHERE id = ?").run(JSON.stringify(["keep-me", "added-meanwhile"]), late);
  });
  await scan();
  assert.ok(first > 0);
  assert.deepEqual(JSON.parse(getTask(late).tags!), ["keep-me", "added-meanwhile", LEADER_UNRESPONSIVE_TAG]);
});
