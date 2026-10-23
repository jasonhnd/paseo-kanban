import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, it } from "node:test";
import { setLanguage } from "../shared/i18n";
import { appendProtocol } from "../server/inject";
import { parseConfig, saveConfig } from "../server/config";
import { closeDb, getDb } from "../server/db";
import { approveTask, requestChanges } from "../server/flow";
import { createTask, getTask } from "../server/store";
import { setWakeSender, resetWakeSender } from "../server/bus";
import { notifyQaSignoff } from "../server/qa-review";
import { startTask } from "./helpers/compat-dispatch";
import { selectedReviewRoute } from "./helpers/selected-review";
import { seedLegacyLinkedReview } from "./helpers/legacy-review";

const root = mkdtempSync(join(tmpdir(), "qa-demo-"));
process.env.KANBAN_DATA_DIR = join(root, "data");
process.env.KANBAN_AGENTS_DIR = join(root, "agents"); mkdirSync(process.env.KANBAN_AGENTS_DIR);
const contacts = join(root, "contacts.json");
const project = "qa-demo";
const config = { autoStart: {}, supervisors: { [project]: "demo-project-leader" }, supervisorAgentId: null,
  concurrency: { global: 4, pools: {}, roles: {} }, contactsFile: contacts };
const messages: Array<{ id: string; text: string }> = [];
const spec = "Specification: docs/demo-spec.md#login";
const table = "| Item | Verdict | Evidence | Notes |\n| Login succeeds | Pass | Demo response 200 | Checked |";
beforeEach(() => {
  setLanguage("en"); getDb().prepare("UPDATE tasks SET status = 'archived'").run();
  saveConfig(config); messages.length = 0;
  setWakeSender((id, text) => { messages.push({ id, text }); });
  writeFileSync(contacts, JSON.stringify({ projects: { [project]: { sb_leader: { paseoAgentId: "demo-sb-leader" } } } }));
});
after(() => { resetWakeSender(); closeDb(); rmSync(root, { recursive: true, force: true }); });
const create = (brief = spec, tags = ["qa"]) => createTask({ project, title: "Check demo", role: "reviewer", tags, brief, workspacePath: root });
function linked() {
  const target = createTask({ project, title: "Demo delivery", role: "executor", workspacePath: root });
  const stamp = new Date().toISOString();
  getDb().prepare("UPDATE tasks SET status = 'in_review', executor_agent_id = 'demo-worker', agent_id = 'demo-worker' WHERE id = ?").run(target.id);
  getDb().prepare(`INSERT INTO runs(task_id, agent_id, role, profile_name, provider, model, family, started_at, ended_at, end_kind)
    VALUES (?, 'demo-worker', 'executor', 'Demo', 'codex', 'work-model', 'openai', ?, ?, 'complete')`).run(target.id, stamp, stamp);
  const review = seedLegacyLinkedReview({ project, title: "Demo QA", role: "reviewer", tags: ["qa"], brief: spec, reviewOf: target.id, workspacePath: root });
  getDb().prepare("UPDATE tasks SET status = 'reviewing', agent_id = 'demo-reviewer' WHERE id = ?").run(review.id);
  getDb().prepare(`INSERT INTO runs(task_id, agent_id, role, profile_name, provider, model, family, started_at)
    VALUES (?, 'demo-reviewer', 'reviewer', 'Demo', 'codex', 'review-model', 'openai', ?)`).run(review.id, stamp);
  return { target, review };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
const signoffs = () => messages.filter(message => message.text.includes("Product"));
it("injects acceptance rules for QA and leaves ordinary review rules intact in both languages", () => {
  for (const language of ["en", "zh-CN"]) {
    const request = { config: { provider: "codex", cwd: root }, env: { KANBAN_ROLE: "reviewer", KANBAN_QA: "1", KANBAN_LANGUAGE: language } };
    const text = appendProtocol(request).config.systemPrompt!;
    assert.match(text, /Google Chrome/); assert.match(text, /Edge/);
    assert.doesNotMatch(text, /git diff/); assert.match(text, /kanban_request_changes/);
    assert.match(text, /kanban_approve/);
    const normal = appendProtocol({ ...request, env: { ...request.env, KANBAN_QA: "0" } }).config.systemPrompt!;
    assert.match(normal, /git diff/); assert.doesNotMatch(normal, /Google Chrome/);
  }
});
it("rejects QA creation without a named specification, while ordinary reviews remain valid", () => {
  assert.throws(() => create("Test login"), /specification/i);
  assert.throws(() => create("Specification:   \nTest login"), /specification/i);
  assert.ok(create().id); assert.ok(create("\u89c4\u683c\u6765\u6e90\uff1adocs/demo.md \u7b2c 2 \u6761").id);
  assert.ok(create("Test login", []).id);
});
it("parses the optional contactsFile without adding a private default", () => {
  assert.equal(parseConfig(config).contactsFile, contacts);
  assert.equal(parseConfig({}).contactsFile, undefined);
  assert.equal(parseConfig({ contactsFile: 7 }).contactsFile, undefined);
});
it("sends linked QA approval to the contact once, including the specification and verdict table", async () => {
  const { target, review } = linked();
  await approveTask(review.id, table); await flush();
  assert.equal(getTask(target.id).status, "acceptance");
  assert.equal(signoffs().length, 1); assert.equal(signoffs()[0].id, "demo-sb-leader");
  assert.ok(signoffs()[0].text.includes(spec)); assert.ok(signoffs()[0].text.includes(table));
  assert.ok(signoffs()[0].text.includes(project));
  assert.ok(getTask(review.id).handoff_json?.includes("Login succeeds"));
  await assert.rejects(async () => approveTask(review.id, table)); await flush();
  notifyQaSignoff(getTask(review.id), getTask(target.id), table); await flush();
  assert.equal(signoffs().length, 1);
});
it("re-reads contacts before each approval instead of caching a recipient", async () => {
  let item = linked(); await approveTask(item.review.id, table); await flush();
  writeFileSync(contacts, JSON.stringify({ projects: { [project]: { sb_leader: { paseoAgentId: "demo-new-leader" } } } }));
  item = linked(); await approveTask(item.review.id, table); await flush();
  assert.deepEqual(signoffs().map(message => message.id), ["demo-sb-leader", "demo-new-leader"]);
});
it("falls back to the target project's registered leader and records the gap", async () => {
  for (const value of [null, "{}", "broken", JSON.stringify({ projects: { [project]: { sb_leader: {} } } })]) {
    if (value === null) rmSync(contacts, { force: true }); else writeFileSync(contacts, value);
    const { target, review } = linked();
    // The reviewed card owns the project, even when QA is filed under another one.
    getDb().prepare("UPDATE tasks SET project = 'qa-other' WHERE id = ?").run(review.id);
    await approveTask(review.id, table); await flush();
    assert.equal(signoffs().at(-1)?.id, "demo-project-leader");
    for (const id of [target.id, review.id]) {
      const comments = getDb().prepare("SELECT body FROM comments WHERE task_id = ?").all(id) as Array<{ body: string }>;
      assert.ok(comments.some(row => /second-brain leader.*project leader/i.test(row.body)));
    }
  }
});
it("returns failed specification text and evidence to the executor on request_changes", () => {
  const { target, review } = linked();
  requestChanges(review.id, "Failed item: Login succeeds", "Evidence: demo response 500");
  assert.equal(getTask(target.id).status, "rework");
  const comments = getDb().prepare("SELECT body FROM comments WHERE task_id = ?").all(target.id) as Array<{ body: string }>;
  assert.ok(comments.some(row => row.body.includes("Login succeeds") && row.body.includes("response 500")));
  assert.equal(signoffs().length, 0);
});

it("carries the QA tag through dispatch into the actual create hook", async () => {
  const { target, review } = linked();
  getDb().prepare("UPDATE tasks SET status = 'acceptance' WHERE id = ?").run(target.id);
  getDb().prepare("UPDATE tasks SET status = 'ready', agent_id = NULL WHERE id = ?").run(review.id);
  getDb().prepare("UPDATE runs SET ended_at = ?, end_kind = 'interrupted' WHERE task_id = ?").run(new Date().toISOString(), review.id);
  const profile = { id: "demo-review", name: "Demo review", role: "reviewer", provider: "codex", family: "openai", model: "review-model", pool: "demo" };
  const prompts: string[] = [];
  await startTask(review.id, { async create(input) {
    prompts.push(appendProtocol({ config: { provider: "codex", cwd: root }, env: input.env }).config.systemPrompt!);
    return { id: "demo-dispatched-reviewer" };
  }, async send() {} }, "scheduler", { profiles: [profile], chosen: profile, routing: selectedReviewRoute([profile]) });
  assert.equal(prompts.length, 1); assert.match(prompts[0], /Google Chrome/); assert.doesNotMatch(prompts[0], /git diff/);
});
it("does not send a Product signoff for ordinary reviews or held linked approvals", async () => {
  let item = linked();
  getDb().prepare("UPDATE tasks SET tags = NULL WHERE id = ?").run(item.review.id);
  await approveTask(item.review.id, table); await flush(); assert.equal(signoffs().length, 0);
  item = linked();
  getDb().prepare("UPDATE runs SET model = 'work-model' WHERE task_id = ?").run(item.review.id);
  await approveTask(item.review.id, table); await flush();
  assert.equal(getTask(item.target.id).status, "in_review"); assert.equal(signoffs().length, 0);
});
it("records an undelivered notice when the bus is not ready without pretending it was sent", async () => {
  resetWakeSender(); const { review } = linked(); await approveTask(review.id, table); await flush();
  const result = getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'qa_signoff_result'").get(review.id) as { data_json: string };
  assert.equal(JSON.parse(result.data_json).delivered, false); assert.equal(signoffs().length, 0);
});

it("deduplicates while an asynchronous notification is still in flight", async () => {
  let release!: () => void;
  setWakeSender((id, text) => {
    messages.push({ id, text });
    if (text.includes("Product")) return new Promise<void>(resolve => { release = resolve; });
  });
  const { target, review } = linked(); await approveTask(review.id, table);
  notifyQaSignoff(getTask(review.id), getTask(target.id), table);
  assert.equal(signoffs().length, 1); release(); await flush();
  const results = getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'qa_signoff_result'").all(review.id) as Array<{ data_json: string }>;
  assert.equal(results.length, 1); assert.equal(JSON.parse(results[0].data_json).delivered, true);
});
