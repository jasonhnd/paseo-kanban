/// <reference types="node" />
import { zhCNPart } from "./helpers/locale";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { after, describe, it, mock } from "node:test";
import { cardTmpEnv, cardTmpGeneration, cardTmpRoot, TMP_GENERATION_FILE } from "../server/card-tmp";
import { unifiedDataRoot } from "../server/storage/root";
import { closeDb, getDb } from "../server/db";
import { type AgentLauncher } from "../server/dispatch";
import { startTask } from "./helpers/compat-dispatch";
import { cardMark } from "../server/card-ref";
import type { Profile } from "../server/profiles";
import { appendEvent, createTask } from "../server/store";
import { KanbanError } from "../server/errors";

const tmp = tmpdir();
mkdirSync(tmp, { recursive: true });
const dir = mkdtempSync(join(tmp, "card-tmp-"));
const tmpRoot = join(dir, "tmp-root");
process.env.KANBAN_DATA_DIR = dir;
process.env.KANBAN_TMP_ROOT = tmpRoot;
// A red run against the old default must fail without writing real card roots.
// The owned fixture may sit inside the invoking card's `.kanban-work/<card>/`
// directory. Paths inside that fixture are the fixture. The same card-shaped
// path outside it stays refused, including /tmp/<card>, /private/tmp/<card>,
// and another `.kanban-work/<card>/` directory.
const realSystemCardRoot = /(?:^\/(?:private\/)?tmp\/[A-Za-z0-9]+_\d+(?:\/|$)|\.kanban-work\/(?:[^/]+\/)?[A-Za-z0-9]+_\d+(?:\/|$))/;
function ownedFixtureRoots(): string[] {
  const roots = new Set<string>([resolve(dir)]);
  try { roots.add(realpathSync(dir)); } catch { /* the fixture directory exists */ }
  for (const root of [...roots]) {
    if (root.startsWith("/private/tmp/")) roots.add(`/tmp/${root.slice("/private/tmp/".length)}`);
    else if (root.startsWith("/tmp/")) roots.add(`/private/tmp/${root.slice("/tmp/".length)}`);
  }
  return [...roots];
}
const ownedRoots = ownedFixtureRoots();
function isInsideOwnedFixture(target: string): boolean {
  const candidate = resolve(String(target));
  return ownedRoots.some(root => {
    const rel = relative(root, candidate);
    return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  });
}
const originalMkdir = fs.mkdirSync;
const mkdirGuard = mock.method(fs, "mkdirSync", (...args: Parameters<typeof fs.mkdirSync>) => {
  const target = String(args[0]);
  if (realSystemCardRoot.test(target) && !isInsideOwnedFixture(target)) throw new Error("test refused a real system card root");
  return Reflect.apply(originalMkdir, fs, args);
});
syncBuiltinESMExports();

after(() => {
  mkdirGuard.mock.restore();
  syncBuiltinESMExports();
  closeDb();
  delete process.env.KANBAN_TMP_ROOT;
  rmSync(dir, { recursive: true, force: true });
});

const profile = (role: string): Profile => ({
  id: role, name: role, role, family: "anthropic", provider: "claude", model: "sonnet", pool: "claude-max",
});

