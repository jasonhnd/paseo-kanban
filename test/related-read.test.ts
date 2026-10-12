/// <reference types="node" />
import { zhCN, zhCNPart, localePattern } from "./helpers/locale";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { runKanban } from "../server/cli";
import { setProjectCode } from "../server/config";
import { closeDb, getDb } from "../server/db";
import { cardMark } from "../server/card-ref";
import { createTask } from "../server/store";
import { addComment, appendEvent } from "../server/task-record";
import { issueToken } from "../server/tokens";
import { formatResult, handleTool } from "../server/tools";

const tmp = tmpdir();
mkdirSync(tmp, { recursive: true });
const dir = mkdtempSync(join(tmp, "related-read-"));
process.env.KANBAN_DATA_DIR = dir;

after(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe("agent token read of related cards", () => {
  it("lets a card token show its parent and the card it reviews, and still forbids writes and unrelated cards", async () => {
    const grand = createTask({ project: "read", title: "Parent of parent", role: "executor", workspacePath: dir, brief: "Earlier report" });
    const parent = createTask({
      project: "read",
      title: "Reader report",
      role: "reader",
      workspacePath: dir,
      parentIds: [grand.id],
      brief: "Reader body",
    });
    const child = createTask({
      project: "read",
      title: "Decision",
      role: "decision",
      workspacePath: dir,
      parentIds: [parent.id],
    });
    const other = createTask({ project: "read", title: "Unrelated", role: "executor", workspacePath: dir });
    const reviewed = createTask({ project: "read", title: "Reviewed executor", role: "executor", workspacePath: dir, brief: "Handoff for review" });
    const review = createTask({
      project: "read",
      title: "Reviewer",
      role: "reviewer",
      workspacePath: dir,
      reviewOf: reviewed.id,
    });

    const token = issueToken("decision", child.id, "decision-agent");
    const shown = (await handleTool("kanban_show", { id: parent.id }, token)) as { id: number; title: string; brief: string };
    assert.equal(shown.id, parent.id);
    assert.equal(shown.title, "Reader report");
    assert.equal(shown.brief, "Reader body");

    const viaCli = (await runKanban(["show", String(parent.id)], { KANBAN_TOKEN: token })) as { id: number };
    assert.equal(viaCli.id, parent.id);

    const own = (await handleTool("kanban_show", { id: child.id }, token)) as { task: { id: number } };
    assert.equal(own.task.id, child.id);

    await assert.rejects(() => handleTool("kanban_show", { id: grand.id }, token), new RegExp(zhCN("tools.ownCardsOnly")));
    await assert.rejects(() => handleTool("kanban_show", { id: other.id }, token), new RegExp(zhCN("tools.ownCardsOnly")));
    await assert.rejects(() => handleTool("kanban_comment", { id: parent.id, text: "Write on parent" }, token), new RegExp(zhCN("tools.ownCardsOnly")));
    await assert.rejects(() => handleTool("kanban_complete", { id: parent.id, summary: "demo fixture" }, token), new RegExp(zhCN("tools.ownCardsOnly")));
    await assert.rejects(() => handleTool("kanban_block", { id: parent.id, kind: "needs_human", reason: "Submit for card" }, token), new RegExp(zhCN("tools.ownCardsOnly")));

    const reviewToken = issueToken("reviewer", review.id, "review-agent");
    const reviewedShown = (await handleTool("kanban_show", { id: reviewed.id }, reviewToken)) as { id: number; brief: string };
    assert.equal(reviewedShown.id, reviewed.id);
    assert.equal(reviewedShown.brief, "Handoff for review");
    const reviewCli = (await runKanban(["show", String(reviewed.id)], { KANBAN_TOKEN: reviewToken })) as { id: number };
    assert.equal(reviewCli.id, reviewed.id);

    await assert.rejects(() => handleTool("kanban_show", { id: parent.id }, reviewToken), new RegExp(zhCN("tools.ownCardsOnly")));
    await assert.rejects(() => handleTool("kanban_comment", { id: reviewed.id, text: "Write on review target" }, reviewToken), new RegExp(zhCN("tools.ownCardsOnly")));
    await assert.rejects(() => handleTool("kanban_block", { id: reviewed.id, kind: "needs_human", reason: "Submit for card" }, reviewToken), new RegExp(zhCN("tools.ownCardsOnly")));
    await assert.rejects(() => handleTool("kanban_approve", { id: reviewed.id, summary: "Previously submitted for card" }, reviewToken), new RegExp(zhCN("tools.ownCardsOnly")));
    await assert.rejects(() => handleTool("kanban_request_changes", { id: reviewed.id, reason: "Reject for card" }, reviewToken), new RegExp(zhCN("tools.ownCardsOnly")));
  });

  it("lets a card token show same-project cards named by code in its brief, not unnamed or cross-project ones", async () => {
    // TEST_0273: codes are no longer generated on the first card, and two code-less projects would both show NAM.
    setProjectCode("named-a", "NMA");
    setProjectCode("named-b", "NMB");
    const named = createTask({ project: "named-a", title: "Explicitly named", role: "executor", workspacePath: dir, brief: "Verdict here" });
    const unnamed = createTask({ project: "named-a", title: "Not named", role: "executor", workspacePath: dir });
    const foreign = createTask({ project: "named-b", title: "Sample text", role: "executor", workspacePath: dir });
    const code = cardMark(named.id);
    const foreignCode = cardMark(foreign.id);
    const own = createTask({
      project: "named-a",
      title: "Summary",
      role: "reader",
      workspacePath: dir,
      brief: `Read ${code}; also name the unrelated card ${foreignCode}`,
    });
    const token = issueToken("reader", own.id, "named-agent");

    const shown = (await handleTool("kanban_show", { id: code }, token)) as { id: number; brief: string };
    assert.equal(shown.id, named.id);
    assert.equal(shown.brief, "Verdict here");

    await assert.rejects(() => handleTool("kanban_show", { id: unnamed.id }, token), new RegExp(localePattern(zhCNPart("tools.ownCardsRead", 30, 40))));
    await assert.rejects(() => handleTool("kanban_show", { id: foreign.id }, token), new RegExp(localePattern(zhCNPart("tools.ownCardsRead", 30, 40))));
    await assert.rejects(() => handleTool("kanban_comment", { id: named.id, text: zhCNPart("missingCwd.purge.writeFailed", 0, 2) }, token), new RegExp(zhCN("tools.ownCardsOnly")));
    await assert.rejects(() => handleTool("kanban_complete", { id: named.id, summary: "demo fixture" }, token), new RegExp(zhCN("tools.ownCardsOnly")));
  });

  it("returns a whitelist view with no agent identity for related cards, and the full show for the own card", async () => {
    const AGENT = "11111111-2222-3333-4444-555555555555";
    const OTHER = "99999999-8888-7777-6666-555555555555";
    const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
    const KEYS = ["brief", "children", "code", "comments", "handoff", "id", "notice", "parents", "pr", "project", "related", "reviews", "role", "status", "tier", "title"];
    const leak = (card: { id: number }) => {
      getDb().prepare("UPDATE tasks SET agent_id = ?, executor_agent_id = ?, handoff_json = ? WHERE id = ?").run(AGENT, OTHER, JSON.stringify({ summary: "Handoff body", handoff: { files: ["a"] } }), card.id);
      getDb()
        .prepare(("INSERT INTO runs (task_id, agent_id, role, profile_name, model, started_at) VALUES (?, ?, 'executor', '" + zhCN("labels.role.executor") + "', 'm', '2026-10-03T00:00:00Z')"))
        .run(card.id, AGENT);
      appendEvent(card.id, "creator_changed", null, null, AGENT, { from: AGENT, to: OTHER });
      appendEvent(card.id, "wake", null, null, OTHER, { fallbackFrom: AGENT, agentId: OTHER });
      appendEvent(card.id, "request_changes", null, null, OTHER, { reason: "Sample text", findings: "Finding body" });
      addComment(card.id, "executor", (zhCN("labels.role.executor") + zhCN("cardDrawer.comments.title")));
      addComment(card.id, OTHER, "Unexpected author");
    };
    const parent = createTask({ project: "redact-a", title: "Parent", role: "executor", workspacePath: dir });
    const reviewed = createTask({ project: "redact-a", title: "demo fixture", role: "executor", workspacePath: dir });
    const titled = createTask({ project: "redact-a", title: "Named in title", role: "executor", workspacePath: dir });
    [parent, reviewed, titled].forEach(leak);

    const child = createTask({ project: "redact-a", title: `Summary ${cardMark(titled.id)}`, role: "reader", workspacePath: dir, parentIds: [parent.id] });
    const review = createTask({ project: "redact-a", title: "sample", role: "reviewer", workspacePath: dir, reviewOf: reviewed.id });
    const childToken = issueToken("reader", child.id, "redact-agent");
    const reviewToken = issueToken("reviewer", review.id, "redact-review");

    const check = (shown: unknown) => {
      const view = shown as Record<string, unknown> & { comments: Array<{ author: string; body: string }>; reviews: Array<{ reason: string; findings: string }>; handoff: { summary: string } };
      assert.deepEqual(Object.keys(view).sort(), KEYS);
      assert.ok(!UUID.test(JSON.stringify(view)), JSON.stringify(view));
      assert.equal(view.handoff.summary, "Handoff body");
      assert.deepEqual(view.comments.map((c) => c.author), [zhCN("labels.role.executor"), zhCN("client.panel.title")]);
      assert.equal(view.comments[0].body, (zhCN("labels.role.executor") + zhCN("cardDrawer.comments.title")));
      assert.equal(view.reviews[0].reason, "Sample text");
      assert.equal(view.reviews[0].findings, "Finding body");
    };
    check(await handleTool("kanban_show", { id: parent.id }, childToken));
    check(await handleTool("kanban_show", { id: titled.id }, childToken));
    check(await handleTool("kanban_show", { id: reviewed.id }, reviewToken));
    check(await runKanban(["show", String(titled.id)], { KANBAN_TOKEN: childToken }));

    const shownTitled = await handleTool("kanban_show", { id: titled.id }, childToken);
    const printed = formatResult(shownTitled);
    for (const part of ["Handoff body", (zhCN("labels.role.executor") + zhCN("cardDrawer.comments.title")), "Finding body", "Sample text", "request_changes", "Named in title"]) assert.ok(printed.includes(part), `${part}\n${printed}`);
    getDb().prepare("UPDATE tasks SET brief = ? WHERE id = ?").run((zhCN("cardDrawer.brief.title") + "Demo textXYZ"), titled.id);
    assert.ok(formatResult(await handleTool("kanban_show", { id: titled.id }, childToken)).includes((zhCN("cardDrawer.brief.title") + "Demo textXYZ")));

    const full = (await handleTool("kanban_show", { id: child.id }, childToken)) as Record<string, unknown>;
    assert.ok("events" in full && "runs" in full);
    await assert.rejects(() => handleTool("kanban_comment", { id: titled.id, text: zhCNPart("missingCwd.purge.writeFailed", 0, 2) }, childToken), new RegExp(zhCN("tools.ownCardsOnly")));
  });
});
