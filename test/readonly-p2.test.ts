/// <reference types="node" />
import assert from "node:assert/strict";
import { after, it } from "node:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyReadonlyP2 } from "./readonly-permissions-probe";

const directory = realpathSync(mkdtempSync(join(tmpdir(), "readonly-p2-")));
after(() => rmSync(directory, { recursive: true, force: true }));
it("production hook rejects helper overrides and HOME aliases before dispatch; real guarded history/patch/read/search preserve the fixture", async () => {
  const result = await verifyReadonlyP2(join(directory, "fixture"));
  assert.equal(result.realProviderEvent, false);
  assert.equal(result.realAcpLifecycle, false);
  assert.equal(result.unchanged, true);
  assert.equal(result.cases, 204);
  assert.ok(result.allow >= 60);
  assert.ok(result.deny >= 60);
});
