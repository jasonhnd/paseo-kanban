/// <reference types="node" />
import { zhCN, zhCNPart, localePattern } from "./helpers/locale";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { after, describe, it } from "node:test";
import type { PaseoApi } from "@getpaseo/client";
import {
  checkAgentDir,
  checkAutoArchiveAfterMergeText,
  checkWorkspaceAgentCwd,
  checkWorktreeSlugSource,
  checkProfileText,
  checkWorkspacesText,
  childEnv,
  conclude,
  inspectDaemon,
  localFileChecks,
  parseBoardJson,
  parsePluginJson,
  parsePluginTable,
  runCompat,
  runCompatChecked,
  runCompatCommand,
  realDeps,
  offlineTestTimeoutMs,
  DEFAULT_OFFLINE_TEST_TIMEOUT_MS,
  withTimeout,
  type CompatDeps,
} from "../server/compat";
import { closeDb, getDb } from "../server/db";
import { ensureSupervisorToken } from "../server/tokens";

const dir = mkdtempSync(join(tmpdir(), "kanban-compat-test-"));

it("checks the selected demo home rather than the user's default daemon files", () => {
  const home = join(dir, "demo-home");
  mkdirSync(join(home, "projects"), { recursive: true });
  mkdirSync(join(home, "agents", "demo"), { recursive: true });
  writeFileSync(join(home, "config.json"), JSON.stringify({ daemon: { agentProfiles: [] } }));
  writeFileSync(join(home, "projects", "workspaces.json"), JSON.stringify([
    { workspaceId: "demo", cwd: join(home, "repo"), kind: "directory", archivedAt: null },
  ]));
  writeFileSync(join(home, "agents", "demo", "agent.json"), JSON.stringify({
    id: "demo", provider: "codex", workspaceId: "demo", archivedAt: null,
    cwd: join(home, "repo"), title: "Demo", labels: {}, config: {},
  }));
  writeFileSync(join(home, "server-id"), "demo-server");
  const env = { PASEO_HOME: home, KANBAN_DATA_DIR: join(home, "board") };
  const fleet = join(env.KANBAN_DATA_DIR, "fleet");
  mkdirSync(fleet, { recursive: true });
  const checks = localFileChecks(env);
  assert.equal(checks.find((check) => check.name === "workspaces.json")?.status, "pass");
  assert.equal(checks.find((check) => check.name === "server-id")?.status, "pass");
  // Corrupt only this home's files: a fallback to ~/.paseo would miss both failures.
  writeFileSync(join(home, "config.json"), "not JSON");
  writeFileSync(join(home, "server-id"), "");
  writeFileSync(join(fleet, "dispatch-matrix.json"), "not JSON");
  const broken = localFileChecks(env);
  assert.equal(broken.find((check) => check.name === "server-id")?.status, "fail");
  assert.ok(broken.filter((check) => check.status === "fail").length >= 3);
});

const table = [
  "PLUGIN                STATUS      ENABLED   SOURCE            REVISION          DIRECTORY         ERROR",
  "paseo-kanban          running     yes       /repo             -                 /repo",
].join("\n");

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

function okDeps(patch: Partial<CompatDeps> = {}): CompatDeps {
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
      return table;
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
      return "Usage: paseo agent open\n  --json";
    },
    files: () => [{ name: zhCN("compat.name.profiles"), status: "pass", detail: "1 demo fixture" }],
    async daemon() {
      return [
        { name: "daemon websocket", status: "pass", detail: "ws://127.0.0.1:6767/ws" },
        { name: zhCN("compat.name.workspaceList"), status: "pass", detail: "demo fixture 1 sample" },
      ];
    },
    ...patch,
  };
}

