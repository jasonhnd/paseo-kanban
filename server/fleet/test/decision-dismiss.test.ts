import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tIn } from "../../../shared/fleet/i18n";
import {
  CHECK_AFTER_MS,
  CHECK_RETRY_MS,
  checkDigest,
  checkLine,
  dueForCheck,
  spokeAfterCreate,
} from "../../../shared/fleet/decision-check";
import {
  dismissPrompt,
  restorePrompt,
  rolesDismissArgs,
  rolesReopenArgs,
  submitDecision,
  userDismissNote,
  type DecideAgent,
  type DecideDeps,
  type OpenDecisionItem,
} from "../decide-reply";
import { runOpenDecisionChecks, type CheckDeps, type OpenCheckRequest } from "../decision-check";
import { parseLeaderActivity } from "../leader-panel";

function check(name: string, cond: boolean, detail?: string): void {
  assert.ok(cond, `${name}${detail ? `: ${detail}` : ""}`);
}

const item: OpenDecisionItem = { id: "d1", project: "demo", title: "Pick one", detail: "A: keep; B: drop. Recommend: A" };
const leader: DecideAgent = { id: "leader-1", title: "Demo leader", cwd: "/work/demo", archivedAt: null };
const note = tIn("zh-CN", "decisions.reply.userDismissNote");

function deps(opts: {
  open?: OpenDecisionItem | null;
  record?: OpenDecisionItem | null;
  table?: Record<string, string> | null;
  agents?: DecideAgent[];
  sendFails?: boolean;
}): { deps: DecideDeps; roles: string[][]; sent: string[] } {
  const roles: string[][] = [];
  const sent: string[] = [];
  let open = opts.open === undefined ? item : opts.open;
  const api: DecideDeps = {
    readOpen: async () => open,
    readRecord: async () => (opts.record === undefined ? open : opts.record),
    roles: async (args) => {
      roles.push(args);
      if (args[1] === "done") open = null;
      if (args[1] === "reopen") open = item;
      return "ok";
    },
    send: async (_id, prompt) => {
      if (opts.sendFails) throw new Error("send failed");
      sent.push(prompt);
    },
    readTable: async () => (opts.table === undefined ? { demo: "leader-1" } : opts.table),
    listAgents: async () => opts.agents ?? [leader],
  };
  return { deps: api, roles, sent };
}

function memory() {
  let state = { reminded: {} as Record<string, string>, tried: {} as Record<string, string> };
  const sent: { agentId: string; text: string }[] = [];
  const logs: string[] = [];
  let failTimes = 0;
  const checkDeps: CheckDeps = {
    load: async () => ({ reminded: { ...state.reminded }, tried: { ...state.tried } }),
    save: async (next) => { state = { reminded: { ...next.reminded }, tried: { ...next.tried } }; },
    send: async (agentId, text) => {
      if (failTimes > 0) { failTimes -= 1; throw new Error("send failed"); }
      sent.push({ agentId, text });
    },
    log: (tag) => { logs.push(tag); },
  };
  return {
    deps: checkDeps,
    sent,
    logs,
    state: () => state,
    fail(n: number) { failTimes = n; },
  };
}

const NOW = Date.parse("2026-06-01T00:00:00.000Z");
function source(id: string, project: string, age: number, status = "open") {
  return { id, project, title: id, status, createdAt: new Date(NOW - age).toISOString() };
}
function request(partial: Partial<OpenCheckRequest> & Pick<OpenCheckRequest, "items">): OpenCheckRequest {
  return {
    details: [],
    supervisors: { alpha: "agent-a", beta: "agent-b" },
    paused: [],
    now: NOW,
    ...partial,
  };
}

