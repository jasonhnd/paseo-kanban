import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { processArguments } from "./helpers/process-arguments";

test("fixture process lookup tolerates command arguments larger than the default 1 MiB buffer", () => {
  const output = "x".repeat(2 * 1024 * 1024);
  const rows = processArguments([123], ((_command, _args, options) =>
    execFileSync(process.execPath, ["-e", "process.stdout.write('x'.repeat(2 * 1024 * 1024))"], options)) as typeof execFileSync);
  assert.deepEqual(rows, [output]);
});

test("fixture lookup selects only tracked PIDs and keeps a live sentinel when all fixtures exited", () => {
  processArguments([123, 456, 123], ((command, args, options) => {
    assert.equal(command, "/bin/ps");
    assert.deepEqual(args, ["-p", `123,456,${process.pid}`, "-o", "pid=,args="]);
    assert.equal(options?.encoding, "utf8");
    return "";
  }) as typeof execFileSync);
  assert.ok(processArguments([]).some(line => line.trim().startsWith(`${process.pid} `)));
});
