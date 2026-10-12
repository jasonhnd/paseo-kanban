// Tests for test-plugin.mjs on throwaway plugin folders.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { pluginTests } from "./test-plugin.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "test-plugin.mjs");
const temps = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function plugin(files) {
  const root = mkdtempSync(join(tmpdir(), "test-plugin-"));
  temps.push(root);
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  return root;
}
const run = (root) => spawnSync(process.execPath, [SCRIPT, "--root", root], { encoding: "utf8" });
const PASS = 'import { test } from "node:test";\ntest("ok", () => {});\n';

test("tests are found under client/, server/, shared/ and test/ only", () => {
  const root = plugin({ "server/a.test.ts": PASS, "test/nested/b.test.tsx": PASS, "shared/c.ts": "", "scripts/d.test.ts": PASS, "server/node_modules/x/e.test.ts": PASS });
  assert.deepEqual(pluginTests(root), ["server/a.test.ts", "test/nested/b.test.tsx"]);
});

test("no plugin tests pass with a note", () => {
  const out = run(plugin({ "README.md": "# demo\n" }));
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /no plugin tests yet/);
});

test("the tests run, and a failing one fails the step", () => {
  assert.equal(run(plugin({ "server/a.test.ts": PASS })).status, 0);
  assert.notEqual(run(plugin({ "server/a.test.ts": 'import { test } from "node:test";\ntest("no", () => { throw new Error("x"); });\n' })).status, 0);
});

test("tsx loads TSX and extensionless TypeScript imports", () => {
  const root = plugin({
    "shared/value.ts": 'export const value: number = 42;\n',
    "client/view.test.tsx": 'import { test } from "node:test"; import assert from "node:assert/strict"; import { value } from "../shared/value"; test("typed", () => assert.equal(value, 42));\n',
  });
  const out = run(root);
  assert.equal(out.status, 0, out.stdout + out.stderr);
});

test("imported runner preloads locale and isolates performance after regression", () => {
  const root = plugin({
    "test/helpers/test-phases.mjs": 'export const testPhases = () => [["regression", "test/a.test.ts"], ["performance", "test/b.test.ts"]];\n',
    "test/helpers/test-tmp.mjs": `import { spawnSync } from "node:child_process";
export async function runPhasesInPrivateTmp(phases, { cwd }) {
  for (const [name, ...files] of phases) {
    console.log(name);
    const out = spawnSync(process.execPath, ["--import", ${JSON.stringify(import.meta.resolve("tsx"))}, "--import", "./test/helpers/locale.mjs", "--test", ...files], { cwd, stdio: "inherit", env: { ...process.env, KANBAN_LANGUAGE: "zh-CN" } });
    if (out.status !== 0) return out.status;
  }
  return 0;
}\n`,
    "test/helpers/locale.mjs": 'globalThis.locale = "zh-CN";\n',
    "test/a.test.ts": 'import { writeFileSync } from "node:fs"; import { test } from "node:test"; import assert from "node:assert/strict"; test("regression", () => { assert.equal(globalThis.locale, "zh-CN"); assert.equal(process.env.KANBAN_LANGUAGE, "zh-CN"); writeFileSync("finished", "yes"); });\n',
    "test/b.test.ts": 'import { existsSync } from "node:fs"; import { test } from "node:test"; import assert from "node:assert/strict"; test("performance", () => assert.ok(existsSync("finished")));\n',
    "server/extra.test.ts": PASS,
  });
  const out = run(root);
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /regression/);
  assert.match(out.stdout, /performance/);
  assert.match(out.stdout, /ok/);
});