after(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe("compat report", () => {
  it("prints one line per check and a Chinese pass line", async () => {
    const result = await runCompat(okDeps());
    assert.equal(result.code, 0);
    assert.match(result.lines[0] ?? "", new RegExp(zhCN("compat.name.typecheck") + localePattern(zhCNPart("wake.review.approved", 4, 7))));
    assert.match(result.lines.at(-1) ?? "", new RegExp("^" + localePattern(zhCNPart("compat.passed", 0, 13)) + "0\\.9\\.2" + localePattern(zhCNPart("missingCwd.none", 3, 4)) + "$"));
    assert.ok(result.lines.some((line) => line.startsWith((zhCN("compat.name.beforeCreate") + zhCNPart("compat.line.skip", 6, 9)))));
  });

  it("fails on the first broken check and does not hang when the daemon never answers", async () => {
    const started = Date.now();
    const result = await runCompat(
      okDeps({
        daemonTimeoutMs: 150,
        daemon: () =>
          new Promise((resolve) => {
            const timer = setTimeout(() => resolve([{ name: "daemon websocket", status: "pass", detail: "late" }]), 5_000);
            (timer as unknown as { unref?: () => void }).unref?.();
          }),
      }),
    );
    // The never-answering daemon would resolve at 5s, so anything below that proves the 150ms cut-off fired.
    assert.ok(Date.now() - started < 4_000, `compat waited ${Date.now() - started}ms on a daemon that never answers`);
    assert.equal(result.code, 1);
    assert.match(result.lines.at(-1) ?? "", new RegExp("^" + localePattern(zhCNPart("compat.failed", 0, 7)) + "daemon websocket$"));
    assert.ok(result.lines.some((line) => line.includes(zhCN("audit.timeout"))));
  });

  it("names a plugin that is not running", () => {
    const bad = parsePluginTable(table.replace("running", "error"));
    assert.equal(bad.ok, false);
    assert.match(bad.detail, new RegExp(localePattern(zhCNPart("doctor.plugin.unknown", 2, 4))));
    const withError = parsePluginTable(`${table}   boom`);
    assert.equal(withError.ok, false);
    assert.equal(parsePluginJson("[]").ok, false);
    assert.equal(parseBoardJson('{"projects":[],"tasks":[]}').ok, true);
    const concluded = conclude([{ name: "daemon websocket", status: "fail", detail: "sample Not sample" }], null);
    assert.equal(concluded.lines.at(-1), zhCN("compat.failed", {"reason":"daemon websocket"}));
  });

  it("rejects a hung promise", async () => {
    const late = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 30_000);
      (timer as unknown as { unref?: () => void }).unref?.();
    });
    await assert.rejects(withTimeout(late, 50, zhCNPart("wake.board.stalled", 5, 8)), new RegExp(localePattern(zhCNPart("wake.board.stalled", 5, 8))));
  });
});

