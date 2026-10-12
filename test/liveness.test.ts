/// <reference types="node" />
import { zhCN, zhCNPart, localePattern } from "./helpers/locale";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { setWakeSender } from "../server/bus";
import { checkSchedulerTick, runCompat, type CompatDeps } from "../server/compat";
import { saveConfig, DEFAULT_CONCURRENCY, type KanbanConfig } from "../server/config";
import { closeDb, getDb } from "../server/db";
import { checkSchedulerIdle, currentSchedulerIdleNote, noteSchedulerTick, resetSchedulerTickForTests } from "../server/liveness";
import { createTask } from "../server/store";
import { resetAgentAliveCheck, resetBoardWakeForTests, setAgentAliveCheck } from "../server/wake";
import { schedulerIdleNote } from "../shared/scheduler";

const tmp = tmpdir();
mkdirSync(tmp, { recursive: true });
const dir = mkdtempSync(join(tmp, "liveness-"));
process.env.KANBAN_DATA_DIR = dir;

const sent: string[] = [];

function config(): void {
  const saved: KanbanConfig = {
    autoStart: {},
    supervisorAgentId: "boss",
    supervisors: {},
    concurrency: {
      global: DEFAULT_CONCURRENCY.global,
      pools: { ...DEFAULT_CONCURRENCY.pools },
      roles: { ...DEFAULT_CONCURRENCY.roles },
    },
  };
  saveConfig(saved);
}

function okDeps(): CompatDeps {
  return {
    stepTimeoutMs: 2_000,
    checkTimeoutMs: 2_000,
    daemonTimeoutMs: 2_000,
    async typecheck() {
      return { ok: true, detail: "" };
    },
    async offlineTest() {
      return { ok: true, detail: "" };
    },
    async pluginTable() {
      return [
        "PLUGIN                STATUS      ENABLED   SOURCE            REVISION          DIRECTORY         ERROR",
        "paseo-kanban          running     yes       /repo             -                 /repo",
      ].join("\n");
    },
    async pluginJson() {
      return JSON.stringify([{ id: "paseo-kanban", status: "running" }]);
    },
    async ping() {
      return { code: 0, stdout: "kanban-pong\n", stderr: "" };
    },
    async list() {
      return { code: 0, stdout: JSON.stringify({ projects: ["a"], tasks: [] }), stderr: "" };
    },
    async version() {
      return "0.9.2\n";
    },
    async openHelp() {
      return "--json";
    },
    files: () => [{ name: zhCN("compat.name.profiles"), status: "pass", detail: "1 demo fixture" }],
    async daemon() {
      return [{ name: "daemon websocket", status: "pass", detail: "ws://127.0.0.1:6767/ws" }];
    },
  };
}

after(() => {
  resetAgentAliveCheck();
  resetBoardWakeForTests();
  resetSchedulerTickForTests();
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe("scheduler liveness", () => {
  it("shows a board note after 3 minutes without a tick", () => {
    const now = Date.parse("2026-09-27T12:00:00.000Z");
    assert.equal(schedulerIdleNote(new Date(now - 2 * 60 * 1000).toISOString(), now), null);
    const note = schedulerIdleNote(new Date(now - 3 * 60 * 1000 - 1).toISOString(), now);
    assert.match(note ?? "", new RegExp("^" + localePattern(zhCNPart("scheduler.idle", 0, 12)) + "2026-09-27 11:56:59Z" + localePattern(zhCNPart("missingCwd.none", 3, 4))));
    const at = new Date(now - 4 * 60 * 1000).toISOString();
    noteSchedulerTick(new Date(at));
    assert.equal(currentSchedulerIdleNote(now), schedulerIdleNote(at, now));
    assert.equal(readFileSync(new URL("../server/liveness.ts", import.meta.url), "utf8").includes(zhCN("wake.board.schedulerIdle")), false);
    resetSchedulerTickForTests();
  });

  it("wakes the Kanban supervisor once after 5 minutes when a card is waiting, without a scheduler tick", () => {
    resetBoardWakeForTests();
    resetSchedulerTickForTests();
    config();
    setAgentAliveCheck(() => true);
    setWakeSender((id, text) => {
      sent.push(`${id}:${text}`);
    });
    const now = Date.parse("2026-09-27T12:10:00.000Z");
    noteSchedulerTick(new Date(now - 4 * 60 * 1000));
    createTask({ project: "idle", title: "Still waiting", role: "executor", workspacePath: dir });
    assert.equal(checkSchedulerIdle(now), false);
    sent.length = 0;
    noteSchedulerTick(new Date(now - 5 * 60 * 1000 - 1));
    assert.equal(checkSchedulerIdle(now), true);
    assert.equal(checkSchedulerIdle(now), false);
    assert.equal(sent.length, 1);
    assert.match(sent[0] ?? "", new RegExp("boss:" + localePattern(zhCNPart("wake.board.problem", 0, 5)) + zhCN("wake.board.schedulerIdle")));
    assert.match(sent[0] ?? "", new RegExp(localePattern(zhCNPart("compat.tick.last", 0, 3))));
    noteSchedulerTick(new Date(now));
    assert.equal(checkSchedulerIdle(now + 1_000), false);
    noteSchedulerTick(new Date(now - 6 * 60 * 1000));
    assert.equal(checkSchedulerIdle(now), true);
  });

  it("does not wake when nothing is waiting", () => {
    resetBoardWakeForTests();
    getDb().prepare("UPDATE tasks SET status = 'done' WHERE status IN ('ready', 'in_review')").run();
    const now = Date.now();
    noteSchedulerTick(new Date(now - 10 * 60 * 1000));
    const before = sent.length;
    assert.equal(checkSchedulerIdle(now), false);
    assert.equal(sent.length, before);
  });

  it("fails compat when the recorded tick is older than 5 minutes", async () => {
    const now = Date.now();
    const stale = checkSchedulerTick(new Date(now - 5 * 60 * 1000 - 1).toISOString(), now);
    assert.equal(stale.status, "fail");
    assert.match(stale.detail, new RegExp(zhCN("compat.tick.late", {shown:".+"})));
    assert.equal(checkSchedulerTick(new Date(now).toISOString(), now).status, "pass");
    assert.equal(checkSchedulerTick(null, now).status, "pass");
    noteSchedulerTick(new Date(now - 6 * 60 * 1000));
    const result = await runCompat(okDeps());
    assert.equal(result.code, 1);
    assert.match(result.lines.join("\n"), new RegExp(zhCN("compat.line.fail", {"name":zhCN("compat.name.schedulerTick"),"detail":zhCN("compat.tick.late", {shown:".+"})})));
    assert.match(result.lines.at(-1) ?? "", new RegExp("^" + localePattern(zhCNPart("compat.failed", 0, 7)) + zhCN("compat.name.schedulerTick") + "$"));
  });
});