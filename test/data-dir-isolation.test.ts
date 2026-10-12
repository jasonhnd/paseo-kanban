import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { canonicalPath, chooseDataDir, defaultPluginDataDir, PLUGIN_ID, registeredPluginPath } from "../server/paths";
import { isAbsolute, join, relative, sep } from "node:path";
import { after, it } from "node:test";

const root = mkdtempSync(join(tmpdir(), "data-dir-isolation-"));
const installation = join(root, "installation");
const production = join(installation, "data");
const isolated = join(root, "isolated");
// The board Paseo really loads: the registered installation's data/, or plugin-data when none is registered.
const registered = registeredPluginPath(PLUGIN_ID);
const liveProduction = registered ? join(registered, "data") : defaultPluginDataDir();
mkdirSync(production, { recursive: true });
mkdirSync(isolated);
after(() => rmSync(root, { recursive: true, force: true }));
const paths = new URL("../server/paths.ts", import.meta.url).href;
const config = new URL("../server/config.ts", import.meta.url).href;
function probe(overrides: NodeJS.ProcessEnv, code = `import { dataDir } from ${JSON.stringify(paths)}; console.log(dataDir());`) {
  const env: NodeJS.ProcessEnv = { ...process.env, KANBAN_HOME: installation, ...overrides };
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];
  return spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { env, encoding: "utf8", timeout: 15_000 });
}
function refused(env: NodeJS.ProcessEnv) {
  const result = probe(env);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /KANBAN_DATA_DIR.*temporary directory/);
}
it("test workers require an explicit temporary data directory", () => {
  refused({ NODE_TEST_CONTEXT: "child-v8", KANBAN_DATA_DIR: undefined });
  refused({ NODE_TEST_CONTEXT: "child-v8", KANBAN_DATA_DIR: "" });
  refused({ NODE_TEST_CONTEXT: "child-v8", KANBAN_DATA_DIR: liveProduction });
  refused({ NODE_TEST_CONTEXT: "child-v8", KANBAN_DATA_DIR: "/var/kanban-production" });
  const checkoutData = join(process.cwd(), "data");
  const temporaryCheckout = [tmpdir(), "/tmp"].some(parent => {
    const rel = relative(canonicalPath(parent), canonicalPath(process.cwd()));
    return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
  });
  if (temporaryCheckout) {
    const fixture = probe({ NODE_TEST_CONTEXT: "child-v8", KANBAN_DATA_DIR: checkoutData });
    assert.equal(fixture.status, 0, fixture.stderr);
    assert.equal(fixture.stdout.trim(), checkoutData);
  } else refused({ NODE_TEST_CONTEXT: "child-v8", KANBAN_DATA_DIR: checkoutData });
  const result = probe({ NODE_TEST_CONTEXT: "child-v8", KANBAN_DATA_DIR: isolated });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), isolated);
});
it("plain subprocesses inherit protection from the private test runner marker", () => {
  refused({ NODE_TEST_CONTEXT: undefined, KANBAN_TEST_TMP: root, TMPDIR: root, KANBAN_DATA_DIR: undefined });
  refused({ NODE_TEST_CONTEXT: undefined, KANBAN_TEST_TMP: undefined, TMPDIR: join(root, "kanban-test-123-fixture"), KANBAN_DATA_DIR: undefined });
});
it("production data and config symlinks cannot bypass test isolation", () => {
  const alias = join(root, "production-alias");
  symlinkSync(liveProduction, alias);
  refused({ NODE_TEST_CONTEXT: "child-v8", KANBAN_DATA_DIR: alias });
  const configFile = join(production, "kanban.config.json");
  writeFileSync(configFile, JSON.stringify({ disabledPools: ["codex-pro"] }));
  const linked = join(root, "linked-config");
  mkdirSync(linked);
  symlinkSync(join(liveProduction, "kanban.config.json"), join(linked, "kanban.config.json"));
  const result = probe({ NODE_TEST_CONTEXT: "child-v8", KANBAN_DATA_DIR: linked }, `import { loadConfig } from ${JSON.stringify(config)}; loadConfig();`);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /KANBAN_DATA_DIR.*temporary directory/);
});
it("rechecks requested directory and config symlinks after earlier safe reads", () => {
  const mutable = join(root, "mutable");
  const code = `import assert from "node:assert/strict";
    import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
    import { dataDir } from ${JSON.stringify(paths)};
    import { loadConfig } from ${JSON.stringify(config)};
    const dir = process.env.KANBAN_DATA_DIR;
    mkdirSync(dir);
    dataDir();
    const file = dir + "/kanban.config.json";
    writeFileSync(file, "{}"); loadConfig();
    rmSync(file); symlinkSync(${JSON.stringify(join(liveProduction, "kanban.config.json"))}, file);
    assert.throws(() => loadConfig(), /KANBAN_DATA_DIR.*temporary directory/);
    rmSync(dir, { recursive: true }); symlinkSync(${JSON.stringify(liveProduction)}, dir);
    assert.throws(() => dataDir(), /KANBAN_DATA_DIR.*temporary directory/);`;
  const result = probe({ NODE_TEST_CONTEXT: "child-v8", KANBAN_DATA_DIR: mutable }, code);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
it("getDb reuses its checked handle but checks any other directory before closing it", () => {
  const db = new URL("../server/db.ts", import.meta.url).href;
  const first = join(root, "reused");
  const code = `import assert from "node:assert/strict";
    import { existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
    import { getDb } from ${JSON.stringify(db)};
    import { dataDir } from ${JSON.stringify(paths)};
    const dir = process.env.KANBAN_DATA_DIR;
    mkdirSync(dir);
    const handle = getDb();
    assert.equal(getDb(), handle);
    process.env.KANBAN_DATA_DIR = ${JSON.stringify(liveProduction)};
    assert.throws(() => getDb(), /KANBAN_DATA_DIR.*temporary directory/);
    process.env.KANBAN_DATA_DIR = dir;
    assert.equal(getDb(), handle, "a refused directory does not close the open handle");
    // Swapping the open directory for a production symlink: path users refuse, the open handle keeps its own file.
    rmSync(dir, { recursive: true }); symlinkSync(${JSON.stringify(liveProduction)}, dir);
    assert.throws(() => dataDir(), /KANBAN_DATA_DIR.*temporary directory/);
    assert.equal(getDb(), handle);
    rmSync(dir);
    assert.equal(existsSync(dir), false);`;
  const result = probe({ NODE_TEST_CONTEXT: "child-v8", KANBAN_DATA_DIR: first }, code);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
it("abnormal simulated production config never changes isolated config", () => {
  const pools = new URL("../server/pools.ts", import.meta.url).href;
  const poolFile = join(root, "pool-status.json");
  writeFileSync(poolFile, JSON.stringify({ pools: { "codex-pro": { dispatchable: true }, "claude-max": { dispatchable: true } } }));
  const code = `import { loadConfig } from ${JSON.stringify(config)};
    import { readPoolSnapshot, readCompatibilityPoolSnapshot } from ${JSON.stringify(pools)};
    const snapshot = readPoolSnapshot();
    const compatibility = readCompatibilityPoolSnapshot();
    console.log(JSON.stringify({ config: loadConfig(), codex: snapshot.dispatchable("codex-pro"), claude: snapshot.dispatchable("claude-max"), compatibilityCodex: compatibility.dispatchable("codex-pro"), compatibilityClaude: compatibility.dispatchable("claude-max") }));`;
  const env = { NODE_TEST_CONTEXT: "child-v8", KANBAN_DATA_DIR: isolated, KANBAN_POOL_STATUS: poolFile };
  writeFileSync(join(isolated, "kanban.config.json"), JSON.stringify({ disabledPools: [] }));
  const before = probe(env, code);
  writeFileSync(join(production, "kanban.config.json"), JSON.stringify({ disabledPools: ["codex-pro", "claude-max"], concurrency: { global: -999 }, projects: "broken" }));
  const changed = probe(env, code);
  assert.equal(before.status, 0, before.stderr);
  assert.equal(changed.status, 0, changed.stderr);
  assert.equal(changed.stdout, before.stdout);
  assert.equal(JSON.parse(changed.stdout).codex, false, "default admission requires immutable policy");
  assert.equal(JSON.parse(changed.stdout).claude, false);
  assert.equal(JSON.parse(changed.stdout).compatibilityCodex, true, "the explicit legacy reader stays isolated");
  assert.equal(JSON.parse(changed.stdout).compatibilityClaude, true);
});
it("normal production processes keep their existing path behavior", () => {
  const env = { NODE_TEST_CONTEXT: undefined, KANBAN_TEST_TMP: undefined,
    TMPDIR: root.replace(/[/\\]kanban-test-\d+-.*$/, ""), KANBAN_DATA_DIR: liveProduction };
  const explicit = probe(env);
  assert.equal(explicit.status, 0, explicit.stderr);
  assert.equal(explicit.stdout.trim(), liveProduction);
  // Without overrides the installation Paseo registers decides: its legacy data/ until it is migrated.
  const defaultPath = probe({ ...env, KANBAN_DATA_DIR: undefined, KANBAN_HOME: undefined });
  assert.equal(defaultPath.status, 0, defaultPath.stderr);
  const expected = registered
    ? chooseDataDir({ env: { PASEO_HOME: process.env.PASEO_HOME }, home: homedir(), pluginRoot: registered, exists: existsSync }).dir
    : defaultPluginDataDir();
  assert.equal(defaultPath.stdout.trim(), expected);
});
