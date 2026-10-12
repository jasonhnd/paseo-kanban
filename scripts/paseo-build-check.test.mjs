import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { COMPILER_IN_PACKAGE, locateCompiler } from "./paseo-build-check.mjs";

const SCRIPT = fileURLToPath(new URL("./paseo-build-check.mjs", import.meta.url));
const dir = realpathSync(mkdtempSync(join(tmpdir(), "compiler-gate-test-")));
after(() => rmSync(dir, { recursive: true, force: true }));
const plugin = join(dir, "plugin");
mkdirSync(plugin);
writeFileSync(join(plugin, "index.server.ts"), "export default {};\n");
writeFileSync(join(dir, "good.mjs"), "export async function compilePlugin() { return { serverBundle: 'code' }; }\n");
writeFileSync(join(dir, "bad.mjs"), "export async function compilePlugin() { throw new Error('shared bundle rejected node import'); }\n");
const run = (compiler, ...args) => spawnSync(process.execPath, [SCRIPT, "--plugin", plugin, ...args], {
  env: { ...process.env, PASEO_PLUGIN_COMPILER: join(dir, compiler) }, encoding: "utf8",
});

test("compiler lookup prefers local compiler; invalid explicit override never falls back", () => {
  const compiler = join(plugin, "node_modules", ...COMPILER_IN_PACKAGE);
  assert.equal(locateCompiler({ pluginDir: plugin, env: {}, exists: path => path === compiler }).source, "node_modules");
  assert.match(locateCompiler({ pluginDir: plugin, env: { PASEO_PLUGIN_COMPILER: "missing" }, exists: () => false }).skip, /set but unusable/);
});

test("a standalone server supplies the real compiler without an app on Linux", () => {
  const server = join(dir, "standalone");
  const compiler = join(server, ...COMPILER_IN_PACKAGE.slice(2));
  const found = locateCompiler({ pluginDir: plugin, platform: "linux", env: { PASEO_SERVER_DIR: server }, exists: path => path === compiler });
  assert.equal(found.compiler, compiler);
  assert.equal(found.command, process.execPath);
  assert.equal(found.source, "PASEO_SERVER_DIR");
  assert.match(locateCompiler({ pluginDir: plugin, platform: "linux", env: { PASEO_SERVER_DIR: server }, exists: () => false }).skip, /set but unusable/);
});

test("real compiler errors propagate and verify's strict lookup fails when unavailable", () => {
  const good = run("good.mjs", "--strict");
  assert.equal(good.status, 0, good.stderr + good.stdout);
  assert.match(good.stdout, /passed: .*server 4 bytes/);
  const bad = run("bad.mjs", "--strict");
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /shared bundle rejected node import/);
  assert.equal(run("missing.mjs", "--strict").status, 2);
  assert.equal(run("missing.mjs").status, 0);
});
