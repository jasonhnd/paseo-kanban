/// <reference types="node" />
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { DEFAULT_CONCURRENCY, saveConfig, type KanbanConfig } from "../server/config";
import { closeDb, getDb } from "../server/db";
import { clearDoctorSafetyCache, runDoctor, type DoctorReport } from "../server/doctor";
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

  it("does not take an empty answer as 'every project was removed'", async () => {
    recordPaseoProjects([entry("a", ALPHA)]);
    assert.equal(await refreshPaseoProjects({ projects: { list: async () => ({ projects: [] }) } }), false);
    assert.equal(isProjectRemoved("alpha"), false);
    resetPaseoProjects({ clearFile: true });
    assert.equal(await refreshPaseoProjects({ projects: { list: async () => ({ projects: [] }) } }), false);
    assert.equal(removedProjects().size, 0);
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
