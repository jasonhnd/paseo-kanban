/// <reference types="node" />
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import privacyRules from "../shared/privacy-rules.mjs";
import { occurrenceFingerprint } from "../server/privacy-scanner.mjs";
import { createSourceSnapshot, scanOutbound } from "../server/cloud-source";

const policy = privacyRules as { publicOccurrenceLiterals: string[]; reviewedOccurrences: Array<{
  path: string; rule: string; index: number; length: number; fingerprint: string;
}> };
const root = realpathSync(mkdtempSync(join(tmpdir(), "cloud-source-")));
const savedList = process.env.FLEET_PRIVATE_DENYLIST;
const list = join(root, "denylist.txt"); writeFileSync(list, "SourcePrivateFixture\n");
process.env.FLEET_PRIVATE_DENYLIST = list;
after(() => { process.env.FLEET_PRIVATE_DENYLIST = savedList; if (savedList === undefined) delete process.env.FLEET_PRIVATE_DENYLIST; rmSync(root, { recursive: true, force: true }); });
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8",
  env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Original fixture author",
    GIT_AUTHOR_EMAIL: "original@example.invalid", GIT_COMMITTER_NAME: "Original fixture author", GIT_COMMITTER_EMAIL: "original@example.invalid" },
  stdio: ["pipe", "pipe", "pipe"] }).trim();
function fixture(files: Record<string, string | Buffer> = { "file.txt": "clean\n" }) {
  const repo = mkdtempSync(join(root, "repo-")); git(repo, "init", "-b", "main");
  for (const [name, body] of Object.entries(files)) { const path = join(repo, name); mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, body); }
  git(repo, "add", "."); git(repo, "commit", "-m", "Original private message");
  return { repoRoot: repo, baseCommit: git(repo, "rev-parse", "HEAD"), tree: git(repo, "rev-parse", "HEAD^{tree}") };
}
const outbound = (f: ReturnType<typeof fixture>, patch = {}) => scanOutbound({ repoRoot: f.repoRoot, tree: f.tree,
  brief: "Implement the fixture.", feedback: "", environment: {}, ...patch });

test("snapshot is an anonymous parentless exact tree and clones into an empty repository", async () => {
  const f = fixture({ "file.txt": "first\n", "run.sh": "#!/bin/sh\nexit 0\n" });
  chmodSync(join(f.repoRoot, "run.sh"), 0o755); git(f.repoRoot, "add", "."); git(f.repoRoot, "commit", "-m", "Another original message");
  f.baseCommit = git(f.repoRoot, "rev-parse", "HEAD"); f.tree = git(f.repoRoot, "rev-parse", "HEAD^{tree}");
  const originalRefs = git(f.repoRoot, "show-ref");
  writeFileSync(join(f.repoRoot, "untracked.txt"), "SourcePrivateFixture");
  writeFileSync(join(f.repoRoot, "file.txt"), "SourcePrivateFixture");
  git(f.repoRoot, "config", "remote.origin.url", "https://example.invalid/private.git");
  const scratchDir = join(root, "snapshot"); mkdirSync(scratchDir);
  const snapshot = await createSourceSnapshot({ ...f, scratchDir });
  assert.equal(snapshot.sourceBase, f.baseCommit); assert.equal(snapshot.tree, f.tree);
  assert.equal(snapshot.bytes, readFileSync(snapshot.bundlePath).length);
  assert.equal(snapshot.sha256, createHash("sha256").update(readFileSync(snapshot.bundlePath)).digest("hex"));
  const clone = join(root, "clone"); git(root, "clone", snapshot.bundlePath, clone);
  assert.equal(git(clone, "rev-parse", "HEAD"), snapshot.snapshotCommit);
  assert.equal(git(clone, "rev-parse", "HEAD^{tree}"), f.tree);
  assert.equal(git(clone, "rev-list", "--count", "--all"), "1");
  assert.equal(git(clone, "rev-list", "--parents", "HEAD"), snapshot.snapshotCommit);
  const commit = git(clone, "cat-file", "commit", "HEAD");
  assert.doesNotMatch(commit, /Original|original@|private message/);
  assert.match(commit, /noreply@github\.com/);
  assert.equal(git(clone, "ls-tree", "-r", "HEAD"), git(f.repoRoot, "ls-tree", "-r", f.baseCommit));
  assert.equal(git(f.repoRoot, "show-ref"), originalRefs);
  assert.equal(git(clone, "show", "HEAD:file.txt"), "first");
  assert.deepEqual(outbound(f), []);
});

