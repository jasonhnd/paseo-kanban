/// <reference types="node" />
import { zhCN, zhCNPart, localePattern } from "./helpers/locale";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, beforeEach, describe, it } from "node:test";
import type { PaseoApi } from "@getpaseo/client";
import { setAgentAliveCheck, resetAgentAliveCheck } from "../server/alive";
import { setWakeSender } from "../server/bus";
import { cardMark } from "../server/card-ref";
import { runKanban } from "../server/cli";
import { doctorSettings, loadConfig, saveConfig, type DoctorSettings } from "../server/config";
import { closeDb, getDb } from "../server/db";
import {
  formatDoctor,
  parseWorktreePorcelain,
  clearDoctorSafetyCache,
  readLastDoctorReport,
  remoteTipFromLs,
  runDoctor,
  type DoctorAgent,
  type DoctorBoard,
  type DoctorDirs,
  type DoctorFinding,
  type DoctorGit,
  type DoctorReport,
  type DoctorSources,
  type DoctorWorkspace,
} from "../server/doctor";
import { collectLiveSources, collectRepoRoots, maybeRunScheduledDoctor } from "../server/doctor-live";
import { createTask } from "../server/store";
import { setLanguage } from "../shared/i18n";
import { handleTool } from "../server/tools";
import { publishAnonymousPolicy } from "./helpers/anonymous-policy";
import { policySnapshotPath } from "../server/application/policy-snapshot";

const tmp = realpathSync(tmpdir());
mkdirSync(tmp, { recursive: true });
const dir = mkdtempSync(join(tmp, "doctor-"));
process.env.KANBAN_DATA_DIR = dir;

const NOW = new Date("2026-10-01T03:00:00.000Z");
/** Upper bound for "this must finish, not hang" races; never reached when the code under test works. */
const HANG_GUARD_MS = 5_000;
const ROOT = join(dir, "worktrees");
const REPO = join(dir, "repo");

const settings: DoctorSettings = {
  ...doctorSettings(null),
  blockedHours: { dependency: 48, needs_human: 1, capability: 1, quota: 24, rate_limit: 4, transient: 1 },
  acceptanceHours: 1,
  readyHours: 1,
  landPendingMinutes: 30,
  cleanupStaleHours: 2,
  totalTimeoutMs: 5_000,
  commandTimeoutMs: 1_000,
};

function resetDb(): void {
  const db = getDb();
  db.exec("DELETE FROM start_claims; DELETE FROM events; DELETE FROM runs; DELETE FROM comments; DELETE FROM links; DELETE FROM tokens; DELETE FROM tasks;");
  try {
    rmSync(join(dir, "doctor-report.json"), { force: true });
  } catch {
    // no report yet
  }
}

function fingerprint(): string {
  const db = getDb();
  return JSON.stringify({
    tasks: db.prepare("SELECT * FROM tasks ORDER BY id").all(),
    runs: db.prepare("SELECT * FROM runs ORDER BY id").all(),
    events: db.prepare("SELECT * FROM events ORDER BY id").all(),
  });
}

function event(taskId: number, kind: string, data: Record<string, unknown>, at = NOW.toISOString(), toStatus: string | null = null): void {
  getDb()
    .prepare("INSERT INTO events (task_id, at, kind, to_status, actor, data_json) VALUES (?, ?, ?, ?, 'test', ?)")
    .run(taskId, at, kind, toStatus, JSON.stringify(data));
}

function open(title: string): ReturnType<typeof createTask> {
  return createTask({ project: "doctor", title, role: "executor", workspacePath: REPO });
}

function hoursAgo(hours: number): string {
  return new Date(NOW.getTime() - hours * 3_600_000).toISOString();
}

function board(over: Partial<DoctorBoard> = {}): DoctorBoard {
  return {
    plugin: "running",
    quota: "fresh",
    quotaAgeMs: 1_000,
    matrix: "ok",
    matrixAgeMs: 1_000,
    tickAt: NOW.toISOString(),
    missingCwdCount: 0,
    ...over,
  };
}

function git(over: Partial<DoctorGit> = {}): DoctorGit {
  return {
    repos: [REPO],
    async worktrees() {
      return [];
    },
    async dirty() {
      return false;
    },
    async branches() {
      return [];
    },
    async pushed() {
      return true;
    },
    async pr() {
      return "merged";
    },
    ...over,
  };
}

function dirs(list: string[], worktrees: string[], placeholders: Record<string, string[] | null> = {}): DoctorDirs {
  return {
    root: ROOT,
    worktrees,
    list: () => list,
    placeholderAgents(path: string) {
      return Object.prototype.hasOwnProperty.call(placeholders, path) ? placeholders[path] : null;
    },
  };
}

function ws(id: string, directory: string, over: Partial<DoctorWorkspace> = {}): DoctorWorkspace {
  return { id, name: id, directory, projectRoot: REPO, kind: "worktree", archived: false, ...over };
}

async function check(sources: DoctorSources, extra?: Partial<{ wake: boolean; persist: boolean; settings: DoctorSettings; clock: () => number }>): Promise<DoctorReport> {
  clearDoctorSafetyCache();
  return runDoctor({ now: NOW, settings: extra?.settings ?? settings, sources, wake: extra?.wake ?? false, persist: extra?.persist ?? false, clock: extra?.clock });
}

function has(report: DoctorReport, idPrefix: string): DoctorFinding | undefined {
  return report.findings.find((item) => item.id.startsWith(idPrefix));
}

beforeEach(() => resetDb());

// Command timeouts are unref'd so a hung git call does not hold Paseo open.
// Node's test runner cancels a test that is waiting only on an unref'd timer.
const keepAlive = setInterval(() => {}, 60_000);

