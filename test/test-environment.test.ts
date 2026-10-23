import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, it } from "node:test";

const root = mkdtempSync(join(tmpdir(), "test-environment-"));
after(() => rmSync(root, { recursive: true, force: true }));
const configUrl = new URL("../server/config.ts", import.meta.url).href;
const utilUrl = new URL("../server/fleet/util.ts", import.meta.url).href;
const helperUrl = new URL("./helpers/test-tmp.mjs", import.meta.url).href;
const fakeHome = join(root, "personal-home");
const personalData = join(fakeHome, ".paseo/plugin-data/paseo-kanban");
mkdirSync(personalData, { recursive: true });
const sentinel = join(personalData, "kanban.config.json");
writeFileSync(sentinel, '{"personal":"sentinel"}\n');
function probe(code: string, overrides: NodeJS.ProcessEnv = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env, KANBAN_TEST_RUN: "1", KANBAN_TEST_PROTECTED_HOMES: JSON.stringify([fakeHome]), ...overrides };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { env, encoding: "utf8", timeout: 30_000 });
}
function ok(result: ReturnType<typeof probe>) { assert.equal(result.status, 0, result.stdout + result.stderr); }

it("runner replaces inherited personal paths and credentials for every phase", () => {
  const worker = join(root, "env.test.mjs");
  writeFileSync(worker, `import assert from 'node:assert/strict'; import { test } from 'node:test';
    test('private environment', () => {
      for (const key of ['HOME','PASEO_HOME','KANBAN_DATA_DIR','KANBAN_PASEO_CONFIG','XDG_CONFIG_HOME','XDG_CACHE_HOME','KANBAN_TMP','KANBAN_TMP_ROOT','KANBAN_WORKTREES_ROOT','KANBAN_PROJECTS_ROOT','ROLES_KANBAN_CONFIG','KANBAN_POOL_STATUS','KANBAN_DISPATCH_MATRIX'])
        assert.ok(key === 'KANBAN_TMP' ? process.env[key] === process.env.KANBAN_TEST_TMP : process.env[key]?.startsWith(process.env.KANBAN_TEST_TMP + '/'), key + ': ' + process.env[key]);
      assert.equal(process.env.KANBAN_TEST_RUN, '1');
      assert.equal(process.env.KANBAN_TOKEN, undefined); assert.equal(process.env.PASEO_AGENT_ID, undefined);
      for (const key of ['AFC_DATA_DIR','ROLES_STATE_DIR','AFC_LEGACY_DATA_DIR']) assert.equal(process.env[key], '');
    });`);
  // A normal invocation may start in the user's shell; its children must never inherit it.
  ok(probe(`import { runPhasesInPrivateTmp } from ${JSON.stringify(helperUrl)};
    process.exitCode = await runPhasesInPrivateTmp([['env', ${JSON.stringify(worker)}]], { cwd: ${JSON.stringify(root)}, logPrefix: 'fixture' });`, {
    KANBAN_TEST_RUN: undefined, HOME: fakeHome, PASEO_HOME: join(fakeHome, ".paseo"),
    KANBAN_DATA_DIR: personalData, KANBAN_PASEO_CONFIG: join(fakeHome, ".paseo/config.json"),
    KANBAN_TOKEN: "fixture-token", PASEO_AGENT_ID: "fixture-agent", XDG_CONFIG_HOME: join(fakeHome, ".config"),
    KANBAN_POOL_STATUS: join(fakeHome, "pools.json"), KANBAN_DISPATCH_MATRIX: join(fakeHome, "matrix.json"),
  }));
});
it("a marked runner refuses leaked HOME or PASEO_HOME before starting any phase", () => {
  for (const overrides of [{ HOME: fakeHome }, { PASEO_HOME: join(fakeHome, ".paseo") }]) {
    const result = probe(`import { runPhasesInPrivateTmp } from ${JSON.stringify(helperUrl)};
      await runPhasesInPrivateTmp([['never', 'missing.test.mjs']], { cwd: ${JSON.stringify(root)}, logPrefix: 'fixture' });`, overrides);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stderr, /test isolation.*(HOME|PASEO_HOME)/i);
    assert.doesNotMatch(result.stdout, /\[fixture\] never/);
  }
});
it("saveConfig/loadConfig refuse personal paths even inside TMPDIR and after a cached safe read", () => {
  ok(probe(`import assert from 'node:assert/strict';
    import { loadConfig, parseConfig, saveConfig } from ${JSON.stringify(configUrl)};
    saveConfig(parseConfig({})); loadConfig();
    process.env.KANBAN_DATA_DIR = ${JSON.stringify(personalData)};
    assert.throws(() => loadConfig(), /test isolation/i);
    assert.throws(() => saveConfig(parseConfig({})), /test isolation/i);`));
  assert.equal(readFileSync(sentinel, "utf8"), '{"personal":"sentinel"}\n');
});
it("fleet reads and writes recheck protected symlink targets after module initialization", () => {
  const alias = join(root, "alias"); symlinkSync(personalData, alias);
  ok(probe(`import assert from 'node:assert/strict'; import { readJson, writeJson } from ${JSON.stringify(utilUrl)};
    await assert.rejects(readJson(${JSON.stringify(join(alias, "kanban.config.json"))}, {}), /test isolation/i);
    await assert.rejects(writeJson(${JSON.stringify(join(alias, "new.json"))}, {}), /test isolation/i);`));
  assert.equal(existsSync(join(personalData, "new.json")), false);
});
it("Paseo config resolution refuses personal config overrides", () => {
  const paths = new URL("../server/paths.ts", import.meta.url).href;
  ok(probe(`import assert from 'node:assert/strict'; import { paseoConfigPath } from ${JSON.stringify(paths)};
    assert.throws(() => paseoConfigPath(), /test isolation/i);`, { KANBAN_PASEO_CONFIG: join(fakeHome, ".paseo/config.json") }));
});
it("roles refuses a personal board config override instead of swallowing the isolation error", () => {
  const roles = new URL("../server/fleet/roles-cli.ts", import.meta.url).href;
  const result = probe(`process.argv = ['node', 'roles', 'decide', 'add', '--project', 'demo', '--title', 'Fixture', '--force-open'];
    await import(${JSON.stringify(roles)});`, { ROLES_KANBAN_CONFIG: sentinel });
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /test isolation/i);
});
it("the explicit test marker blocks personal fallback after the data override and legacy markers are lost", () => {
  const result = probe(`import { parseConfig, saveConfig } from ${JSON.stringify(configUrl)};
    saveConfig(parseConfig({ projects: { demo: { defaultWorkspace: 'dir', baseBranch: 'trunk' } } }));`, {
    HOME: fakeHome, PASEO_HOME: join(fakeHome, ".paseo"), KANBAN_DATA_DIR: undefined,
    KANBAN_PASEO_CONFIG: join(fakeHome, ".paseo/config.json"), KANBAN_TEST_TMP: undefined,
    TMPDIR: root,
  });
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /test isolation/i);
  assert.equal(readFileSync(sentinel, "utf8"), '{"personal":"sentinel"}\n');
});

