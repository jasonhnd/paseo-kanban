// Tests for typecheck.mjs on throwaway plugin folders (tsc comes from this repository's node_modules).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "typecheck.mjs");
const TSCONFIG = JSON.stringify({ compilerOptions: { strict: true, noEmit: true, module: "ESNext", moduleResolution: "Bundler", target: "ES2022", types: [] }, include: ["**/*.ts"], exclude: ["node_modules"] });
const temps = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function plugin(files) {
  const root = mkdtempSync(join(tmpdir(), "typecheck-test-"));
  temps.push(root);
  const all = { "package.json": JSON.stringify({ name: "demo", version: "0.0.0" }), ...files };
  for (const [path, body] of Object.entries(all)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  symlinkSync(join(ROOT, "node_modules"), join(root, "node_modules"), "dir");
  return root;
}
const run = (root) => spawnSync(process.execPath, [SCRIPT, "--root", root], { encoding: "utf8" });

test("a plugin without TypeScript sources passes with a note", () => {
  const out = run(plugin({ "tsconfig.json": TSCONFIG }));
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /typecheck: ok \(no TypeScript sources yet/);
  assert.equal(run(plugin({})).status, 0);
});

test("sources are checked with the root tsconfig.json", () => {
  const good = run(plugin({ "tsconfig.json": TSCONFIG, "server/x.ts": "export const n: number = 1;\n" }));
  assert.equal(good.status, 0, good.stdout + good.stderr);
  assert.match(good.stdout, /typecheck: ok \(1 file\(s\)\)/);
  const bad = run(plugin({ "tsconfig.json": TSCONFIG, "server/x.ts": "export const n: number = \"one\";\n" }));
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /typecheck: FAILED/);
  assert.match(bad.stdout, /TS2322/);
});

test("sources without a tsconfig.json fail", () => {
  const out = run(plugin({ "shared/x.ts": "export {};\n" }));
  assert.equal(out.status, 1);
  assert.match(out.stdout, /1 TypeScript file\(s\) but no tsconfig\.json/);
});
