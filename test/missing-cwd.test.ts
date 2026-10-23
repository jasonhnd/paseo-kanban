/// <reference types="node" />
import { zhCN, zhCNPart, localePattern } from "./helpers/locale";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { after, beforeEach, describe, it } from "node:test";
import { SUBPROCESS_TIMEOUT_MS } from "./helpers/subprocess-timeout";
import type { CleanupRecord } from "../server/archive-book";
import { setWakeSender } from "../server/bus";
import { checkAgentCwdSource } from "../server/compat";
import { loadConfig, setSupervisorAgentId } from "../server/config";
import { kanbanHelp, runKanban } from "../server/cli";
import { closeDb, getDb } from "../server/db";
import { startTask } from "./helpers/compat-dispatch";
import { KanbanError } from "../server/errors";
import { rejectTask } from "../server/flow";
import type { GitRunner } from "../server/git";
import {
  PLACEHOLDER_NAME,
  buildMissingCwdReport,
  deletePaseoAgent,
  missingCwdMessage,
  purgeCardAgents,
  registerMissingPaths,
  resetMissingCwdForTests,
  setMissingCwdHooks,
  startMissingCwdPatrol,
  patrolMissingCwds,
  type CwdAgent,
} from "../server/missing-cwd";
import { HOME } from "../server/paths";
import type { Profile } from "../server/profiles";
import { boardExtras } from "../server/schedule";
import { resetStallScanForTests, scanStalled } from "../server/stall";
import { appendEvent, createTask, getTask } from "../server/store";
import { notifyAcceptance, resetAgentAliveCheck, resetBoardWakeForTests, setAgentAliveCheck, wakeKanbanSupervisor } from "../server/wake";
import { branchName } from "../server/workspace";
import { resetWorktreeRemovalForTests, settleOwnedWorktree } from "../server/worktree-gc";

const dir = mkdtempSync(join(tmpdir(), "missing-cwd-"));
const agents = join(dir, "agents");
const trees = join(dir, "worktrees");
const agentic = join(dir, "agentic-root");
const checkAgents = join(dir, "check-agents");
mkdirSync(agents, { recursive: true });
mkdirSync(trees, { recursive: true });
mkdirSync(agentic, { recursive: true });
process.env.KANBAN_DATA_DIR = dir;
process.env.KANBAN_AGENTS_DIR = agents;
process.env.KANBAN_WORKTREES_ROOT = trees;
process.env.KANBAN_PROJECTS_ROOT = agentic;

const root = join(import.meta.dirname, "..");
const profile: Profile = {
  id: "exec",
  name: zhCN("labels.role.executor"),
  role: "executor",
  family: "xai",
  provider: "alternate",
  model: "grok-4.7",
  pool: "alternate",
};

function writeAgent(id: string, cwd: string, extra: { archivedAt?: string | null; labels?: Record<string, string>; title?: string; provider?: string } = {}): void {
  mkdirSync(join(agents, "bucket"), { recursive: true });
  writeFileSync(
    join(agents, "bucket", `${id}.json`),
    JSON.stringify({
      id,
      cwd,
      title: extra.title ?? id,
      provider: extra.provider ?? "alternate",
      labels: extra.labels ?? {},
      archivedAt: extra.archivedAt ?? null,
      lastActivityAt: "2026-09-27T00:00:00.000Z",
      lastStatus: "idle",
    }),
  );
}

function comments(taskId: number): Array<{ body: string }> {
  return getDb().prepare("SELECT body FROM comments WHERE task_id = ? ORDER BY id").all(taskId) as Array<{ body: string }>;
}

function events(taskId: number, kind: string): Array<{ data_json: string }> {
  return getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = ? ORDER BY id").all(taskId, kind) as Array<{ data_json: string }>;
}

function remember(id: number, directory: string): void {
  const task = getTask(id);
  appendEvent(id, "worktree_created", null, null, "test", {
    directory,
    branch: branchName(id, task.title),
    base: "pre",
    root: join(dir, "repo-root"),
  });
}

function fakeGit(directory: string, dirty = false): GitRunner {
  return async (_cwd, args) => {
    const [cmd, sub] = args;
    if (cmd === "status") return { code: 0, stdout: dirty ? " M file\n" : "", stderr: "" };
    if (cmd === "branch" && sub === "--list") return { code: 0, stdout: `  ${args[2] ?? "branch"}\n`, stderr: "" };
    if (cmd === "worktree" && sub === "remove") {
      rmSync(directory, { recursive: true, force: true });
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
}

async function settle(id: number, directory: string, dirty = false): Promise<string> {
  resetWorktreeRemovalForTests();
  return settleOwnedWorktree({
    task: getTask(id),
    events: [],
    now: new Date(),
    timeoutMs: 5_000,
    record: () => {},
    run: fakeGit(directory, dirty),
    worktreesRoot: trees,
  });
}

function cliEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, KANBAN_DATA_DIR: dir, KANBAN_AGENTS_DIR: agents, KANBAN_WORKTREES_ROOT: trees, KANBAN_PROJECTS_ROOT: agentic };
  delete env.KANBAN_TOKEN;
  delete env.PASEO_AGENT_ID;
  delete env.KANBAN_TASK;
  delete env.KANBAN_ROLE;
  return { ...env, ...extra };
}

function runCheck(args: string[], agentsRoot: string): Promise<{ code: number | null; stdout: string; stderr: string; ms: number }> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(join(root, "bin/check-missing-cwd"), args, {
      env: {
        ...process.env,
        KANBAN_DATA_DIR: dir,
        KANBAN_AGENTS_DIR: agentsRoot,
        KANBAN_WORKTREES_ROOT: trees,
        KANBAN_PROJECTS_ROOT: agentic,
        KANBAN_MISSING_CWD_LIST: join(dir, "missing-cwd-list.md"),
      },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: SUBPROCESS_TIMEOUT_MS,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr, ms: Date.now() - started }));
  });
}

