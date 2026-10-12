/// <reference types="node" />
import { zhCN } from "./helpers/locale";
import assert from "node:assert/strict";
import cp from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { transpileModule, ModuleKind, ScriptTarget } from "typescript";
import type { PaseoApi } from "@getpaseo/client";
import type { DoctorGit, DoctorSources } from "../server/doctor";

// Reuse the schema, but open only :memory:. All runtime filesystem calls below are fake.
const schema = fs.readFileSync(new URL("../server/db.ts", import.meta.url), "utf8").match(/const SCHEMA = `([\s\S]*?)`;/)?.[1];
assert.ok(schema);
let db: DatabaseSync;
mock.module(new URL("../server/db.ts", import.meta.url).href, {
  namedExports: { getDb: () => db, getReadOnlyDb: () => db, closeDb: () => {} },
});
// Prove the inherited doctor fixes catch the original bugs without editing the live checkout.
// Transpile a reverted copy in memory; its dependencies still resolve to the same mocked DB/fs.
const regression = process.env.TEST_EDGE_REGRESSION;
if (regression) {
  const file = regression === "transient_unchecked" ? "transient-retry.ts"
    : regression === "repo_complete" ? "doctor.ts" : "doctor-live.ts";
  const url = new URL(`../server/${file}`, import.meta.url);
  let source = fs.readFileSync(url, "utf8");
  const replacements: Record<string, [string, string]> = {
    repo_scan: ["let listedOk = collected.missing.length === 0;", "let listedOk = true;"],
    repo_complete: ["if ((sources.missingRepos ?? []).length > 0) return false;", "// Old logic considered the remaining repositories complete."],
    placeholder_exists: ['const readme = join(dir, PLACEHOLDER_NAME);', 'const readme = join(dir, PLACEHOLDER_NAME); if (!existsSync(readme)) return null;'],
    transient_unchecked: [
      'const current = getTask(task.id);\n  if (current.status !== "blocked" || current.blocked_kind !== "transient") return;\n  if (current.blocked_at !== task.blocked_at || current.agent_id !== task.agent_id) return;',
      "// Old logic did not recheck the wait after delivery.",
    ],
  };
  assert.ok(replacements[regression], `unknown regression mode ${regression}`);
  const [from, to] = replacements[regression];
  assert.ok(source.includes(from));
  source = source.replace(from, to).replace(/from "([^"]+)"/g, (_match, path: string) => {
    const resolved = path.startsWith(".") ? new URL(path + ".ts", url).href
      : path.startsWith("node:") ? path : import.meta.resolve(path);
    return `from "${resolved}"`;
  });
  const js = transpileModule(source, { compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 } }).outputText;
  const reverted = await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);
  mock.module(url.href, { namedExports: { ...reverted } });
}
const { collectLiveSources, collectRepoRoots } = await import("../server/doctor-live");
const { runDoctor } = await import("../server/doctor");
const { loadConfig, doctorSettings } = await import("../server/config");
const { setAgentAliveCheck, resetAgentAliveCheck } = await import("../server/alive");
const { setWakeSender } = await import("../server/bus");
const { blockTask, unblockTask, appendEvent, getTask } = await import("../server/store");
const { retryTransientBlocks } = await import("../server/transient-retry");

const ROOT = join(fs.realpathSync(tmpdir()), "virtual-test-0073");
const REPO = join(ROOT, "repos", "configured");
const TREES = join(ROOT, "worktrees");
const PROJECT = join(TREES, "project");
const TREE = join(PROJECT, "orphan");
const PLACE = join(PROJECT, "placeholder");
const README = join(PLACE, "README-placeholder.txt");
const NOW = new Date("2026-10-01T03:00:00.000Z");
const files = new Map<string, string>();
const directories = new Set<string>();
const denied = new Map<string, string>();
const envKeys = ["KANBAN_DATA_DIR", "KANBAN_AGENTIC_ROOT", "KANBAN_AGENTS_DIR", "KANBAN_WORKTREES_ROOT", "KANBAN_DOCTOR_BOARD_FAIL"];
let oldEnv: Array<string | undefined>;
let wakes: string[];
let gitCalls: string[];
let repoStatCalls: number;

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

