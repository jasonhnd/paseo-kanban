/// <reference types="node" />
import { zhCNPart, localePattern } from "./helpers/locale";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { runKanban } from "../server/cli";
import { ConfigFileError, DEFAULT_CONCURRENCY, loadConfig, saveConfig } from "../server/config";
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
