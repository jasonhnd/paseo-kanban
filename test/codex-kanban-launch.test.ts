/// <reference types="node" />
import { BOARD_AGENT_ENV } from "../server/agent-env";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

const wrapper = resolve(dirname(fileURLToPath(import.meta.url)), "../bin/codex-kanban-launch");
const dir = mkdtempSync(join(tmpdir(), "codex-wrapper-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const realDir = join(dir, "real codex");
mkdirSync(realDir);
const real = join(realDir, "codex");
writeFileSync(real, '#!/bin/sh\nprintf "%s\\000" "$@"\nexit "${FAKE_CODEX_EXIT:-0}"\n');
chmodSync(real, 0o755);
const aliasDir = join(dir, "wrapper aliases");
mkdirSync(aliasDir);
symlinkSync(wrapper, join(aliasDir, "codex"));
const hardlinkDir = join(dir, "hardlink");
mkdirSync(hardlinkDir);
linkSync(wrapper, join(hardlinkDir, "codex"));

function run(args: string[], env: Record<string, string> = {}) {
  return spawnSync(wrapper, args, {
    env: { PATH: realDir, ...env }, encoding: "utf8", timeout: 3_000,
  });
}
function argv(output: string) {
  return output === "" ? [] : output.split("\0").slice(0, -1);
}
const overrides = ["-c", "memories.generate_memories=false", "-c", "features.memories=false"];

describe("Codex board launch wrapper", () => {
  it("prepends both overrides for every board role and preserves argv exactly", () => {
    const args = ["app-server", "--enable", "goals", "with spaces", "", "line\nbreak", 'quote"and\'dollar$'];
    for (const role of ["executor", "reviewer", "reader", "decision", "batch"]) {
      const result = run(args, { [BOARD_AGENT_ENV]: "1", KANBAN_ROLE: role });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(argv(result.stdout), [...overrides, ...args], role);
    }
  });

  it("passes unmarked and non-board invocations through without overrides", () => {
    const args = ["app-server", "--enable", "goals", "", "a b"];
    for (const mark of [undefined, "", "0", "true"]) {
      const result = run(args, mark === undefined ? {} : { [BOARD_AGENT_ENV]: mark });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(argv(result.stdout), args);
    }
  });

  it("prefers KANBAN_REAL_CODEX over PATH and accepts paths with spaces", () => {
    const result = run(["--version"], { PATH: aliasDir, KANBAN_REAL_CODEX: real });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(argv(result.stdout), ["--version"]);
  });

  it("finds an explicit executable name and skips the wrapper's PATH aliases", () => {
    const result = run(["app-server"], { PATH: `${aliasDir}:${hardlinkDir}:${realDir}`, KANBAN_REAL_CODEX: "codex" });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(argv(result.stdout), ["app-server"]);
  });

  it("skips symlink and hardlink aliases when finding codex on PATH", () => {
    const result = run(["app-server"], { PATH: `${aliasDir}:${hardlinkDir}:${realDir}` });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(argv(result.stdout), ["app-server"]);
  });

  it("fails clearly when only itself or no codex exists, without recursion", () => {
    for (const path of [aliasDir, `${aliasDir}:${hardlinkDir}`, join(dir, "missing")]) {
      const result = run([], { PATH: path });
      assert.equal(result.status, 127, result.stderr);
      assert.match(result.stderr, /real codex not found/);
      assert.equal(result.error, undefined);
    }
  });

  it("refuses explicit self aliases and an invalid override without falling back", () => {
    for (const path of [wrapper, join(aliasDir, "codex"), join(hardlinkDir, "codex"), join(dir, "missing")]) {
      const result = run([], { KANBAN_REAL_CODEX: path });
      assert.equal(result.status, 127, result.stderr);
      assert.match(result.stderr, /recursive launch refused|not an executable file/);
      assert.equal(result.error, undefined);
    }
  });

  it("preserves codex's exit status through exec", () => {
    assert.equal(run(["app-server"], { FAKE_CODEX_EXIT: "23" }).status, 23);
  });

  it("logs only the final argv with lossless invocation framing", () => {
    const log = join(dir, "argv.log");
    const args = ["app-server", "", "line\nbreak"];
    const result = run(args, { [BOARD_AGENT_ENV]: "1", KANBAN_CODEX_WRAPPER_LOG: log, PRIVATE_TEST_VALUE: "must-not-appear" });
    assert.equal(result.status, 0, result.stderr);
    const record = readFileSync(log, "utf8");
    assert.deepEqual(argv(record), [String(args.length + overrides.length), ...overrides, ...args]);
    assert.doesNotMatch(record, /must-not-appear|PRIVATE_TEST_VALUE/);
    assert.ok(!record.includes(BOARD_AGENT_ENV));
  });
});
