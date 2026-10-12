import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = await mkdtemp(join(tmpdir(), "afc-record-files-"));
process.env.PASEO_HOME = join(home, "daemon");
process.env.KANBAN_PASEO_CONFIG = join(process.env.PASEO_HOME!, "config.json");
process.env.KANBAN_DATA_DIR = join(home, "data");

const { readAgentRecordFiles } = await import("../records");

test("a fresh daemon has an empty record list without an error", async (context) => {
  const logged = context.mock.method(console, "error", () => {});
  assert.deepEqual(await readAgentRecordFiles(home), []);
  assert.equal(logged.mock.callCount(), 0);
});

test("a damaged records path still reports an error", async (context) => {
  const logged = context.mock.method(console, "error", () => {});
  try {
    await writeFile(join(home, "agents"), "invalid directory");
    assert.equal(await readAgentRecordFiles(home), null);
    assert.equal(logged.mock.callCount(), 1);
    assert.match(String(logged.mock.calls[0].arguments[0]), /cannot read/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
