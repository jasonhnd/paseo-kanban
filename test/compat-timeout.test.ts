import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, it } from "node:test";
import { realDeps } from "../server/compat";

const dir = mkdtempSync(join(tmpdir(), "kanban-compat-timeout-"));
// Two fixtures: one that never finishes by itself (exec, so the kill hits the sleeper) and one that exits at once.
const hangDir = join(dir, "hang");
const quickDir = join(dir, "quick");
for (const [bin, body] of [[hangDir, "exec sleep 60"], [quickDir, "exit 0"]] as const) {
  mkdirSync(bin);
  writeFileSync(join(bin, "npm"), `#!/bin/sh\n${body}\n`);
  chmodSync(join(bin, "npm"), 0o700);
}
const envFor = (bin: string) => ({ ...process.env, KANBAN_DATA_DIR: dir, PATH: `${bin}:${process.env.PATH}` });
const env = envFor(quickDir);
after(() => rmSync(dir, { recursive: true, force: true }));
it("keeps the mainline offline budget independent of the typecheck budget", () => {
  const deps = realDeps({ ...env, KANBAN_COMPAT_OFFLINE_TEST_TIMEOUT_MS: undefined });
  try {
    assert.equal(deps.offlineTestTimeoutMs, 600_000);
    assert.equal(deps.checkTimeoutMs, 360_000);
  } finally { deps.cleanup?.(); }
});
it("uses an explicit budget in the actual offline test child, still failing a timed-out command", async () => {
  const deps = realDeps({ ...envFor(hangDir), KANBAN_COMPAT_OFFLINE_TEST_TIMEOUT_MS: "10" });
  try {
    assert.equal(deps.offlineTestTimeoutMs, 10);
    assert.equal(deps.checkTimeoutMs, 360_000);
    assert.equal((await deps.offlineTest()).ok, false);
  } finally { deps.cleanup?.(); }
});
it("allows the complete command to finish with a longer budget", async () => {
  const deps = realDeps({ ...env, KANBAN_COMPAT_OFFLINE_TEST_TIMEOUT_MS: "60000" });
  try {
    assert.equal(deps.offlineTestTimeoutMs, 60_000);
    assert.equal(deps.checkTimeoutMs, 360_000);
    assert.equal((await deps.offlineTest()).ok, true);
  } finally { deps.cleanup?.(); }
});
