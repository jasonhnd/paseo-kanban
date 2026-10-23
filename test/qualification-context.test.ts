import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, it } from "node:test";
import { closeDb } from "../server/db";
import { appendEvent, createTask, getTask } from "../server/store";
import { parseConfig, saveConfig, loadConfig, setProjectWorkspace } from "../server/config";
import { qualificationForNewAgent, qualificationReworkCount } from "../server/qualification";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qualification-"));
  process.env.KANBAN_DATA_DIR = dir;
  mkdirSync(join(dir, "work"));
});
afterEach(() => { closeDb(); rmSync(dir, { recursive: true, force: true }); });
const task = (extra = {}) => createTask({ project: "demo", role: "executor", title: "Change code", brief: "Implement a function", workspacePath: join(dir, "work"), tier: "L4", ...extra });
const config = () => parseConfig({});

it("counts review returns and leader rework rather than review-round or run totals", () => {
  const card = task();
  appendEvent(card.id, "started", "ready", "running", "scheduler", {});
  appendEvent(card.id, "request_changes", "reviewing", "rework", "reviewer", {});
  appendEvent(card.id, "resumed", "rework", "running", "scheduler", {});
  appendEvent(card.id, "leader_rework", "acceptance", "ready", "supervisor", { countRound: false });
  appendEvent(card.id, "land_conflict", "acceptance", "rework", "supervisor", {});
  appendEvent(card.id, "request_changes", "reviewing", "done", "reviewer", {});
  appendEvent(task().id, "request_changes", "reviewing", "rework", "reviewer", {});
  assert.equal(qualificationReworkCount(card.id), 2);
  assert.deepEqual(qualificationForNewAgent(getTask(card.id), false, config()).map(row => row.effort), ["xhigh"]);
});

it("normalizes operational tags with the existing code/ops precedence", () => {
  const coded = task({ title: "Deploy a compiler", tags: ["hard-code"] });
  assert.ok(qualificationForNewAgent(coded, false, config()).every(row => row.model === "gpt-6.1-sol"));
  const ops = task({ title: "Deploy a compiler", tags: ["hard-code", "deploy", "needs-max"], effort: "max" });
  assert.ok(qualificationForNewAgent(ops, false, config()).every(row => row.effort === "low"));
});

it("authorizes max only for the card's own role and never inherits executor max into review", () => {
  const card = task({ tags: ["needs-max"] });
  assert.deepEqual(qualificationForNewAgent(card, false, config()).map(row => row.effort), ["max"]);
  assert.ok(qualificationForNewAgent(card, true, config()).every(row => row.effort !== "max"));
  const ownReview = task({ role: "reviewer", effort: "max" });
  assert.ok(qualificationForNewAgent(ownReview, false, config()).some(row => row.effort === "max"));
});

it("reads project policy and retains it through workspace settings writes", () => {
  const card = task();
  const settings = parseConfig({ qualification: { executor: { L4: [] } }, projects: {
    demo: { defaultWorkspace: "dir", qualification: { executor: { L4: [{ provider: "codex", model: "gpt-6.1-sol", efforts: ["xhigh"] }] } } },
  } });
  saveConfig(settings);
  setProjectWorkspace("demo", { baseBranch: "preview" });
  const updated = loadConfig();
  assert.deepEqual(updated.projects?.demo.qualification, settings.projects?.demo.qualification);
  assert.deepEqual(qualificationForNewAgent(card, false, updated), [{ provider: "codex", model: "gpt-6.1-sol", effort: "xhigh" }]);
});

it("honors a standalone review's own needs-max without affecting an automatic review", () => {
  const ownReview = task({ role: "reviewer", tags: ["needs-max"] });
  assert.ok(qualificationForNewAgent(ownReview, false, config()).some(row => row.effort === "max"));
  assert.ok(qualificationForNewAgent(ownReview, true, config()).every(row => row.effort !== "max"));
});

it("uses the router's matrix default when the card has no stored tier", () => {
  const card = task({ tier: null });
  assert.ok(qualificationForNewAgent(card, false, config(), "L4").every(row => row.model === "gpt-6.1-sol" && ["high", "xhigh"].includes(row.effort)));
});


it("counts acceptance rejection as rework and ignores conflict/bookkeeping events", () => {
  const card = task({ effort: "high" });
  appendEvent(card.id, "land_conflict", "acceptance", "rework", "supervisor", {});
  appendEvent(card.id, "rejected", "acceptance", "done", "supervisor", {});
  assert.equal(qualificationReworkCount(card.id), 0);
  appendEvent(card.id, "rejected", "acceptance", "rework", "supervisor", {});
  assert.equal(qualificationReworkCount(card.id), 1);
  assert.deepEqual(qualificationForNewAgent(card, false, config()).map(row => row.effort), ["xhigh"]);
});

it("starts automatic reviews at their own minimum after executor returns", () => {
  const card = task({ effort: "high" });
  const fresh = qualificationForNewAgent(card, true, config());
  appendEvent(card.id, "request_changes", "reviewing", "rework", "reviewer", {});
  appendEvent(card.id, "leader_rework", "acceptance", "ready", "supervisor", { countRound: false });
  assert.deepEqual(qualificationForNewAgent(card, false, config()).map(row => row.effort), ["xhigh"]);
  assert.deepEqual(qualificationForNewAgent(card, true, config()), fresh);
  const standalone = task({ role: "reviewer", effort: "high" });
  appendEvent(standalone.id, "leader_rework", "acceptance", "ready", "supervisor", {});
  assert.deepEqual(qualificationForNewAgent(standalone, false, config()).filter(row => row.model === "gpt-6.1-sol").map(row => row.effort), ["xhigh"]);
});
