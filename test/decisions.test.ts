/// <reference types="node" />
import { zhCN, zhCNPart, localePattern } from "./helpers/locale";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { decisionBoardExtras, decisionsReadMessage, leaderTarget, readOpenDecisions, waitingOnDecision } from "../server/decisions";
import { cardDecisions, cardHoldReason, decisionGroups, decisionsSnapshotSchema, projectAttentionTotals, type DecisionView } from "../shared/decisions";

const dir = mkdtempSync(join(tmpdir(), "decisions-"));
process.env.KANBAN_DATA_DIR = dir;
const file = join(dir, "decisions.json");
const agents = join(dir, "agents");
mkdirSync(join(agents, "project"), { recursive: true });
process.env.KANBAN_AGENTS_DIR = agents;
after(() => rmSync(dir, { recursive: true, force: true }));

function decision(over: Partial<DecisionView> = {}): DecisionView {
  return { id: "d1", project: "demo_tasks", title: "XYZ_0017 release scope", detail: "A Release;B Waiting . demo fixture A",
    blocking: false, status: "open", createdAt: "2026-10-01T12:00:00Z", agentId: null,
    leader: { agentId: "demo_tasks-leader", reason: null }, ...over };
}
function write(rows: unknown) { writeFileSync(file, JSON.stringify(rows)); }
function record(id: string, extra = {}) {
  writeFileSync(join(agents, "project", `${id}.json`), JSON.stringify({ id, cwd: dir, title: "<leader> · demo_tasks", provider: "codex", lastStatus: "idle", ...extra }));
}

describe("read-only decision source", () => {
  it("keeps only open rows, sorts blocking first and leaves the bytes unchanged", () => {
    write([decision(), decision({ id: "done", status: "done" as "open" }), decision({ id: "block", blocking: true })]);
    const before = readFileSync(file, "utf8");
    const result = readOpenDecisions(file);
    assert.equal(result.message, null);
    assert.deepEqual(result.items.map((item) => item.id), ["block", "d1"]);
    assert.equal(readFileSync(file, "utf8"), before);
  });
  it("reports missing, unreadable, broken JSON and wrong shapes without throwing or writing", () => {
    assert.deepEqual(readOpenDecisions(join(dir, "missing.json")), { items: [], message: decisionsReadMessage() });
    assert.equal(readOpenDecisions(dir).message, decisionsReadMessage());
    for (const content of ["{broken", "{}", '[{"status":"open","title":3}]']) {
      writeFileSync(file, content);
      assert.deepEqual(readOpenDecisions(file), { items: [], message: decisionsReadMessage(), uncertain: true });
      assert.equal(readFileSync(file, "utf8"), content);
    }
  });
  it("accepts a valid empty list and legacy closed rows without open-only fields", () => {
    write([{ status: "done" }]);
    assert.deepEqual(readOpenDecisions(file), { items: [], message: null });
    write([]);
    assert.deepEqual(readOpenDecisions(file), { items: [], message: null });
  });
});

describe("leader resolution and board payload", () => {
  it("uses the decision's agentId first, then the project's supervisor, and honors project filtering", () => {
    write([decision({ agentId: " specific " }), decision({ id: "fallback" }), decision({ id: "other", project: "DEMO" })]);
    const seen: string[] = [];
    const result = decisionBoardExtras({ demo_tasks: "demo_tasks-leader", DEMO: "demo-leader" }, "demo_tasks", { path: file, target(id) {
      seen.push(id ?? ""); return { agentId: id || null, reason: null };
    } });
    assert.deepEqual(result.decisions.items.map((d) => d.leader.agentId), ["specific", "demo_tasks-leader"]);
    assert.deepEqual(Object.keys(result.leaders), ["demo_tasks"]);
    assert.deepEqual(seen, ["demo_tasks-leader", "specific"]);
    assert.ok(decisionsSnapshotSchema.safeParse(result.decisions).success);
  });
  it("marks absent, missing, closed and archived leaders unavailable", () => {
    assert.match(leaderTarget(null).reason!, new RegExp(localePattern(zhCNPart("settings.leaders.none", 1, 5))));
    assert.equal(leaderTarget("missing").agentId, null);
    record("archived", { archivedAt: "2026-10-01" });
    record("closed", { lastStatus: "closed" });
    record("active");
    assert.match(leaderTarget("archived").reason!, new RegExp(zhCN("missingCwd.report.isArchived")));
    assert.match(leaderTarget("closed").reason!, new RegExp(zhCN("settingsPanel.agent.closed")));
    assert.deepEqual(leaderTarget(" active "), { agentId: "active", reason: null });
    write([decision({ project: "unregistered" })]);
    const result = decisionBoardExtras({}, undefined, { path: file });
    assert.equal(result.decisions.items[0].leader.agentId, null);
    assert.match(result.decisions.items[0].leader.reason!, new RegExp(localePattern(zhCNPart("settings.leaders.none", 1, 5))));
  });
});