const emptyPage = { entries: [], pageInfo: { nextCursor: null } };
const paseo = {
  workspaces: { list: async () => emptyPage },
  agents: { list: async () => emptyPage },
} as unknown as PaseoApi;

function fakeGit(repos: string[] = [REPO]): DoctorGit {
  return {
    repos,
    worktrees: async () => [{ path: TREE, branch: "docs/topic" }],
    dirty: async () => false,
    branches: async () => [],
    pushed: async () => true,
    pr: async () => "merged",
  };
}

async function diagnose(sources: DoctorSources) {
  return runDoctor({ now: NOW, sources: { ...sources, board: {
    plugin: "running", quota: "fresh", quotaAgeMs: 0, matrix: "ok", matrixAgeMs: 0,
    tickAt: NOW.toISOString(), missingCwdCount: 0,
  } }, settings: doctorSettings(null), wake: true, persist: true });
}

async function collect() {
  return collectLiveSources(paseo, Date.now(), Date.now() + 5_000);
}

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(schema);
  files.clear(); directories.clear(); denied.clear();
  wakes = []; gitCalls = []; repoStatCalls = 0;
  oldEnv = envKeys.map((key) => process.env[key]);
  process.env.KANBAN_DATA_DIR = join(ROOT, "data");
  process.env.KANBAN_AGENTIC_ROOT = join(ROOT, "repos");
  process.env.KANBAN_AGENTS_DIR = join(ROOT, "agents");
  process.env.KANBAN_WORKTREES_ROOT = TREES;
  process.env.KANBAN_DOCTOR_BOARD_FAIL = "1";
  directories.add(REPO); directories.add(TREES); directories.add(PROJECT); directories.add(TREE);
  directories.add(process.env.KANBAN_AGENTS_DIR);
  files.set(join(ROOT, "data", "kanban.config.json"), JSON.stringify({
    supervisorAgentId: "boss", supervisors: { edge: "boss" }, transientRetryMinutes: 1, transientRetryLimit: 1,
    projects: { configured: { defaultWorkspace: "dir", baseBranch: "main", code: "EDGE" } },
  }));
  mock.method(fs, "realpathSync", (path: fs.PathLike) => String(path));
  mock.method(fs, "existsSync", (path: fs.PathLike) => !denied.has(String(path)) && (files.has(String(path)) || directories.has(String(path))));
  mock.method(fs, "statSync", (path: fs.PathLike) => {
    const key = String(path);
    if (key === REPO) repoStatCalls += 1;
    if (denied.has(key)) throw errno(denied.get(key)!);
    if (!files.has(key) && !directories.has(key)) throw errno("ENOENT");
    return { isDirectory: () => directories.has(key) } as fs.Stats;
  });
  mock.method(fs, "readFileSync", (path: fs.PathOrFileDescriptor) => {
    const key = String(path);
    if (denied.has(key)) throw errno(denied.get(key)!);
    const value = files.get(key);
    if (value == null) throw errno("ENOENT");
    return value;
  });
  mock.method(fs, "writeFileSync", (path: fs.PathOrFileDescriptor, text: unknown) => { files.set(String(path), String(text)); });
  mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
    const source = String(from);
    const target = String(to);
    if (files.has(source)) {
      files.set(target, files.get(source)!);
      files.delete(source);
      return;
    }
    if (directories.has(source)) {
      directories.delete(source);
      directories.add(target);
      return;
    }
    throw errno("ENOENT");
  });
  mock.method(fs, "unlinkSync", (path: fs.PathLike) => { files.delete(String(path)); });
  mock.method(fs, "mkdirSync", () => undefined);
  mock.method(fs, "readdirSync", (path: fs.PathLike, options?: { withFileTypes?: boolean } | string) => {
    const key = String(path);
    if (denied.has(key)) throw errno(denied.get(key)!);
    if (!directories.has(key)) throw errno("ENOENT");
    const children = [...directories, ...files.keys()].filter((name) => name.startsWith(key + "/") && !name.slice(key.length + 1).includes("/"));
    return children.map((name) => options && typeof options === "object" && options.withFileTypes
      ? { name: name.slice(key.length + 1), isDirectory: () => directories.has(name) } : name.slice(key.length + 1));
  });
  mock.method(cp, "execFile", (...args: unknown[]) => {
    const [cmd, argv, options, callback] = args as [string, string[], { cwd?: string }, (err: Error | null, stdout: string, stderr: string) => void];
    assert.equal(cmd, "git", "no real command may run");
    gitCalls.push(`${options.cwd}:${argv.join(" ")}`);
    const output = argv[0] === "worktree" ? `worktree ${TREE}\nbranch refs/heads/docs/topic\n` : "";
    callback(null, output, "");
    return {} as cp.ChildProcess;
  });
  syncBuiltinESMExports();
  setAgentAliveCheck(() => true);
  setWakeSender((_id, text) => { wakes.push(text); });
});

