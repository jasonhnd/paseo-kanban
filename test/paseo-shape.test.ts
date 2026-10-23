/// <reference types="node" />
import { zhCN, zhCNPart, localePattern } from "./helpers/locale";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { PaseoApi } from "@getpaseo/client";
import { closeDb } from "../server/db";
import { KanbanError } from "../server/errors";
import { bindScheduler, resetSchedulerForTests } from "../server/loop";
import { planTurn } from "../server/nudge";
import { findAgentFile } from "../server/open";
import { listPaseoWorkspaces, readAgentPage, readWorkspacePage } from "../server/paseo";
import { profilesFromText, readProfiles } from "../server/profiles";
import { runTick } from "./helpers/compat-schedule";
import { createTask, getTask } from "../server/store";
import { noteTickSuccess } from "../server/wake";

const tmp = tmpdir();
mkdirSync(tmp, { recursive: true });
const dir = mkdtempSync(join(tmp, "shape-"));
process.env.KANBAN_DATA_DIR = dir;

const workspace = {
  id: "wks",
  name: "main",
  title: null,
  projectId: "p",
  projectRootPath: "/repo",
  workspaceDirectory: "/repo",
  workspaceKind: "local_checkout",
  archivingAt: null,
  pinnedAt: null,
};

function captureError(run: () => Promise<void> | void): Promise<string> {
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  return Promise.resolve()
    .then(run)
    .finally(() => {
      console.error = orig;
    })
    .then(() => lines.join("\n"));
}

after(() => {
  resetSchedulerForTests();
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe("profile file", () => {
  it("rejects a config that is not a profile list", () => {
    assert.throws(() => profilesFromText("{"), new RegExp(zhCN("compat.workspaces.notJson")));
    assert.throws(() => profilesFromText("{}"), new RegExp(zhCN("compat.workspaces.notArray")));
    assert.throws(() => profilesFromText(JSON.stringify({ daemon: { agentProfiles: [{ id: "a", name: "A" }] } })), new RegExp(localePattern(zhCNPart("profiles.itemMissingFields", 19, 40))));
    const ok = profilesFromText(JSON.stringify({ daemon: { agentProfiles: [{ id: "a", name: "A", provider: "alternate" }] } }));
    assert.equal(ok[0]?.name, "A");
  });

  it("throws when the file cannot be read, instead of dispatching with an empty roster", () => {
    process.env.KANBAN_PASEO_CONFIG = join(dir, "missing-config.json");
    assert.throws(() => readProfiles(), new RegExp(localePattern(zhCNPart("profiles.unreadable", 0, 12))));
    delete process.env.KANBAN_PASEO_CONFIG;
  });
});

describe("turn payload", () => {
  it("skips a round when the outcome or timeline shape changed", () => {
    assert.equal(planTurn(null, []).action, "skip");
    assert.equal(planTurn({ kind: "completed" }, { not: "array" }).action, "skip");
    const failed = planTurn({ kind: "failed" }, []);
    assert.equal(failed.action, "failed");
    if (failed.action === "failed") assert.match(failed.message, new RegExp(localePattern(zhCNPart("nudge.failed.noMessage", 6, 22))));
    const done = planTurn({ kind: "completed" }, [{ type: "tool_call", name: "kanban_complete" }]);
    assert.deepEqual(done, { action: "completed", finished: true });
  });
});

describe("daemon list pages", () => {
  it("requires pageInfo.nextCursor and archivedAt, and stops when the alternate does not advance", async () => {
    assert.throws(() => readWorkspacePage({ entries: [workspace], pageInfo: {} }), /pageInfo.nextCursor/);
    const page = readWorkspacePage({ entries: [workspace], pageInfo: { nextCursor: null } });
    assert.equal(page.entries[0]?.kind, "local_checkout");
    assert.equal(page.nextCursor, null);
    assert.throws(
      () => readAgentPage({ entries: [{ agent: { id: "a", workspaceId: "wks" } }], pageInfo: { nextCursor: null } }),
      /archivedAt/,
    );
    const agent = readAgentPage({
      entries: [{ agent: { id: "a", archivedAt: null, workspaceId: "wks" } }],
      pageInfo: { nextCursor: null },
    });
    assert.equal(agent.agents[0]?.archived, false);

    const stuck = {
      workspaces: {
        async list() {
          return { entries: [workspace], pageInfo: { nextCursor: "same" } };
        },
      },
    } as unknown as PaseoApi;
    await assert.rejects(listPaseoWorkspaces(stuck), (err: unknown) => {
      assert.ok(err instanceof KanbanError);
      assert.match(err.message, new RegExp("nextCursor " + localePattern(zhCNPart("paseo.shape.cursorStuck", 21, 25))));
      return true;
    });
  });
});

describe("local paseo files", () => {
  it("treats a broken agent file as missing and keeps going", async () => {
    const agents = join(dir, "agents");
    process.env.KANBAN_AGENTS_DIR = agents;
    const folder = join(agents, "ab");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "abcd.json"), "{");
    const broken = await captureError(() => {
      assert.equal(findAgentFile("abcd"), null);
    });
    assert.match(broken, /is unreadable/);

    writeFileSync(
      join(folder, "abcd.json"),
      JSON.stringify({ id: "abcd", cwd: dir, workspaceId: "wks", labels: [], archivedAt: 1, title: "A", provider: "alternate" }),
    );
    const odd = await captureError(() => {
      const file = findAgentFile("abcd");
      assert.equal(file?.archivedAt, null);
      assert.deepEqual(file?.labels, {});
    });
    assert.match(odd, /archivedAt/);
    assert.match(odd, /labels/);

    delete process.env.KANBAN_AGENTS_DIR;
  });
});

