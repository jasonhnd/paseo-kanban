/// <reference types="node" />
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";

it("held production command dependencies follow a changed managed installation without module reload", async () => {
  const root = mkdtempSync(join(tmpdir(), "managed-cli-path-"));
  const config = join(root, "host.json");
  const marker = join(root, "invocation.json");
  const keys = ["KANBAN_HOME", "KANBAN_PASEO_CONFIG", "KANBAN_DATA_DIR"] as const;
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const installation = (version: string) => {
    const directory = join(root, version);
    mkdirSync(join(directory, "bin"), { recursive: true });
    writeFileSync(join(directory, "bin", "roles.mjs"), `
import { writeFileSync } from "node:fs";
const result = { version: ${JSON.stringify(version)}, args: process.argv.slice(2) };
writeFileSync(${JSON.stringify(marker)}, JSON.stringify(result));
if (result.args[0] === "decide" && result.args[1] === "overturn") console.log("reopened fixture-reopened");
else if (result.args[0] === "decide" && result.args[1] === "done") console.log("fixture-decision shelved");
else console.log(JSON.stringify(result));
`);
    return directory;
  };
  const previous = installation("previous");
  const current = installation("current");
  const select = (path: string) => writeFileSync(config, JSON.stringify({ plugins: { "paseo-kanban": { path } } }));
  try {
    delete process.env.KANBAN_HOME;
    process.env.KANBAN_PASEO_CONFIG = config;
    process.env.KANBAN_DATA_DIR = join(root, "data");
    select(previous);
    // Import and hold the real production factories while the prior path is configured.
    const { productionDecideDeps } = await import("../decide-reply");
    const { productionRolesSetDeps } = await import("../roles-page");
    const { performOverturn, runDecisionMaintenance } = await import("../decisions-maint");
    const decisions = productionDecideDeps();
    const roles = productionRolesSetDeps();
    assert.equal(JSON.parse(await decisions.roles(["probe"])).version, "previous");
    assert.equal(JSON.parse((await roles.runRoles(["probe"])).stdout).version, "previous");

    select(current);
    rmSync(previous, { recursive: true });
    assert.equal(JSON.parse(await decisions.roles(["probe"])).version, "current");
    const roleOutcome = await roles.runRoles(["probe"]);
    assert.equal(roleOutcome.ok, true);
    assert.equal(JSON.parse(roleOutcome.stdout).version, "current");

    const fleet = join(root, "data", "fleet");
    mkdirSync(fleet, { recursive: true });
    const decisionsPath = join(fleet, "decisions.json");
    const kanbanConfigPath = join(root, "board.json");
    writeFileSync(decisionsPath, "[]\n");
    writeFileSync(kanbanConfigPath, "{}\n");
    const notify = () => { throw new Error("No fixture leader may be notified"); };
    const overturned = await performOverturn({ id: "fixture-decision", decisionsPath, kanbanConfigPath, notify });
    assert.equal(overturned.ok, true);
    assert.equal(JSON.parse(readFileSync(marker, "utf8")).version, "current");

    writeFileSync(decisionsPath, JSON.stringify([{ id: "fixture-decision", project: "fixture", title: "Fixture", status: "open", createdAt: "2020-01-01T00:00:00.000Z" }]));
    await runDecisionMaintenance({ paths: { decisionsPath, kanbanConfigPath, statePath: join(fleet, "maint.json"), logPath: join(fleet, "maint.log") }, now: Date.parse("2020-01-10T00:00:00.000Z"), notify });
    const invocation = JSON.parse(readFileSync(marker, "utf8"));
    assert.equal(invocation.version, "current");
    assert.deepEqual(invocation.args.slice(0, 3), ["decide", "done", "fixture-decision"]);
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    rmSync(root, { recursive: true, force: true });
  }
});
