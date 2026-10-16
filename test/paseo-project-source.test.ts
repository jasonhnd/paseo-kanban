/// <reference types="node" />
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { DEFAULT_CONCURRENCY, saveConfig, type KanbanConfig } from "../server/config";
import { closeDb, getDb } from "../server/db";
import { clearDoctorSafetyCache, runDoctor, type DoctorReport } from "../server/doctor";
import { runUpgradeCheck, type UpgradeDeps } from "../server/fleet/upgrade-check";
import { requestSupervisorShift } from "../server/fleet/supervisor-shift";
import type { PaseoApi } from "../server/fleet/paseo-api";
import { startTask } from "../server/dispatch";
import { listBoard } from "../server/board-cards";
import { isProjectDormant, isProjectPaused } from "../server/paused";
import {
  assertProjectInPaseo,
  isProjectRemoved,
  normalizeProjectPath,
  parsePaseoProjectList,
  paseoProjectPaths,
  paseoProjectsPath,
  projectDirectories,
  recordPaseoProjects,
  refreshPaseoProjects,
  refreshPaseoProjectsFromCli,
  removedProjects,
  resetPaseoProjects,
} from "../server/paseo-projects";
import { projectRows } from "../server/project-rows";
import { createTask } from "../server/store";
import { handleTool } from "../server/tools";
import { quietProjects, shownPaused } from "../shared/fleet/paused";

// Everything lives in a disposable data directory; the real Paseo daemon and board data are never read.
const dir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "paseo-project-source-")));
process.env.KANBAN_DATA_DIR = dir;

const NOW = new Date("2026-10-01T03:00:00.000Z");
const ALPHA = join(dir, "repos", "alpha");
const BETA = join(dir, "repos", "beta");
const GAMMA = join(dir, "repos", "gamma");
for (const path of [ALPHA, BETA, GAMMA]) mkdirSync(path, { recursive: true });
const LEADER = { role: "supervisor", taskId: null, agentId: null } as const;

function entry(name: string, path: string) {
  return { id: `prj_${name}`, name, path };
}

function config(over: Partial<KanbanConfig> = {}): KanbanConfig {
  const base = { defaultWorkspace: "dir" as const, baseBranch: "main", worktreeLanes: 1, lanesEnabled: false };
  return {
    autoStart: { wake: false, chain: false },
    supervisorAgentId: "kanban-boss",
    supervisors: { alpha: "alpha-leader", beta: "beta-leader", nodir: "nodir-leader" },
    concurrency: { global: DEFAULT_CONCURRENCY.global, pools: { ...DEFAULT_CONCURRENCY.pools }, roles: { ...DEFAULT_CONCURRENCY.roles } },
    projects: {
      alpha: { ...base, workspacePath: `dir:${ALPHA}/` },
      beta: { ...base, workspacePath: BETA },
      nodir: { ...base },
    },
    ...over,
  };
}

function open(project: string, title = "card") {
  return createTask({ project, title, role: "executor" });
}

beforeEach(() => {
  resetPaseoProjects({ clearFile: true });
  getDb().exec("DELETE FROM events; DELETE FROM tasks;");
  saveConfig(config());
});

