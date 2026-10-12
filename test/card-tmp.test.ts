/// <reference types="node" />
import { zhCNPart } from "./helpers/locale";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { cardTmpEnv, cardTmpGeneration, cardTmpRoot, TMP_GENERATION_FILE } from "../server/card-tmp";
import { closeDb, getDb } from "../server/db";
import { type AgentLauncher } from "../server/dispatch";
import { startTask } from "./helpers/compat-dispatch";
import { cardMark } from "../server/card-ref";
import type { Profile } from "../server/profiles";
import { appendEvent, createTask } from "../server/store";

const tmp = tmpdir();
mkdirSync(tmp, { recursive: true });
const dir = mkdtempSync(join(tmp, "card-tmp-"));
const tmpRoot = join(dir, "tmp-root");
process.env.KANBAN_DATA_DIR = dir;
process.env.KANBAN_TMP_ROOT = tmpRoot;

after(() => {
  closeDb();
  delete process.env.KANBAN_TMP_ROOT;
  rmSync(dir, { recursive: true, force: true });
});

const profile = (role: string): Profile => ({
  id: role, name: role, role, family: "anthropic", provider: "claude", model: "sonnet", pool: "claude-max",
});

describe("per-card TMPDIR", () => {
  it("defaults the root to /tmp and honors KANBAN_TMP_ROOT", () => {
    assert.equal(cardTmpRoot(), tmpRoot);
    delete process.env.KANBAN_TMP_ROOT;
    try {
      assert.equal(cardTmpRoot(), "/tmp");
    } finally {
      process.env.KANBAN_TMP_ROOT = tmpRoot;
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
    getDb().prepare("UPDATE tasks SET status = 'rework' WHERE id = ?").run(task.id);
    appendEvent(task.id, "request_changes", "running", "rework", "test", { reason: "demo fixture" });
    await startTask(task.id, launcher, "test", options);
    assert.equal(sends, 1);
  });
});