describe("decision groups, card badges and project counts", () => {
  it("orders blocking project groups first and blocking rows before ordinary rows", () => {
    const groups = decisionGroups([decision({ project: "A" }), decision({ id: "b1", project: "B" }),
      decision({ id: "b2", project: "B", blocking: true }), decision({ id: "a2", project: "A", createdAt: "2026-09-30T12:00:00Z" })]);
    assert.deepEqual(groups.map((g) => [g.project, g.items.map((d) => d.id)]), [["B", ["b2", "b1"]], ["A", ["a2", "d1"]]]);
  });
  it("matches entire codes in title or detail, ignoring case without matching prefixes", () => {
    const rows = [decision(), decision({ id: "detail", title: "Release scope", detail: "sample xyz_0017 ) picks A" }),
      decision({ id: "wrong", title: ("XYZ_00170 " + "X" + "XYZ_0017 XYZ_0017_suffix"), detail: "" })];
    assert.deepEqual(cardDecisions("XYZ_0017", rows).map((d) => d.id), ["d1", "detail"]);
    assert.equal(cardDecisions("", rows).length, 0);
    assert.equal(cardDecisions("DEMO_0017", rows).length, 0);
  });
  it("counts decisions once per project, including projects with no cards", () => {
    const totals = projectAttentionTotals([{ project: "demo_tasks", status: "acceptance" }, { project: "demo_tasks", status: "blocked" },
      { project: "demo_tasks", status: "running" }, { project: "DEMO", status: "done" }], [decision(), decision({ project: "no-cards" })]);
    assert.deepEqual(totals.find((x) => x.project === "demo_tasks"), { project: "demo_tasks", acceptance: 1, blocked: 1, decisions: 1 });
    assert.equal(totals.find((x) => x.project === "no-cards")?.decisions, 1);
  });
  it("explains stopped cards and omits leader requests on finished cards", () => {
    const base = { status: "acceptance", blockedReason: null, nextStep: null, returnNote: null, unattended: false, stallNote: null };
    assert.equal(cardHoldReason(base), zhCN("decisions.hold.acceptance"));
    assert.equal(cardHoldReason({ ...base, status: "blocked", blockedReason: "Wait for login" }), "Wait for login");
    assert.equal(cardHoldReason({ ...base, status: "rework", returnNote: zhCN("labels.caption.reviewReject", {"summary":"Add tests"}) }), zhCN("labels.caption.reviewReject", {"summary":"Add tests"}));
    assert.equal(cardHoldReason({ ...base, status: "ready", nextStep: zhCN("boardView.quota.headline") }), zhCN("boardView.quota.headline"));
    assert.equal(cardHoldReason({ ...base, status: "done", nextStep: "Old reason" }), null);
  });
});

describe("an unreadable source is not 'nobody is waiting'", () => {
  const task = { id: 17, project: "demo_tasks", code_seq: 17 };
  it("a missing file is certain (no decisions); a file that exists but cannot be read is uncertain", () => {
    assert.equal(readOpenDecisions(join(dir, "nope.json")).uncertain, undefined);
    writeFileSync(file, "{broken");
    assert.equal(readOpenDecisions(file).uncertain, true);
    write([]);
    assert.equal(readOpenDecisions(file).uncertain, undefined);
  });
  it("waitingOnDecision treats uncertain as waiting, and a clean read as not waiting", () => {
    writeFileSync(file, "{broken");
    assert.equal(waitingOnDecision(task, readOpenDecisions(file)), true);
    write([]);
    assert.equal(waitingOnDecision(task, readOpenDecisions(file)), false);
    assert.equal(waitingOnDecision(task, readOpenDecisions(join(dir, "nope.json"))), false);
  });
});

describe("decision card codes and notes", () => {
  it("finds distinct card codes in title, detail and notes, ignoring look-alikes", async () => {
    const { decisionCardCodes, latestComment } = await import("../shared/decisions");
    const base = { title: "abc_0017 Sample text DEMO_0070、DEMO_00701", detail: "sample TEST_0225.AB_12 Not sample DEMO_0070", userComments: [
      { at: "2026-10-01T00:00:00Z", note: "sample XYZ_0088" }, { at: "2026-10-02T00:00:00Z", note: "New" }] };
    assert.deepEqual(decisionCardCodes(base), ["ABC_0017", "DEMO_0070", "TEST_0225", "XYZ_0088"]);
    assert.equal(latestComment(base)?.note, "New");
    assert.equal(latestComment({}), null);
  });
  it("keeps the list readable when owner or notes are malformed", async () => {
    const { openDecisionSchema } = await import("../shared/decisions");
    const parsed = openDecisionSchema.parse({ id: "d", project: "p", title: "t", detail: "", blocking: false, status: "open",
      createdAt: "2026-10-01T00:00:00Z", owner: 5, userComments: [{ at: 1 }] });
    assert.equal(parsed.owner, null);
    assert.equal(parsed.userComments, undefined);
  });
});