after(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe("matching a board project to a Paseo project by directory", () => {
  it("normalises dir: prefixes, trailing slashes, relative paths and symlinks", () => {
    const link = join(dir, "repos", "alpha-link");
    symlinkSync(ALPHA, link);
    assert.equal(normalizeProjectPath(`dir:${ALPHA}/`), ALPHA);
    assert.equal(normalizeProjectPath(`  ${ALPHA}//  `), ALPHA);
    assert.equal(normalizeProjectPath(link), ALPHA);
    assert.equal(normalizeProjectPath("relative/path"), null);
    assert.equal(normalizeProjectPath("dir:"), null);
    assert.equal(normalizeProjectPath(42), null);
    const missing = join(dir, "repos", "not-created");
    assert.equal(normalizeProjectPath(`${missing}/`), missing);
  });

  it("matches by path even when the two sides name the project differently", () => {
    recordPaseoProjects([entry("A Totally Different Name", ALPHA), entry("Other", BETA)]);
    assert.equal(isProjectRemoved("alpha"), false);
    assert.equal(isProjectRemoved("beta"), false);
    assert.deepEqual([...paseoProjectPaths()!].sort(), [ALPHA, BETA].sort());
  });

  it("does not match by name when the directory is not in Paseo", () => {
    recordPaseoProjects([entry("alpha", GAMMA)]);
    assert.equal(isProjectRemoved("alpha"), true);
  });

  it("reads a project's directory from its cards when the config names none, and any known directory keeps it", () => {
    saveConfig(config({ projects: { alpha: { defaultWorkspace: "dir", baseBranch: "main", worktreeLanes: 1, lanesEnabled: false } } }));
    createTask({ project: "alpha", title: "from a card", role: "executor", workspacePath: `dir:${ALPHA}` });
    createTask({ project: "alpha", title: "from an older directory", role: "executor", workspacePath: GAMMA });
    assert.deepEqual(projectDirectories("alpha").sort(), [ALPHA, GAMMA].sort());
    recordPaseoProjects([entry("anything", ALPHA)]);
    assert.equal(isProjectRemoved("alpha"), false);
    recordPaseoProjects([entry("anything", BETA)]);
    assert.equal(isProjectRemoved("alpha"), true);
  });

  it("knows a lane project's repository root, and a worktree card's root from its events", async () => {
    const WOOD = join(dir, "repos", "wood");
    const ELM = join(dir, "repos", "elm");
    mkdirSync(WOOD, { recursive: true });
    mkdirSync(ELM, { recursive: true });
    const base = { defaultWorkspace: "dir" as const, baseBranch: "main", worktreeLanes: 1, lanesEnabled: true };
    saveConfig(config({ projects: { wood: { ...base }, elm: { ...base } }, supervisors: { wood: "wood-leader", elm: "elm-leader" } }));
    const lane = createTask({ project: "wood", title: "in a lane", role: "executor", workspacePath: `lane:${WOOD}@main` });
    assert.equal((getDb().prepare("SELECT workspace_kind AS k FROM tasks WHERE id = ?").get(lane.id) as { k: string }).k, "lane");
    const temp = createTask({ project: "elm", title: "in a worktree", role: "executor", workspacePath: ELM });
    getDb().prepare("UPDATE tasks SET workspace_path = ?, workspace_kind = 'worktree' WHERE id = ?").run(join(dir, "checkouts", "elm-1"), temp.id);
    getDb().prepare("INSERT INTO events (task_id, at, kind, actor, data_json) VALUES (?, ?, 'worktree_created', 'scheduler', ?)").run(temp.id, NOW.toISOString(), JSON.stringify({ root: ELM }));
    assert.deepEqual(projectDirectories("wood"), [WOOD]);
    assert.deepEqual(projectDirectories("elm"), [ELM]);
    recordPaseoProjects([entry("b", BETA)]);
    assert.deepEqual([...removedProjects()].sort(), ["elm", "wood"]);
    await assert.rejects(() => handleTool("kanban_create", { project: "wood", title: "x", role: "executor" }, null, LEADER), /Paseo/);
    await assert.rejects(() => startTask(lane.id, {} as never, "supervisor"), /Paseo/);
    recordPaseoProjects([entry("w", WOOD), entry("b", BETA)]);
    assert.equal(isProjectRemoved("wood"), false);
  });

  it("keeps a project with no known directory, since nothing can prove it is gone", () => {
    recordPaseoProjects([entry("only", BETA)]);
    assert.equal(isProjectRemoved("nodir"), false);
    assert.equal(isProjectRemoved("never-heard-of"), false);
    assert.deepEqual([...removedProjects()], ["alpha"]);
  });
});

describe("keeping the last good list when Paseo cannot be read", () => {
  it("treats every project as present when Paseo has never been read", () => {
    assert.equal(paseoProjectPaths(), null);
    assert.equal(isProjectRemoved("alpha"), false);
    assert.equal(removedProjects().size, 0);
    assert.doesNotThrow(() => assertProjectInPaseo("alpha"));
  });

  it("keeps the previous list when a refresh fails, times out, or returns nonsense", async () => {
    recordPaseoProjects([entry("b", BETA)]);
    assert.equal(isProjectRemoved("alpha"), true);
    assert.equal(await refreshPaseoProjects({ projects: { list: async () => { throw new Error("daemon down"); } } }), false);
    assert.equal(await refreshPaseoProjects({ projects: { list: () => new Promise(() => undefined) } }, { timeoutMs: 20 }), false);
    assert.equal(await refreshPaseoProjects({ projects: { list: async () => ({ unexpected: true }) } }), false);
    assert.equal(isProjectRemoved("alpha"), true);
    assert.equal(isProjectRemoved("beta"), false);
  });

  it("takes a successful empty list as the answer: the last project can be removed", async () => {
    recordPaseoProjects([entry("a", ALPHA)]);
    assert.equal(await refreshPaseoProjects({ projects: { list: async () => ({ projects: [] }) } }, { now: NOW }), true);
    assert.equal(isProjectRemoved("alpha"), true);
    assert.deepEqual([...removedProjects()].sort(), ["alpha", "beta"]);
    await assert.rejects(() => handleTool("kanban_create", { project: "alpha", title: "x", role: "executor" }, null, LEADER), /Paseo/);
    open("alpha", "history");
    assert.deepEqual(listBoard(undefined, { archived: false }).tasks, []);
    // The empty list is stored, and a fresh process keeps it.
    resetPaseoProjects();
    assert.equal(isProjectRemoved("alpha"), true);
    assert.deepEqual(JSON.parse(readFileSync(paseoProjectsPath(), "utf8")).projects, []);
  });

  it("takes a first successful empty list too, through the client and the command line", async () => {
    assert.equal(await refreshPaseoProjects({ projects: { list: async () => ({ projects: [] }) } }), true);
    assert.equal(isProjectRemoved("alpha"), true);
    resetPaseoProjects({ clearFile: true });
    assert.equal(refreshPaseoProjectsFromCli(() => "[]"), true);
    assert.equal(isProjectRemoved("alpha"), true);
    assert.equal(isProjectRemoved("nodir"), false);
  });

  it("replaces the list after a good refresh and stores it for other processes", async () => {
    const ok = await refreshPaseoProjects({ projects: { list: async () => ({ projects: [
      { projectId: "p1", projectDisplayName: "Alpha", projectRootPath: `${ALPHA}/`, projectKind: "git" },
    ] }) } }, { now: NOW });
    assert.equal(ok, true);
    assert.equal(isProjectRemoved("alpha"), false);
    assert.equal(isProjectRemoved("beta"), true);
    const stored = JSON.parse(readFileSync(paseoProjectsPath(), "utf8")) as { readAt: string; projects: Array<{ path: string }> };
    assert.equal(stored.readAt, NOW.toISOString());
    assert.deepEqual(stored.projects.map((row) => row.path), [ALPHA]);
    // A fresh process has no memory, only the file.
    resetPaseoProjects();
    assert.equal(isProjectRemoved("beta"), true);
    assert.equal(isProjectRemoved("alpha"), false);
  });

  it("ignores a damaged stored file as if Paseo had never been read", () => {
    recordPaseoProjects([entry("a", ALPHA)]);
    resetPaseoProjects();
    writeFileSync(paseoProjectsPath(), "{not json");
    assert.equal(paseoProjectPaths(), null);
    assert.equal(isProjectRemoved("beta"), false);
  });

  it("falls back to the paseo command line when no client is available, and keeps the list if that fails too", () => {
    const rows = JSON.stringify([{ projectId: "p1", name: "A", kind: "git", path: ALPHA }]);
    assert.equal(refreshPaseoProjectsFromCli(() => rows, { now: NOW }), true);
    assert.equal(isProjectRemoved("beta"), true);
    assert.equal(isProjectRemoved("alpha"), false);
    assert.equal(refreshPaseoProjectsFromCli(() => { throw new Error("spawn paseo ENOENT"); }), false);
    assert.equal(refreshPaseoProjectsFromCli(() => "not json"), false);
    assert.equal(isProjectRemoved("alpha"), false);
  });

  it("parses the client answer strictly", () => {
    assert.deepEqual(
      parsePaseoProjectList({ projects: [{ projectId: "p", projectDisplayName: "P", projectRootPath: `${ALPHA}/` }] }),
      [{ id: "p", name: "P", path: ALPHA }],
    );
    assert.throws(() => parsePaseoProjectList(null));
    assert.throws(() => parsePaseoProjectList({ projects: "no" }));
    assert.throws(() => parsePaseoProjectList({ projects: [{ projectId: "p" }] }));
  });
});

describe("a project that left Paseo is quiet everywhere", () => {
  beforeEach(() => recordPaseoProjects([entry("b", BETA)]));

  it("counts as dormant for wakes and reminders without being a paused project", () => {
    assert.equal(isProjectPaused("alpha"), false);
    assert.equal(isProjectDormant("alpha"), true);
    assert.equal(isProjectDormant("beta"), false);
  });

  it("refuses new cards, registered cards and starts, with a message that says the project left Paseo", async () => {
    const card = open("beta", "kept");
    const args = { project: "alpha", title: "new work", role: "executor" };
    await assert.rejects(() => handleTool("kanban_create", args, null, LEADER), /alpha/);
    await assert.rejects(() => handleTool("kanban_create", args, null, LEADER), /Paseo/);
    assert.throws(() => assertProjectInPaseo("alpha"), /Paseo/);
    const created = (await handleTool("kanban_create", { ...args, project: "beta" }, null, LEADER)) as { id?: number };
    assert.ok(created.id);
    getDb().prepare("UPDATE tasks SET project = 'alpha' WHERE id = ?").run(card.id);
    await assert.rejects(() => startTask(card.id, {} as never, "supervisor"), /Paseo/);
    assert.equal((getDb().prepare("SELECT status FROM tasks WHERE id = ?").get(card.id) as { status: string }).status, "ready");
  });

  it("keeps the cards and shows them again with includeRemoved", () => {
    open("alpha", "history");
    open("beta", "live");
    const hidden = listBoard(undefined, { archived: false });
    assert.deepEqual(hidden.tasks.map((card) => card.project), ["beta"]);
    assert.ok(!hidden.projects.includes("alpha"));
    assert.deepEqual(listBoard("alpha").tasks, []);
    const all = listBoard(undefined, { archived: false, includeRemoved: true });
    assert.deepEqual(all.tasks.map((card) => card.project).sort(), ["alpha", "beta"]);
    assert.equal(listBoard("alpha", { includeRemoved: true }).tasks.length, 1);
  });

  it("hides the cards from the list tool and shows them with includeRemoved", async () => {
    open("alpha", "history");
    open("beta", "live");
    const hidden = (await handleTool("kanban_list", {}, null, LEADER)) as { tasks: Array<{ project: string }> };
    assert.deepEqual(hidden.tasks.map((card) => card.project), ["beta"]);
    const shown = (await handleTool("kanban_list", { includeRemoved: true }, null, LEADER)) as { tasks: Array<{ project: string }> };
    assert.deepEqual(shown.tasks.map((card) => card.project).sort(), ["alpha", "beta"]);
  });

  it("drops the project from the by-project rows, but includeRemoved brings it back", () => {
    open("alpha");
    open("beta");
    assert.deepEqual(projectRows(config()).map((row) => row.project), ["beta", "nodir"]);
    assert.deepEqual(projectRows(config(), { includeRemoved: true }).map((row) => row.project), ["alpha", "beta", "nodir"]);
  });

  it("lets a card show still read it through the tools", async () => {
    const card = open("alpha", "still readable");
    const shown = (await handleTool("kanban_show", { id: card.id }, null, LEADER)) as { task?: { project?: string } };
    assert.equal(shown.task?.project, "alpha");
  });
});

describe("doctor", () => {
  async function check(): Promise<DoctorReport> {
    clearDoctorSafetyCache();
    return runDoctor({ now: NOW, wake: false, persist: false, sources: { agents: { agents: [], paseoIds: [] } } });
  }

  it("still reports a red for a project that is in Paseo", async () => {
    recordPaseoProjects([entry("a", ALPHA), entry("b", BETA)]);
    const card = open("alpha", "agent missing");
    getDb().prepare("UPDATE tasks SET status = 'running', agent_id = 'missing-agent' WHERE id = ?").run(card.id);
    const report = await check();
    assert.equal(report.findings.find((item) => item.id === `agent:missing:${card.id}`)?.severity, "red");
  });

  it("reports at most one info for a project that left Paseo, and no red or yellow", async () => {
    recordPaseoProjects([entry("b", BETA)]);
    const gone = open("alpha", "agent missing");
    getDb().prepare("UPDATE tasks SET status = 'running', agent_id = 'missing-agent' WHERE id = ?").run(gone.id);
    const kept = open("beta", "agent missing too");
    getDb().prepare("UPDATE tasks SET status = 'running', agent_id = 'other-missing' WHERE id = ?").run(kept.id);
    const report = await check();
    assert.equal(report.findings.some((item) => item.project === "alpha" && item.severity !== "info"), false);
    assert.equal(report.findings.find((item) => item.id === `agent:missing:${kept.id}`)?.severity, "red");
    const notes = report.findings.filter((item) => item.id.startsWith("paseo-project:removed"));
    assert.equal(notes.length, 1);
    assert.equal(notes[0].severity, "info");
    assert.match(notes[0].symptom, /alpha/);
    assert.doesNotMatch(notes[0].symptom, /beta/);
    assert.equal(report.counts.red, 1);
  });

  it("also leaves out a directory leftover whose card belongs to a removed project", async () => {
    recordPaseoProjects([entry("b", BETA)]);
    const gone = open("alpha", "has a retained agent");
    const kept = open("beta", "has a retained agent too");
    const place = join(dir, "worktrees", "placeholder-alpha");
    const other = join(dir, "worktrees", "placeholder-beta");
    clearDoctorSafetyCache();
    const report = await runDoctor({
      now: NOW, wake: false, persist: false,
      sources: {
        dirs: { root: join(dir, "worktrees"), worktrees: [], list: () => [place, other], placeholderAgents: (path: string) => (path === place ? ["a-agent"] : ["b-agent"]) },
        agents: { agents: [
          { id: "a-agent", archived: true, labels: { kanban_task: String(gone.id) } },
          { id: "b-agent", archived: true, labels: { kanban_task: String(kept.id) } },
        ], paseoIds: [] },
      },
    });
    const placeholders = report.findings.filter((item) => item.id.startsWith("dir:placeholder:"));
    assert.deepEqual(placeholders.map((item) => item.object), [other]);
    assert.equal(report.findings.some((item) => item.card != null && item.card.startsWith("ALPHA") && item.severity !== "info"), false);
    assert.equal(report.findings.filter((item) => item.id.startsWith("paseo-project:removed")).length, 1);
  });

  it("adds no note when nothing left Paseo", async () => {
    recordPaseoProjects([entry("a", ALPHA), entry("b", BETA)]);
    const report = await check();
    assert.equal(report.findings.some((item) => item.id.startsWith("paseo-project:")), false);
  });
});

describe("the fleet views", () => {
  const paused = [
    { project: "alpha", since: "2026-10-01", note: "" },
    { project: "beta", since: "2026-10-02", note: "" },
  ];

  it("quiets paused and removed projects together", () => {
    const quiet = quietProjects(paused, new Set(["alpha", "gamma"]));
    assert.deepEqual(quiet.map((row) => row.project).sort(), ["alpha", "beta", "gamma"]);
    assert.equal(quiet.find((row) => row.project === "alpha")?.since, "2026-10-01");
  });

  it("shows only paused projects that are still in Paseo", () => {
    assert.deepEqual(shownPaused(paused, new Set(["alpha"])).map((row) => row.project), ["beta"]);
    assert.deepEqual(shownPaused(paused, new Set()).map((row) => row.project), ["alpha", "beta"]);
  });
});

describe("leader reminders and shifts", () => {
  beforeEach(() => recordPaseoProjects([entry("b", BETA)]));

  it("does not ask the leader of a removed project to shift, and creates nothing", async () => {
    const calls: string[] = [];
    const ports = new Proxy({}, { get: (_t, name) => (...args: unknown[]) => { calls.push(String(name)); return Promise.resolve(null); } });
    for (const action of ["start", "continue"] as const) {
      const result = await requestSupervisorShift({} as PaseoApi, "alpha", action, ports as never);
      assert.notEqual(result.phase, "running");
    }
    assert.deepEqual(calls, []);
  });

  it("sends no compatibility failure notice to a removed project's leader, but still notifies one that is in Paseo", async () => {
    const sent: string[] = [];
    const deps = (): UpgradeDeps => ({
      readState: async () => ({ version: "1", recordedAt: "", checkedAt: null, results: [] }),
      writeState: async () => undefined,
      currentVersion: async () => "2",
      plugins: [
        { id: "a", label: "Plugin A", dir: "/a", cwdMatch: "alpha-cwd", project: "alpha" },
        { id: "b", label: "Plugin B", dir: "/b", cwdMatch: "beta-cwd", project: "beta" },
      ],
      hasCompatScript: async () => true,
      runCompat: async () => ({ ok: false, timedOut: false, output: "broken" }),
      listAgents: async () => [
        { id: "alpha-leader", title: "alpha", cwd: "alpha-cwd", archivedAt: null },
        { id: "beta-leader", title: "beta", cwd: "beta-cwd", archivedAt: null },
      ],
      send: async (id) => { sent.push(id); },
      now: () => NOW.toISOString(),
      readSupervisors: async () => ({ alpha: "alpha-leader", beta: "beta-leader" }),
    });
    await runUpgradeCheck(deps(), { force: true });
    assert.deepEqual(sent, ["beta-leader"]);
  });
});