describe("scheduler skips a bad round", () => {
  it("does not start or block a card when profiles cannot be read", async () => {
    noteTickSuccess();
    resetSchedulerForTests();
    process.env.KANBAN_PASEO_CONFIG = join(dir, "missing-config.json");
    const root = join(dir, "repo");
    mkdirSync(root, { recursive: true });
    const task = createTask({ project: "shape", title: "Broken profile", role: "executor", workspacePath: root });
    let created = 0;
    const bound = bindScheduler({
      intervalMs: 3_600_000,
      ready: () => ({
        launcher: {
          async create() {
            created += 1;
            return { id: "should-not" };
          },
          async send() {},
        },
        config: {
          autoStart: { shape: true },
          supervisorAgentId: null,
          supervisors: {},
          concurrency: { global: 4, pools: {}, roles: {} },
        },
      }),
    });
    const logged = await captureError(() => bound.kick());
    assert.match(logged, /profiles/);
    assert.equal(created, 0);
    const after = getTask(task.id);
    assert.equal(after.status, "ready");
    assert.equal(after.blocked_kind, null);
    bound.release();
    noteTickSuccess();
    delete process.env.KANBAN_PASEO_CONFIG;
  });

  it("does not create a workspace when the workspace list shape is wrong", async () => {
    const root = join(dir, "place");
    mkdirSync(root, { recursive: true });
    const task = createTask({ project: "place", title: "Broken list", role: "executor", workspacePath: root });
    let created = 0;
    await runTick({
      profiles: [
        { id: "ex", name: zhCN("labels.role.executor"), role: "executor", family: "xai", provider: "alternate", model: "grok" },
        { id: "rv", name: zhCN("labels.role.reviewer"), role: "reviewer", family: "anthropic", provider: "claude", model: "sonnet" },
      ],
      pools: {
        state: "fresh",
        message: (zhCNPart("compat.name.offlineTest", 2, 4) + zhCNPart("profiles.testSnapshot", 5, 7)),
        generatedAt: null,
        dispatchable: () => true,
        entry: () => ({ dispatchable: true, deprioritize: false, prefer: false, resetsAt: null, reason: null, onlyRoles: null }),
      },
      config: {
        autoStart: { place: true },
        supervisorAgentId: null,
        supervisors: {},
        concurrency: { global: 4, pools: {}, roles: {} },
      },
      launcher: {
        async listWorkspaces() {
          throw new KanbanError("paseo_shape", zhCN("paseo.shape.workspaceListNoCursor"));
        },
        async createDirectoryWorkspace() {
          created += 1;
          return { id: "new", directory: root, name: "new" };
        },
        async create() {
          created += 1;
          return { id: "agent" };
        },
        async send() {},
      },
    });
    assert.equal(created, 0);
    const after = getTask(task.id);
    assert.equal(after.status, "ready");
    assert.match(after.hold_reason ?? "", /pageInfo.nextCursor/);
  });
});
