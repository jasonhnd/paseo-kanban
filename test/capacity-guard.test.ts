/// <reference types="node" />
import { zhCN } from "./helpers/locale";
import { DEMO_BANNED, DEMO_FAMILIES, DEMO_PROFILE_RULES } from "./helpers/dispatch-policy";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { formatBytes } from "../shared/capacity-format";
import { setLanguage } from "../shared/i18n";
import { statusLabel } from "../shared/labels";
import { resetAgentAliveCheck, setAgentAliveCheck } from "../server/alive";
import { resetWakeSender, setWakeSender } from "../server/bus";
import { cardMark } from "../server/card-ref";
import {
  capacityHoldReason,
  recordCardWorkBytes,
  refreshCapacityGuard,
  resetCapacityForTests,
  setCapacityProbeForTests,
  type CapacityProbe,
} from "../server/capacity-guard";
import { loadConfig, saveConfig, type KanbanConfig } from "../server/config";
import { closeDb, getDb } from "../server/db";
import { runDoctor } from "../server/doctor";
import { KanbanError } from "../server/errors";
import { acceptTask, completeTask } from "../server/flow";
import type { Profile } from "../server/profiles";
import { claimStatus, createTask, getTask } from "../server/store";
import { listBoard } from "../server/board-cards";
import { getDetail } from "../server/task-detail";
import { startTask } from "./helpers/compat-dispatch";
import { runTick } from "./helpers/compat-schedule";

const GIB = 1024 ** 3;
const dir = mkdtempSync(join(tmpdir(), "kanban-capacity-"));
const dataDir = join(dir, "data");
const workRoot = join(dir, "card-work");
process.env.KANBAN_DATA_DIR = dataDir;
process.env.KANBAN_POOL_STATUS = join(dir, "pool-status.json");
mkdirSync(dataDir, { recursive: true });
mkdirSync(workRoot, { recursive: true });

const profiles: Profile[] = [
  { id: "ex", name: "executor", role: "executor", family: "xai", provider: "cursor", model: "grok-4.7", pool: "cursor" },
  { id: "rv", name: "reviewer", role: "reviewer", family: "anthropic", provider: "claude", model: "sonnet", pool: "claude-max" },
];

const sent: Array<{ id: string; text: string }> = [];

function writePools(): void {
  writeFileSync(process.env.KANBAN_POOL_STATUS!, JSON.stringify({
    generatedAt: "2026-10-01T00:00:00.000Z",
    pools: { cursor: { dispatchable: true }, "claude-max": { dispatchable: true } },
  }));
}

function baseConfig(extra: Record<string, unknown> = {}): KanbanConfig {
  return {
    autoStart: {},
    supervisorAgentId: "leader-1",
    supervisors: {},
    concurrency: { global: 5, pools: {}, roles: {} },
    families: DEMO_FAMILIES,
    bannedProviders: DEMO_BANNED,
    profileRules: DEMO_PROFILE_RULES,
    projects: {
      gauge: { defaultWorkspace: "dir", baseBranch: "main", worktreeLanes: 1, lanesEnabled: false, parallel: false, alwaysTemp: false },
    },
    ...extra,
  } as KanbanConfig;
}

function workspace(name: string): string {
  const path = join(dir, "ws", name);
  mkdirSync(path, { recursive: true });
  return path;
}

function launcher() {
  let n = 0;
  return {
    async create() {
      n += 1;
      return { id: `agent-capacity-${n}` };
    },
    async send() {},
  };
}

function installProbe(probe: CapacityProbe): void {
  setCapacityProbeForTests({ roots: [workRoot], fresh: true, ...probe });
}

function holdFor(workBytes: number, freeBytes: number): string {
  const parts = [
    zhCN("capacity.hold.work", { work: formatBytes(workBytes), max: formatBytes(10 * GIB) }),
    zhCN("capacity.hold.free", { free: formatBytes(freeBytes), min: formatBytes(50 * GIB) }),
  ];
  return zhCN("capacity.hold", { detail: parts.filter((_, index) => index === 0 ? workBytes > 10 * GIB : freeBytes < 50 * GIB).join(zhCN("capacity.sep")) });
}

