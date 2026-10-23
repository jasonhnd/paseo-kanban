import { recordFixtureDelivery } from "./helpers/delivery";
/// <reference types="node" />
import { DEMO_FAMILIES, DEMO_BANNED, DEMO_PROFILE_RULES } from "./helpers/dispatch-policy";
import { zhCN, zhCNPart, localePattern, complexDocsProfileName } from "./helpers/locale";
import assert from "node:assert/strict";
import { cardMark } from "../server/card-ref";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { setWakeSender } from "../server/bus";
import { DEFAULT_CONCURRENCY, loadConfig, saveConfig, type KanbanConfig } from "../server/config";
import { closeDb, getDb } from "../server/db";
import { startTask } from "./helpers/compat-dispatch";
import { applyFailure, classifyFailure, reclaimTask } from "../server/failures";
import { approveTask } from "../server/flow";
import type { Profile } from "../server/profiles";
import { currentOccupancy } from "../server/routing";
import { agentLiveness } from "../server/open";
import { MISSING_CONFIRM_MS, resetReconcileForTests, type TickOptions } from "../server/schedule";
import { runTick } from "./helpers/compat-schedule";
import { addComment, archiveTask, blockTask, createTask, getTask } from "../server/store";
import { resetAgentAliveCheck, setAgentAliveCheck } from "../server/wake";

const tmp = tmpdir();
mkdirSync(tmp, { recursive: true });
const dir = mkdtempSync(join(tmp, "sched-"));
process.env.KANBAN_DATA_DIR = dir;
const poolFile = join(dir, "pool-status.json");
process.env.KANBAN_POOL_STATUS = poolFile;

const profiles: Profile[] = [
  { id: "ex", name: zhCN("labels.role.executor"), role: "executor", family: "xai", provider: "alternate", model: "grok-4.7", pool: "alternate" },
  { id: "rv", name: zhCN("labels.role.reviewer"), role: "reviewer", family: "anthropic", provider: "claude", model: "sonnet", pool: "claude-max" },
];

const sent: Array<{ id: string; text: string }> = [];

function limits(patch: Partial<KanbanConfig["concurrency"]> = {}): KanbanConfig["concurrency"] {
  return {
    global: patch.global ?? DEFAULT_CONCURRENCY.global,
    pools: { ...DEFAULT_CONCURRENCY.pools, ...patch.pools },
    roles: { ...DEFAULT_CONCURRENCY.roles, ...patch.roles },
  };
}

function queueOnBusyDir(config: KanbanConfig, project: string): KanbanConfig {
  const next: KanbanConfig = {
    ...config,
    projects: {
      ...(config.projects ?? {}),
      [project]: { defaultWorkspace: "dir", baseBranch: "main", worktreeLanes: 1, lanesEnabled: false, parallel: false },
    },
  };
  saveConfig(next);
  return next;
}

function lockAuto(enable: string | null, concurrency = limits(), supervisorAgentId: string | null = null): KanbanConfig {
  const rows = getDb().prepare("SELECT DISTINCT project FROM tasks").all() as unknown as Array<{ project: string }>;
  const autoStart: Record<string, boolean> = {};
  for (const row of rows) autoStart[row.project] = enable === row.project;
  if (enable) autoStart[enable] = true;
  const config: KanbanConfig = { autoStart, supervisorAgentId, supervisors: {}, concurrency, families: DEMO_FAMILIES, bannedProviders: DEMO_BANNED, profileRules: DEMO_PROFILE_RULES };
  saveConfig(config);
  return config;
}

function launcher(): TickOptions["launcher"] {
  let n = 0;
  return {
    async create() {
      n += 1;
      return { id: `agent-${Date.now()}-${n}` };
    },
    async send() {},
  };
}

function writePools(pools: Record<string, { dispatchable?: boolean; deprioritize?: boolean; reason?: string; onlyRoles?: string[]; usedPct?: number }>): void {
  writeFileSync(poolFile, JSON.stringify({ generatedAt: "2026-10-01T00:00:00.000Z", pools }));
}

beforeEach(() => {
  resetReconcileForTests();
  sent.length = 0;
  setWakeSender((id, text) => {
    sent.push({ id, text });
  });
  setAgentAliveCheck(() => true);
  writePools({ alternate: { dispatchable: true }, "claude-max": { dispatchable: true } });
});

