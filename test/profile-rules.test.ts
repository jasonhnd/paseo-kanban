/// <reference types="node" />
import { DEMO_PROFILE_RULES } from "./helpers/dispatch-policy";
import { zhCN, zhCNPart, localePattern, complexDocsProfileName, highRiskProfileName } from "./helpers/locale";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { setWakeSender } from "../server/bus";
import { kanbanHelp, runKanban } from "../server/cli";
import { DEFAULT_CONCURRENCY, loadConfig, saveConfig, type KanbanConfig } from "../server/config";
import { closeDb, getDb } from "../server/db";
import { countRunsToday, effectiveProfileRules, normalizeTags, tokyoDayStart } from "../server/profile-rules";
import type { Profile } from "../server/profiles";
import { type TickOptions } from "../server/schedule";
import { runTick } from "./helpers/compat-schedule";
import { createTask, getDetail, getTask } from "../server/store";
import { handleTool } from "../server/tools";
import { issueToken } from "../server/tokens";
import { resetAgentAliveCheck, resetBoardWakeForTests, setAgentAliveCheck } from "../server/wake";

const tmp = tmpdir();
mkdirSync(tmp, { recursive: true });
const dir = mkdtempSync(join(tmp, "rules-"));
process.env.KANBAN_DATA_DIR = dir;
const poolFile = join(dir, "pool-status.json");
process.env.KANBAN_POOL_STATUS = poolFile;

const grok: Profile = { id: "g", name: zhCN("labels.role.executor"), role: "executor", family: "xai", provider: "grok", model: "grok-4.7", pool: "supergrok" };
const opus: Profile = {
  id: "o",
  name: complexDocsProfileName,
  role: "candidate",
  candidateFor: "executor",
  family: "anthropic",
  provider: "claude",
  model: "claude-opus-5-5",
  pool: "claude-max",
};
const review: Profile = { id: "r", name: zhCN("labels.role.reviewer"), role: "reviewer", family: "anthropic", provider: "claude", model: "sonnet", pool: "claude-max" };
const xaiReview: Profile = {
  id: "xr",
  name: "Reviewer · Grok",
  role: "candidate",
  candidateFor: "reviewer",
  family: "xai",
  provider: "grok",
  model: "grok-4.7",
  pool: "cursor",
};

const sent: Array<{ id: string; text: string }> = [];

function config(project: string, supervisorAgentId: string | null = null): KanbanConfig {
  const value: KanbanConfig = {
    autoStart: { [project]: true },
    supervisorAgentId,
    supervisors: {},
    profileRules: DEMO_PROFILE_RULES,
    concurrency: { global: 50, pools: { ...DEFAULT_CONCURRENCY.pools, "claude-max": 50, supergrok: 50 }, roles: { executor: 50, reviewer: 50 } },
  };
  saveConfig(value);
  return value;
}

function launcher(): TickOptions["launcher"] {
  let n = 0;
  return {
    async create() {
      n += 1;
      return { id: `rules-agent-${Date.now()}-${n}` };
    },
    async send() {},
  };
}

function writePools(pools: Record<string, Record<string, unknown>>, ageMs = 0): void {
  writeFileSync(poolFile, JSON.stringify({ generatedAt: new Date().toISOString(), pools }));
  if (ageMs > 0) {
    const old = new Date(Date.now() - ageMs);
    utimesSync(poolFile, old, old);
  }
}

function workspace(name: string): string {
  const path = join(dir, name);
  mkdirSync(path, { recursive: true });
  return path;
}

function addRun(taskId: number, profile: string, startedAt: string): void {
  getDb()
    .prepare(`INSERT INTO runs (task_id, agent_id, role, profile_name, provider, model, family, started_at) VALUES (?, ?, 'reviewer', ?, 'cursor', 'grok-4.7', 'xai', ?)`)
    .run(taskId, `run-${Math.random()}`, profile, startedAt);
}

beforeEach(() => {
  sent.length = 0;
  setWakeSender((id, text) => {
    sent.push({ id, text });
  });
  setAgentAliveCheck(() => true);
  resetBoardWakeForTests();
  writePools({ supergrok: { dispatchable: true }, "claude-max": { dispatchable: true }, cursor: { dispatchable: true } });
});

