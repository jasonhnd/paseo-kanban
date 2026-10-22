import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, it } from "node:test";
import { setLanguage } from "../shared/i18n";
import { agentsMarkedForRelease } from "../server/archive-book";
import { cardMark } from "../server/card-ref";
import { saveConfig } from "../server/config";
import { closeDb, getDb } from "../server/db";
import { KanbanError } from "../server/errors";
import { pollAwaitingPr } from "../server/flow";
import { resetCheckCache, setGhRunner, type GhRunner } from "../server/pr";
import { loadReviewAssignments } from "../server/review-assignment";
import { appendEvent, createTask, getTask, type TaskRow } from "../server/store";
import { issueToken } from "../server/tokens";
import { handleTool } from "../server/tools";
import { seedLegacyLinkedReview } from "./helpers/legacy-review";
import { runTick } from "./helpers/compat-schedule";
import { selectedReviewRoute } from "./helpers/selected-review";

const root = mkdtempSync(join(tmpdir(), "linked-approval-"));
const work = join(root, "work"); mkdirSync(work);
process.env.KANBAN_DATA_DIR = join(root, "data");
process.env.KANBAN_AGENTS_DIR = join(root, "agents"); mkdirSync(process.env.KANBAN_AGENTS_DIR);
const project = "approval-demo";
const executor = { id: "work", name: "Demo work", role: "executor", provider: "codex", family: "openai", model: "work-model", pool: "demo" };
const reviewer = { id: "review", name: "Demo review", role: "reviewer", provider: "codex", family: "openai", model: "review-model", pool: "demo" };
const config = { autoStart: { [project]: true }, supervisors: {}, supervisorAgentId: null,
  projects: { [project]: { code: "DEMO", defaultWorkspace: "dir" as const, baseBranch: "main", alwaysTemp: false, lanesEnabled: false, worktreeLanes: 1 } },
  concurrency: { global: 10, roles: { executor: 10, reviewer: 10 }, pools: {} } };

beforeEach(() => {
  setLanguage("en");
  setGhRunner(null); resetCheckCache();
  getDb().prepare("UPDATE tasks SET status = 'archived'").run();
  saveConfig(config);
});
after(() => { setGhRunner(null); resetCheckCache(); closeDb(); rmSync(root, { recursive: true, force: true }); });

function linked(executorModel: string | null = "work-model", reviewerModel: string | null = "review-model") {
  const target = createTask({ project, title: "Submitted delivery", role: "executor", workspacePath: work });
  const worker = `worker-${target.id}`;
  const now = new Date().toISOString();
  const execution = getDb().prepare(`INSERT INTO runs(task_id, agent_id, role, profile_name, provider, model, family, started_at, ended_at, end_kind)
    VALUES (?, ?, 'executor', 'Demo work', 'codex', ?, 'openai', ?, ?, 'complete')`).run(target.id, worker, executorModel, now, now);
  getDb().prepare(`UPDATE tasks SET status = 'in_review', executor_agent_id = ?, agent_id = ?, review_round = 1,
    handoff_json = '{"summary":"Delivered","handoff":{"files":["README.md"]}}', hold_reason = 'Review scheduled', nudge_count = 2 WHERE id = ?`)
    .run(worker, worker, target.id);
  appendEvent(target.id, "complete", "running", "in_review", "executor", { summary: "Delivered" });
  // Imported linked reviews can coexist with the queued automatic reservation. Public creation remains guarded.
  const review = seedLegacyLinkedReview({ project, title: "Independent review", role: "reviewer", reviewOf: target.id, workspacePath: work });
  const agent = `reviewer-${review.id}`;
  getDb().prepare("UPDATE tasks SET status = 'reviewing', agent_id = ? WHERE id = ?").run(agent, review.id);
  const run = getDb().prepare(`INSERT INTO runs(task_id, agent_id, role, profile_name, provider, model, family, started_at)
    VALUES (?, ?, 'reviewer', 'Demo review', 'codex', ?, 'openai', ?)`).run(review.id, agent, reviewerModel, now);
  return { target: getTask(target.id), review: getTask(review.id), agent, worker, token: issueToken("reviewer", review.id, agent),
    executionRunId: Number(execution.lastInsertRowid), reviewRunId: Number(run.lastInsertRowid) };
}
type Linked = ReturnType<typeof linked>;
const approve = (item: Linked) => handleTool("kanban_approve", { summary: "Checked the delivery" }, item.token) as Promise<TaskRow>;
const verdicts = (id: number) => getDb().prepare("SELECT from_status, to_status, actor, data_json FROM events WHERE task_id = ? AND kind = 'approve'").all(id) as Array<{
  from_status: string; to_status: string; actor: string; data_json: string;
}>;
function held(item: Linked, reason: RegExp) {
  assert.equal(getTask(item.review.id).status, "acceptance");
  assert.deepEqual(getTask(item.target.id), item.target);
  assert.equal(verdicts(item.target.id).length, 0);
  for (const id of [item.review.id, item.target.id]) {
    const comment = getDb().prepare("SELECT body FROM comments WHERE task_id = ? ORDER BY id DESC LIMIT 1").get(id) as { body: string };
    assert.match(comment.body, reason);
    assert.ok(comment.body.includes(`pass ${cardMark(item.target.id)}`));
  }
}

