import { zhCN, zhCNPart, localePattern } from "./helpers/locale";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, it } from "node:test";
import { kanbanHelp, runKanban } from "../server/cli";
import { closeDb, getDb } from "../server/db";
import { completeTask, approveTask, requestChanges, rejectTask, leaderReworkTask } from "../server/flow";
import { clearExternalWait, completionNextStep, externalWaitMessage } from "../server/external-wait";
import { blockTask, claimStatus, createTask, getTask, listBoard, setBlockedListener } from "../server/store";
import { issueToken } from "../server/tokens";
import { handleTool, toolDefs } from "../server/tools";
import { protocolFor } from "../server/protocol";
import { boardRpc } from "../shared/rpc";
import { STATUSES } from "../shared/labels";

const dir = mkdtempSync(join(tmpdir(), "TEST_0107-"));
process.env.KANBAN_DATA_DIR = dir;
after(() => { setBlockedListener(null); closeDb(); rmSync(dir, { recursive: true, force: true }); });

function card(role = "executor") {
  const task = createTask({ project: "external-wait", title: "External wait", role });
  const agent = `agent-${task.id}`;
  getDb().prepare("UPDATE tasks SET status = 'running', agent_id = ?, executor_agent_id = ? WHERE id = ?").run(agent, agent, task.id);
  return { task: getTask(task.id), agent, token: issueToken(role, task.id, agent) };
}
function count(id: number, kind: string) {
  return (getDb().prepare("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND kind = ?").get(id, kind) as { n: number }).n;
}

for (const via of ["MCP", "CLI", "store"]) {
  for (const reason of ["Delivery ready; wait for CI", (zhCNPart("boardViews.projects.counts", 50, 53) + "PR https://github.com/acme/repo/pull/1 " + zhCNPart("worktreeGc.leftover.notMerged", 1, 3)), (zhCNPart("boardView.blocked.dependency", 40, 44) + "Demo text"), (zhCNPart("parents.block.waitingParents", 0, 4) + zhCNPart("boardViews.doctor.open", 6, 8) + "TEST_0042"), "Waiting for CI checks", "Pending pull request merge", "external CI dependency, not a failure", "awaiting task #477"]) {
    it(`${via} rejects executor dependency wait: ${reason}`, async () => {
      const { task, token, agent } = card();
      let notifications = 0;
      setBlockedListener(() => { notifications++; });
      try {
        await assert.rejects(async () => {
          if (via === "store") return blockTask(task.id, "dependency", reason, "executor");
          if (via === "CLI") return runKanban(["block", String(task.id), "--kind", "dependency", "--reason", reason], { PASEO_AGENT_ID: agent });
          return handleTool("kanban_block", { kind: "dependency", reason }, token);
        }, err => err instanceof Error && err.message === externalWaitMessage());
        assert.deepEqual(getTask(task.id), task);
        assert.equal(notifications, 0);
        assert.equal(count(task.id, "blocked"), 0);
        assert.equal(count(task.id, "block_rejected"), 1);
      } finally { setBlockedListener(null); }
    });
  }
}

