/// <reference types="node" />
import { zhCNPart, localePattern } from "./helpers/locale";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { runKanban } from "../server/cli";
import { loadConfig, saveConfig, setProjectSupervisor } from "../server/config";
import { closeDb } from "../server/db";

const dir = mkdtempSync(join(tmpdir(), "TEST_0096-"));
process.env.KANBAN_DATA_DIR = dir;
const project = "demo_fleet";
const env = { PASEO_AGENT_ID: "hand-open-leader" };

beforeEach(() => {
  const config = loadConfig();
  config.projects = {
    [project]: { code: "EX", defaultWorkspace: "dir", baseBranch: "main", worktreeLanes: 1, lanesEnabled: false },
  };
  config.supervisors = {};
  saveConfig(config);
});

after(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe("supervisor project registration", () => {
  it("keeps a configured full project name", async () => {
    const result = await runKanban(["supervise", "--project", project], env) as { project: string };
    assert.equal(result.project, project);
    assert.deepEqual(loadConfig().supervisors, { [project]: env.PASEO_AGENT_ID });
  });

  it("resolves short codes regardless of case and explains the canonical registration", async () => {
    for (const code of ["EX", "ex", "Ex"]) {
      const result = await runKanban(["supervise", "--project", code], env) as { project: string; message: string };
      assert.equal(result.project, project);
      assert.equal(result.message, `${zhCNPart("leaderRegistry.supervise.byCode", 0, 5)}EX ${zhCNPart("leaderRegistry.supervise.byCode", 12, 16)}${project}`);
      assert.deepEqual(loadConfig().supervisors, { [project]: env.PASEO_AGENT_ID });
    }
  });

  it("rejects unknown names with available names and codes without changing the file", async () => {
    const path = join(dir, "kanban.config.json");
    const before = readFileSync(path, "utf8");
    await assert.rejects(() => runKanban(["supervise", "--project", "unknown"], env), (error: Error) => {
      assert.match(error.message, new RegExp(localePattern(zhCNPart("config.unknownProject", 0, 5)) + "unknown」"));
      assert.ok(error.message.includes(`${project}${zhCNPart("missingCwd.none", 0, 1)}EX${zhCNPart("missingCwd.none", 3, 4)}`));
      return true;
    });
    assert.equal(readFileSync(path, "utf8"), before);
  });

  it("applies the same validation to the setter used by the settings RPC, including removal", () => {
    setProjectSupervisor(" ex ", " settings-leader ");
    assert.deepEqual(loadConfig().supervisors, { [project]: "settings-leader" });
    assert.throws(() => setProjectSupervisor("unknown", "leader"), new RegExp(localePattern(zhCNPart("config.unknownProject", 0, 4))));
    assert.throws(() => setProjectSupervisor("unknown", null), new RegExp(localePattern(zhCNPart("config.unknownProject", 0, 4))));
    assert.deepEqual(loadConfig().supervisors, { [project]: "settings-leader" });
    setProjectSupervisor("Ex", null);
    assert.deepEqual(loadConfig().supervisors, {});
  });
});
