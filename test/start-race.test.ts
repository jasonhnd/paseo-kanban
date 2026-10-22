/// <reference types="node" />
import { zhCN, zhCNPart, localePattern } from "./helpers/locale";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { formatAudit, performAudit, type AuditView } from "../server/audit";
import { closeDb, getDb } from "../server/db";
import { type AgentLauncher } from "../server/dispatch";
import { startTask } from "./helpers/compat-dispatch";
import type { Profile } from "../server/profiles";
import { acquireStartClaim, releaseStartClaim, START_CLAIM_TTL_MS } from "../server/start-claim";
import { appendEvent, createTask, getDetail, getTask } from "../server/store";
import { createdWorktree } from "../server/worktree-gc";
import { commitWorktree, discardFreshWorktree, settleRivalRecord } from "../server/worktree-record";

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(testDir);
const tsxLoader = join(repoRoot, "node_modules/tsx/dist/loader.mjs");

const tmp = tmpdir();
mkdirSync(tmp, { recursive: true });
const dir = mkdtempSync(join(tmp, "start-race-"));
process.env.KANBAN_DATA_DIR = dir;
process.env.KANBAN_AGENTS_DIR = join(dir, "agents");
process.env.KANBAN_WORKTREES_ROOT = join(dir, "worktrees");
mkdirSync(process.env.KANBAN_AGENTS_DIR, { recursive: true });
mkdirSync(process.env.KANBAN_WORKTREES_ROOT, { recursive: true });

const executor: Profile = {
  id: "ex",
  name: zhCN("labels.role.executor"),
  role: "executor",
  family: "xai",
  provider: "cursor",
  model: "grok-4.7",
  pool: "cursor",
};

function room(name: string): string {
  const path = join(dir, name);
  mkdirSync(path, { recursive: true });
  return path;
}

