/// <reference types="node" />
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, symlinkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { commandInvocation } from "../server/command-invocation";

test("standalone Node commands handle an install path that contains a space", () => {
  const root = mkdtempSync(join(tmpdir(), "node-cli-"));
  const install = join(root, "Demo space");
  const bin = join(install, "bin");
  mkdirSync(install, { recursive: true });
  symlinkSync(resolve(import.meta.dirname, "../node_modules"), join(install, "node_modules"), "dir");
  mkdirSync(bin, { recursive: true });
  const source = resolve(import.meta.dirname, "../bin");
  const names = readdirSync(source).filter((name) => name.endsWith(".bundle.mjs") || name === "paseo-kanban.mjs");
  assert.ok(names.some((name) => name.endsWith(".bundle.mjs")), "CLI bundles are missing; run npm run build first");
  for (const file of names) copyFileSync(join(source, file), join(bin, file));
  cpSync(resolve(import.meta.dirname, "../server/protocol"), join(install, "server", "protocol"), { recursive: true });
  const env = {
    ...process.env,
    HOME: root,
    PATH: "",
    PASEO_AGENT_ID: "",
    KANBAN_TOKEN: "",
    PASEO_HOME: join(root, "paseo"),
    KANBAN_HOME: install,
    KANBAN_PROJECT_ROOT: install,
    KANBAN_DATA_DIR: join(root, "board"),
    AFC_DATA_DIR: "",
    ROLES_STATE_DIR: "",
  };
  const run = (...args: string[]) => spawnSync(process.execPath, [join(bin, "paseo-kanban.mjs"), ...args], { env, encoding: "utf8", timeout: 20_000 });
  for (const args of [["--help"], ["decide", "--help"], ["migrate", "--help"]]) {
    const result = run(...args);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.length > 0);
  }
  const list = run("list", "--json");
  assert.equal(list.status, 0, list.stderr);
  assert.deepEqual(JSON.parse(list.stdout), { projects: [], tasks: [] });
  const add = run("decide", "add", "--project", "demo", "--title", "Demo decision", "--detail", "A: proceed; B: wait. Recommend: A", "--json");
  assert.equal(add.status, 0, add.stderr);
  const listed = run("decide", "ls", "--json");
  assert.equal(listed.status, 0, listed.stderr);
  assert.equal(JSON.parse(listed.stdout).items.length, 1);
  assert.ok(readFileSync(join(root, "board", "kanban-decisions.json"), "utf8").includes("Demo decision"));
  assert.deepEqual(commandInvocation("demo.mjs", ["one two"]), { command: process.execPath, args: ["demo.mjs", "one two"] });
});
