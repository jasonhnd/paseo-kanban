import { zhCNPart } from "./helpers/locale";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, it } from "node:test";
import { closeDb, getDb } from "../server/db";
import { startTask } from "./helpers/compat-dispatch";
import { completeTask, leaderPassTask, settleQuietHandoff } from "../server/flow";
import type { Profile } from "../server/profiles";
import { createTask, getTask } from "../server/store";

const dir = mkdtempSync(join(tmpdir(), "auto-review-copy-"));
process.env.KANBAN_DATA_DIR = dir;
const reviewer: Profile = { id: "review-copy", name: "Review prompt fixture", role: "reviewer", family: "anthropic", provider: "claude", model: "sonnet" };
after(() => { closeDb(); rmSync(dir, { recursive: true, force: true }); });

for (const mode of ["auto-inline", "auto-linked", "manual", "manual-after-auto"] as const) {
  it(`marks only the current automatic submission in the actual review prompt: ${mode}`, async () => {
    const cwd = join(dir, mode);
    mkdirSync(cwd);
    const source = createTask({ project: "copy", title: mode, role: "executor", workspacePath: cwd, brief: "Inspect actual changes" });
    getDb().prepare("UPDATE tasks SET status = 'running', agent_id = ?, executor_family = 'xai' WHERE id = ?").run(`executor-${source.id}`, source.id);
    getDb().prepare("INSERT INTO runs (task_id, agent_id, role, profile_name, provider, model, family, started_at) VALUES (?, ?, 'executor', 'Anonymous executor', 'grok', 'grok-4.7', 'xai', ?)")
      .run(source.id, `executor-${source.id}`, new Date().toISOString());
    if (mode !== "manual") assert.equal(settleQuietHandoff(source.id, { lastText: zhCNPart("dispatch.prompt.autoComplete", 26, 32) }), "auto_completed");
    let linked = null;
    if (mode === "auto-linked") {
      // Release inline review through a real ruling before reserving an additional review.
      leaderPassTask(source.id, "The inline review has a recorded leader ruling");
      linked = createTask({ project: "copy", title: "Independent review", role: "reviewer", workspacePath: cwd, reviewOf: source.id, brief: "Inspect actual changes" });
    }
    if (mode === "manual" || mode === "manual-after-auto") {
      getDb().prepare("UPDATE tasks SET status = 'running' WHERE id = ?").run(source.id);
      // A user-authored marker in a real handoff is not automatic provenance.
      completeTask(source.id, "executor", ("【" + zhCNPart("flow.auto.prefix", 1, 6) + "Test text for current edit"), { files: [], verification: zhCNPart("cardDrawer.verdict.approve", 2, 4), risks: [] });
    }
    const target = linked ?? getTask(source.id);
    const prompts: string[] = [];
    const result = await startTask(target.id, {
      async create(input) { prompts.push(input.prompt ?? ""); return { id: `review-${target.id}` }; },
      async send() {},
    }, "scheduler", { chosen: reviewer, profiles: [reviewer], force: true });
    assert.ok(result.agentId);
    assert.equal(getTask(target.id).status, "reviewing");
    assert.equal(prompts.length, 1);
    const isAuto = mode.startsWith("auto-");
    assert.equal(prompts[0].includes(zhCNPart("dispatch.prompt.autoComplete", 10, 52)), isAuto);
  });
}