after(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe("cross-process start", () => {
  it("lets only one of two processes create a worktree and an agent", async () => {
    const path = room("shared");
    const quiet: AgentLauncher = {
      async create() {
        return { id: "holder-agent" };
      },
      async send() {},
    };
    const holder = createTask({ project: "race", title: "Directory occupied", role: "executor", workspacePath: path });
    await startTask(holder.id, quiet, "test", { profiles: [executor], chosen: executor, reason: "placeholder" });
    const task = createTask({ project: "race", title: "Start concurrently", role: "executor", workspacePath: path });
    const releaseFile = join(dir, "release");
    const entered = new Set<string>();
    const agents: string[] = [];
    const done: Array<{ name: string; result?: { message: string; agentId?: string }; error?: string }> = [];

    const start = (name: string) =>
      new Promise<void>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            "--import",
            tsxLoader,
            join(testDir, "start-race-worker.ts"),
            JSON.stringify({ dataDir: dir, taskId: task.id, name, releaseFile }),
          ],
          { cwd: repoRoot, env: { ...process.env, NODE_OPTIONS: "" }, stdio: ["ignore", "pipe", "pipe"] },
        );
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          stdout += chunk;
          const lines = stdout.split("\n");
          stdout = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.trim()) continue;
            let message: { type: string; name: string; result?: { message: string; agentId?: string }; error?: string };
            try {
              message = JSON.parse(line) as typeof message;
            } catch {
              continue;
            }
            if (message.type === "worktree") entered.add(message.name);
            if (message.type === "agent") agents.push(message.name);
            if (message.type === "done") done.push({ name: message.name, result: message.result, error: message.error });
          }
        });
        child.stderr.on("data", (chunk: string) => {
          stderr += chunk;
        });
        child.on("error", reject);
        child.on("exit", (code) => {
          if (code !== 0) reject(new Error(`start worker ${name} exited ${code}: ${stderr}`));
          else resolve();
        });
      });

    const pending = [start("a"), start("b")];
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (entered.size >= 2) break;
      if (done.length >= 2) break;
      if (done.length >= 1 && entered.size >= 1) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    writeFileSync(releaseFile, "go");
    await Promise.all(pending);

    const created = getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'worktree_created'").all(task.id) as Array<{
      data_json: string;
    }>;
    const runs = getDb().prepare("SELECT agent_id FROM runs WHERE task_id = ?").all(task.id) as Array<{ agent_id: string }>;
    assert.equal(created.length, 1, `worktree_created ${created.length}, entered ${[...entered].join(",")}, done ${JSON.stringify(done)}`);
    assert.equal(runs.length, 1);
    assert.equal(entered.size, 1);
    assert.equal(agents.length, 1);
    const winner = done.find((item) => item.result?.agentId);
    const loser = done.find((item) => item !== winner);
    assert.ok(winner?.result?.agentId);
    assert.match(loser?.result?.message ?? loser?.error ?? "", new RegExp(zhCN("startClaim.alreadyStarting")));
    const saved = JSON.parse(created[0]?.data_json ?? "{}") as { directory?: string };
    assert.equal(getTask(task.id).workspace_path, saved.directory);
    assert.equal(getTask(task.id).status, "running");
    assert.equal(getTask(task.id).agent_id, winner?.result?.agentId);
    const claims = getDb().prepare("SELECT COUNT(*) AS n FROM start_claims WHERE task_id = ?").get(task.id) as { n: number };
    assert.equal(claims.n, 0);
    const temps = getDb().prepare("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND kind = 'temp_workspace'").get(task.id) as { n: number };
    assert.equal(temps.n, 1);
  });

  it("takes over a claim that is older than the limit even when the pid is still alive", () => {
    const task = createTask({ project: "race", title: "Expired placeholder", role: "executor", workspacePath: room("stale-claim") });
    const stale = new Date(Date.now() - START_CLAIM_TTL_MS - 1_000).toISOString();
    getDb().prepare("INSERT INTO start_claims (task_id, token, pid, at) VALUES (?, ?, ?, ?)").run(task.id, "old", process.pid, stale);
    const token = acquireStartClaim(task.id);
    assert.ok(token);
    assert.notEqual(token, "old");
    assert.equal(acquireStartClaim(task.id), null);
    releaseStartClaim(task.id, token ?? "");
    const exited = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    assert.equal(exited.status, 0);
    const fresh = new Date().toISOString();
    getDb().prepare("INSERT INTO start_claims (task_id, token, pid, at) VALUES (?, ?, ?, ?)").run(task.id, "dead", exited.pid, fresh);
    const taken = acquireStartClaim(task.id);
    assert.ok(taken);
    releaseStartClaim(task.id, taken ?? "");
  });

  it("releases the claim when the worktree cannot be created", async () => {
    const path = room("rollback");
    const holder = createTask({ project: "race", title: "Occupied rollback", role: "executor", workspacePath: path });
    await startTask(holder.id, { async create() { return { id: "hold-rb" }; }, async send() {} }, "test", {
      profiles: [executor],
      chosen: executor,
      reason: "placeholder",
    });
    const task = createTask({ project: "race", title: "Sample text", role: "executor", workspacePath: path });
    await assert.rejects(
      () =>
        startTask(
          task.id,
          {
            async create() {
              return { id: "nope" };
            },
            async send() {},
            async createWorktree() {
              throw new Error((zhCNPart("workspaceRecreate.claimLost", 15, 17) + zhCNPart("doctorLive.unreadable", 2, 3)));
            },
          },
          "test",
          { profiles: [executor], chosen: executor, reason: "Test" },
        ),
      new RegExp(localePattern(zhCNPart("workspaceRecreate.claimLost", 15, 17)) + localePattern(zhCNPart("doctorLive.unreadable", 2, 3))),
    );
    const claims = getDb().prepare("SELECT COUNT(*) AS n FROM start_claims WHERE task_id = ?").get(task.id) as { n: number };
    assert.equal(claims.n, 0);
    assert.equal(getTask(task.id).status, "ready");
    assert.equal(getTask(task.id).workspace_kind, "dir");
    assert.equal(getTask(task.id).workspace_path, path);
    const created = getDb().prepare("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND kind IN ('worktree_created', 'temp_workspace')").get(task.id) as {
      n: number;
    };
    assert.equal(created.n, 0);
  });
});

