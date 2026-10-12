import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveClaude, sessionTree } from "../coupon-cli";

function commands() {
  const path = mkdtempSync(join(tmpdir(), "demo commands \u6f14\u793a-"));
  for (const name of ["claude", "pgrep"]) {
    const file = join(path, name);
    writeFileSync(file, "#!/bin/sh\nexit 0\n");
    chmodSync(file, 0o755);
  }
  return path;
}

test("coupon discovers Claude on a supplied PATH without which", () => {
  const path = commands();
  assert.equal(resolveClaude(path), join(path, "claude"));
  assert.equal(resolveClaude(""), null);
});

test("coupon uses the discovered pgrep for every descendant query", async () => {
  const path = commands();
  const calls: Array<{ command: string; args: string[] }> = [];
  const tree = await sessionTree(path, async (command, args) => {
    calls.push({ command, args });
    if (args[0] === "-ls") return "101.afc-coupon-claude (Detached)";
    assert.equal(command, join(path, "pgrep"));
    return args[1] === "101" ? "102\n" : "";
  });
  assert.deepEqual(tree, [101, 102]);
  assert.deepEqual(calls.slice(1).map(call => call.args), [["-P", "101"], ["-P", "102"]]);
});

test("missing pgrep fails before opening or inspecting a screen", async () => {
  let inspected = false;
  await assert.rejects(sessionTree("", async () => { inspected = true; return ""; }), /pgrep/);
  assert.equal(inspected, false);
});
