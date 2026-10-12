/// <reference types="node" />
// Local production-hook probe. Never connects to Paseo or starts an agent/provider.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentPermissionRequest } from "@getpaseo/protocol/agent-types";
import { createLifecycleHooks, type LifecycleHookDeps } from "../server/lifecycle-hooks";
import { decidePermission } from "../server/permissions";

function fingerprint(dir: string) {
  return readdirSync(dir, { recursive: true }).sort().map(name => {
    const path = join(dir, String(name)); const stat = statSync(path);
    return { name, mode: stat.mode, mtimeMs: stat.mtimeMs, size: stat.size, sha256: stat.isFile() ? createHash("sha256").update(readFileSync(path)).digest("hex") : null };
  });
}
export async function fixtureProbe(directory: string) {
  const parent = realpathSync(resolve(process.env.KANBAN_TMP ?? process.env.TMPDIR ?? "/tmp"));
  const dir = join(realpathSync(dirname(resolve(directory))), basename(directory)); const rel = relative(parent, dir);
  assert.ok(rel && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`), "Use a new directory inside KANBAN_TMP or TMPDIR");
  // A fresh directory protects pre-existing files and keeps every artifact task-owned.
  mkdirSync(dir);
  const workspace = join(dir, "workspace"); const docs = join(dir, "authorized-docs"); const taskTmp = join(dir, "card-tmp"); const outside = join(dir, "external-artificial");
  for (const path of [workspace, docs, taskTmp, outside]) mkdirSync(path);
  const sentinel = join(workspace, "sentinel.txt"); const secret = join(outside, "artificial-auth.txt");
  const content = "Synthetic sentinel: read this exact text.\n";
  writeFileSync(sentinel, content, { mode: 0o640 });
  writeFileSync(secret, "ARTIFICIAL SECRET, NOT A CREDENTIAL\n", { mode: 0o600 });
  writeFileSync(join(docs, "reference.txt"), "authorized reference\n");
  writeFileSync(join(taskTmp, "evidence.txt"), "card-owned evidence\n");
  writeFileSync(join(workspace, "artificial.magic"), "0 string synthetic sentinel marker\n");
  symlinkSync(secret, join(workspace, "escape.txt"));
  symlinkSync(outside, join(workspace, "escape-dir"));
  // This is an offline simulated-provider fixture. Do not require an authenticated GitHub CLI.
  const tools = join(dir, "tools"); mkdirSync(tools, { recursive: true });
  writeFileSync(join(tools, "gh"), `#!${process.execPath}\nif (process.argv.slice(2).join(' ') !== 'pr view --help') process.exit(2);\nconsole.log('View a pull request');\n`, { mode: 0o755 });
  const readScope = { taskId: 1, workspace, roots: [docs, taskTmp] };
  const baseline = fingerprint(dir); const events: unknown[] = []; const responses: any[] = [];
  let autoAccept = false;
  let role = "reader";
  const hooks = createLifecycleHooks({
    hookObjects: { agent: () => true }, bind() {},
    permissionContext: () => ({ kanban: true, autoAccept, role, taskId: 1, readScope }),
    decidePermission, addComment() {}, appendEvent() {}, console: { error(message: unknown) { throw Error(String(message)); } },
  } as unknown as LifecycleHookDeps);
  const context = { paseo: { agents: { ref: () => ({ respondToPermission: async (reply: unknown) => { responses.push(reply); } }) } } };
  const read = (path: string) => ({ name: "read", kind: "tool", detail: { type: "read", filePath: path }, metadata: { rawRequest: { toolCall: { kind: "read", rawInput: { path }, locations: [{ path }] } } } });
  const search = (path: string, query = "sentinel") => ({ name: "search", kind: "tool", detail: { type: "search", query, filePaths: [path] }, metadata: { rawRequest: { toolCall: { kind: "search", rawInput: { path, pattern: query }, locations: [{ path }] } } } });
  const cases = [
    { ...read(sentinel), expected: "allow" },
    { ...read(join(docs, "reference.txt")), expected: "allow" },
    { ...read(join(taskTmp, "evidence.txt")), expected: "allow" },
    { ...search(sentinel), expected: "allow" },
    { ...read(secret), expected: "deny" },
    { ...read("../external-artificial/artificial-auth.txt"), expected: "deny" },
    { ...read(join(workspace, "escape.txt")), expected: "deny" },
    { ...search(secret), expected: "deny" },
    { ...search(join(workspace, "escape-dir")), expected: "deny" },
    { ...search(workspace), expected: "deny" }, // nested escaping symlink
    { ...search(sentinel), metadata: { rawRequest: { toolCall: { kind: "search", rawInput: { path: sentinel, command: `cat ${secret}`, pattern: "sentinel" } } } }, expected: "deny" },
    { name: "read", kind: "tool", detail: { type: "read", filePath: sentinel }, title: sentinel, expected: "deny" }, // title fallback has no real path evidence
    { name: "edit", kind: "tool", detail: { type: "edit", filePath: sentinel, newString: "changed" }, expected: "deny" },
    { name: "execute", kind: "tool", detail: { type: "shell", command: `printf changed > ${sentinel}` }, expected: "deny" },
    { name: "switch_mode", kind: "mode", detail: { type: "unknown", input: { mode: "yolo" }, output: null }, expected: "deny" },
    { name: "switch_mode", kind: "mode", detail: { type: "read", filePath: sentinel }, expected: "deny" },
    { name: "other", kind: "tool", title: "kanban-kanban_show: kanban_show", detail: { type: "plain_text", label: "kanban-kanban_show: kanban_show", text: "{}" }, expected: "deny" },
  ];
  for (role of ["reader", "decision"]) for (autoAccept of [false, true]) for (const [index, item] of cases.entries()) {
    const { expected, ...fields } = item;
    const request = { id: `${autoAccept}-${index}`, provider: "antigravity", ...fields, actions: [{ id: "allow-once", label: "Allow once", behavior: "allow" }, { id: "reject-once", label: "Reject", behavior: "deny" }] } as unknown as AgentPermissionRequest;
    await hooks.permission({ agent: { id: "synthetic-reader" }, request } as never, context as never);
    const response = responses.at(-1)?.response;
    assert.equal(response?.behavior, expected, request.id);
    // Actual guarded file/search handlers. Assert denial before dispatch, so a
    // faulty gate NEVER executes a dangerous handler or reads an external file.
    const result = response.behavior === "allow" ? readFileSync((fields.detail as { filePath?: string; filePaths?: string[] }).filePath ?? (fields.detail as { filePaths: string[] }).filePaths[0], "utf8") : null;
    if (expected === "allow" && (fields.detail as { filePath?: string }).filePath === sentinel) assert.equal(result, content);
    if (expected === "allow" && fields.name === "search") assert.ok(result?.includes("sentinel"));
    assert.deepEqual(fingerprint(dir), baseline, `${request.id}: sentinel/mtime/mode/directory changed`);
    events.push({ role, autoAccept, request, response, readResult: result, handlerExecuted: response.behavior === "allow", unchanged: true });
  }
  role = "reviewer";
  const shells = [
    ...[`tree -o ${sentinel}`, `tree -ao${sentinel}`, `tree --output=${sentinel}`, `uniq ${sentinel} ${sentinel}`, `uniq -c ${sentinel} ${sentinel}`, `find . -fprint0 ${sentinel}`, `find . -fprintf ${sentinel} format`, `git --no-pager -c core.fsmonitor=false grep -O${sentinel} sentinel`, `git --no-pager -c core.fsmonitor=false grep '-nO${sentinel}' sentinel`].map(command => ({ command, expected: "deny", args: null })),
    ...["file -C", "file -C -m artificial.magic", "file -Cm artificial.magic", "file --compile", "gh api -XPOST repos/o/r/issues", "gh api -XDELETE repos/o/r/git/refs/heads/main", "gh api -fkey=value repos/o/r/issues", "gh api -Fkey=value repos/o/r/issues", "tree -Lo", "tree -Lo 1 out", "tree -L1o out", "tree -Io pat out", "tree -Po pat out"].map(command => ({ command, expected: "deny", args: null })),
    { command: "cat sentinel.txt", expected: "allow", args: ["cat", "sentinel.txt"] },
    { command: "uniq -c sentinel.txt", expected: "allow", args: ["uniq", "-c", "sentinel.txt"] },
    { command: "find . -name sentinel.txt -print", expected: "allow", args: ["find", ".", "-name", "sentinel.txt", "-print"] },
    { command: "git --no-pager -c core.fsmonitor=false grep --no-index sentinel sentinel.txt", expected: "allow", args: ["git", "--no-pager", "-c", "core.fsmonitor=false", "grep", "--no-index", "sentinel", "sentinel.txt"] },
    { command: "file -i sentinel.txt", expected: "allow", args: ["file", "-i", "sentinel.txt"] },
    { command: "file -m artificial.magic sentinel.txt", expected: "allow", args: ["file", "-m", "artificial.magic", "sentinel.txt"] },
    { command: "gh pr view --help", expected: "allow", args: ["gh", "pr", "view", "--help"], contains: "pull request" },
  ];
  for (autoAccept of [false, true]) for (const [index, item] of shells.entries()) {
    const request = { id: `shell-${autoAccept}-${index}`, provider: "synthetic", name: "execute", kind: "tool", detail: { type: "shell", command: item.command } } as AgentPermissionRequest;
    await hooks.permission({ agent: { id: "synthetic-reviewer" }, request } as never, context as never);
    const response = responses.at(-1)?.response;
    assert.equal(response?.behavior, item.expected, item.command);
    const result = response.behavior === "allow" && item.args ? execFileSync(item.args[0], item.args.slice(1), { cwd: workspace, encoding: "utf8", env: { ...process.env, PATH: tools + delimiter + (process.env.PATH ?? ""), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GH_CONFIG_DIR: join(dir, "gh-config"), GH_TOKEN: "", GITHUB_TOKEN: "", GH_HOST: "127.0.0.1:1" } }) : null;
    if (item.expected === "allow") assert.ok(result?.toLowerCase().includes(("contains" in item ? item.contains : "sentinel") ?? "sentinel"));
    assert.deepEqual(fingerprint(dir), baseline, item.command);
    events.push({ role, autoAccept, request, response, handlerResult: result, handlerExecuted: result !== null, unchanged: true });
  }
  return { evidenceLayer: "production permission hook with simulated provider and local read handler", realProviderEvent: false, realAcpLifecycle: false, cases: events.length, baseline, events };
}

async function main() {
  const [mode, path] = process.argv.slice(2);
  if (mode === "--fixture" && path) console.log(JSON.stringify(await fixtureProbe(path), null, 2));
  else if (mode === "--replay" && path) {
    // Supply sanitized mapped AgentPermissionRequest records from a normally
    // authorized Kanban session. Replay does not establish provider enforcement.
    const events = JSON.parse(readFileSync(path, "utf8")); assert.ok(Array.isArray(events));
    const results = events.map((event: any) => {
      assert.equal(event.role, "reader"); assert.equal(event.request?.provider, "antigravity");
      // readScope is supplied by the trusted replay operator, not the recorded
      // request. A replay scope is still a synthetic context, not live task proof.
      const decision = decidePermission({ kanban: true, autoAccept: event.autoAccept === true, role: event.role, readScope: event.readScope, request: event.request });
      if (event.expected) assert.equal(decision.action, event.expected);
      return { id: event.request.id, autoAccept: event.autoAccept === true, action: decision.action };
    });
    console.log(JSON.stringify({ evidenceLayer: "offline replay of supplied requests", realProviderEvent: false, results }, null, 2));
  } else throw Error("Usage: node --import tsx test/antigravity-permissions-probe.ts --fixture <new-card-tmp-directory> | --replay <sanitized-events.json>");
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