describe("same-process start", () => {
  it("creates a temp workspace once when two starts interleave", async () => {
    const root = room("worktree-card");
    const holder = createTask({ project: "race", title: "Directory occupied", role: "executor", workspacePath: root });
    await startTask(holder.id, { async create() { return { id: "holder-sp" }; }, async send() {} }, "test", {
      profiles: [executor],
      chosen: executor,
      reason: "placeholder",
    });
    const task = createTask({ project: "race", title: "Same-process concurrent start", role: "executor", workspacePath: root });
    let creates = 0;
    let agents = 0;
    let unblock: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    let entered: () => void = () => {};
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const launcher: AgentLauncher = {
      async create(options) {
        agents += 1;
        return { id: `agent-${agents}`, workspaceId: options.workspaceId };
      },
      async send() {},
      async createWorktree(options) {
        creates += 1;
        const directory = join(dir, "trees", `same-process-${creates}`);
        mkdirSync(directory, { recursive: true });
        mkdirSync(join(directory, ".git"));
        entered();
        await gate;
        return { directory, workspaceId: `ws-${creates}`, name: options.title ?? "t" };
      },
    };
    const options = { profiles: [executor], chosen: executor, reason: "Test" };
    const first = startTask(task.id, launcher, "scheduler", options).then(
      (result) => ({ result }),
      (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }),
    );
    const early = await Promise.race([inside.then(() => null), first]);
    assert.equal(early, null, `first start ended before createWorktree: ${JSON.stringify(early)}`);
    const second = startTask(task.id, launcher, "supervisor", options).then(
      (result) => ({ result }),
      (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    unblock();
    const [a, b] = await Promise.all([first, second]);

    assert.equal(creates, 1);
    assert.equal(agents, 1);
    assert.ok("result" in a && a.result.agentId);
    assert.match("error" in b ? b.error : b.result.message, new RegExp(zhCN("dispatch.inProgress") + "|" + zhCN("startClaim.alreadyStarting")));
    const events = getDb().prepare("SELECT kind FROM events WHERE task_id = ? AND kind IN ('worktree_created', 'temp_workspace')").all(task.id) as Array<{ kind: string }>;
    assert.equal(events.filter((e) => e.kind === "worktree_created").length, 1);
    const claims = getDb().prepare("SELECT COUNT(*) AS n FROM start_claims WHERE task_id = ?").get(task.id) as { n: number };
    assert.equal(claims.n, 0);
  });
});

describe("worktree event choice", () => {
  it("prefers the worktree_created event that matches paseo_workspace_id", async () => {
    const task = createTask({ project: "race", title: "Two records", role: "executor", workspacePath: room("two-events") });
    const real = join(dir, "real-copy");
    const empty = join(dir, "empty-copy");
    getDb()
      .prepare("UPDATE tasks SET workspace_kind = 'worktree', workspace_path = ?, paseo_workspace_id = ? WHERE id = ?")
      .run(empty, "ws-real", task.id);
    appendEvent(task.id, "worktree_created", null, null, "test", {
      directory: real,
      branch: "kanban/real-copy",
      workspaceId: "ws-real",
      base: "main",
      root: room("two-events"),
    });
    appendEvent(task.id, "worktree_created", null, null, "test", {
      directory: empty,
      branch: "kanban/empty-copy",
      workspaceId: "ws-empty",
      base: "main",
      root: room("two-events"),
    });
    assert.equal(createdWorktree(task.id)?.directory, real);
    assert.equal(getDetail(task.id).task.branch, "kanban/real-copy");
    mkdirSync(real, { recursive: true });
    const box: AgentLauncher = {
      async create(options) {
        assert.equal(options.cwd, real);
        return { id: "reuse-agent", workspaceId: options.workspaceId };
      },
      async send() {},
      async createWorktree() {
        throw new Error((zhCNPart("boardView.note.accept", 42, 44) + "Demo text worktree"));
      },
    };
    await startTask(task.id, box, "test", { profiles: [executor], chosen: executor, reason: "demo fixture" });
    assert.equal(getTask(task.id).workspace_path, real);
    getDb().prepare("UPDATE tasks SET paseo_workspace_id = NULL WHERE id = ?").run(task.id);
    assert.equal(createdWorktree(task.id)?.directory, empty);
    assert.equal(getDetail(task.id).task.branch, "kanban/empty-copy");
  });
});

describe("audit duplicate worktrees", () => {
  it("reports an unfinished card with worktrees in different directories", async () => {
    const task = createTask({ project: "race", title: "Duplicate directory", role: "executor", workspacePath: room("audit-dup") });
    const first = join(dir, "audit-a");
    const second = join(dir, "audit-b");
    appendEvent(task.id, "worktree_created", null, null, "test", { directory: first, branch: "kanban/a", workspaceId: "ws-a" });
    appendEvent(task.id, "temp_workspace", null, null, "test", { directory: first, name: "race" });
    appendEvent(task.id, "worktree_created", null, null, "test", { directory: second, branch: "kanban/b", workspaceId: "ws-b" });
    appendEvent(task.id, "temp_workspace", null, null, "test", { directory: second, name: "race" });
    const same = createTask({ project: "race", title: "Same directory", role: "executor", workspacePath: room("audit-same") });
    appendEvent(same.id, "worktree_created", null, null, "test", { directory: first, branch: "kanban/same", workspaceId: "ws-same" });
    appendEvent(same.id, "temp_workspace", null, null, "test", { directory: first, name: "same" });
    const view: AuditView = {
      async listActiveAgents() {
        return [];
      },
      async inspectWorkspace() {
        return null;
      },
    };
    const report = await performAudit(view);
    const text = formatAudit(report);
    assert.match(text, new RegExp(localePattern(zhCNPart("audit.duplicateWorktrees", 0, 12))));
    assert.match(text, new RegExp(first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(text, new RegExp(second.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(report.ok, false);
    const card = report.cards.find((item) => item.id === task.id);
    assert.ok(card);
    assert.equal(card?.duplicateWorktrees?.length, 2);
    assert.equal(report.cards.some((item) => item.id === same.id && (item.duplicateWorktrees?.length ?? 0) > 1), false);
  });
});

describe("lost worktree", () => {
  it("refuses to record without the claim, and drops an empty rival without keeping it as the latest", async () => {
    const root = room("discard-root");
    const task = createTask({ project: "race", title: "Lost race", role: "executor", workspacePath: root });
    const real = join(dir, "kept-copy");
    const intruderDir = join(dir, "intruder-copy");
    const intruderBranch = `kanban/${task.id}-intruder`;
    const lost = commitWorktree({
      taskId: task.id,
      token: "nope",
      directory: intruderDir,
      data: { directory: intruderDir, branch: intruderBranch, workspaceId: "ws-nope", root, base: "main" },
      temp: null,
    });
    assert.equal(lost.ok, false);
    assert.equal(createdWorktree(task.id), null);

    appendEvent(task.id, "worktree_created", null, null, "test", {
      directory: intruderDir,
      branch: intruderBranch,
      workspaceId: "ws-intruder",
      base: "main",
      root,
    });
    const token = acquireStartClaim(task.id);
    assert.ok(token);
    const recorded = commitWorktree({
      taskId: task.id,
      token: token ?? "",
      directory: real,
      data: { directory: real, branch: `kanban/${task.id}-kept`, workspaceId: "ws-kept", root, base: "main" },
      temp: null,
    });
    assert.equal(recorded.ok, true);
    if (recorded.ok) assert.equal(recorded.intruders.length, 1);
    getDb().prepare("UPDATE tasks SET workspace_kind = 'worktree', paseo_workspace_id = 'ws-intruder' WHERE id = ?").run(task.id);
    assert.equal(createdWorktree(task.id)?.directory, intruderDir);
    const keptVisible = getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'worktree_created' ORDER BY id").all(task.id) as Array<{
      data_json: string;
    }>;
    assert.equal(keptVisible.some((row) => JSON.parse(row.data_json).discarded === true), false);

    const calls: string[] = [];
    const removed = await discardFreshWorktree({
      taskId: task.id,
      directory: intruderDir,
      branch: intruderBranch,
      root,
      base: "main",
      workspaceId: "ws-intruder",
      listAgents: async () => [],
      archiveWorkspace: async (id) => {
        calls.push(`archive:${id}`);
      },
      run: async (_cwd, args) => {
        calls.push(args.join(" "));
        if (args[0] === "rev-list") return { code: 0, stdout: "0\n", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    assert.equal(removed.archived, true);
    assert.equal(removed.removedBranch, true);
    assert.ok(calls.includes("archive:ws-intruder"));
    assert.equal(calls.some((line) => line.startsWith("branch -d ")), true);
    settleRivalRecord(task.id, intruderDir, removed);
    assert.equal(createdWorktree(task.id)?.directory, real);
    assert.equal(getDetail(task.id).task.branch, `kanban/${task.id}-kept`);

    const busyDir = join(dir, "busy-copy");
    appendEvent(task.id, "worktree_created", null, null, "test", {
      directory: busyDir,
      branch: `kanban/${task.id}-busy`,
      workspaceId: "ws-busy",
      base: "main",
      root,
    });
    const skipped = await discardFreshWorktree({
      taskId: task.id,
      directory: busyDir,
      branch: `kanban/${task.id}-busy`,
      root,
      base: "main",
      workspaceId: "ws-busy",
      listAgents: async () => [],
      archiveWorkspace: async () => undefined,
      run: async (_cwd, args) => {
        if (args[0] === "rev-list") return { code: 0, stdout: "2\n", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    assert.equal(skipped.skipped, zhCN("worktreeRecord.skip.hasCommits"));
    settleRivalRecord(task.id, busyDir, skipped);
    const busyRow = getDb()
      .prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'worktree_created' ORDER BY id DESC")
      .get(task.id) as { data_json: string };
    const busyData = JSON.parse(busyRow.data_json) as { directory?: string; discarded?: boolean };
    assert.equal(busyData.directory, busyDir);
    assert.notEqual(busyData.discarded, true);
    getDb().prepare("UPDATE tasks SET paseo_workspace_id = 'ws-busy' WHERE id = ?").run(task.id);
    assert.equal(createdWorktree(task.id)?.directory, busyDir);

    const kept = await discardFreshWorktree({
      taskId: task.id,
      directory: real,
      branch: `kanban/${task.id}-kept`,
      root,
      base: "main",
      workspaceId: "ws-kept",
      listAgents: async () => [{ id: "busy", archived: false }],
      archiveWorkspace: async () => {
        throw new Error("Do not archive");
      },
      run: async () => {
        throw new Error("Do not delete");
      },
    });
    assert.equal(kept.archived, false);
    assert.equal(kept.removedBranch, false);
    assert.equal(kept.skipped, zhCN("worktreeRecord.skip.hasAgent"));

    const committed = await discardFreshWorktree({
      taskId: task.id,
      directory: real,
      branch: `kanban/${task.id}-kept`,
      root,
      base: "main",
      workspaceId: "ws-kept",
      listAgents: async () => [],
      archiveWorkspace: async () => undefined,
      run: async (_cwd, args) => {
        if (args[0] === "branch") throw new Error((zhCN("worktreeRecord.skip.hasCommits") + "Demo text"));
        if (args[0] === "rev-list") return { code: 0, stdout: "2\n", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    assert.equal(committed.removedBranch, false);
    assert.equal(committed.skipped, zhCN("worktreeRecord.skip.hasCommits"));
    releaseStartClaim(task.id, token ?? "");
  });
});
