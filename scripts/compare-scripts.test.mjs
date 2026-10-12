// Tests for compare-scripts.mjs on two throwaway repositories.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { compareTrees, parseArgs, sharedFiles } from "./compare-scripts.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "compare-scripts.mjs");
const temps = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function repo(files) {
  const root = mkdtempSync(join(tmpdir(), "compare-scripts-"));
  temps.push(root);
  const all = { "scripts/compare-scripts.mjs": "// gate\n", ".githooks/pre-commit": "#!/bin/sh\n", ".github/workflows/ci.yml": "name: ci\n", "README.md": "# not shared\n", ...files };
  for (const [path, body] of Object.entries(all)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  return root;
}
const env = { ...process.env };
delete env.PASEO_FLEET_SIBLING;
const run = (root, ...args) => spawnSync(process.execPath, [SCRIPT, "--root", root, ...args], { encoding: "utf8", env });

test("arguments, with the sibling from the environment", () => {
  assert.equal(parseArgs([], {}).sibling, null);
  assert.equal(parseArgs([], { PASEO_FLEET_SIBLING: "/other" }).sibling, "/other");
  assert.equal(parseArgs(["--sibling", "/x"], { PASEO_FLEET_SIBLING: "/other" }).sibling, "/x");
  assert.throws(() => parseArgs(["--sibling"], {}), /unknown argument/);
});

test("the shared folders are scripts/, .githooks/ and .github/workflows/", () => {
  assert.deepEqual(Object.keys(sharedFiles(repo({}))).sort(), [".githooks/pre-commit", ".github/workflows/ci.yml", "scripts/compare-scripts.mjs"]);
});

test("no sibling fails instead of reporting a vacuous comparison", () => {
  const out = run(repo({}));
  assert.equal(out.status, 2, out.stdout + out.stderr);
  assert.match(out.stderr, /public sibling source is required/);
});

test("identical gates pass; a README may differ", () => {
  const out = run(repo({}), "--sibling", repo({ "README.md": "# other\n" }));
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /3 shared file\(s\), identical in both repositories/);
});

test("a changed, missing or extra gate fails", () => {
  const here = repo({ "scripts/extra.mjs": "// only here\n" });
  const there = repo({ ".githooks/pre-commit": "#!/bin/sh\nexit 1\n", "scripts/rules.json": "{}\n" });
  const out = run(here, "--sibling", there);
  assert.equal(out.status, 1);
  assert.deepEqual(compareTrees(sharedFiles(here), sharedFiles(there)), [
    "differs       .githooks/pre-commit",
    "only here     scripts/extra.mjs",
    "only sibling  scripts/rules.json",
  ]);
});

test("a sibling without the gates is a setup problem", () => {
  const empty = mkdtempSync(join(tmpdir(), "compare-scripts-"));
  temps.push(empty);
  assert.equal(run(repo({}), "--sibling", empty).status, 2);
});
