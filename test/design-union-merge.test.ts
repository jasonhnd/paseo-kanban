/// <reference types="node" />
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, it } from "node:test";
import { closeDb } from "../server/db";
import { createTask } from "../server/store";
import { landLocalBranch } from "../server/temp-land";

const dir = mkdtempSync(join(tmpdir(), "kanban-design-union-"));
process.env.KANBAN_DATA_DIR = join(dir, "data");
after(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=t@example.com", ...args], { cwd, stdio: "pipe" }).toString();
}

function setup(name: string) {
  const root = join(dir, name);
  mkdirSync(join(root, "docs"), { recursive: true });
  git(root, ["init", "-b", "main"]);
  // The union policy belongs to the fixture repository, not the plugin checkout.
  writeFileSync(join(root, ".gitattributes"), "docs/DESIGN.md merge=union\n");
  writeFileSync(join(root, "docs", "DESIGN.md"), "# Design\n\nline one\n\n## base\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "initial"]);
  const branch = (b: string, edit: (file: string) => void) => {
    const directory = join(dir, `${name}-${b}`);
    git(root, ["worktree", "add", "-b", b, directory]);
    edit(join(directory, "docs", "DESIGN.md"));
    git(directory, ["commit", "-am", b]);
    return { directory, branch: b, base: "main", root };
  };
  return { root, branch };
}

function land(owned: { directory: string; branch: string; base: string; root: string }) {
  const task = createTask({ project: "sandbox", title: owned.branch, role: "executor" });
  return landLocalBranch(task, owned, "test");
}

it("keeps both sections when two branches append to the end of DESIGN.md", async () => {
  const { root, branch } = setup("append");
  const a = branch("card-a", file => appendFileSync(file, "\n## section A\n- a\n"));
  const b = branch("card-b", file => appendFileSync(file, "\n## section B\n- b\n"));
  assert.equal((await land(a)).kind, "merged");
  assert.equal((await land(b)).kind, "merged");
  const text = readFileSync(join(root, "docs", "DESIGN.md"), "utf8");
  assert.match(text, /## section A/);
  assert.match(text, /## section B/);
});

it("keeps both lines when two branches change the same line differently (needs a human look)", async () => {
  const { root, branch } = setup("sameline");
  const a = branch("card-a", file => writeFileSync(file, readFileSync(file, "utf8").replace("line one", "line from A")));
  const b = branch("card-b", file => writeFileSync(file, readFileSync(file, "utf8").replace("line one", "line from B")));
  assert.equal((await land(a)).kind, "merged");
  assert.equal((await land(b)).kind, "merged");
  const text = readFileSync(join(root, "docs", "DESIGN.md"), "utf8");
  assert.match(text, /line from A/);
  assert.match(text, /line from B/);
  assert.doesNotMatch(text, /line one/);
});
