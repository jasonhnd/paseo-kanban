/// <reference types="node" />
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import { SUBPROCESS_TIMEOUT_MS } from "./helpers/subprocess-timeout";

it("mounts the actual server board/detail handlers in a synthetic offline home", async (t) => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = await new Promise<{ code: number; output: string }>(resolve => {
    execFile(process.execPath, ["--experimental-test-module-mocks", "--import", "tsx", "--test", "--test-reporter=tap",
      fileURLToPath(new URL("./acceptance-review-board-worker.ts", import.meta.url))],
    { env, timeout: SUBPROCESS_TIMEOUT_MS }, (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, output: stdout + stderr }));
  });
  t.diagnostic(result.output);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /# tests 1\b/); assert.match(result.output, /# pass 1\b/); assert.match(result.output, /# fail 0\b/);
});