describe("compat offline budget", () => {
  it("defaults to twice the observed 300s suite and validates overrides", () => {
    assert.equal(DEFAULT_OFFLINE_TEST_TIMEOUT_MS, 600_000);
    assert.equal(offlineTestTimeoutMs({}), 600_000);
    assert.equal(offlineTestTimeoutMs({ KANBAN_COMPAT_OFFLINE_TEST_TIMEOUT_MS: " 750000 " }), 750_000);
    for (const raw of ["0", "-1", "NaN", "Infinity", "1.5", "2147483647"]) {
      assert.throws(() => offlineTestTimeoutMs({ KANBAN_COMPAT_OFFLINE_TEST_TIMEOUT_MS: raw }), new RegExp(localePattern(zhCNPart("compat.env.offlineTimeout", 41, 46))));
    }
    const deps = realDeps({ KANBAN_DATA_DIR: dir, KANBAN_COMPAT_OFFLINE_TEST_TIMEOUT_MS: "750000" });
    try { assert.equal(deps.offlineTestTimeoutMs, 750_000); }
    finally { deps.cleanup?.(); }
  });

  it("gives offline tests their own budget while typecheck retains its limit", async () => {
    const result = await runCompat(okDeps({ checkTimeoutMs: 10, offlineTestTimeoutMs: 30_000,
      offlineTest: async () => { await new Promise(resolve => setTimeout(resolve, 30)); return { ok: true, detail: "" }; },
    }));
    assert.equal(result.code, 0);
  });

  it("keeps performance skip reasons visible in the compatibility report", async () => {
    const reason = "PERFORMANCE LOAD High load, skip timing threshold;loadavg=[40,50,60] availableCPUs=8";
    const result = await runCompat(okDeps({ offlineTest: async () => ({ ok: true, detail: reason }) }));
    assert.equal(result.code, 0);
    assert.ok(result.lines.some(line => line.includes(reason)));
  });

  it("reports actual elapsed time and budget when offline tests hang", async () => {
    const result = await runCompat(okDeps({ offlineTestTimeoutMs: 10, offlineTest: () => new Promise(() => {}) }));
    assert.equal(result.code, 1);
    assert.ok(result.lines.some(line => new RegExp(zhCN("compat.name.offlineTest") + ".*" + zhCN("audit.timeout") + ".*" + localePattern(zhCNPart("compat.commandTimeout", 3, 8)) + "\\d+ms" + localePattern(zhCNPart("compat.commandTimeout", 19, 23)) + "10ms").test(line)));
  });

  it("reports elapsed time and budget from a real timed-out subprocess", async () => {
    const output = await runCompatCommand(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], 50, process.env);
    assert.equal(output.code, 124);
    assert.match(output.stderr, new RegExp(zhCN("compat.commandTimeout", {"elapsed":"\\d+","budget":"50"})));
  });

  it("passes the configured budget to the actual offline child command", async () => {
    const bin = join(dir, "budget-bin"); mkdirSync(bin);
    const npm = join(bin, "npm");
    writeFileSync(npm, `#!${process.execPath}\nsetTimeout(() => {}, 30000);\n`); chmodSync(npm, 0o755);
    const deps = realDeps({ ...process.env, KANBAN_DATA_DIR: dir, PATH: `${bin}:${process.env.PATH}`,
      KANBAN_COMPAT_OFFLINE_TEST_TIMEOUT_MS: "50" });
    try {
      const output = await deps.offlineTest();
      assert.equal(output.ok, false);
      assert.match(output.detail, new RegExp(zhCN("compat.commandTimeout", {"elapsed":"\\d+","budget":"50"})));
    } finally { deps.cleanup?.(); }
  });

  it("keeps the explicit overall cap and cleans up on timeout", async () => {
    let cleaned = false;
    const result = await runCompatChecked({ KANBAN_COMPAT_TIMEOUT_MS: "10" }, okDeps({
      offlineTestTimeoutMs: 100, offlineTest: () => new Promise(() => {}), cleanup: () => { cleaned = true; },
    }));
    assert.equal(result.code, 1);
    assert.match(result.lines[0], new RegExp(zhCN("compat.run.overallTimeout") + ".*" + localePattern(zhCNPart("compat.commandTimeout", 3, 8)) + "\\d+ms" + localePattern(zhCNPart("compat.commandTimeout", 19, 23)) + "10ms"));
    assert.equal(cleaned, true);
  });
});

describe("local file checks", () => {
  it("requires cursor auto_accept to be boolean and workspace fields to exist", () => {
    const profiles = checkProfileText(
      JSON.stringify({
        daemon: {
          agentProfiles: [
            { id: "c", name: zhCN("labels.role.executor"), provider: "cursor", featureValues: { auto_accept: true } },
            { id: "g", name: zhCN("labels.role.reviewer"), provider: "claude" },
          ],
        },
      }),
    );
    assert.equal(profiles[1]?.status, "pass");
    const workspaces = checkWorkspacesText(
      JSON.stringify([{ workspaceId: "w", cwd: "/repo", kind: "worktree", archivedAt: null, mainRepoRoot: "/repo" }]),
    );
    assert.equal(workspaces.status, "pass");
    assert.equal(checkWorkspacesText("{}").status, "fail");
  });

  it("passes when one agent record still has archivedAt", () => {
    const agents = join(dir, "agents");
    const folder = join(agents, "ab");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "old.json"), JSON.stringify({ id: "old", provider: "cursor" }));
    writeFileSync(
      join(folder, "full.json"),
      JSON.stringify({
        id: "full",
        provider: "cursor",
        cwd: "/repo",
        title: "A",
        workspaceId: "w",
        archivedAt: null,
        labels: { role: "executor" },
        config: { model: "grok" },
      }),
    );
    const result = checkAgentDir(agents);
    assert.equal(result.status, "pass");
  });
});

