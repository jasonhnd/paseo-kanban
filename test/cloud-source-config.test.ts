/// <reference types="node" />
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { assertLocalMirrorEligibility, LOCAL_MIRROR_PROJECTS, parseCloudRunner } from "../server/cloud-config";
import { parseConfig } from "../server/config";

const root = realpathSync(mkdtempSync(join(tmpdir(), "source-config-")));
const repo = join(root, "repo"); mkdirSync(repo);
execFileSync("git", ["init", "-q", repo]);
after(() => rmSync(root, { recursive: true, force: true }));
const profile = { role: "executor", provider: "codex", family: "openai", model: "gpt-6.1-sol" };
const config = () => parseCloudRunner("paseo-kanban", { enabled: true, source: "localMirror" });

test("local eligibility accepts executor candidates without accepting other pool roles", () => {
  const valid = { project: "paseo-kanban", repoRoot: repo, registeredRepoRoot: repo, config: config(), role: "executor", tags: ["cloud"] };
  for (const executor of [profile, { ...profile, provider: "grok", family: "xai", model: "grok-4.7" }]) {
    const candidate = { ...executor, role: "candidate", candidateFor: "executor" };
    assert.doesNotThrow(() => assertLocalMirrorEligibility({ ...valid, profile: candidate }));
    assert.throws(() => assertLocalMirrorEligibility({ ...valid, role: "reviewer", profile: candidate }), /local mirror/i);
    for (const role of ["reviewer", "batch", "personal", undefined]) {
      assert.throws(() => assertLocalMirrorEligibility({ ...valid, profile: { ...candidate, candidateFor: role } }), /local mirror/i);
      assert.throws(() => assertLocalMirrorEligibility({ ...valid, profile: { ...executor, role, candidateFor: "executor" } }), /local mirror/i);
    }
    for (const patch of [{ family: "other" }, { provider: "other" }, { model: "other-model" }]) {
      assert.throws(() => assertLocalMirrorEligibility({ ...valid, profile: { ...candidate, ...patch } }), /local mirror/i);
    }
  }
});

test("public source defaults remain unchanged and project admission is deferred to dispatch", () => {
  const value = parseCloudRunner("paseo-clear-chat", { enabled: true });
  assert.equal(value.source, "publicGithub");
  assert.equal(value.maxSourceBytes, 10 * 1024 * 1024);
  assert.equal(value.maxResultBytes, 10 * 1024 * 1024);
  assert.equal(parseCloudRunner("demo-web", { enabled: true }).enabled, true);
  assert.throws(() => parseCloudRunner("paseo-clear-chat", { source: "other" }));
  for (const maxSourceBytes of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => parseCloudRunner("paseo-kanban", { source: "localMirror", maxSourceBytes }));
  }
});

test("local source uses a static allowlist that configuration cannot extend", () => {
  assert.deepEqual(LOCAL_MIRROR_PROJECTS, ["paseo-kanban"]);
  assert.ok(Object.isFrozen(LOCAL_MIRROR_PROJECTS));
  for (const project of ["other", "renamed", "paseo-clear-chat"]) {
    assert.throws(() => parseCloudRunner(project, { enabled: true, source: "localMirror" }));
  }
  assert.throws(() => parseCloudRunner("paseo-kanban", { source: "localMirror", localMirrorProjects: ["other"] }));
  const parsed = parseConfig({ projects: { "paseo-kanban": { defaultWorkspace: "dir", workspacePath: repo,
    cloudRunner: { enabled: true, source: "localMirror", maxSourceBytes: 1234, maxResultBytes: 5678 } } } });
  assert.equal(parsed.projects!["paseo-kanban"].cloudRunner!.source, "localMirror");
  assert.equal(parsed.projects!["paseo-kanban"].cloudRunner!.maxResultBytes, 5678);
});

