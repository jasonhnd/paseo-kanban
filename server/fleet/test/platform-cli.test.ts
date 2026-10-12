// Commands copied without sources or node_modules must still work with only Node.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { commandInvocation, findCommand } from "../commands";
import { symlinkSync } from "node:fs";
import { platformCapabilities } from "../platform";

const plugin = resolve(import.meta.dirname, "../../..");
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "node-cli-"));
  const install = join(root, "Demo space \u6f14\u793a", "bin");
  mkdirSync(install, { recursive: true });
  for (const file of readdirSync(join(plugin, "bin"))) copyFileSync(join(plugin, "bin", file), join(install, file));
  symlinkSync(join(plugin, "node_modules"), join(install, "..", "node_modules"), "dir");
  const data = join(root, "state");
  const state = join(data, "fleet");
  mkdirSync(state, { recursive: true });
  const env = { ...process.env, HOME: root, PATH: "", AFC_DATA_DIR: "", ROLES_STATE_DIR: "",
    KANBAN_DATA_DIR: data, PASEO_HOME: join(root, "paseo"), AFC_LANGUAGE: "en" };
  const command = join(install, "afc.mjs");
  const run = (...args: string[]) => spawnSync(process.execPath, [command, ...args], { env, encoding: "utf8", timeout: 30_000 });
  return { root, state, install, command, env, run };
}

test("platform guards and native command resolution", () => {
  assert.equal(platformCapabilities("darwin").keychain, false);
  for (const platform of ["linux", "win32"] as const) assert.equal(platformCapabilities(platform).keychain, false);
  assert.equal(platformCapabilities("win32").unixProcesses, false);
  assert.equal(platformCapabilities("darwin").releaseTarget, true);
  assert.equal(platformCapabilities("linux").releaseTarget, true);
  assert.equal(platformCapabilities("win32").releaseTarget, false);
  assert.equal(findCommand("missing-demo-command", ""), null);
  assert.deepEqual(commandInvocation("demo.mjs", ["one two"]), { command: process.execPath, args: ["demo.mjs", "one two"] });
});

test("standalone commands keep decision semantics in the unified root", async () => {
  const f = fixture();
  for (const args of [["--help"], ["roles", "--help"], ["coupon", "--help"]]) {
    const result = f.run(...args); assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.trim(), `${args.join(" ")} must execute the command`);
  }
  const add = (...args: string[]) => f.run("decide", "add", "--project", "demo", "--title", "Demo decision", "--detail", "A: proceed; B: wait. Recommend: A", ...args);
  assert.equal(f.run("decide", "add", "--project", "demo", "--title", "Demo", "--detail", "Missing options").status, 1);
  const calls = Array.from({ length: 8 }, () => new Promise<number | null>((done, reject) => {
    const child = spawn(process.execPath, [f.command, "decide", "add", "--project", "demo", "--title", "Parallel demo", "--detail", "A: proceed; B: wait. Recommend: A"], { env: f.env, stdio: "ignore" });
    child.on("error", reject); child.on("exit", done);
  }));
  assert.deepEqual(await Promise.all(calls), Array(8).fill(0));
  const rows = () => JSON.parse(readFileSync(join(f.state, "decisions.json"), "utf8"));
  assert.equal(rows().length, 8); assert.equal(new Set(rows().map((row: { id: string }) => row.id)).size, 8);
  const result = add(); assert.equal(result.status, 0, result.stderr);
  const id = result.stdout.trim().split(" ")[1];
  assert.equal(f.run("decide", "comment", id, "--note", "Demo reply").status, 0);
  assert.equal(f.run("decide", "done", id, "--as", "shelved", "--note", "Demo deferred").status, 0);
  assert.equal(rows().find((row: { id: string }) => row.id === id).status, "shelved");
  assert.equal(f.run("roles", "pause", "demo").status, 0);
  assert.equal(f.run("roles", "resume", "demo").status, 0);
  // A corrupt file must be retained rather than replaced by an empty decisions list.
  const corrupt = "invalid demo JSON"; writeFileSync(join(f.state, "decisions.json"), corrupt);
  assert.equal(add().status, 1); assert.equal(readFileSync(join(f.state, "decisions.json"), "utf8"), corrupt);
});

test("non-macOS keychain adapter never starts a probe, even when enabled", () => {
  const f = fixture();
  writeFileSync(join(f.state, "afc.config.json"), JSON.stringify({ adapters: { keychain: true } }));
  const code = `Object.defineProperty(process, "platform", { value: "linux" });
    const m = await import(${JSON.stringify(join(plugin, "server/fleet/keychain-probe.ts"))});
    m.startKeychainProbe()();
    if ((await m.readKeychainAlerts()).length) throw new Error("Unexpected alerts");`;
  const result = spawnSync(process.execPath, ["--import", join(plugin, "node_modules/tsx/dist/loader.mjs"), "--input-type=module", "-e", code], { env: f.env, encoding: "utf8", timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readdirSync(f.state), ["afc.config.json"]);
});

test("retired storage overrides fail with configuration diagnostics, never migrate", () => {
  for (const entry of [null, resolve(plugin, "bin/afc.mjs")]) {
    const f = fixture();
    const command = entry ?? f.command;
    for (const variable of ["ROLES_STATE_DIR", "AFC_DATA_DIR", "AFC_LEGACY_DATA_DIR"]) {
      const result = spawnSync(process.execPath, [command, "decide", "ls"], { env: { ...f.env, [variable]: join(f.root, "old") }, encoding: "utf8" });
      assert.equal(result.status, 1);
      assert.ok(result.stderr.includes(variable), result.stderr);
      assert.equal(existsSync(join(f.state, "decisions.json")), false);
    }
    assert.notEqual(f.run("migrate", "--dry-run").status, 0);
    assert.equal(existsSync(join(f.state, "MIGRATION.json")), false);
  }
});
