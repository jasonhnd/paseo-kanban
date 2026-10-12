// scripts/paseo-build-check.mjs: compiler lookup, and the check end to end against a stand-in
// compiler (the real one ships with Paseo and is exercised by `npm run build:check`).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

type Located = { compiler?: string; command?: string; env?: Record<string, string>; source?: string; skip?: string };
type BuildCheck = {
  COMPILER_IN_PACKAGE: string[];
  locateCompiler(options: { pluginDir?: string; env?: Record<string, string>; home?: string; platform?: string; exists?: (path: string) => boolean }): Located;
};

const script = fileURLToPath(new URL("../scripts/paseo-build-check.mjs", import.meta.url));
const runner = fileURLToPath(new URL("../scripts/paseo-compile-runner.mjs", import.meta.url));
const { COMPILER_IN_PACKAGE, locateCompiler } = (await import(new URL("../scripts/paseo-build-check.mjs", import.meta.url).href)) as BuildCheck;

const only = (...paths: string[]) => (path: string) => paths.includes(path);

describe("locateCompiler", () => {
  test("skips with every place it tried when no compiler exists", () => {
    const found = locateCompiler({ pluginDir: "/srv/plugin", env: { PATH: "" }, home: "/home/demo", platform: "linux", exists: () => false });
    assert.equal(found.compiler, undefined);
    assert.match(found.skip ?? "", /no Paseo plugin compiler found/);
    assert.match(found.skip ?? "", /node_modules/);
  });

  test("prefers the plugin's own @getpaseo/server under plain Node", () => {
    const local = join("/srv/plugin", "node_modules", ...COMPILER_IN_PACKAGE);
    const found = locateCompiler({ pluginDir: "/srv/plugin", env: { PATH: "" }, platform: "linux", exists: only(local) });
    assert.deepEqual(found, { compiler: local, command: process.execPath, env: {}, source: "node_modules" });
  });

  test("runs a compiler inside a macOS app bundle under the app's Electron helper", () => {
    const resources = join("/home/demo", "Applications", "Paseo.app", "Contents", "Resources");
    const helper = join(resources, "..", "Frameworks", "Paseo Helper.app", "Contents", "MacOS", "Paseo Helper");
    const found = locateCompiler({
      pluginDir: "/srv/plugin", env: { PATH: "" }, home: "/home/demo", platform: "darwin",
      exists: only(join(resources, "app.asar"), helper),
    });
    assert.equal(found.compiler, join(resources, "app.asar", "node_modules", ...COMPILER_IN_PACKAGE));
    assert.equal(found.command, helper);
    assert.deepEqual(found.env, { ELECTRON_RUN_AS_NODE: "1" });
  });

  test("PASEO_PLUGIN_COMPILER wins when set, and an unusable one is reported instead of replaced", () => {
    const found = locateCompiler({ pluginDir: "/srv/plugin", env: { PATH: "", PASEO_PLUGIN_COMPILER: "/srv/missing/compiler.js" }, platform: "linux", exists: () => true });
    // exists() is true for everything, yet the explicit path wins: it is used as given.
    assert.equal(found.compiler, "/srv/missing/compiler.js");
    const missing = locateCompiler({ pluginDir: "/srv/plugin", env: { PATH: "", PASEO_PLUGIN_COMPILER: "/srv/missing/compiler.js" }, platform: "linux", exists: () => false });
    assert.match(missing.skip ?? "", /PASEO_PLUGIN_COMPILER is set but unusable/);
  });
});

describe("build:check end to end with a stand-in compiler", () => {
  let dir = "";
  let plugin = "";

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "build-check-test-"));
    plugin = join(dir, "plugin");
    await mkdir(plugin);
    await writeFile(join(plugin, "index.server.ts"), "export default {};\n");
    await writeFile(join(dir, "ok-compiler.mjs"),
      "export async function compilePlugin(entries) { return { clientBundle: entries.client ? 'c' : null, serverBundle: 'server-code' }; }\n");
    await writeFile(join(dir, "bad-compiler.mjs"),
      "export async function compilePlugin() { throw new Error('Node module cannot be imported into the plugin shared bundle: node:os'); }\n");
  });
  after(async () => { await rm(dir, { recursive: true, force: true }); });

  const run = (compiler: string, ...args: string[]) => spawnSync(process.execPath, [script, "--plugin", plugin, ...args], {
    encoding: "utf8", env: { ...process.env, PASEO_PLUGIN_COMPILER: compiler },
  });

  test("passes and reports the bundles the compiler produced", () => {
    const result = run(join(dir, "ok-compiler.mjs"));
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /build:check passed: .*server 11 bytes/);
    assert.doesNotMatch(result.stdout, /client/);
  });

  test("fails with the compiler's own message", () => {
    const result = run(join(dir, "bad-compiler.mjs"));
    assert.equal(result.status, 1);
    assert.match(result.stdout, /build:check FAILED[\s\S]*Node module cannot be imported into the plugin shared bundle/);
  });

  test("a missing compiler is SKIPPED, never passed; --strict turns it into a failure", () => {
    const loose = run(join(dir, "absent.mjs"));
    assert.equal(loose.status, 0);
    assert.match(loose.stdout, /build:check SKIPPED \(not a pass\)/);
    assert.doesNotMatch(loose.stdout, /passed/);
    assert.equal(run(join(dir, "absent.mjs"), "--strict").status, 2);
  });

  test("the runner refuses a directory without plugin entries", () => {
    const result = spawnSync(process.execPath, [runner, join(dir, "ok-compiler.mjs"), dir, join(dir, "out")], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no plugin entry/);
  });
});