test("local eligibility requires the registered canonical root, opt-in, tag, role and profile", () => {
  const valid = { project: "paseo-kanban", repoRoot: repo, registeredRepoRoot: repo, config: config(), role: "executor", tags: ["cloud"], profile };
  assert.doesNotThrow(() => assertLocalMirrorEligibility(valid));
  assert.doesNotThrow(() => assertLocalMirrorEligibility({ ...valid, profile: { ...profile, provider: "grok", family: "xai", model: "grok-4.7" } }));
  const other = join(root, "other"); mkdirSync(other);
  const link = join(root, "link"); symlinkSync(repo, link);
  const child = join(repo, "child"); mkdirSync(child);
  for (const patch of [
    { project: "renamed" }, { repoRoot: other }, { registeredRepoRoot: undefined },
    { repoRoot: link }, { registeredRepoRoot: link, repoRoot: link },
    { repoRoot: child, registeredRepoRoot: child },
    { config: { ...config(), enabled: false } }, { config: { ...config(), source: "publicGithub" as const } },
    { tags: [] }, { role: "reviewer" }, { profile: { ...profile, role: "reviewer" } },
    { profile: { ...profile, provider: "other" } }, { profile: { ...profile, family: "xai" } },
    { profile: { ...profile, model: "" } },
  ]) assert.throws(() => assertLocalMirrorEligibility({ ...valid, ...patch }), /local mirror/i);
});


test("directory options preserve commands and reject invalid runtime or option types", () => {
  const directories = [{ path: ".", optional: false }, { path: "web", optional: true, testCommand: ["bun", "run", "test:cov"] }, { path: "pipeline", skipTest: true }];
  const parsed = parseCloudRunner("demo", { runtime: "bun", directories });
  assert.deepEqual(parsed.directories, directories);
  for (const options of [ { optional: "true" }, { skipTest: 1 }, { testCommand: ["npm", "test"] }, { testCommand: ["bun", "install"] }, { testCommand: ["bun", "run"] }, { testCommand: ["bun", "run", "bad\narg"] } ]) {
    assert.throws(() => parseCloudRunner("demo", { runtime: "bun", directories: [{ path: "web", ...options }] }));
  }
});

test("enabled Bun project configurations parse with the global allowlist and directory options", () => {
  const common = { enabled: true, runtime: "bun", bunVersion: "1.4.2", installBun: false,
    snapshot: "tpl-agent", templateRefreshedAt: "2026-10-23T00:00:00+09:00", maxParallel: 1,
    installCommand: ["bun", "install", "--frozen-lockfile"], testCommand: ["bun", "run", "test"] };
  const installCommand = common.installCommand;
  const proposals = {
    "demo-site": { ...common, nodeVersion: "24.20.0", directories: [
      { path: ".", installCommand, testCommand: ["bun", "run", "test"] },
      { path: "web", optional: true, installCommand, testCommand: ["bun", "run", "test:cov"] },
      { path: "pipeline", optional: true, installCommand, skipTest: true },
      { path: "astro", optional: true, installCommand, skipTest: true },
    ], environment: { BLOB_BASE_URL: "https://blob.example.com", SEO_LIVE_BASE: "" } },
    "demo-worker": { ...common, directories: [{ path: ".", installCommand, testCommand: ["bun", "run", "test"] }] },
  };
  for (const [project, cloudRunner] of Object.entries(proposals)) {
    const input = { cloud: { allowedProjects: Object.keys(proposals), maxMachines: 3 },
      projects: { [project]: { defaultWorkspace: "dir", ...(project === "demo-worker" ? { baseBranch: "preview" } : {}), cloudRunner } } };
    const parsed = parseConfig(JSON.parse(JSON.stringify(input)));
    assert.deepEqual(parsed.cloud!.allowedProjects, ["demo-site", "demo-worker"]);
    assert.equal(parsed.cloud!.maxMachines, 3);
    const runner = parsed.projects![project].cloudRunner!;
    for (const [field, expected] of Object.entries(cloudRunner)) {
      assert.deepEqual(runner[field as keyof typeof runner], expected, `${project}.${field}`);
    }
    assert.equal(runner.source, "publicGithub");
    if (project === "demo-worker") assert.equal(parsed.projects![project].baseBranch, "preview");
  }
});