test("snapshot requires a pinned full commit id and an empty scratch directory", async () => {
  const f = fixture(); const scratchDir = join(root, "invalid"); mkdirSync(scratchDir);
  await assert.rejects(async () => createSourceSnapshot({ ...f, baseCommit: "HEAD", scratchDir }));
  writeFileSync(join(scratchDir, "existing"), "keep");
  await assert.rejects(async () => createSourceSnapshot({ ...f, scratchDir }));
  assert.equal(readFileSync(join(scratchDir, "existing"), "utf8"), "keep");
});

test("the whole pinned tree is scanned including unchanged, ignored-extension and binary content", () => {
  for (const [path, content] of [
    ["unchanged.txt", "SourcePrivateFixture"], ["package-lock.json", "SourcePrivateFixture"],
    ["image.png", Buffer.from("\0SourcePrivateFixture")], ["unicode.txt", Buffer.from("SourcePrivateFixture", "utf16le")],
  ] as const) {
    const f = fixture({ [path]: content, "change.txt": "before" });
    writeFileSync(join(f.repoRoot, "change.txt"), "after");
    assert.ok(outbound(f).some(finding => finding.rule === "private"));
  }
});

test("brief, feedback, environment keys and values use the same complete privacy rules", () => {
  const f = fixture();
  const card = ["REAL", "_0123"].join("");
  const samples = ["SourcePrivateFixture", ["/Users", "personal", "repo"].join("/"), ["/home", "personal"].join("/"),
    card, ["SB", "20261022", "18"].join("-"), ["HAF", "private"].join("-"),
    ["sk-", "a".repeat(32)].join(""), ["xoxb-", "a".repeat(24)].join(""),
    ["Bearer ", "a".repeat(30)].join(""), ["https://example.invalid/?token=", "a".repeat(20)].join(""),
    ["person", "@", "mail.test.org"].join("")];
  for (const secret of samples) {
    for (const patch of [{ brief: secret }, { feedback: secret }, { environment: { DEMO_VALUE: secret } }]) {
      const findings = outbound(f, patch);
      assert.ok(findings.length, JSON.stringify({ patch }));
      assert.ok(!JSON.stringify(findings).includes(secret), "findings never echo refused content");
    }
  }
  assert.ok(outbound(f, { environment: { SourcePrivateFixture: "safe" } }).length);
});

test("paths and file modes cannot bypass the outbound gate", () => {
  for (const path of [".local-evidence/a.png", "notebook.md", "handoff/receipt.md", "SourcePrivateFixture.txt",
    ["REAL", "_0123.txt"].join(""), ["/Users", "personal", "repo"].join("/").slice(1)]) {
    assert.ok(outbound(fixture({ [path]: "" })).length, path);
  }
  const f = fixture(); const blob = git(f.repoRoot, "rev-parse", "HEAD:file.txt");
  git(f.repoRoot, "update-index", "--add", "--cacheinfo", `120000,${blob},link`);
  f.tree = git(f.repoRoot, "write-tree");
  assert.ok(outbound(f).some(finding => finding.rule === "unsupported-mode"));
  git(f.repoRoot, "update-index", "--add", "--cacheinfo", `160000,${f.baseCommit},submodule`);
  f.tree = git(f.repoRoot, "write-tree");
  assert.ok(outbound(f).some(finding => finding.rule === "unsupported-mode"));
});

test("empty tree directories are scanned as paths too", () => {
  const f = fixture();
  const empty = execFileSync("git", ["-C", f.repoRoot, "mktree"], { input: "", encoding: "utf8" }).trim();
  f.tree = execFileSync("git", ["-C", f.repoRoot, "mktree"], { input: `040000 tree ${empty}\t.local-evidence\n`, encoding: "utf8" }).trim();
  assert.ok(outbound(f).some(finding => finding.rule === "private-evidence"));
});

