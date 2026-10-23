/// <reference types="node" />
import { zhCNPart, localePattern } from "./helpers/locale";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { runKanban } from "../server/cli";
import { ConfigFileError, DEFAULT_CONCURRENCY, loadConfig, parseConfig, saveConfig, setProjectCode, setProjectWorkspace } from "../server/config";
import { projectRepository } from "../server/project-repo";
import { readSettings, writeSettings } from "../server/settings";
import { cardMark, takeCodeSeq } from "../server/card-ref";
import { closeDb, getDb } from "../server/db";
import { ensureProjectCode, syncProjectCodes } from "../server/project-codes";
import { createTask } from "../server/store";

const tmp = tmpdir();
mkdirSync(tmp, { recursive: true });
const dirs: string[] = [];

function useDir(): string {
  closeDb();
  const next = mkdtempSync(join(tmp, "config-file-"));
  dirs.push(next);
  process.env.KANBAN_DATA_DIR = next;
  return next;
}

after(() => {
  closeDb();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function configPath(dir: string): string {
  return join(dir, "kanban.config.json");
}

function tempNames(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.endsWith(".tmp"));
}

function captureError(run: () => void): string[] {
  const logs: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => {
    logs.push(args.map((item) => String(item)).join(" "));
  };
  try {
    run();
  } finally {
    console.error = orig;
  }
  return logs;
}

describe("config file writes", () => {
  for (const field of ["repo", "repository"]) for (const viaCli of [false, true]) it(`preserves project ${field} without a workspace through ${viaCli ? "CLI project --base --code" : "setProjectCode"}`, async () => {
    const dir = useDir();
    writeFileSync(configPath(dir), JSON.stringify({ projects: { demo: { defaultWorkspace: "dir", [field]: "https://github.com/example/demo.git" } } }));
    assert.equal(projectRepository({ project: "demo", workspacePath: null }), "example/demo");
    if (viaCli) {
      await runKanban(["project", "--project", "demo", "--base", "develop", "--code", "DEMO"], { PASEO_AGENT_ID: "" });
    } else {
      setProjectCode("demo", "DEMO");
    }
    const saved = JSON.parse(readFileSync(configPath(dir), "utf8")).projects.demo;
    assert.equal(saved.repo, "example/demo");
    assert.equal(saved.code, "DEMO");
    assert.equal(saved.workspacePath, undefined);
    if (viaCli) assert.equal(saved.baseBranch, "develop");
    assert.equal(projectRepository({ project: "demo", workspacePath: null }), "example/demo");
  });

  for (const field of ["repo", "repository"]) it(`preserves and normalizes project ${field} through config, workspace and settings saves`, async () => {
    const dir = useDir();
    writeFileSync(configPath(dir), JSON.stringify({ projects: { demo: { defaultWorkspace: "dir", [field]: " https://github.com/example/demo.git " } } }));
    const assertRepo = () => {
      assert.equal(projectRepository({ project: "demo", workspacePath: null }), "example/demo");
      assert.equal(JSON.parse(JSON.stringify(loadConfig())).projects.demo.repo, "example/demo");
    };
    assertRepo();
    saveConfig(loadConfig());
    assertRepo();
    setProjectWorkspace("demo", { baseBranch: "develop" });
    assertRepo();
    const view = await readSettings(async () => []);
    const result = await writeSettings({ revision: view.revision, document: view.document! }, async () => []);
    assert.equal(result.ok, true, result.message);
    assertRepo();
    saveConfig(loadConfig());
    assert.equal(JSON.parse(readFileSync(configPath(dir), "utf8")).projects.demo.repo, "example/demo");
  });

  it("rejects invalid configured repository identities instead of silently losing them", () => {
    for (const field of ["repo", "repository"]) for (const value of ["example", "example/demo/extra", "../demo", "example/..", "https://example.invalid/demo/repo", "", 42]) {
      assert.throws(() => parseConfig({ projects: { demo: { defaultWorkspace: "dir", [field]: value } } }), ConfigFileError);
    }
  });

  it("accepts repository-only projects and gives repo precedence over its legacy alias", () => {
    const config = parseConfig({ projects: { demo: { repo: ["git", "github.com:example/demo.git"].join("@"), repository: "example/legacy" } } });
    assert.equal(config.projects?.demo.repo, "example/demo");
    assert.equal(config.projects?.demo.defaultWorkspace, "dir");
  });

  it("preserves cloud budgets, qualification and background limits through workspace edits", () => {
    const dir = useDir();
    const source = {
      cloud: { allowedProjects: ["demo"], maxMachines: 2, deleteTimeoutSec: 120, deletePollIntervalSec: 2 },
      qualification: { executor: { L4: [] } },
      backgroundWaitUnknownLimit: 2,
      projects: { demo: { qualification: { reviewer: { L3: [] } } } },
    };
    writeFileSync(configPath(dir), JSON.stringify(source));
    const assertSettings = () => {
      const config = loadConfig();
      assert.deepEqual(config.cloud, source.cloud);
      assert.deepEqual(config.qualification, source.qualification);
      assert.equal(config.backgroundWaitUnknownLimit, source.backgroundWaitUnknownLimit);
      assert.deepEqual(config.projects?.demo.qualification, source.projects.demo.qualification);
      assert.equal(config.projects?.demo.defaultWorkspace, "dir");
    };
    assertSettings();
    setProjectWorkspace("demo", { baseBranch: "develop" });
    assertSettings();
    assert.equal(loadConfig().projects?.demo.baseBranch, "develop");
  });

  it("does not change a config file that cannot be read or parsed", () => {
    const bodies = [
      '{"supervisors":{"xyz_tasks":"agent-1"},"concurrency":{"global":4}',
      "",
      "   ",
      "null",
      "[]",
      '"x"',
    ];
    for (const body of bodies) {
      const dir = useDir();
      const path = configPath(dir);
      writeFileSync(path, body);
      const before = readFileSync(path);
      const logs = captureError(() => {
        getDb();
        syncProjectCodes(getDb());
        assert.throws(
          () => ensureProjectCode("xyz_tasks"),
          (err: unknown) => {
            assert.ok(err instanceof ConfigFileError);
            assert.match((err as ConfigFileError).message, new RegExp(localePattern(zhCNPart("config.broken", 33, 37))));
            return true;
          },
        );
      });
      assert.deepEqual(readFileSync(path), before);
      assert.deepEqual(tempNames(dir), []);
      assert.equal(logs.length, 2);
      for (const line of logs) assert.match(line, new RegExp("^\\[paseo-kanban\\] kanban\\.config\\.json " + localePattern(zhCNPart("config.broken", 19, 37))));
    }
  });

  it("does not replace a config path that cannot be read", () => {
    const dir = useDir();
    const path = configPath(dir);
    mkdirSync(path);
    const logs = captureError(() => {
      getDb();
      syncProjectCodes(getDb());
      assert.throws(() => ensureProjectCode("xyz_tasks"), ConfigFileError);
    });
    assert.equal(statSync(path).isDirectory(), true);
    assert.equal(logs.length, 2);
    assert.match(logs[0] ?? "", new RegExp(localePattern(zhCNPart("config.broken", 33, 37))));
  });

  it("does not add project codes to an existing file, even for known projects (TEST_0273)", () => {
    const dir = useDir();
    const path = configPath(dir);
    const original = {
      autoStart: { xyz_tasks: false },
      supervisorAgentId: "sup-1",
      supervisors: { xyz_tasks: "agent-xyz_tasks" },
      concurrency: { global: 9, pools: { cursor: 1 }, roles: { executor: 2 } },
      customFlag: "keep-me",
      projects: {
        xyz_tasks: {
          defaultWorkspace: "dir",
          baseBranch: "develop",
          worktreeLanes: 3,
          lanesEnabled: true,
          note: "stay",
        },
        already: {
          defaultWorkspace: "dir",
          baseBranch: "main",
          worktreeLanes: 1,
          lanesEnabled: false,
          code: "ALR",
          extra: 1,
        },
      },
    };
    writeFileSync(path, `${JSON.stringify(original, null, 2)}\n`);
    const before = readFileSync(path);
    getDb();
    syncProjectCodes(getDb());
    createTask({ project: "xyz_tasks", title: "Legacy project without code", role: "executor" });
    assert.deepEqual(readFileSync(path), before);
    assert.equal(ensureProjectCode("xyz_tasks"), "XYZ", "shown with the derived code, not stored");
    assert.equal(ensureProjectCode("already"), "ALR");
    assert.deepEqual(readFileSync(path), before);
    assert.deepEqual(tempNames(dir), []);
  });

  it("does not rewrite the file on later opens", () => {
    const dir = useDir();
    const path = configPath(dir);
    writeFileSync(path, `${JSON.stringify({ supervisors: { xyz_tasks: "agent-xyz_tasks" }, note: "keep" }, null, 2)}\n`);
    const before = readFileSync(path);
    const mtime = statSync(path, { bigint: true }).mtimeNs;
    getDb();
    closeDb();
    getDb();
    syncProjectCodes(getDb());
    closeDb();
    getDb();
    assert.equal(statSync(path, { bigint: true }).mtimeNs, mtime);
    assert.deepEqual(readFileSync(path), before);
    const saved = JSON.parse(before.toString("utf8")) as { supervisors: { xyz_tasks: string }; note: string; projects?: unknown };
    assert.equal(saved.supervisors.xyz_tasks, "agent-xyz_tasks");
    assert.equal(saved.note, "keep");
    assert.equal(saved.projects, undefined);
    assert.deepEqual(tempNames(dir), []);
  });

  it("reports a bad config from the command line and still does not write", async () => {
    const dir = useDir();
    const path = configPath(dir);
    const broken = '{"supervisors":{"xyz_tasks":"agent-1"}';
    writeFileSync(path, broken);
    const before = readFileSync(path);
    const logs: string[] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => {
      logs.push(args.map((item) => String(item)).join(" "));
    };
    try {
      await assert.rejects(
        () => runKanban(["create", "--project", "xyz_tasks", "--title", (zhCNPart("boardView.note.accept", 42, 44) + zhCNPart("missingCwd.purge.writeFailed", 0, 2)), "--role", "executor"], { PASEO_AGENT_ID: "" }),
        (err: unknown) => {
          assert.ok(err instanceof ConfigFileError);
          assert.match((err as ConfigFileError).message, new RegExp(localePattern(zhCNPart("config.broken", 33, 37))));
          return true;
        },
      );
    } finally {
      console.error = orig;
    }
    assert.deepEqual(readFileSync(path), before);
    assert.deepEqual(tempNames(dir), []);
    assert.equal(logs.length, 0, "the command line stops before it opens the database");
  });

  it("does not let saveConfig replace an unreadable file with defaults", () => {
    const dir = useDir();
    const path = configPath(dir);
    const broken = '{"supervisors":{"xyz_tasks":"agent-1"},"concurrency":';
    writeFileSync(path, broken);
    const before = readFileSync(path);
    assert.throws(() => loadConfig(), ConfigFileError, "a broken file is not read as defaults (TEST_0273)");
    const defaults = {
      autoStart: {},
      supervisorAgentId: null,
      supervisors: {},
      concurrency: { global: DEFAULT_CONCURRENCY.global, pools: { ...DEFAULT_CONCURRENCY.pools }, roles: { ...DEFAULT_CONCURRENCY.roles } },
    };
    assert.throws(() => saveConfig(defaults), ConfigFileError);
    assert.deepEqual(readFileSync(path), before);
    assert.deepEqual(tempNames(dir), []);
  });

  it("keeps showing the card number after the config file is broken", () => {
    const dir = useDir();
    const path = configPath(dir);
    const task = createTask({ project: "xyz_tasks", title: "demo fixture", role: "executor" });
    assert.equal(cardMark(task.id), "XYZ_0001");
    const broken = "{ broken";
    writeFileSync(path, broken);
    const before = readFileSync(path);
    assert.equal(cardMark(task.id), "XYZ_0001");
    closeDb();
    const logs = captureError(() => {
      assert.equal(cardMark(task.id), "XYZ_0001");
      assert.throws(() => takeCodeSeq("xyz_tasks"), ConfigFileError);
    });
    assert.deepEqual(readFileSync(path), before);
    assert.deepEqual(tempNames(dir), []);
    assert.equal(logs.length, 1);
    assert.match(logs[0] ?? "", new RegExp("^\\[paseo-kanban\\] kanban\\.config\\.json " + localePattern(zhCNPart("config.broken", 19, 37))));
  });
});