after(() => {
  clearInterval(keepAlive);
  resetAgentAliveCheck();
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe("doctor", () => {
  it("parses worktree porcelain, including a detached entry", () => {
    const parsed = parseWorktreePorcelain("worktree /repo\nHEAD abc\nbranch refs/heads/main\n\nworktree /tmp/wt\nHEAD def\ndetached\n");
    assert.deepEqual(parsed, [
      { path: "/repo", branch: "main" },
      { path: "/tmp/wt", branch: null },
    ]);
  });

  it("flags a worktree workspace with no open card, and ignores one an open card holds", async () => {
    const live = open(zhCNPart("doctor.agent.double.symptom", 7, 9));
    getDb().prepare("UPDATE tasks SET paseo_workspace_id = 'w-live', workspace_kind = 'worktree' WHERE id = ?").run(live.id);
    const orphan = await check({ workspaces: [ws("w-live", join(ROOT, "live")), ws("w-old", join(ROOT, "old"))] });
    assert.equal(has(orphan, "ws:orphan:w-old")?.severity, "red");
    assert.equal(has(orphan, "ws:orphan:w-live"), undefined);
  });

  it("flags a workspace that is still there after cleanup, and skips one already archived", async () => {
    const done = open("Already collected");
    getDb().prepare("UPDATE tasks SET status = 'done', workspace_kind = 'worktree', paseo_workspace_id = 'w-done' WHERE id = ?").run(done.id);
    event(done.id, "cleanup_finished", {});
    const reported = await check({ workspaces: [ws("w-done", join(ROOT, "done"))] });
    assert.match(has(reported, "ws:orphan:w-done")?.symptom ?? "", new RegExp(localePattern(zhCNPart("doctor.agent.orphan.cleaned", 5, 10))));
    const archived = await check({ workspaces: [ws("w-done", join(ROOT, "done"), { archived: true })] });
    assert.equal(has(archived, "ws:orphan:"), undefined);
  });

  it("flags two workspaces on one card, and ignores a single binding", async () => {
    const card = open(zhCNPart("nativeSessions.manifest.duplicateMove", 3, 5));
    event(card.id, "workspace_bound", { workspaceId: "w-a" });
    event(card.id, "workspace_bound", { workspaceId: "w-b" });
    const hit = await check({
      workspaces: [ws("w-a", join(ROOT, "a")), ws("w-b", join(ROOT, "b"))],
    });
    assert.equal(has(hit, `ws:multi:${card.id}`)?.severity, "red");
    assert.match(has(hit, `ws:multi:${card.id}`)?.symptom ?? "", new RegExp(localePattern(zhCNPart("doctor.ws.multi.symptom", 6, 18))));
    resetDb();
    const one = open(zhCNPart("server.pickProject", 3, 5));
    event(one.id, "workspace_bound", { workspaceId: "w-a" });
    const quiet = await check({ workspaces: [ws("w-a", join(ROOT, "a"))] });
    assert.equal(has(quiet, "ws:multi:"), undefined);
    resetDb();
    const normal = open((zhCNPart("doctor.repo.missing", 0, 3) + "Demo text"));
    event(normal.id, "workspace_bound", { workspaceId: "w-main", name: "main" });
    event(normal.id, "workspace_bound", { workspaceId: "w-card" });
    const mainAndCard = await check({
      workspaces: [ws("w-main", join(ROOT, "main"), { kind: "dir", name: "main" }), ws("w-card", join(ROOT, "card"))],
    });
    assert.equal(has(mainAndCard, "ws:multi:"), undefined);
  });

  it("flags a git worktree that is not an open card, including a non-kanban branch, and keeps one that is", async () => {
    const card = open("Working");
    const owned = join(ROOT, "owned");
    const foreign = join(ROOT, "docs-branch");
    getDb().prepare("UPDATE tasks SET workspace_path = ?, workspace_kind = 'worktree' WHERE id = ?").run(owned, card.id);
    const report = await check({
      dirs: dirs([owned, foreign], [owned, foreign]),
      git: git({
        async worktrees() {
          return [
            { path: owned, branch: `kanban/${cardMark(card.id)}-task` },
            { path: foreign, branch: "docs/demo-0054-auth-sec-106" },
          ];
        },
      }),
    });
    assert.equal(has(report, "git:worktree:")?.object, foreign);
    assert.equal(report.findings.filter((item) => item.check === "worktree").length, 1);
  });

  it("keeps a git worktree that an unfinished card borrows by workspace id, and flags it once every card is done", async () => {
    const owner = open(zhCN("labels.role.reader"));
    const reviewer = open(zhCN("labels.role.reviewer"));
    const shared = join(ROOT, "shared");
    getDb().prepare("UPDATE tasks SET workspace_path = ?, workspace_kind = 'worktree', paseo_workspace_id = 'w-shared', status = 'done' WHERE id = ?").run(shared, owner.id);
    getDb().prepare("UPDATE tasks SET workspace_path = ?, paseo_workspace_id = 'w-shared', status = 'reviewing' WHERE id = ?").run(REPO, reviewer.id);
    getDb().prepare("UPDATE tasks SET updated_at = ? WHERE id IN (?, ?)").run(hoursAgo(3), reviewer.id, owner.id);
    event(reviewer.id, "workspace_bound", { workspaceId: "w-shared" });
    const sources = (): DoctorSources => ({
      workspaces: [ws("w-shared", shared)],
      dirs: dirs([shared], [shared]),
      git: git({
        async worktrees() {
          return [{ path: shared, branch: "kanban/other" }];
        },
      }),
    });
    assert.equal(has(await check(sources()), "git:worktree:"), undefined);
    getDb().prepare("UPDATE tasks SET status = 'done' WHERE id IN (?, ?)").run(reviewer.id, owner.id);
    assert.equal(has(await check(sources()), "git:worktree:")?.object, shared);
  });

  it("says unknown instead of safe when gh fails, and safe when the tree is clean and merged", async () => {
    const foreign = join(ROOT, "foreign");
    const unknown = await check({
      dirs: dirs([foreign], [foreign]),
      git: git({
        async worktrees() {
          return [{ path: foreign, branch: "docs/topic" }];
        },
        async pr() {
          return "unknown";
        },
      }),
    });
    assert.match(has(unknown, "git:worktree:")?.suggestion ?? "", /unknown/);
    assert.equal((has(unknown, "git:worktree:")?.suggestion ?? "").includes(zhCN("doctor.safety.safe")), false);
    const safe = await check({
      dirs: dirs([foreign], [foreign]),
      git: git({
        async worktrees() {
          return [{ path: foreign, branch: "docs/topic" }];
        },
      }),
    });
    assert.match(has(safe, "git:worktree:")?.suggestion ?? "", new RegExp(zhCN("doctor.safety.safe")));
  });

  it("keeps going when one repo's git fails", async () => {
    const foreign = join(ROOT, "ok");
    const bad = join(dir, "bad-repo");
    const report = await check({
      dirs: dirs([foreign], [foreign]),
      git: git({
        repos: [bad, REPO],
        async worktrees(repo: string) {
          if (repo === bad) throw new Error(("git " + zhCNPart("panelPrefs.brokenNoBackup", 4, 6)));
          return [{ path: foreign, branch: "docs/topic" }];
        },
      }),
    });
    assert.equal(has(report, `check:worktree:${bad}`)?.severity, "info");
    assert.equal(has(report, "git:worktree:")?.object, foreign);
  });

  it("stops the rest of the checkup at the total timeout and keeps earlier findings", async (t) => {
    // Advance both the deadline clock and command timer explicitly. Parallel CPU
    // load must not consume the budget before the earlier checks have run.
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: NOW });
    const later = join(ROOT, "later");
    const visited: string[] = [];
    let reachedSlow!: () => void;
    const slowStarted = new Promise<void>((resolve) => { reachedSlow = resolve; });
    const pending = check(
      {
        workspaces: [ws("w-old", join(ROOT, "old"))],
        dirs: dirs([later], []),
        git: git({
          repos: [join(dir, "slow"), REPO],
          async worktrees(repo: string) {
            visited.push(repo);
            if (repo.endsWith("slow")) {
              reachedSlow();
              return new Promise(() => undefined);
            }
            return [{ path: later, branch: "docs/later" }];
          },
        }),
        board: board({ plugin: "stopped" }),
      },
      { settings: { ...settings, totalTimeoutMs: 80, commandTimeoutMs: 5_000 } },
    );
    await slowStarted;
    t.mock.timers.tick(80);
    const report = await pending;
    assert.equal(report.timedOut, true);
    assert.equal(report.durationMs, 80);
    assert.deepEqual(visited, [join(dir, "slow")]);
    assert.equal(has(report, "check:timeout")?.severity, "info");
    assert.equal(has(report, `check:worktree:${join(dir, "slow")}`)?.evidence, zhCN("audit.timeout"));
    assert.ok(has(report, "ws:orphan:w-old"));
    assert.equal(has(report, "board:plugin")?.severity, "red");
    assert.equal(has(report, "git:worktree:"), undefined);
  });

  it("flags a leftover kanban branch after cleanup, and ignores a branch on an open card", async () => {
    const done = open((zhCNPart("settings.projects.base", 2, 4) + zhCNPart("nativeSessions.sweep.uncardedTmp", 12, 14)));
    const mark = cardMark(done.id);
    getDb().prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(done.id);
    event(done.id, "cleanup_finished", {});
    const branch = `kanban/${mark}-task`;
    const hit = await check({ git: git({ async branches() { return [branch]; } }) });
    assert.equal(has(hit, "git:branch:")?.severity, "yellow");
    resetDb();
    const live = open((zhCNPart("doctor.branch.leftover", 21, 25) + zhCNPart("labels.assigner.user", 0, 1)));
    const liveBranch = `kanban/${cardMark(live.id)}-task`;
    const quiet = await check({ git: git({ async branches() { return [liveBranch]; } }) });
    assert.equal(has(quiet, "git:branch:"), undefined);
  });

  it("flags a stray directory and a placeholder whose agents are gone, and ignores a worktree and a live placeholder", async () => {
    const parent = join(ROOT, "hash");
    const stray = join(ROOT, "hash", "pr-661-analytics");
    const bucket = join(ROOT, "hash2");
    const real = join(ROOT, "hash2", "card");
    const placeholder = join(ROOT, "hash3", "gone");
    const held = join(ROOT, "hash4", "held");
    const report = await check({
      dirs: dirs([parent, stray, bucket, real, placeholder, held], [real], {
        [placeholder]: ["gone-agent"],
        [held]: ["live-agent"],
      }),
      agents: { agents: [{ id: "live-agent", archived: false }] },
    });
    assert.equal(has(report, "dir:stray:")?.object, stray);
    assert.equal(report.findings.filter((item) => item.id.startsWith("dir:stray:")).length, 1);
    assert.match(has(report, "dir:placeholder:")?.symptom ?? "", new RegExp("agent " + localePattern(zhCNPart("doctor.dir.placeholder.gone", 15, 19))));
    assert.equal(report.findings.some((item) => item.object === real || item.object === held || item.object === parent), false);
  });

  it("keeps archived placeholder records and suggests the card's purge command", async () => {
    const task = open(zhCN("server.archived", {"card":"agent"}));
    const place = join(ROOT, "archived-placeholder");
    const report = await check({
      dirs: dirs([place], [], { [place]: ["archived-agent", "gone-agent"] }),
      agents: { agents: [{ id: "archived-agent", archived: true, labels: { kanban_task: String(task.id) } }], paseoIds: [] },
    });
    const finding = has(report, "dir:placeholder:");
    assert.equal(finding?.severity, "yellow");
    assert.match(finding?.symptom ?? "", new RegExp(localePattern(zhCNPart("doctor.dir.placeholder.retained", 11, 17))));
    assert.match(finding?.suggestion ?? "", new RegExp(`purge-agents ${cardMark(task.id)}`));
    assert.equal(finding?.symptom.includes(zhCNPart("doctor.dir.placeholder.gone", 15, 19)), false);
  });

  it("uses a card code in an archived agent title when labels are absent", async () => {
    const place = join(ROOT, "title-placeholder");
    const report = await check({
      dirs: dirs([place], [], { [place]: ["archived-agent"] }),
      agents: { agents: [{ id: "archived-agent", archived: true, title: ("【" + zhCN("labels.role.reviewer") + "】TEST_0073 " + zhCN("compat.run.failed") + "Demo text") }], paseoIds: [] },
    });
    assert.match(has(report, "dir:placeholder:")?.suggestion ?? "", /purge-agents TEST_0073/);
  });

  it("requires both the active list and agent records to be absent before declaring a placeholder gone", async () => {
    const place = join(ROOT, "active-placeholder");
    const report = await check({
      dirs: dirs([place], [], { [place]: ["api-agent"] }),
      agents: { agents: [], paseoIds: ["api-agent"] },
    });
    assert.equal(has(report, "dir:placeholder:"), undefined);
    const gone = await check({
      dirs: dirs([place], [], { [place]: ["api-agent"] }),
      agents: { agents: [], paseoIds: [] },
    });
    assert.match(has(gone, "dir:placeholder:")?.symptom ?? "", new RegExp(localePattern(zhCNPart("doctor.dir.placeholder.gone", 15, 19))));
  });

  it("marks placeholder checks unknown when agent records are unavailable", async () => {
    const place = join(ROOT, "unknown-placeholder");
    for (const agents of [undefined, { agents: [], paseoIds: [], error: "EACCES: agent directory" }]) {
      const report = await check({ dirs: dirs([place], [], { [place]: ["hidden-agent"] }), agents });
      assert.equal(has(report, "dir:placeholder:"), undefined);
      assert.match(has(report, "check:directory:")?.evidence ?? "", /unknown/);
    }
  });

  it("checks archived records on disk and fails closed when the agent directory cannot be read", async () => {
    const prevAgents = process.env.KANBAN_AGENTS_DIR;
    const prevWt = process.env.KANBAN_WORKTREES_ROOT;
    const root = join(dir, "placeholder-agents");
    const bucket = join(root, "cwd");
    const wt = join(dir, "placeholder-worktrees");
    const place = join(wt, "project", "place");
    mkdirSync(bucket, { recursive: true });
    mkdirSync(place, { recursive: true });
    writeFileSync(join(place, "README-placeholder.txt"), (zhCN("doctor.safety.agent", {"value":"a"}) + "rchived-agent\n"));
    const record = join(bucket, "archived-agent.json");
    writeFileSync(record, JSON.stringify({ id: "archived-agent", title: ("【" + zhCN("labels.role.executor") + "】TEST_0081"), archivedAt: NOW.toISOString(), cwd: place }));
    process.env.KANBAN_AGENTS_DIR = root;
    process.env.KANBAN_WORKTREES_ROOT = wt;
    const emptyPage = { entries: [], pageInfo: { nextCursor: null } };
    const paseo = {
      workspaces: { list: async () => emptyPage },
      agents: { list: async () => emptyPage },
    } as unknown as PaseoApi;
    const diagnose = async () => {
      const sources = await collectLiveSources(paseo, Date.now(), Date.now() + 20_000);
      return check({ agents: sources.agents, dirs: sources.dirs });
    };
    try {
      const archived = await diagnose();
      assert.equal(has(archived, "dir:placeholder:")?.severity, "yellow");
      assert.match(has(archived, "dir:placeholder:")?.suggestion ?? "", /purge-agents TEST_0081/);
      chmodSync(bucket, 0);
      const unread = await diagnose();
      assert.equal(has(unread, "dir:placeholder:"), undefined);
      assert.match(has(unread, "check:directory:")?.evidence ?? "", /unknown.*EACCES|unknown.*EPERM/);
      chmodSync(bucket, 0o755);
      // Move the fixture record out of the agent tree to simulate a deleted record.
      renameSync(record, join(dir, "deleted-agent-fixture.json"));
      const gone = await diagnose();
      assert.match(has(gone, "dir:placeholder:")?.symptom ?? "", new RegExp(localePattern(zhCNPart("doctor.dir.placeholder.gone", 15, 19))));
    } finally {
      chmodSync(bucket, 0o755);
      if (prevAgents == null) delete process.env.KANBAN_AGENTS_DIR;
      else process.env.KANBAN_AGENTS_DIR = prevAgents;
      if (prevWt == null) delete process.env.KANBAN_WORKTREES_ROOT;
      else process.env.KANBAN_WORKTREES_ROOT = prevWt;
    }
  });

  it("flags an orphan kanban agent after cleanup, and ignores one on an open card", async () => {
    const done = open("Orphan");
    getDb().prepare("UPDATE tasks SET status = 'done', agent_id = 'orphan-agent' WHERE id = ?").run(done.id);
    event(done.id, "cleanup_finished", {});
    const agents: DoctorAgent[] = [
      { id: "orphan-agent", archived: false, labels: { kanban: "1", kanban_task: String(done.id), role: "executor" } },
    ];
    const hit = await check({ agents: { agents } });
    assert.equal(has(hit, "agent:orphan:orphan-agent")?.severity, "red");
    resetDb();
    const live = open(zhCNPart("reclaimNote.result.running", 0, 2));
    getDb().prepare("UPDATE tasks SET status = 'running', agent_id = 'live-agent' WHERE id = ?").run(live.id);
    const quiet = await check({
      agents: {
        agents: [{ id: "live-agent", archived: false, labels: { kanban: "1", kanban_task: String(live.id), role: "executor" }, status: "running" }],
        paseoIds: ["live-agent"],
      },
    });
    assert.equal(has(quiet, "agent:orphan:"), undefined);
    assert.equal(has(quiet, "agent:missing:"), undefined);
  });

  it("flags a running card whose agent is gone, and ignores one Paseo still lists", async () => {
    const gone = open("Agent missing");
    getDb().prepare("UPDATE tasks SET status = 'running', agent_id = 'missing-agent' WHERE id = ?").run(gone.id);
    const hit = await check({ agents: { agents: [], paseoIds: [] } });
    assert.equal(has(hit, `agent:missing:${gone.id}`)?.severity, "red");
    const quiet = await check({
      agents: {
        agents: [{ id: "missing-agent", archived: false, labels: { kanban: "1", kanban_task: String(gone.id) } }],
        paseoIds: ["missing-agent"],
      },
    });
    assert.equal(has(quiet, "agent:missing:"), undefined);
  });

  it("flags two live executors on one card, and ignores a single one", async () => {
    const card = open(zhCNPart("doctor.agent.double.symptom", 5, 7));
    getDb().prepare("UPDATE tasks SET status = 'running', agent_id = 'exec-a' WHERE id = ?").run(card.id);
    const both: DoctorAgent[] = [
      { id: "exec-a", archived: false, labels: { kanban: "1", kanban_task: String(card.id), role: "executor" } },
      { id: "exec-b", archived: false, labels: { kanban: "1", kanban_task: String(card.id), role: "executor" } },
    ];
    const hit = await check({ agents: { agents: both, paseoIds: ["exec-a", "exec-b"] } });
    assert.equal(has(hit, `agent:double:${card.id}`)?.severity, "red");
    const quiet = await check({ agents: { agents: [both[0]], paseoIds: ["exec-a"] } });
    assert.equal(has(quiet, "agent:double:"), undefined);
  });

  it("flags an idle running agent past the stall threshold, and ignores a recent idle", async () => {
    const card = open(zhCNPart("audit.summary.stalled", 1, 3));
    getDb().prepare("UPDATE tasks SET status = 'running', agent_id = 'idle-agent' WHERE id = ?").run(card.id);
    const stale: DoctorAgent = {
      id: "idle-agent",
      archived: false,
      status: "idle",
      idleSince: new Date(NOW.getTime() - 11 * 60_000).toISOString(),
      labels: { kanban: "1", kanban_task: String(card.id), role: "executor" },
    };
    const hit = await check({ agents: { agents: [stale], paseoIds: ["idle-agent"] } });
    assert.equal(has(hit, `card:idle:${card.id}`)?.severity, "yellow");
    const fresh = { ...stale, idleSince: new Date(NOW.getTime() - 60_000).toISOString() };
    const quiet = await check({ agents: { agents: [fresh], paseoIds: ["idle-agent"] } });
    assert.equal(has(quiet, "card:idle:"), undefined);
  });

  it("flags a long block, a long acceptance, a stuck land, and a stale cleanup, and ignores the fresh ones", async () => {
    const blocked = open(zhCN("labels.status.blocked"));
    getDb().prepare("UPDATE tasks SET status = 'blocked', blocked_kind = 'needs_human', blocked_at = ? WHERE id = ?").run(hoursAgo(3), blocked.id);
    const waiting = open(zhCN("decisions.hold.acceptance"));
    getDb().prepare("UPDATE tasks SET status = 'acceptance', updated_at = ? WHERE id = ?").run(hoursAgo(3), waiting.id);
    event(waiting.id, "entered", {}, hoursAgo(3), "acceptance");
    const landing = open(zhCN("labels.badge.conflictWord"));
    event(landing.id, "land_pending", { reason: "conflict", branch: "kanban/x", base: "main", conflict: true, files: ["a.ts"] }, hoursAgo(2));
    const dirty = open("Cannot clean");
    getDb().prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(dirty.id);
    event(dirty.id, "cleanup", { action: "skip_worktree", ok: false, reason: "not_merged", directory: REPO }, hoursAgo(5));
    const hit = await check({});
    assert.equal(has(hit, `card:blocked:${blocked.id}`)?.severity, "red");
    assert.equal(has(hit, `card:acceptance:${waiting.id}`)?.severity, "red");
    assert.equal(has(hit, `card:land:${landing.id}`)?.severity, "red");
    assert.match(has(hit, `card:cleanup:${dirty.id}`)?.symptom ?? "", /not_merged/);
    resetDb();
    const freshBlock = open(zhCNPart("ui.duration.justBlocked", 1, 4));
    getDb().prepare("UPDATE tasks SET status = 'blocked', blocked_kind = 'needs_human', blocked_at = ? WHERE id = ?").run(NOW.toISOString(), freshBlock.id);
    const freshAccept = open("Just accepted");
    getDb().prepare("UPDATE tasks SET status = 'acceptance' WHERE id = ?").run(freshAccept.id);
    event(freshAccept.id, "entered", {}, NOW.toISOString(), "acceptance");
    const freshLand = open("Just queued");
    event(freshLand.id, "land_pending", { reason: "Dirty main directory", branch: "kanban/y", base: "main" }, NOW.toISOString());
    const freshClean = open("Just failed");
    getDb().prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(freshClean.id);
    event(freshClean.id, "cleanup", { action: "skip_worktree", ok: false, reason: "not_merged" }, NOW.toISOString());
    const quiet = await check({});
    assert.equal(has(quiet, "card:blocked:"), undefined);
    assert.equal(has(quiet, "card:acceptance:"), undefined);
    assert.equal(has(quiet, "card:land:"), undefined);
    assert.equal(has(quiet, "card:cleanup:"), undefined);
  });

  it("flags a running card with no agent after an ambiguous lost-create recovery", async () => {
    const stuck = open("Two candidates");
    getDb().prepare("UPDATE tasks SET status = 'running', agent_id = NULL WHERE id = ?").run(stuck.id);
    event(stuck.id, "agent_creating", { role: "executor", profile: zhCN("labels.role.executor") }, hoursAgo(1));
    event(stuck.id, "agent_recover_ambiguous", { agentIds: ["cand-a", "cand-b"] }, NOW.toISOString());
    const restarted = open("Restarted");
    getDb().prepare("UPDATE tasks SET status = 'running', agent_id = NULL WHERE id = ?").run(restarted.id);
    event(restarted.id, "agent_recover_ambiguous", { agentIds: ["old-a", "old-b"] }, hoursAgo(2));
    event(restarted.id, "agent_creating", { role: "executor", profile: zhCN("labels.role.executor") }, hoursAgo(1));
    const bound = open((zhCNPart("cleanup.reason.gone", 0, 2) + zhCNPart("doctor.ambiguous.symptom", 39, 41)));
    getDb().prepare("UPDATE tasks SET status = 'running', agent_id = 'cand-c' WHERE id = ?").run(bound.id);
    event(bound.id, "agent_recover_ambiguous", { agentIds: ["cand-c", "cand-d"] }, NOW.toISOString());
    const hit = await check({});
    const finding = has(hit, `card:recover-ambiguous:${stuck.id}`);
    assert.equal(finding?.severity, "red");
    assert.match(finding?.suggestion ?? "", /cand-a、cand-b/);
    assert.equal(finding?.object, "cand-a, cand-b");
    assert.equal(has(hit, `card:recover-ambiguous:${restarted.id}`), undefined);
    assert.equal(has(hit, `card:recover-ambiguous:${bound.id}`), undefined);
  });

  it("flags ready that is not a normal queue, and ignores quota or concurrency holds", async () => {
    const stuck = open(zhCNPart("doctor.ready.suggestion", 27, 30));
    getDb().prepare(("UPDATE tasks SET status = 'ready', hold_reason = '" + zhCN("routing.profileMissing") + "', updated_at = ? WHERE id = ?")).run(hoursAgo(3), stuck.id);
    const queued = open("Queued");
    getDb().prepare((zhCN("schedule.roleFull", {"role":("UPDATE tasks SET status = 'ready', hold_reason = '" + zhCNPart("reworkReassign.waitingAutoStart", 0, 7) + zhCN("labels.role.executor"))}) + "', updated_at = ? WHERE id = ?")).run(hoursAgo(48), queued.id);
    const report = await check({});
    assert.equal(has(report, `card:ready:${stuck.id}`)?.severity, "yellow");
    assert.equal(has(report, `card:ready:${queued.id}`), undefined);
    const quotaWait = open(zhCN("boardView.quota.headline"));
    getDb().prepare("UPDATE tasks SET status = 'ready', hold_reason = ?, updated_at = ? WHERE id = ?").run((zhCN("blocked.prefix.quota") + "cursor" + zhCN("nativeSessions.sweep.reasonSep") + "Ahead of budget"), hoursAgo(48), quotaWait.id);
    const quotaBlocked = open("Legacy quota block");
    getDb().prepare("UPDATE tasks SET status = 'blocked', blocked_kind = 'quota', blocked_reason = ?, blocked_at = ? WHERE id = ?").run((zhCN("blocked.prefix.quota") + "cursor" + zhCN("nativeSessions.sweep.reasonSep") + "Pool paused"), hoursAgo(48), quotaBlocked.id);
    const quiet = await check({});
    assert.equal(has(quiet, `card:ready:${quotaWait.id}`), undefined);
    const old = has(quiet, `card:blocked:${quotaBlocked.id}`);
    assert.equal(old?.severity, "yellow");
    assert.notEqual(old?.severity, "red");
    assert.equal(quiet.findings.some((item) => item.taskId === quotaWait.id && item.severity === "red"), false);
  });

  it("flags a stale tick, a stopped plugin, a stale quota and matrix, and a missing cwd count", async () => {
    const hit = await check({
      board: board({
        tickAt: hoursAgo(1),
        plugin: "stopped",
        quota: "stale",
        quotaAgeMs: 7 * 3_600_000,
        matrix: "stale",
        matrixAgeMs: 48 * 3_600_000,
        missingCwdCount: 2,
      }),
    });
    assert.equal(has(hit, "board:tick")?.severity, "red");
    assert.equal(has(hit, "board:plugin")?.severity, "red");
    assert.equal(has(hit, "board:quota")?.severity, "yellow", "stale quota data is never red: the board dispatches in the base order");
    assert.equal(has(hit, "board:matrix")?.severity, "yellow");
    assert.match(has(hit, "board:cwd")?.symptom ?? "", /2/);
    const quiet = await check({ board: board() });
    assert.equal(quiet.findings.filter((item) => item.check === "board").length, 0);
  });

  it("does not treat an unknown plugin or a failed gh as healthy, and does not write the database", async () => {
    const before = fingerprint();
    const report = await check({ board: board({ plugin: "unknown" }) });
    assert.equal(has(report, "board:plugin")?.severity, "yellow");
    assert.match(has(report, "board:plugin")?.evidence ?? "", new RegExp(localePattern(zhCNPart("doctor.plugin.unknownEvidence", 5, 16))));
    assert.equal(fingerprint(), before);
  });

  it("wakes the Kanban leader once per new red, and again only after it goes away and comes back", async () => {
    saveConfig({ ...loadConfig(), supervisorAgentId: "boss-doctor" });
    setAgentAliveCheck(() => true);
    const messages: string[] = [];
    setWakeSender((_id, text) => {
      messages.push(text);
    });
    const sources: DoctorSources = { workspaces: [ws("w-old", join(ROOT, "old"))] };
    const first = await check(sources, { wake: true, persist: true });
    assert.equal(first.alertedIds.length, 1);
    assert.equal(messages.length, 1);
    assert.match(messages[0], new RegExp(localePattern(zhCNPart("doctor.wake.title", 5, 15))));
    assert.match(messages[0], new RegExp(localePattern(zhCNPart("board.attention.memo", 0, 9))));
    assert.match(messages[0], new RegExp(localePattern(zhCNPart("doctor.wake.ask", 0, 17))));
    assert.match(messages[0], new RegExp(localePattern(zhCNPart("boardView.note.reversible", 16, 26))));
    assert.match(messages[0], new RegExp(zhCN("boardView.cmd.okToMerge")));
    assert.match(messages[0], /--role batch/);
    assert.match(messages[0], new RegExp(localePattern(zhCN("doctor.ws.orphan.noCard"))));
    const second = await check(sources, { wake: true, persist: true });
    assert.equal(messages.length, 1);
    assert.deepEqual(second.alertedIds, first.alertedIds);
    await check({ workspaces: [] }, { wake: true, persist: true });
    assert.equal(messages.length, 1);
    await check(sources, { wake: true, persist: true });
    assert.equal(messages.length, 2);
  });

  it("prints a summary and serves --last without scanning again", async () => {
    const sources: DoctorSources = { board: board({ tickAt: new Date().toISOString() }) };
    const text = await runKanban(["doctor"], {}, { doctorSources: sources });
    assert.match(String(text), new RegExp(zhCN("doctor.format.none")));
    const last = await runKanban(["doctor", "--last", "--json"], {}, {});
    assert.equal((last as DoctorReport).counts.red, 0);
    const shown = await handleTool("kanban_doctor", { last: true }, null, { role: "supervisor", taskId: null, agentId: null });
    assert.equal((shown as DoctorReport).counts.yellow, 0);
    assert.match(formatDoctor(shown as DoctorReport), new RegExp(zhCN("boardViews.doctor.title")));
    const line = String(await runKanban(["audit"], {}, { auditView: { async listActiveAgents() { return []; }, async inspectWorkspace() { return null; } } }));
    assert.match(line, new RegExp(localePattern(zhCNPart("doctor.auditLine", 0, 7)) + "0" + localePattern(zhCNPart("doctor.auditLine", 12, 20)) + "0"));
  });

  it("reads an old database without migrating it or writing project codes", async () => {
    const cold = mkdtempSync(join(tmp, "doctor-cold-"));
    const dbPath = join(cold, "kanban.db");
    const configPath = join(cold, "kanban.config.json");
    const raw = new DatabaseSync(dbPath);
    raw.exec(`CREATE TABLE tasks (
      id INTEGER PRIMARY KEY,
      project TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
    raw.prepare("INSERT INTO tasks (project, title, status, created_at, updated_at) VALUES (?, ?, 'ready', ?, ?)").run(
      "ColdProj",
      "Legacy database",
      NOW.toISOString(),
      NOW.toISOString(),
    );
    raw.close();
    writeFileSync(configPath, "{}\n");
    const before = readFileSync(configPath, "utf8");
    const prev = process.env.KANBAN_DATA_DIR;
    process.env.KANBAN_DATA_DIR = cold;
    closeDb();
    try {
      clearDoctorSafetyCache();
      const report = await runDoctor({ now: NOW, settings, sources: { board: board() }, persist: false });
      const finding = has(report, "check:board:database");
      assert.equal(finding?.severity, "info");
      assert.equal(finding?.object, zhCN("doctor.object.database"));
      // The id is a fixed token; only the label follows the language.
      setLanguage("en");
      try {
        clearDoctorSafetyCache();
        const english = await runDoctor({ now: NOW, settings, sources: { board: board() }, persist: false });
        assert.equal(has(english, "check:board:database")?.object, "database");
      } finally {
        setLanguage("zh-CN");
      }
      const seen = new DatabaseSync(dbPath, { readOnly: true });
      const columns = seen.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
      seen.close();
      assert.equal(columns.some((column) => column.name === "code_seq"), false);
      assert.equal(readFileSync(configPath, "utf8"), before);
    } finally {
      closeDb();
      process.env.KANBAN_DATA_DIR = prev;
      rmSync(cold, { recursive: true, force: true });
    }
  });

  it("does not call a branch safe to delete when the local tip is ahead or an old PR head differs", async () => {
    assert.equal(remoteTipFromLs("aaaaaaaa\trefs/heads/docs/topic\n", "docs/topic"), "aaaaaaaa");
    const foreign = join(ROOT, "foreign");
    const ahead = await check({
      dirs: dirs([foreign], [foreign]),
      git: git({
        async worktrees() {
          return [{ path: foreign, branch: "docs/topic" }];
        },
        async pushed() {
          return false;
        },
        async pr() {
          return "open";
        },
        async tip() {
          return "newsha";
        },
      }),
    });
    assert.equal((has(ahead, "git:worktree:")?.suggestion ?? "").includes(zhCN("doctor.safety.safe")), false);
    assert.match(has(ahead, "git:worktree:")?.suggestion ?? "", new RegExp(zhCN("doctor.safety.unsafe")));
    const stale = await check({
      dirs: dirs([foreign], [foreign]),
      git: git({
        async worktrees() {
          return [{ path: foreign, branch: "docs/topic" }];
        },
        async pushed() {
          return false;
        },
        async tip() {
          return "bbbbbbbb";
        },
        async pr() {
          return { state: "merged", headOid: "aaaaaaaa" };
        },
      }),
    });
    assert.match(has(stale, "git:worktree:")?.suggestion ?? "", new RegExp(localePattern(zhCNPart("doctor.safety.mergedOther", 7, 13))));
    assert.equal((has(stale, "git:worktree:")?.suggestion ?? "").includes(zhCN("doctor.safety.safe")), false);
  });

  it("does not call a worktree empty of agents when the list failed or an API agent is on it", async () => {
    const foreign = join(ROOT, "foreign");
    const failed = await check({
      dirs: dirs([foreign], [foreign]),
      agents: { agents: [], paseoIds: ["live-api-only"], error: "failed listing" },
      git: git({
        async worktrees() {
          return [{ path: foreign, branch: "docs/topic" }];
        },
      }),
    });
    assert.match(has(failed, "git:worktree:")?.suggestion ?? "", new RegExp(zhCN("doctor.safety.agent", {"value":"unknown"})));
    assert.equal((has(failed, "git:worktree:")?.suggestion ?? "").includes(zhCN("doctor.safety.safe")), false);
    const apiOnly = await check({
      workspaces: [ws("w-live", foreign)],
      dirs: dirs([foreign], [foreign]),
      agents: {
        agents: [{ id: "live-api-only", archived: false, cwd: null, workspaceId: "w-live" }],
        paseoIds: ["live-api-only"],
      },
      git: git({
        async worktrees() {
          return [{ path: foreign, branch: "docs/topic" }];
        },
      }),
    });
    assert.match(has(apiOnly, "git:worktree:")?.suggestion ?? "", /live-api-only/);
    assert.equal((has(apiOnly, "git:worktree:")?.suggestion ?? "").includes(zhCN("doctor.safety.safe")), false);
  });

  it("retries a red wake after the send fails", async () => {
    saveConfig({ ...loadConfig(), supervisorAgentId: "boss-doctor" });
    setAgentAliveCheck(() => true);
    let failSend = true;
    const messages: string[] = [];
    setWakeSender(() => {
      if (failSend) return Promise.reject(new Error((zhCNPart("stall.call.send", 0, 2) + zhCN("compat.run.failed"))));
      messages.push("sent");
      return Promise.resolve();
    });
    const sources: DoctorSources = { workspaces: [ws("w-old", join(ROOT, "old"))] };
    const first = await check(sources, { wake: true, persist: true });
    assert.equal(messages.length, 0);
    assert.equal(first.alertedIds.length, 0);
    failSend = false;
    const second = await check(sources, { wake: true, persist: true });
    assert.equal(messages.length, 1);
    assert.equal(second.alertedIds.length, 1);
  });

  it("keeps an alert when a later check fails, times out, or is only a manual scan", async () => {
    saveConfig({ ...loadConfig(), supervisorAgentId: "boss-doctor" });
    setAgentAliveCheck(() => true);
    const messages: string[] = [];
    setWakeSender((_id, text) => {
      messages.push(text);
    });
    const sources: DoctorSources = { workspaces: [ws("w-old", join(ROOT, "old"))] };
    const first = await check(sources, { wake: true, persist: true });
    assert.equal(first.alertedIds.length, 1);
    const blinded = await check({ workspaces: [], workspaceError: "workspace API failed" }, { wake: true, persist: true });
    assert.equal(messages.length, 1);
    assert.ok(blinded.alertedIds.includes(first.alertedIds[0]));
    const manual = await check({ workspaces: [], workspaceError: "workspace API failed" }, { wake: false, persist: true });
    assert.equal(messages.length, 1);
    assert.ok(manual.alertedIds.includes(first.alertedIds[0]));
    const again = await check(sources, { wake: true, persist: true });
    assert.equal(messages.length, 1);
    assert.deepEqual(again.alertedIds, first.alertedIds);
    const foreign = join(ROOT, "later");
    const gitRed = await check(
      {
        git: git({
          async worktrees() {
            return [{ path: foreign, branch: "docs/later" }];
          },
        }),
        dirs: dirs([foreign], [foreign]),
      },
      { wake: true, persist: true },
    );
    const gitId = has(gitRed, "git:worktree:")?.id;
    assert.ok(gitId);
    // A fake clock passes the total deadline only once the hung git call starts, so the run times out
    // the same way however loaded the machine is. The short command timeout just lets the hung call return.
    let fakeNow = 0;
    const slow = await check(
      {
        git: git({
          repos: [join(dir, "slow")],
          async worktrees() {
            fakeNow += settings.totalTimeoutMs;
            return new Promise(() => undefined);
          },
        }),
        dirs: dirs([], []),
      },
      { settings: { ...settings, commandTimeoutMs: 10 }, clock: () => fakeNow, wake: true, persist: true },
    );
    assert.equal(slow.timedOut, true);
    assert.ok(slow.alertedIds.includes(gitId));
    const repeated = await check(
      {
        git: git({
          async worktrees() {
            return [{ path: foreign, branch: "docs/later" }];
          },
        }),
        dirs: dirs([foreign], [foreign]),
      },
      { wake: true, persist: true },
    );
    assert.equal(messages.filter((text) => text.includes("git worktree")).length, 1);
    assert.ok(repeated.alertedIds.includes(gitId));
  });

  it("stops a stuck workspace list and a stuck scheduled collect at the deadline", async () => {
    const paseo = {
      workspaces: { list: () => new Promise(() => undefined) },
      agents: { list: () => new Promise(() => undefined) },
    } as unknown as PaseoApi;
    const started = Date.now();
    const sources = await collectLiveSources(paseo, started, started + 30);
    assert.ok(Date.now() - started < HANG_GUARD_MS, `collectLiveSources took ${Date.now() - started}ms`);
    assert.match(sources.workspaceError ?? "", new RegExp(zhCN("audit.timeout")));
    let finishCollect: (sources: DoctorSources) => void = () => undefined;
    const hung = maybeRunScheduledDoctor(new Date("2099-01-01T00:00:00.000Z"), {
      settings: { ...settings, totalTimeoutMs: 30, intervalMs: 0 },
      collect: () => new Promise<DoctorSources>((resolve) => { finishCollect = resolve; }),
    });
    const outcome = await Promise.race([
      hung.then(() => "done"),
      new Promise((resolve) => setTimeout(() => resolve("pending"), HANG_GUARD_MS)),
    ]);
    assert.equal(outcome, "done");
    // The wait ended at the deadline but the collection is still running: a second run must not stack behind it.
    let startedSecond = false;
    const second = {
      settings: { ...settings, totalTimeoutMs: 1_000, intervalMs: 0 },
      collect: async () => {
        startedSecond = true;
        return { workspaces: [], board: board() };
      },
    };
    await maybeRunScheduledDoctor(new Date("2099-01-01T00:00:00.000Z"), second);
    assert.equal(startedSecond, false);
    finishCollect({ workspaces: [], board: board() });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await maybeRunScheduledDoctor(new Date("2099-01-01T00:00:00.000Z"), second);
    assert.equal(startedSecond, true);
  });

  it("checks a configured project repo that no card has used, and reports a missing one", async () => {
    const root = join(dir, "configured-repo");
    mkdirSync(root);
    const prevRoot = process.env.KANBAN_AGENTIC_ROOT;
    const prevConfig = loadConfig();
    process.env.KANBAN_AGENTIC_ROOT = dir;
    saveConfig({
      ...prevConfig,
      projects: {
        ...(prevConfig.projects ?? {}),
        "configured-repo": { defaultWorkspace: "dir", baseBranch: "main", worktreeLanes: 1, lanesEnabled: false, workspacePath: root },
        "missing-repo": { defaultWorkspace: "dir", baseBranch: "main", worktreeLanes: 1, lanesEnabled: false },
      },
    });
    try {
      createTask({ project: "missing-repo", title: "Sample text", role: "executor", workspacePath: join(dir, "missing-repo") });
      const found = collectRepoRoots([]);
      assert.ok(found.repos.some((path) => path.endsWith("configured-repo")));
      assert.ok(found.missing.some((item) => item.project === "missing-repo"));
      const elsewhere = join(dir, "elsewhere");
      mkdirSync(elsewhere);
      const fromPaseo = collectRepoRoots([
        { id: "w-main", name: "configured-repo", directory: elsewhere, projectRoot: elsewhere, kind: "dir", archived: false },
      ]);
      assert.ok(fromPaseo.repos.some((path) => path.endsWith("elsewhere")));
      const report = await check({ missingRepos: [{ project: "missing-repo", path: join(dir, "missing-repo") }] });
      assert.match(has(report, "check:worktree:missing-repo")?.evidence ?? "", new RegExp(localePattern(zhCNPart("doctor.repo.missing", 3, 10))));
    } finally {
      saveConfig(prevConfig);
      if (prevRoot == null) delete process.env.KANBAN_AGENTIC_ROOT;
      else process.env.KANBAN_AGENTIC_ROOT = prevRoot;
    }
  });

  it("treats a configured project with no known directory as unknown, never under the plugin install directory (issue #9)", () => {
    const prevRoot = process.env.KANBAN_AGENTIC_ROOT;
    const prevConfig = loadConfig();
    const parent = join(dir, "issue9-parent");
    const known = join(parent, "no-directory-project");
    mkdirSync(known, { recursive: true });
    process.env.KANBAN_AGENTIC_ROOT = parent;
    const row = { defaultWorkspace: "dir", baseBranch: "main", worktreeLanes: 1, lanesEnabled: false } as const;
    saveConfig({
      ...prevConfig,
      projects: {
        ...(prevConfig.projects ?? {}),
        "no-directory-project": row,
        "relative-path-project": { ...row, workspacePath: "relative/checkout" },
        "absolute-path-project": { ...row, workspacePath: join(dir, "issue9-absolute") },
      },
    });
    mkdirSync(join(dir, "issue9-absolute"), { recursive: true });
    const warnings: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { warnings.push(args.join(" ")); };
    try {
      const first = collectRepoRoots([]);
      const second = collectRepoRoots([]);
      for (const found of [first, second]) {
        assert.equal(found.missing.some((item) => item.project === "no-directory-project" || item.project === "relative-path-project"), false);
        assert.equal(found.skipped.some((item) => item.project === "no-directory-project" || item.project === "relative-path-project"), false);
        assert.equal(found.repos.includes(known), false);
        assert.ok(found.repos.some((path) => path.endsWith("issue9-absolute")));
      }
      const relative = warnings.filter((line) => line.includes("relative-path-project") && line.includes("relative/checkout"));
      assert.equal(relative.length, 1, "a relative workspacePath is reported exactly once");
      assert.equal(warnings.some((line) => line.includes("no-directory-project")), false);
    } finally {
      console.error = original;
      saveConfig(prevConfig);
      if (prevRoot == null) delete process.env.KANBAN_AGENTIC_ROOT;
      else process.env.KANBAN_AGENTIC_ROOT = prevRoot;
    }
  });

  it("scans directories past absent empty projects, but fails closed for open cards and EACCES", async () => {
    const prevConfig = loadConfig();
    const envKeys = ["KANBAN_AGENTIC_ROOT", "KANBAN_AGENTS_DIR", "KANBAN_WORKTREES_ROOT"] as const;
    const previous = envKeys.map((key) => process.env[key]);
    const agentic = join(dir, "empty-project-roots");
    const repo = join(agentic, "normal");
    const wt = join(dir, "wt-empty-projects");
    const stray = join(wt, "project", "visible-stray");
    const emptyProject = join(wt, "empty-project");
    mkdirSync(emptyProject, { recursive: true });
    mkdirSync(join(stray, "nested-content"), { recursive: true });
    mkdirSync(repo, { recursive: true });
    mkdirSync(stray, { recursive: true });
    const git = (args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
    git(["init", "-b", "main"]);
    git(["-c", "user.name=doctor", "-c", "user.email=doctor@example.com", "commit", "--allow-empty", "-m", "init"]);
    const project = { defaultWorkspace: "dir", baseBranch: "main", worktreeLanes: 1, lanesEnabled: false } as const;
    saveConfig({ ...prevConfig, projects: { normal: { ...project, workspacePath: repo }, "demo_quota": project, demo_sandbox: project } });
    process.env.KANBAN_AGENTIC_ROOT = agentic;
    process.env.KANBAN_AGENTS_DIR = join(dir, "agents-empty-projects");
    process.env.KANBAN_WORKTREES_ROOT = wt;
    mkdirSync(process.env.KANBAN_AGENTS_DIR);
    const emptyPage = { entries: [], pageInfo: { nextCursor: null } };
    const paseo = {
      workspaces: { list: async () => emptyPage },
      agents: { list: async () => emptyPage },
    } as unknown as PaseoApi;
    const diagnose = async () => {
      const sources = await collectLiveSources(paseo, Date.now(), Date.now() + 20_000);
      return { sources, report: await check({ ...sources, board: board() }) };
    };
    try {
      // Finished history does not keep an absent project in the required repos.
      const closed = createTask({ project: "demo_quota", title: "Done", role: "executor", workspacePath: join(agentic, "demo_quota") });
      getDb().prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(closed.id);
      const archived = createTask({ project: "demo_sandbox", title: "archived", role: "executor", workspacePath: join(agentic, "demo_sandbox") });
      getDb().prepare("UPDATE tasks SET status = 'archived' WHERE id = ?").run(archived.id);
      const empty = await diagnose();
      assert.deepEqual(empty.sources.missingRepos, []);
      assert.deepEqual(empty.sources.git?.repos, [repo]);
      assert.equal(empty.sources.dirs?.scanned, true);
      assert.ok(empty.sources.dirs?.list().includes(stray));
      assert.equal(empty.sources.dirs?.list().includes(emptyProject), false);
      assert.equal(empty.sources.dirs?.list().includes(join(wt, "project")), false);
      assert.equal(empty.sources.dirs?.list().includes(join(stray, "nested-content")), false);
      assert.deepEqual(empty.report.findings.filter((item) => item.id.startsWith("dir:stray:")).map((item) => item.object), [stray]);
      assert.equal(has(empty.report, "check:directory:"), undefined);
      for (const name of ["demo_quota", "demo_sandbox"]) {
        assert.ok(empty.report.findings.some((item) => item.severity === "info" && item.project === name && item.symptom === `${(zhCN("board.intake.projectPlaceholder") + " ")}${name} ${zhCNPart("doctor.repo.skipped.symptom", 13, 23)}`));
      }
      const card = createTask({ project: "demo_quota", title: "Sample text", role: "executor", workspacePath: join(agentic, "demo_quota") });
      const active = await diagnose();
      assert.ok(active.sources.missingRepos?.some((item) => item.project === "demo_quota"));
      assert.equal(active.sources.dirs?.scanned, false);
      assert.ok(has(active.report, "check:worktree:demo_quota"));
      assert.ok(has(active.report, "check:directory:"));
      getDb().prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(card.id);
      chmodSync(agentic, 0);
      const denied = await diagnose();
      assert.equal(denied.sources.missingRepos?.length, 3);
      assert.equal(denied.sources.dirs?.scanned, false);
      assert.ok(has(denied.report, "check:directory:"));
      assert.equal(denied.report.findings.some((item) => item.symptom.includes(zhCNPart("doctor.repo.skipped.symptom", 20, 23))), false);
    } finally {
      chmodSync(agentic, 0o755);
      saveConfig(prevConfig);
      envKeys.forEach((key, index) => {
        if (previous[index] == null) delete process.env[key];
        else process.env[key] = previous[index];
      });
    }
  });

  it("does not report an old not_merged failure after local cleanup kept the remote PR branch", async () => {
    const task = open("PR remote retained");
    getDb().prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(task.id);
    event(task.id, "cleanup", { action: "skip_worktree", ok: false, reason: "not_merged", directory: REPO }, hoursAgo(5));
    event(task.id, "temp_workspace_cleaned", { reason: "Pushed; PR not merged; kept on the remote", keptBranch: false }, hoursAgo(3));
    const report = await check({});
    assert.equal(has(report, `card:cleanup:${task.id}`), undefined);
  });

  it("clears a cleanup failure after a later success, and keeps one buried under other objects", async () => {
    const solved = open("Later success");
    getDb().prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(solved.id);
    event(solved.id, "cleanup", { action: "archive_agent", ok: false, reason: "not_merged", agentId: "agent-a" }, hoursAgo(5));
    event(solved.id, "cleanup", { action: "archive_agent", ok: true, agentId: "agent-a" }, hoursAgo(4));
    const quiet = await check({});
    assert.equal(has(quiet, `card:cleanup:${solved.id}`), undefined);
    resetDb();
    const buried = open("Old failure remains");
    getDb().prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(buried.id);
    event(buried.id, "cleanup", { action: "skip_worktree", ok: false, reason: "not_merged", directory: REPO }, hoursAgo(5));
    for (let i = 0; i < 40; i += 1) {
      event(buried.id, "cleanup", { action: "archive_agent", ok: true, agentId: `other-${i}` }, hoursAgo(1));
    }
    const hit = await check({});
    assert.match(has(hit, `card:cleanup:${buried.id}`)?.symptom ?? "", /not_merged/);
  });

  it("names the latest failed step, not an older wait_turn that was already resolved", async () => {
    const task = open(zhCN("doctor.cleanup.deleteBranch"));
    getDb().prepare("UPDATE tasks SET status = 'archived' WHERE id = ?").run(task.id);
    event(task.id, "cleanup", { action: "wait_turn", agentId: "agent-a", ok: false, reason: "Waiting for this turn to end" }, hoursAgo(6));
    event(task.id, "cleanup", { action: "archive_agent", agentId: "agent-a", ok: true }, hoursAgo(6));
    event(task.id, "cleanup", { action: "delete_branch", directory: REPO, ok: false, outcome: "error", error: ("git " + zhCNPart("settings.families.noFast", 0, 2)), retryAt: hoursAgo(3) }, hoursAgo(4));
    const hit = await check({});
    const found = hit.findings.filter((f: { id: string }) => f.id.startsWith(`card:cleanup:${task.id}`));
    assert.equal(found.length, 1);
    assert.match(found[0].symptom, new RegExp(zhCN("doctor.cleanup.deleteBranch") + zhCN("common.colon") + "git " + localePattern(zhCNPart("settings.families.noFast", 0, 2))));
    assert.doesNotMatch(found[0].symptom, new RegExp(zhCN("archiveBook.reason.waitTurn")));
  });

  it("keeps readable agent records and does not call a checkout safe when one file cannot be read", async () => {
    const root = join(dir, "agents-broken");
    const okDir = join(root, "ok");
    const locked = join(root, "locked");
    mkdirSync(okDir, { recursive: true });
    mkdirSync(locked, { recursive: true });
    writeFileSync(join(okDir, "good.json"), JSON.stringify({ id: "good-agent", cwd: "/tmp/good-agent", archivedAt: null, lastStatus: "idle" }));
    writeFileSync(join(okDir, "bad.json"), "{");
    const hidden = join(okDir, "unreadable.json");
    writeFileSync(hidden, JSON.stringify({ id: "hidden-agent", cwd: "/tmp/hidden" }));
    writeFileSync(join(locked, "secret.json"), JSON.stringify({ id: "secret-agent" }));
    chmodSync(hidden, 0);
    chmodSync(locked, 0);
    const prevAgents = process.env.KANBAN_AGENTS_DIR;
    const prevWt = process.env.KANBAN_WORKTREES_ROOT;
    const wt = join(dir, "wt-agents");
    mkdirSync(wt);
    process.env.KANBAN_AGENTS_DIR = root;
    process.env.KANBAN_WORKTREES_ROOT = wt;
    const emptyPage = { entries: [], pageInfo: { nextCursor: null } };
    const paseo = {
      workspaces: { list: async () => emptyPage },
      agents: { list: async () => emptyPage },
    } as unknown as PaseoApi;
    try {
      const sources = await collectLiveSources(paseo, Date.now(), Date.now() + 20_000);
      assert.ok(sources.agents?.agents.some((agent) => agent.id === "good-agent"));
      assert.equal(sources.agents?.agents.some((agent) => agent.id === "hidden-agent"), false);
      const error = sources.agents?.error ?? "";
      assert.match(error, /unreadable\.json/);
      assert.match(error, /bad\.json/);
      assert.match(error, /locked/);
      const foreign = join(ROOT, "foreign-unread");
      const report = await check({
        agents: sources.agents,
        workspaces: [],
        dirs: dirs([foreign], [foreign]),
        git: git({
          async worktrees() {
            return [{ path: foreign, branch: "docs/topic" }];
          },
        }),
        board: board(),
      });
      const suggestion = has(report, "git:worktree:")?.suggestion ?? "";
      assert.match(suggestion, new RegExp(zhCN("doctor.safety.agent", {"value":"unknown"})));
      assert.equal(suggestion.includes(zhCN("doctor.safety.safe")), false);
    } finally {
      chmodSync(locked, 0o755);
      chmodSync(hidden, 0o644);
      if (prevAgents == null) delete process.env.KANBAN_AGENTS_DIR;
      else process.env.KANBAN_AGENTS_DIR = prevAgents;
      if (prevWt == null) delete process.env.KANBAN_WORKTREES_ROOT;
      else process.env.KANBAN_WORKTREES_ROOT = prevWt;
    }
  });

  it("returns when a wake sender never finishes, then wakes on the next run", async () => {
    saveConfig({ ...loadConfig(), supervisorAgentId: "boss-doctor" });
    setAgentAliveCheck(() => true);
    const clock = new Date();
    const sources: DoctorSources = { workspaces: [ws("w-old", join(ROOT, "old"))], board: board({ tickAt: clock.toISOString() }) };
    setWakeSender(() => new Promise(() => undefined));
    const started = Date.now();
    await maybeRunScheduledDoctor(clock, {
      settings: { ...settings, totalTimeoutMs: 80, intervalMs: 0 },
      collect: async () => sources,
    });
    assert.ok(Date.now() - started < HANG_GUARD_MS, `scheduled doctor returned after ${Date.now() - started}ms (budget 80ms)`);
    assert.equal(readLastDoctorReport()?.alertedIds.length ?? -1, 0);
    let resumed = false;
    setWakeSender(() => {
      resumed = true;
    });
    await maybeRunScheduledDoctor(new Date(Date.now() + 60_000), {
      settings: { ...settings, totalTimeoutMs: 2_000, intervalMs: 0 },
      collect: async () => sources,
    });
    assert.equal(resumed, true);
    assert.equal(readLastDoctorReport()?.alertedIds.length, 1);
    resetDb();
    const manual: DoctorSources = { workspaces: [ws("w-old", join(ROOT, "old"))], board: board() };
    setWakeSender(() => new Promise(() => undefined));
    const pending = check(manual, { wake: true, persist: true, settings: { ...settings, totalTimeoutMs: 10 } });
    const outcome = await Promise.race([
      pending.then(() => "done"),
      new Promise((resolve) => setTimeout(() => resolve("pending"), HANG_GUARD_MS)),
    ]);
    assert.equal(outcome, "done");
    const first = await pending;
    assert.equal(first.alertedIds.length, 0);
    assert.ok(readLastDoctorReport());
    let sent = 0;
    setWakeSender(() => {
      sent += 1;
    });
    const second = await check(manual, { wake: true, persist: true });
    assert.equal(sent, 1);
    assert.equal(second.alertedIds.length, 1);
  });

  it("keeps a plugin alert through unknown, and a directory alert when git listing fails", async () => {
    saveConfig({ ...loadConfig(), supervisorAgentId: "boss-doctor" });
    setAgentAliveCheck(() => true);
    const messages: string[] = [];
    setWakeSender((_id, text) => {
      messages.push(text);
    });
    const stopped = { board: board({ plugin: "stopped" }) };
    const first = await check(stopped, { wake: true, persist: true });
    assert.ok(first.alertedIds.includes("board:plugin"));
    const unknown = await check({ board: board({ plugin: "unknown" }) }, { wake: true, persist: true });
    assert.equal(has(unknown, "board:plugin")?.severity, "yellow");
    assert.ok(unknown.alertedIds.includes("board:plugin"));
    assert.equal(messages.length, 1);
    const again = await check(stopped, { wake: true, persist: true });
    assert.equal(messages.length, 1);
    assert.ok(again.alertedIds.includes("board:plugin"));

    const stray = join(dir, "stray-bucket");
    mkdirSync(stray, { recursive: true });
    const straySources: DoctorSources = { dirs: dirs([stray], []), board: board(), workspaces: [] };
    const seen = await check(straySources, { wake: true, persist: true });
    const strayId = has(seen, "dir:stray:")?.id;
    assert.ok(strayId);
    assert.equal(messages.length, 2);
    const outside = mkdtempSync(join(tmpdir(), "kanban-doctor-"));
    const bare = join(outside, "not-a-repo");
    mkdirSync(bare);
    const card = open("Broken repository");
    getDb().prepare("UPDATE tasks SET workspace_kind = 'dir', workspace_path = ? WHERE id = ?").run(bare, card.id);
    const prevConfig = loadConfig();
    saveConfig({ ...prevConfig, projects: {} });
    const prevAgents = process.env.KANBAN_AGENTS_DIR;
    const prevWt = process.env.KANBAN_WORKTREES_ROOT;
    const agentsRoot = join(dir, "agents-empty");
    const wtRoot = join(dir, "wt-empty");
    mkdirSync(agentsRoot);
    mkdirSync(wtRoot);
    process.env.KANBAN_AGENTS_DIR = agentsRoot;
    process.env.KANBAN_WORKTREES_ROOT = wtRoot;
    const emptyPage = { entries: [], pageInfo: { nextCursor: null } };
    const paseo = {
      workspaces: { list: async () => emptyPage },
      agents: { list: async () => emptyPage },
    } as unknown as PaseoApi;
    try {
      const collected = await collectLiveSources(paseo, Date.now(), Date.now() + 20_000);
      assert.equal(collected.dirs?.scanned, false);
      assert.deepEqual(collected.dirs?.list() ?? [], []);
      const mid = await check(
        { dirs: collected.dirs, git: collected.git, workspaces: [], agents: collected.agents, board: board() },
        { wake: true, persist: true },
      );
      assert.ok(mid.alertedIds.includes(strayId));
      assert.equal(messages.length, 2);
    } finally {
      saveConfig(prevConfig);
      rmSync(outside, { recursive: true, force: true });
      if (prevAgents == null) delete process.env.KANBAN_AGENTS_DIR;
      else process.env.KANBAN_AGENTS_DIR = prevAgents;
      if (prevWt == null) delete process.env.KANBAN_WORKTREES_ROOT;
      else process.env.KANBAN_WORKTREES_ROOT = prevWt;
    }
    const back = await check(straySources, { wake: true, persist: true });
    assert.equal(messages.length, 2);
    assert.ok(back.alertedIds.includes(strayId));
  });

  it("keeps directory alerts when the root, a subdirectory, or a placeholder cannot be read", async () => {
    saveConfig({ ...loadConfig(), supervisorAgentId: "boss-doctor", projects: {} });
    setAgentAliveCheck(() => true);
    let wakes = 0;
    setWakeSender(() => {
      wakes += 1;
    });
    const prevAgents = process.env.KANBAN_AGENTS_DIR;
    const prevWt = process.env.KANBAN_WORKTREES_ROOT;
    const wt = join(dir, "wt-scan");
    const agentsRoot = join(dir, "agents-scan");
    mkdirSync(wt);
    mkdirSync(agentsRoot);
    process.env.KANBAN_AGENTS_DIR = agentsRoot;
    process.env.KANBAN_WORKTREES_ROOT = wt;
    const emptyPage = { entries: [], pageInfo: { nextCursor: null } };
    const paseo = {
      workspaces: { list: async () => emptyPage },
      agents: { list: async () => emptyPage },
    } as unknown as PaseoApi;
    const diagnose = async () => {
      const collected = await collectLiveSources(paseo, Date.now(), Date.now() + 20_000);
      const report = await check(
        { dirs: collected.dirs, board: board(), workspaces: [], agents: collected.agents, git: git() },
        { wake: true, persist: true },
      );
      return { collected, report };
    };
    try {
      const stray = join(wt, "project", "stray-root");
      mkdirSync(stray, { recursive: true });
      const seen = await diagnose();
      const strayId = has(seen.report, "dir:stray:")?.id;
      assert.ok(strayId);
      assert.equal(wakes, 1);
      chmodSync(wt, 0);
      const blocked = await diagnose();
      assert.equal(blocked.collected.dirs?.scanned, false);
      assert.match(blocked.collected.dirs?.scanError ?? "", /EACCES|EPERM/);
      assert.ok(blocked.report.alertedIds.includes(strayId));
      assert.equal(blocked.report.counts.red, 0);
      assert.ok(blocked.report.counts.info >= 1);
      assert.equal(wakes, 1);
      chmodSync(wt, 0o755);
      rmSync(stray, { recursive: true, force: true });

      resetDb();
      const visible = join(wt, "project", "visible-stray");
      const locked = join(wt, "locked");
      const hidden = join(locked, "hidden-stray");
      mkdirSync(visible, { recursive: true });
      mkdirSync(hidden, { recursive: true });
      const both = await diagnose();
      const hiddenId = both.report.findings.find((item) => item.id.startsWith("dir:stray:") && item.object.endsWith("hidden-stray"))?.id;
      assert.ok(hiddenId);
      assert.ok(both.report.findings.some((item) => item.object.endsWith("visible-stray")));
      const afterBoth = wakes;
      chmodSync(locked, 0);
      const partial = await diagnose();
      assert.equal(partial.collected.dirs?.scanned, true);
      assert.ok(partial.collected.dirs?.unread?.some((path) => path.endsWith("locked")));
      assert.ok(partial.report.alertedIds.includes(hiddenId));
      assert.ok(partial.report.findings.some((item) => item.object.endsWith("visible-stray")));
      assert.equal(partial.report.findings.some((item) => item.id === hiddenId), false);
      assert.match(has(partial.report, "check:directory:")?.evidence ?? "", /locked/);
      assert.equal(wakes, afterBoth);
      chmodSync(locked, 0o755);
      rmSync(visible, { recursive: true, force: true });
      rmSync(locked, { recursive: true, force: true });

      resetDb();
      const place = join(wt, "project", "place");
      mkdirSync(place, { recursive: true });
      const readme = join(place, "README-placeholder.txt");
      writeFileSync(readme, ("agent" + zhCN("common.colon") + "gone-agent\n"));
      const marked = await diagnose();
      const placeId = has(marked.report, "dir:placeholder:")?.id;
      assert.ok(placeId);
      const afterPlace = wakes;
      chmodSync(readme, 0);
      const unread = await diagnose();
      assert.equal(has(unread.report, "dir:stray:"), undefined);
      assert.ok(unread.report.alertedIds.includes(placeId));
      assert.match(has(unread.report, "check:directory:")?.evidence ?? "", /place/);
      assert.equal(wakes, afterPlace);
      chmodSync(readme, 0o644);
    } finally {
      try {
        chmodSync(wt, 0o755);
      } catch {
        // already restored
      }
      if (prevAgents == null) delete process.env.KANBAN_AGENTS_DIR;
      else process.env.KANBAN_AGENTS_DIR = prevAgents;
      if (prevWt == null) delete process.env.KANBAN_WORKTREES_ROOT;
      else process.env.KANBAN_WORKTREES_ROOT = prevWt;
    }
  });

  it("keeps a stale quota yellow and never wakes for it, also when the snapshot or the board read fails", async () => {
    saveConfig({ ...loadConfig(), supervisorAgentId: "boss-doctor", projects: {} });
    setAgentAliveCheck(() => true);
    let wakes = 0;
    setWakeSender(() => {
      wakes += 1;
    });
    const pool = policySnapshotPath();
    const prevConfig = process.env.KANBAN_PASEO_CONFIG;
    process.env.KANBAN_PASEO_CONFIG = join(dir, "doctor-policy-config.json");
    writeFileSync(process.env.KANBAN_PASEO_CONFIG, JSON.stringify({ daemon: { agentProfiles: [] } }));
    const writeStale = () => {
      publishAnonymousPolicy({ roles: {} }, { cursor: { dispatchable: true } }, Date.now() - 7 * 3_600_000);
    };
    writeStale();
    const prevPool = process.env.KANBAN_POOL_STATUS;
    const prevAgents = process.env.KANBAN_AGENTS_DIR;
    const prevWt = process.env.KANBAN_WORKTREES_ROOT;
    const prevFail = process.env.KANBAN_DOCTOR_BOARD_FAIL;
    process.env.KANBAN_POOL_STATUS = pool;
    process.env.KANBAN_AGENTS_DIR = join(dir, "agents-quota");
    process.env.KANBAN_WORKTREES_ROOT = join(dir, "wt-quota");
    mkdirSync(process.env.KANBAN_AGENTS_DIR);
    mkdirSync(process.env.KANBAN_WORKTREES_ROOT);
    const emptyPage = { entries: [], pageInfo: { nextCursor: null } };
    const paseo = {
      workspaces: { list: async () => emptyPage },
      agents: { list: async () => emptyPage },
    } as unknown as PaseoApi;
    const diagnose = async () => {
      const collected = await collectLiveSources(paseo, Date.now(), Date.now() + 20_000);
      const report = await check({ board: collected.board, workspaces: [], dirs: dirs([], []) }, { wake: true, persist: true });
      return { collected, report };
    };
    try {
      const first = await diagnose();
      assert.equal(first.collected.board?.quota, "stale");
      assert.ok((first.collected.board?.quotaAgeMs ?? 0) >= 6 * 3_600_000);
      assert.equal(has(first.report, "board:quota")?.severity, "yellow");
      assert.equal(first.report.alertedIds.includes("board:quota"), false, "a yellow finding never wakes the leader");
      chmodSync(pool, 0);
      const denied = await diagnose();
      assert.equal(denied.collected.board?.quota, "unknown");
      assert.equal(has(denied.report, "board:quota")?.severity, "yellow");
      chmodSync(pool, 0o644);
      writeFileSync(pool, "{");
      const bad = await diagnose();
      assert.equal(bad.collected.board?.quota, "unknown");
      assert.equal(has(bad.report, "board:quota")?.severity, "yellow");
      rmSync(pool);
      writeStale();
      const again = await diagnose();
      assert.equal(again.collected.board?.quota, "stale");
      assert.equal(has(again.report, "board:quota")?.severity, "yellow");
      process.env.KANBAN_DOCTOR_BOARD_FAIL = "1";
      const failed = await diagnose();
      assert.equal(failed.collected.board?.quota, "unknown");
      assert.equal(failed.collected.board?.matrix, "unknown");
      assert.equal(has(failed.report, "board:quota")?.severity, "yellow");
      assert.equal(failed.report.alertedIds.includes("board:quota"), false);
    } finally {
      try {
        chmodSync(pool, 0o644);
      } catch {
        // already restored
      }
      if (prevFail == null) delete process.env.KANBAN_DOCTOR_BOARD_FAIL;
      else process.env.KANBAN_DOCTOR_BOARD_FAIL = prevFail;
      if (prevConfig == null) delete process.env.KANBAN_PASEO_CONFIG;
      else process.env.KANBAN_PASEO_CONFIG = prevConfig;
      rmSync(pool, { force: true });
      if (prevPool == null) delete process.env.KANBAN_POOL_STATUS;
      else process.env.KANBAN_POOL_STATUS = prevPool;
      if (prevAgents == null) delete process.env.KANBAN_AGENTS_DIR;
      else process.env.KANBAN_AGENTS_DIR = prevAgents;
      if (prevWt == null) delete process.env.KANBAN_WORKTREES_ROOT;
      else process.env.KANBAN_WORKTREES_ROOT = prevWt;
    }
  });

  it("keeps a worktree alert when a configured repo cannot be opened, and does not call it a stray", async () => {
    const prevConfig = loadConfig();
    const prevRoot = process.env.KANBAN_AGENTIC_ROOT;
    const prevAgents = process.env.KANBAN_AGENTS_DIR;
    const prevWt = process.env.KANBAN_WORKTREES_ROOT;
    const agentic = join(dir, "agentic-roots");
    const repo = join(agentic, "listed-repo");
    const wt = join(dir, "wt-configured");
    const orphan = join(wt, "project", "orphan");
    mkdirSync(repo, { recursive: true });
    mkdirSync(wt);
    const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });
    git(repo, ["init", "-b", "main"]);
    git(repo, ["config", "user.email", "doctor@example.com"]);
    git(repo, ["config", "user.name", "doctor"]);
    writeFileSync(join(repo, "README"), "x\n");
    git(repo, ["add", "README"]);
    git(repo, ["commit", "-m", "init"]);
    git(repo, ["worktree", "add", "-b", "docs/topic", orphan]);
    saveConfig({
      ...prevConfig,
      supervisorAgentId: "boss-doctor",
      projects: {
        "listed-repo": { defaultWorkspace: "dir", baseBranch: "main", worktreeLanes: 1, lanesEnabled: false },
      },
    });
    createTask({ project: "listed-repo", title: "Sample text", role: "executor", workspacePath: repo });
    setAgentAliveCheck(() => true);
    let wakes = 0;
    setWakeSender(() => {
      wakes += 1;
    });
    process.env.KANBAN_AGENTIC_ROOT = agentic;
    process.env.KANBAN_AGENTS_DIR = join(dir, "agents-configured");
    process.env.KANBAN_WORKTREES_ROOT = wt;
    mkdirSync(process.env.KANBAN_AGENTS_DIR);
    const emptyPage = { entries: [], pageInfo: { nextCursor: null } };
    const paseo = {
      workspaces: { list: async () => emptyPage },
      agents: { list: async () => emptyPage },
    } as unknown as PaseoApi;
    const diagnose = async () => {
      const collected = await collectLiveSources(paseo, Date.now(), Date.now() + 20_000);
      const report = await check(
        { ...collected, board: board(), workspaces: collected.workspaces ?? [] },
        { wake: true, persist: true },
      );
      return { collected, report };
    };
    try {
      const first = await diagnose();
      const gitId = has(first.report, "git:worktree:")?.id;
      assert.ok(gitId);
      assert.equal(has(first.report, "dir:stray:"), undefined);
      assert.equal(wakes, 1);
      chmodSync(agentic, 0);
      const denied = await diagnose();
      assert.ok(denied.collected.missingRepos?.some((item) => item.project === "listed-repo"));
      assert.equal(denied.collected.dirs?.scanned, false);
      assert.equal(has(denied.report, "dir:stray:"), undefined);
      assert.ok(denied.report.alertedIds.includes(gitId));
      assert.equal(wakes, 1);
      chmodSync(agentic, 0o755);
      const back = await diagnose();
      assert.equal(has(back.report, "git:worktree:")?.id, gitId);
      assert.equal(wakes, 1);
      renameSync(repo, join(agentic, "listed-repo-away"));
      const missing = await diagnose();
      assert.ok(missing.collected.missingRepos?.some((item) => item.project === "listed-repo"));
      assert.equal(missing.collected.dirs?.scanned, false);
      assert.equal(has(missing.report, "dir:stray:"), undefined);
      assert.ok(missing.report.alertedIds.includes(gitId));
      assert.equal(wakes, 1);
      renameSync(join(agentic, "listed-repo-away"), repo);
      const restored = await diagnose();
      assert.equal(has(restored.report, "git:worktree:")?.id, gitId);
      assert.equal(wakes, 1);
    } finally {
      try {
        chmodSync(agentic, 0o755);
      } catch {
        // already restored
      }
      saveConfig(prevConfig);
      if (prevRoot == null) delete process.env.KANBAN_AGENTIC_ROOT;
      else process.env.KANBAN_AGENTIC_ROOT = prevRoot;
      if (prevAgents == null) delete process.env.KANBAN_AGENTS_DIR;
      else process.env.KANBAN_AGENTS_DIR = prevAgents;
      if (prevWt == null) delete process.env.KANBAN_WORKTREES_ROOT;
      else process.env.KANBAN_WORKTREES_ROOT = prevWt;
    }
  });
});