it("advances a linked target using distinct actual models in the same family and records provenance", async () => {
  const item = linked("  Work-Model  ", " REVIEW-MODEL ");
  const result = await approve(item);
  assert.equal(result.id, item.review.id); assert.equal(result.status, "acceptance");
  const target = getTask(item.target.id);
  assert.equal(target.status, "acceptance"); assert.equal(target.hold_reason, null); assert.equal(target.nudge_count, 0);
  assert.equal(target.executor_agent_id, item.worker); assert.equal(target.agent_id, item.worker);
  assert.equal(target.review_round, 1); assert.equal(target.handoff_json, item.target.handoff_json); assert.equal(target.contract_json, item.target.contract_json);
  const [event] = verdicts(target.id);
  assert.equal(event.from_status, "in_review"); assert.equal(event.to_status, "acceptance"); assert.equal(event.actor, item.agent);
  const data = JSON.parse(event.data_json);
  assert.equal(data.reviewTaskId, item.review.id); assert.equal(data.reviewCard, cardMark(item.review.id));
  assert.equal(data.reviewerAgentId, item.agent); assert.equal(data.reviewerRunId, item.reviewRunId);
  assert.equal(data.reviewerModel, "review-model"); assert.equal(data.executorModel, "work-model"); assert.equal(data.executorRunId, item.executionRunId);
  assert.ok(agentsMarkedForRelease(target.id).includes(item.worker));
  assert.ok(agentsMarkedForRelease(item.review.id).includes(item.agent));
  assert.equal(loadReviewAssignments(target.id).get(target.id), undefined);
});

it("does not schedule another automatic review on subsequent normal scheduler ticks", async () => {
  const item = linked(); await approve(item);
  const count = () => getDb().prepare("SELECT COUNT(*) AS n FROM tasks").get()!.n;
  const before = count(); const opened: unknown[] = [];
  for (let i = 0; i < 2; i++) {
    const result = await runTick({ profiles: [executor, reviewer], config, pools: selectedReviewRoute([reviewer]).snapshot,
      launcher: { async create(input) { opened.push(input); return { id: "unexpected-review" }; }, async send() {} } });
    assert.deepEqual(result.started, []); assert.deepEqual(result.errors, []);
  }
  assert.equal(opened.length, 0); assert.equal(count(), before); assert.equal(getTask(item.target.id).status, "acceptance");
  assert.equal(verdicts(item.target.id).length, 1);
});

it("keeps normalized same-model reviews for the leader despite different providers or effort", async () => {
  const item = linked("  SAME-MODEL ", "same-model");
  getDb().prepare("UPDATE runs SET provider = 'claude', family = 'anthropic', effort = 'high' WHERE id = ?").run(item.reviewRunId);
  await approve(item); held(item, /same actual model \(same-model\)/);
});

for (const side of ["executor", "reviewer"] as const) for (const model of [null, "", "   "]) {
  it(`requires a recorded actual ${side} model (${JSON.stringify(model)}) without profile fallback`, async () => {
    const item = linked(side === "executor" ? model : "work-model", side === "reviewer" ? model : "review-model");
    getDb().prepare("UPDATE tasks SET profile_override = 'Demo review' WHERE id = ?").run(item.review.id);
    await approve(item); held(item, side === "executor" ? /actual executor model/ : /review run has no actual model/);
  });
}

