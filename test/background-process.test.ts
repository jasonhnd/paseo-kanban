/// <reference types="node" />
import assert from "node:assert/strict";
import { it } from "node:test";
import { backgroundProcessStatus, backgroundProcesses, authorizeBackgroundProcess, sameBackgroundProcess, type BackgroundProcess } from "../server/background-process";

const row = (pid: number, ppid: number, patch: Partial<BackgroundProcess> = {}): BackgroundProcess => ({
  pid, ppid, pgid: pid, session: "0", uid: 501, started: "Thu Oct 22 00:00:00 2026", state: "S", ...patch,
});

it("accepts detached descendants or a verified shared session, but rejects forged process associations", () => {
  const caller = row(20, 1);
  const child = row(30, 20);
  const grandchild = row(40, 30);
  assert.equal(authorizeBackgroundProcess(40, 20, 501, [caller, child, grandchild]), grandchild);
  for (const target of [row(50, 1), row(50, 20, { uid: 502 }), row(50, 20, { state: "Z" }), row(50, 50)]) {
    assert.throws(() => authorizeBackgroundProcess(50, 20, 501, [caller, target]));
  }
  assert.throws(() => authorizeBackgroundProcess(20, 20, 501, [caller]));
  assert.throws(() => authorizeBackgroundProcess(30, 20, 501, [child]));
  assert.throws(() => authorizeBackgroundProcess(40, 20, 502, [caller, child, grandchild]));
  const sessionCaller = row(20, 1, { session: "20" });
  const peer = row(50, 1, { session: "20" });
  assert.equal(authorizeBackgroundProcess(50, 20, 501, [sessionCaller, peer]), peer);
  assert.throws(() => authorizeBackgroundProcess(50, 20, 501, [sessionCaller, { ...peer, session: "21" }]));
});

it("does not treat a zombie, reused PID or surviving unrelated group member as the tracked writer", () => {
  const original = row(30, 20);
  assert.equal(sameBackgroundProcess(original, [{ ...original }]), true);
  for (const rows of [[], [row(31, 20, { pgid: 30 })], [{ ...original, started: "another start" }],
    [{ ...original, state: "Z" }], [{ ...original, uid: 502 }]]) {
    assert.equal(sameBackgroundProcess(original, rows), false);
  }
});

it("rejects incomplete or malformed ps snapshots instead of reporting missing processes", () => {
  for (const output of ["", "bad row", "30 20 30 0 501 not-a-date S", "30 20 30 0 501 Thu Oct 22 00:00:00 2026 @"]) {
    assert.throws(() => backgroundProcesses(() => output));
  }
  assert.deepEqual(backgroundProcesses(() => "30 20 30 0 501 Thu Oct 22 00:00:00 2026 S"), [row(30, 20)]);
  assert.equal(backgroundProcesses(() => "30 20 30 0 501 Thu Oct 22 00:00:00 2026 ?")[0].state, "?");
});

it("accepts the macOS over-soft-memory-limit STAT modifier for parsing and registration", () => {
  const rows = backgroundProcesses(() => [
    "20 1 20 0 501 Thu Oct 22 00:00:00 2026 S",
    "30 20 30 0 501 Thu Oct 22 00:00:00 2026 S>",
  ].join("\n"));
  assert.equal(rows[1].state, "S>");
  assert.equal(authorizeBackgroundProcess(30, 20, 501, rows), rows[1]);
});

it("parses snapshots larger than 1 MiB and preserves unknown on buffer or read failures", () => {
  const line = "30 20 30 0 501 Thu Oct 22 00:00:00 2026 S\n";
  const count = 30_000;
  assert.ok(Buffer.byteLength(line.repeat(count)) > 1024 * 1024);
  assert.equal(backgroundProcesses(() => line.repeat(count)).length, count);
  for (const code of ["ENOBUFS", "ETIMEDOUT", "EACCES"]) {
    assert.equal(backgroundProcessStatus(row(30, 20), () => {
      throw Object.assign(new Error("snapshot unavailable"), { code });
    }), "unknown");
  }
});