for (const [role, kind, reason] of [
  ["executor", "needs_human", (zhCNPart("cardDrawer.pr.awaiting", 0, 2) + "CI " + zhCNPart("doctor.quota.unknownSuggestion", 19, 22) + zhCNPart("waitUser.listUnreadable", 38, 41) + zhCNPart("permissions.deny.noAutoAccept", 8, 10))],
  ["executor", "dependency", (zhCNPart("cardParts.event.prWait", 0, 2) + zhCNPart("doctor.decision.symptom", 2, 6) + " PR " + zhCNPart("doctor.quota.unknownSuggestion", 19, 22))],
  ["executor", "dependency", "CI access denied, awaiting manual authorization"],
  ["executor", "dependency", (zhCNPart("cardParts.event.prWait", 0, 2) + "Fix CI " + zhCN("compat.run.failed"))],
  ["executor", "dependency", (zhCNPart("db.migration.noDatabase", 0, 2) + "Demo text")],
  ["executor", "dependency", ("CI " + zhCNPart("config.noProjects", 3, 5) + zhCNPart("settings.error.broken", 5, 8) + zhCNPart("compat.workspaces.empty", 5, 7) + zhCN("labels.role.executor"))],
  ["executor", "dependency", "CI Broken tier configuration; cannot run"],
  ["executor", "dependency", "preparing package"],
  ["executor", "capability", (zhCNPart("boardViews.projects.counts", 50, 53) + "CI" + zhCN("common.comma") + "Demo text")],
  ["reviewer", "dependency", (zhCNPart("boardViews.projects.counts", 50, 53) + "CI")],
  ["reader", "dependency", zhCN("cardDrawer.pr.awaiting")],
  ["batch", "dependency", (zhCNPart("boardView.blocked.dependency", 40, 44) + zhCN("labels.status.done"))],
  ["supervisor", "dependency", (zhCNPart("cardDrawer.pr.awaiting", 0, 2) + "CI")],
]) {
  it(`preserves ${role}/${kind}: ${reason}`, async () => {
    const { task, token } = card(role);
    await handleTool("kanban_block", { id: task.id, kind, reason }, token);
    assert.equal(getTask(task.id).status, "blocked");
    assert.equal(count(task.id, "blocked"), 1);
    assert.equal(count(task.id, "block_rejected"), 0);
  });
}

for (const via of ["MCP", "CLI"]) {
  for (const wait of ["CI", ("PR https://github.com/acme/repo/pull/7 " + zhCNPart("worktreeGc.leftover.notMerged", 1, 3)), (zhCNPart("boardView.cmd.parentCode", 1, 4) + " TEST_0042 " + zhCN("labels.status.done"))]) {
    it(`${via} completes with ${wait}, exposes it through board RPC and keeps it at acceptance`, async () => {
      const { task, token } = card();
      const handoff = { files: ["server/flow.ts"], verification: "passed", risks: [], waitingOn: ` ${wait} ` };
      const result = via === "MCP"
        ? await handleTool("kanban_complete", { summary: "Submitted", handoff }, token)
        : await runKanban(["complete", String(task.id), "--summary", "Submitted", "--handoff", JSON.stringify(handoff)], { KANBAN_TOKEN: token });
      assert.equal((result as { status: string }).status, "in_review");
      assert.deepEqual(JSON.parse(getTask(task.id).handoff_json!).handoff, via === "CLI" ? JSON.stringify(handoff) : handoff);
      const event = getDb().prepare("SELECT actor, data_json FROM events WHERE task_id = ? AND kind = 'complete'").get(task.id) as { actor: string; data_json: string };
      assert.equal(event.actor, "executor");
      const pr = wait.match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/)?.[0];
      assert.deepEqual(JSON.parse(event.data_json), {
        summary: "Submitted", waitingOn: wait,
        ...(pr ? { ignoredPr: [{ url: pr, reason: "project_repository_unknown_or_no_origin" }] } : {}),
      });
      assert.equal(JSON.parse(getTask(task.id).contract_json!).pr, null);
      const cards = boardRpc.output.shape.tasks.parse(listBoard("external-wait").tasks);
      assert.equal(cards.find(t => t.id === task.id)?.nextStep, `${zhCN("blocked.prefix.external")}${wait}`);
      getDb().prepare("UPDATE tasks SET status = 'reviewing' WHERE id = ?").run(task.id);
      await approveTask(task.id, zhCNPart("cardDrawer.verdict.approve", 2, 4));
      assert.equal(getTask(task.id).status, "acceptance");
      assert.equal(listBoard("external-wait").tasks.find(t => t.id === task.id)?.nextStep, `${zhCN("blocked.prefix.external")}${wait}`);
    });
  }
}