it("direct legacy routing helpers isolate inherited personal paths before loading config", () => {
  const legacy = new URL("./helpers/legacy-routing.ts", import.meta.url).href;
  ok(probe(`import assert from 'node:assert/strict';
    await import(${JSON.stringify(legacy)}).then(({ useLegacyRouting }) => {
      assert.equal(process.env.KANBAN_TEST_RUN, '1');
      useLegacyRouting();
    });
    const { loadConfig } = await import(${JSON.stringify(configUrl)});
    const { configPath } = await import(${JSON.stringify(new URL("../server/config-file.ts", import.meta.url).href)});
    assert.ok(configPath().startsWith(process.env.KANBAN_TEST_TMP + '/'));
    assert.equal(loadConfig().quotaRouting.enabled, false);`, {
    KANBAN_TEST_RUN: undefined, HOME: fakeHome, PASEO_HOME: join(fakeHome, ".paseo"),
    KANBAN_DATA_DIR: undefined, KANBAN_PASEO_CONFIG: join(fakeHome, ".paseo/config.json"),
  }));
  assert.equal(readFileSync(sentinel, "utf8"), '{"personal":"sentinel"}\n');
});

it("legacy routing children retain an explicitly isolated shared board", () => {
  const legacy = new URL("./helpers/legacy-routing.ts", import.meta.url).href;
  const sharedData = join(root, "shared-board");
  ok(probe(`import assert from 'node:assert/strict';
    import { loadConfig, parseConfig, saveConfig } from ${JSON.stringify(configUrl)};
    saveConfig(parseConfig({ autoStart: { demo: true } }));
    const { useLegacyRouting } = await import(${JSON.stringify(legacy)});
    assert.equal(process.env.KANBAN_DATA_DIR, ${JSON.stringify(sharedData)});
    useLegacyRouting();
    assert.equal(loadConfig().autoStart.demo, true);
    assert.equal(loadConfig().quotaRouting.enabled, false);`, { KANBAN_DATA_DIR: sharedData }));
});