after(() => {
  resetAgentAliveCheck();
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe("card tags", () => {
  it("takes repeated --tag on the CLI, stores them once each and shows them in the detail", async () => {
    // TEST_0188: a card needs a configured project.
    await runKanban(["project", "--project", "tags", "--code", "TAGS"], {});
    const created = (await runKanban(
      ["create", "--project", "tags", "--title", "With tag", "--role", "executor", "--workspace", workspace("tags"), "--tag", "high-risk", "--tag", "complex-docs,High-Risk", "--json"],
      {},
    )) as { id: number; tags: string | null };
    assert.deepEqual(JSON.parse(created.tags ?? "[]"), ["high-risk", "complex-docs"]);
    assert.deepEqual(getDetail(created.id).task.tags, ["high-risk", "complex-docs"]);
  });

  it("takes tags from the MCP kanban_create tool", async () => {
    await runKanban(["project", "--project", "tags", "--code", "TAGS"], {});
    const token = issueToken("supervisor", null, null);
    const created = (await handleTool(
      "kanban_create",
      { project: "tags", title: "MCP Sample text", role: "reviewer", workspace: workspace("tags-mcp"), tags: ["high-risk"] },
      token,
    )) as { id: number };
    assert.deepEqual(getDetail(created.id).task.tags, ["high-risk"]);
    const plain = createTask({ project: "tags", title: "Without tag", role: "executor", workspacePath: workspace("tags-none") });
    assert.equal(plain.tags, null);
    assert.deepEqual(getDetail(plain.id).task.tags, []);
  });

  it("rejects a malformed tag", () => {
    assert.throws(() => normalizeTags(["High risk"]), new RegExp(localePattern(zhCNPart("profileRules.tagInvalid", 0, 3)) + "High risk」" + localePattern(zhCNPart("nativeSessions.archive.badSuffix", 4, 7))));
  });

  it("explains both tags in --help", () => {
    assert.match(kanbanHelp(), /--tag high-risk/);
    assert.match(kanbanHelp(), /--tag complex-docs/);
  });
});

describe("profile rules config", () => {
  it("ships no profile-name-specific policy", () => {
    assert.deepEqual(effectiveProfileRules(), {});
  });
  it("keeps profileRules overrides through load and save, and applies only the explicitly configured rules", () => {
    writeFileSync(
      join(dir, "kanban.config.json"),
      JSON.stringify({ autoStart: {}, supervisors: {}, profileRules: { [((zhCN("labels.role.reviewer") + " ") + "· Backup")]: { dailyLimit: 3 }, [complexDocsProfileName]: null, [highRiskProfileName]: { tags: ["high-risk"], orPoolPrefer: true } } }),
    );
    const loaded = loadConfig();
    assert.deepEqual(loaded.profileRules, { [((zhCN("labels.role.reviewer") + " ") + "· Backup")]: { dailyLimit: 3 }, [complexDocsProfileName]: null, [highRiskProfileName]: { tags: ["high-risk"], orPoolPrefer: true } });
    const rules = effectiveProfileRules(loaded.profileRules);
    assert.equal(rules[complexDocsProfileName], undefined);
    assert.deepEqual(rules[((zhCN("labels.role.reviewer") + " ") + "· Backup")], { dailyLimit: 3 });
    assert.deepEqual(rules[highRiskProfileName], { tags: ["high-risk"], orPoolPrefer: true });
  });
});

describe("daily count", () => {
  it("counts runs from Tokyo midnight", () => {
    const task = createTask({ project: "count", title: "Count", role: "reviewer", workspacePath: workspace("count") });
    addRun(task.id, "Counting profile", "2026-09-27T14:59:59.000Z");
    addRun(task.id, "Counting profile", "2026-09-27T15:00:00.000Z");
    addRun(task.id, "Counting profile", "2026-09-28T02:00:00.000Z");
    const now = Date.parse("2026-09-28T03:00:00.000Z");
    assert.equal(new Date(tokyoDayStart(now)).toISOString(), "2026-09-27T15:00:00.000Z");
    assert.equal(countRunsToday("Counting profile", now), 2);
  });
});

describe("scheduler with profile rules", () => {
  it("holds an untagged card on quota when only Opus could take it, and starts Opus once tagged", async () => {
    writePools({ supergrok: { dispatchable: false }, "claude-max": { dispatchable: true }, cursor: { dispatchable: true } });
    const plain = createTask({ project: "opus-rule", title: "Ordinary card", role: "executor", workspacePath: workspace("opus-plain") });
    const held = await runTick({ profiles: [grok, opus, review, xaiReview], launcher: launcher(), config: config("opus-rule") });
    assert.ok(!held.started.includes(plain.id));
    const after = getTask(plain.id);
    assert.equal(after.status, "ready");
    assert.notEqual(after.blocked_kind, "needs_human");
    assert.match(after.hold_reason ?? "", new RegExp(localePattern(zhCNPart("routing.ruleWaitHead", 0, 8)) + ".*complex-docs"));

    const tagged = createTask({ project: "opus-rule", title: "Contract alignment", role: "executor", workspacePath: workspace("opus-tagged"), tags: ["complex-docs"] });
    const result = await runTick({ profiles: [grok, opus, review, xaiReview], launcher: launcher(), config: config("opus-rule") });
    assert.ok(result.started.includes(tagged.id));
    assert.equal(getTask(tagged.id).executor_profile, opus.name);
  });

});

describe("stale pool snapshot wake", () => {
  it("wakes the Kanban supervisor once after 6 hours without an update", async () => {
    writePools({ supergrok: { dispatchable: true } }, 7 * 60 * 60 * 1000);
    await runTick({ profiles: [grok, review], launcher: launcher(), config: config("stale-wake", "kanban-sup") });
    await runTick({ profiles: [grok, review], launcher: launcher(), config: config("stale-wake", "kanban-sup") });
    const wakes = sent.filter((item) => item.id === "kanban-sup" && new RegExp(zhCN("wake.board.poolStale")).test(item.text));
    assert.equal(wakes.length, 1);
    assert.match(wakes[0]?.text ?? "", new RegExp(localePattern(zhCNPart("pools.staleMessage", 20, 27))));
  });

  it("does not wake before 6 hours", async () => {
    writePools({ supergrok: { dispatchable: true } }, 5 * 60 * 60 * 1000);
    await runTick({ profiles: [grok, review], launcher: launcher(), config: config("stale-quiet", "kanban-sup") });
    assert.equal(sent.filter((item) => new RegExp(zhCN("doctor.object.quota")).test(item.text)).length, 0);
  });
});
