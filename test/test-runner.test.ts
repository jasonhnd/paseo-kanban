import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, readFileSync, existsSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { after, it } from "node:test";
import { SUBPROCESS_TIMEOUT_MS } from "./helpers/subprocess-timeout";

const runner = new URL("../bin/test.mjs", import.meta.url);
const phasesModule = new URL("./helpers/test-phases.mjs", import.meta.url);
const roots: string[] = [];
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
function runFixture(failure?: "functional" | "performance" | "pollution", inheritedLegacy?: string | null) {
  const root = mkdtempSync(join(tmpdir(), "kanban-test-runner-"));
  roots.push(root);
  mkdirSync(join(root, "test"));
  mkdirSync(join(root, "bin"));
  mkdirSync(join(root, "test/helpers"));
  // The runner derives its root and file list from the shared phases module, so the fixture needs its own copy.
  writeFileSync(join(root, "test/helpers/test-phases.mjs"), readFileSync(phasesModule, "utf8"));
  const fixtureRunner = join(root, "bin/test.mjs");
  // Copy the actual entry point; keep tsx resolution tied to this repository.
  const helperUrl = new URL("./helpers/test-tmp.mjs", import.meta.url).href;
  writeFileSync(fixtureRunner, readFileSync(runner, "utf8")
    .replace('import.meta.resolve("tsx")', JSON.stringify(import.meta.resolve("tsx")))
    .replace('"../test/helpers/test-tmp.mjs"', JSON.stringify(helperUrl)));
  for (const [name, delay] of [["fast", 10], ["slow", 100]] as const) {
    writeFileSync(join(root, "test", `${name}.test.ts`), `
      import { test } from "node:test";
      import assert from "node:assert/strict";
      import { existsSync, mkdirSync, writeFileSync } from "node:fs";
      import { join } from "node:path";
      test("${name} worker", async () => {
        await new Promise(resolve => setTimeout(resolve, ${delay}));
        assert.ok(!existsSync("${name}"), "ordinary tests must run once");
        writeFileSync("${name}", String(process.pid));
        writeFileSync("${name}.tmpdir", process.env.TMPDIR ?? "");
        assert.ok(process.env.KANBAN_TMP_ROOT?.startsWith(process.env.TMPDIR + "/"), "card roots must be owned by this test run");
        writeFileSync("${name}.card-root", process.env.KANBAN_TMP_ROOT);
        ${failure === "pollution" && name === "fast" ? 'mkdirSync(".kanban-work/TEST_0500", { recursive: true });' : ""}
        writeFileSync("${name}.test-marker", process.env.KANBAN_TEST_TMP ?? "");
        // Tests may unset the primary overrides, but the legacy fallback must remain isolated.
        delete process.env.ROLES_STATE_DIR;
        delete process.env.AFC_DATA_DIR;
        const legacy = process.env.AFC_LEGACY_DATA_DIR;
        assert.equal(legacy, "", "the runner disables legacy discovery");
        writeFileSync("${name}.legacy-state", JSON.stringify({
          dir: legacy,
          populated: ["decisions.json", "paused-projects.json", "panel-prefs.json"]
            .some(file => Boolean(legacy) && existsSync(join(legacy, file))),
        }));
        ${failure === "functional" && name === "slow" ? 'assert.fail("functional sentinel");' : ""}
      });
    `);
  }
  writeFileSync(join(root, "test/native-sessions.test.ts"), `
    import { test } from "node:test";
    import assert from "node:assert/strict";
    import { existsSync, readFileSync, writeFileSync } from "node:fs";
    test("ordinary native test", () => {
      assert.ok(existsSync("fast") && existsSync("slow"), "all parallel workers must finish first");
      assert.ok(!existsSync("ordinary"), "native functional tests must run once");
      writeFileSync("ordinary", String(process.pid));
    });
    test("native session performance: fixture", () => {
      assert.ok(existsSync("fast") && existsSync("slow"), "all ordinary workers must finish first");
      assert.notEqual(readFileSync("slow", "utf8"), String(process.pid), "performance must use a new process");
      writeFileSync("performance", "ran");
      ${failure === "performance" ? 'assert.fail("performance sentinel");' : ""}
    });
  `);
  writeFileSync(join(root, "test/tick-scale.test.ts"), `
    import { test } from "node:test";
    import assert from "node:assert/strict";
    import { existsSync, writeFileSync } from "node:fs";
    test("tick scale gate: fixture", () => {
      assert.ok(existsSync("fast") && existsSync("slow"), "all ordinary workers must finish first");
      writeFileSync("tick-scale", "ran");
    });
  `);
  const env = { ...process.env };
  // A child --test invocation must be a fresh runner, not a recursive test worker.
  delete env.NODE_TEST_CONTEXT;
  if (inheritedLegacy === null) delete env.AFC_LEGACY_DATA_DIR;
  else if (inheritedLegacy !== undefined) env.AFC_LEGACY_DATA_DIR = inheritedLegacy;
  const result = spawnSync(process.execPath, [fixtureRunner], { cwd: tmpdir(), env, encoding: "utf8", timeout: SUBPROCESS_TIMEOUT_MS });
  return { root, ...result };
}