beforeEach(() => {
  resetMissingCwdForTests();
  resetStallScanForTests();
  resetWorktreeRemovalForTests();
  resetBoardWakeForTests();
  resetAgentAliveCheck();
  setWakeSender(() => {});
});

after(() => {
  resetMissingCwdForTests();
  resetAgentAliveCheck();
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe("missing cwd guard", { concurrency: false }, () => {
  it("purges archived kanban agents, including one nested under the worktree, only after the comment", async () => {
    mkdirSync(join(dir, "repo-root"), { recursive: true });
    const id = createTask({ project: "cwd", title: "Done", role: "executor", workspacePath: join(dir, "repo-root") }).id;
    const directory = join(trees, "done-card");
    mkdirSync(directory, { recursive: true });
    remember(id, directory);
    getDb().prepare("UPDATE tasks SET status = 'done', agent_id = 'agent-arch', handoff_json = ? WHERE id = ?").run(JSON.stringify({ summary: "Handoff here" }), id);
    getDb().prepare("INSERT INTO runs (task_id, agent_id, role, started_at) VALUES (?, 'agent.sub', 'executor', ?)").run(id, new Date().toISOString());
    writeAgent("agent-arch", directory, { archivedAt: "2026-09-27T01:00:00.000Z", labels: { kanban: "1", kanban_task: String(id) }, title: "Archive executor" });
    writeAgent("agent.sub", join(directory, "src"), { labels: { kanban: "1", kanban_task: String(id) }, title: "Subdirectory" });
    const order: string[] = [];
    setMissingCwdHooks({
      deleteAgent: async (agentId) => {
        assert.ok(comments(id).some((row) => row.body.includes(agentId === "agent-arch" ? "Archive executor" : "Subdirectory")));
        assert.ok(comments(id).some((row) => row.body.includes(zhCNPart("missingCwd.purge.source", 11, 17))));
        assert.ok(events(id, "agent_purged").some((row) => row.data_json.includes(agentId)));
        order.push(`delete:${agentId}`);
      },
    });
    assert.equal(await settle(id, directory), "settled");
    assert.deepEqual(order.sort(), ["delete:agent-arch", "delete:agent.sub"]);
    assert.equal(existsSync(directory), false);
    assert.equal(existsSync(join(directory, PLACEHOLDER_NAME)), false);
  });

  it("does not delete when the highlight write fails, and puts a placeholder back", async () => {
    const id = createTask({ project: "cwd", title: "Write failed", role: "executor", workspacePath: join(dir, "repo-root") }).id;
    const directory = join(trees, "write-failed");
    mkdirSync(directory, { recursive: true });
    remember(id, directory);
    getDb().prepare("UPDATE tasks SET status = 'done', agent_id = 'agent-write' WHERE id = ?").run(id);
    writeAgent("agent-write", directory, { labels: { kanban: "1", kanban_task: String(id) } });
    let deleted = 0;
    setMissingCwdHooks({
      recordPurge: () => {
        throw new Error((zhCN("cardDrawer.comments.title") + "Demo text"));
      },
      deleteAgent: async () => {
        deleted += 1;
      },
    });
    assert.equal(await settle(id, directory), "settled");
    assert.equal(deleted, 0);
    assert.equal(existsSync(join(directory, PLACEHOLDER_NAME)), true);
    assert.match(readFileSync(join(directory, PLACEHOLDER_NAME), "utf8"), /agent-write/);
  });

  it("keeps a non-kanban agent and a kanban agent on an open card, then placeholders the path", async () => {
    const id = createTask({ project: "cwd", title: "Still working", role: "executor", workspacePath: join(dir, "repo-root") }).id;
    const directory = join(trees, "still-open");
    mkdirSync(directory, { recursive: true });
    remember(id, directory);
    getDb().prepare("UPDATE tasks SET status = 'running', agent_id = 'agent-open' WHERE id = ?").run(id);
    writeAgent("agent-open", directory, { labels: { kanban: "1", kanban_task: String(id) } });
    writeAgent("agent-outsider", directory, { title: "Sample text" });
    let deleted = 0;
    setMissingCwdHooks({
      deleteAgent: async () => {
        deleted += 1;
      },
    });
    assert.equal(await settle(id, directory), "settled");
    assert.equal(deleted, 0);
    assert.equal(existsSync(join(directory, PLACEHOLDER_NAME)), true);
    assert.ok(events(id, "cwd_placeholder").length >= 1);
  });

  it("keeps the directory when the agent list cannot be read", async () => {
    const id = createTask({ project: "cwd", title: "List failed", role: "executor", workspacePath: join(dir, "repo-root") }).id;
    const directory = join(trees, "list-failed");
    mkdirSync(directory, { recursive: true });
    remember(id, directory);
    getDb().prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(id);
    let deleted = 0;
    setMissingCwdHooks({
      listAgents: () => {
        throw new Error((zhCNPart("compat.name.modelEfforts", 4, 6) + zhCN("doctorLive.unreadable")));
      },
      deleteAgent: async () => {
        deleted += 1;
      },
    });
    assert.equal(await settle(id, directory), "pending");
    assert.equal(deleted, 0);
    assert.equal(existsSync(directory), true);
    assert.equal(existsSync(join(directory, PLACEHOLDER_NAME)), false);
  });

  it("does not purge or remove a dirty worktree", async () => {
    const id = createTask({ project: "cwd", title: "Sample text", role: "executor", workspacePath: join(dir, "repo-root") }).id;
    const directory = join(trees, "dirty");
    mkdirSync(directory, { recursive: true });
    remember(id, directory);
    getDb().prepare("UPDATE tasks SET status = 'done', agent_id = 'agent-dirty' WHERE id = ?").run(id);
    writeAgent("agent-dirty", directory, { labels: { kanban: "1", kanban_task: String(id) } });
    let deleted = 0;
    setMissingCwdHooks({
      deleteAgent: async () => {
        deleted += 1;
      },
    });
    assert.equal(await settle(id, directory, true), "pending");
    assert.equal(deleted, 0);
    assert.equal(existsSync(directory), true);
    assert.equal(existsSync(join(directory, PLACEHOLDER_NAME)), false);
  });

  it("deletes the branch on the retry after a placeholder is left behind", async () => {
    const id = createTask({ project: "cwd", title: "Placeholder then delete branch", role: "executor", workspacePath: join(dir, "repo-root") }).id;
    const directory = join(trees, "placeholder-retry");
    mkdirSync(directory, { recursive: true });
    remember(id, directory);
    getDb().prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(id);
    writeAgent("agent-kept", directory, { title: "Remaining" });
    const branch = branchName(id, "Placeholder then delete branch");
    let branchDeletes = 0;
    const calls: string[][] = [];
    const run: GitRunner = async (_cwd, args) => {
      calls.push(args);
      if (args[0] === "status") {
        if (existsSync(join(directory, PLACEHOLDER_NAME))) return { code: 128, stdout: "", stderr: "fatal: not a git repository" };
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "worktree" && args[1] === "remove") {
        rmSync(directory, { recursive: true, force: true });
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "branch" && args[1] === "--list") return { code: 0, stdout: `  ${branch}\n`, stderr: "" };
      if (args[0] === "branch" && args[1] === "-D") {
        branchDeletes += 1;
        if (branchDeletes === 1) return { code: 1, stdout: "", stderr: "not fully merged" };
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "diff") return { code: 1, stdout: "", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };
    const book: CleanupRecord[] = [];
    const record = (data: Omit<CleanupRecord, "at">) => {
      book.push({ ...data, at: "2026-09-28T00:00:00.000Z" });
    };
    const firstNow = new Date("2026-09-28T00:00:00.000Z");
    assert.equal(
      await settleOwnedWorktree({ task: getTask(id), events: book, now: firstNow, timeoutMs: 5_000, record, run, worktreesRoot: trees }),
      "pending",
    );
    assert.equal(existsSync(join(directory, PLACEHOLDER_NAME)), true);
    assert.match(book.find((event) => event.ok === false)?.error ?? "", /not fully merged/);
    const retryAt = book.find((event) => event.ok === false)?.retryAt;
    assert.ok(retryAt);
    const statusBeforeRetry = calls.filter((args) => args[0] === "status").length;
    resetWorktreeRemovalForTests();
    assert.equal(
      await settleOwnedWorktree({
        task: getTask(id),
        events: book,
        now: new Date(Date.parse(retryAt) + 1_000),
        timeoutMs: 5_000,
        record,
        run,
        worktreesRoot: trees,
      }),
      "settled",
    );
    assert.equal(branchDeletes, 2);
    assert.equal(calls.filter((args) => args[0] === "status").length, statusBeforeRetry);
  });

  it("leaves the directory gone when no agent points at it", async () => {
    const id = createTask({ project: "cwd", title: "Nobody", role: "executor", workspacePath: join(dir, "repo-root") }).id;
    const directory = join(trees, "empty-card");
    mkdirSync(directory, { recursive: true });
    remember(id, directory);
    getDb().prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(id);
    setMissingCwdHooks({
      listAgents: () => [],
    });
    assert.equal(await settle(id, directory), "settled");
    assert.equal(existsSync(directory), false);
  });

  it("fills only worktree and legacy report paths, and registers other paths once", async () => {
    const card = createTask({ project: "cwd", title: "demo fixture", role: "executor", workspacePath: join(dir, "repo-root") }).id;
    const underTree = join(trees, "patrol-card");
    const underAgentic = join(agentic, "patrol-free");
    const foreign = join(dir, "foreign-missing");
    getDb().prepare("UPDATE tasks SET agent_id = 'patrol-card' WHERE id = ?").run(card);
    const agentsOnDisk: CwdAgent[] = [
      { id: "patrol-card", cwd: underTree, provider: "alternate", title: "demo fixture", archived: false, lastActivityAt: null, labels: { kanban: "1" } },
      { id: "patrol-free", cwd: underAgentic, provider: "alternate", title: "None sample", archived: false, lastActivityAt: null, labels: {} },
      { id: "patrol-foreign", cwd: foreign, provider: "alternate", title: "Elsewhere", archived: false, lastActivityAt: null, labels: {} },
    ];
    const added: string[] = [];
    const logs: string[] = [];
    setMissingCwdHooks({
      listAgents: () => agentsOnDisk,
      decideList: async () => "",
      decideAdd: async (input) => {
        added.push(input.title);
      },
      log: (line) => logs.push(line),
    });
    await patrolMissingCwds();
    assert.equal(existsSync(join(underTree, PLACEHOLDER_NAME)), true);
    assert.equal(existsSync(join(underAgentic, PLACEHOLDER_NAME)), true);
    assert.equal(existsSync(foreign), false);
    assert.equal(added.length, 1);
    assert.match(added[0] ?? "", new RegExp(zhCN("missingCwd.decide.title", {"count":"1","fingerprint":"[0-9a-f]{8}"})));
    assert.ok(events(card, "cwd_placeholder").length >= 1);
    assert.ok(logs.some((line) => line.includes("patrol-free")));
    assert.match(missingCwdMessage() ?? "", new RegExp("^" + (zhCN("doctor.safety.has") + " ") + "1 " + localePattern(zhCNPart("doctor.cwd.missing", 10, 26)) + "$"));
    assert.equal(boardExtras().missingCwdMessage, missingCwdMessage());
    await patrolMissingCwds();
    assert.equal(added.length, 1);
    assert.equal(existsSync(foreign), false);
  });

  it("does not placeholder a finished card while cleanup is still going to collect the agent", async () => {
    const card = createTask({ project: "cwd", title: "Inspection finished", role: "executor", workspacePath: join(dir, "repo-root") }).id;
    const underTree = join(trees, "patrol-done");
    getDb().prepare("UPDATE tasks SET status = 'done', agent_id = 'patrol-done' WHERE id = ?").run(card);
    appendEvent(card, "accept", "acceptance", "done", "test", {});
    const agentsOnDisk: CwdAgent[] = [
      {
        id: "patrol-done",
        cwd: underTree,
        provider: "alternate",
        title: "Done",
        archived: false,
        lastActivityAt: null,
        labels: { kanban: "1", kanban_task: String(card) },
      },
    ];
    setMissingCwdHooks({ listAgents: () => agentsOnDisk });
    await patrolMissingCwds();
    assert.equal(existsSync(join(underTree, PLACEHOLDER_NAME)), false);
    assert.equal(events(card, "cwd_placeholder").length, 0);
    assert.ok(events(card, "cwd_placeholder_skipped").length >= 1);
    appendEvent(card, "cleanup_finished", null, null, "test", {});
    await patrolMissingCwds();
    assert.equal(existsSync(join(underTree, PLACEHOLDER_NAME)), true);
  });

  it("registers a new path once and skips registration when the decision list cannot be read", async () => {
    const added: string[] = [];
    setMissingCwdHooks({
      decideList: async () => "",
      decideAdd: async () => {
        added.push("add");
      },
    });
    assert.equal(await registerMissingPaths([join(dir, "brand-new-foreign")]), true);
    assert.equal(added.length, 1);
    setMissingCwdHooks({
      decideList: async () => {
        throw new Error("ls down");
      },
      decideAdd: async () => {
        added.push("again");
      },
    });
    assert.equal(await registerMissingPaths([join(dir, "another-foreign")]), false);
    assert.equal(added.length, 1);
  });

  it("logs a roles rejection without throwing or remembering the rejected paths", async () => {
    const path = join(dir, "rejected-decision");
    const logs: string[] = [];
    const reason = ("roles exited with code 1: detail " + zhCNPart("profileRules.tagNotText", 2, 4) + zhCNPart("compat.source.noIncludeArchived", 6, 9) + "A、B " + zhCNPart("doctor.agent.double.symptom", 5, 7) + zhCNPart("settingsPanel.autoStart.pickProject", 1, 3) + "Demo text");
    let attempts = 0;
    setMissingCwdHooks({
      decideList: async () => "",
      decideAdd: async () => {
        attempts += 1;
        throw new Error(reason);
      },
      log: (line) => logs.push(line),
    });
    assert.equal(await registerMissingPaths([path]), false);
    assert.ok(logs.some((line) => line.includes("decide add failed") && line.includes(reason)));
    setMissingCwdHooks({
      decideList: async () => "",
      decideAdd: async () => { attempts += 1; },
      log: (line) => logs.push(line),
    });
    assert.equal(await registerMissingPaths([path]), true);
    assert.equal(await registerMissingPaths([path]), false);
    assert.equal(attempts, 2);
  });

  it("registers one new path without repeating the batch, and expands an old set key", async () => {
    const a = join(dir, "set-a");
    const b = join(dir, "set-b");
    const c = join(dir, "set-c");
    const added: Array<{ title: string; detail: string }> = [];
    setMissingCwdHooks({
      decideList: async () => "",
      decideAdd: async (input) => {
        added.push(input);
      },
    });
    assert.equal(await registerMissingPaths([a, b]), true);
    assert.equal(added.length, 1);
    assert.match(added[0]?.detail ?? "", new RegExp("A" + zhCN("common.colon")));
    assert.match(added[0]?.detail ?? "", new RegExp("B" + zhCN("common.colon")));
    assert.match(added[0]?.detail ?? "", new RegExp(localePattern(zhCNPart("missingCwd.decide.recommend", 0, 4))));
    assert.match(added[0]?.detail ?? "", new RegExp(localePattern(zhCNPart("missingCwd.decide.optionA", 20, 36))));
    assert.match(added[0]?.detail ?? "", new RegExp("README-placeholder\\.txt " + localePattern(zhCNPart("missingCwd.decide.optionA", 62, 69))));
    assert.equal(added[0]?.detail.includes(a), true);
    assert.equal(added[0]?.detail.includes(b), true);
    assert.equal(await registerMissingPaths([b, a, c]), true);
    assert.equal(added.length, 2);
    assert.match(added[1]?.title ?? "", new RegExp((zhCN("doctor.safety.has") + " ") + "1 " + localePattern(zhCNPart("missingCwd.decide.title", 10, 18))));
    assert.equal(added[1]?.detail.includes(c), true);
    assert.equal(added[1]?.detail.includes(a), false);
    assert.equal(added[1]?.detail.includes(b), false);
    assert.equal(await registerMissingPaths([a]), false);
    assert.equal(await registerMissingPaths([c, b]), false);
    assert.equal(added.length, 2);

    const legacyA = join(dir, "legacy-a");
    const legacyB = join(dir, "legacy-b");
    const legacyC = join(dir, "legacy-c");
    const file = join(dir, "missing-cwd-registered.json");
    const current = JSON.parse(readFileSync(file, "utf8")) as { keys: string[] };
    current.keys.push(`${legacyA}\n${legacyB}`);
    writeFileSync(file, `${JSON.stringify(current, null, 2)}\n`);
    assert.equal(await registerMissingPaths([legacyB, legacyA]), false);
    assert.equal(added.length, 2);
    assert.equal(await registerMissingPaths([legacyA, legacyC]), true);
    assert.equal(added.length, 3);
    assert.match(added[2]?.title ?? "", new RegExp((zhCN("doctor.safety.has") + " ") + "1 " + localePattern(zhCNPart("missingCwd.decide.title", 10, 18))));
    assert.equal(added[2]?.detail.includes(legacyC), true);
    assert.equal(added[2]?.detail.includes(legacyA), false);
    const stored = JSON.parse(readFileSync(file, "utf8")) as { keys: string[] };
    assert.equal(stored.keys.includes(legacyA), true);
    assert.equal(stored.keys.includes(legacyB), true);
    assert.equal(stored.keys.includes(legacyC), true);
    assert.equal(stored.keys.some((key) => key.includes("\n")), false);
  });

  it("keeps running when a patrol tick throws", async () => {
    let runs = 0;
    const stop = startMissingCwdPatrol({
      intervalMs: 60_000,
      run: async () => {
        runs += 1;
        throw new Error("boom");
      },
    });
    const deadline = Date.now() + 10_000;
    while (runs < 1 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(runs, 1);
    stop();
  });

  it("opens a new agent on reject when the executor cwd is gone, and puts the handoff in the brief", async () => {
    const room = join(dir, "rework-room");
    mkdirSync(room, { recursive: true });
    writeAgent("exec-missing", join(dir, "exec-cwd-gone"), { title: "Sample text" });
    const task = createTask({ project: "rework", title: "Directory missing", role: "executor", workspacePath: room, brief: "Original goal" });
    getDb()
      .prepare("UPDATE tasks SET status = 'acceptance', executor_agent_id = 'exec-missing', handoff_json = ? WHERE id = ?")
      .run(JSON.stringify({ summary: "Previous handoff" }), task.id);
    const rejected = rejectTask(task.id, zhCNPart("flow.error.reviewerReject", 3, 7), "supervisor");
    assert.equal(rejected.executor_agent_id, null);
    assert.equal((rejected.brief.match(new RegExp(zhCN("flow.brief.rejected"), "g")) ?? []).length, 1);
    assert.match(rejected.brief, new RegExp("Original goal"));
    assert.match(rejected.brief, new RegExp(localePattern(zhCNPart("flow.brief.priorHandoff", 3, 8))));
    assert.match(rejected.brief, new RegExp("Previous handoff"));
    const created: string[] = [];
    const sent: string[] = [];
    await startTask(
      task.id,
      {
        async create(options) {
          created.push(options.prompt ?? "");
          return { id: "new-exec" };
        },
        async send(id) {
          sent.push(id);
        },
      },
      "scheduler",
      { profiles: [profile], chosen: profile, reason: "Redispatch" },
    );
    assert.deepEqual(sent, []);
    assert.equal(created.length, 1);
    assert.match(created[0] ?? "", new RegExp(zhCN("flow.brief.rejected")));
    assert.match(created[0] ?? "", new RegExp(localePattern(zhCNPart("flow.brief.priorHandoff", 3, 8))));
    assert.equal(getTask(task.id).agent_id, "new-exec");
  });

  it("opens a new agent when start finds the executor cwd already gone", async () => {
    const room = join(dir, "resume-room");
    mkdirSync(room, { recursive: true });
    writeAgent("exec-later", join(dir, "exec-later-gone"));
    const task = createTask({ project: "rework", title: "Found only at start", role: "executor", workspacePath: room, brief: "Original goal" });
    getDb()
      .prepare("UPDATE tasks SET status = 'rework', executor_agent_id = 'exec-later', handoff_json = ? WHERE id = ?")
      .run(JSON.stringify({ summary: "Handoff before start" }), task.id);
    const sent: string[] = [];
    const created: string[] = [];
    await startTask(
      task.id,
      {
        async create(options) {
          created.push(options.prompt ?? "");
          return { id: "fresh-exec" };
        },
        async send(id) {
          sent.push(id);
        },
      },
      "scheduler",
      { profiles: [profile], chosen: profile, reason: "Redispatch" },
    );
    assert.deepEqual(sent, []);
    assert.match(created[0] ?? "", new RegExp(localePattern(zhCNPart("dispatch.executorCwdMissing", 5, 12))));
    assert.match(created[0] ?? "", new RegExp(localePattern(zhCNPart("flow.brief.priorHandoff", 3, 8))));
    assert.match(created[0] ?? "", new RegExp("Handoff before start"));
  });

  it("blocks a card whose own directory is gone and does not open an agent", async () => {
    const room = join(dir, "vanish");
    mkdirSync(room, { recursive: true });
    const task = createTask({ project: "vanish", title: "Directory deleted", role: "executor", workspacePath: room, brief: "sample" });
    rmSync(room, { recursive: true, force: true });
    let created = 0;
    const result = await startTask(
      task.id,
      {
        async create() {
          created += 1;
          return { id: "nope" };
        },
        async send() {
          throw new Error("Do not send");
        },
      },
      "scheduler",
      { profiles: [profile], chosen: profile, reason: "Do not dispatch" },
    );
    assert.equal(created, 0);
    assert.equal(getTask(task.id).status, "blocked");
    assert.equal(getTask(task.id).blocked_kind, "capability");
    assert.match(result.message, new RegExp(localePattern(zhCNPart("dispatch.executorCwdMissing", 5, 12))));

    const rootDir = join(dir, "repo-root");
    const gone = join(trees, "saved-gone");
    const saved = createTask({ project: "vanish", title: "Worktree lost", role: "executor", workspacePath: rootDir });
    getDb().prepare("UPDATE tasks SET workspace_kind = 'worktree', workspace_base = 'pre' WHERE id = ?").run(saved.id);
    appendEvent(saved.id, "worktree_created", null, null, "test", { directory: gone, branch: branchName(saved.id, saved.title), base: "pre", root: rootDir });
    let createdTree = 0;
    const blocked = await startTask(
      saved.id,
      {
        async create() {
          createdTree += 1;
          return { id: "nope" };
        },
        async send() {
          throw new Error("Do not send");
        },
      },
      "scheduler",
      { profiles: [profile], chosen: profile, reason: "Do not dispatch" },
    );
    assert.equal(createdTree, 0);
    assert.equal(getTask(saved.id).status, "blocked");
    // The launcher cannot build a worktree, so the rebuild fails and the card waits for a person.
    assert.equal(getTask(saved.id).blocked_kind, "needs_human");
    assert.match(blocked.message, new RegExp(localePattern(zhCNPart("workspaceRecreate.baseFailed", 17, 21))));
    assert.match(blocked.message, new RegExp(gone.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  it("does not send a wake or a stall nudge when the cwd is missing", async () => {
    writeAgent("boss-missing", join(dir, "no-boss-cwd"), { title: "<leader>" });
    setSupervisorAgentId("boss-missing");
    setAgentAliveCheck(() => true);
    const sent: string[] = [];
    setWakeSender((id) => sent.push(id));
    const task = createTask({ project: "wake", title: "demo fixture", role: "executor", workspacePath: join(dir, "repo-root"), createdByAgent: "boss-missing" });
    getDb().prepare("UPDATE tasks SET status = 'acceptance' WHERE id = ?").run(task.id);
    notifyAcceptance(task.id);
    assert.equal(wakeKanbanSupervisor({ taskId: task.id, kind: "start_failed", detail: "Try it" }), false);
    assert.deepEqual(sent, []);
    assert.ok(events(task.id, "wake_skipped_missing_cwd").length >= 1);
    assert.match(missingCwdMessage() ?? "", new RegExp(zhCN("doctor.cwd.missing", {"count":"\\d+"})));
    assert.equal(boardExtras().missingCwdMessage, missingCwdMessage());

    writeAgent("stall-agent", join(dir, "no-stall-cwd"));
    const stalled = createTask({ project: "wake", title: "demo fixture", role: "executor", workspacePath: join(dir, "repo-root") });
    getDb().prepare("UPDATE tasks SET status = 'running', agent_id = 'stall-agent' WHERE id = ?").run(stalled.id);
    const nudged: string[] = [];
    await scanStalled({
      now: new Date(),
      config: loadConfig(),
      intervalMs: 0,
      idleMs: 1_000,
      agentActivity: () => ({ state: "idle", since: new Date(Date.now() - 3_600_000).toISOString() }),
      send: async (id) => {
        nudged.push(id);
      },
    });
    assert.equal(nudged.includes("stall-agent"), false);
    assert.equal(events(stalled.id, "wake_skipped_missing_cwd").some((row) => row.data_json.includes("stall")), true);
  });

  it("rejects unfinished cards, and dry-run does not delete", async () => {
    assert.match(kanbanHelp(), new RegExp("purge-agents <" + localePattern(zhCNPart("boardView.cmd.parentCode", 3, 6))));
    const open = createTask({ project: "purge", title: "Sample text", role: "executor", workspacePath: join(dir, "repo-root") });
    await assert.rejects(
      () => runKanban(["purge-agents", String(open.id)], cliEnv()),
      (err: unknown) => err instanceof KanbanError && new RegExp(localePattern(zhCNPart("missingCwd.purge.notFinished", 0, 9))).test(err.message),
    );
    const done = createTask({ project: "purge", title: "Cleanable", role: "executor", workspacePath: join(dir, "repo-root") });
    getDb().prepare("UPDATE tasks SET status = 'done', agent_id = 'purge-me', handoff_json = ? WHERE id = ?").run(JSON.stringify({ summary: "Submitted" }), done.id);
    writeAgent("purge-me", join(dir, "purge-cwd"), { labels: { kanban: "1", kanban_task: String(done.id) }, title: "Sample text" });
    let deleted = 0;
    setMissingCwdHooks({
      deleteAgent: async () => {
        deleted += 1;
      },
      recordPurge: () => {
        throw new Error("dry-run Do not write summary");
      },
    });
    const before = comments(done.id).length;
    const preview = (await runKanban(["purge-agents", String(done.id), "--dry-run"], cliEnv())) as { text: string; deleted: string[] };
    assert.match(preview.text, new RegExp(zhCN("missingCwd.purge.dryRunNone")));
    assert.deepEqual(preview.deleted, []);
    assert.equal(deleted, 0);
    assert.equal(comments(done.id).length, before);

    const worker = createTask({ project: "purge", title: "Worker", role: "executor", workspacePath: join(dir, "repo-root") });
    getDb().prepare("UPDATE tasks SET status = 'done', agent_id = 'worker-1' WHERE id = ?").run(worker.id);
    await assert.rejects(
      () => runKanban(["purge-agents", String(done.id)], cliEnv({ PASEO_AGENT_ID: "worker-1" })),
      (err: unknown) => err instanceof KanbanError && err.code === "forbidden",
    );
    assert.equal(deleted, 0);

    setMissingCwdHooks({
      deleteAgent: async (agentId) => {
        assert.ok(comments(done.id).some((row) => row.body.includes(zhCNPart("missingCwd.purge.source", 11, 17)) && row.body.includes("Sample text")));
        assert.ok(events(done.id, "agent_purged").some((row) => row.data_json.includes(agentId)));
        deleted += 1;
      },
    });
    const removed = (await runKanban(["purge-agents", String(done.id)], cliEnv())) as { text: string; deleted: string[] };
    assert.match(removed.text, new RegExp(zhCN("missingCwd.purge.deletedCount", {"count":"1"})));
    assert.deepEqual(removed.deleted, ["purge-me"]);
    assert.equal(deleted, 1);
  });

  it("does not comment again when purge-agents is run a second time", async () => {
    const done = createTask({ project: "purge", title: "Run once more", role: "executor", workspacePath: join(dir, "repo-root") });
    getDb().prepare("UPDATE tasks SET status = 'done', agent_id = 'purge-again' WHERE id = ?").run(done.id);
    writeAgent("purge-again", join(dir, "purge-again-cwd"), { labels: { kanban: "1", kanban_task: String(done.id) }, title: "Run again" });
    let deleted = 0;
    setMissingCwdHooks({
      deleteAgent: async () => {
        deleted += 1;
      },
    });
    const first = await purgeCardAgents(done.id);
    assert.deepEqual(first.deleted, ["purge-again"]);
    const afterFirst = comments(done.id).length;
    const purged = events(done.id, "agent_purged").length;
    assert.ok(afterFirst >= 1);
    assert.equal(purged, 1);
    const second = await purgeCardAgents(done.id);
    assert.deepEqual(second.deleted, ["purge-again"]);
    assert.equal(comments(done.id).length, afterFirst);
    assert.equal(events(done.id, "agent_purged").length, purged);
    assert.equal(deleted, 2);
    assert.match(second.text, new RegExp(zhCN("missingCwd.purge.lineDelete", {"agent":"purge-again","reason":zhCN("missingCwd.purge.notesWritten")})));
    const dry = await purgeCardAgents(done.id, { dryRun: true });
    assert.match(dry.text, new RegExp(zhCN("missingCwd.purge.lineDelete", {"agent":"purge-again","reason":zhCN("missingCwd.purge.notesWritten")})));
    assert.equal(comments(done.id).length, afterFirst);
    assert.equal(deleted, 2);

    const ghost = createTask({ project: "purge", title: "Record missing", role: "executor", workspacePath: join(dir, "repo-root") });
    getDb().prepare("UPDATE tasks SET status = 'done', agent_id = 'ghost-agent' WHERE id = ?").run(ghost.id);
    const missing = await purgeCardAgents(ghost.id);
    assert.deepEqual(missing.deleted, []);
    assert.equal(comments(ghost.id).length, 0);
    assert.match(missing.text, new RegExp(zhCN("missingCwd.purge.lineKeep", {"agent":"ghost-agent","reason":zhCN("missingCwd.purge.gone")})));
    const preview = await purgeCardAgents(ghost.id, { dryRun: true });
    assert.match(preview.text, new RegExp(zhCN("missingCwd.purge.lineKeep", {"agent":"ghost-agent","reason":zhCN("missingCwd.purge.gone")})));
    assert.equal(comments(ghost.id).length, 0);
  });

  it("retries a failed delete without writing the summary again", async () => {
    const done = createTask({ project: "purge", title: "Retry deletion failure", role: "executor", workspacePath: join(dir, "repo-root") });
    getDb().prepare("UPDATE tasks SET status = 'done', agent_id = 'purge-retry' WHERE id = ?").run(done.id);
    writeAgent("purge-retry", join(dir, "purge-retry-cwd"), { labels: { kanban: "1", kanban_task: String(done.id) }, title: "demo fixture" });
    let attempts = 0;
    setMissingCwdHooks({
      deleteAgent: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error((zhCNPart("compat.tick.last", 0, 2) + zhCN("missingCwd.purge.deleteFailed")));
      },
    });
    const first = await purgeCardAgents(done.id);
    assert.deepEqual(first.deleted, []);
    assert.match(first.text, new RegExp(zhCN("missingCwd.purge.writeFailed")));
    const notes = comments(done.id).length;
    assert.equal(notes, 1);
    assert.equal(events(done.id, "agent_purged").length, 1);
    const second = await purgeCardAgents(done.id);
    assert.deepEqual(second.deleted, ["purge-retry"]);
    assert.match(second.text, new RegExp(zhCN("missingCwd.purge.lineDelete", {"agent":"purge-retry","reason":zhCN("missingCwd.purge.notesWritten")})));
    assert.equal(comments(done.id).length, notes);
    assert.equal(events(done.id, "agent_purged").length, 1);
    assert.equal(attempts, 2);
  });

  it("deletes a recorded agent during worktree cleanup without writing the summary again", async () => {
    const id = createTask({ project: "cwd", title: "Retry cleanup", role: "executor", workspacePath: join(dir, "repo-root") }).id;
    const directory = join(trees, "purge-recorded");
    mkdirSync(directory, { recursive: true });
    remember(id, directory);
    getDb().prepare("UPDATE tasks SET status = 'done', agent_id = 'agent-recorded' WHERE id = ?").run(id);
    writeAgent("agent-recorded", directory, { labels: { kanban: "1", kanban_task: String(id) }, title: "Already recorded" });
    appendEvent(id, "agent_purged", null, null, "kanban", { agentId: "agent-recorded", summary: "Previously written" });
    let deleted = 0;
    setMissingCwdHooks({
      deleteAgent: async () => {
        deleted += 1;
      },
      recordPurge: () => {
        throw new Error((zhCNPart("cleanup.reason.gone", 0, 2) + "Demo text"));
      },
    });
    assert.equal(comments(id).length, 0);
    assert.equal(await settle(id, directory), "settled");
    assert.equal(deleted, 1);
    assert.equal(comments(id).length, 0);
    assert.equal(events(id, "agent_purged").length, 1);
    assert.equal(existsSync(directory), false);
  });

  it("refuses to pass --all or --cwd to paseo agent delete", async () => {
    const calls: string[][] = [];
    await deletePaseoAgent("abc.1", async (_cmd, args) => {
      calls.push(args);
      return "";
    });
    assert.deepEqual(calls, [["agent", "delete", "abc.1", "--json"]]);
    await assert.rejects(() => deletePaseoAgent("--all", async () => ""));
    await assert.rejects(() => deletePaseoAgent("-lead", async () => ""));
  });

  it("reads the installed protocol and still has no cwd filter", () => {
    const result = checkAgentCwdSource();
    assert.equal(result.status, "pass");
  });

  it("prints a human list and a json report without creating directories", async () => {
    const bucket = join(checkAgents, "bucket");
    mkdirSync(bucket, { recursive: true });
    const missing = join(dir, "check-missing");
    const placeholder = join(dir, "check-placeholder");
    const healthy = join(dir, "check-healthy");
    mkdirSync(placeholder, { recursive: true });
    writeFileSync(join(placeholder, PLACEHOLDER_NAME), ((zhCN("missingCwd.report.placeholder") + "\n")));
    mkdirSync(healthy, { recursive: true });
    const missingFile = join(bucket, "missing-one.json");
    writeFileSync(
      missingFile,
      JSON.stringify({ id: "missing-one", cwd: missing, title: "Directory missing", provider: "alternate", archivedAt: "2026-09-27T00:00:00.000Z", labels: {} }),
    );
    writeFileSync(
      join(bucket, "placeholder-one.json"),
      JSON.stringify({ id: "placeholder-one", cwd: placeholder, title: "Sample text", provider: "alternate", archivedAt: null, labels: { kanban: "1" } }),
    );
    writeFileSync(
      join(bucket, "healthy-one.json"),
      JSON.stringify({ id: "healthy-one", cwd: healthy, title: "demo fixture", provider: "alternate", archivedAt: null, labels: {} }),
    );
    const stamp = statSync(missingFile).mtimeMs;
    const listPath = join(dir, "missing-cwd-list.md");
    const built = buildMissingCwdReport({ agentsRoot: checkAgents, listPath, now: new Date("2026-09-28T02:00:00.000Z") });
    assert.equal(built.report.checkedAt, "2026-09-28T02:00:00.000Z");
    assert.equal(built.report.count, 1);
    assert.equal(built.report.placeholder, 1);
    assert.equal(built.report.listPath, listPath);
    assert.equal(built.report.items.length, built.report.count);
    assert.deepEqual(built.report.items, [{ agentId: "missing-one", cwd: missing, title: "Directory missing", archived: true }]);
    assert.equal(existsSync(missing), false);
    assert.equal(statSync(missingFile).mtimeMs, stamp);
    assert.match(readFileSync(listPath, "utf8"), new RegExp(zhCN("missingCwd.report.missing")));
    assert.match(readFileSync(listPath, "utf8"), new RegExp(zhCN("missingCwd.report.placeholder")));
    assert.match(built.human, new RegExp(zhCN("missingCwd.report.missing")));
    assert.match(built.human, new RegExp(zhCN("missingCwd.report.placeholder")));
    assert.equal(built.code, 1);

    const json = await runCheck(["--json"], checkAgents);
    assert.ok(json.ms < SUBPROCESS_TIMEOUT_MS, `check-missing-cwd took ${json.ms}ms`);
    assert.equal(json.code, 1);
    const report = JSON.parse(json.stdout) as {
      checkedAt: string;
      count: number;
      placeholder: number;
      listPath: string;
      items: Array<{ agentId: string; cwd: string; title: string; archived: boolean }>;
    };
    assert.equal(report.count, 1);
    assert.equal(report.placeholder, 1);
    assert.equal(report.items.length, report.count);
    assert.equal(report.items[0]?.agentId, "missing-one");
    assert.equal(report.items[0]?.archived, true);
    assert.equal(existsSync(report.listPath), true);
    assert.equal(existsSync(missing), false);

    const human = await runCheck([], checkAgents);
    assert.ok(human.ms < SUBPROCESS_TIMEOUT_MS, `check-missing-cwd took ${human.ms}ms`);
    assert.equal(human.code, 1);
    assert.match(human.stdout, new RegExp(zhCN("missingCwd.report.missing")));
    assert.match(human.stdout, new RegExp(zhCN("missingCwd.report.placeholder")));
    assert.match(human.stdout, new RegExp(zhCN("missingCwd.report.listFile")));

    const unknown = await runCheck(["--json", "--nope"], checkAgents);
    assert.equal(unknown.code, 2);
    assert.match(unknown.stderr, new RegExp(localePattern(zhCNPart("checkMissingCwd.unknownArg", 0, 4))));

    rmSync(missingFile);
    const onlyPlaceholder = await runCheck(["--json"], checkAgents);
    assert.ok(onlyPlaceholder.ms < SUBPROCESS_TIMEOUT_MS, `check-missing-cwd took ${onlyPlaceholder.ms}ms`);
    assert.equal(onlyPlaceholder.code, 0);
    const quiet = JSON.parse(onlyPlaceholder.stdout) as { count: number; placeholder: number; items: unknown[] };
    assert.equal(quiet.count, 0);
    assert.equal(quiet.placeholder, 1);
    assert.deepEqual(quiet.items, []);
    assert.equal(existsSync(placeholder), true);
  });
});
