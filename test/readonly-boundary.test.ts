/// <reference types="node" />
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentPermissionRequest } from "@getpaseo/protocol/agent-types";
import { decidePermission } from "../server/permissions";
import { readOnlyShell } from "../server/readonly";
import { fixtureProbe } from "./antigravity-permissions-probe";

function request(patch: Record<string, unknown> = {}): AgentPermissionRequest {
  return { id: "test", provider: "antigravity", name: "read", kind: "tool", detail: { type: "read", filePath: "sentinel.txt" }, metadata: { rawRequest: { toolCall: { kind: "read", rawInput: { path: "sentinel.txt" } } } }, ...patch } as AgentPermissionRequest;
}
const dir = realpathSync(mkdtempSync(join(tmpdir(), "permission-handler-")));
writeFileSync(join(dir, "sentinel.txt"), "needle\n");
const readScope = { taskId: 1, workspace: dir, roots: [] };
after(() => rmSync(dir, { recursive: true, force: true }));
const bad = [
  { name: "edit", detail: { type: "edit", filePath: "sentinel.txt", newString: "x" } },
  { name: "write", detail: { type: "write", filePath: "sentinel.txt", content: "x" } },
  { name: "delete", detail: { type: "edit", filePath: "sentinel.txt" } },
  { name: "execute", detail: { type: "shell", command: "printf changed > sentinel.txt" } },
  { kind: "mode", name: "switch_mode", detail: { type: "read", filePath: "sentinel.txt" } },
  { name: "switch_mode", detail: { type: "unknown", input: { mode: "yolo" }, output: null } },
  { kind: "plan", detail: { type: "read", filePath: "sentinel.txt" } },
  { name: "other", detail: { type: "unknown", input: { tool: "read" }, output: null } },
  { name: "write", detail: { type: "read", filePath: "sentinel.txt" } },
  { detail: { type: "read", filePath: "sentinel.txt", command: "rm x" } },
  { detail: { type: "read" } },
  { name: "other", title: "read", detail: { type: "plain_text", text: "read_file" }, metadata: { type: "read" } },
  { name: "other", title: "kanban-kanban_show: kanban_show", detail: { type: "plain_text", label: "kanban-kanban_show: kanban_show" } },
  { name: "other", detail: { type: "unknown", toolName: "kanban_show" }, metadata: { server: "kanban" } },
  { name: "kanban_show", detail: { type: "shell", command: "pwd" } },
  { kind: "mode", name: "kanban_show", detail: { type: "unknown" } },
];
describe("read-only permission boundary", () => {
  for (const role of ["reader", "reviewer", "decision"]) for (const autoAccept of [false, true]) {
    it(`${role}/auto_accept=${autoAccept} allows structured reads and its board tools`, () => {
      for (const r of [request(), request({ name: "search", detail: { type: "search", query: "needle" }, metadata: { rawRequest: { toolCall: { kind: "search", rawInput: { path: dir, pattern: "needle" } } } } }), request({ name: "kanban_show", detail: { type: "unknown" } })]) {
        assert.equal(decidePermission({ kanban: true, autoAccept, role, readScope, request: r }).action, "allow");
      }
      assert.equal(decidePermission({ kanban: true, autoAccept, role, request: request({ name: "kanban_accept", detail: { type: "unknown" } }) }).action, "deny");
    });
    it(`${role}/auto_accept=${autoAccept} refuses write/mode/unknown and disguised tools`, () => {
      for (const r of bad) assert.equal(decidePermission({ kanban: true, autoAccept, role, request: request(r) }).action, "deny", JSON.stringify(r));
    });
  }
  it("reader never runs shell scripts, including apparently safe command names", () => {
    for (const command of ["pwd", "cat sentinel.txt", "sh script.sh", "node -e 'write()'", "cat $(touch x)", "echo ${x}"]) {
      assert.equal(decidePermission({ kanban: true, autoAccept: true, role: "reader", request: request({ name: "execute", detail: { type: "shell", command } }) }).action, "deny");
    }
  });
  it("keeps executor/batch write permission when their existing auto_accept gate allows it", () => {
    for (const role of ["executor", "batch"]) for (const r of bad.slice(0, 4)) assert.equal(decidePermission({ kanban: true, autoAccept: true, role, request: request(r) }).action, "allow");
  });
  it("reviewer blocks file compilation, all gh API requests and ambiguous tree value-option clusters", () => {
    for (const command of ["file -C", "file -C -m magic", "file -Cm magic", "file -bC magic", "file '-C'", "file --compile", "file --compile=magic", "file --comp", "file -z input", "file -Z input", "file --uncompress input", "file --unknown", "file -mC input", "gh api foo", "gh api -XPOST foo", "gh api -XDELETE foo", "gh api -fkey=value foo", "gh api -Fkey=value foo", "gh api '-XPOST' foo", "gh api --method=PUT foo", "gh api --field=key=value foo", "gh api --raw-field=key=value foo", "gh api --input=data foo", "gh api --meth PUT foo", "tree -Lo", "tree -Lo 1 out", "tree -L1o out", "tree -Io pat out", "tree -Po pat out", "tree -aLo 1 out", "tree '-Lo' 1 out", "tree -L1 .", "tree -Inode_modules ."]) assert.equal(readOnlyShell(command), false, command);
    for (const command of ["file input", "file -b input", "file -bi input", "file --mime-type input", "file -m artificial.magic input", "file -bm artificial.magic input", "file --magic-file=artificial.magic input", "tree -aL 2 .", "tree -I node_modules .", "tree -P '*.ts' .", "tree -aI node_modules .", "gh pr view --help", "gh issue list --help", "gh repo view --help", "gh run list --help"]) assert.equal(readOnlyShell(command), true, command);
  });
  it("reviewer shell rejects shell syntax, executable scripts, output flags and indirect commands", () => {
    for (const command of ["tree -o sentinel", "tree -osentinel", "tree -ao sentinel", "tree -ao'sentinel'", "tree --output=sentinel", "tree --out sentinel", "tree --unknown", "uniq input output", "uniq -cu input output", "uniq -- input output", "uniq --unknown input", "find . -fprint0 sentinel", "find . -fprint sentinel", "find . -fprintf sentinel format", "find . -fls sentinel", "find . -execdir writer +", "find . -unknown", "git --no-pager -c core.fsmonitor=false grep -Owriter needle", "git --no-pager -c core.fsmonitor=false grep -nOwriter needle", "git --no-pager -c core.fsmonitor=false grep '-Owriter' needle", "git --no-pager -c core.fsmonitor=false grep --open-files-in-pager=writer needle", "git --no-pager -c core.fsmonitor=false grep --open=writer needle", "git --no-pager -c core.fsmonitor=false grep --unknown needle"]) assert.equal(readOnlyShell(command), false, command);
    for (const command of ["tree -a -L 2 .", "tree --dirsfirst --sort=name .", "uniq -c input", "uniq -f1 -s2 input", "uniq --skip-fields=1 -- input", "find . -name '*.ts' -type f -print0", "git --no-pager -c core.fsmonitor=false grep -nI -e needle -- input", "git --no-pager -c core.fsmonitor=false grep -e '-Owriter' -- input"]) assert.equal(readOnlyShell(command), true, command);
    for (const command of ["echo x > sentinel", "cat < input", "pwd; touch x", "pwd && touch x", "pwd || touch x", "cat `touch x`", "cat $(touch x)", "echo $'encoded'", "echo $COMMAND", "cat\ntouch x", "cat\\n", "cat | sh", "./cat x", "/tmp/cat x", "env cat x", "bash -c 'cat x'", "find . -exec sh script.sh +", "find . -fprint sentinel", "sed -n '1w sentinel' x", "sed -n '1e' x", "sed -n -f script x", "sort -osentinel input", "rg --pre=script x", "git diff --output=sentinel", "git diff --ext-diff", "git show --textconv", "git -c core.pager=script show", "git branch new-branch", "git grep --open-files-in-pager=script x", "gh api -X POST foo"]) assert.equal(readOnlyShell(command), false, command);
    for (const command of ["sort --compress-program=./writer input", "git status --short", "git --no-pager log", "git -c core.fsmonitor=false log", "git --no-pager -c core.fsmonitor=false log --show-signature", "git --no-pager -c core.fsmonitor=false cat-file --filters HEAD:file", "git --no-pager -c core.fsmonitor=./writer status", "git --no-pager -c core.fsmonitor=false -c core.pager=./writer log"]) assert.equal(readOnlyShell(command), false, command);
    for (const command of ["pwd", "cat sentinel.txt", "git --no-pager -c core.fsmonitor=false log --no-ext-diff --no-textconv --no-show-signature -1 --oneline", "git --no-pager -c core.fsmonitor=false status --short", "git --no-pager -c core.fsmonitor=false diff --no-ext-diff --no-textconv", "git --no-pager -c core.fsmonitor=false branch --show-current", "sed -n '1,20p' sentinel.txt"]) assert.equal(readOnlyShell(command), true, command);
  });
  it("log short required values reject an independent separator or missing value", () => {
    const prefix = "git --no-pager -c core.fsmonitor=false log ";
    const guards = "--no-ext-diff --no-textconv --no-show-signature --oneline";
    for (const option of ["-n", "-S", "-G", "-pn", "-pS", "-pG"]) {
      for (const options of [`${option} -- ${guards}`, `${guards} ${option} --`, `${guards} ${option}`, `${option} '--' ${guards}`]) {
        assert.equal(readOnlyShell(prefix + options), false, options);
      }
    }
    for (const options of ["-n 1", "-S needle", "-G needle", "-n1", "-Sneedle", "-Gneedle", "-p -n 1", "-p -S needle", "-p -G needle", "-p -n1", "-p -Sneedle", "-p -Gneedle", "-S--", "-G--"]) {
      assert.equal(readOnlyShell(prefix + guards + " " + options), true, options);
    }
  });
  it("log requires active helper guards for history and every patch spelling, regardless of option order", () => {
    const prefix = "git --no-pager -c core.fsmonitor=false log ";
    const guards = "--no-ext-diff --no-textconv --no-show-signature --oneline";
    for (const patch of ["-1 --oneline", "-p", "--patch", "-u", "--cc", "-c", "-U3", "-U", "--word-diff", "--word-diff=plain", "-W", "--function-context", "--raw", "-puW", "--stat", "--format=%h", "--pretty=oneline", "--all --name-only"]) {
      assert.equal(readOnlyShell(prefix + patch), false, patch);
      for (const options of [`${guards} ${patch}`, `${patch} ${guards}`, `--oneline --no-show-signature --no-textconv ${patch} --no-ext-diff`]) assert.equal(readOnlyShell(prefix + options), true, options);
    }
    for (const option of ["--textconv", "--textc", "--textcon", "--ext-diff", "--ext", "--ext-dif", "--no-no-textconv", "--no-no-ext-diff", "--show-signat", "--show-signature", "--format=%G?", "--pretty=%GS", "--pretty=artificial", "--format=artificial", "--pretty", "--no-textconv=false", "--no-ext-diff=false", "--unknown"]) {
      for (const options of [`${guards} -u ${option}`, `${option} -u ${guards}`]) assert.equal(readOnlyShell(prefix + options), false, options);
    }
    for (const options of ["--no-ext-diff --no-show-signature --oneline -S --no-textconv -u", "--no-textconv --no-show-signature --oneline --format --no-ext-diff -u", "--no-ext-diff --no-show-signature --oneline -G --no-textconv -u", "-u -- --no-ext-diff --no-textconv --no-show-signature --oneline", "--no-textconv --no-show-signature --oneline -u -- --no-ext-diff", "--no-ext-diff --no-show-signature --oneline -u --format=--no-textconv", "--no-ext-diff --no-textconv --no-show-signature -S --oneline -u", "--no-ext-diff --no-textconv --oneline -S --no-show-signature -u", "--no-ext-diff --no-textconv --no-show-signature -u"]) assert.equal(readOnlyShell(prefix + options), false, options);
    assert.equal(readOnlyShell(prefix + guards + " -S '--textconv' -1"), false, "existing explicit helper deny remains conservative even for pattern data");
    assert.equal(readOnlyShell(prefix + guards + " -S needle -1 -- data.txt"), true);
  });
});
it("actual guarded Git status cannot invoke a repository fsmonitor script (local handler, no provider)", () => {
  const repo = mkdtempSync(join(dir, "git-handler-"));
  const git = (args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  git(["init", "-q"]);
  const sentinel = join(repo, "sentinel.txt"); const marker = join(repo, "writer-ran");
  writeFileSync(sentinel, "unchanged\n");
  const script = join(repo, "fsmonitor.sh");
  writeFileSync(script, "#!/bin/sh\nprintf changed > sentinel.txt\nprintf ran > writer-ran\n", { mode: 0o700 });
  git(["config", "core.fsmonitor", script]);
  const before = statSync(sentinel);
  assert.equal(readOnlyShell("git status --short"), false);
  const args = ["--no-pager", "-c", "core.fsmonitor=false", "status", "--short"];
  assert.equal(readOnlyShell("git " + args.join(" ")), true);
  git(args);
  assert.equal(readFileSync(sentinel, "utf8"), "unchanged\n");
  assert.equal(statSync(sentinel).mtimeMs, before.mtimeMs); assert.equal(statSync(sentinel).mode, before.mode);
  assert.equal(existsSync(marker), false);
});
it("production permission hook emits allow/deny and preserves sentinel hash, mtime, mode and directory (simulated provider)", async () => {
  const result = await fixtureProbe(join(dir, "probe"));
  assert.equal(result.realProviderEvent, false); assert.ok(result.cases >= 30);
});
