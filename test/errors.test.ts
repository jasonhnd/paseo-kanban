/// <reference types="node" />
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { KanbanError } from "../server/errors";

describe("KanbanError", () => {
  it("serializes the code, message and details into the CLI error envelope", () => {
    const err = new KanbanError("bad_card", "no such card", { id: 7 });
    assert.deepEqual(err.toJSON(), { ok: false, error: "bad_card", message: "no such card", id: 7 });
  });

  it("defaults to no details and stays an Error", () => {
    const err = new KanbanError("x", "boom");
    assert.deepEqual(err.details, {});
    assert.ok(err instanceof Error);
    assert.deepEqual(JSON.parse(JSON.stringify(err)), { ok: false, error: "x", message: "boom" });
  });
});
