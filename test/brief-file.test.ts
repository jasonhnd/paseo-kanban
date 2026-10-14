/// <reference types="node" />
import { zhCNPart, localePattern } from "./helpers/locale";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import os from "node:os";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { after, describe, it, mock } from "node:test";
import { BRIEF_FILE_MAX_BYTES, readBriefFile } from "../server/brief-file";
import { unifiedDataRoot } from "../server/storage/root";
import { KanbanError } from "../server/errors";

const repo = mkdtempSync(join(tmpdir(), "kanban-brief-repo-"));
const outside = mkdtempSync(join(tmpdir(), "kanban-brief-outside-"));
const scratch = mkdtempSync(join(tmpdir(), "brief-file-"));
// Narrow the injected temporary boundary so negative fixtures remain isolated
// even when HOME and the checkout themselves are inside the system temp root.
const readIsolatedBrief = (path: string, role: string, cwd: string) => readBriefFile(path, role, cwd, [scratch]);
execFileSync("git", ["init", "-q", repo]);
after(() => {
  for (const dir of [repo, outside, scratch]) rmSync(dir, { recursive: true, force: true });
});

describe("--brief-file", () => {
  it("refuses a non-supervisor before touching the file", () => {
    const missing = join(repo, "does-not-exist.md");
    assert.throws(() => readIsolatedBrief(missing, "executor", repo), (err) => err instanceof KanbanError && err.code === "forbidden");
  });

  it("reads a file inside the repository and one under the temp directory", () => {
    writeFileSync(join(repo, "brief.md"), "in repo");
    writeFileSync(join(scratch, "brief.md"), "in tmp");
    assert.equal(readBriefFile("brief.md", "supervisor", repo), "in repo");
    assert.equal(readIsolatedBrief(join(scratch, "brief.md"), "supervisor", repo), "in tmp");
  });

  it("reads configured work roots and explicit overrides without granting arbitrary temp files", () => {
    const prior = process.env.KANBAN_TMP_ROOT;
    process.env.KANBAN_TMP_ROOT = scratch;
    try {
      writeFileSync(join(scratch, "work-brief.md"), "card work");
      writeFileSync(join(outside, "not-a-brief.md"), "outside");
      assert.equal(readBriefFile(join(scratch, "work-brief.md"), "supervisor", repo), "card work");
      assert.throws(() => readBriefFile(join(outside, "not-a-brief.md"), "supervisor", repo), (err) => err instanceof KanbanError && err.code === "invalid");
    } finally {
      if (prior === undefined) delete process.env.KANBAN_TMP_ROOT;
      else process.env.KANBAN_TMP_ROOT = prior;
    }
  });

  it("allows the plugin-data fallback and rejects a symlink escaping it", () => {
    const home = join(scratch, "home");
    const work = join(unifiedDataRoot(process.env, home), "work", "demo", "TEST_0405");
    mkdirSync(work, { recursive: true });
    writeFileSync(join(work, "brief.md"), "fallback brief");
    writeFileSync(join(outside, "private.md"), "private");
    symlinkSync(join(outside, "private.md"), join(work, "escape.md"));
    const homeMock = mock.method(os, "homedir", () => home);
    syncBuiltinESMExports();
    const prior = process.env.KANBAN_TMP_ROOT;
    delete process.env.KANBAN_TMP_ROOT;
    try {
      assert.equal(readBriefFile(join(work, "brief.md"), "supervisor", repo), "fallback brief");
      assert.throws(() => readBriefFile(join(work, "escape.md"), "supervisor", repo), (err) => err instanceof KanbanError && err.code === "invalid");
    } finally {
      process.env.KANBAN_TMP_ROOT = prior;
      homeMock.mock.restore(); syncBuiltinESMExports();
    }
  });

  it("refuses files outside the repository and allowed work roots, including through a symlink", () => {
    writeFileSync(join(outside, "secret"), "secret");
    assert.throws(() => readIsolatedBrief(join(outside, "secret"), "supervisor", repo), (err) => err instanceof KanbanError && err.code === "invalid");
    symlinkSync(join(outside, "secret"), join(repo, "link.md"));
    assert.throws(() => readIsolatedBrief("link.md", "supervisor", repo), (err) => err instanceof KanbanError && err.code === "invalid");
    assert.throws(() => readIsolatedBrief("../" + outside.split("/").pop() + "/secret", "supervisor", repo), (err) => err instanceof KanbanError && err.code === "invalid");
  });

  it("refuses directories and oversize files", () => {
    assert.throws(() => readIsolatedBrief(".", "supervisor", repo), new RegExp(localePattern(zhCNPart("tempWorkspace.placeholder.readmeNotFile", 6, 10))));
    writeFileSync(join(repo, "big.md"), "x".repeat(BRIEF_FILE_MAX_BYTES + 1));
    assert.throws(() => readIsolatedBrief("big.md", "supervisor", repo), new RegExp(localePattern(zhCNPart("tempWorkspace.placeholder.readmeNotFile", 6, 10))));
  });

  it("does not treat an arbitrary cwd as a repository boundary", () => {
    writeFileSync(join(outside, "loose.md"), "loose");
    assert.throws(() => readIsolatedBrief(join(outside, "loose.md"), "supervisor", "/"), (err) => err instanceof KanbanError && err.code === "invalid");
    assert.throws(() => readIsolatedBrief(join(outside, "loose.md"), "supervisor", outside), (err) => err instanceof KanbanError && err.code === "invalid");
    assert.throws(() => readIsolatedBrief(join(outside, "loose.md"), "supervisor", homedir()), (err) => err instanceof KanbanError && err.code === "invalid");
  });

  it("uses the git top level when run from a subdirectory of a repository", () => {
    mkdirSync(join(repo, "sub"), { recursive: true });
    writeFileSync(join(repo, "top.md"), "top");
    assert.equal(readBriefFile("../top.md", "supervisor", join(repo, "sub")), "top");
    assert.throws(() => readIsolatedBrief(join(outside, "loose.md"), "supervisor", join(repo, "sub")), (err) => err instanceof KanbanError && err.code === "invalid");
  });
});
