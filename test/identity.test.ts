/// <reference types="node" />
import { zhCN, zhCNPart, localePattern } from "./helpers/locale";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { kanbanHelp } from "../server/cli";
import { runKanban } from "./helpers/compat-cli";
import { loadConfig, setProjectCode, setProjectSupervisor, setSupervisorAgentId } from "../server/config";
import { closeDb, getDb } from "../server/db";
import { blockTask, createTask, getTask } from "../server/store";
import { issueToken } from "../server/tokens";

const tmp = tmpdir();
mkdirSync(tmp, { recursive: true });
const dir = mkdtempSync(join(tmp, "identity-"));
process.env.KANBAN_DATA_DIR = dir;
// TEST_0188: cards go only into configured projects.
for (const [name, code] of [["box", "BOX"], ["mine", "MINE"], ["elsewhere", "ELS"], ["shell", "SHL"]]) setProjectCode(name, code);

after(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

function acceptance(id: number): void {
  getDb().prepare("UPDATE tasks SET status = 'acceptance' WHERE id = ?").run(id);
}

describe("cli identity", () => {
  it("refuses create, accept, and start from an agent Kanban opened", async () => {
    const worker = "worker-kanban";
    const card = createTask({ project: "box", title: "Running card", role: "executor", workspacePath: dir });
    getDb().prepare("UPDATE tasks SET agent_id = ?, status = 'acceptance' WHERE id = ?").run(worker, card.id);
    const env = { PASEO_AGENT_ID: worker };
    await assert.rejects(() => runKanban(["create", "--project", "box", "--title", "Unauthorized creation", "--role", "executor"], env), new RegExp(localePattern(zhCNPart("tools.denial.create", 0, 13))));
    await assert.rejects(() => runKanban(["accept", String(card.id)], env), new RegExp(localePattern(zhCNPart("tools.denial.accept", 0, 13))));
    await assert.rejects(() => runKanban(["start", String(card.id)], env), new RegExp(localePattern(zhCNPart("cli.onlyLeader.start", 0, 13))));
    assert.equal(getTask(card.id).status, "acceptance");
  });

  it("treats a kanban=1 label as a worker even without a row", async () => {
    const agents = join(dir, "agents");
    process.env.KANBAN_AGENTS_DIR = agents;
    const id = "labeled-worker";
    const folder = join(agents, id.slice(0, 2));
    mkdirSync(folder, { recursive: true });
    writeFileSync(
      join(folder, `${id}.json`),
      JSON.stringify({ id, cwd: dir, labels: { kanban: "1", role: "reviewer" }, title: "Reviewer", provider: "cursor" }),
    );
    await assert.rejects(
      () => runKanban(["create", "--project", "box", "--title", (zhCN("labels.role.reviewer") + "Demo text"), "--role", "executor"], { PASEO_AGENT_ID: id }),
      new RegExp(localePattern(zhCNPart("tools.denial.create", 0, 13))),
    );
  });

  it("refuses create from an unregistered hand-opened agent until it registers, then records it as the creator", async () => {
    const hand = "hand-open-boss";
    // TEST_0184 P1-1: an agent that is neither board-launched nor a registered <leader> is read-only.
    await assert.rejects(
      () => runKanban(["create", "--project", "mine", "--title", (zhCNPart("wake.gap.unregistered", 0, 3) + "Demo text"), "--role", "executor"], { PASEO_AGENT_ID: hand }),
      new RegExp(localePattern(zhCNPart("identity.guestDenial", 4, 18))),
    );
    await runKanban(["supervise", "--project", "mine"], { PASEO_AGENT_ID: hand });
    const created = (await runKanban(["create", "--project", "mine", "--title", "Created by me", "--role", "executor"], { PASEO_AGENT_ID: hand })) as {
      id: number;
      created_by_agent: string | null;
    };
    assert.equal(created.created_by_agent, hand);
    assert.equal(getTask(created.id).created_by_agent, hand);
    acceptance(created.id);
    const accepted = (await runKanban(["accept", String(created.id)], { PASEO_AGENT_ID: hand })) as { status: string };
    assert.equal(accepted.status, "done");
  });

  it("is the unrestricted supervisor when no identity env is set", async () => {
    const foreign = createTask({ project: "elsewhere", title: "Another card", role: "executor", createdByAgent: "someone-else" });
    acceptance(foreign.id);
    const created = (await runKanban(["create", "--project", "shell", "--title", (zhCNPart("cli.newProjectOnlyKanbanLeader", 35, 37) + zhCNPart("wake.children.next", 1, 3)), "--role", "executor"], {})) as {
      created_by_agent: string | null;
      status: string;
    };
    assert.equal(created.created_by_agent, null);
    const accepted = (await runKanban(["accept", String(foreign.id)], {})) as { status: string };
    assert.equal(accepted.status, "done");
  });

  it("does not let a project supervisor accept a card from another project", async () => {
    const boss = "boss-of-mine";
    await runKanban(["supervise", "--project", "mine"], { PASEO_AGENT_ID: boss });
    assert.equal(loadConfig().supervisors.mine, boss);
    const other = createTask({ project: "elsewhere", title: "Sample text", role: "executor", createdByAgent: "other-boss" });
    acceptance(other.id);
    await assert.rejects(() => runKanban(["accept", String(other.id)], { PASEO_AGENT_ID: boss }), new RegExp(localePattern(zhCN("identity.otherProjectCard", { action: zhCN("tools.action.accept"), project: "elsewhere" }))));
    assert.equal(getTask(other.id).status, "acceptance");
    setProjectSupervisor("elsewhere", boss);
    const accepted = (await runKanban(["accept", String(other.id)], { PASEO_AGENT_ID: boss })) as { status: string };
    assert.equal(accepted.status, "done");
  });

  it("lets the Kanban supervisor unblock a board-caused card outside the project, but not accept it", async () => {
    const kanban = "kanban-fallback";
    const local = "proj-only";
    setSupervisorAgentId(kanban);
    setProjectSupervisor("mine", local);
    const fused = createTask({ project: "elsewhere", title: "Circuit breaker", role: "executor", createdByAgent: "other-boss" });
    getDb().prepare("UPDATE tasks SET status = 'running' WHERE id = ?").run(fused.id);
    blockTask(fused.id, "needs_human", (zhCN("compat.run.failed") + zhCNPart("settings.thresholds.landConflictLimit", 4, 6) + "Demo text"), "scheduler");
    await assert.rejects(() => runKanban(["unblock", String(fused.id)], { PASEO_AGENT_ID: local }), new RegExp(localePattern(zhCN("identity.otherProjectCard", { action: zhCN("cardDrawer.settings.unblock"), project: "elsewhere" }))));
    const unblocked = (await runKanban(["unblock", String(fused.id)], { PASEO_AGENT_ID: kanban })) as { status: string };
    assert.equal(unblocked.status, "running");

    const human = createTask({ project: "elsewhere", title: "Missing information", role: "executor", createdByAgent: "other-boss" });
    getDb().prepare("UPDATE tasks SET status = 'running' WHERE id = ?").run(human.id);
    blockTask(human.id, "needs_human", (zhCNPart("decisions.hold.rework", 1, 4) + "Demo text"), "executor");
    await assert.rejects(() => runKanban(["unblock", String(human.id)], { PASEO_AGENT_ID: kanban }), new RegExp(localePattern(zhCN("identity.otherProjectCard", { action: zhCN("cardDrawer.settings.unblock"), project: "elsewhere" }))));

    const review = createTask({ project: "elsewhere", title: "Waiting for acceptance", role: "executor", createdByAgent: "other-boss" });
    acceptance(review.id);
    await assert.rejects(() => runKanban(["accept", String(review.id)], { PASEO_AGENT_ID: kanban }), new RegExp(localePattern(zhCN("identity.otherProjectCard", { action: zhCN("tools.action.accept"), project: "elsewhere" }))));
    assert.equal(getTask(review.id).status, "acceptance");
  });

  it("keeps a token identity even when PASEO_AGENT_ID is also set", async () => {
    const card = createTask({ project: "token", title: "Token card", role: "executor" });
    const executor = issueToken("executor", card.id, "token-agent");
    await assert.rejects(
      () =>
        runKanban(["create", "--project", "token", "--title", "Must not create", "--role", "executor"], {
          KANBAN_TOKEN: executor,
          PASEO_AGENT_ID: "hand-open-boss",
        }),
      new RegExp(localePattern(zhCNPart("tools.denial.create", 0, 13))),
    );
  });

  it("refuses project registration from a Kanban worker and documents the remaining risk", async () => {
    await assert.rejects(() => runKanban(["supervise", "--project", "mine"], { PASEO_AGENT_ID: "worker-kanban" }), new RegExp(localePattern(zhCNPart("leaderRegistry.error.notLeader", 16, 39))));
    await assert.rejects(() => runKanban(["supervise", "--project", "mine"], {}), new RegExp(localePattern(zhCNPart("cli.supervise.needAgent", 18, 35))));
    assert.match(kanbanHelp(), /PASEO_AGENT_ID/);
    assert.match(kanbanHelp(), /supervise --project/);
    assert.match(kanbanHelp(), new RegExp("\\u9632\\u7684\\u662f\\u8bef\\u7528\\uff0c\\u9632\\u4e0d\\u4e86\\u5b58\\u5fc3\\u7ed5\\u8fc7"));
    const help = String(await runKanban(["--help"], {}));
    assert.equal(help, kanbanHelp());
  });
});
