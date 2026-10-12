/// <reference types="node" />
import { zhCN, zhCNPart, localePattern, complexDocsProfileName } from "./helpers/locale";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { kanbanHelp, runKanban } from "../server/cli";
import { setProjectCode, setProjectSupervisor } from "../server/config";
import { closeDb, getDb } from "../server/db";
import { reclaimTask } from "../server/failures";
import type { AgentPresence } from "../server/presence";
import { blockTask, createTask, getTask } from "../server/store";
import { issueToken } from "../server/tokens";
import { t } from "../shared/i18n";

const tmp = tmpdir();
mkdirSync(tmp, { recursive: true });
const dir = mkdtempSync(join(tmp, "rebind-"));
process.env.KANBAN_DATA_DIR = dir;

const PROFILE = {
  role: "executor",
  profile_name: complexDocsProfileName,
  provider: "claude",
  model: "claude-opus-5-5",
  family: "anthropic",
  thinking_option_id: "high",
};

function insertRun(taskId: number, agentId: string, role: string, profile = PROFILE.profile_name): void {
  getDb()
    .prepare(
      `INSERT INTO runs (task_id, agent_id, role, profile_name, provider, model, family, auto_accept, thinking_option_id, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    )
    .run(
      taskId,
      agentId,
      role,
      profile,
      role === "reviewer" ? "cursor" : PROFILE.provider,
      role === "reviewer" ? "grok-4.7" : PROFILE.model,
      role === "reviewer" ? "xai" : PROFILE.family,
      role === "reviewer" ? null : PROFILE.thinking_option_id,
      new Date().toISOString(),
    );
}

function present(presence: AgentPresence) {
  return { agentPresence: async () => presence };
}

after(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe("rebind", () => {
  it("documents rebind in the help text and labels the new events", () => {
    assert.match(kanbanHelp(), new RegExp("rebind <" + localePattern(zhCNPart("cli.rebind.needAgent", 29, 40))));
    assert.match(kanbanHelp(), /PASEO_AGENT_ID/);
    const board = readFileSync(new URL("../client/card-parts.tsx", import.meta.url), "utf8");
    assert.match(board, /turn_canceled:\s*"cardParts\.event\.turnCanceled"/);
    assert.match(board, /rebound:\s*"cardParts\.event\.rebound"/);
    assert.equal(t("cardParts.event.turnCanceled"), zhCN("cardParts.event.turnCanceled"));
    assert.equal(t("cardParts.event.rebound"), zhCN("cardParts.event.rebound"));
  });

  it("lets only a supervisor rebind, and refuses an agent that never ran the card", async () => {
    const worker = "worker-rebind";
    const card = createTask({ project: "rebind", title: "Executor running", role: "executor", workspacePath: dir });
    insertRun(card.id, worker, "executor");
    getDb().prepare("UPDATE tasks SET status = 'running', agent_id = ? WHERE id = ?").run(worker, card.id);
    await assert.rejects(() => runKanban(["rebind", String(card.id), "--agent", worker], { PASEO_AGENT_ID: worker }, present("running")), new RegExp(localePattern(zhCNPart("cli.onlyLeader.rebind", 0, 13))));
    assert.equal(getTask(card.id).status, "running");

    const ready = createTask({ project: "rebind", title: "Ready", role: "executor", workspacePath: dir });
    await assert.rejects(
      () => runKanban(["rebind", String(ready.id), "--agent", "stranger"], {}, present("idle")),
      new RegExp(localePattern(zhCNPart("rebind.error.neverRan", 9, 18))),
    );
    assert.equal(getTask(ready.id).status, "ready");
    await assert.rejects(() => runKanban(["rebind", String(ready.id)], {}, present("idle")), new RegExp(localePattern(zhCNPart("cli.rebind.needAgent", 0, 9))));
  });

  it("refuses an archived, closed, missing, or unknown agent and a supervisor from another project", async () => {
    const agent = "agent-refuse";
    const task = createTask({ project: "rebind", title: "Hold", role: "executor", workspacePath: dir, createdByAgent: "owner" });
    insertRun(task.id, agent, "executor");
    getDb().prepare("UPDATE tasks SET status = 'ready', agent_id = NULL WHERE id = ?").run(task.id);
    for (const presence of ["archived", "closed", "missing", "unknown"] as const) {
      const message = presence === "archived" ? new RegExp(zhCN("missingCwd.report.isArchived")) : presence === "closed" ? new RegExp(zhCN("settingsPanel.agent.closed")) : presence === "missing" ? new RegExp(localePattern(zhCNPart("rebind.error.missing", 9, 14))) : new RegExp(localePattern(zhCNPart("rebind.error.unknown", 0, 4)));
      await assert.rejects(() => runKanban(["rebind", String(task.id), "--agent", agent], {}, present(presence)), message);
      assert.equal(getTask(task.id).status, "ready");
    }
    // TEST_0188: "other-boss" must be a registered <leader> of another project; an unregistered session is read-only.
    await assert.rejects(
      () => runKanban(["rebind", String(task.id), "--agent", agent], { PASEO_AGENT_ID: "other-boss" }, present("idle")),
      new RegExp(localePattern(zhCNPart("identity.guestDenial", 4, 18))),
    );
    setProjectCode("rebind_other", "RBO");
    setProjectSupervisor("rebind_other", "other-boss");
    await assert.rejects(
      () => runKanban(["rebind", String(task.id), "--agent", agent], { PASEO_AGENT_ID: "other-boss" }, present("idle")),
      new RegExp(localePattern(zhCNPart("rebind.error.archived", 13, 17)) + localePattern(zhCNPart("identity.otherProjectRule", 4, 10))),
    );
    assert.equal(getTask(task.id).status, "ready");
  });

  it("rebinds a blocked card to the original executor, opens a run, and lets that agent finish with PASEO_AGENT_ID", async () => {
    const agent = "00000000-0000-4000-8000-000000000004";
    const task = createTask({ project: "rebind", title: "Accidental reclaim", role: "executor", workspacePath: dir });
    insertRun(task.id, agent, "executor");
    getDb().prepare("UPDATE tasks SET status = 'running', agent_id = ?, executor_agent_id = ? WHERE id = ?").run(agent, agent, task.id);
    issueToken("executor", task.id, agent);
    assert.equal(reclaimTask(task.id), "reclaimed");
    assert.equal(getTask(task.id).status, "ready");
    const tokens = getDb().prepare("SELECT COUNT(*) AS n FROM tokens WHERE agent_id = ?").get(agent) as { n: number };
    assert.equal(tokens.n, 0);
    blockTask(task.id, "needs_human", (zhCNPart("workspace.freshCopy", 9, 11) + zhCNPart("routing.ruleWaitHead", 7, 10) + zhCN("cardParts.event.rebound")), "supervisor");
    getDb().prepare("UPDATE tasks SET hold_reason = ?, cooldown_until = ?, nudge_count = 3 WHERE id = ?").run("Hold", "2026-09-27T12:00:00.000Z", task.id);

    const bound = (await runKanban(["rebind", String(task.id), "--agent", agent], {}, present("idle"))) as {
      status: string;
      agentId: string;
      text: string;
    };
    assert.equal(bound.status, "running");
    assert.equal(bound.agentId, agent);
    assert.match(bound.text, /PASEO_AGENT_ID/);
    assert.match(bound.text, /bin\/kanban complete/);

    const row = getTask(task.id);
    assert.equal(row.status, "running");
    assert.equal(row.agent_id, agent);
    assert.equal(row.executor_agent_id, agent);
    assert.equal(row.blocked_kind, null);
    assert.equal(row.blocked_reason, null);
    assert.equal(row.blocked_at, null);
    assert.equal(row.blocked_from, null);
    assert.equal(row.hold_reason, null);
    assert.equal(row.cooldown_until, null);
    assert.equal(row.nudge_count, 0);

    const event = getDb().prepare("SELECT actor, from_status, to_status, data_json FROM events WHERE task_id = ? AND kind = 'rebound'").get(task.id) as {
      actor: string;
      from_status: string;
      to_status: string;
      data_json: string;
    };
    assert.equal(event.actor, "supervisor");
    assert.equal(event.from_status, "blocked");
    assert.equal(event.to_status, "running");
    const data = JSON.parse(event.data_json) as { agentId?: string; reason?: string };
    assert.equal(data.agentId, agent);
    assert.equal(typeof data.reason, "string");
    assert.match(data.reason ?? "", new RegExp(zhCN("cardParts.event.rebound")));

    const open = getDb().prepare("SELECT * FROM runs WHERE task_id = ? AND ended_at IS NULL").get(task.id) as {
      agent_id: string;
      role: string;
      profile_name: string;
      provider: string;
      model: string;
      family: string;
      thinking_option_id: string;
    };
    assert.equal(open.agent_id, agent);
    assert.equal(open.role, "executor");
    assert.equal(open.profile_name, PROFILE.profile_name);
    assert.equal(open.provider, PROFILE.provider);
    assert.equal(open.model, PROFILE.model);
    assert.equal(open.family, PROFILE.family);
    assert.equal(open.thinking_option_id, PROFILE.thinking_option_id);
    assert.equal((getDb().prepare("SELECT COUNT(*) AS n FROM tokens WHERE agent_id = ?").get(agent) as { n: number }).n, 0);

    const done = (await runKanban(["complete", String(task.id), "--summary", "Handoff", "--handoff", '{"files":["server/rebind.ts"]}'], {
      PASEO_AGENT_ID: agent,
    })) as { status: string };
    assert.equal(done.status, "in_review");
    assert.equal(getTask(task.id).status, "in_review");
  });

  it("rebinds a review-stage card to reviewing and lets that reviewer approve with PASEO_AGENT_ID", async () => {
    const reviewer = "reviewer-rebind";
    const task = createTask({ project: "rebind", title: "Waiting for review", role: "executor", workspacePath: dir });
    insertRun(task.id, "exec-keep", "executor");
    insertRun(task.id, reviewer, "reviewer", ((zhCN("labels.role.reviewer") + " ") + "· Grok"));
    getDb().prepare("UPDATE tasks SET status = 'in_review', agent_id = NULL, executor_agent_id = 'exec-keep' WHERE id = ?").run(task.id);
    blockTask(task.id, "needs_human", (zhCN("labels.role.reviewer") + "Demo text"), "supervisor");

    const bound = (await runKanban(["rebind", String(task.id), "--agent", reviewer], {}, present("running"))) as { status: string };
    assert.equal(bound.status, "reviewing");
    const row = getTask(task.id);
    assert.equal(row.agent_id, reviewer);
    assert.equal(row.executor_agent_id, "exec-keep");
    assert.equal(row.blocked_kind, null);
    const open = getDb().prepare("SELECT role, profile_name, provider, model, family FROM runs WHERE task_id = ? AND ended_at IS NULL").get(task.id) as {
      role: string;
      profile_name: string;
      provider: string;
      model: string;
      family: string;
    };
    assert.equal(open.role, "reviewer");
    assert.equal(open.profile_name, ((zhCN("labels.role.reviewer") + " ") + "· Grok"));
    assert.equal(open.provider, "cursor");
    assert.equal(open.model, "grok-4.7");
    assert.equal(open.family, "xai");
    const event = getDb().prepare("SELECT to_status, actor FROM events WHERE task_id = ? AND kind = 'rebound'").get(task.id) as {
      to_status: string;
      actor: string;
    };
    assert.equal(event.actor, "supervisor");
    assert.equal(event.to_status, "reviewing");

    const approved = (await runKanban(["approve", String(task.id), "--summary", zhCNPart("cardDrawer.verdict.approve", 2, 4)], { PASEO_AGENT_ID: reviewer })) as { status: string };
    assert.equal(approved.status, "acceptance");
  });
});