for (const status of ["ready", "reviewing", "blocked", "acceptance", "done", "archived"]) {
  it(`keeps the target for the leader when another review is ${status}`, async () => {
    const item = linked();
    const other = seedLegacyLinkedReview({ project, title: "Competing review", role: "reviewer", reviewOf: item.target.id });
    getDb().prepare("UPDATE tasks SET status = ? WHERE id = ?").run(status, other.id);
    if (["acceptance", "done", "archived"].includes(status)) appendEvent(other.id, "approve", "reviewing", "acceptance", "other-reviewer", { summary: "Earlier verdict" });
    await approve(item); held(item, /Another review is active or already approved/);
    const comment = getDb().prepare("SELECT body FROM comments WHERE task_id = ? ORDER BY id DESC LIMIT 1").get(item.target.id) as { body: string };
    assert.ok(comment.body.includes(cardMark(other.id)));
  });
}

it("ignores archived unfinished reviews and finished request-changes when checking other approvals", async () => {
  const item = linked();
  for (const status of ["archived", "done"]) {
    const other = seedLegacyLinkedReview({ project, title: "Old review", role: "reviewer", reviewOf: item.target.id });
    getDb().prepare("UPDATE tasks SET status = ? WHERE id = ?").run(status, other.id);
    if (status === "done") appendEvent(other.id, "request_changes", "reviewing", "done", "reviewer", { reason: "Earlier round" });
  }
  await approve(item); assert.equal(getTask(item.target.id).status, "acceptance");
});

it("refuses a review run bound to a different agent without borrowing an older matching model", async () => {
  const item = linked();
  getDb().prepare(`INSERT INTO runs(task_id, agent_id, role, provider, model, started_at)
    VALUES (?, 'unbound-reviewer', 'reviewer', 'codex', 'another-model', ?)`).run(item.review.id, new Date().toISOString());
  await approve(item); held(item, /reviewer agent or current reviewer run/);
});

it("refuses an ambiguous executor binding", async () => {
  const item = linked();
  getDb().prepare("UPDATE tasks SET executor_agent_id = 'replacement-worker' WHERE id = ?").run(item.target.id);
  item.target = getTask(item.target.id);
  await approve(item); held(item, /execution run does not match/);
});

it("rejects a non-bound agent before recording either approval", async () => {
  const item = linked(); const stale = issueToken("reviewer", item.review.id, "unbound-reviewer");
  await assert.rejects(() => handleTool("kanban_approve", { summary: "Not assigned" }, stale), error => error instanceof KanbanError && error.code === "forbidden");
  assert.equal(getTask(item.review.id).status, "reviewing"); assert.deepEqual(getTask(item.target.id), item.target);
  assert.equal(verdicts(item.review.id).length, 0); assert.equal(verdicts(item.target.id).length, 0);
  for (const name of ["kanban_approve", "kanban_pass", "kanban_accept", "kanban_rework", "kanban_block"]) {
    await assert.rejects(() => handleTool(name, { id: item.target.id, summary: "Out of scope", note: "Out of scope", reason: "Out of scope", kind: "needs_human" }, item.token),
      error => error instanceof KanbanError && error.code === "forbidden");
  }
  assert.deepEqual(getTask(item.target.id), item.target);
});

for (const status of ["reviewing", "acceptance", "rework", "done", "blocked", "archived"] as const) {
  it(`never changes a target already in ${status}`, async () => {
    const item = linked(); getDb().prepare("UPDATE tasks SET status = ? WHERE id = ?").run(status, item.target.id);
    const before = getTask(item.target.id); await approve(item);
    assert.equal(getTask(item.review.id).status, "acceptance"); assert.deepEqual(getTask(item.target.id), before);
    assert.equal(verdicts(item.target.id).length, 0);
  });
}