afterEach(() => {
  resetAgentAliveCheck();
  setWakeSender(() => {});
  mock.restoreAll();
  syncBuiltinESMExports();
  envKeys.forEach((key, i) => { if (oldEnv[i] == null) delete process.env[key]; else process.env[key] = oldEnv[i]; });
  db.close();
});

describe("doctor fake metadata regressions", { concurrency: 1 }, () => {
  for (const failure of ["ENOENT", "EACCES"]) {
    it(`keeps old worktree alerts through configured repo ${failure}, without a stray or repeat wake`, async () => {
      const first = await diagnose({ git: fakeGit(), dirs: { root: TREES, worktrees: [TREE], list: () => [TREE], placeholderAgents: () => null } });
      const id = `git:worktree:${TREE}`;
      assert.ok(first.alertedIds.includes(id));
      assert.equal(wakes.length, 1);
      if (failure === "ENOENT") {
        // A missing checkout remains required while this project has an unfinished card.
        db.prepare(`INSERT INTO tasks (project, title, role, status, created_at, updated_at)
          VALUES ('configured', 'unfinished', 'executor', 'ready', ?, ?)`).run(NOW.toISOString(), NOW.toISOString());
        directories.delete(REPO);
      } else denied.set(REPO, failure);
      const collected = await collect();
      assert.deepEqual(collected.missingRepos, [{ project: "configured", path: REPO }]);
      assert.equal(collected.dirs?.scanned, false);
      assert.equal(gitCalls.length, 0);
      const middle = await diagnose(collected);
      assert.ok(middle.alertedIds.includes(id));
      assert.ok(middle.findings.some((finding) => finding.id === "check:worktree:configured"));
      assert.equal(middle.findings.some((finding) => finding.id.startsWith("dir:stray:")), false);
      // Even a caller supplying a completed directory snapshot must not claim missing git was complete.
      const partial = await diagnose({ ...collected, dirs: { root: TREES, worktrees: [TREE], list: () => [], placeholderAgents: () => null } });
      assert.ok(partial.alertedIds.includes(id));
      denied.delete(REPO); directories.add(REPO);
      const recovered = await collect();
      recovered.git = fakeGit(recovered.git?.repos);
      const back = await diagnose(recovered);
      assert.ok(back.alertedIds.includes(id));
      assert.equal(wakes.length, 1);
    });
  }

  it("treats statSync EACCES as incomplete even when existsSync reports true", async () => {
    denied.set(REPO, "EACCES");
    mock.method(fs, "realpathSync", (path: fs.PathLike) => String(path));
  mock.method(fs, "existsSync", (path: fs.PathLike) => String(path) === REPO);
    syncBuiltinESMExports();
    assert.deepEqual(collectRepoRoots().missing, [{ project: "configured", path: REPO }]);
    assert.ok(repoStatCalls > 0);
  });

  for (const failure of ["EACCES", "ENOTDIR"]) {
    it(`keeps a placeholder alert when its metadata/read is ${failure}, then recovers without waking`, async () => {
      directories.delete(TREE); directories.add(PLACE);
      files.set(README, ("agent" + zhCN("common.colon") + "gone-agent\n"));
      // No configured repository for this directory-only scan.
      files.set(join(ROOT, "data", "kanban.config.json"), JSON.stringify({ supervisorAgentId: "boss", projects: {} }));
      const first = await diagnose(await collect());
      const id = `dir:placeholder:${PLACE}`;
      assert.ok(first.alertedIds.includes(id));
      assert.equal(wakes.length, 1);
      denied.set(README, failure);
      const unread = await collect();
      assert.equal(unread.dirs?.placeholderAgents(PLACE), "unknown");
      const middle = await diagnose(unread);
      assert.ok(middle.alertedIds.includes(id));
      assert.equal(middle.findings.some((finding) => finding.id.startsWith("dir:stray:")), false);
      denied.delete(README);
      const back = await diagnose(await collect());
      assert.ok(back.alertedIds.includes(id));
      assert.equal(wakes.length, 1);
      files.delete(README);
      assert.equal((await collect()).dirs?.placeholderAgents(PLACE), null, "only ENOENT means no placeholder");
    });
  }
});