after(() => {
  resetAgentAliveCheck();
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe("scheduler", () => {
  it("promotes a waiting card once every prerequisite is done", async () => {
    const parent = createTask({ project: "promo", title: "Parent", role: "executor", workspacePath: dir });
    const child = createTask({ project: "promo", title: "Child", role: "executor", workspacePath: dir, parentIds: [parent.id] });
    assert.equal(child.status, "waiting");
    getDb().prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(parent.id);
    const config = lockAuto(null);
    await runTick({ profiles, launcher: launcher(), config });
    assert.equal(getTask(child.id).status, "ready");
    assert.match(getTask(child.id).hold_reason ?? "", new RegExp(zhCN("schedule.autoStartOff")));
  });

  it("holds a card when the pool is full, and when the workspace is already busy", async () => {
    const left = join(dir, "left");
    const right = join(dir, "right");
    mkdirSync(left, { recursive: true });
    mkdirSync(right, { recursive: true });
    const first = createTask({ project: "cap", title: "sample", role: "executor", workspacePath: left });
    const second = createTask({ project: "cap", title: "sample", role: "executor", workspacePath: right });
    const capped = await runTick({
      profiles,
      launcher: launcher(),
      config: lockAuto("cap", limits({ pools: { alternate: 1 } })),
    });
    assert.equal(capped.started.length, 1);
    assert.equal(capped.started[0], first.id);
    assert.match(capped.held.find((item) => item.id === second.id)?.reason ?? "", new RegExp(zhCN("routing.poolFull", {"pool":"alternate"})));

    const sameA = createTask({ project: "room", title: "Same directory A", role: "executor", workspacePath: dir });
    const sameB = createTask({ project: "room", title: "Same directory B", role: "executor", workspacePath: dir });
    const crowded = await runTick({
      profiles,
      launcher: launcher(),
      config: queueOnBusyDir(lockAuto("room", limits({ pools: { alternate: 5 }, roles: { executor: 3 } })), "room"),
    });
    assert.ok(crowded.started.includes(sameA.id));
    assert.equal(crowded.started.includes(sameB.id), false);
    assert.match(getTask(sameB.id).hold_reason ?? "", new RegExp(zhCN("schedule.sameWorkspace")));
  });

  it("does not dispatch a pool marked dispatchable false", async () => {
    writePools({ alternate: { dispatchable: false } });
    const task = createTask({ project: "pool", title: "demo fixture", role: "executor", workspacePath: dir });
    const result = await runTick({ profiles, launcher: launcher(), config: lockAuto("pool") });
    assert.equal(result.started.includes(task.id), false);
    const waiting = getTask(task.id);
    assert.equal(waiting.status, "ready");
    assert.equal(waiting.blocked_kind, null);
    assert.match(waiting.hold_reason ?? "", new RegExp("^" + zhCN("blocked.prefix.quota") + "alternate" + zhCN("nativeSessions.sweep.reasonSep")));
    assert.equal(getDb().prepare("SELECT id FROM events WHERE task_id = ? AND kind = 'blocked'").get(task.id), undefined);
    assert.equal(getDb().prepare("SELECT id FROM events WHERE task_id = ? AND kind LIKE 'wake_%'").get(task.id), undefined);
    assert.equal(getDb().prepare("SELECT id FROM events WHERE task_id = ? AND kind = 'board_wake'").get(task.id), undefined);
    await runTick({ profiles, launcher: launcher(), config: loadConfig() });
    const holds = getDb().prepare("SELECT id FROM events WHERE task_id = ? AND kind = 'held'").all(task.id) as unknown[];
    assert.equal(holds.length, 1);
  });

  it("turns an old quota block back into a quota wait and does not wake the leader", async () => {
    writePools({ alternate: { dispatchable: false, reason: "5 hour window reached 70%" } });
    const task = createTask({ project: "legacy-quota", title: "Old quota card", role: "executor", workspacePath: dir });
    blockTask(task.id, "quota", zhCN("routing.noProfile"), "scheduler");
    sent.length = 0;
    await runTick({ profiles, launcher: launcher(), config: lockAuto("legacy-quota", limits(), "boss") });
    const waiting = getTask(task.id);
    assert.equal(waiting.status, "ready");
    assert.equal(waiting.blocked_kind, null);
    assert.match(waiting.hold_reason ?? "", new RegExp("^" + zhCN("blocked.prefix.quota") + "alternate" + zhCN("nativeSessions.sweep.reasonSep")));
    assert.match(waiting.hold_reason ?? "", /5 hour window/);
    const blocked = getDb().prepare("SELECT id FROM events WHERE task_id = ? AND kind = 'blocked' AND id > (SELECT id FROM events WHERE task_id = ? AND kind = 'unblocked')").get(task.id, task.id);
    assert.equal(blocked, undefined);
    assert.equal(sent.some((item) => item.id === "boss"), false);
  });

  it("blocks needs_human when the only named profile is missing, and does not do that for a paused pool", async () => {
    const missing = createTask({
      project: "permanent",
      title: "Profile disappeared",
      role: "executor",
      workspacePath: dir,
      profileOverride: (zhCNPart("missingCwd.purge.gone", 9, 13) + zhCNPart("routing.effortSource.profile", 0, 2)),
    });
    sent.length = 0;
    await runTick({ profiles, launcher: launcher(), config: lockAuto("permanent", limits(), "boss") });
    const blocked = getTask(missing.id);
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.blocked_kind, "needs_human");
    assert.match(blocked.blocked_reason ?? "", new RegExp(localePattern(zhCNPart("routing.profileNotFound", 0, 5))));
    assert.equal(sent.some((item) => item.id === "boss"), true);

    writePools({ alternate: { dispatchable: false, reason: "Not logged in" }, "claude-max": { dispatchable: true } });
    const loggedOut = createTask({ project: "permanent", title: "Executor not logged in", role: "executor", workspacePath: dir });
    sent.length = 0;
    await runTick({ profiles, launcher: launcher(), config: loadConfig() });
    const human = getTask(loggedOut.id);
    assert.equal(human.status, "blocked");
    assert.equal(human.blocked_kind, "needs_human");
    assert.match(human.blocked_reason ?? "", /Not logged in/);
    assert.doesNotMatch(human.hold_reason ?? "", new RegExp("^" + zhCN("blocked.prefix.quota")));
  });

  it("requeues a rate limit without counting a failure, and waits out the 5 minute cooldown", async () => {
    assert.equal(classifyFailure("429 Too many requests"), "rate_limit");
    const task = createTask({ project: "cool", title: "Rate limited", role: "executor", workspacePath: dir });
    getDb().prepare("UPDATE tasks SET status = 'running', agent_id = 'agent-rate' WHERE id = ?").run(task.id);
    const now = new Date("2026-09-26T12:00:00.000Z");
    assert.equal(applyFailure(task.id, "429 Too many requests", "rate_limit", now), "requeue");
    const queued = getTask(task.id);
    assert.equal(queued.status, "ready");
    assert.equal(queued.fail_count, 0);
    assert.equal(queued.blocked_kind, "rate_limit");
    // Earlier tests leave running cards. Closed reclaims those at once, so this card
    // is held for the cooldown. A missing file waits a minute and would still fill the pool.
    const held = await runTick({ profiles, launcher: launcher(), now, config: lockAuto("cool"), agentState: () => "closed" });
    assert.equal(held.started.includes(task.id), false);
    assert.match(getTask(task.id).hold_reason ?? "", new RegExp(localePattern(zhCNPart("failures.cooldown", 0, 6))));
    const later = new Date(now.getTime() + 6 * 60 * 1000);
    const released = await runTick({ profiles, launcher: launcher(), now: later, config: loadConfig() });
    assert.ok(released.started.includes(task.id));
    assert.equal(getTask(task.id).fail_count, 0);
  });

  it("fuses on the first credential or missing-model error", () => {
    assert.equal(classifyFailure("model not found: grok-x"), "credential");
    const task = createTask({ project: "fuse", title: "Credentials", role: "executor", workspacePath: dir });
    getDb().prepare("UPDATE tasks SET status = 'running', agent_id = 'agent-cred' WHERE id = ?").run(task.id);
    assert.equal(applyFailure(task.id, "model not found: grok-x", "credential"), "block");
    const blocked = getTask(task.id);
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.blocked_kind, "needs_human");
    assert.match(blocked.blocked_reason ?? "", /model not found: grok-x/);
    assert.equal(blocked.fail_count, 0);
  });

  it("counts other errors up to maxRetries and then blocks", () => {
    const task = createTask({ project: "retry", title: "demo fixture", role: "executor", workspacePath: dir });
    assert.equal(task.max_retries, 2);
    getDb().prepare("UPDATE tasks SET status = 'running', agent_id = 'agent-err' WHERE id = ?").run(task.id);
    assert.equal(applyFailure(task.id, "socket hang up", "other"), "requeue");
    assert.equal(getTask(task.id).status, "ready");
    assert.equal(getTask(task.id).fail_count, 1);
    getDb().prepare("UPDATE tasks SET status = 'running', agent_id = 'agent-err-2' WHERE id = ?").run(task.id);
    assert.equal(applyFailure(task.id, "socket hang up again", "other"), "block");
    const blocked = getTask(task.id);
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.blocked_kind, "needs_human");
    assert.equal(blocked.fail_count, 2);
  });

  it("reclaims a card whose agent is gone and dispatches it again", async () => {
    const task = createTask({ project: "gone", title: "Unexpected end", role: "executor", workspacePath: dir });
    getDb().prepare("UPDATE tasks SET status = 'running', agent_id = 'agent-gone' WHERE id = ?").run(task.id);
    const result = await runTick({
      profiles,
      launcher: launcher(),
      config: lockAuto("gone"),
      agentState: () => "closed",
    });
    assert.ok(result.started.includes(task.id));
    assert.equal(getTask(task.id).fail_count, 0);
    const event = getDb().prepare("SELECT kind, to_status FROM events WHERE task_id = ? AND kind = 'reclaimed'").get(task.id) as {
      kind: string;
      to_status: string;
    };
    assert.equal(event.to_status, "ready");
  });

  it("does not reclaim a card while its agent is still being created", async () => {
    const task = createTask({ project: "opening", title: "Just started", role: "executor", workspacePath: dir });
    const now = new Date("2026-09-26T16:00:00.000Z");
    getDb().prepare("UPDATE tasks SET status = 'running', agent_id = NULL, updated_at = ? WHERE id = ?").run(now.toISOString(), task.id);
    const held = await runTick({
      profiles,
      launcher: launcher(),
      now,
      config: lockAuto("opening"),
      agentState: () => "missing",
    });
    assert.equal(getTask(task.id).status, "running");
    assert.equal(held.started.includes(task.id), false);
    const later = new Date(now.getTime() + 3 * 60 * 1000);
    const released = await runTick({
      profiles,
      launcher: launcher(),
      now: later,
      config: loadConfig(),
      agentState: () => "missing",
    });
    assert.ok(released.started.includes(task.id));
    assert.equal(getTask(task.id).status, "running");
  });

  it("does not redispath a card that succeeded within 5 minutes", async () => {
    const task = createTask({ project: "guard", title: "Just succeeded", role: "executor", workspacePath: dir });
    const now = new Date("2026-09-26T15:00:00.000Z");
    getDb()
      .prepare(
        ("INSERT INTO runs (task_id, agent_id, role, profile_name, provider, model, family, started_at, ended_at, end_kind)\n         VALUES (?, 'agent-ok', 'executor', '" + zhCN("labels.role.executor") + "', 'alternate', 'grok-4.7', 'xai', ?, ?, 'complete')"),
      )
      .run(task.id, new Date(now.getTime() - 60_000).toISOString(), new Date(now.getTime() - 60_000).toISOString());
    const held = await runTick({ profiles, launcher: launcher(), now, config: lockAuto("guard") });
    assert.equal(held.started.includes(task.id), false);
    assert.match(getTask(task.id).hold_reason ?? "", new RegExp("5 " + localePattern(zhCNPart("failures.hold.recentSuccess", 6, 12))));
    const later = new Date(now.getTime() + 6 * 60 * 1000);
    const released = await runTick({ profiles, launcher: launcher(), now: later, config: loadConfig() });
    assert.ok(released.started.includes(task.id));
  });

  it("wakes the registered supervisor for a triage card and stops with a hint when nobody is registered", async () => {
    const task = createTask({
      project: "inbox",
      title: "Create button",
      brief: "Create button",
      role: "supervisor",
      initialStatus: "triage",
    });
    const quiet = await runTick({
      profiles,
      launcher: launcher(),
      config: lockAuto(null),
      send: async (id, text) => {
        sent.push({ id, text });
      },
    });
    assert.equal(quiet.started.includes(task.id), false);
    assert.match(getTask(task.id).hold_reason ?? "", new RegExp(localePattern(zhCNPart("schedule.noLeader", 17, 32))));
    assert.equal(sent.length, 0);
    const config = lockAuto(null, limits(), "boss");
    await runTick({
      profiles,
      launcher: launcher(),
      config,
      send: async (id, text) => {
        sent.push({ id, text });
      },
    });
    const about = () => sent.filter((item) => item.text.includes(`${cardMark(task.id)}`));
    assert.equal(about().length, 1);
    assert.equal(about()[0]?.id, "boss");
    assert.match(about()[0]?.text ?? "", /kanban_create/);
    await runTick({
      profiles,
      launcher: launcher(),
      config,
      send: async (id, text) => {
        sent.push({ id, text });
      },
    });
    assert.equal(about().length, 1);
    assert.equal(getTask(task.id).status, "triage");
  });

  it("wakes a creator registered as project leader for acceptance, a human block, and a finished child set", async () => {
    setAgentAliveCheck((id) => id === "creator" || id === "boss");
    const registered = lockAuto(null);
    registered.supervisors.wake = "creator";
    saveConfig(registered);
    const review = createTask({ project: "wake", title: "Waiting for acceptance", role: "executor", workspacePath: dir, createdByAgent: "creator" });
    getDb().prepare("UPDATE tasks SET status = 'reviewing', handoff_json = ? WHERE id = ?").run(JSON.stringify({ summary: "demo fixture README" }), review.id);
    approveTask(review.id, zhCNPart("cardDrawer.verdict.approve", 2, 4));
    assert.equal(getTask(review.id).status, "acceptance");
    assert.ok(sent.some((item) => item.id === "creator" && item.text.includes(`${cardMark(review.id)}`) && item.text.includes(zhCN("labels.status.acceptance")) && item.text.includes("demo fixture README")));

    sent.length = 0;
    const stuck = createTask({ project: "wake", title: "demo fixture", role: "executor", workspacePath: dir, createdByAgent: "creator" });
    blockTask(stuck.id, "needs_human", "Missing API guide", "executor");
    assert.ok(sent.some((item) => item.id === "creator" && item.text.includes(`${cardMark(stuck.id)}`) && item.text.includes("Missing API guide")));
    const weak = createTask({ project: "wake", title: "demo fixture", role: "executor", workspacePath: dir, createdByAgent: "creator" });
    blockTask(weak.id, "capability", "Cannot do", "executor");
    assert.ok(sent.some((item) => item.id === "creator" && item.text.includes(`${cardMark(weak.id)}`) && item.text.includes(zhCN("blocked.kind.capability"))));
    sent.length = 0;
    const quota = createTask({ project: "wake", title: "demo fixture", role: "executor", workspacePath: dir, createdByAgent: "creator" });
    blockTask(quota.id, "quota", "No quota", "executor");
    assert.equal(sent.length, 0);

    const parent = createTask({
      project: "wake",
      title: "Requirement group",
      role: "supervisor",
      initialStatus: "triage",
      createdByAgent: "creator",
    });
    const childA = createTask({ project: "wake", title: "Child A", role: "executor", workspacePath: dir, parentIds: [parent.id] });
    const childB = createTask({ project: "wake", title: "Child B", role: "executor", workspacePath: dir, parentIds: [parent.id] });
    assert.equal(childA.status, "ready");
    getDb().prepare("UPDATE tasks SET status = 'done' WHERE id IN (?, ?)").run(childA.id, childB.id);
    sent.length = 0;
    await runTick({ profiles, launcher: launcher(), config: registered });
    assert.equal(getTask(parent.id).status, "acceptance");
    assert.ok(sent.some((item) => item.id === "creator" && item.text.includes(zhCNPart("cardParts.event.wakeChildren", 2, 4)) && item.text.includes(`${cardMark(parent.id)}`)));

    sent.length = 0;
    setAgentAliveCheck((id) => id === "boss");
    lockAuto(null, limits(), "boss");
    const orphan = createTask({ project: "wake", title: "Creator gone", role: "executor", workspacePath: dir, createdByAgent: "creator" });
    blockTask(orphan.id, "needs_human", "Unavailable", "executor");
    assert.ok(sent.some((item) => item.id === "boss" && item.text.includes(`${cardMark(orphan.id)}`)));
    assert.equal(sent.some((item) => item.id === "creator"), false);
    assert.ok(getTask(orphan.id).unattended_at);
  });

  it("sends a rework card back to the original executor inside the success window", async () => {
    const workspace = join(dir, "rework-now");
    mkdirSync(workspace, { recursive: true });
    const task = createTask({ project: "rework-now", title: "Return immediately", role: "executor", workspacePath: workspace });
    const now = new Date("2026-09-26T16:00:00.000Z");
    const ended = new Date(now.getTime() - 60_000).toISOString();
    getDb().prepare(("UPDATE tasks SET status = 'rework', executor_agent_id = 'orig-exec', agent_id = 'orig-exec', executor_profile = '" + zhCN("labels.role.executor") + "' WHERE id = ?")).run(task.id);
    getDb()
      .prepare(
        ("INSERT INTO runs (task_id, agent_id, role, profile_name, provider, model, family, started_at, ended_at, end_kind)\n         VALUES (?, 'orig-exec', 'executor', '" + zhCN("labels.role.executor") + "', 'alternate', 'grok-4.7', 'xai', ?, ?, 'complete')"),
      )
      .run(task.id, ended, ended);
    const resumed: string[] = [];
    const result = await runTick({
      profiles,
      launcher: {
        async create() {
          return { id: "should-not-create" };
        },
        async send(id) {
          resumed.push(id);
        },
      },
      now,
      config: lockAuto("rework-now", limits({ global: 50, pools: { alternate: 50 }, roles: { executor: 50 } })),
    });
    assert.deepEqual(resumed, ["orig-exec"]);
    assert.ok(result.started.includes(task.id));
    assert.equal(getTask(task.id).status, "running");
  });

  it("queues a GPT rework when codex-pro is not in the snapshot", async () => {
    writePools({ alternate: { dispatchable: true }, "claude-max": { dispatchable: true } });
    const workspace = join(dir, "gpt-rework-missing");
    mkdirSync(workspace, { recursive: true });
    const gpt: Profile = {
      id: "gpt-rework",
      name: "Executor · configured model.1-Sol",
      role: "executor",
      family: "openai",
      provider: "codex",
      model: "demo-v2.1-sol",
      pool: "codex-pro",
      modeId: "full-access",
      thinkingOptionId: "high",
      featureValues: { fast_mode: false },
    };
    const task = createTask({ project: "gpt-rework-missing", title: "Sample text GPT", role: "executor", workspacePath: workspace });
    getDb()
      .prepare("UPDATE tasks SET status = 'rework', executor_agent_id = 'gpt-agent', agent_id = 'gpt-agent', executor_profile = ? WHERE id = ?")
      .run(gpt.name, task.id);
    const resumed: string[] = [];
    const result = await runTick({
      profiles: [...profiles, gpt],
      launcher: {
        async create() {
          return { id: "should-not-create" };
        },
        async send(id) {
          resumed.push(id);
        },
      },
      config: lockAuto("gpt-rework-missing", limits({ global: 50, pools: { alternate: 50, "codex-pro": 50, "claude-max": 50 }, roles: { executor: 50 } })),
    });
    assert.deepEqual(resumed, []);
    assert.ok(!result.started.includes(task.id));
    assert.equal(getTask(task.id).status, "rework");
    assert.match(getTask(task.id).hold_reason ?? "", new RegExp(zhCN("routing.poolUnseenReason")));
  });

  it("does not send a GPT rework back at ultra", async () => {
    writePools({ "codex-pro": { dispatchable: true }, alternate: { dispatchable: true }, "claude-max": { dispatchable: true } });
    const workspace = join(dir, "gpt-rework-ultra");
    mkdirSync(workspace, { recursive: true });
    const gpt: Profile = {
      id: "gpt-ultra",
      name: "Executor · configured model.1-Sol (ultra)",
      role: "executor",
      family: "openai",
      provider: "codex",
      model: "demo-v2.1-sol",
      pool: "codex-pro",
      modeId: "full-access",
      thinkingOptionId: "ultra",
    };
    const task = createTask({ project: "gpt-rework-ultra", title: "ultra Do not return", role: "executor", workspacePath: workspace });
    getDb()
      .prepare("UPDATE tasks SET status = 'rework', executor_agent_id = 'gpt-ultra', agent_id = 'gpt-ultra', executor_profile = ? WHERE id = ?")
      .run(gpt.name, task.id);
    const resumed: string[] = [];
    await runTick({
      profiles: [...profiles, gpt],
      launcher: {
        async create() {
          return { id: "should-not-create" };
        },
        async send(id) {
          resumed.push(id);
        },
      },
      config: lockAuto("gpt-rework-ultra", limits({ global: 50, pools: { alternate: 50, "codex-pro": 50 }, roles: { executor: 50 } })),
    });
    assert.deepEqual(resumed, []);
    const after = getTask(task.id);
    assert.notEqual(after.status, "running");
    assert.match(`${after.blocked_reason ?? ""} ${after.hold_reason ?? ""}`, new RegExp(zhCN("routing.depthNotAllowed")));
  });

  it("blocks a GPT rework on the executor run depth, not the later reviewer run", async () => {
    writePools({ "codex-pro": { dispatchable: true }, alternate: { dispatchable: true }, "claude-max": { dispatchable: true } });
    const workspace = join(dir, "gpt-rework-reviewer-depth");
    mkdirSync(workspace, { recursive: true });
    const gpt: Profile = {
      id: "gpt-exec-depth",
      name: "Executor · configured model.1-Sol",
      role: "executor",
      family: "openai",
      provider: "codex",
      model: "demo-v2.1-sol",
      pool: "codex-pro",
      modeId: "full-access",
      thinkingOptionId: "high",
    };
    const task = createTask({ project: "gpt-rework-reviewer-depth", title: "Apply executor depth gate", role: "executor", workspacePath: workspace });
    const ended = new Date().toISOString();
    getDb()
      .prepare("UPDATE tasks SET status = 'rework', executor_agent_id = 'gpt-exec', agent_id = 'rev-agent', executor_profile = ? WHERE id = ?")
      .run(gpt.name, task.id);
    getDb()
      .prepare(
        `INSERT INTO runs (task_id, agent_id, role, profile_name, provider, model, family, thinking_option_id, started_at, ended_at, end_kind)
         VALUES (?, 'gpt-exec', 'executor', ?, 'codex', 'demo-v2.1-sol', 'openai', 'ultra', ?, ?, 'complete')`,
      )
      .run(task.id, gpt.name, ended, ended);
    getDb()
      .prepare(
        ("INSERT INTO runs (task_id, agent_id, role, profile_name, provider, model, family, thinking_option_id, started_at, ended_at, end_kind)\n         VALUES (?, 'rev-agent', 'reviewer', '" + zhCN("labels.role.reviewer") + "', 'claude', 'sonnet', 'anthropic', 'xhigh', ?, ?, 'complete')"),
      )
      .run(task.id, ended, ended);
    const resumed: string[] = [];
    await runTick({
      profiles: [...profiles, gpt],
      launcher: {
        async create() {
          return { id: "should-not-create" };
        },
        async send(id) {
          resumed.push(id);
        },
      },
      config: lockAuto("gpt-rework-reviewer-depth", limits({ global: 50, pools: { alternate: 50, "codex-pro": 50 }, roles: { executor: 50 } })),
    });
    assert.deepEqual(resumed, []);
    const after = getTask(task.id);
    assert.notEqual(after.status, "running");
    assert.match(`${after.blocked_reason ?? ""} ${after.hold_reason ?? ""}`, new RegExp(zhCN("routing.depthNotAllowed")));
  });

  it("still holds a stale pool whose last reading is at the stop line", async () => {
    writePools({ alternate: { dispatchable: false, usedPct: 98 } });
    const old = new Date(Date.now() - 31 * 60 * 1000);
    utimesSync(poolFile, old, old);
    const workspace = join(dir, "stale-work");
    mkdirSync(workspace, { recursive: true });
    const task = createTask({ project: "stale", title: "Do not dispatch stale data blindly", role: "executor", workspacePath: workspace });
    const result = await runTick({
      profiles,
      launcher: launcher(),
      config: lockAuto("stale", limits({ global: 50, pools: { alternate: 50 }, roles: { executor: 50 } })),
    });
    assert.ok(!result.started.includes(task.id));
    const after = getTask(task.id);
    assert.equal(after.status, "ready");
    assert.equal(after.blocked_kind, null);
    assert.match(after.hold_reason ?? "", new RegExp("^" + zhCN("blocked.prefix.quota")));
    assert.match(after.hold_reason ?? "", new RegExp((zhCN("doctor.quota.stale") + " ") + "3\\d " + localePattern(zhCNPart("pools.staleMessage", 17, 25))));
    assert.match(after.hold_reason ?? "", new RegExp(localePattern(zhCNPart("pools.staleStopped", 7, 12)) + "98% " + localePattern(zhCNPart("pools.staleStopped", 20, 26)) + "97%"));
  });

  it("starts from a stale snapshot that still allows the pool, and says the snapshot is stale", async () => {
    writePools({ alternate: { dispatchable: true }, "claude-max": { dispatchable: true } });
    const old = new Date(Date.now() - 45 * 60 * 1000);
    utimesSync(poolFile, old, old);
    const workspace = join(dir, "stale-open");
    mkdirSync(workspace, { recursive: true });
    const task = createTask({ project: "stale-open", title: "Stale data still dispatchable", role: "executor", workspacePath: workspace });
    const result = await runTick({
      profiles,
      launcher: launcher(),
      config: lockAuto("stale-open", limits({ global: 50, pools: { alternate: 50 }, roles: { executor: 50 } })),
    });
    assert.ok(result.started.includes(task.id));
    const started = getDb()
      .prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'started' ORDER BY id DESC LIMIT 1")
      .get(task.id) as { data_json: string };
    assert.match(started.data_json, new RegExp((zhCN("doctor.quota.stale") + " ") + "4\\d " + localePattern(zhCNPart("pools.staleMessage", 17, 25))));
  });

  it("dispatches when the snapshot file is missing, and says so", async () => {
    rmSync(poolFile, { force: true });
    const workspace = join(dir, "no-pools");
    mkdirSync(workspace, { recursive: true });
    const task = createTask({ project: "no-pools", title: "Sample text", role: "executor", workspacePath: workspace });
    const result = await runTick({
      profiles,
      launcher: launcher(),
      config: lockAuto("no-pools", limits({ global: 50, pools: { alternate: 50 }, roles: { executor: 50 } })),
    });
    assert.ok(result.started.includes(task.id));
    const started = getDb()
      .prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'started' ORDER BY id DESC LIMIT 1")
      .get(task.id) as { data_json: string };
    assert.match(started.data_json, new RegExp(localePattern(zhCNPart("pools.absent", 0, 7))));
  });

  it("switches to another pool immediately after a rate limit instead of waiting out the cooldown", async () => {
    const workspace = join(dir, "switch");
    mkdirSync(workspace, { recursive: true });
    writePools({ alternate: { dispatchable: true }, supergrok: { dispatchable: true }, "claude-max": { dispatchable: true } });
    const alt: Profile[] = [
      ...profiles,
      { id: "sg", name: "Executor · Super", role: "candidate", candidateFor: "executor", family: "xai", provider: "grok", model: "grok-4.7", pool: "supergrok" },
    ];
    const task = createTask({ project: "switch", title: "Switch pool", role: "executor", workspacePath: workspace });
    const now = new Date("2026-09-26T18:00:00.000Z");
    getDb()
      .prepare(("UPDATE tasks SET status = 'running', agent_id = 'agent-hot', executor_profile = '" + zhCN("labels.role.executor") + "', handoff_json = ? WHERE id = ?"))
      .run(("{\"summary\":\"" + zhCNPart("tempLand.conflict.withCard", 10, 12) + "Demo text\"}"), task.id);
    getDb()
      .prepare(
        ("INSERT INTO runs (task_id, agent_id, role, profile_name, provider, model, family, started_at)\n         VALUES (?, 'agent-hot', 'executor', '" + zhCN("labels.role.executor") + "', 'alternate', 'grok-4.7', 'xai', ?)"),
      )
      .run(task.id, now.toISOString());
    addComment(task.id, "executor", "Title changed first");
    assert.equal(applyFailure(task.id, "429 Too many requests", "rate_limit", now, "alternate"), "requeue");
    const prompts: string[] = [];
    const released = await runTick({
      profiles: alt,
      now,
      launcher: {
        async create(options) {
          prompts.push(options.prompt ?? "");
          return { id: "agent-cool" };
        },
        async send() {},
      },
      config: lockAuto("switch", limits({ global: 50, pools: { alternate: 50, supergrok: 50, "claude-max": 50 }, roles: { executor: 50 } })),
    });
    assert.ok(released.started.includes(task.id));
    assert.equal(getTask(task.id).executor_profile, "Executor · Super");
    assert.match(prompts[0] ?? "", new RegExp(localePattern(zhCNPart("dispatch.prev.heading", 3, 8))));
    assert.match(prompts[0] ?? "", /429 Too many requests/);
    assert.match(prompts[0] ?? "", new RegExp("Title changed first"));
    assert.match(prompts[0] ?? "", new RegExp(localePattern(zhCNPart("tempLand.conflict.withCard", 10, 12)) + "Demo text"));
  });

  it("waits on quota when no pool can be dispatched, then starts once a pool recovers", async () => {
    const workspace = join(dir, "recover");
    mkdirSync(workspace, { recursive: true });
    writePools({
      alternate: { dispatchable: false, reason: "Executor also edits", usedPct: 91, onlyRoles: ["executor"] },
      "claude-max": { dispatchable: false, usedPct: 40 },
    });
    const task = createTask({ project: "recover", title: "Waiting for quota", role: "executor", workspacePath: workspace });
    const wide = limits({ global: 50, pools: { alternate: 50, "claude-max": 50 }, roles: { executor: 50 } });
    await runTick({ profiles, launcher: launcher(), config: lockAuto("recover", wide) });
    assert.equal(getTask(task.id).status, "ready");
    assert.equal(getTask(task.id).blocked_kind, null);
    assert.match(getTask(task.id).hold_reason ?? "", new RegExp("^" + zhCN("blocked.prefix.quota") + "alternate" + zhCN("nativeSessions.sweep.reasonSep")));
    const heldWait = JSON.parse(
      (getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'held'").get(task.id) as { data_json: string }).data_json,
    ) as { quotaWait: boolean; quota: { generatedAt: string | null; state: string | null; pool: string | null; dispatchable: boolean | null; usedPct: number | null; onlyRoles: string[] | null; matrixGeneratedAt: string | null } };
    assert.equal(heldWait.quotaWait, true);
    assert.equal(heldWait.quota.generatedAt, "2026-10-01T00:00:00.000Z");
    assert.equal(heldWait.quota.state, "fresh");
    assert.equal(heldWait.quota.pool, "alternate");
    assert.equal(heldWait.quota.dispatchable, false);
    assert.equal(heldWait.quota.usedPct, 91);
    assert.deepEqual(heldWait.quota.onlyRoles, ["executor"]);
    assert.equal(heldWait.quota.matrixGeneratedAt, null);
    assert.equal(getDb().prepare("SELECT id FROM events WHERE task_id = ? AND kind = 'blocked'").get(task.id), undefined);
    writePools({ alternate: { dispatchable: true, usedPct: 12, onlyRoles: ["executor"] }, "claude-max": { dispatchable: true } });
    const released = await runTick({ profiles, launcher: launcher(), config: loadConfig() });
    assert.ok(released.started.includes(task.id));
    assert.equal(getTask(task.id).status, "running");
    const started = JSON.parse(
      (getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'started'").get(task.id) as { data_json: string }).data_json,
    ) as { quota: { generatedAt: string | null; state: string | null; pool: string | null; dispatchable: boolean | null; usedPct: number | null; onlyRoles: string[] | null; matrixGeneratedAt: string | null } };
    assert.equal(started.quota.generatedAt, "2026-10-01T00:00:00.000Z");
    assert.equal(started.quota.state, "fresh");
    assert.equal(started.quota.pool, "alternate");
    assert.equal(started.quota.dispatchable, true);
    assert.equal(started.quota.usedPct, 12);
    assert.deepEqual(started.quota.onlyRoles, ["executor"]);
    assert.equal(started.quota.matrixGeneratedAt, null);
  });

  it("puts a deprioritized pool behind another dispatchable pool", async () => {
    writePools({
      alternate: { dispatchable: true, deprioritize: true },
      supergrok: { dispatchable: true, deprioritize: false },
      "claude-max": { dispatchable: true },
    });
    const alt: Profile[] = [
      ...profiles,
      { id: "sg", name: "Executor · Super", role: "candidate", candidateFor: "executor", family: "xai", provider: "grok", model: "grok-4.7", pool: "supergrok" },
    ];
    const workspace = join(dir, "deprio");
    mkdirSync(workspace, { recursive: true });
    const task = createTask({ project: "deprio", title: "Lower priority", role: "executor", workspacePath: workspace });
    const result = await runTick({
      profiles: alt,
      launcher: launcher(),
      config: lockAuto("deprio", limits({ global: 50, pools: { alternate: 50, supergrok: 50, "claude-max": 50 }, roles: { executor: 50 } })),
    });
    assert.ok(result.started.includes(task.id));
    const started = getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'started'").get(task.id) as { data_json: string };
    const data = JSON.parse(started.data_json) as { profile: string; reason: string };
    assert.equal(data.profile, "Executor · Super");
    assert.match(data.reason, new RegExp("Executor · Super"));
  });

  it("keeps a profile override even when another pool is healthier", async () => {
    writePools({
      alternate: { dispatchable: true, deprioritize: true },
      supergrok: { dispatchable: true },
      "claude-max": { dispatchable: true },
    });
    const alt: Profile[] = [
      ...profiles,
      { id: "sg", name: "Executor · Super", role: "candidate", candidateFor: "executor", family: "xai", provider: "grok", model: "grok-4.7", pool: "supergrok" },
    ];
    const workspace = join(dir, "override");
    mkdirSync(workspace, { recursive: true });
    const task = createTask({
      project: "override",
      title: "Sample text",
      role: "executor",
      workspacePath: workspace,
      profileOverride: zhCN("labels.role.executor"),
    });
    const result = await runTick({
      profiles: alt,
      launcher: launcher(),
      config: lockAuto("override", limits({ global: 50, pools: { alternate: 50, supergrok: 50, "claude-max": 50 }, roles: { executor: 50 } })),
    });
    assert.ok(result.started.includes(task.id));
    const started = getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'started'").get(task.id) as { data_json: string };
    const data = JSON.parse(started.data_json) as { profile: string; reason: string };
    assert.equal(data.profile, zhCN("labels.role.executor"));
    assert.match(data.reason, new RegExp(localePattern(zhCNPart("routing.pinnedShort", 5, 9))));
  });

  it("records the pinned profile pool on a quota block and a review hold", async () => {
    writePools({
      alternate: { dispatchable: false, usedPct: 88, onlyRoles: ["executor"], reason: "Executor also edits" },
      "claude-max": { dispatchable: false, usedPct: 70, onlyRoles: ["reviewer"], reason: "Reviewer Demo text" },
    });
    const wide = limits({
      global: 50,
      pools: { alternate: 50, "claude-max": 50 },
      roles: { executor: 50, reviewer: 50 },
    });
    const blockDir = join(dir, "pin-block");
    const holdDir = join(dir, "pin-hold");
    mkdirSync(blockDir, { recursive: true });
    mkdirSync(holdDir, { recursive: true });
    const blockedCard = createTask({
      project: "pin-quota",
      title: "Explicit executor",
      role: "executor",
      workspacePath: blockDir,
      profileOverride: zhCN("labels.role.executor"),
    });
    const heldCard = createTask({
      project: "pin-quota",
      title: "Explicit reviewer",
      role: "reviewer",
      workspacePath: holdDir,
      profileOverride: zhCN("labels.role.reviewer"),
    });
    const result = await runTick({
      profiles,
      launcher: launcher(),
      config: lockAuto("pin-quota", wide),
      matrix: { state: "missing" },
    });
    assert.equal(result.started.includes(blockedCard.id), false);
    assert.equal(result.started.includes(heldCard.id), false);
    assert.equal(getTask(blockedCard.id).status, "ready");
    assert.equal(getTask(blockedCard.id).blocked_kind, null);
    assert.match(getTask(blockedCard.id).hold_reason ?? "", new RegExp("^" + zhCN("blocked.prefix.quota") + "alternate" + zhCN("nativeSessions.sweep.reasonSep")));
    const blocked = JSON.parse(
      (getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'held'").get(blockedCard.id) as { data_json: string }).data_json,
    ) as { quotaWait: boolean; quota: { pool: string | null; dispatchable: boolean | null; usedPct: number | null; onlyRoles: string[] | null; state: string | null } };
    assert.equal(blocked.quotaWait, true);
    assert.equal(blocked.quota.pool, "alternate");
    assert.equal(blocked.quota.dispatchable, false);
    assert.equal(blocked.quota.usedPct, 88);
    assert.deepEqual(blocked.quota.onlyRoles, ["executor"]);
    assert.equal(blocked.quota.state, "fresh");
    assert.equal(getTask(heldCard.id).status, "ready");
    const held = JSON.parse(
      (getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'held'").get(heldCard.id) as { data_json: string }).data_json,
    ) as { kind: string; quota: { pool: string | null; dispatchable: boolean | null; usedPct: number | null; onlyRoles: string[] | null; state: string | null } };
    assert.equal(held.kind, "quota");
    assert.equal(held.quota.pool, "claude-max");
    assert.equal(held.quota.dispatchable, false);
    assert.equal(held.quota.usedPct, 70);
    assert.deepEqual(held.quota.onlyRoles, ["reviewer"]);
    assert.equal(held.quota.state, "fresh");
  });

  it("does not start a pinned decision card when the pool is only for reviewers, and still starts a review", async () => {
    writePools({
      alternate: { dispatchable: true },
      "claude-max": { dispatchable: true, onlyRoles: ["reviewer"] },
    });
    const alt: Profile[] = [
      ...profiles,
      { id: "dc", name: "Decision · Claude", role: "decision", family: "anthropic", provider: "claude", model: "opus", pool: "claude-max" },
    ];
    const workspace = join(dir, "only-roles");
    const reviewDir = join(dir, "only-roles-review");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(reviewDir, { recursive: true });
    const task = createTask({
      project: "only-roles",
      title: "Explicit decision",
      role: "decision",
      workspacePath: workspace,
      profileOverride: "Decision · Claude",
    });
    const config = lockAuto("only-roles", limits({ global: 50, pools: { alternate: 50, "claude-max": 50 }, roles: { executor: 50, reviewer: 50, decision: 50 } }));
    const result = await runTick({ profiles: alt, launcher: launcher(), config, matrix: { state: "missing" } });
    assert.equal(result.started.includes(task.id), false);
    const blocked = getTask(task.id);
    assert.equal(blocked.status, "ready");
    assert.equal(blocked.blocked_kind, null);
    assert.match(blocked.hold_reason ?? "", new RegExp("^" + zhCN("blocked.prefix.quota") + "claude-max" + zhCN("nativeSessions.sweep.reasonSep")));
    assert.match(blocked.hold_reason ?? "", new RegExp(localePattern(zhCN("routing.pinnedBlocked", { name: "Decision · Claude", why: zhCN("pools.onlyFor", {pool:"claude-max",roles:zhCN("labels.role.reviewer")}) }))));
    assert.match(blocked.hold_reason ?? "", new RegExp(zhCN("pools.onlyFor", {pool:"claude-max",roles:zhCN("labels.role.reviewer")})));

    const review = createTask({ project: "only-roles", title: "Wait for review", role: "executor", workspacePath: reviewDir });
    getDb()
      .prepare(("UPDATE tasks SET status = 'in_review', executor_agent_id = ?, executor_profile = '" + zhCN("labels.role.executor") + "', executor_family = 'xai' WHERE id = ?"))
      .run(`exec-${review.id}`, review.id);
    recordFixtureDelivery(review.id, "grok-4.7");
    const started = await runTick({ profiles: alt, launcher: launcher(), config: loadConfig(), matrix: { state: "missing" } });
    assert.ok(started.started.includes(review.id), getTask(review.id).hold_reason ?? getTask(review.id).blocked_reason ?? "");
    assert.equal(getTask(review.id).status, "reviewing");
  });

  it("still starts a pinned decision card when the snapshot has no onlyRoles", async () => {
    writePools({ alternate: { dispatchable: true }, "claude-max": { dispatchable: true } });
    const alt: Profile[] = [
      ...profiles,
      { id: "dc-open", name: "Decision · Claude", role: "decision", family: "anthropic", provider: "claude", model: "opus", pool: "claude-max" },
    ];
    const workspace = join(dir, "only-roles-open");
    mkdirSync(workspace, { recursive: true });
    const task = createTask({
      project: "only-roles-open",
      title: "Old snapshot still dispatches decision",
      role: "decision",
      workspacePath: workspace,
      profileOverride: "Decision · Claude",
    });
    const result = await runTick({
      profiles: alt,
      launcher: launcher(),
      config: lockAuto("only-roles-open", limits({ global: 50, pools: { alternate: 50, "claude-max": 50 }, roles: { decision: 50 } })),
      matrix: { state: "missing" },
    });
    assert.ok(result.started.includes(task.id), getTask(task.id).blocked_reason ?? getTask(task.id).hold_reason ?? "");
    assert.equal(getTask(task.id).status, "running");
  });

  it("does not send a Claude executor back when the pool is only for reviewers", async () => {
    writePools({
      alternate: { dispatchable: true },
      "claude-max": { dispatchable: true, onlyRoles: ["reviewer"] },
    });
    const alt: Profile[] = [
      ...profiles,
      {
        id: "opus",
        name: complexDocsProfileName,
        role: "candidate",
        candidateFor: "executor",
        family: "anthropic",
        provider: "claude",
        model: "opus",
        pool: "claude-max",
      },
    ];
    const workspace = join(dir, "only-roles-rework");
    mkdirSync(workspace, { recursive: true });
    const task = createTask({ project: "only-roles-rework", title: "Sample text Claude", role: "executor", workspacePath: workspace });
    getDb()
      .prepare("UPDATE tasks SET status = 'rework', executor_agent_id = 'orig-opus', agent_id = 'orig-opus', executor_profile = ? WHERE id = ?")
      .run(complexDocsProfileName, task.id);
    const resumed: string[] = [];
    const result = await runTick({
      profiles: alt,
      launcher: {
        async create() {
          return { id: "should-not-create" };
        },
        async send(id) {
          resumed.push(id);
        },
      },
      config: lockAuto("only-roles-rework", limits({ global: 50, pools: { alternate: 50, "claude-max": 50 }, roles: { executor: 50 } })),
      matrix: { state: "missing" },
    });
    assert.deepEqual(resumed, []);
    assert.equal(result.started.includes(task.id), false);
    assert.equal(getTask(task.id).status, "rework");
    assert.match(getTask(task.id).hold_reason ?? "", new RegExp(zhCN("reworkReassign.waitingAutoStart", {"reason":zhCN("pools.onlyFor", {pool:"claude-max",roles:zhCN("labels.role.reviewer")})})));

    getDb().prepare("UPDATE tasks SET status = 'acceptance' WHERE id = ?").run(task.id);
    writePools({ alternate: { dispatchable: true }, "claude-max": { dispatchable: true, onlyRoles: ["executor"] } });
    const allowed = createTask({ project: "only-roles-rework", title: "Executor can return", role: "executor", workspacePath: workspace });
    getDb()
      .prepare("UPDATE tasks SET status = 'rework', executor_agent_id = 'orig-opus-2', agent_id = 'orig-opus-2', executor_profile = ? WHERE id = ?")
      .run(complexDocsProfileName, allowed.id);
    const resumedAfter: string[] = [];
    const again = await runTick({
      profiles: alt,
      launcher: {
        async create() {
          return { id: "should-not-create" };
        },
        async send(id) {
          resumedAfter.push(id);
        },
      },
      config: loadConfig(),
      matrix: { state: "missing" },
    });
    assert.deepEqual(resumedAfter, ["orig-opus-2"]);
    assert.ok(again.started.includes(allowed.id));
    assert.equal(getTask(allowed.id).status, "running");
  });

  it("reserves a reviewer from another family before starting an executor", async () => {
    const alt: Profile[] = [
      { id: "claude-ex", name: "Executor · Claude", role: "executor", family: "anthropic", provider: "claude", model: "sonnet", pool: "claude-max" },
      { id: "xai-ex", name: "Executor · Grok", role: "candidate", candidateFor: "executor", family: "xai", provider: "grok", model: "grok-4.7", pool: "supergrok" },
      { id: "rv", name: zhCN("labels.role.reviewer"), role: "reviewer", family: "anthropic", provider: "claude", model: "sonnet", pool: "claude-max" },
    ];
    const workspace = join(dir, "reserve");
    mkdirSync(workspace, { recursive: true });
    const task = createTask({ project: "reserve", title: "Reserve reviewer", role: "executor", workspacePath: workspace });
    const result = await runTick({
      profiles: alt,
      launcher: launcher(),
      config: lockAuto("reserve", limits({ global: 50, pools: { alternate: 50, supergrok: 50, "claude-max": 50 }, roles: { executor: 50 } })),
    });
    assert.ok(result.started.includes(task.id));
    assert.equal(getTask(task.id).executor_profile, "Executor · Grok");
    assert.equal(getTask(task.id).executor_family, "xai");
  });

  it("blocks on the first other error when maxRetries is 0", () => {
    const task = createTask({ project: "zero", title: "No retry", role: "executor", workspacePath: dir, maxRetries: 0 });
    assert.equal(task.max_retries, 0);
    getDb().prepare("UPDATE tasks SET status = 'running', agent_id = 'agent-zero' WHERE id = ?").run(task.id);
    assert.equal(applyFailure(task.id, "socket hang up", "other"), "block");
    assert.equal(getTask(task.id).fail_count, 1);
    assert.equal(getTask(task.id).status, "blocked");
    assert.equal(getTask(task.id).blocked_kind, "needs_human");
  });

  it("wakes a child builder registered as project leader, then the Kanban fallback if that leader is gone", async () => {
    setAgentAliveCheck((id) => id === "builder" || id === "registrar" || id === "boss");
    const parent = createTask({
      project: "built",
      title: "demo fixture",
      role: "supervisor",
      initialStatus: "triage",
      createdByAgent: "registrar",
    });
    const child = createTask({
      project: "built",
      title: "demo fixture",
      role: "executor",
      workspacePath: dir,
      parentIds: [parent.id],
      createdByAgent: "builder",
    });
    getDb().prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(child.id);
    sent.length = 0;
    const registered = lockAuto(null, limits(), "boss");
    registered.supervisors.built = "builder";
    saveConfig(registered);
    await runTick({ profiles, launcher: launcher(), config: registered });
    assert.equal(getTask(parent.id).status, "acceptance");
    const woke = getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'wake_children'").get(parent.id) as { data_json: string };
    assert.equal(JSON.parse(woke.data_json).agentId, "builder");
    assert.ok(sent.some((item) => item.id === "builder" && item.text.includes(`${cardMark(parent.id)}`)));

    sent.length = 0;
    setAgentAliveCheck((id) => id === "boss");
    const parent2 = createTask({
      project: "built",
      title: "Parent two",
      role: "supervisor",
      initialStatus: "triage",
      createdByAgent: "registrar",
    });
    const child2 = createTask({
      project: "built",
      title: "Child two",
      role: "executor",
      workspacePath: dir,
      parentIds: [parent2.id],
      createdByAgent: "builder",
    });
    getDb().prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(child2.id);
    await runTick({ profiles, launcher: launcher(), config: loadConfig() });
    const woke2 = getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'wake_children'").get(parent2.id) as { data_json: string };
    assert.equal(JSON.parse(woke2.data_json).agentId, "boss");
    assert.equal(JSON.parse(woke2.data_json).fallback, true);
    assert.ok(getTask(parent2.id).unattended_at);
    assert.ok(sent.some((item) => item.id === "boss" && item.text.includes(`${cardMark(parent2.id)}`)));
    assert.equal(sent.some((item) => item.id === "builder" || item.id === "registrar"), false);
  });

  it("runs worktree cards in parallel and keeps one dir card per directory", async () => {
    const repo = join(dir, "repo-wt");
    const room = join(dir, "dir-room");
    const docs = join(dir, "docs-none");
    mkdirSync(repo, { recursive: true });
    mkdirSync(room, { recursive: true });
    mkdirSync(docs, { recursive: true });
    const treeA = createTask({ project: "isolate", title: "Edit documentation A", role: "executor", workspacePath: repo });
    const treeB = createTask({ project: "isolate", title: "Edit documentation B", role: "executor", workspacePath: repo });
    getDb().prepare("UPDATE tasks SET workspace_kind = 'worktree', workspace_base = 'main' WHERE id = ?").run(treeA.id);
    getDb().prepare("UPDATE tasks SET workspace_kind = 'worktree', workspace_base = 'develop' WHERE id = ?").run(treeB.id);
    const dirA = createTask({ project: "isolate", title: "Same directory A", role: "executor", workspacePath: room });
    const dirB = createTask({ project: "isolate", title: "Same directory B", role: "executor", workspacePath: room });
    const noneA = createTask({ project: "isolate", title: "Read-only A", role: "executor", workspacePath: `none:${docs}` });
    const noneB = createTask({ project: "isolate", title: "Read-only B", role: "executor", workspacePath: `none:${docs}` });
    assert.equal(getTask(treeA.id).workspace_kind, "worktree");
    assert.equal(getTask(treeA.id).workspace_base, "main");
    assert.equal(getTask(treeB.id).workspace_base, "develop");
    assert.equal(noneA.workspace_kind, "none");
    const branches: string[] = [];
    const cwds: string[] = [];
    const result = await runTick({
      profiles,
      launcher: {
        async create(options) {
          cwds.push(options.cwd);
          return { id: `iso-${cwds.length}` };
        },
        async send() {},
        async createWorktree(options) {
          branches.push(`${options.baseBranch}:${options.branchName}`);
          const path = join(repo, String(branches.length));
          mkdirSync(path, { recursive: true });
          mkdirSync(join(path, ".git"));
          return { directory: path };
        },
      },
      config: queueOnBusyDir(lockAuto("isolate", limits({ global: 50, pools: { alternate: 50, "claude-max": 50 }, roles: { executor: 50 } })), "isolate"),
    });
    assert.ok(result.started.includes(treeA.id));
    assert.ok(result.started.includes(treeB.id));
    assert.ok(result.started.includes(dirA.id));
    assert.equal(result.started.includes(dirB.id), false);
    assert.match(getTask(dirB.id).hold_reason ?? "", new RegExp(zhCN("schedule.sameWorkspace")));
    assert.ok(result.started.includes(noneA.id));
    assert.ok(result.started.includes(noneB.id));
    assert.deepEqual(branches.sort(), [`main:kanban/${treeA.id}-Edit-documentation-A`, `develop:kanban/${treeB.id}-Edit-documentation-B`].sort());
    const stored = getTask(treeA.id).workspace_path;
    assert.ok(stored && stored !== repo);
    assert.ok(cwds.includes(stored!));
    archiveTask(treeA.id, "test");
    assert.equal(existsSync(stored!), true);
    assert.equal(getTask(treeA.id).workspace_path, stored);
  });
});

describe("directory lock by role", () => {
  const roomy = () => limits({ global: 100, pools: { alternate: 100, "claude-max": 100, "claude-read": 100 }, roles: { executor: 100, reviewer: 100, reader: 100, decision: 100, batch: 100 } });
  const lockProfiles: Profile[] = [
    ...profiles,
    { id: "rd", name: zhCN("labels.role.reader"), role: "reader", family: "xai", provider: "claude", model: "sonnet", pool: "claude-read" },
    { id: "dc", name: zhCN("labels.role.decision"), role: "decision", family: "xai", provider: "claude", model: "opus", pool: "claude-read" },
    { id: "bt", name: zhCN("labels.role.batch"), role: "batch", family: "xai", provider: "alternate", model: "grok-4.7", pool: "alternate" },
  ];
  const alive = () => "alive" as const;

  function room(name: string): string {
    const path = join(dir, name);
    mkdirSync(path, { recursive: true });
    return path;
  }

  /** Puts a card into running or reviewing with a run row, as if an agent were on it. */
  function occupy(id: number, status: "running" | "reviewing", runRole: string, profileName: string): void {
    const at = new Date().toISOString();
    getDb().prepare("UPDATE tasks SET status = ?, agent_id = ?, updated_at = ? WHERE id = ?").run(status, `busy-${id}`, at, id);
    getDb()
      .prepare(
        `INSERT INTO runs (task_id, agent_id, role, profile_name, provider, model, family, started_at)
         VALUES (?, ?, ?, ?, 'claude', 'sonnet', 'anthropic', ?)`,
      )
      .run(id, `busy-${id}`, runRole, profileName, at);
  }

  function toReview(id: number): void {
    getDb()
      .prepare(("UPDATE tasks SET status = 'in_review', executor_agent_id = ?, executor_profile = '" + zhCN("labels.role.executor") + "', executor_family = 'xai' WHERE id = ?"))
      .run(`exec-${id}`, id);
    recordFixtureDelivery(id, "grok-4.7");
  }

  it("queues a second writer behind a running executor in the same directory", async () => {
    const path = room("lock-writers");
    const running = createTask({ project: "lock-w", title: "Editing", role: "executor", workspacePath: path });
    occupy(running.id, "running", "executor", zhCN("labels.role.executor"));
    const executor = createTask({ project: "lock-w", title: "Also edit", role: "executor", workspacePath: path });
    const batch = createTask({ project: "lock-w", title: "Batch also edits", role: "batch", workspacePath: path });
    const result = await runTick({ profiles: lockProfiles, launcher: launcher(), agentState: alive, config: queueOnBusyDir(lockAuto("lock-w", roomy()), "lock-w") });
    assert.equal(result.started.includes(executor.id), false);
    assert.equal(result.started.includes(batch.id), false);
    assert.match(getTask(executor.id).hold_reason ?? "", new RegExp(zhCN("schedule.sameWorkspace")));
    assert.match(getTask(batch.id).hold_reason ?? "", new RegExp(zhCN("schedule.sameWorkspace")));
  });

  it("starts reader, decision, a reviewer card and another card's review beside a running executor", async () => {
    const path = room("lock-readers");
    const running = createTask({ project: "lock-r", title: "Editing", role: "executor", workspacePath: path });
    occupy(running.id, "running", "executor", zhCN("labels.role.executor"));
    const reader = createTask({ project: "lock-r", title: "Reader", role: "reader", workspacePath: path });
    const decision = createTask({ project: "lock-r", title: "demo fixture", role: "decision", workspacePath: path });
    const reviewCard = createTask({ project: "lock-r", title: "Sample text", role: "reviewer", workspacePath: path });
    const done = createTask({ project: "lock-r", title: "Sample text", role: "executor", workspacePath: path });
    toReview(done.id);
    const result = await runTick({ profiles: lockProfiles, launcher: launcher(), agentState: alive, config: lockAuto("lock-r", roomy()) });
    for (const task of [reader, decision, reviewCard, done]) {
      assert.ok(result.started.includes(task.id), `${cardMark(task.id)} ${task.title} Should start:${getTask(task.id).hold_reason ?? ""}`);
      assert.doesNotMatch(getTask(task.id).hold_reason ?? "", new RegExp(localePattern(zhCNPart("schedule.sameWorkspace", 0, 6))));
    }
    assert.equal(getTask(reader.id).status, "running");
    assert.equal(getTask(decision.id).status, "running");
    assert.equal(getTask(reviewCard.id).status, "reviewing");
    assert.equal(getTask(done.id).status, "reviewing");
    assert.equal(getTask(running.id).status, "running");
  });

  it("lets the review and a new executor start while a reader hangs in the directory (DEMO #20 / #17)", async () => {
    const path = room("lock-demo");
    const hung = createTask({ project: "lock-demo", title: "Reader pending", role: "reader", workspacePath: path });
    occupy(hung.id, "running", "reader", zhCN("labels.role.reader"));
    const reviewing = createTask({ project: "lock-demo", title: "Another review running", role: "executor", workspacePath: path });
    occupy(reviewing.id, "reviewing", "reviewer", zhCN("labels.role.reviewer"));
    const occ = currentOccupancy(lockProfiles);
    assert.equal(occ.workspaces.has(path), false);
    const delivered = createTask({ project: "lock-demo", title: "Completed; awaiting review", role: "executor", workspacePath: path });
    toReview(delivered.id);
    const fresh = createTask({ project: "lock-demo", title: "New executor", role: "executor", workspacePath: path });
    const result = await runTick({ profiles: lockProfiles, launcher: launcher(), agentState: alive, config: lockAuto("lock-demo", roomy()) });
    assert.ok(result.started.includes(delivered.id), getTask(delivered.id).hold_reason ?? "");
    assert.equal(getTask(delivered.id).status, "reviewing");
    assert.ok(result.started.includes(fresh.id), getTask(fresh.id).hold_reason ?? "");
    assert.equal(getTask(fresh.id).status, "running");
    assert.ok(currentOccupancy(lockProfiles).workspaces.has(path));
  });

  it("still applies the global and per-role caps to read-only work", async () => {
    const path = room("lock-caps");
    const first = createTask({ project: "lock-cap", title: "Reader one", role: "reader", workspacePath: path });
    const second = createTask({ project: "lock-cap", title: "Reader two", role: "reader", workspacePath: path });
    const result = await runTick({
      profiles: lockProfiles,
      launcher: launcher(),
      agentState: alive,
      config: lockAuto("lock-cap", limits({ global: 100, pools: { "claude-read": 100 }, roles: { reader: (currentOccupancy(lockProfiles).byRole.reader ?? 0) + 1 } })),
    });
    assert.ok(result.started.includes(first.id));
    assert.equal(result.started.includes(second.id), false);
    assert.match(getTask(second.id).hold_reason ?? "", new RegExp(zhCN("schedule.roleFull", {"role":zhCN("labels.role.reader")})));
  });

  it("keeps rework in line with other writers in the same directory", async () => {
    const path = room("lock-rework");
    const running = createTask({ project: "lock-rw", title: "Editing", role: "executor", workspacePath: path });
    occupy(running.id, "running", "executor", zhCN("labels.role.executor"));
    const back = createTask({ project: "lock-rw", title: "Rejected", role: "executor", workspacePath: path });
    getDb()
      .prepare(("UPDATE tasks SET status = 'rework', executor_agent_id = 'orig-rw', agent_id = 'orig-rw', executor_profile = '" + zhCN("labels.role.executor") + "' WHERE id = ?"))
      .run(back.id);
    const resumed: string[] = [];
    const quiet: TickOptions["launcher"] = {
      async create() {
        return { id: `rw-${Date.now()}` };
      },
      async send(id) {
        resumed.push(id);
      },
    };
    const held = await runTick({ profiles: lockProfiles, launcher: quiet, agentState: alive, config: queueOnBusyDir(lockAuto("lock-rw", roomy()), "lock-rw") });
    assert.equal(held.started.includes(back.id), false);
    assert.deepEqual(resumed, []);
    assert.equal(getTask(back.id).status, "rework");
    assert.match(getTask(back.id).hold_reason ?? "", new RegExp(zhCN("schedule.sameWorkspace")));

    getDb().prepare("UPDATE tasks SET status = 'acceptance' WHERE id = ?").run(running.id);
    const resumedTick = await runTick({ profiles: lockProfiles, launcher: quiet, agentState: alive, config: queueOnBusyDir(lockAuto("lock-rw", roomy()), "lock-rw") });
    assert.ok(resumedTick.started.includes(back.id));
    assert.deepEqual(resumed, ["orig-rw"]);
    assert.equal(getTask(back.id).status, "running");

    const next = createTask({ project: "lock-rw", title: "Queued after rework", role: "executor", workspacePath: path });
    const after = await runTick({ profiles: lockProfiles, launcher: quiet, agentState: alive, config: queueOnBusyDir(lockAuto("lock-rw", roomy()), "lock-rw") });
    assert.equal(after.started.includes(next.id), false);
    assert.match(getTask(next.id).hold_reason ?? "", new RegExp(zhCN("schedule.sameWorkspace")));
  });

  it("does not reclaim the first time an assigned agent's file cannot be read", async () => {
    const task = createTask({ project: "miss-once", title: "Transient file loss", role: "executor", workspacePath: dir });
    getDb().prepare("UPDATE tasks SET status = 'running', agent_id = 'agent-miss-once' WHERE id = ?").run(task.id);
    const now = new Date("2026-09-27T11:08:00.000Z");
    const config = lockAuto(null);
    await runTick({ profiles, launcher: launcher(), now, config, agentState: () => "missing" });
    assert.equal(getTask(task.id).status, "running");
    assert.equal(getTask(task.id).agent_id, "agent-miss-once");
    const soon = new Date(now.getTime() + MISSING_CONFIRM_MS - 1);
    await runTick({ profiles, launcher: launcher(), now: soon, config, agentState: () => "missing" });
    assert.equal(getTask(task.id).status, "running");
    const later = new Date(now.getTime() + MISSING_CONFIRM_MS);
    await runTick({ profiles, launcher: launcher(), now: later, config, agentState: () => "missing" });
    assert.equal(getTask(task.id).status, "ready");
    const event = getDb().prepare("SELECT kind, to_status FROM events WHERE task_id = ? AND kind = 'reclaimed'").get(task.id) as {
      kind: string;
      to_status: string;
    };
    assert.equal(event.to_status, "ready");
  });

  it("clears a missing-file miss when the agent can be read again", async () => {
    const task = createTask({ project: "miss-back", title: "File restored", role: "executor", workspacePath: dir });
    getDb().prepare("UPDATE tasks SET status = 'running', agent_id = 'agent-miss-back' WHERE id = ?").run(task.id);
    const now = new Date("2026-09-27T11:09:00.000Z");
    const config = lockAuto(null);
    let state: "missing" | "alive" = "missing";
    await runTick({ profiles, launcher: launcher(), now, config, agentState: () => state });
    state = "alive";
    await runTick({ profiles, launcher: launcher(), now: new Date(now.getTime() + MISSING_CONFIRM_MS), config, agentState: () => state });
    assert.equal(getTask(task.id).status, "running");
    state = "missing";
    await runTick({ profiles, launcher: launcher(), now: new Date(now.getTime() + MISSING_CONFIRM_MS + 1_000), config, agentState: () => state });
    assert.equal(getTask(task.id).status, "running");
  });

  it("still reclaims a closed or errored agent on the first look", async () => {
    const closed = createTask({ project: "gone-now", title: "closed", role: "executor", workspacePath: dir });
    getDb().prepare("UPDATE tasks SET status = 'running', agent_id = 'agent-closed-now' WHERE id = ?").run(closed.id);
    const config = lockAuto(null);
    await runTick({ profiles, launcher: launcher(), config, agentState: () => "error" });
    assert.equal(getTask(closed.id).status, "ready");
  });

  it("does not reclaim while paseo reload rewrites the agent file, and does after it stays missing", async () => {
    const agentId = "reloadagent01";
    const agents = join(dir, "reload-agents");
    const previous = process.env.KANBAN_AGENTS_DIR;
    process.env.KANBAN_AGENTS_DIR = agents;
    const folder = join(agents, agentId.slice(0, 2));
    mkdirSync(folder, { recursive: true });
    const file = join(folder, `${agentId}.json`);
    const live = JSON.stringify({ id: agentId, lastStatus: "running", archivedAt: null, cwd: dir });
    writeFileSync(file, live);
    const task = createTask({ project: "reload-file", title: "Reload overwrites", role: "executor", workspacePath: dir });
    getDb().prepare("UPDATE tasks SET status = 'running', agent_id = ? WHERE id = ?").run(agentId, task.id);
    const config = lockAuto(null);
    const now = new Date("2026-09-27T11:10:00.000Z");
    const state = (id: string | null) => (id === agentId ? agentLiveness(id) : "alive");
    try {
      await runTick({ profiles, launcher: launcher(), now, config, agentState: state });
      assert.equal(getTask(task.id).status, "running");

      writeFileSync(file, "{");
      await runTick({ profiles, launcher: launcher(), now: new Date(now.getTime() + 1_000), config, agentState: state });
      assert.equal(getTask(task.id).status, "running");

      writeFileSync(file, live);
      await runTick({ profiles, launcher: launcher(), now: new Date(now.getTime() + MISSING_CONFIRM_MS + 1_000), config, agentState: state });
      assert.equal(getTask(task.id).status, "running");
      assert.equal(getTask(task.id).agent_id, agentId);

      rmSync(file);
      const goneAt = new Date(now.getTime() + MISSING_CONFIRM_MS + 2_000);
      await runTick({ profiles, launcher: launcher(), now: goneAt, config, agentState: state });
      assert.equal(getTask(task.id).status, "running");
      await runTick({
        profiles,
        launcher: launcher(),
        now: new Date(goneAt.getTime() + MISSING_CONFIRM_MS),
        config,
        agentState: state,
      });
      assert.equal(getTask(task.id).status, "ready");
    } finally {
      if (previous === undefined) delete process.env.KANBAN_AGENTS_DIR;
      else process.env.KANBAN_AGENTS_DIR = previous;
    }
  });
});

describe("started means running", () => {
  const wide = () => limits({ global: 100, pools: { alternate: 100, "claude-max": 100 }, roles: { executor: 100, reviewer: 100 } });

  function eventsOf(id: number, kind: string): Array<{ from_status: string | null; to_status: string | null }> {
    return getDb().prepare("SELECT from_status, to_status FROM events WHERE task_id = ? AND kind = ? ORDER BY id").all(id, kind) as unknown as Array<{
      from_status: string | null;
      to_status: string | null;
    }>;
  }

  function runsOf(id: number): number {
    return (getDb().prepare("SELECT COUNT(*) AS n FROM runs WHERE task_id = ?").get(id) as { n: number }).n;
  }

  it("writes started only together with the running status", async () => {
    const task = createTask({ project: "started-ok", title: "Normal start", role: "executor", workspacePath: join(dir, "started-ok") });
    mkdirSync(join(dir, "started-ok"), { recursive: true });
    const result = await runTick({ profiles, launcher: launcher(), agentState: () => "alive", config: lockAuto("started-ok", wide()) });
    assert.ok(result.started.includes(task.id));
    const started = eventsOf(task.id, "started");
    assert.equal(started.length, 1);
    assert.equal(started[0]?.to_status, "running");
    assert.equal(getTask(task.id).status, "running");
  });

  it("does not write started when the card is reclaimed to ready while its agent is being opened (card #10)", async () => {
    const path = join(dir, "started-race");
    mkdirSync(path, { recursive: true });
    const task = createTask({ project: "started-race", title: "on agent Very slow", role: "executor", workspacePath: path });
    lockAuto("started-race", wide());
    const slow: TickOptions["launcher"] = {
      async create() {
        // A tick past the start grace sees no agent id yet and hands the card back to ready.
        assert.equal(reclaimTask(task.id, new Date(Date.now() + 10 * 60 * 1000)), "reclaimed");
        return { id: "slow-agent" };
      },
      async send() {},
    };
    await assert.rejects(startTask(task.id, slow, "scheduler", { profiles }), new RegExp(localePattern(zhCNPart("dispatch.lostClaim", 35, 41))));
    const after = getTask(task.id);
    assert.equal(after.status, "ready");
    assert.equal(after.agent_id, null);
    assert.equal(eventsOf(task.id, "started").length, 0);
    assert.equal(eventsOf(task.id, "agent_opened").length, 1);
    assert.equal(runsOf(task.id), 0);

    const retry = await runTick({ profiles, launcher: launcher(), agentState: () => "alive", config: lockAuto("started-race", wide()) });
    assert.ok(retry.started.includes(task.id));
    assert.equal(getTask(task.id).status, "running");
    assert.deepEqual(eventsOf(task.id, "started").map((row) => row.to_status), ["running"]);
  });

  it("leaves an archived card archived when it is archived during agent creation", async () => {
    const path = join(dir, "started-archived");
    mkdirSync(path, { recursive: true });
    const task = createTask({ project: "started-archived", title: "Archived during start", role: "executor", workspacePath: path });
    lockAuto("started-archived", wide());
    const racing: TickOptions["launcher"] = {
      async create() {
        getDb().prepare("UPDATE tasks SET status = 'archived' WHERE id = ?").run(task.id);
        return { id: "late-agent" };
      },
      async send() {},
    };
    await assert.rejects(startTask(task.id, racing, "scheduler", { profiles }), new RegExp(localePattern(zhCNPart("dispatch.lostClaim", 35, 41))));
    assert.equal(getTask(task.id).status, "archived");
    assert.equal(eventsOf(task.id, "started").length, 0);
    assert.equal(runsOf(task.id), 0);
  });
});

describe("hold reasons and review waits", () => {
  it("writes a hold reason for every ready or in_review card a tick did not start", async () => {
    const path = join(dir, "hold-all");
    mkdirSync(path, { recursive: true });
    const ready = createTask({ project: "hold-all", title: "Not started", role: "executor", workspacePath: path });
    const review = createTask({ project: "hold-all", title: "Review not opened yet", role: "executor", workspacePath: path });
    getDb()
      .prepare(("UPDATE tasks SET status = 'in_review', executor_agent_id = ?, executor_profile = '" + zhCN("labels.role.executor") + "', executor_family = 'xai' WHERE id = ?"))
      .run("exec-hold", review.id);
    recordFixtureDelivery(review.id, "grok-4.7");
    getDb().prepare("UPDATE tasks SET hold_reason = NULL WHERE id IN (?, ?)").run(ready.id, review.id);
    await runTick({ profiles, launcher: launcher(), config: lockAuto(null), agentState: () => "alive" });
    assert.equal(getTask(ready.id).status, "ready");
    assert.equal(getTask(review.id).status, "in_review");
    const blanks = getDb()
      .prepare("SELECT id, status FROM tasks WHERE status IN ('ready', 'in_review') AND (hold_reason IS NULL OR trim(hold_reason) = '')")
      .all();
    assert.deepEqual(blanks, []);
    assert.match(getTask(ready.id).hold_reason ?? "", new RegExp(zhCN("schedule.autoStartOff")));
    assert.match(getTask(review.id).hold_reason ?? "", new RegExp(zhCN("schedule.autoStartOff")));
  });

  it("waits to review instead of fusing when reviewers use the same model, are paused, or are out of quota", async () => {
    const path = join(dir, "review-wait");
    mkdirSync(path, { recursive: true });
    const sameFamily: Profile = {
      id: "rv-same",
      name: zhCN("labels.role.reviewer"),
      role: "reviewer",
      family: "anthropic",
      provider: "claude",
      model: "sonnet",
      pool: "claude-max",
    };
    const paused: Profile = {
      id: "rv-pause",
      name: "Reviewer · Sample text",
      role: "candidate",
      candidateFor: "reviewer",
      family: "xai",
      provider: "grok",
      model: "grok-4.7",
      pool: "google-review",
    };
    const task = createTask({ project: "review-wait", title: "Wait for different-family reviewer", role: "executor", workspacePath: path });
    getDb()
      .prepare("UPDATE tasks SET status = 'in_review', executor_agent_id = ?, executor_profile = ?, executor_family = 'anthropic' WHERE id = ?")
      .run("exec-opus", complexDocsProfileName, task.id);
    recordFixtureDelivery(task.id, "sonnet");
    writePools({
      alternate: { dispatchable: true },
      "claude-max": { dispatchable: true },
      "google-review": { dispatchable: false, reason: "Quota exhausted" },
    });
    sent.length = 0;
    const wide = limits({
      global: 5000,
      pools: { alternate: 5000, "claude-max": 5000, "google-review": 5000 },
      roles: { executor: 5000, reviewer: 5000 },
    });
    const held = await runTick({
      profiles: [sameFamily, paused],
      launcher: launcher(),
      config: lockAuto("review-wait", wide, "boss"),
      agentState: () => "alive",
    });
    assert.equal(held.started.includes(task.id), false);
    const waiting = getTask(task.id);
    assert.equal(waiting.status, "in_review");
    assert.equal(waiting.blocked_kind, null);
    assert.match(waiting.hold_reason ?? "", /sonnet/);
    assert.match(waiting.hold_reason ?? "", /Quota exhausted/);
    const heldEvent = JSON.parse(
      (getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'held'").get(task.id) as { data_json: string }).data_json,
    ) as { kind: string; quotaWait: boolean; quota: { generatedAt: string | null; state: string | null; pool: string | null; dispatchable: boolean | null; usedPct: number | null; onlyRoles: string[] | null } };
    assert.equal(heldEvent.kind, "quota");
    assert.equal(heldEvent.quotaWait, true);
    assert.equal(heldEvent.quota.generatedAt, "2026-10-01T00:00:00.000Z");
    assert.equal(heldEvent.quota.state, "fresh");
    assert.equal(heldEvent.quota.pool, "google-review");
    assert.equal(heldEvent.quota.dispatchable, false);
    assert.equal(heldEvent.quota.usedPct, null);
    assert.equal(heldEvent.quota.onlyRoles, null);
    assert.equal(sent.some((item) => item.text.includes(`${cardMark(task.id)}`) || item.text.includes(zhCN("cardParts.event.fused"))), false);
    assert.equal(getDb().prepare("SELECT id FROM events WHERE task_id = ? AND kind = 'blocked'").get(task.id), undefined);

    writePools({
      alternate: { dispatchable: true },
      "claude-max": { dispatchable: true },
      "google-review": { dispatchable: true },
    });
    const started = await runTick({
      profiles: [sameFamily, paused],
      launcher: launcher(),
      config: lockAuto("review-wait", wide, "boss"),
      agentState: () => "alive",
    });
    assert.ok(started.started.includes(task.id), getTask(task.id).hold_reason ?? "");
    assert.equal(getTask(task.id).status, "reviewing");
    assert.equal(sent.some((item) => item.text.includes(zhCN("cardParts.event.fused"))), false);
  });

  it("holds an executor on quota when no different-family reviewer can be reserved", async () => {
    const path = join(dir, "no-reviewer");
    mkdirSync(path, { recursive: true });
    const claudeOnly: Profile = {
      id: "cex",
      name: "Executor · Claude",
      role: "executor",
      family: "anthropic",
      provider: "claude",
      model: "sonnet",
      pool: "claude-max",
    };
    const same: Profile = {
      id: "rv-same",
      name: zhCN("labels.role.reviewer"),
      role: "reviewer",
      family: "anthropic",
      provider: "claude",
      model: "sonnet",
      pool: "claude-max",
    };
    const task = createTask({ project: "no-reviewer", title: "No other family can review", role: "executor", workspacePath: path });
    writePools({ "claude-max": { dispatchable: true }, alternate: { dispatchable: true } });
    const held = await runTick({
      profiles: [claudeOnly, same],
      launcher: launcher(),
      config: lockAuto("no-reviewer", limits({ global: 50, pools: { "claude-max": 50, alternate: 50 }, roles: { executor: 50 } })),
      agentState: () => "alive",
    });
    assert.equal(held.started.includes(task.id), false);
    const waiting = getTask(task.id);
    assert.equal(waiting.status, "ready");
    assert.equal(waiting.blocked_kind, null);
    assert.match(waiting.hold_reason ?? "", new RegExp(zhCN("routing.noReviewer")));

    const cursorReview: Profile = {
      id: "xrv",
      name: "Reviewer · GrokSample textCursorSample text",
      role: "candidate",
      candidateFor: "reviewer",
      family: "xai",
      provider: "cursor",
      model: "grok-4.7",
      pool: "cursor",
    };
    const cursorHeld = await runTick({
      profiles: [claudeOnly, same, cursorReview],
      launcher: launcher(),
      config: lockAuto("no-reviewer", limits({ global: 50, pools: { "claude-max": 50, cursor: 50 }, roles: { executor: 50 } })),
      agentState: () => "alive",
    });
    assert.equal(cursorHeld.started.includes(task.id), false);
    assert.match(getTask(task.id).hold_reason ?? "", new RegExp("Cursor " + localePattern(zhCNPart("routing.cursorReadonly", 7, 15))));

    const xaiReview: Profile = {
      id: "grv",
      name: "Reviewer · Grok",
      role: "candidate",
      candidateFor: "reviewer",
      family: "xai",
      provider: "grok",
      model: "grok-4.7",
      pool: "supergrok",
    };
    writePools({ "claude-max": { dispatchable: true }, alternate: { dispatchable: true }, supergrok: { dispatchable: true } });
    const started = await runTick({
      profiles: [claudeOnly, same, xaiReview],
      launcher: launcher(),
      config: lockAuto("no-reviewer", limits({ global: 50, pools: { "claude-max": 50, alternate: 50, supergrok: 50 }, roles: { executor: 50 } })),
      agentState: () => "alive",
    });
    assert.ok(started.started.includes(task.id), getTask(task.id).hold_reason ?? "");
    assert.equal(getTask(task.id).status, "running");
    assert.equal(getTask(task.id).executor_family, "anthropic");
  });
});
