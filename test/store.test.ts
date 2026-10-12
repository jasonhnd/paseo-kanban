/// <reference types="node" />
import { zhCN } from "./helpers/locale";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { closeDb } from "../server/db";
import { archiveTask, blockTask, createTask, listBoard, unblockTask } from "../server/store";

const tmp = tmpdir();
mkdirSync(tmp, { recursive: true });
const dir = mkdtempSync(join(tmp, "store-"));
process.env.KANBAN_DATA_DIR = dir;

after(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe("board store", () => {
  it("creates a ready card and lists it", () => {
    const task = createTask({ project: "sandbox", title: "Edit one line", role: "executor", brief: "Only edit README", workspacePath: "/sandbox" });
    assert.equal(task.status, "ready");
    const board = listBoard();
    assert.ok(board.tasks.some((card) => card.id === task.id && card.roleLabel === zhCN("labels.role.executor")));
    assert.ok(board.projects.includes("sandbox"));
  });

  it("archives and can block then unblock", () => {
    const task = createTask({ project: "sandbox", title: "Sample text", role: "reviewer" });
    const blocked = blockTask(task.id, "needs_human", "Missing information", "test");
    assert.equal(blocked.status, "blocked");
    const restored = unblockTask(task.id, "test");
    assert.equal(restored.status, "ready");
    const archived = archiveTask(task.id, "test");
    assert.equal(archived.status, "archived");
    assert.throws(() => archiveTask(task.id, "test"));
  });
});