it("commits the review verdict and target transition atomically", async () => {
  const item = linked();
  getDb().exec(`CREATE TRIGGER refuse_target_approval BEFORE UPDATE OF status ON tasks
    WHEN OLD.id = ${item.target.id} AND NEW.status = 'acceptance' BEGIN SELECT RAISE(ABORT, 'synthetic write failure'); END`);
  try {
    await assert.rejects(() => approve(item), /synthetic write failure/);
    assert.equal(getTask(item.review.id).status, "reviewing"); assert.deepEqual(getTask(item.target.id), item.target);
    assert.equal(verdicts(item.review.id).length, 0);
    assert.deepEqual(agentsMarkedForRelease(item.review.id), []);
  } finally { getDb().exec("DROP TRIGGER refuse_target_approval"); }
  await approve(item); assert.equal(getTask(item.target.id).status, "acceptance");
});

function githubWait(item: Linked, hook?: () => void) {
  const pr = "https://github.com/acme/widgets/pull/7";
  getDb().prepare("UPDATE tasks SET contract_json = ? WHERE id = ?").run(JSON.stringify({ kind: "github", repo: "acme/widgets", pr, awaiting: false }), item.review.id);
  let passing = false;
  const runner: GhRunner = async args => {
    const line = args.join(" ");
    if (line.startsWith("pr view")) { hook?.(); return JSON.stringify({ url: pr, headRefOid: "demo-sha", headRefName: "feature" }); }
    if (line.includes("/protection")) return JSON.stringify({ required_status_checks: { contexts: ["ci"] } });
    if (line.includes("/rules/")) return JSON.stringify([{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "ci" }] } }]);
    if (line.includes("/statuses")) return "[]";
    if (line.includes("check-runs")) return JSON.stringify({ check_runs: [{ name: "ci", status: passing ? "completed" : "in_progress", conclusion: passing ? "success" : null }] });
    throw new Error(line);
  };
  setGhRunner(runner); resetCheckCache();
  return () => { passing = true; resetCheckCache(); };
}

it("preserves bound approval provenance through pending PR checks and polling", async () => {
  const item = linked(); const pass = githubWait(item);
  assert.equal((await approve(item)).status, "reviewing"); assert.equal(getTask(item.target.id).status, "in_review");
  pass(); assert.ok((await pollAwaitingPr()).includes(item.review.id));
  assert.equal(getTask(item.target.id).status, "acceptance");
  assert.equal(JSON.parse(verdicts(item.target.id)[0].data_json).reviewerAgentId, item.agent);
});

it("rechecks competing reviews after pending checks pass", async () => {
  const item = linked(); const pass = githubWait(item); await approve(item);
  const other = seedLegacyLinkedReview({ project, title: "Review opened during checks", role: "reviewer", reviewOf: item.target.id });
  getDb().prepare("UPDATE tasks SET status = 'reviewing' WHERE id = ?").run(other.id);
  pass(); await pollAwaitingPr(); held(item, /Another review is active or already approved/);
});

it("requires a fresh verdict when the reviewer changes while checking the PR", async () => {
  const item = linked(); githubWait(item, () => getDb().prepare("UPDATE tasks SET agent_id = 'replacement-reviewer' WHERE id = ?").run(item.review.id));
  await assert.rejects(() => approve(item), error => error instanceof KanbanError && ["conflict", "forbidden"].includes(error.code));
  assert.equal(getTask(item.review.id).status, "reviewing"); assert.equal(verdicts(item.review.id).length, 0);
  assert.deepEqual(getTask(item.target.id), item.target);
});

it("does not reuse a pending verdict after reviewer reassignment", async () => {
  const item = linked(); const pass = githubWait(item); await approve(item);
  getDb().prepare("UPDATE tasks SET agent_id = 'replacement-reviewer' WHERE id = ?").run(item.review.id);
  pass(); await pollAwaitingPr();
  assert.equal(getTask(item.review.id).status, "reviewing"); assert.equal(verdicts(item.review.id).length, 0);
  assert.equal(getTask(item.target.id).status, "in_review");
  assert.equal(JSON.parse(getTask(item.review.id).contract_json!).awaiting, false);
});

it("does not apply an old pending approval to a resubmitted target delivery", async () => {
  const item = linked(); const pass = githubWait(item); await approve(item);
  appendEvent(item.target.id, "complete", "running", "in_review", "executor", { summary: "New delivery" });
  pass(); await pollAwaitingPr(); held(item, /delivery changed/);
});