describe("daemon inspection", () => {
  it("reads list fields and does not call create or archive", async () => {
    let created = 0;
    const client = {
      workspaces: {
        async list() {
          return { entries: [workspace], pageInfo: { nextCursor: null } };
        },
        create() {
          created += 1;
        },
        archive() {
          created += 1;
        },
        ref() {
          return { agents: { create() { created += 1; } }, archive() { created += 1; } };
        },
      },
      agents: {
        async list() {
          return { entries: [{ agent: { id: "a", archivedAt: null, workspaceId: "wks" } }], pageInfo: { nextCursor: null } };
        },
        create() {
          created += 1;
        },
        ref() {
          return {
            archive() { created += 1; },
            send() { created += 1; },
            respondToPermission() { created += 1; },
          };
        },
      },
      providers: {
        listModels() {
          created += 1;
          return Promise.resolve({ models: [] });
        },
      },
    } as unknown as PaseoApi;
    const checks = await inspectDaemon(client);
    assert.equal(created, 0);
    assert.ok(checks.every((item) => item.status === "pass"));
  });
});

describe("workspace cwd", () => {
  it("still finds that a workspace create drops cwd", () => {
    const result = checkWorkspaceAgentCwd();
    assert.equal(result.status, "pass");
    assert.match(result.detail, new RegExp(localePattern(zhCNPart("compat.source.cwdOk", 36, 49))));
  });
});

describe("Paseo merge auto-archive (TEST_0268)", () => {
  it("finds worktreeSlug in the installed worktree source", () => {
    const result = checkWorktreeSlugSource();
    assert.equal(result.status, "pass", result.detail);
  });

  it("reports the autoArchiveAfterMerge switch without failing on either value", () => {
    assert.equal(checkAutoArchiveAfterMergeText(JSON.stringify({ daemon: { autoArchiveAfterMerge: true } })).status, "pass");
    assert.match(checkAutoArchiveAfterMergeText(JSON.stringify({ daemon: { autoArchiveAfterMerge: true } })).detail, new RegExp(localePattern(zhCNPart("compat.autoArchive.on", 0, 2))));
    assert.match(checkAutoArchiveAfterMergeText(JSON.stringify({ daemon: { autoArchiveAfterMerge: false } })).detail, new RegExp(localePattern(zhCNPart("compat.autoArchive.off", 0, 2))));
    assert.match(checkAutoArchiveAfterMergeText(JSON.stringify({ daemon: {} })).detail, new RegExp(localePattern(zhCNPart("compat.autoArchive.off", 9, 12))));
    assert.equal(checkAutoArchiveAfterMergeText(JSON.stringify({ daemon: { autoArchiveAfterMerge: "yes" } })).status, "fail");
    assert.equal(checkAutoArchiveAfterMergeText("{").status, "fail");
  });
});

describe("compat child env", () => {
  it("keeps an isolated data dir and still drops agent identity", () => {
    const env = childEnv({
      ...process.env,
      KANBAN_DATA_DIR: dir,
      KANBAN_TOKEN: "should-drop",
      PASEO_AGENT_ID: "should-drop",
    });
    assert.equal(env.KANBAN_DATA_DIR, dir);
    assert.equal(env.KANBAN_TOKEN, undefined);
    assert.equal(env.PASEO_AGENT_ID, undefined);
  });
});

describe("supervisor token", () => {
  it("does not rewrite the token row when the file and the database already agree", () => {
    process.env.KANBAN_DATA_DIR = dir;
    const first = ensureSupervisorToken();
    const before = getDb().prepare("SELECT created_at, COUNT(*) AS n FROM tokens WHERE role = 'supervisor' AND task_id IS NULL").get() as {
      created_at: string;
      n: number;
    };
    const second = ensureSupervisorToken();
    const afterRow = getDb().prepare("SELECT created_at, COUNT(*) AS n FROM tokens WHERE role = 'supervisor' AND task_id IS NULL").get() as {
      created_at: string;
      n: number;
    };
    assert.equal(second, first);
    assert.equal(afterRow.created_at, before.created_at);
    assert.equal(afterRow.n, 1);
    assert.equal(before.n, 1);
  });
});