describe("transient exhaustion in-flight regressions", { concurrency: 1 }, () => {
  beforeEach(() => {
    directories.add(ROOT);
    directories.add(join(ROOT, "agents", "bucket"));
    files.set(join(ROOT, "agents", "bucket", "worker.json"), JSON.stringify({ id: "worker", cwd: ROOT, archivedAt: null }));
    db.prepare(`INSERT INTO tasks (id, project, title, role, status, agent_id, blocked_kind, blocked_at, blocked_from, blocked_reason, created_at, updated_at)
      VALUES (1, 'edge', 'waiting', 'executor', 'blocked', 'worker', 'transient', ?, 'running', 'old wait', ?, ?)`).run(NOW.toISOString(), NOW.toISOString(), NOW.toISOString());
    appendEvent(1, "blocked", "running", "blocked", "test", { kind: "transient" });
    appendEvent(1, "transient_retry", "blocked", "running", "test", { attempt: 1 });
  });

  for (const change of ["status", "kind", "blockedAt", "agentId", "manual reblock"] as const) {
    it(`does not stamp the new wait after ${change} changes during leader delivery`, async () => {
      const freshAt = new Date(NOW.getTime() + 10 * 60_000);
      await retryTransientBlocks(freshAt, loadConfig(), async (id) => {
        assert.equal(id, "boss");
        if (change === "manual reblock") {
          unblockTask(1, "supervisor");
          blockTask(1, "transient", "new wait", "executor");
          db.prepare("UPDATE tasks SET blocked_at = ? WHERE id = 1").run(freshAt.toISOString());
        } else {
          const columns = { status: "status", kind: "blocked_kind", blockedAt: "blocked_at", agentId: "agent_id" };
          const values = { status: "running", kind: "needs_human", blockedAt: freshAt.toISOString(), agentId: "replacement" };
          db.prepare(`UPDATE tasks SET ${columns[change]} = ? WHERE id = 1`).run(values[change]);
        }
      });
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'transient_exhausted'").get()?.n, 0);
      if (change === "manual reblock") {
        const prompts: string[] = [];
        await retryTransientBlocks(new Date(freshAt.getTime() + 60_000), loadConfig(), async (id, text) => {
          assert.equal(id, "worker"); prompts.push(text);
        });
        assert.equal(prompts.length, 1, "the fresh episode must still receive its first retry");
        assert.equal(getTask(1).status, "running");
      }
    });
  }

  it("records exhaustion once when the same wait survives delivery", async () => {
    let deliveries = 0;
    const send = async () => { deliveries += 1; };
    await retryTransientBlocks(new Date(NOW.getTime() + 120_000), loadConfig(), send);
    await retryTransientBlocks(new Date(NOW.getTime() + 180_000), loadConfig(), send);
    assert.equal(deliveries, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'transient_exhausted'").get()?.n, 1);
    assert.equal(getTask(1).status, "blocked");
  });
});
