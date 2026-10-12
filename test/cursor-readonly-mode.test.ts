/// <reference types="node" />
import { zhCN, zhCNPart, localePattern } from "./helpers/locale";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { closeDb } from "../server/db";
import { type AgentLauncher } from "../server/dispatch";
import { startTask } from "./helpers/compat-dispatch";
import type { Profile } from "../server/profiles";
import { cursorReadonlyReason } from "../server/routing";
import { createTask, getTask } from "../server/store";

const tmp = tmpdir();
mkdirSync(tmp, { recursive: true });
const dir = mkdtempSync(join(tmp, "cursor-readonly-"));
process.env.KANBAN_DATA_DIR = dir;
process.env.KANBAN_POOL_STATUS = join(dir, "no-such-pools.json");

const cursorExec: Profile = {
  id: "ex",
  name: "Executor · Cursor",
  role: "executor",
  family: "xai",
  provider: "cursor",
  model: "grok-4.7",
  modeId: "agent",
  pool: "cursor",
  featureValues: { auto_accept: true },
};
const claudeReview: Profile = {
  id: "rv",
  name: zhCN("labels.role.reviewer"),
  role: "reviewer",
  family: "anthropic",
  provider: "claude",
  model: "sonnet",
  modeId: "default",
  pool: "claude-max",
};
const cursorReview: Profile = {
  id: "crv",
  name: "Reviewer · GrokSample textCursorSample text",
  role: "reviewer",
  family: "xai",
  provider: "cursor",
  model: "grok-4.7",
  modeId: "agent",
  pool: "cursor",
};

function room(name: string): string {
  const path = join(dir, name);
  mkdirSync(path, { recursive: true });
  return path;
}

function launcher(): { api: AgentLauncher; configs: Array<Parameters<AgentLauncher["create"]>[0]> } {
  const configs: Array<Parameters<AgentLauncher["create"]>[0]> = [];
  const api: AgentLauncher = {
    async create(options) {
      configs.push(options);
      return { id: `agent-${configs.length}` };
    },
    async send() {},
  };
  return { api, configs };
}

after(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe("Cursor read-only dispatch", () => {
  it("keeps a Cursor executor on agent mode and does not rewrite a Claude reviewer's mode", async () => {
    const exec = launcher();
    const worker = createTask({ project: "cursor-ro", title: "Executor", role: "executor", workspacePath: room("exec") });
    await startTask(worker.id, exec.api, "test", { profiles: [cursorExec, claudeReview] });
    assert.equal(exec.configs.length, 1);
    assert.equal(exec.configs[0]?.config.modeId, "agent");
    assert.equal(exec.configs[0]?.config.provider, "cursor/grok-4.7");
    assert.equal(exec.configs[0]?.config.featureValues?.auto_accept, true);

    const review = launcher();
    const card = createTask({ project: "cursor-ro", title: "Reviewer", role: "reviewer", workspacePath: room("review") });
    await startTask(card.id, review.api, "test", { profiles: [claudeReview, cursorReview] });
    assert.equal(review.configs.length, 1);
    assert.equal(review.configs[0]?.config.modeId, "default");
    assert.equal(review.configs[0]?.config.provider, "claude/sonnet");
    assert.equal(getTask(card.id).status, "reviewing");
  });

  it("does not open an agent when the only reviewer is Cursor", async () => {
    const box = launcher();
    const card = createTask({ project: "cursor-ro", title: "Sample text Cursor Sample text", role: "reviewer", workspacePath: room("blocked") });
    const result = await startTask(card.id, box.api, "test", { profiles: [cursorReview] });
    assert.equal(box.configs.length, 0);
    assert.match(result.message, new RegExp(cursorReadonlyReason().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    const row = getTask(card.id);
    assert.equal(row.status, "blocked");
    assert.equal(row.blocked_kind, "needs_human");
    assert.match(row.blocked_reason ?? "", new RegExp("Cursor " + localePattern(zhCNPart("routing.cursorReadonly", 7, 15))));
  });
});
