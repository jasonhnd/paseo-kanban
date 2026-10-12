/// <reference types="node" />
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { runKanban } from "../server/cli";
import { loadConfig, saveConfig, setProjectAutoStart, setProjectSupervisor, updateConfigFile } from "../server/config";
import { withConfigLock } from "../server/config-lock";
import { closeDb } from "../server/db";

const tmp = tmpdir();
mkdirSync(tmp, { recursive: true });
const dir = mkdtempSync(join(tmp, "config-lock-"));
process.env.KANBAN_DATA_DIR = dir;
process.env.KANBAN_AGENTS_DIR = join(dir, "agents");
mkdirSync(process.env.KANBAN_AGENTS_DIR, { recursive: true });
const project = "lock_proj";

after(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  const config = loadConfig();
  config.projects = { [project]: { code: "LCK", defaultWorkspace: "dir", baseBranch: "main", worktreeLanes: 1, lanesEnabled: false } };
  config.supervisors = {};
  config.supervisorAgentId = "kanban-boss";
  config.autoStart = {};
  saveConfig(config);
});

function child(script: string): { done: Promise<string>; output: () => string; held: Promise<void> } {
  const proc = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { env: { ...process.env, KANBAN_DATA_DIR: dir } });
  let out = "";
  let err = "";
  let markHeld: () => void = () => {};
  const held = new Promise<void>((resolve) => (markHeld = resolve));
  proc.stdout.on("data", (chunk) => {
    out += chunk;
    if (out.includes("held")) markHeld();
  });
  proc.stderr.on("data", (chunk) => (err += chunk));
  const done = new Promise<string>((resolve, reject) => proc.on("close", (status) => (status === 0 ? resolve(out) : reject(new Error(err)))));
  return { done, output: () => out, held };
}

const configModule = JSON.stringify(join(process.cwd(), "server/config.ts"));
const lockModule = JSON.stringify(join(process.cwd(), "server/config-lock.ts"));

describe("config read-modify-write", () => {
  it("many processes writing different keys at once lose no update", async () => {
    const writers = Array.from({ length: 6 }, (_, writer) =>
      child(`import { setProjectAutoStart } from ${configModule};
        for (let i = 0; i < 12; i++) setProjectAutoStart("w${writer}_" + i, i % 2 === 0);`).done,
    );
    await Promise.all(writers);
    const keys = Object.keys(loadConfig().autoStart);
    assert.equal(keys.length, 6 * 12, `lost ${6 * 12 - keys.length} updates`);
  });

  it("a writer waits for another process that holds the lock, then applies its change on top", async () => {
    const holder = child(`import { withConfigLock } from ${lockModule};
      import { setProjectAutoStart } from ${configModule};
      withConfigLock(() => { setProjectAutoStart("from_holder", true); console.log("held"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 700); });`);
    await holder.held;
    const begin = Date.now();
    setProjectAutoStart("from_parent", false);
    assert.ok(Date.now() - begin >= 350, `did not wait: ${Date.now() - begin}ms`);
    await holder.done;
    const config = loadConfig();
    assert.equal(config.autoStart.from_holder, true);
    assert.equal(config.autoStart.from_parent, false);
  });

  it("updateConfigFile and the setters share the lock", async () => {
    const holder = child(`import { withConfigLock } from ${lockModule};
      withConfigLock(() => { console.log("held"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 600); });`);
    await holder.held;
    const begin = Date.now();
    updateConfigFile((raw) => { raw.lockProbe = 1; return true; });
    assert.ok(Date.now() - begin >= 300, `updateConfigFile did not wait: ${Date.now() - begin}ms`);
    await holder.done;
    assert.equal((JSON.parse(readFileSync(join(dir, "kanban.config.json"), "utf8")) as { lockProbe?: number }).lockProbe, 1);
  });

  it("handover checks the registered <leader> and writes the new one under the lock", async () => {
    setProjectSupervisor(project, "old");
    const holder = child(`import { withConfigLock } from ${lockModule};
      withConfigLock(() => { console.log("held"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 600); });`);
    await holder.held;
    const begin = Date.now();
    await runKanban(["handover", "--project", "LCK", "--to", "new"], { PASEO_AGENT_ID: "new" });
    assert.ok(Date.now() - begin >= 300, `handover did not wait: ${Date.now() - begin}ms`);
    await holder.done;
    assert.equal(loadConfig().supervisors[project], "new");
  });

  it("two sessions racing to handover from the same <leader> end with one registered <leader> and no lost write", async () => {
    setProjectSupervisor(project, "old");
    const racers = ["racer-a", "racer-b"].map((id) =>
      child(`import { runKanban } from ${JSON.stringify(join(process.cwd(), "server/cli.ts"))};
        try { await runKanban(["handover", "--project", "LCK", "--to", "${id}"], { PASEO_AGENT_ID: "${id}", KANBAN_AGENTS_DIR: ${JSON.stringify(process.env.KANBAN_AGENTS_DIR)} }); console.log("ok"); } catch (e) { console.log("refused " + (e instanceof Error ? e.message : e)); }`).done,
    );
    const outcomes = await Promise.all(racers);
    const registered = loadConfig().supervisors[project];
    assert.ok(registered === "racer-a" || registered === "racer-b", String(registered));
    // The loser either saw the winner and was refused, or was also allowed (the winner is gone in this fixture);
    // either way the registry holds exactly one of them and the other write was not silently half-applied.
    assert.ok(outcomes.some((text) => text.includes("ok")), outcomes.join("|"));
  });

  it("is reentrant inside one process", () => {
    const seen = withConfigLock(() => withConfigLock(() => {
      setProjectAutoStart("nested", true);
      return loadConfig().autoStart.nested;
    }));
    assert.equal(seen, true);
  });

  it("releases the lock when the callback throws", () => {
    assert.throws(() => withConfigLock(() => { throw new Error("boom"); }), /boom/);
    setProjectAutoStart("after_throw", true);
    assert.equal(loadConfig().autoStart.after_throw, true);
  });
});