it("counts direct acceptance handoffs, and keeps blank or absent waits out of the waitingOn metric", async () => {
  for (const [role, handoff, expected] of [
    ["reader", { waitingOn: (zhCNPart("boardView.external.headline", 1, 3) + zhCNPart("relatedView.header", 22, 24)) }, (zhCNPart("boardView.external.headline", 1, 3) + zhCNPart("relatedView.header", 22, 24))],
    ["executor", { waitingOn: "  " }, null],
    ["executor", { waitingOn: null }, null],
    ["executor", { files: [] }, null],
    ["executor", null, null],
  ] as const) {
    const { task } = card(role);
    await completeTask(task.id, role, zhCN("labels.status.done"), handoff);
    assert.equal(getTask(task.id).status, role === "reader" ? "acceptance" : "in_review");
    const n = getDb().prepare("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND kind = 'complete' AND json_type(data_json, '$.waitingOn') = 'text' AND length(trim(json_extract(data_json, '$.waitingOn'))) > 0").get(task.id) as { n: number };
    assert.equal(n.n, expected ? 1 : 0);
    assert.equal(listBoard("external-wait").tasks.find(t => t.id === task.id)?.nextStep, expected ? `${zhCN("blocked.prefix.external")}${expected}` : null);
  }
});

it("rejects non-text waitingOn before changing the card or writing a completion", () => {
  for (const value of [42, [], {}]) {
    const { task } = card();
    assert.throws(() => completeTask(task.id, "executor", zhCN("labels.status.done"), { waitingOn: value }), new RegExp("waitingOn " + localePattern(zhCNPart("profileRules.tagNotText", 2, 7))));
    assert.deepEqual(getTask(task.id), task);
    assert.equal(count(task.id, "complete"), 0);
  }
});

it("keeps hold text and tolerates legacy, malformed, and replaced handoffs", async () => {
  assert.equal(completionNextStep(null, (zhCNPart("identityLines.openExecutor", 2, 5) + zhCNPart("transientRetry.timeout.send", 4, 6)), "acceptance"), (zhCNPart("identityLines.openExecutor", 2, 5) + zhCNPart("transientRetry.timeout.send", 4, 6)));
  assert.equal(completionNextStep("bad json", null, "acceptance"), null);
  assert.equal(completionNextStep('{"handoff":{"waitingOn":42}}', null, "acceptance"), null);
  assert.equal(completionNextStep('{"handoff":{"waitingOn":"CI"}}', "CI Not green", "acceptance"), (zhCN("blocked.prefix.external") + "CI\nCI Not green"));
  const { task } = card();
  completeTask(task.id, "executor", (zhCNPart("profileRules.tag.highRisk", 62, 64) + zhCNPart("reviewHold.lead.rounds", 1, 2)), { waitingOn: "CI" });
  getDb().prepare("UPDATE tasks SET status = 'running' WHERE id = ?").run(task.id);
  completeTask(task.id, "executor", "Second round", { files: [] });
  assert.equal(listBoard("external-wait").tasks.find(t => t.id === task.id)?.nextStep, null);
});

it("keeps executor instructions, MCP descriptions and CLI help aligned", async () => {
  for (const text of [protocolFor("executor"), kanbanHelp(),
    toolDefs().find(t => t.name === "kanban_block")!.description]) {
    assert.match(text, new RegExp(localePattern(zhCNPart("externalWait.message", 0, 18))));
    assert.match(text, /waitingOn/);
    assert.match(text, /needs_human/);
  }
  assert.match(toolDefs().find(t => t.name === "kanban_complete")!.description, /waitingOn/);
  assert.equal(await runKanban(["block", "--help"]), kanbanHelp());
});