async function main(): Promise<void> {
  const first = deps({});
  const closed = await submitDecision({ id: "d1", choice: "dismiss", text: "" }, first.deps);
  check("dismiss records with the decided class and the panel note", closed.ok && JSON.stringify(first.roles[0]) === JSON.stringify(rolesDismissArgs("d1", userDismissNote())));
  check("dismiss tells the registered leader", first.sent.length === 1 && first.sent[0] === dismissPrompt(item));
  const again = await submitDecision({ id: "d1", choice: "dismiss", text: "" }, first.deps);
  const already = new Set([tIn("zh-CN", "decisions.reply.dismissedAlready"), tIn("en", "decisions.reply.dismissedAlready")]);
  check("dismiss again is a no-op", again.ok && already.has(again.message), again.message);
  check("dismiss again does not write or send", first.roles.length === 1 && first.sent.length === 1);

  const missing = deps({ table: null, agents: [] });
  const noLeader = await submitDecision({ id: "d1", choice: "dismiss", text: "" }, missing.deps);
  check("dismiss with no leader session still records", noLeader.ok && missing.roles.length === 1 && missing.sent.length === 0, noLeader.message);

  const noisy = deps({ table: null, agents: [], sendFails: true });
  const quiet = await submitDecision({ id: "d1", choice: "dismiss", text: "" }, noisy.deps);
  check("dismiss does not throw when there is no leader", quiet.ok);

  const broken = deps({ sendFails: true });
  const saved = await submitDecision({ id: "d1", choice: "dismiss", text: "" }, broken.deps);
  check("dismiss stays successful when the notice fails", saved.ok && broken.roles.length === 1 && saved.message.includes("send failed"));

  const undo = deps({ open: null, record: item });
  const restored = await submitDecision({ id: "d1", choice: "restore", text: "" }, undo.deps);
  check("restore calls decide reopen and tells the leader", restored.ok && JSON.stringify(undo.roles[0]) === JSON.stringify(rolesReopenArgs("d1")) && undo.sent[0] === restorePrompt(item));
  const stillOpen = await submitDecision({ id: "d1", choice: "restore", text: "" }, undo.deps);
  check("restore of an open item does not write again", stillOpen.ok && undo.roles.length === 1);

  const undoMissing = deps({ open: null, record: item, table: null, agents: [], sendFails: true });
  const undoQuiet = await submitDecision({ id: "d1", choice: "restore", text: "" }, undoMissing.deps);
  check("restore does not throw when there is no leader", undoQuiet.ok && undoMissing.roles.length === 1 && undoMissing.sent.length === 0);

  const old = CHECK_AFTER_MS + 60_000;
  const gate = memory();
  const due = request({ items: [source("d-old", "alpha", old)] });
  const once = await runOpenDecisionChecks(due, gate.deps);
  check("a 24-hour item is reminded once", once.sent.join() === "d-old" && gate.sent.length === 1);
  const twice = await runOpenDecisionChecks(due, gate.deps);
  check("the same item is not reminded again inside 24 hours", twice.sent.length === 0 && gate.sent.length === 1);
  const later = await runOpenDecisionChecks({ ...due, now: NOW + CHECK_AFTER_MS }, gate.deps);
  check("the same item can be reminded after 24 hours", later.sent.join() === "d-old" && gate.sent.length === 2);

  const young = await runOpenDecisionChecks(request({ items: [source("d-young", "alpha", CHECK_AFTER_MS)] }), memory().deps);
  check("an item open for exactly 24 hours is not reminded", young.sent.length === 0);

  const retry = memory();
  retry.fail(1);
  const failedSend = await runOpenDecisionChecks(due, retry.deps);
  check("a failed reminder is not marked sent", failedSend.sent.length === 0 && retry.sent.length === 0);
  const soon = await runOpenDecisionChecks({ ...due, now: NOW + 60_000 }, retry.deps);
  check("a failed reminder waits out the retry window", soon.sent.length === 0 && retry.sent.length === 0);
  const retried = await runOpenDecisionChecks({ ...due, now: NOW + CHECK_RETRY_MS }, retry.deps);
  check("a failed reminder is sent after the retry window", retried.sent.join() === "d-old" && retry.sent.length === 1);

  const created = new Date(NOW - old).toISOString();
  const spokeYesBox = memory();
  const spokeYes = await runOpenDecisionChecks(request({
    items: [source("d-yes", "alpha", old)],
    details: [{ project: "alpha", activityWarning: null, lastUserReplyAt: new Date(NOW - old + 1000).toISOString() }],
  }), spokeYesBox.deps);
  const spokeLine = checkLine({ id: "d-yes", project: "alpha", title: "d-yes", spoke: "yes" });
  check("a leader who spoke after the item was opened is reminded", spokeYes.sent.join() === "d-yes" && spokeYesBox.sent[0]?.text.includes(spokeLine));
  const spokeNoBox = memory();
  const spokeNo = await runOpenDecisionChecks(request({
    items: [source("d-no", "alpha", old)],
    details: [{ project: "alpha", activityWarning: null, lastUserReplyAt: created }],
  }), spokeNoBox.deps);
  check("a leader who has not spoken since the item opened is not reminded", spokeNo.sent.length === 0 && spokeNoBox.sent.length === 0);
  check("an equal timestamp is not after creation", spokeAfterCreate(created, { known: true, lastUserReplyAt: created }) === "no");
  check("an unreadable timeline degrades to unknown and still qualifies", dueForCheck({
    createdAt: created, now: NOW, speech: { known: false, lastUserReplyAt: null },
  }));

  const pausedBox = memory();
  const paused = await runOpenDecisionChecks(request({
    items: [source("d-pause", "alpha", old)],
    paused: [{ project: "Alpha" }],
  }), pausedBox.deps);
  check("a paused project is not reminded", paused.sent.length === 0 && pausedBox.logs.length === 0);

  const orphan = memory();
  const noOwner = await runOpenDecisionChecks(request({
    items: [source("d-none", "gamma", old)],
    supervisors: null,
  }), orphan.deps);
  check("a missing owner is recorded and does not throw", noOwner.noOwner.join() === "d-none" && orphan.sent.length === 0 && orphan.logs.some((line) => line.includes("no owner")));

  const batch = memory();
  const grouped = await runOpenDecisionChecks(request({
    items: [source("d-a1", "alpha", old), source("d-a2", "alpha", old), source("d-b1", "beta", old)],
  }), batch.deps);
  check("one leader gets one message and two leaders get two", grouped.sent.length === 3 && batch.sent.length === 2);
  const alpha = batch.sent.find((row) => row.agentId === "agent-a");
  check("one message lists both of that leader's items", Boolean(alpha) && alpha!.text === checkDigest([
    checkLine({ id: "d-a1", project: "alpha", title: "d-a1", spoke: "unknown" }),
    checkLine({ id: "d-a2", project: "alpha", title: "d-a2", spoke: "unknown" }),
  ]));

  const userAt = "2026-05-02T00:00:00.000Z";
  const agentAt = "2026-05-03T00:00:00.000Z";
  const spoken = parseLeaderActivity([
    { seqStart: 1, timestamp: "2026-05-01T00:00:00.000Z", item: { type: "user_message", text: "hello" } },
    { seqStart: 2, timestamp: userAt, item: { type: "assistant_message", text: "options" } },
    { seqStart: 3, timestamp: "2026-05-02T01:00:00.000Z", item: { type: "user_message", text: "[notice] wake" } },
    { seqStart: 4, timestamp: agentAt, item: { type: "assistant_message", text: "ack" } },
  ]);
  check("the latest user-facing reply is kept when a later reply is to another agent", spoken.lastUserReplyAt === userAt);
  const absent = parseLeaderActivity([
    { seqStart: 1, timestamp: userAt, item: { type: "assistant_message", text: "hello" } },
  ]);
  check("a reply with no prompt counts as spoken to the user", absent.lastUserReplyAt === userAt);

  const root = join(mkdtempSync(join(tmpdir(), "afc-dismiss-")), "fleet");
  const rolesBin = resolve(dirname(fileURLToPath(import.meta.url)), "../../../bin/roles.mjs");
  const env = {
    ...process.env,
    PASEO_HOME: join(root, "paseo"),

    KANBAN_DATA_DIR: join(root, ".."),

    AFC_LANGUAGE: "zh-CN",
  };
  const cli = (...args: string[]) => spawnSync(process.execPath, [rolesBin, "decide", ...args], { env, encoding: "utf8", timeout: 15_000 });
  try {
    const added = cli("add", "--project", "demo", "--title", "Pick one", "--detail", "A: keep; B: drop. Recommend: A");
    const id = /added\s+(\S+)/.exec(added.stdout)?.[1] ?? "";
    check("cli adds a demo item", added.status === 0 && id.length > 0, added.stderr);
    const done = cli("done", id, "--as", "decided", "--note", note);
    const rows = () => JSON.parse(readFileSync(join(root, "decisions.json"), "utf8")) as Array<{ id: string; status: string; note: string; doneAt?: string }>;
    const closedRow = rows().find((row) => row.id === id);
    check("cli close stores done and the panel note", done.status === 0 && closedRow?.status === "done" && closedRow.note === note, done.stderr);
    const stamped = rows().map((row) => row.id === id ? { ...row, doneAt: "2000-01-01T00:00:00" } : row);
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(root, "decisions.json"), JSON.stringify(stamped, null, 2));
    const repeat = cli("done", id, "--as", "decided", "--note", note);
    const repeated = rows().find((row) => row.id === id);
    check("cli close again does not move doneAt", repeat.status === 0 && repeated?.doneAt === "2000-01-01T00:00:00", repeat.stdout + repeat.stderr);
    const reopened = cli("reopen", id);
    const openRow = rows().find((row) => row.id === id);
    check("cli reopen clears the close", reopened.status === 0 && openRow?.status === "open" && openRow.note === "" && openRow.doneAt === undefined, reopened.stderr);
    const letter = cli("done", id, "--note", "picked A");
    const refused = cli("reopen", id);
    const stayed = rows().find((row) => row.id === id);
    check("cli reopen refuses a letter close", letter.status === 0 && refused.status !== 0 && stayed?.status === "done", refused.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

 }

test("panel close, reopen command, reminders and user-facing activity", main);