it("test runner waits for all parallel workers before the isolated performance process", () => {
  const result = runFixture();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(readFileSync(join(result.root, "performance"), "utf8"), "ran");
  assert.equal(readFileSync(join(result.root, "tick-scale"), "utf8"), "ran");
});
it("test runner rejects a whole phase that adds a card directory in its default project root", () => {
  const result = runFixture("pollution");
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /card-root isolation failed/);
  assert.equal(existsSync(join(result.root, "performance")), false);
});
it("test runner propagates functional failure and does not start performance", () => {
  const result = runFixture("functional");
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /functional sentinel/);
  assert.equal(existsSync(join(result.root, "performance")), false);
});
it("test runner propagates an isolated performance failure", () => {
  const result = runFixture("performance");
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /performance sentinel/);
  assert.equal(existsSync(join(result.root, "performance")), true);
});
it("test runner gives the run a private TMPDIR and removes it afterwards", () => {
  const result = runFixture();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const fast = readFileSync(join(result.root, "fast.tmpdir"), "utf8");
  const slow = readFileSync(join(result.root, "slow.tmpdir"), "utf8");
  assert.equal(fast, slow);
  assert.equal(readFileSync(join(result.root, "fast.test-marker"), "utf8"), fast);
  assert.equal(readFileSync(join(result.root, "slow.test-marker"), "utf8"), slow);
  assert.match(fast, /kanban-test-\d+-/);
  assert.notEqual(fast, process.env.TMPDIR);
  for (const worker of ["fast", "slow"]) {
    const cardRoot = readFileSync(join(result.root, `${worker}.card-root`), "utf8");
    assert.ok(cardRoot.startsWith(fast + "/"));
    assert.notEqual(cardRoot, process.env.KANBAN_TMP_ROOT);
    assert.equal(existsSync(cardRoot), false);
  }
  assert.equal(existsSync(fast), false);
});
it("test runner isolates the legacy fallback with an unset or populated parent override", () => {
  const legacy = mkdtempSync(join(tmpdir(), "runner-parent-legacy-"));
  roots.push(legacy);
  const files = {
    "decisions.json": "[]",
    "paused-projects.json": '[{"project":"demo"}]',
    "panel-prefs.json": '{"fontStep":"lg","colorMode":"dark"}',
  };
  for (const [name, content] of Object.entries(files)) writeFileSync(join(legacy, name), content);
  for (const inherited of [null, legacy]) {
    const result = runFixture(undefined, inherited);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    for (const worker of ["fast", "slow"]) {
      const temp = readFileSync(join(result.root, `${worker}.tmpdir`), "utf8");
      const observed = JSON.parse(readFileSync(join(result.root, `${worker}.legacy-state`), "utf8"));
      assert.equal(observed.dir, "", "retired discovery is disabled");
      assert.notEqual(observed.dir, legacy);
      assert.equal(observed.populated, false);
    }
  }
  for (const [name, content] of Object.entries(files)) assert.equal(readFileSync(join(legacy, name), "utf8"), content);
});
it("coverage keeps c8 data and test temp dirs under one root that is removed afterwards", () => {
  const root = mkdtempSync(join(tmpdir(), "kanban-coverage-fixture-"));
  roots.push(root);
  for (const dir of ["bin", "test/helpers", "server", "shared"]) mkdirSync(join(root, dir), { recursive: true });
  const repo = new URL("..", import.meta.url).pathname;
  for (const file of ["bin/coverage.mjs", "test/helpers/test-tmp.mjs", "test/helpers/card-root-audit.mjs", "test/helpers/coverage-phases.mjs", "test/helpers/test-phases.mjs"]) copyFileSync(join(repo, file), join(root, file));
  symlinkSync(join(repo, "node_modules"), join(root, "node_modules"));
  writeFileSync(join(root, "server/mod.ts"), "export const value = 1;\n");
  writeFileSync(join(root, "test/a.test.ts"), `
    import { test } from "node:test";
    import assert from "node:assert/strict";
    import { mkdtempSync, writeFileSync } from "node:fs";
    import { tmpdir } from "node:os";
    import { join } from "node:path";
    test("leaks a dir", () => {
      const leaked = mkdtempSync(join(tmpdir(), "leak-"));
      writeFileSync(join(process.env.COVERAGE_TMP_RECORD!, "seen"), leaked);
      assert.ok(leaked.includes("kanban-test-"));
    });
  `);
  for (const name of ["native-sessions", "tick-scale"]) writeFileSync(join(root, `test/${name}.test.ts`), 'import { test } from "node:test";\ntest("noop", () => {});\n');
  const outer = mkdtempSync(join(tmpdir(), "kanban-coverage-outer-"));
  roots.push(outer);
  const record = join(outer, "record");
  mkdirSync(record);
  const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: outer, COVERAGE_TMP_RECORD: record };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [join(root, "bin/coverage.mjs")], { cwd: root, env, encoding: "utf8", timeout: 60_000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(existsSync(join(record, "seen")), true);
  assert.deepEqual(readdirSync(outer).filter(name => name !== "record"), []);
});
