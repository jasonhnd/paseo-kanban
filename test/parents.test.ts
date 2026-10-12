/// <reference types="node" />
import { zhCN } from "./helpers/locale";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { parentIdsFromArgs, parentIdsFromFlags, parseKanbanArgs } from "../server/argv";
import { closeDb, getDb } from "../server/db";
import { createTask, getDetail } from "../server/store";
import { handleTool } from "../server/tools";
import { issueToken } from "../server/tokens";
import { setProjectCode } from "../server/config";

const tmp = tmpdir();
mkdirSync(tmp, { recursive: true });
const dir = mkdtempSync(join(tmp, "parents-"));
process.env.KANBAN_DATA_DIR = dir;

after(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe("create --parents", () => {
  it("reads --parents and keeps the new card waiting on an unfinished parent", async () => {
    // TEST_0273: a card no longer configures its project by writing a short code; configure it first.
    setProjectCode("sandbox", "SAN");
    const parent = createTask({ project: "sandbox", title: "Parent", role: "executor" });
    const parsed = parseKanbanArgs(["create", "--project", "sandbox", "--title", zhCN("cardDrawer.links.child"), "--role", "executor", "--parents", String(parent.id)]);
    assert.deepEqual(parentIdsFromFlags(parsed), [parent.id]);
    assert.deepEqual(parentIdsFromFlags(parseKanbanArgs(["create", "--parent", String(parent.id)])), [parent.id]);
    assert.deepEqual(parentIdsFromArgs(String(parent.id)), [parent.id]);

    const supervisor = issueToken("supervisor", null, null);
    const created = (await handleTool(
      "kanban_create",
      { project: "sandbox", title: "Child", role: "executor", parents: parentIdsFromFlags(parsed) },
      supervisor,
    )) as { id: number; status: string };
    assert.equal(created.status, "waiting");
    const detail = getDetail(created.id);
    assert.equal(detail.parents.length, 1);
    assert.equal(detail.parents[0].id, parent.id);
    const event = getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'created'").get(created.id) as { data_json: string };
    assert.deepEqual(JSON.parse(event.data_json).parents, [parent.id]);
  });

  it("accepts repeated and comma-separated parent ids", () => {
    assert.deepEqual(parentIdsFromFlags(parseKanbanArgs(["create", "--parents", "11", "--parents", "12"])), [11, 12]);
    assert.deepEqual(parentIdsFromFlags(parseKanbanArgs(["create", "--parents=11,12"])), [11, 12]);
  });
});
