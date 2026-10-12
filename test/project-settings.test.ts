/// <reference types="node" />
import { zhCN, zhCNPart, localePattern } from "./helpers/locale";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { runKanban } from "../server/cli";
import { retiredDefaultWorktree, loadConfig, logRetiredDefaultWorktrees, projectWorkspace, saveConfig } from "../server/config";
import { closeDb, getDb } from "../server/db";
import { createTask } from "../server/store";
import { seedFixtureProjects } from "./helpers/seed-projects";

const tmp = tmpdir();
mkdirSync(tmp, { recursive: true });
const dir = mkdtempSync(join(tmp, "project-settings-"));
process.env.KANBAN_DATA_DIR = dir;
seedFixtureProjects(dir);

after(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

const supervisorEnv = { PASEO_AGENT_ID: "" };

describe("project workspace settings", () => {
  it("shows directory defaults and lets only a supervisor change them", async () => {
    const shown = (await runKanban(["project"], supervisorEnv)) as { text: string; projects: Record<string, { code?: string }> };
    assert.match(shown.text, new RegExp("demo_library" + localePattern(zhCNPart("cli.project.line", 6, 13)) + "main" + localePattern(zhCNPart("cli.project.line", 19, 23)) + "1" + localePattern(zhCNPart("missingCwd.none", 0, 1)) + zhCN("cli.project.lanesOff") + localePattern(zhCNPart("parents.refresh.failed", 12, 14)) + zhCN("cli.project.parallelOn") + localePattern(zhCNPart("cli.project.code", 0, 4)) + "DEMO"));
    assert.match(shown.text, new RegExp("demo_portal" + localePattern(zhCNPart("cli.project.line", 6, 13)) + "main" + localePattern(zhCNPart("cli.project.line", 19, 23)) + "1" + localePattern(zhCNPart("missingCwd.none", 0, 1)) + zhCN("cli.project.lanesOff") + localePattern(zhCNPart("parents.refresh.failed", 12, 14)) + zhCN("cli.project.parallelOn") + localePattern(zhCNPart("cli.project.code", 0, 4)) + "TEST2"));
    assert.equal(shown.projects.demo_library?.code, "DEMO");
    assert.equal(shown.projects.demo_web?.code, "DEMO2");
    assert.deepEqual(projectWorkspace("demo_library"), {
      defaultWorkspace: "dir",
      baseBranch: "main",
      worktreeLanes: 1,
      lanesEnabled: false,
      parallel: true,
      code: "DEMO",
    });

    await assert.rejects(
      () => runKanban(["project", "--project", "demo_library", "--workspace", "worktree", "--base", "pre"], supervisorEnv),
      new RegExp(retiredDefaultWorktree()),
    );
    assert.equal(loadConfig().projects?.demo_library?.defaultWorkspace, "dir");
    assert.equal(loadConfig().projects?.demo_library?.code, "DEMO");

    const set = (await runKanban(["project", "--project", "demo_library", "--workspace", "dir", "--base", "pre", "--lanes", "2"], supervisorEnv)) as {
      ok: boolean;
      text: string;
      defaultWorkspace: string;
      baseBranch: string;
      worktreeLanes: number;
      lanesEnabled: boolean;
    };
    assert.equal(set.ok, true);
    assert.equal(set.defaultWorkspace, "dir");
    assert.equal(set.baseBranch, "pre");
    assert.equal(set.worktreeLanes, 2);
    assert.match(set.text ?? "", new RegExp(localePattern(zhCNPart("cli.project.line", 7, 13)) + "pre" + localePattern(zhCNPart("cli.project.line", 19, 23)) + "2" + localePattern(zhCNPart("missingCwd.none", 0, 1)) + zhCN("cli.project.lanesOff") + localePattern(zhCNPart("missingCwd.none", 3, 4))));
    assert.equal(set.lanesEnabled, false);
    const again = (await runKanban(["project", "--project", "demo_library"], supervisorEnv)) as {
      text: string;
      defaultWorkspace: string;
      baseBranch: string;
      worktreeLanes: number;
    };
    assert.match(again.text, new RegExp(localePattern(zhCNPart("cli.project.line", 7, 13)) + "pre" + localePattern(zhCNPart("cli.project.line", 19, 23)) + "2"));
    assert.equal(again.baseBranch, "pre");
    assert.equal(again.worktreeLanes, 2);
    assert.equal(projectWorkspace("other").defaultWorkspace, "dir");

    const raw = loadConfig();
    raw.projects = {
      ...(raw.projects ?? {}),
      demo_library: { defaultWorkspace: "worktree", baseBranch: "pre", worktreeLanes: 2, lanesEnabled: false, parallel: true },
    };
    saveConfig(raw);
    assert.equal(projectWorkspace("demo_library").defaultWorkspace, "dir");
    const warned = (await runKanban(["project", "--project", "demo_library"], supervisorEnv)) as { text: string; defaultWorkspace: string };
    assert.equal(warned.defaultWorkspace, "dir");
    assert.match(warned.text, new RegExp(retiredDefaultWorktree()));
    const lines: string[] = [];
    assert.deepEqual(logRetiredDefaultWorktrees((line) => lines.push(line)), ["demo_library"]);
    assert.match(lines[0] ?? "", new RegExp(retiredDefaultWorktree()));

    const worker = createTask({ project: "guard", title: "Worker", role: "executor", workspacePath: dir });
    getDb().prepare("UPDATE tasks SET agent_id = ? WHERE id = ?").run("worker-project", worker.id);
    await assert.rejects(
      () => runKanban(["project", "--project", "demo_library", "--workspace", "dir"], { PASEO_AGENT_ID: "worker-project" }),
      new RegExp(localePattern(zhCNPart("cli.project.onlyLeader", 0, 19))),
    );
    assert.equal(loadConfig().projects?.demo_library?.defaultWorkspace, "worktree");
    await assert.rejects(() => runKanban(["project", "--project", "demo_library", "--workspace", "sideways"], supervisorEnv), new RegExp(zhCN("config.workspaceOnlyDir")));
    const saved = readFileSync(join(dir, "kanban.config.json"), "utf8");
    assert.match(saved, /"baseBranch": "pre"/);
  });

  it("shows alwaysTemp and lets only a supervisor turn it on or off", async () => {
    const listed = (await runKanban(["project"], supervisorEnv)) as { text: string };
    assert.match(listed.text, new RegExp(zhCN("cli.project.alwaysTempOff")));
    const off = (await runKanban(["project", "--project", "show-temp"], supervisorEnv)) as { text: string; alwaysTemp?: boolean };
    assert.match(off.text, new RegExp(zhCN("cli.project.alwaysTempOff")));
    assert.equal(off.alwaysTemp, undefined);
    await assert.rejects(
      () => runKanban(["project", "--project", "show-temp", "--always-temp", "maybe"], supervisorEnv),
      new RegExp(zhCN("cli.project.onOff.alwaysTemp")),
    );
    const on = (await runKanban(["project", "--project", "show-temp", "--always-temp", "on"], supervisorEnv)) as {
      text: string;
      alwaysTemp?: boolean;
    };
    assert.equal(on.alwaysTemp, true);
    assert.match(on.text, new RegExp(zhCN("cli.project.alwaysTempOn")));
    assert.equal(loadConfig().projects?.["show-temp"]?.alwaysTemp, true);
    await runKanban(["project", "--project", "show-temp", "--base", "develop", "--code", "SHW"], supervisorEnv);
    assert.equal(projectWorkspace("show-temp").alwaysTemp, true);
    assert.equal(projectWorkspace("show-temp").baseBranch, "develop");
    assert.equal(projectWorkspace("show-temp").code, "SHW");
    const closed = (await runKanban(["project", "--project", "show-temp", "--always-temp", "off"], supervisorEnv)) as {
      text: string;
      alwaysTemp?: boolean;
    };
    assert.match(closed.text, new RegExp(zhCN("cli.project.alwaysTempOff")));
    assert.equal(closed.alwaysTemp, undefined);
    assert.equal(loadConfig().projects?.["show-temp"]?.alwaysTemp, undefined);
    const worker = createTask({ project: "guard-temp", title: "Worker", role: "executor", workspacePath: dir });
    getDb().prepare("UPDATE tasks SET agent_id = ? WHERE id = ?").run("worker-always", worker.id);
    await assert.rejects(
      () => runKanban(["project", "--project", "show-temp", "--always-temp", "on"], { PASEO_AGENT_ID: "worker-always" }),
      new RegExp(localePattern(zhCNPart("cli.project.onlyLeader", 0, 19))),
    );
  });
});


it("sets, displays and preserves waitParentPr with project leader scope", async () => {
  const show = async (project: string) => await runKanban(["project", "--project", project], supervisorEnv) as { text: string; waitParentPr: boolean };
  assert.equal((await show("wait-switch")).waitParentPr, true);
  assert.match((await show("wait-switch")).text, new RegExp(zhCN("labels.badge.waitingParents", {"marks":("PR " + zhCNPart("cli.project.onOff.waitParentPr", 7, 10))})));
  await runKanban(["project", "--project", "wait-switch", "--wait-parent-pr", "off"], supervisorEnv);
  assert.equal((await show("wait-switch")).waitParentPr, false);
  assert.match((await show("wait-switch")).text, new RegExp(zhCN("labels.badge.waitingParents", {"marks":("PR " + zhCNPart("worktreeGc.leftover.notMerged", 1, 3) + zhCN("cli.project.off"))})));
  await runKanban(["project", "--project", "wait-switch", "--base", "pre", "--code", "WPR"], supervisorEnv);
  assert.equal(loadConfig().projects?.["wait-switch"]?.waitParentPr, false);
  const config = loadConfig();
  config.supervisors = { ...config.supervisors, "wait-switch": "own-leader", other: "other-leader" };
  saveConfig(config);
  await assert.rejects(() => runKanban(["project", "--project", "wait-switch", "--wait-parent-pr", "on"], { PASEO_AGENT_ID: "other-leader" }), new RegExp("forbidden|" + localePattern(zhCNPart("nativeSessions.cli.ownProjectOnly", 0, 2)) + "|" + localePattern(zhCNPart("doctor.safety.unsafe", 0, 2)) + "|\\u65e0\\u6743"));
  await assert.rejects(() => runKanban(["project", "--project", "wait-switch", "--wait-parent-pr", "on"], { PASEO_AGENT_ID: "worker-project" }), new RegExp(localePattern(zhCNPart("cli.onlyLeader.rebind", 0, 10))));
  assert.equal((await show("wait-switch")).waitParentPr, false);
  await runKanban(["project", "--project", "wait-switch", "--wait-parent-pr", "on"], { PASEO_AGENT_ID: "own-leader" });
  assert.equal((await show("wait-switch")).waitParentPr, true);
  await assert.rejects(() => runKanban(["project", "--project", "wait-switch", "--wait-parent-pr", "maybe"], supervisorEnv), new RegExp("on " + localePattern(zhCNPart("cli.project.onOff.allowLanes", 11, 16))));
});
