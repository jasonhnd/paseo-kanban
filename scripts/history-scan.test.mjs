import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { run, loadRules, scanFile, summarizeHistoryFindings } from "./check-private.mjs";
import { git, exportCommit, historyObjects } from "./git-objects.mjs";

const root = mkdtempSync(join(tmpdir(), "history-scan-"));
after(() => rmSync(root, { recursive: true, force: true }));
git(root, ["init", "-q"]);
git(root, ["config", "user.name", "paseo-fleet contributors"]);
git(root, ["config", "user.email", "noreply@example.invalid"]);
const commit = message => {
  git(root, ["add", "."]);
  git(root, ["commit", "--allow-empty", "-qm", message]);
  return git(root, ["rev-parse", "HEAD"]).trim();
};
const leak = ["/", "home/", "somebody/private"].join("");
writeFileSync(join(root, "removed.md"), leak);
const first = commit("initial");
rmSync(join(root, "removed.md"));
writeFileSync(join(root, "safe.md"), "safe\n");
commit(["message ", leak].join(""));
const tip = commit("clean tip");
git(root, ["tag", "-a", "demo", "-m", ["tag ", leak].join("")]);

test("all reachable trees and messages are checked even when the tip is clean", () => {
  assert.equal(run(["--tree", tip, "--no-private-list"], {}, root).hits.length, 0);
  const result = run(["--history", tip, "--no-private-list"], {}, root);
  assert.ok(result.hits.some(hit => hit.path === "removed.md"));
  assert.ok(result.hits.some(hit => hit.path.startsWith("commit-object/")));
  assert.equal(result.scope.commits, 3);
  assert.equal(result.scope.trees, 2);
  assert.equal(result.scope.blobs, 2);
  assert.throws(() => run(["--history", tip, "safe.md", "--no-private-list"], {}, root), /cannot be narrowed/);
});

test("annotated tag messages and their complete commit ancestry are checked", () => {
  const result = run(["--history", "demo", "--no-private-list"], {}, root);
  assert.equal(result.scope.tags, 1);
  assert.equal(result.scope.commits, 3);
  assert.ok(result.hits.some(hit => hit.path.startsWith("tag-object/")));
});

test("history diagnostics contain only finding paths, types and counts, without finding object locators", () => {
  const script = join(dirname(fileURLToPath(import.meta.url)), "check-private.mjs");
  const result = spawnSync(process.execPath, [script, "--history", "demo", "--no-private-list"],
    { cwd: root, env: process.env, encoding: "utf8" });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /removed\.md:home-path \(1\)/);
  assert.match(result.stdout, /commit-metadata:home-path \(1\)/);
  assert.match(result.stdout, /tag-metadata:home-path \(1\)/);
  assert.doesNotMatch(result.stdout, new RegExp(first));
  assert.doesNotMatch(result.stdout, new RegExp(git(root, ["rev-parse", `${first}:removed.md`]).trim()));
  assert.ok(!result.stdout.includes(leak));
});

test("history reporting preserves every finding count when metadata objects are grouped", () => {
  const hits = [
    { path: `commit-object/${"a".repeat(40)}`, object: "a".repeat(40), rule: "private" },
    { path: `commit-object/${"b".repeat(40)}`, object: "b".repeat(40), rule: "private" },
    { path: `tag-object/${"c".repeat(40)}`, object: "c".repeat(40), rule: "card-code" },
    { path: "docs/validation/hourly-quota/chart.png", object: "d".repeat(40), rule: "forbidden-path" },
  ];
  const findings = summarizeHistoryFindings(hits);
  assert.deepEqual(findings, [
    { path: "commit-metadata", rule: "private", count: 2 },
    { path: "docs/validation/hourly-quota/chart.png", rule: "forbidden-path", count: 1 },
    { path: "tag-metadata", rule: "card-code", count: 1 },
  ]);
  assert.equal(findings.reduce((sum, hit) => sum + hit.count, 0), hits.length);
});

test("an export contains the exact target tree and no Git history", () => {
  const destination = join(root, "export");
  const result = exportCommit(root, first, destination);
  assert.equal(result.commit, first);
  assert.equal(result.files, 1);
  assert.equal(historyObjects(root, first).commits.size, 1);
});

test("non-public validation evidence is refused even under the documentation allowance", () => {
  assert.ok(scanFile("docs/validation/hourly-quota/report.md", "anonymous", loadRules())
    .some(hit => hit.rule === "forbidden-path"));
});

for (const extension of ["png", "mp4", "woff2"]) {
  test(`deleted forbidden ${extension} evidence remains rejected in reachable history`, () => {
    const repo = mkdtempSync(join(root, "ignored-evidence-"));
    git(repo, ["init", "-q"]);
    git(repo, ["config", "user.name", "paseo-fleet contributors"]);
    git(repo, ["config", "user.email", "noreply@example.invalid"]);
    const path = `docs/validation/hourly-quota/chart.${extension}`;
    mkdirSync(join(repo, "docs/validation/hourly-quota"), { recursive: true });
    writeFileSync(join(repo, path), Buffer.from([0, 1, 2, 3]));
    writeFileSync(join(repo, "safe.md"), "anonymous\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-qm", "anonymous evidence"]);
    git(repo, ["rm", path]);
    git(repo, ["commit", "-qm", "remove evidence"]);
    assert.equal(run(["--tree", "HEAD", "--no-private-list"], {}, repo).hits.length, 0);
    const result = run(["--history", "HEAD", "--no-private-list"], {}, repo);
    assert.equal(result.scope.commits, 2);
    assert.deepEqual(result.hits.map(hit => [hit.path, hit.line, hit.rule]), [[path, 0, "forbidden-path"]]);
  });
}