async function tick() {
  return runTick({
    profiles,
    launcher: launcher(),
    config: loadConfig(),
    agentState: () => "alive",
    send: async (id, text) => { sent.push({ id, text }); },
  });
}

beforeEach(() => {
  resetCapacityForTests();
  sent.length = 0;
  setLanguage("zh-CN");
  setAgentAliveCheck(() => true);
  setWakeSender((id, text) => { sent.push({ id, text }); });
  writePools();
  saveConfig(baseConfig());
});

after(() => {
  resetCapacityForTests();
  resetWakeSender();
  resetAgentAliveCheck();
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe("capacity guard", () => {
  it("pauses new starts and reports red when card work is above 10 GiB, and leaves a running card running", async () => {
    installProbe({ du: () => 11 * GIB, free: () => 80 * GIB });
    const ready = createTask({ project: "gauge", title: "queued", role: "executor", workspacePath: workspace("queued") });
    const running = createTask({ project: "gauge", title: "busy", role: "executor", workspacePath: workspace("busy") });
    getDb().prepare("UPDATE tasks SET status = 'running', agent_id = 'agent-busy' WHERE id = ?").run(running.id);
    await refreshCapacityGuard({ config: loadConfig(), send: async (id, text) => { sent.push({ id, text }); } });
    const result = await tick();
    assert.equal(result.started.includes(ready.id), false);
    assert.equal(getTask(ready.id).status, "ready");
    assert.equal(getTask(ready.id).hold_reason, holdFor(11 * GIB, 80 * GIB));
    assert.equal(getTask(running.id).status, "running");
    const report = await runDoctor({ wake: false, persist: false });
    const red = report.findings.find((item) => item.id === "board:capacity");
    assert.equal(red?.severity, "red");
    assert.match(red?.evidence ?? "", new RegExp(formatBytes(11 * GIB)));
    assert.match(red?.evidence ?? "", new RegExp(formatBytes(10 * GIB)));
    assert.match(red?.evidence ?? "", new RegExp(formatBytes(80 * GIB)));
    assert.match(red?.evidence ?? "", new RegExp(formatBytes(50 * GIB)));
    await assert.rejects(() => startTask(ready.id, launcher(), "supervisor"), (err: unknown) => {
      assert.ok(err instanceof KanbanError);
      assert.equal(err.code, "not_ready");
      assert.equal(err.message, holdFor(11 * GIB, 80 * GIB));
      return true;
    });
    assert.equal(getTask(running.id).status, "running");
    await assert.rejects(() => startTask(running.id, launcher(), "supervisor"), (err: unknown) => {
      assert.ok(err instanceof KanbanError);
      assert.equal(err.code, "conflict");
      return true;
    });
  });

  it("pauses when disk free is below 50 GiB and lists the five largest card directories", async () => {
    const cards = [];
    for (let i = 0; i < 6; i += 1) cards.push(createTask({ project: "gauge", title: `dir ${i}`, role: "executor", workspacePath: dir }));
    const codes = cards.map((task) => cardMark(task.id));
    mkdirSync(join(workRoot, "notes"));
    for (const code of codes) mkdirSync(join(workRoot, code));
    const sizes: Record<string, number> = { [basename(workRoot)]: 12 * GIB, notes: 9 * GIB };
    const ranked = [9, 8, 7, 6, 5, 1];
    codes.forEach((code, index) => { sizes[code] = ranked[index]! * GIB; });
    installProbe({
      du: (path) => sizes[basename(path)] ?? 0,
      free: () => 40 * GIB,
    });
    await refreshCapacityGuard({ config: loadConfig() });
    const ready = cards[0]!;
    const result = await tick();
    assert.equal(result.started.includes(ready.id), false);
    assert.equal(getTask(ready.id).hold_reason, holdFor(12 * GIB, 40 * GIB));
    const report = await runDoctor({ wake: false, persist: false });
    const red = report.findings.find((item) => item.id === "board:capacity");
    assert.equal(red?.severity, "red");
    for (const code of ["notes", codes[0], codes[1], codes[2], codes[3]]) assert.match(red?.evidence ?? "", new RegExp(code!));
    assert.doesNotMatch(red?.evidence ?? "", new RegExp(codes[5]!));
    assert.match(red?.evidence ?? "", new RegExp(zhCN("capacity.status.unknown")));
    assert.match(red?.evidence ?? "", new RegExp(statusLabel("ready")));
  });

  it("resumes new starts after both readings drop back under the limits", async () => {
    installProbe({ du: () => 11 * GIB, free: () => 80 * GIB });
    const task = createTask({ project: "gauge", title: "later", role: "executor", workspacePath: workspace("later") });
    await refreshCapacityGuard({ config: loadConfig() });
    assert.equal((await tick()).started.includes(task.id), false);
    installProbe({ du: () => 1 * GIB, free: () => 80 * GIB });
    await refreshCapacityGuard({ config: loadConfig() });
    assert.equal(capacityHoldReason(), null);
    const report = await runDoctor({ wake: false, persist: false });
    assert.equal(report.findings.some((item) => item.id === "board:capacity"), false);
    const resumed = await tick();
    assert.equal(resumed.started.includes(task.id), true);
    assert.equal(getTask(task.id).status, "running");
  });

  it("uses configured limits, treats non-positive numbers as the defaults, and does not pause exactly at the limit", async () => {
    writeFileSync(join(dataDir, "kanban.config.json"), `${JSON.stringify({
      ...baseConfig(),
      capacity: { maxWorkGiB: 100, minFreeGiB: 1 },
    })}\n`);
    installProbe({ du: () => 11 * GIB, free: () => 40 * GIB });
    await refreshCapacityGuard({ config: loadConfig() });
    assert.equal(capacityHoldReason(), null);

    writeFileSync(join(dataDir, "kanban.config.json"), `${JSON.stringify({
      ...baseConfig(),
      capacity: { maxWorkGiB: 10, minFreeGiB: 50 },
    })}\n`);
    await refreshCapacityGuard({ config: loadConfig() });
    assert.equal(capacityHoldReason(), holdFor(11 * GIB, 40 * GIB));

    writeFileSync(join(dataDir, "kanban.config.json"), `${JSON.stringify({
      ...baseConfig(),
      capacity: { maxWorkGiB: 0, minFreeGiB: 0 },
    })}\n`);
    installProbe({ du: () => 5 * GIB, free: () => 100 * GIB });
    await refreshCapacityGuard({ config: loadConfig() });
    assert.equal(capacityHoldReason(), null);
    installProbe({ du: () => 11 * GIB, free: () => 100 * GIB });
    await refreshCapacityGuard({ config: loadConfig() });
    assert.match(capacityHoldReason() ?? "", new RegExp(formatBytes(10 * GIB)));
    installProbe({ du: () => 1 * GIB, free: () => 10 * GIB });
    await refreshCapacityGuard({ config: loadConfig() });
    assert.match(capacityHoldReason() ?? "", new RegExp(formatBytes(50 * GIB)));

    writeFileSync(join(dataDir, "kanban.config.json"), `${JSON.stringify(baseConfig())}\n`);
    installProbe({ du: () => 10 * GIB, free: () => 50 * GIB });
    await refreshCapacityGuard({ config: loadConfig() });
    assert.equal(capacityHoldReason(), null);
    installProbe({ du: () => 10 * GIB + 1, free: () => 50 * GIB });
    await refreshCapacityGuard({ config: loadConfig() });
    assert.ok(capacityHoldReason());
    installProbe({ du: () => 1 * GIB, free: () => 50 * GIB - 1 });
    await refreshCapacityGuard({ config: loadConfig() });
    assert.ok(capacityHoldReason());

    const plain = join(dataDir, "kanban.config.json");
    writeFileSync(plain, `${JSON.stringify({ language: "en", projects: {} })}\n`);
    saveConfig(loadConfig());
    const saved = JSON.parse(readFileSync(plain, "utf8")) as Record<string, unknown>;
    assert.equal(Object.hasOwn(saved, "capacity"), false);
  });

  it("does not pause when a reading fails and there is no earlier sample, and reuses an over-limit sample without a false clear", async () => {
    installProbe({
      du: () => { throw new Error("du failed"); },
      free: () => 80 * GIB,
    });
    const task = createTask({ project: "gauge", title: "readable", role: "executor", workspacePath: workspace("readable") });
    await refreshCapacityGuard({ config: loadConfig() });
    assert.equal(capacityHoldReason(), null);
    let report = await runDoctor({ wake: false, persist: false });
    assert.equal(report.findings.some((item) => item.id === "board:capacity"), false);
    const info = report.findings.find((item) => item.id === "board:capacity:read");
    assert.equal(info?.severity, "info");
    assert.match(info?.evidence ?? info?.symptom ?? "", /du failed/);
    installProbe({ du: () => 1 * GIB, free: () => 80 * GIB });
    assert.equal((await tick()).started.includes(task.id), true);

    resetCapacityForTests();
    saveConfig(baseConfig());
    installProbe({ du: () => 11 * GIB, free: () => 80 * GIB });
    await refreshCapacityGuard({ config: loadConfig() });
    installProbe({
      du: () => { throw new Error("du failed again"); },
      free: () => 80 * GIB,
    });
    await refreshCapacityGuard({ config: loadConfig() });
    assert.match(capacityHoldReason() ?? "", new RegExp(formatBytes(11 * GIB)));
    report = await runDoctor({ wake: false, persist: false });
    assert.equal(report.findings.find((item) => item.id === "board:capacity")?.severity, "red");
    assert.equal(report.findings.find((item) => item.id === "board:capacity:read")?.severity, "info");

    writeFileSync(join(dataDir, "kanban.config.json"), `${JSON.stringify({
      ...baseConfig(),
      capacity: { maxWorkGiB: 100, minFreeGiB: 1 },
    })}\n`);
    await refreshCapacityGuard({ config: loadConfig() });
    assert.equal(capacityHoldReason(), null);
  });

  it("wakes the leader once per low-capacity episode and does not let doctor send a second reminder", async () => {
    installProbe({ du: () => 11 * GIB, free: () => 80 * GIB });
    await refreshCapacityGuard({ config: loadConfig(), send: async (id, text) => { sent.push({ id, text }); } });
    await refreshCapacityGuard({ config: loadConfig(), send: async (id, text) => { sent.push({ id, text }); } });
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.id, "leader-1");
    assert.match(sent[0]?.text ?? "", new RegExp(zhCN("capacity.wake.title")));
    const before = sent.length;
    await runDoctor({ wake: true, persist: false });
    assert.equal(sent.length, before);
    installProbe({ du: () => 1 * GIB, free: () => 80 * GIB });
    await refreshCapacityGuard({ config: loadConfig(), send: async (id, text) => { sent.push({ id, text }); } });
    installProbe({ du: () => 11 * GIB, free: () => 80 * GIB });
    await refreshCapacityGuard({ config: loadConfig(), send: async (id, text) => { sent.push({ id, text }); } });
    assert.equal(sent.length, 2);

    let attempts = 0;
    resetCapacityForTests();
    saveConfig(baseConfig());
    installProbe({ du: () => 11 * GIB, free: () => 80 * GIB });
    const flaky = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("wake down");
    };
    await refreshCapacityGuard({ config: loadConfig(), send: flaky });
    await refreshCapacityGuard({ config: loadConfig(), send: flaky });
    assert.equal(attempts, 2);
  });

  it("caches du until the directory mtime changes or the reading is marked fresh", async () => {
    mkdirSync(join(workRoot, "cached-child"));
    let calls: string[] = [];
    installProbe({
      fresh: false,
      du: (path) => {
        calls.push(basename(path));
        return basename(path) === "cached-child" ? 4 * GIB : 1 * GIB;
      },
      free: () => 80 * GIB,
    });
    const now = new Date("2026-10-17T00:00:00.000Z");
    await refreshCapacityGuard({ now, config: loadConfig(), notify: false });
    const first = calls.length;
    assert.ok(first >= 2);
    calls = [];
    await refreshCapacityGuard({ now: new Date(now.getTime() + 60_000), config: loadConfig(), notify: false });
    assert.deepEqual(calls, []);
    const bumped = new Date("2026-10-17T00:05:00.000Z");
    utimesSync(join(workRoot, "cached-child"), bumped, bumped);
    await refreshCapacityGuard({ now: new Date(now.getTime() + 120_000), config: loadConfig(), notify: false });
    assert.deepEqual(calls, ["cached-child"]);
    calls = [];
    await refreshCapacityGuard({ now: new Date(now.getTime() + 11 * 60_000), config: loadConfig(), notify: false });
    assert.ok(calls.length >= 2);
    calls = [];
    installProbe({
      fresh: true,
      du: (path) => {
        calls.push(path);
        return 1 * GIB;
      },
      free: () => 80 * GIB,
    });
    await refreshCapacityGuard({ now: new Date(now.getTime() + 12 * 60_000), config: loadConfig(), notify: false });
    assert.ok(calls.length >= 1);
  });

  it("records a card temp directory size once at completion and shows it on the board", async () => {
    const root = process.env.KANBAN_TMP_ROOT ?? workRoot;
    const task = createTask({ project: "gauge", title: "finish", role: "executor", workspacePath: null });
    const code = cardMark(task.id);
    const cardDir = join(root, code);
    mkdirSync(cardDir, { recursive: true });
    writeFileSync(join(cardDir, "blob.bin"), Buffer.alloc(128 * 1024, 1));
    claimStatus(task.id, "ready", "running", "test");
    await completeTask(task.id, "executor", "done", { files: [], verification: "ok", risks: [] });
    const recorded = getTask(task.id).tmp_work_bytes;
    assert.equal(typeof recorded, "number");
    assert.ok((recorded ?? 0) > 0);
    writeFileSync(join(cardDir, "more.bin"), Buffer.alloc(256 * 1024, 2));
    recordCardWorkBytes(task.id);
    assert.equal(getTask(task.id).tmp_work_bytes, recorded);
    assert.equal(listBoard().tasks.find((item) => item.id === task.id)?.workBytes, recorded);
    assert.equal(getDetail(task.id).task.workBytes, recorded);

    const missing = createTask({ project: "gauge", title: "no dir", role: "batch", workspacePath: null });
    claimStatus(missing.id, "ready", "running", "test");
    await completeTask(missing.id, "batch", "done", { files: [], verification: "ok", risks: [] });
    assert.equal(getTask(missing.id).tmp_work_bytes, null);
    assert.equal(getTask(missing.id).status, "acceptance");
    const missingCode = cardMark(missing.id);
    mkdirSync(join(root, missingCode), { recursive: true });
    writeFileSync(join(root, missingCode, "blob.bin"), Buffer.alloc(64 * 1024, 3));
    await acceptTask(missing.id, "supervisor");
    const accepted = getTask(missing.id).tmp_work_bytes;
    assert.equal(typeof accepted, "number");
    assert.ok((accepted ?? 0) > 0);
    assert.equal(getTask(missing.id).status, "done");
  });
});