for (const status of STATUSES) {
  it(`shows external waits only in completion states: ${status}`, () => {
    const { task } = card();
    const raw = JSON.stringify({ summary: "Old handoff", handoff: { waitingOn: "CI" } });
    getDb().prepare("UPDATE tasks SET status = ?, handoff_json = ?, hold_reason = ? WHERE id = ?")
      .run(status, raw, (zhCNPart("nativeSessions.kept.leader", 9, 11) + zhCNPart("transientRetry.timeout.send", 4, 6)), task.id);
    const visible = ["in_review", "reviewing", "acceptance"].includes(status);
    assert.equal(listBoard("external-wait").tasks.find(t => t.id === task.id)?.nextStep,
      visible ? (zhCN("blocked.prefix.external") + "CI\n" + zhCNPart("nativeSessions.kept.leader", 9, 11) + zhCNPart("transientRetry.timeout.send", 4, 6)) : (zhCNPart("nativeSessions.kept.leader", 9, 11) + zhCNPart("transientRetry.timeout.send", 4, 6)));
    assert.equal(getTask(task.id).handoff_json, raw);
  });
}

for (const text of [false, true]) {
  for (const route of ["review reject", "leader reject", "leader rework", "leader reassign", "running claim"]) {
    it(`clears ${text ? "CLI text" : "object"} waits on ${route} without changing history`, async () => {
      const { task } = card();
      const handoff = { files: ["file.ts"], verification: "passed", risks: [], waitingOn: "CI" };
      completeTask(task.id, "executor", (zhCNPart("profileRules.tag.highRisk", 62, 64) + zhCNPart("reviewHold.lead.rounds", 1, 2)), text ? JSON.stringify(handoff) : handoff);
      if (route === "review reject") {
        getDb().prepare("UPDATE tasks SET status = 'reviewing' WHERE id = ?").run(task.id);
        requestChanges(task.id, "Add tests", zhCNPart("doctor.format.none", 6, 8));
      } else if (route === "leader reject") {
        getDb().prepare("UPDATE tasks SET status = 'acceptance' WHERE id = ?").run(task.id);
        await rejectTask(task.id, "Add tests");
      } else if (route.startsWith("leader")) {
        await leaderReworkTask(task.id, "Add tests", { presence: () => route === "leader reassign" ? "missing" : "idle" });
      } else {
        getDb().prepare("UPDATE tasks SET status = 'ready' WHERE id = ?").run(task.id);
        claimStatus(task.id, "ready", "running", "supervisor");
      }
      const stored = JSON.parse(getTask(task.id).handoff_json!);
      assert.equal(stored.summary, (zhCNPart("profileRules.tag.highRisk", 62, 64) + zhCNPart("reviewHold.lead.rounds", 1, 2)));
      assert.equal(typeof stored.handoff, text ? "string" : "object");
      assert.deepEqual(text ? JSON.parse(stored.handoff) : stored.handoff,
        { files: ["file.ts"], verification: "passed", risks: [] });
      assert.equal(listBoard("external-wait").tasks.find(t => t.id === task.id)?.nextStep, null);
      const metric = () => (getDb().prepare("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND kind = 'complete' AND json_type(data_json, '$.waitingOn') = 'text' AND length(trim(json_extract(data_json, '$.waitingOn'))) > 0").get(task.id) as { n: number }).n;
      assert.equal(metric(), 1);
      if (getTask(task.id).status !== "running") {
        getDb().prepare("UPDATE tasks SET status = 'ready' WHERE id = ?").run(task.id);
        claimStatus(task.id, "ready", "running", "supervisor");
      }
      completeTask(task.id, "executor", "Second round", { waitingOn: (zhCNPart("compactEvents.apply.pruned", 20, 22) + "PR") });
      assert.equal(listBoard("external-wait").tasks.find(t => t.id === task.id)?.nextStep, (zhCN("blocked.prefix.external") + zhCNPart("compactEvents.apply.pruned", 20, 22) + "PR"));
      assert.equal(metric(), 2);
    });
  }
}

it("preserves malformed and unrelated legacy handoffs when clearing waits", () => {
  for (const raw of [null, "bad json", "null", '{"handoff":"bad json"}', '{"handoff":[]}', '{"summary":"legacy","handoff":{"files":[]}}']) {
    const { task } = card();
    getDb().prepare("UPDATE tasks SET handoff_json = ? WHERE id = ?").run(raw, task.id);
    clearExternalWait(task.id);
    assert.equal(getTask(task.id).handoff_json, raw);
  }
});