describe("per-card TMPDIR", () => {
  it("refuses a real system card root outside the owned fixture", () => {
    assert.throws(() => mkdirSync("/tmp/TEST_0099/external-card"), /test refused a real system card root/);
    assert.throws(() => mkdirSync("/private/tmp/TEST_0099/external-card"), /test refused a real system card root/);
    assert.throws(() => mkdirSync("/var/empty/.kanban-work/TEST_0099/external-card"), /test refused a real system card root/);
    assert.throws(() => mkdirSync("/var/empty/.kanban-work/other-project/TEST_0098/external-card"), /test refused a real system card root/);
    const sibling = resolve(dir, "..", "not-this-fixture");
    if (realSystemCardRoot.test(sibling)) {
      assert.throws(() => mkdirSync(sibling), /test refused a real system card root/);
    }
    const inside = join(dir, "owned-fixture-dir");
    mkdirSync(inside);
    assert.equal(statSync(inside).isDirectory(), true);
  });

  it("defaults to the project fallback under the plugin data root and honors KANBAN_TMP_ROOT", () => {
    assert.equal(cardTmpRoot(), tmpRoot);
    delete process.env.KANBAN_TMP_ROOT;
    try {
      assert.equal(cardTmpRoot(), join(unifiedDataRoot(), "work", "unassigned"));
    } finally {
      process.env.KANBAN_TMP_ROOT = tmpRoot;
    }
  });

  it("uses the configured project workspace, excludes scratch locally and isolates cards", () => {
    const repo = join(dir, "configured-repo");
    const other = join(dir, "card-copy");
    execFileSync("git", ["init", "-q", repo]);
    execFileSync("git", ["init", "-q", other]);
    writeFileSync(join(dir, "kanban.config.json"), JSON.stringify({
      projects: { demo: { defaultWorkspace: "dir", workspacePath: repo } },
    }));
    delete process.env.KANBAN_TMP_ROOT;
    try {
      const context = { project: "demo", workspacePath: other };
      const a = cardTmpEnv("TEST_0400", context);
      const b = cardTmpEnv("TEST_0401", context);
      assert.equal(a.KANBAN_TMP, join(realpathSync(repo), ".kanban-work", "TEST_0400"));
      assert.equal(b.KANBAN_TMP, join(realpathSync(repo), ".kanban-work", "TEST_0401"));
      assert.ok(cardTmpGeneration(a.KANBAN_TMP));
      cardTmpEnv("TEST_0400", context);
      const exclude = readFileSync(join(repo, ".git/info/exclude"), "utf8");
      assert.equal(exclude.split("\n").filter(line => line === ".kanban-work/").length, 1);
      assert.equal(execFileSync("git", ["status", "--short"], { cwd: repo, encoding: "utf8" }), "");
      assert.equal(existsSync(join(other, ".kanban-work")), false);
    } finally { process.env.KANBAN_TMP_ROOT = tmpRoot; }
  });

  it("falls back for a non-repository or unwritable project, never to the system temp root", () => {
    const home = join(dir, "fallback-home");
    const notGit = join(dir, "not-git");
    const readOnly = join(dir, "read-only-repo");
    mkdirSync(notGit);
    execFileSync("git", ["init", "-q", readOnly]);
    const homeMock = mock.method(os, "homedir", () => home);
    syncBuiltinESMExports();
    delete process.env.KANBAN_TMP_ROOT;
    chmodSync(readOnly, 0o500);
    try {
      for (const [project, workspacePath, code] of [
        ["plain", notGit, "TEST_0402"], ["readonly", readOnly, "TEST_0403"],
      ] as const) {
        const env = cardTmpEnv(code, { project, workspacePath });
        assert.equal(env.KANBAN_TMP, join(unifiedDataRoot(process.env, home), "work", project, code));
        assert.ok(cardTmpGeneration(env.KANBAN_TMP));
      }
    } finally {
      chmodSync(readOnly, 0o700);
      process.env.KANBAN_TMP_ROOT = tmpRoot;
      homeMock.mock.restore();
      syncBuiltinESMExports();
    }
  });

  it("makes <root>/<code> and returns TMPDIR with a trailing slash and KANBAN_TMP without", () => {
    const env = cardTmpEnv("TEST_0211");
    assert.deepEqual(env, { TMPDIR: `${tmpRoot}/TEST_0211/`, KANBAN_TMP: `${tmpRoot}/TEST_0211` });
    assert.ok(statSync(join(tmpRoot, "TEST_0211")).isDirectory());
    const generation = cardTmpGeneration(env.KANBAN_TMP);
    assert.ok(generation);
    assert.deepEqual(cardTmpEnv("TEST_0211"), env);
    assert.notEqual(cardTmpGeneration(env.KANBAN_TMP), generation, "a new start rotates the generation");
  });

  it("returns nothing for a card without a display code, and nothing creates a directory for it", () => {
    for (const code of ["#12", "", "../x", "TEST_0211/evil", "a b_1"]) assert.deepEqual(cardTmpEnv(code), {}, code);
    assert.equal(existsSync(join(tmpRoot, "#12")), false);
  });

  it("returns nothing when the directory cannot be made", () => {
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "file");
    process.env.KANBAN_TMP_ROOT = blocker;
    try {
      assert.deepEqual(cardTmpEnv("TEST_0300"), {});
    } finally {
      process.env.KANBAN_TMP_ROOT = tmpRoot;
    }
  });

  it("refuses to launch an agent when its explicit work root cannot be prepared", async () => {
    const blocker = join(dir, "start-blocker");
    writeFileSync(blocker, "file");
    process.env.KANBAN_TMP_ROOT = blocker;
    let creates = 0;
    const launcher: AgentLauncher = { async create() { creates++; return { id: "must-not-start" }; }, async send() {} };
    const task = createTask({ project: "tmpenv", title: "Unusable work root", role: "executor", workspacePath: `none:${dir}` });
    try {
      await assert.rejects(startTask(task.id, launcher, "test", { profiles: [profile("executor")], chosen: profile("executor"), reason: "Test" }),
        (err) => err instanceof KanbanError && err.code === "workspace_missing");
      assert.equal(creates, 0, "never inherit a process default directory when preparation fails");
    } finally { process.env.KANBAN_TMP_ROOT = tmpRoot; }
  });

  it("falls back when a local exclude is unwritable or the project work root is a symlink", () => {
    const home = join(dir, "unsafe-home");
    const outside = join(dir, "unsafe-target");
    mkdirSync(outside);
    const homeMock = mock.method(os, "homedir", () => home);
    syncBuiltinESMExports();
    delete process.env.KANBAN_TMP_ROOT;
    try {
      for (const [project, code] of [["exclude", "TEST_0410"], ["symlink", "TEST_0411"]] as const) {
        const repo = join(dir, project + "-repo");
        execFileSync("git", ["init", "-q", repo]);
        const exclude = join(repo, ".git/info/exclude");
        if (project === "exclude") chmodSync(exclude, 0o400);
        else symlinkSync(outside, join(repo, ".kanban-work"));
        const env = cardTmpEnv(code, { project, workspacePath: repo });
        assert.equal(env.KANBAN_TMP, join(unifiedDataRoot(process.env, home), "work", project, code));
        assert.equal(existsSync(join(outside, code)), false);
        chmodSync(exclude, 0o600);
      }
    } finally {
      process.env.KANBAN_TMP_ROOT = tmpRoot;
      homeMock.mock.restore(); syncBuiltinESMExports();
    }
  });

  it("does not follow directory or generation-marker symlinks", () => {
    const outside = join(dir, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(tmpRoot, "TEST_0301"));
    assert.deepEqual(cardTmpEnv("TEST_0301"), {});
    assert.equal(existsSync(join(outside, TMP_GENERATION_FILE)), false);
    const target = join(outside, "keep.txt");
    writeFileSync(target, "must survive");
    const path = join(tmpRoot, "TEST_0302");
    mkdirSync(path);
    symlinkSync(target, join(path, TMP_GENERATION_FILE));
    assert.deepEqual(cardTmpEnv("TEST_0302"), {});
    assert.equal(readFileSync(target, "utf8"), "must survive");
    assert.throws(() => cardTmpGeneration(path));
  });

  it("gives every newly started role agent TMPDIR=<root>/<its card code>/", async () => {
    const work = join(dir, "work");
    mkdirSync(work, { recursive: true });
    for (const role of ["executor", "batch", "reader"]) {
      const envs: Array<Record<string, string> | undefined> = [];
      const launcher: AgentLauncher = {
        async create(options) {
          envs.push(options.env);
          return { id: `agent-${role}` };
        },
        async send() {},
      };
      const task = createTask({ project: "tmpenv", title: `Deliver ${role}`, role, workspacePath: `none:${work}` });
      await startTask(task.id, launcher, "test", { profiles: [profile(role)], chosen: profile(role), reason: "Test" });
      const code = cardMark(task.id);
      assert.match(code, /^[A-Za-z0-9]+_\d{4}$/);
      assert.equal(envs[0]?.TMPDIR, `${tmpRoot}/${code}/`, role);
      assert.equal(envs[0]?.KANBAN_TMP, `${tmpRoot}/${code}`, role);
      assert.equal(envs[0]?.KANBAN_ROLE, role);
      assert.ok(statSync(join(tmpRoot, code)).isDirectory(), role);
    }
  });

  it("rotates the generation before resuming the original executor", async () => {
    const work = join(dir, "resume-work");
    mkdirSync(work);
    const task = createTask({ project: "tmpenv", title: "Rework generation", role: "executor", workspacePath: `none:${work}` });
    const path = join(tmpRoot, cardMark(task.id));
    let generation: string | null = null;
    let sends = 0;
    const launcher: AgentLauncher = {
      async create() { return { id: "resume-executor" }; },
      async send() {
        sends++;
        assert.notEqual(cardTmpGeneration(path), generation);
      },
    };
    const options = { profiles: [profile("executor")], chosen: profile("executor"), reason: "Test" };
    await startTask(task.id, launcher, "test", options);
    generation = cardTmpGeneration(path);
    assert.ok(generation);
    process.env.KANBAN_TMP_ROOT = join(dir, "changed-root");
    getDb().prepare("UPDATE tasks SET status = 'rework' WHERE id = ?").run(task.id);
    appendEvent(task.id, "request_changes", "running", "rework", "test", { reason: "demo fixture" });
    try {
      await startTask(task.id, launcher, "test", options);
      assert.equal(sends, 1);
      assert.equal(existsSync(join(process.env.KANBAN_TMP_ROOT, cardMark(task.id))), false);
    } finally { process.env.KANBAN_TMP_ROOT = tmpRoot; }
  });

  it("uses Git's shared info/exclude for a linked project workspace", () => {
    const repo = join(dir, "linked-source");
    const linked = join(dir, "linked-project");
    execFileSync("git", ["init", "-q", repo]);
    execFileSync("git", ["-C", repo, "-c", "user.name=paseo-fleet contributors", "-c", "user.email=noreply@example.invalid", "commit", "--allow-empty", "-qm", "fixture"]);
    execFileSync("git", ["-C", repo, "worktree", "add", "--detach", linked]);
    const prior = process.env.KANBAN_TMP_ROOT;
    delete process.env.KANBAN_TMP_ROOT;
    try {
      const env = cardTmpEnv("TEST_0404", { workspacePath: linked });
      assert.equal(env.KANBAN_TMP, join(realpathSync(linked), ".kanban-work", "TEST_0404"));
      assert.match(readFileSync(join(repo, ".git/info/exclude"), "utf8"), /^\.kanban-work\/$/m);
      assert.equal(execFileSync("git", ["status", "--short"], { cwd: linked, encoding: "utf8" }), "");
    } finally { process.env.KANBAN_TMP_ROOT = prior; }
  });
});