test("locale Chinese is allowed while missing rules, missing objects and malformed inputs fail closed", () => {
  const f = fixture({ "shared/locales/zh-CN.json": JSON.stringify({ title: "\u770b\u677f" }) });
  assert.deepEqual(outbound(f), []);
  assert.ok(outbound(f, { tree: "0".repeat(40) }).length);
  assert.ok(outbound(f, { feedback: null }).length);
  process.env.FLEET_PRIVATE_DENYLIST = join(root, "absent");
  assert.ok(outbound(f).some(finding => finding.rule === "scan-unavailable"));
  writeFileSync(list, "/[invalid/\n"); process.env.FLEET_PRIVATE_DENYLIST = list;
  assert.ok(outbound(f).some(finding => finding.rule === "scan-unavailable"));
  writeFileSync(list, "SourcePrivateFixture\n");
});

test("a truncated Git blob batch fails closed", () => {
  const f = fixture(); const tools = mkdtempSync(join(root, "tools-"));
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  writeFileSync(join(tools, "package.json"), '{"type":"commonjs"}\n');
  const command = join(tools, "git");
  writeFileSync(command, `#!${process.execPath}\nconst cp=require('node:child_process');const args=process.argv.slice(2);if(args.includes('--batch')){process.stdout.write('truncated');}else{const r=cp.spawnSync(${JSON.stringify(realGit)},args,{stdio:'inherit'});process.exit(r.status??1);}\n`);
  chmodSync(command, 0o755);
  const previous = process.env.PATH; process.env.PATH = `${tools}:${previous}`;
  try { assert.ok(outbound(f).some(finding => finding.rule === "scan-unavailable")); }
  finally { process.env.PATH = previous; }
});


test("outbound placeholder rules keep real paths and ticket formats blocked", () => {
  for (const body of [
    ["/Users", "example", "project"].join("/"), ["/home", "example"].join("/"),
    ["ABC", "_0031"].join(""),
  ]) assert.deepEqual(outbound(fixture({ "demo.txt": body })), []);
  for (const body of [
    ["/Users", "example-person", "project"].join("/"), ["/home", "personal"].join("/"),
    ["/home", "example", "..", "personal"].join("/"),
    ["C:", "Users", "personal"].join(String.fromCharCode(92)),
    ["REAL", "_123456"].join(""), ["SB", "20261022", "18"].join("-"),
    ["HAF", "personal"].join("-"),
    ["HTTPS://", "real-person", ":", "real-password", "@example.invalid"].join(""),
  ]) assert.ok(outbound(fixture({ "demo.txt": body })).length);
});


test("runtime reuses shipped exact approvals and changed lines, paths and metadata still refuse", () => {
  const approval = policy.reviewedOccurrences.find(item => item.rule === "credential")!;
  const source = readFileSync(new URL(`../${approval.path}`, import.meta.url), "utf8");
  const line = source.split("\n").find(value => occurrenceFingerprint(approval.path, value,
    { index: approval.index, 0: value.slice(approval.index, approval.index + approval.length) }, approval.rule) === approval.fingerprint)!;
  assert.ok(line);
  assert.deepEqual(outbound(fixture({ [approval.path]: line })), []);
  for (const files of [{ [approval.path]: line + " // changed" }, { "other.test.ts": line }]) {
    assert.ok(outbound(fixture(files)).some(hit => hit.rule === "credential"));
  }
  const approved = fixture({ [approval.path]: line });
  assert.ok(outbound(approved, { brief: line }).some(hit => hit.rule === "credential"));
  assert.ok(outbound(approved, { feedback: line }).some(hit => hit.rule === "credential"));
  assert.ok(outbound(approved, { environment: { DEMO: line } }).some(hit => hit.rule === "credential"));
  writeFileSync(list, "SourcePrivateFixture\nvalue\n");
  try { assert.ok(outbound(approved).some(hit => hit.rule === "private"), "an approved credential span never exempts another private match"); }
  finally { writeFileSync(list, "SourcePrivateFixture\n"); }
});

test("runtime reuses public-name path approvals for explicit directory entries", () => {
  const literal = policy.publicOccurrenceLiterals[0];
  writeFileSync(list, `SourcePrivateFixture\n${literal}\n`);
  try {
    assert.deepEqual(outbound(fixture({ [`integrations/${literal}/memory_bridge.py`]: "clean" })), []);
    assert.ok(outbound(fixture({ [`integrations/${literal}-other/memory_bridge.py`]: "clean" })).some(hit => hit.rule === "private"));
  } finally { writeFileSync(list, "SourcePrivateFixture\n"); }
});
