/// <reference types="node" />
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import { processArguments } from "./helpers/process-arguments";
import { resetWakeSender, setWakeSender } from "../server/bus";
import { forgetBoardWakesInMemoryForTests, noteTickFailure, noteTickSuccess, resetAgentAliveCheck, setAgentAliveCheck } from "../server/wake";
import { capacityHoldReason, refreshCapacityGuard, resetCapacityForTests, setCapacityProbeForTests } from "../server/capacity-guard";
import { hasBoardWakeMark } from "../server/board-wake-marks";
import { configPath } from "../server/config-file";
import { closeDb, getDb } from "../server/db";
import { loadConfig, parseConfig, saveConfig, setProjectCode, setProjectWorkspace } from "../server/config";
import { createTask, getTask, archiveTask, appendEvent } from "../server/store";
import { startTask } from "./helpers/compat-dispatch";
import { runTick } from "./helpers/compat-schedule";
import type { AgentLauncher } from "../server/dispatch";
import type { Profile } from "../server/profiles";
import { currentOccupancy } from "../server/routing";
import { resolveReviewTarget, reviewFamilyBlock } from "../server/review-target";
import { bindCloudRunner, cloudBoardPrefix, cloudQueueReason, executeCloudCommand, reconcileCloudMachines, setCloudRuntimeForTests, stopCloudRuns, waitForCloudRuns, type CloudRuntime } from "../server/cloud-runner";
import { setLanguage } from "../shared/i18n";
import { cloudDelivery, cloudRunRecord, localCloudReceipt } from "../server/cloud-record";
import { cloudPrivacyFindings } from "../server/cloud-privacy";
import { acceptTask, approveTask, requestChanges } from "../server/flow";
import { executable as fixtureExecutable } from "../scripts/isolated-environment.mjs";

delete process.env.KANBAN_TOKEN;
delete process.env.PASEO_AGENT_ID;
const root = mkdtempSync(join(tmpdir(), "cloud-runner-"));
const realGit = fixtureExecutable("git");
// The remote shell fixture declares its POSIX tools without inheriting provider executables.
const shellTools = ["mkdir", "grep", "tail", "rm", "mv", "chmod", "sha256sum"].map(name => [name, fixtureExecutable(name, `${process.env.PATH}:/bin:/usr/bin`)]);
let dir: string;
let repo: string;
let remote: string;
let tools: string;
let calls: string;
let localCreates = 0;
let fixtureRuntime: CloudRuntime;
const codex: Profile = { id: "ex", name: "Cloud executor", role: "executor", provider: "codex", family: "openai", model: "gpt-6.1-sol", pool: "demo" };
const grok: Profile = { ...codex, id: "gx", name: "Cloud grok", provider: "grok", family: "xai", model: "grok-4.7" };
const reviewer: Profile = { id: "rv", name: "Independent reviewer", role: "reviewer", provider: "grok", family: "xai", model: "grok-4.7", pool: "demo" };
const launcher: AgentLauncher = { async create() { localCreates++; return { id: "local-fixture" }; }, async send() {} };

function git(cwd: string, ...args: string[]): string {
  return execFileSync(realGit, args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Anonymous contributor", GIT_COMMITTER_NAME: "Anonymous contributor", GIT_AUTHOR_EMAIL: "noreply@example.invalid", GIT_COMMITTER_EMAIL: "noreply@example.invalid" }, stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function executable(name: string, body: string) {
  const path = join(tools, name);
  writeFileSync(path, `#!${process.execPath}\n${body}`); chmodSync(path, 0o755);
}
function mode(value: string) { writeFileSync(join(dir, "mode"), value); }
function log(): Array<{ command: string; args: string[]; cwd?: string; tmpdir?: string; kanbanTmp?: string; blobBaseUrl?: string; seoLiveBase?: string }> {
  return existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
}
function machines(): string[] { return readdirSync(join(dir, "boxes")); }
function task(cloud = true) { return createTask({ project: "paseo-clear-chat", title: "Improve fixture", brief: "Update the fixture and run tests.", role: "executor", workspacePath: repo, contract: "github:example/paseo-clear-chat", tags: cloud ? ["cloud"] : [] }); }
function config(patch: Record<string, unknown> = {}) {
  const current = loadConfig();
  current.projects!["paseo-clear-chat"].cloudRunner = { ...current.projects!["paseo-clear-chat"].cloudRunner!, ...patch };
  saveConfig(current);
}
async function start(id: number, profile = codex) { return startTask(id, launcher, "test", { profiles: [profile, profile.model === reviewer.model ? { ...reviewer, provider: "codex", family: "openai", model: codex.model } : reviewer], chosen: profile }); }
async function settled() { await waitForCloudRuns(); assert.deepEqual(machines(), []); }

function workspaceFreeTask() {
  // Write the input as an operator would, without requiring config normalization to work first.
  const raw = JSON.parse(readFileSync(configPath(), "utf8"));
  const project = raw.projects["paseo-clear-chat"];
  delete project.workspacePath;
  delete project.cloudRunner.mirrorRoot;
  project.repo = "example/paseo-clear-chat";
  writeFileSync(configPath(), JSON.stringify(raw));
  return createTask({ project: "paseo-clear-chat", title: "Improve fixture", brief: "Update the fixture and run tests.", role: "executor", contract: "github:example/paseo-clear-chat", tags: ["cloud"] });
}

beforeEach(async () => {
  await stopCloudRuns(); closeDb(); resetWakeSender(); resetAgentAliveCheck();
  resetCapacityForTests();
  setCapacityProbeForTests({ statfs: () => ({ blocks: 1024 ** 4, bavail: 100 * 1024 ** 3, bsize: 1 }) });
  setLanguage("en");
  dir = mkdtempSync(join(root, "case-"));
  repo = join(dir, "paseo-clear-chat"); remote = join(dir, "remote.git");
  tools = join(dir, "tools"); calls = join(dir, "calls.txt");
  for (const path of [repo, tools, join(dir, "boxes"), join(dir, "scratch")]) mkdirSync(path, { recursive: true });
  writeFileSync(join(tools, "package.json"), '{"type":"commonjs"}\n');
  process.env.KANBAN_DATA_DIR = join(dir, "board");
  process.env.KANBAN_TMP_ROOT = join(dir, "scratch");
  process.env.KANBAN_WORKTREES_ROOT = join(dir, "worktrees");
  process.env.FLEET_PRIVATE_DENYLIST = join(dir, "denylist.txt");
  writeFileSync(process.env.FLEET_PRIVATE_DENYLIST, "CloudPrivateTerm\n");
  for (const [name, target] of shellTools) symlinkSync(target, join(tools, name));
  git(repo, "init", "-b", "main");
  writeFileSync(join(repo, "package.json"), '{"name":"cloud-fixture","version":"1.0.0","scripts":{"test":"node -e \\\"process.exit(0)\\\""}}\n');
  writeFileSync(join(repo, "package-lock.json"), '{"name":"cloud-fixture","version":"1.0.0","lockfileVersion":3,"packages":{}}\n');
  writeFileSync(join(repo, "fixture.txt"), "Before\n"); git(repo, "add", "."); git(repo, "commit", "-m", "Initial fixture");
  git(dir, "clone", "--bare", repo, remote);
  git(repo, "remote", "add", "origin", "https://github.com/example/paseo-clear-chat.git");
  const common = `const fs = require('node:fs'); const cp = require('node:child_process'); const path = require('node:path');
const root = process.env.FAKE_CLOUD_ROOT; const args = process.argv.slice(2);
const mode = fs.existsSync(path.join(root, 'mode')) ? fs.readFileSync(path.join(root, 'mode'), 'utf8') : '';
fs.appendFileSync(path.join(root, 'calls.txt'), JSON.stringify({command:path.basename(process.argv[1]),args,cwd:process.cwd(),tmpdir:process.env.TMPDIR,kanbanTmp:process.env.KANBAN_TMP,blobBaseUrl:process.env.BLOB_BASE_URL,seoLiveBase:process.env.SEO_LIVE_BASE})+'\\n');\n`;
  executable("git", common + `
if (mode === 'local-push' && process.cwd().includes('/boxes/') && args[0] === 'push') {
 const policy = cp.spawnSync(${JSON.stringify(realGit)}, ['config','--get','protocol.https.allow'], {encoding:'utf8'}).stdout.trim();
 // The red test must never contact a network. Delegate to real Git only once the repository denies HTTPS.
 const result = policy === 'never' ? cp.spawnSync(${JSON.stringify(realGit)}, args, {encoding:'utf8'}) : {status:0,stderr:'missing protocol restriction'};
 fs.writeFileSync(path.join(root,'push-result.json'),JSON.stringify({policy,status:result.status,stderr:result.stderr,
   ssh:cp.spawnSync(${JSON.stringify(realGit)}, ['config','--get','protocol.ssh.allow'], {encoding:'utf8'}).stdout.trim()}));
 process.stderr.write(result.stderr); process.exit(result.status ?? 1);
}
if (process.cwd().includes('/boxes/') && args.includes('push')) process.exit(91);
if (mode === 'anonymous-denied' && args.includes('ls-remote')) process.exit(9);
if (mode === 'bundle-fail' && args.includes('fetch') && args.some(x=>x.endsWith('.bundle'))) process.exit(6);
const out = cp.spawnSync(${JSON.stringify(realGit)}, args.map(x => ['https://github.com/example/paseo-clear-chat.git','https://github.com/example/paseo-clear-chat','https://github.com/example/demo-web.git','https://github.com/example/demo-web'].includes(x) ? path.join(root,'remote.git') : x), {stdio:'inherit'});
process.exit(out.status ?? 1);`);
  executable("npm", common + `if (mode === 'test-fail' && args[0] === 'test') process.exit(4); if (mode.startsWith('directory-fail-') && args[0] === 'ci' && process.cwd().endsWith('/'+mode.slice('directory-fail-'.length))) process.exit(5); process.exit(0);`);
  executable("bun", common + `
if (args[0] === '--version') {
 if (mode === 'bun-missing' && !process.argv[1].includes('/.bun/bin/')) process.exit(127);
 console.log(process.argv[1].includes('/.bun/bin/') ? (mode === 'bun-install-wrong' ? '1.4.4' : '1.4.2') : '1.4.4');
}
process.exit(0);`);
  executable("uname", common + `console.log(['bun-arm','bun-no-digest'].includes(mode) ? 'aarch64' : mode === 'bun-unsupported' ? 'riscv64' : 'x86_64');`);
  executable("curl", common + `
if (mode === 'bun-install-fail') process.exit(22);
if (!args.includes('--output') || !args.at(-1).startsWith('https://github.com/oven-sh/bun/releases/download/bun-v1.4.2/bun-linux-')) process.exit(9);
fs.writeFileSync(args[args.indexOf('--output')+1], mode === 'bun-checksum-wrong' ? 'corrupted release' : 'fixture release');
`);
  executable("unzip", common + `
if (mode === 'bun-unzip-fail') process.exit(9);
const dest=args[args.indexOf('-d')+1]; const arch=['bun-arm','bun-no-digest'].includes(mode) ? 'aarch64' : 'x64';
fs.mkdirSync(path.join(dest,'bun-linux-'+arch),{recursive:true});
fs.copyFileSync(path.join(root,'tools/bun'),path.join(dest,'bun-linux-'+arch,'bun'));
`);
  executable("base64", common + `if (args.includes('-d')) process.stdout.write(Buffer.from(fs.readFileSync(0,'utf8').trim(),'base64')); else process.stdout.write(fs.readFileSync(args.at(-1)).toString('base64'));`);
  executable("timeout", common + `
const child=cp.spawn(args[1],args.slice(2),{stdio:'inherit'}); let expired=false;
const timer=setTimeout(()=>{expired=true;child.kill('SIGKILL');},parseFloat(args[0])*1000);
process.on('SIGTERM',()=>child.kill('SIGKILL'));
child.on('error',()=>{clearTimeout(timer);process.exit(127);});
child.on('close',code=>{clearTimeout(timer);process.exit(expired?124:code??130);});`);
  const agent = common + `
fs.appendFileSync(${JSON.stringify(join(root, "agent-pids"))}, String(process.pid) + '\\n');
if (mode === 'expired' || mode === 'expired-zero') { console.error('Authentication expired. Please run grok login.'); process.exit(mode === 'expired' ? 1 : 0); }
if (mode === 'unauthenticated') { console.error('You are not authenticated.'); process.exit(1); }
if (mode === 'agent-no-capacity' || mode === 'agent-quota-exceeded') { console.error(mode === 'agent-no-capacity' ? 'no_capacity' : 'quota_exceeded'); process.exit(3); }
if (mode === 'agent-fail') { console.error('fixture execution failed'); process.exit(3); }
if (mode === 'hang') { setInterval(()=>{},1000); } else {
fs.writeFileSync('fixture.txt', mode === 'privacy' ? '/'+['Users','private-user','work'].join('/')+'\\n' : mode === 'short-ticket' ? 'PCC'+'_'+'1\\n' : mode === 'denylist' ? 'CloudPrivateTerm\\n' : mode === 'edit-again' ? 'After again\\n' : 'After\\n');
if (mode === 'local-symlink') fs.symlinkSync('fixture.txt', 'link.txt');
if (mode === 'local-push') { const pushed=cp.spawnSync('git',['push','https://github.com/example/demo.git','HEAD'],{stdio:'inherit'}); if (pushed.status !== 0) process.exit(pushed.status ?? 1); }
if (mode === 'cjk-path') fs.writeFileSync(String.fromCodePoint(0x65e5)+'.txt','');
console.log('Fixture agent finished'); }`;
  executable("codex", agent); executable("grok", agent);
  executable("gh", common + `
if (args[0] !== 'pr' || args[1] !== 'create' || !args.includes('--draft')) process.exit(92);
console.log('https://github.com/'+args[args.indexOf('--repo')+1]+'/pull/1');`);
  executable("instabox", common + `
const boxes = path.join(root,'boxes'); const name = args[1]; const box = path.join(boxes, name ?? 'invalid');
if (args[0] === 'ls') { console.log(JSON.stringify({machines:fs.readdirSync(boxes).map(name=>({name}))})); }
else if (args[0] === 'create') {
 const countFile=path.join(root,'attempts'); const count=Number(fs.existsSync(countFile)?fs.readFileSync(countFile,'utf8'):0)+1; fs.writeFileSync(countFile,String(count));
 if (mode === 'capacity-always' || (mode === 'capacity-once' && count === 1)) { console.error('no_capacity'); process.exit(1); }
 const name=args[args.indexOf('--name')+1]; fs.mkdirSync(path.join(boxes,name,'home/.grok/bin'),{recursive:true});
 fs.symlinkSync(path.join(root,'tools/grok'),path.join(boxes,name,'home/.grok/bin/grok'));
 // The fake Bun is a CommonJS Node executable; real Bun archives need no package manifest.
 fs.mkdirSync(path.join(boxes,name,'home/.bun/bin'),{recursive:true});
 fs.copyFileSync(path.join(root,'tools/package.json'),path.join(boxes,name,'home/.bun/bin/package.json'));
 if (mode === 'bun-home') {
  const bin=path.join(boxes,name,'home/.bun/bin'); fs.mkdirSync(bin,{recursive:true});
  for (const file of ['bun','package.json']) fs.copyFileSync(path.join(root,'tools',file),path.join(bin,file));
 }
 console.log('Created '+name);
 if (mode === 'create-hang') setInterval(()=>{},1000);
} else if (args[0] === 'rm') { if (mode === 'rm-fail') process.exit(7); fs.rmSync(box,{recursive:true,force:true}); }
else if (args[0] === 'get') { if (!fs.existsSync(box)) process.exit(1); console.log(JSON.stringify({name})); }
else if (args[0] === 'exec') {
 if (!fs.existsSync(box)) process.exit(2);
 const line=args.slice(args.indexOf('--')+1).join(' '); const match=line.match(/echo ([A-Za-z0-9+/=]+) \\| base64 -d \\| bash -l/);
 if (!match && !line.startsWith("node -e ")) process.exit(93);
 let script=match ? Buffer.from(match[1],'base64').toString('utf8') : line;
 if (match && script.includes('refs/heads/result')) {
   if (mode === 'local-extra-ref') script=script.replace('git bundle create "$KANBAN_TMP/task.bundle" "$base..refs/heads/result"', 'git update-ref refs/heads/unwanted "$head"; git bundle create "$KANBAN_TMP/task.bundle" "$base..refs/heads/result" refs/heads/unwanted');
   if (mode === 'local-multi') script=script.replace('git update-ref refs/heads/result "$head"', 'head=$(git commit-tree "$(git rev-parse \\"$head^{tree}\\")" -p "$head" -m \\"Complete cloud task\\"); git update-ref refs/heads/result "$head"');
   if (mode === 'local-wrong-parent') script=script.replace('git update-ref refs/heads/result "$head"', 'head=$(git commit-tree "$(git rev-parse \\"$head^{tree}\\")" -m \\"Complete cloud task\\"); git update-ref refs/heads/result "$head"').replace('"$base..refs/heads/result"', 'refs/heads/result');
   if (mode === 'local-tree-mismatch') script=script.replace('echo "PKB_TREE=', 'echo "PKB_TREE=0');
 }
 if (mode === 'corrupt-bundle' && script.includes('base64 -w0')) { console.log(Buffer.from('Invalid bundle content '.repeat(10)).toString('base64')); process.exit(0); }
 if (mode === 'bundle-noise' && script.includes('base64 -w0')) console.log('A login shell banner: ignore this line.');
 const child=cp.spawn('/bin/bash',['-c',script],{env:{...process.env,HOME:path.join(box,'home')},stdio:'inherit'});
 process.on('SIGTERM',()=>child.kill('SIGTERM')); child.on('exit',(code)=>process.exit(code??1));
} else process.exit(94);`);
  const fakeEnv = { PATH: `${tools}:${process.env.PATH}`, FAKE_CLOUD_ROOT: dir, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  fixtureRuntime = {
    run: (command, args, options) => executeCloudCommand(command, args, { ...options, env: { ...options.env, ...fakeEnv } }),
    publicRepository: async () => readFileSync(join(dir, "mode"), "utf8") !== "private",
  };
  setCloudRuntimeForTests(fixtureRuntime);
  mode(""); localCreates = 0;
  saveConfig(parseConfig({ cloud: { allowedProjects: ["paseo-clear-chat"], deleteTimeoutSec: 1, deletePollIntervalSec: 1 }, language: "en", families: {}, bannedProviders: { providers: [], families: [], pools: [], models: [] }, concurrency: { global: 10, roles: { executor: 10, reviewer: 10 }, pools: { demo: 10 } }, projects: { "paseo-clear-chat": { code: "DEMO", defaultWorkspace: "dir", workspacePath: repo, cloudRunner: { enabled: true, mirrorRoot: join(dir, "mirrors"), retryIntervalSec: 1, maxCreateAttempts: 2 } } } }));
});
after(async () => {
  await stopCloudRuns();
  const pidFile = join(root, "agent-pids");
  const pids = existsSync(pidFile) ? readFileSync(pidFile, "utf8").trim().split("\n").map(Number) : [];
  const processes = processArguments(pids);
  assert.equal(processes.some(line => line.includes(`${root}/`) && /\/tools\/(?:codex|grok) /.test(line)), false, "fake cloud agents must not survive machine deletion");
  setCloudRuntimeForTests(null); closeDb(); rmSync(root, { recursive: true, force: true });
});

test("cloud success pushes a task branch, creates a draft PR, enters review and deletes its machine", async () => {
  const card = task(); await start(card.id); await settled();
  const done = getTask(card.id);
  assert.equal(done.status, "in_review", JSON.stringify({ reason: done.blocked_reason, hold: done.hold_reason, calls: log().map(x => [x.command, ...x.args.slice(0, 3)]) })); assert.equal(done.fail_count, 0); assert.equal(localCreates, 0);
  assert.match(done.handoff_json!, /https:\/\/github.com\/example\/paseo-clear-chat\/pull\/1/);
  const target = resolveReviewTarget(done, true); assert.ok(target?.ok); assert.equal(target.model, codex.model);
  assert.ok(reviewFamilyBlock(codex, target)); assert.equal(reviewFamilyBlock(reviewer, target), null);
  const pushes = log().filter(x => x.command === "git" && x.args.includes("push")); assert.equal(pushes.length, 1);
  assert.match(pushes[0].args.at(-1)!, /^refs\/heads\/kanban\/cloud-[a-z0-9-]+:refs\/heads\/kanban\/cloud-[a-z0-9-]+$/);
  assert.equal(log().filter(x => x.command === "gh").length, 1);
  const create = log().find(x => x.command === "instabox" && x.args[0] === "create")!;
  assert.ok(create.args.includes("--timeout")); assert.deepEqual(create.args.slice(-2), ["--on-timeout", "kill"]);
  assert.equal(git(remote, "show", "main:fixture.txt"), "Before");
  assert.ok(log().some(x => x.command === "npm" && x.args[0] === "ci"));
  assert.ok(log().some(x => x.command === "npm" && x.args[0] === "test"));
  assert.equal(loadConfig().projects!["paseo-clear-chat"].cloudRunner!.source, "publicGithub");
  assert.equal(cloudRunRecord(card.id)!.source, undefined);
  assert.equal(localCloudReceipt(card.id), null);
  assert.equal(log().some(x => x.command === "instabox" && x.args.at(-1)?.startsWith("node -e ")), false);
});

test("public cloud without a host workspace completes execution, bundle import, cleanup and review", async () => {
  const card = workspaceFreeTask();
  assert.equal(card.workspace_path, null);
  await start(card.id); await settled();
  const record = cloudRunRecord(card.id)!;
  const mirror = join(process.env.KANBAN_DATA_DIR!, "mirrors", "paseo-clear-chat.git");
  assert.equal(record.originalPath, null); assert.equal(record.originalKind, card.workspace_kind);
  assert.equal(record.mirror, mirror);
  assert.equal(getTask(card.id).status, "in_review");
  assert.equal(getTask(card.id).workspace_path, mirror);
  assert.equal(git(mirror, "show", `${record.branch}:fixture.txt`), "After");
  assert.ok(log().some(x => x.command === "codex"));
  assert.ok(log().some(x => x.command === "npm" && x.args[0] === "test"));
  assert.ok(log().some(x => x.command === "instabox" && x.args[0] === "rm"));
  assert.ok(log().some(x => x.command === "gh"));
  assert.equal(localCreates, 0);
  const target = resolveReviewTarget(getTask(card.id), true); assert.ok(target?.ok);
  assert.equal(reviewFamilyBlock(reviewer, target), null);
  const reviewLauncher: AgentLauncher = { ...launcher, async createWorktree(options) {
    const directory = join(dir, "workspace-free-review");
    git(options.cwd, "worktree", "add", "-b", options.branchName, directory, options.baseBranch);
    return { directory, workspaceId: "workspace-free-review", head: git(directory, "rev-parse", "HEAD") };
  } };
  await startTask(card.id, reviewLauncher, "test", { profiles: [codex, reviewer], chosen: reviewer });
  requestChanges(card.id, "Refine fixture", "Add another edit."); mode("edit-again");
  await start(card.id); await settled();
  assert.equal(getTask(card.id).status, "in_review", getTask(card.id).blocked_reason ?? undefined);
  assert.equal(cloudRunRecord(card.id)!.originalPath, null, "rework must preserve an explicitly absent host workspace");
  assert.equal(cloudRunRecord(card.id)!.originalKind, card.workspace_kind);
  assert.equal(git(mirror, "show", `${cloudRunRecord(card.id)!.branch}:fixture.txt`), "After again");
});

for (const failure of ["capacity-once", "agent-fail"]) test(`public cloud without a host workspace restores null after ${failure}`, async () => {
  const card = workspaceFreeTask(); mode(failure);
  await start(card.id); await settled();
  assert.equal(getTask(card.id).workspace_path, null);
  assert.equal(getTask(card.id).workspace_kind, card.workspace_kind);
  assert.equal(getTask(card.id).status, failure === "capacity-once" ? "ready" : "blocked");
  assert.equal(cloudRunRecord(card.id)!.originalPath, null);
});

test("public cloud with a host workspace uses the board mirror default", async () => {
  const current = loadConfig(); delete current.projects!["paseo-clear-chat"].cloudRunner!.mirrorRoot; saveConfig(current);
  const card = task(); await start(card.id); await settled();
  assert.equal(getTask(card.id).status, "in_review");
  assert.equal(cloudRunRecord(card.id)!.originalPath, repo);
  assert.equal(cloudRunRecord(card.id)!.mirror, join(process.env.KANBAN_DATA_DIR!, "mirrors", "paseo-clear-chat.git"));
});

test("public cloud restart restores a persisted null host workspace after orphan cleanup", async () => {
  const card = workspaceFreeTask(); const machine = `${cloudBoardPrefix()}demo-0001-g4`;
  const result = getDb().prepare("INSERT INTO runs (task_id, role, started_at) VALUES (?, 'executor', ?)").run(card.id, new Date().toISOString());
  getDb().prepare("UPDATE tasks SET status = 'running' WHERE id = ?").run(card.id);
  appendEvent(card.id, "cloud_run_started", null, null, "scheduler", { generation: 4, machine, branch: "kanban/cloud-fixture", repo: "example/paseo-clear-chat", base: "main", mirror: join(dir, "board/mirrors/paseo-clear-chat.git"), originalPath: null, originalKind: null, runId: Number(result.lastInsertRowid) });
  mkdirSync(join(dir, "boxes", machine)); await reconcileCloudMachines();
  assert.deepEqual(machines(), []); assert.equal(getTask(card.id).status, "ready");
  assert.equal(getTask(card.id).workspace_path, null); assert.equal(getTask(card.id).workspace_kind, "none");
  assert.equal(getDb().prepare("SELECT ended_at FROM runs WHERE id = ?").get(Number(result.lastInsertRowid))?.ended_at != null, true);
});

test("no_capacity releases admission slots, retries successfully, and never increments failure count", async () => {
  mode("capacity-once"); const card = task(); await start(card.id); await settled();
  assert.equal(getTask(card.id).status, "ready"); assert.equal(currentOccupancy([codex]).global, 0);
  await start(card.id); assert.equal(Number(readFileSync(join(dir, "attempts"), "utf8")), 1);
  getDb().prepare("UPDATE events SET data_json = json_set(data_json, '$.retryAt', 0) WHERE task_id = ? AND kind = 'cloud_capacity_wait'").run(card.id);
  await start(card.id); await settled();
  assert.equal(getTask(card.id).status, "in_review"); assert.equal(getTask(card.id).fail_count, 0);
});

test("no_capacity attempt limit leaves a ready hold without tripping the failure fuse", async () => {
  mode("capacity-always"); config({ maxCreateAttempts: 1 }); const card = task();
  await start(card.id); await settled(); await start(card.id);
  assert.equal(getTask(card.id).status, "ready"); assert.match(getTask(card.id).hold_reason!, /capacity.*limit/i);
  assert.equal(getTask(card.id).fail_count, 0); assert.equal(log().filter(x => x.args[0] === "create").length, 1);
});

test("expired Grok login blocks capability with a template refresh reason and deletes the machine", async () => {
  mode("expired"); const card = task(); await start(card.id, grok); await settled();
  assert.equal(getTask(card.id).blocked_kind, "capability"); assert.match(getTask(card.id).blocked_reason!, /tpl-agent.*Grok.*expired.*refresh/i);
  assert.equal(getTask(card.id).fail_count, 0); assert.equal(log().some(x => x.command === "gh"), false);
  assert.ok(getDb().prepare("SELECT id FROM events WHERE task_id = ? AND kind = 'cloud_leader_notice'").get(card.id));
});

test("Grok login expiry is recognized even when its CLI exits zero", async () => {
  mode("expired-zero"); const card = task(); await start(card.id, grok); await settled();
  assert.equal(getTask(card.id).blocked_kind, "capability"); assert.match(getTask(card.id).blocked_reason!, /Grok login expired/);
});

test("the Grok CLI unauthenticated message requests template refresh instead of failure fusion", async () => {
  mode("unauthenticated"); const card = task(); await start(card.id, grok); await settled();
  assert.equal(getTask(card.id).blocked_kind, "capability"); assert.match(getTask(card.id).blocked_reason!, /Grok login expired/); assert.equal(getTask(card.id).fail_count, 0);
});

for (const failure of ["agent-fail", "test-fail", "hang"]) test(`cloud ${failure} deletes the machine and leaves no public output`, async () => {
  mode(failure); config({ taskTimeoutSec: failure === "hang" ? 1 : 30 }); const card = task();
  await start(card.id); await settled();
  assert.equal(getTask(card.id).status, "blocked"); assert.equal(getTask(card.id).fail_count, 0);
  assert.equal(log().some(x => x.command === "gh" || x.args.includes("push")), false);
});

test("timeout after a partial machine creation still deletes the allocated machine", async () => {
  mode("create-hang"); config({ taskTimeoutSec: 1 }); const card = task(); await start(card.id); await settled();
  assert.match(getTask(card.id).blocked_reason!, /timed out/); assert.equal(getTask(card.id).fail_count, 0);
});

for (const failure of ["bundle-fail", "corrupt-bundle"]) test(`${failure} stops before any push and deletes the machine`, async () => {
  mode(failure); const card = task(); await start(card.id); await settled();
  assert.equal(getTask(card.id).status, "blocked"); assert.equal(log().some(x => x.args.includes("push")), false);
});

test("bundle transfer filters login-shell noise before importing the Git objects", async () => {
  mode("bundle-noise"); const card = task(); await start(card.id); await settled(); assert.equal(getTask(card.id).status, "in_review");
});

test("cancellation aborts the cloud process, deletes its machine and preserves archived status", async () => {
  mode("hang"); const card = task(); await start(card.id);
  for (let i = 0; i < 500 && !log().some(x => x.command === "codex"); i++) await new Promise(r => setTimeout(r, 10));
  archiveTask(card.id, "supervisor"); await settled(); assert.equal(getTask(card.id).status, "archived");
});

test("plugin shutdown aborts and deletes running machines before resolving", async () => {
  mode("hang"); const card = task(); await start(card.id);
  for (let i = 0; i < 500 && !log().some(x => x.command === "codex"); i++) await new Promise(r => setTimeout(r, 10));
  await stopCloudRuns(); assert.deepEqual(machines(), []); assert.equal(getTask(card.id).status, "ready");
});

test("a cancelled cloud generation cannot alter a newer local execution on the same card", async () => {
  mode("hang"); const card = task(); await start(card.id);
  for (let i = 0; i < 500 && !log().some(x => x.command === "codex"); i++) await new Promise(resolve => setTimeout(resolve, 10));
  getDb().prepare("UPDATE tasks SET status = 'ready', workspace_kind = 'dir', workspace_path = ? WHERE id = ?").run(repo, card.id);
  config({ enabled: false }); await start(card.id); await settled();
  assert.equal(getTask(card.id).status, "running"); assert.equal(getTask(card.id).agent_id, "local-fixture"); assert.equal(getTask(card.id).fail_count, 0);
});

test("shutdown waits for an in-flight public preflight and never creates a late machine", async () => {
  let entered = false; let release!: (value: boolean) => void;
  setCloudRuntimeForTests({ ...fixtureRuntime, publicRepository: () => { entered = true; return new Promise(resolve => { release = resolve; }); } });
  const card = task(); const pending = start(card.id);
  for (let i = 0; i < 500 && !entered; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(entered); const stopped = stopCloudRuns(); release(true); await pending; await stopped;
  assert.equal(getTask(card.id).status, "ready"); assert.equal(log().some(x => x.args[0] === "create"), false);
});

test("plugin shutdown waits for an in-flight machine inventory reconciliation", async () => {
  let entered = false; let release!: () => void;
  setCloudRuntimeForTests({ ...fixtureRuntime, run: async (command, args, options) => {
    if (command === "instabox" && args[0] === "ls") { entered = true; await new Promise<void>(resolve => { release = resolve; }); }
    return fixtureRuntime.run(command, args, options);
  } });
  const pending = reconcileCloudMachines();
  for (let i = 0; i < 500 && !entered; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(entered); let finished = false;
  const stopped = stopCloudRuns().then(() => { finished = true; });
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(finished, false);
  release(); await pending; await stopped; assert.equal(finished, true);
});

test("host bindings share active cloud workers and a fresh bind can restart after shutdown", async () => {
  const first = bindCloudRunner(); await first.ready;
  mode("hang"); const card = task(); await start(card.id);
  const second = bindCloudRunner(); await second.ready; await first.release(); assert.equal(getTask(card.id).status, "running");
  const shutdown = second.release(); const restarted = bindCloudRunner(); await Promise.all([shutdown, restarted.ready]);
  assert.deepEqual(machines(), []); assert.equal(getTask(card.id).status, "ready"); mode("");
  const next = task(); await start(next.id); await settled(); assert.equal(getTask(next.id).status, "in_review"); await restarted.release();
});

for (const forbidden of ["private", "anonymous-denied"]) test(`${forbidden} repository is refused before any machine is created`, async () => {
  mode(forbidden); const card = task(); await start(card.id); await settled();
  assert.equal(getTask(card.id).blocked_kind, "capability"); assert.equal(log().some(x => x.args[0] === "create"), false);
});

test("Claude profiles are refused without opening a cloud or local executor", async () => {
  const card = task(); await start(card.id, { ...codex, provider: "claude", family: "anthropic", model: "claude-sonnet-5" }); await settled();
  assert.equal(getTask(card.id).blocked_kind, "capability"); assert.equal(localCreates, 0); assert.equal(log().some(x => x.args[0] === "create"), false);
});

test("privacy findings block before push or draft PR creation", async () => {
  mode("privacy"); const card = task(); await start(card.id); await settled();
  assert.equal(getTask(card.id).blocked_kind, "needs_human"); assert.match(getTask(card.id).blocked_reason!, /privacy/i);
  assert.equal(log().some(x => x.command === "gh" || x.args.includes("push")), false);
});

test("short internal ticket identifiers block the fetched bundle before push or draft PR creation", async () => {
  mode("short-ticket"); const card = task(); await start(card.id); await settled();
  assert.equal(getTask(card.id).blocked_kind, "needs_human"); assert.match(getTask(card.id).blocked_reason!, /internal-ticket/);
  assert.ok(log().some(x => x.command === "git" && x.args.includes("fetch") && x.args.some(arg => arg.endsWith(".bundle"))));
  assert.equal(log().some(x => x.command === "gh" || x.args.includes("push")), false);
  assert.equal(git(remote, "for-each-ref", "--format=%(refname)"), "refs/heads/main");
});

test("privacy scanning rejects short internal ticket identifiers independently of the private denylist", () => {
  for (const digits of ["1", "12", "123", "1234"]) {
    const ticket = ["PCC", digits].join("_");
    assert.ok(cloudPrivacyFindings(ticket, "/srv/reviewer").includes("internal-ticket"));
    assert.ok(cloudPrivacyFindings(`prefix${ticket}suffix`, "/srv/reviewer").includes("internal-ticket"));
  }
});

test("the shared host private denylist blocks cloud publication without exporting its terms", async () => {
  mode("denylist"); const card = task(); await start(card.id); await settled();
  assert.equal(getTask(card.id).blocked_kind, "needs_human"); assert.match(getTask(card.id).blocked_reason!, /private-denylist/);
  assert.equal(log().some(x => x.args.includes("push")), false);
  assert.equal(log().filter(x => x.command === "instabox").some(x => x.args.join(" ").includes("CloudPrivateTerm")), false);
});

test("CJK filenames are scanned as decoded paths instead of Git octal escapes", async () => {
  mode("cjk-path"); const card = task(); await start(card.id); await settled();
  assert.equal(getTask(card.id).blocked_kind, "needs_human"); assert.match(getTask(card.id).blocked_reason!, /cjk/);
  assert.equal(log().some(x => x.args.includes("push")), false);
});

test("disabled switch preserves the original local execution path without invoking InstaBox", async () => {
  config({ enabled: false }); const card = task(); await start(card.id);
  assert.equal(localCreates, 1); assert.equal(getTask(card.id).status, "running"); assert.equal(log().some(x => x.command === "instabox"), false);
});

test("an untagged card stays local even when its project enables cloud execution", async () => {
  const card = task(false); await start(card.id);
  assert.equal(localCreates, 1); assert.equal(getTask(card.id).status, "running");
  assert.equal(log().some(x => x.command === "instabox"), false);
});

test("a configured non-main branch is used for the clone, task ancestry and draft PR base", async () => {
  git(remote, "branch", "preview", "main");
  const settings = loadConfig(); settings.projects!["paseo-clear-chat"].baseBranch = "preview"; saveConfig(settings);
  const card = task(); await start(card.id); await settled(); assert.equal(getTask(card.id).status, "in_review");
  const clone = log().find(x => x.command === "git" && x.args.includes("--single-branch"))!;
  assert.equal(clone.args[clone.args.indexOf("--branch") + 1], "preview");
  const pr = log().find(x => x.command === "gh")!; assert.equal(pr.args[pr.args.indexOf("--base") + 1], "preview");
  assert.equal(git(remote, "show", "preview:fixture.txt"), "Before");
});

test("cloud parallel limit and the shared global limit hold new cards without local worktrees", async () => {
  mode("hang"); config({ maxParallel: 1 }); const first = task(); const second = task();
  await start(first.id); await start(second.id);
  assert.equal(getTask(second.id).status, "ready"); assert.match(getTask(second.id).hold_reason!, /parallel/i);
  assert.equal(currentOccupancy([codex]).global, 1); assert.equal(localCreates, 0); await stopCloudRuns();
});

test("shared global capacity gates cloud cards as well as local work", async () => {
  mode("hang"); const settings = loadConfig(); settings.concurrency.global = 1; saveConfig(settings);
  const first = task(); const second = task(); await start(first.id); await start(second.id);
  assert.equal(getTask(first.id).status, "running"); assert.equal(getTask(second.id).status, "ready");
  assert.match(getTask(second.id).hold_reason!, /global/i); await stopCloudRuns();
});

test("startup reconciliation deletes only this board prefix and retries interrupted generations", async () => {
  mkdirSync(join(dir, "boxes", `${cloudBoardPrefix()}demo-0001-g1`));
  mkdirSync(join(dir, "boxes", "unrelated-machine"));
  await reconcileCloudMachines(); assert.deepEqual(machines(), ["unrelated-machine"]);
  rmSync(join(dir, "boxes", "unrelated-machine"), { recursive: true });
});

test("startup reconciliation recovers a persisted interrupted run after deleting its orphan", async () => {
  const card = task(); const machine = `${cloudBoardPrefix()}demo-0001-g4`;
  const result = getDb().prepare("INSERT INTO runs (task_id, role, started_at) VALUES (?, 'executor', ?)").run(card.id, new Date().toISOString());
  getDb().prepare("UPDATE tasks SET status = 'running', workspace_kind = 'none' WHERE id = ?").run(card.id);
  appendEvent(card.id, "cloud_run_started", null, null, "scheduler", { generation: 4, machine, branch: `kanban/cloud-${machine}`, repo: "example/paseo-clear-chat", base: "main", mirror: join(dir, "mirrors/paseo-clear-chat.git"), originalPath: repo, originalKind: "dir", runId: Number(result.lastInsertRowid) });
  mkdirSync(join(dir, "boxes", machine)); await reconcileCloudMachines();
  assert.deepEqual(machines(), []); assert.equal(getTask(card.id).status, "ready"); assert.equal(getTask(card.id).fail_count, 0);
  assert.equal(getTask(card.id).workspace_path, repo);
});

test("startup recovers a persisted draft PR receipt without pushing or creating a second PR", async () => {
  const card = task(); await start(card.id); await settled(); const delivered = cloudDelivery(card.id)!;
  getDb().prepare("UPDATE tasks SET status = 'running', handoff_json = NULL, contract_json = ? WHERE id = ?").run("github:example/paseo-clear-chat", card.id);
  getDb().prepare("DELETE FROM events WHERE task_id = ? AND kind IN ('cloud_delivery', 'cloud_run_cleaned', 'cloud_run_settled')").run(card.id);
  getDb().prepare("UPDATE runs SET ended_at = NULL, end_kind = NULL WHERE id = ?").run(delivered.runId);
  setCloudRuntimeForTests(fixtureRuntime); await reconcileCloudMachines();
  assert.equal(getTask(card.id).status, "in_review"); assert.equal(cloudDelivery(card.id)!.head, delivered.head);
  assert.equal(log().filter(x => x.command === "gh").length, 1); assert.deepEqual(machines(), []);
});

test("deletion failure blocks publication handoff and startup retries the durable cleanup record", async () => {
  mode("rm-fail"); const card = task(); await start(card.id); await waitForCloudRuns();
  assert.equal(getTask(card.id).blocked_kind, "needs_human"); assert.equal(machines().length, 1);
  assert.match(getTask(card.id).blocked_reason!, /deletion/);
  mode(""); await reconcileCloudMachines(); assert.deepEqual(machines(), []);
});

test("two cloud cards share a mirror safely while respecting the default parallel limit", async () => {
  const first = task(); const second = task(); await Promise.all([start(first.id), start(second.id)]); await settled();
  assert.equal(getTask(first.id).status, "in_review"); assert.equal(getTask(second.id).status, "in_review");
  assert.equal(log().filter(x => x.command === "gh").length, 2);
});

test("template age warns before Grok expiry and refuses an already expired template before creation", async () => {
  config({ templateRefreshedAt: new Date(Date.now() - 6.2 * 86_400_000).toISOString() });
  const first = task(); await start(first.id, grok); await settled(); assert.equal(getTask(first.id).status, "in_review");
  assert.ok(getDb().prepare("SELECT id FROM events WHERE task_id = ? AND kind = 'cloud_leader_notice'").get(first.id));
  config({ templateRefreshedAt: new Date(Date.now() - 8 * 86_400_000).toISOString() });
  const second = task(); await start(second.id, grok); await settled(); assert.equal(getTask(second.id).blocked_kind, "capability");
  assert.equal(log().filter(x => x.command === "instabox" && x.args[0] === "create").length, 1);
});

test("privacy rules reject paths, host usernames, internal tickets, CJK and personal identities", () => {
  assert.deepEqual(cloudPrivacyFindings("Clean English text and noreply@github.com", join("/", "home", "demo-user")), []);
  for (const text of [join("/", "Users", "demo-user", "file"), "demo-user", "DEMO_0001", "\u65e5\u672c\u8a9e", "person@example.com"]) {
    assert.ok(cloudPrivacyFindings(text, join("/", "home", "demo-user")).length > 0);
  }
});

test("each cloud install, agent and test command receives the same card-local TMPDIR and KANBAN_TMP", async () => {
  const card = task(); await start(card.id); await settled(); assert.equal(getTask(card.id).status, "in_review");
  const steps = log().filter(x => ["npm", "codex"].includes(x.command)); assert.equal(steps.length, 3);
  for (const step of steps) {
    assert.equal(step.tmpdir, step.kanbanTmp); assert.match(step.tmpdir!, /\/home\/work\/\.kanban-work\/DEMO_0001$/);
  }
});

function directoriesFixture() {
  for (const name of ["web", "pipeline"]) {
    mkdirSync(join(repo, name));
    writeFileSync(join(repo, name, "package.json"), readFileSync(join(repo, "package.json")));
    writeFileSync(join(repo, name, "package-lock.json"), readFileSync(join(repo, "package-lock.json")));
  }
  git(repo, "add", "."); git(repo, "commit", "-m", "Add package directories"); git(remote, "fetch", repo, "main:main");
  config({ directories: ["web", "pipeline"] });
}

test("multiple configured package directories install and test in their declared order", async () => {
  directoriesFixture(); const card = task(); await start(card.id); await settled(); assert.equal(getTask(card.id).status, "in_review");
  const steps = log().filter(x => x.command === "npm");
  assert.deepEqual(steps.map(x => [x.args[0], x.cwd!.split("/").at(-1)]), [["ci", "web"], ["ci", "pipeline"], ["test", "web"], ["test", "pipeline"]]);
});

for (const name of ["web", "pipeline"]) test(`failure installing package directory ${name} aborts execution and deletes its machine`, async () => {
  directoriesFixture(); mode(`directory-fail-${name}`); const card = task(); await start(card.id); await settled();
  assert.equal(getTask(card.id).status, "blocked"); assert.equal(log().some(x => x.command === "codex" || x.args.includes("push")), false);
  const installs = log().filter(x => x.command === "npm"); assert.equal(installs.at(-1)!.cwd!.split("/").at(-1), name);
});

test("first cloud request_changes redispatches on the next scheduler tick and refreshes the review copy", async () => {
  const card = task(); await start(card.id); await settled();
  const first = cloudDelivery(card.id)!; const copies = new Map<string, string>(); let count = 0;
  const reviewLauncher: AgentLauncher = {
    ...launcher,
    async createWorktree(options) {
      const directory = join(dir, `review-${++count}`); git(options.cwd, "worktree", "add", "-b", options.branchName, directory, options.baseBranch);
      const workspaceId = `review-${count}`; copies.set(workspaceId, directory); return { directory, workspaceId, head: git(directory, "rev-parse", "HEAD") };
    },
    async listAgents() { return []; },
    async archiveWorkspace(id) { const directory = copies.get(id); if (directory) git(first.mirror, "worktree", "remove", directory); },
  };
  await startTask(card.id, reviewLauncher, "test", { profiles: [codex, reviewer], chosen: reviewer });
  assert.equal(getTask(card.id).status, "reviewing"); assert.equal(git(getTask(card.id).workspace_path!, "rev-parse", "HEAD"), first.head);
  requestChanges(card.id, "Refine the fixture", "Keep the existing change and add the next edit.");
  assert.equal(getTask(card.id).review_round, 1); assert.equal(getTask(card.id).executor_agent_id, null);
  assert.equal(loadConfig().reworkReassignHours, 2);
  mode("edit-again");
  const tick = await runTick({ launcher: reviewLauncher, profiles: [codex, reviewer], now: new Date(), agentState: () => "missing" });
  assert.deepEqual(tick.errors, []); assert.deepEqual(tick.started, [card.id], JSON.stringify(tick));
  await settled(); assert.equal(getTask(card.id).status, "in_review");
  assert.equal(getDb().prepare("SELECT id FROM events WHERE task_id = ? AND kind = 'rework_wait_started'").get(card.id), undefined);
  const second = cloudDelivery(card.id)!; assert.notEqual(second.head, first.head); assert.equal(cloudRunRecord(card.id)!.generation, 2);
  await startTask(card.id, reviewLauncher, "test", { profiles: [codex, reviewer], chosen: reviewer });
  assert.equal(getTask(card.id).status, "reviewing"); assert.equal(git(getTask(card.id).workspace_path!, "rev-parse", "HEAD"), second.head);
  requestChanges(card.id, "Request a leader ruling", "The second rejection must stay parked.");
  const held = await runTick({ launcher: reviewLauncher, profiles: [codex, reviewer], now: new Date(), agentState: () => "missing" });
  assert.deepEqual(held.errors, []); assert.deepEqual(held.started, []);
  assert.equal(getTask(card.id).status, "rework"); assert.equal(getTask(card.id).review_round, 2);
  assert.equal(cloudRunRecord(card.id)!.generation, 2);
  assert.equal(log().filter(x => x.command === "instabox" && x.args[0] === "create").length, 2);
});


function additionalProject(name = "demo-web", allowed = false) {
  const settings = loadConfig();
  settings.projects![name] = { ...settings.projects!["paseo-clear-chat"], code: "WEB" };
  if (allowed) settings.cloud!.allowedProjects.push(name);
  saveConfig(settings);
  return (cloud = true) => createTask({ project: name, title: "Improve fixture", brief: "Update the fixture and run tests.", role: "executor", workspacePath: repo, contract: "github:example/demo-web", tags: cloud ? ["cloud"] : [] });
}

test("unlisted enabled project stays readable, refuses only cloud cards and warns once per project", async () => {
  const makeTask = additionalProject();
  const settings = loadConfig(); settings.supervisorAgentId = "fixture-leader"; saveConfig(settings);
  assert.equal(loadConfig().projects!["demo-web"].cloudRunner!.enabled, true);
  setAgentAliveCheck(() => true);
  const messages: string[] = []; setWakeSender((_id, text) => { messages.push(text); });
  const first = makeTask(); const second = makeTask();
  for (const card of [first, second]) {
    await start(card.id);
    assert.equal(getTask(card.id).status, "ready");
    assert.match(getTask(card.id).hold_reason!, /allowedProjects/);
    assert.match((getDb().prepare("SELECT body FROM comments WHERE task_id = ?").all(card.id) as { body: string }[]).map(row => row.body).join("\n"), /allowedProjects/);
  }
  setCloudRuntimeForTests(fixtureRuntime); forgetBoardWakesInMemoryForTests();
  await start(first.id); await new Promise(resolve => setImmediate(resolve));
  assert.equal(messages.length, 1);
  assert.equal(log().length, 0, "unlisted dispatch must not probe GitHub or InstaBox");
  await start(makeTask(false).id); assert.equal(localCreates, 1);
  const listed = task(); await start(listed.id); await settled();
  assert.equal(getTask(listed.id).status, "in_review");
});


test("unlisted project warning retries failed delivery and resets when admission is restored", async () => {
  const card = additionalProject()();
  const settings = loadConfig(); settings.supervisorAgentId = "fixture-leader"; saveConfig(settings);
  setAgentAliveCheck(() => true);
  let attempts = 0; let release!: () => void;
  setWakeSender(async () => { attempts++; if (attempts === 1) throw new Error("fixture unavailable"); await new Promise<void>(resolve => { release = resolve; }); });
  assert.match(cloudQueueReason(card)!, /allowedProjects/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(hasBoardWakeMark("cloud-project-refused:demo-web"), false);
  cloudQueueReason(card); cloudQueueReason(card);
  assert.equal(attempts, 2, "concurrent checks share one pending delivery");
  release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(hasBoardWakeMark("cloud-project-refused:demo-web"), true);
  const allowed = loadConfig(); allowed.cloud!.allowedProjects.push("demo-web"); saveConfig(allowed);
  assert.equal(cloudQueueReason(card), null);
  assert.equal(hasBoardWakeMark("cloud-project-refused:demo-web"), false);
  assert.equal((getDb().prepare("SELECT body FROM comments WHERE task_id = ? AND body LIKE '%allowedProjects%'").all(card.id)).length, 1);
});

test("only unlisted public opt-ins do not trigger cloud inventory and defaults keep disabled projects local", async () => {
  const settings = loadConfig(); settings.cloud!.allowedProjects = []; saveConfig(settings);
  await reconcileCloudMachines(); assert.deepEqual(log(), []);
  const card = task(); await start(card.id);
  assert.match(getTask(card.id).hold_reason!, /allowedProjects/); assert.equal(localCreates, 0);
  config({ enabled: false }); await start(card.id); assert.equal(localCreates, 1);
  assert.deepEqual(log(), []);
});

test("scheduler records an unlisted project refusal without stopping listed dispatch", async () => {
  const denied = additionalProject()(); const allowed = task();
  const result = await runTick({ launcher, profiles: [codex, reviewer], now: new Date(), agentState: () => "missing" });
  assert.deepEqual(result.errors, []); assert.ok(result.held.some(row => row.id === denied.id && /allowedProjects/.test(row.reason)));
  await settled(); assert.equal(getTask(allowed.id).status, "in_review");
  assert.equal(getTask(denied.id).status, "ready");
});

test("listed public project with a different repository name passes anonymous proof and uses its own mirror", async () => {
  const makeTask = additionalProject("demo-web", true);
  // A distinct checkout avoids the origin cache used by the existing project.
  const otherRepo = join(dir, "demo-web"); git(dir, "clone", repo, otherRepo);
  git(otherRepo, "remote", "set-url", "origin", "https://github.com/example/demo-web.git");
  const settings = loadConfig(); settings.projects!["demo-web"].workspacePath = otherRepo; saveConfig(settings);
  const card = makeTask(); await start(card.id); await settled();
  assert.equal(getTask(card.id).status, "in_review", getTask(card.id).blocked_reason ?? "");
  assert.equal(cloudRunRecord(card.id)!.repo, "example/demo-web");
  assert.ok(log().some(row => row.command === "codex" && row.cwd === join(dir, "boxes", cloudRunRecord(card.id)!.machine, "home", "work", "demo-web")), "the cloud agent must run in the matching repository directory");
  assert.equal(cloudRunRecord(card.id)!.mirror, join(dir, "mirrors", "demo-web.git"));
  assert.ok(log().some(row => row.command === "git" && row.args.includes("ls-remote") && row.args.includes("https://github.com/example/demo-web.git")));
});

test("listed project still refuses private repositories", async () => {
  const card = additionalProject("demo-web", true)(); mode("private");
  await start(card.id);
  assert.equal(getTask(card.id).status, "blocked");
  assert.match(getTask(card.id).blocked_reason!, /private|anonymous/i);
  assert.equal(log().some(row => row.command === "instabox"), false);
});

test("configuration defaults off, bounds limits and preserves unlisted enabled projects", () => {
  assert.equal(parseConfig({}).projects?.["paseo-clear-chat"]?.cloudRunner?.enabled ?? false, false);
  assert.equal(parseConfig({ projects: { other: { defaultWorkspace: "dir", cloudRunner: { enabled: true } } } }).projects!.other.cloudRunner!.enabled, true);
  assert.throws(() => parseConfig({ projects: { "paseo-clear-chat": { defaultWorkspace: "dir", cloudRunner: { enabled: true, maxParallel: 0 } } } }));
  setProjectWorkspace("paseo-clear-chat", { parallel: false }); setProjectCode("paseo-clear-chat", "DEMO");
  assert.equal(loadConfig().projects!["paseo-clear-chat"].cloudRunner?.enabled, true);
});

test("cloud configuration expresses runtime versions, per-directory installs and non-secret environment", () => {
  for (const runtime of ["npm", "bun"]) {
    const runtimeVersion = runtime === "npm" ? "24.20.0" : "1.4.2";
    const installCommand = runtime === "npm" ? ["npm", "ci"] : ["bun", "install", "--frozen-lockfile"];
    const testCommand = runtime === "npm" ? ["npm", "test"] : ["bun", "run", "test"];
    const directories = [".", ...["web", "pipeline", "astro"].map(path => ({ path, installCommand }))];
    const environment = { BLOB_BASE_URL: "https://example.invalid/blobs", SEO_LIVE_BASE: "" };
    config({ runtime, runtimeVersion, directories, environment, installCommand, testCommand });
    const parsed = loadConfig().projects!["paseo-clear-chat"].cloudRunner!;
    assert.equal(parsed.runtimeVersion, runtimeVersion); assert.deepEqual(parsed.directories, directories);
    assert.deepEqual(parsed.environment, environment); assert.deepEqual(parsed.testCommand, testCommand);
  }
});

test("cloud configuration rejects secret environment keys or values and reserved environment overrides", () => {
  const parse = (cloudRunner: Record<string, unknown>) => parseConfig({ projects: { "paseo-clear-chat": { defaultWorkspace: "dir", cloudRunner } } });
  for (const key of ["API_TOKEN", "CLIENT_SECRET", "PUBLIC_KEY", "DATABASE_PASSWORD", "TMPDIR", "KANBAN_TMP", "HOME", "PATH", "GIT_CONFIG_GLOBAL", "NODE_OPTIONS"]) {
    assert.throws(() => parse({ environment: { [key]: "demo" } }), Error, key);
  }
  for (const value of ["Bearer " + "a".repeat(25), "sk-" + "a".repeat(25), "demo_PASSWORD", "https://user:pass@example.invalid/"]) {
    assert.throws(() => parse({ environment: { DEMO_VALUE: value } }));
  }
  for (const runtimeVersion of ["24", "v24.20.0", "24.20.0;echo demo", "../node"]) assert.throws(() => parse({ runtimeVersion }));
  assert.throws(() => parse({ directories: [{ path: "../web", installCommand: ["npm", "ci"] }] }));
  assert.throws(() => parse({ directories: [{ path: "web", installCommand: ["bun", "install"] }] }));
});

test("per-directory install overrides and non-secret environment reach cloud steps with protected card scratch", async () => {
  directoriesFixture();
  const environment = { BLOB_BASE_URL: "https://example.invalid/blobs?label='demo'", SEO_LIVE_BASE: "" };
  config({ runtimeVersion: process.versions.node, directories: [{ path: "web", installCommand: ["npm", "ci", "--ignore-scripts"] }, "pipeline"], environment });
  const card = task(); await start(card.id); await settled(); assert.equal(getTask(card.id).status, "in_review");
  const steps = log().filter(x => x.command === "npm" || x.command === "codex");
  assert.equal(steps.length, 5); assert.deepEqual(steps[0].args, ["ci", "--ignore-scripts"]);
  assert.deepEqual(steps[1].args, ["ci", "--no-audit", "--no-fund"]);
  const scratch = join(dir, "boxes", cloudRunRecord(card.id)!.machine, "home/work/.kanban-work/DEMO_0001");
  for (const step of steps) {
    assert.equal(step.blobBaseUrl, environment.BLOB_BASE_URL); assert.equal(step.seoLiveBase, "");
    assert.equal(step.tmpdir, scratch); assert.equal(step.kanbanTmp, scratch);
  }
});

test("a configured Node version mismatch stops before package installation and deletes the cloud machine", async () => {
  config({ runtimeVersion: "0.0.0" }); const card = task(); await start(card.id); await settled();
  assert.equal(getTask(card.id).blocked_kind, "capability");
  assert.equal(log().some(x => ["npm", "codex", "gh"].includes(x.command) || x.args.includes("push")), false);
});

for (const reserved of [{ mode: "persistent" }]) test(`reserved cloud configuration ${JSON.stringify(reserved)} refuses execution as unimplemented`, async () => {
  config(reserved); const card = task(); await start(card.id); await settled();
  assert.equal(getTask(card.id).blocked_kind, "capability"); assert.match(getTask(card.id).blocked_reason!, /not implemented/i);
  assert.equal(log().some(x => x.command === "instabox"), false);
});

test("scheduler leaves active cloud runs to cloud lifecycle instead of reclaiming a missing local session", async () => {
  mode("hang"); const card = task(); await start(card.id);
  await runTick({ launcher, profiles: [codex, reviewer], now: new Date(Date.now() + 180_000), agentState: () => "missing" });
  assert.equal(getTask(card.id).status, "running"); assert.equal(getTask(card.id).fail_count, 0); await stopCloudRuns();
});


test("inventory outages back off ticks, hold cloud cards, notify once and recover without losing orphans", async () => {
  const card = task(); const ordinary = task(false);
  const orphan = `${cloudBoardPrefix()}demo-0001-g1`;
  mkdirSync(join(dir, "boxes", orphan));
  const messages: string[] = [];
  const settings = loadConfig(); settings.supervisorAgentId = "fixture-leader"; saveConfig(settings);
  setAgentAliveCheck(() => true); setWakeSender((_id, text) => { if (text.includes("InstaBox")) messages.push(text); });
  let attempts = 0; let failing = true;
  setCloudRuntimeForTests({ ...fixtureRuntime, run: async (command, args, options) => {
    if (command === "instabox" && args[0] === "ls") {
      attempts++;
      if (failing) return { code: 1, stdout: "", stderr: JSON.stringify({ error: ["internal error token=fixture-private-value https://demo", ":password@example.invalid/path?key=hidden"].join(""), token: "json-token-private-value", api_key: "json-api-private-value", client_secret: "json secret with spaces and \"quotes\"" }) };
    }
    return fixtureRuntime.run(command, args, options);
  } });
  let now = Date.now() + 1000;
  for (const [index, seconds] of [120, 300, 600, 900, 900].entries()) {
    const tick = await runTick({ launcher, profiles: [], now: new Date(now) });
    assert.equal(tick.errors.filter(error => error.includes("Cloud inventory failed")).length, 1);
    assert.doesNotMatch(tick.errors.join("\n"), /fixture-private-value|json-token-private-value|json-api-private-value|secret with spaces|password@|key=hidden/);
    assert.equal(attempts, index + 1);
    const until = new Date(now + seconds * 1000);
    const hhmm = `${String(until.getHours()).padStart(2, "0")}:${String(until.getMinutes()).padStart(2, "0")}`;
    setLanguage("zh-CN");
    assert.equal(cloudQueueReason(getTask(card.id)), `InstaBox \u6e05\u5355\u8bfb\u53d6\u5931\u8d25\uff0c\u9000\u907f\u81f3 ${hhmm}`);
    setLanguage("en");
    assert.equal(cloudQueueReason(getTask(ordinary.id)), null);
    assert.deepEqual(machines(), [orphan]);
    const skipped = await runTick({ launcher, profiles: [], now: new Date(now + seconds * 1000 - 1) });
    assert.deepEqual(skipped.errors, []); assert.equal(attempts, index + 1);
    assert.equal(messages.length, 1);
    now += seconds * 1000;
  }
  assert.match(messages[0], /internal error/);
  assert.doesNotMatch(messages[0], /fixture-private-value|json-token-private-value|json-api-private-value|secret with spaces|password@|key=hidden/);
  await start(card.id); // Manual dispatch must respect the same barrier even after retry expiry.
  assert.equal(getTask(card.id).status, "ready");
  assert.match(getTask(card.id).hold_reason!, /InstaBox inventory read failed/);
  assert.equal(log().some(call => call.args[0] === "create"), false);
  failing = false;
  const recovered = await runTick({ launcher, profiles: [], now: new Date(now) });
  assert.deepEqual(recovered.errors, []); assert.deepEqual(machines(), []);
  assert.equal(cloudQueueReason(getTask(card.id)), null);
  assert.equal(messages.length, 2); assert.match(messages[1], /recovered/);
  await reconcileCloudMachines(now + 1000); assert.equal(messages.length, 2);
  const next = task(); await start(next.id); await settled(); assert.equal(getTask(next.id).status, "in_review");
});

test("inventory retries are configurable and concurrent callers share one failed attempt", async () => {
  config({ reconcileRetrySec: [2, 3] });
  let attempts = 0;
  setCloudRuntimeForTests({ ...fixtureRuntime, run: async () => { attempts++; return { code: 1, stdout: "", stderr: "internal error" }; } });
  const now = Date.now() + 1000;
  const first = await Promise.allSettled([reconcileCloudMachines(now), reconcileCloudMachines(now)]);
  assert.ok(first.every(result => result.status === "rejected")); assert.equal(attempts, 1);
  await reconcileCloudMachines(now + 1999); assert.equal(attempts, 1);
  await assert.rejects(reconcileCloudMachines(now + 2000)); assert.equal(attempts, 2);
  await reconcileCloudMachines(now + 4999); assert.equal(attempts, 2);
  await assert.rejects(reconcileCloudMachines(now + 5000)); assert.equal(attempts, 3);
  for (const steps of [[], [0], [901], [1.5]]) assert.throws(() => parseConfig({ projects: { "paseo-clear-chat": { defaultWorkspace: "dir", cloudRunner: { reconcileRetrySec: steps } } } }));
});

test("invalid inventory fails closed and disabled unused cloud never calls InstaBox", async () => {
  let attempts = 0;
  setCloudRuntimeForTests({ ...fixtureRuntime, run: async () => { attempts++; return { code: 0, stdout: "{}", stderr: "" }; } });
  await assert.rejects(reconcileCloudMachines(), /inventory is invalid/);
  await reconcileCloudMachines(); assert.equal(attempts, 1);
  setCloudRuntimeForTests({ ...fixtureRuntime, run: async () => { throw new Error("must not invoke"); } });
  config({ enabled: false }); await reconcileCloudMachines();
});


test("inventory notices survive runtime resets and retry a refused recovery delivery", async () => {
  const settings = loadConfig(); settings.supervisorAgentId = "fixture-leader"; saveConfig(settings);
  setAgentAliveCheck(() => true);
  const messages: string[] = []; let refuseRecovery = true;
  setWakeSender((_id, text) => {
    if (text.includes("recovered") && refuseRecovery) throw new Error("fixture transport unavailable");
    messages.push(text);
  });
  const failed: CloudRuntime = { ...fixtureRuntime, run: async () => ({ code: 1, stdout: "", stderr: "internal error" }) };
  setCloudRuntimeForTests(failed); await assert.rejects(reconcileCloudMachines());
  setCloudRuntimeForTests(failed); await assert.rejects(reconcileCloudMachines());
  assert.equal(messages.length, 1);
  setCloudRuntimeForTests(fixtureRuntime); await reconcileCloudMachines();
  assert.equal(messages.length, 1);
  refuseRecovery = false; await reconcileCloudMachines(); await reconcileCloudMachines();
  assert.equal(messages.length, 2); assert.match(messages[1], /recovered/);
});

test("binding again resets inventory backoff but preserves the sent failure notice mark", async () => {
  const settings = loadConfig(); settings.supervisorAgentId = "fixture-leader"; saveConfig(settings);
  setAgentAliveCheck(() => true);
  const messages: string[] = []; setWakeSender((_id, text) => { messages.push(text); });
  let reads = 0; let failing = true;
  setCloudRuntimeForTests({ ...fixtureRuntime, run: async () => {
    reads++;
    return failing ? { code: 1, stdout: "", stderr: "internal error" } : { code: 0, stdout: "[]", stderr: "" };
  } });

  const first = bindCloudRunner(); await first.ready;
  await assert.rejects(reconcileCloudMachines());
  assert.equal(reads, 1); assert.equal(messages.length, 1);
  assert.equal(hasBoardWakeMark("cloud-inventory:paseo-clear-chat"), true);
  await first.release();

  const second = bindCloudRunner(); await second.ready;
  await assert.rejects(reconcileCloudMachines());
  assert.equal(reads, 2, "binding should immediately retry a previously backed-off inventory read");
  assert.equal(messages.length, 1, "the durable failure notice mark should suppress duplicate wakes");
  assert.equal(hasBoardWakeMark("cloud-inventory:paseo-clear-chat"), true);

  failing = false; await second.release();
  const third = bindCloudRunner(); await third.ready;
  await reconcileCloudMachines();
  assert.equal(reads, 3); assert.equal(cloudQueueReason(task()), null);
  assert.equal(hasBoardWakeMark("cloud-inventory:paseo-clear-chat"), false);
  await third.release();
});

test("failed inventory never settles an interrupted generation or treats it as absent", async () => {
  const card = task(); const machine = `${cloudBoardPrefix()}demo-0001-g4`;
  const result = getDb().prepare("INSERT INTO runs (task_id, role, started_at) VALUES (?, 'executor', ?)").run(card.id, new Date().toISOString());
  getDb().prepare("UPDATE tasks SET status = 'running', workspace_kind = 'none' WHERE id = ?").run(card.id);
  appendEvent(card.id, "cloud_run_started", null, null, "scheduler", { generation: 4, machine, branch: "kanban/cloud-fixture", repo: "example/paseo-clear-chat", base: "main", mirror: join(dir, "mirrors/paseo-clear-chat.git"), originalPath: repo, originalKind: "dir", runId: Number(result.lastInsertRowid) });
  setCloudRuntimeForTests({ ...fixtureRuntime, run: async () => ({ code: 1, stdout: "[]", stderr: "internal error" }) });
  await assert.rejects(reconcileCloudMachines()); await reconcileCloudMachines();
  assert.equal(getTask(card.id).status, "running");
  assert.equal(getDb().prepare("SELECT ended_at FROM runs WHERE id = ?").get(result.lastInsertRowid)!.ended_at, null);
  assert.equal(getDb().prepare("SELECT id FROM events WHERE task_id = ? AND kind IN ('cloud_run_cleaned', 'cloud_run_settled')").get(card.id), undefined);
});


test("truncated startup inventory backs off without settling runs and a complete inventory recovers", async () => {
  config({ reconcileRetrySec: [2, 3] });
  const settings = loadConfig(); settings.supervisorAgentId = "fixture-leader"; saveConfig(settings);
  setAgentAliveCheck(() => true);
  const messages: string[] = []; setWakeSender((_id, text) => { messages.push(text); });
  const card = task(); const queued = task(); const machine = `${cloudBoardPrefix()}demo-0001-g4`;
  const result = getDb().prepare("INSERT INTO runs (task_id, role, started_at) VALUES (?, 'executor', ?)").run(card.id, new Date().toISOString());
  getDb().prepare("UPDATE tasks SET status = 'running', workspace_kind = 'none' WHERE id = ?").run(card.id);
  appendEvent(card.id, "cloud_run_started", null, null, "scheduler", { generation: 4, machine, branch: "kanban/cloud-fixture", repo: "example/paseo-clear-chat", base: "main", mirror: join(dir, "mirrors/paseo-clear-chat.git"), originalPath: repo, originalKind: "dir", runId: Number(result.lastInsertRowid) });
  let truncated = true; let reads = 0;
  setCloudRuntimeForTests({ ...fixtureRuntime, run: async (command, args) => {
    assert.equal(command, "instabox"); assert.deepEqual(args, ["ls", "--json"]);
    reads++;
    return { code: 0, stdout: '{"machines":[]}', stderr: "", truncated };
  } });
  const now = Date.now() + 1000;
  const unchanged = () => {
    assert.equal(getTask(card.id).status, "running");
    assert.equal(getDb().prepare("SELECT ended_at FROM runs WHERE id = ?").get(result.lastInsertRowid)!.ended_at, null);
    assert.equal(getDb().prepare("SELECT id FROM events WHERE task_id = ? AND kind IN ('cloud_run_cleaned', 'cloud_run_settled')").get(card.id), undefined);
  };
  await assert.rejects(reconcileCloudMachines(now), /Cloud inventory.*truncated/);
  unchanged();
  assert.match(cloudQueueReason(getTask(queued.id))!, /InstaBox inventory read failed/);
  await start(queued.id);
  assert.equal(getTask(queued.id).status, "ready");
  assert.match(getTask(queued.id).hold_reason!, /InstaBox inventory read failed/);
  await reconcileCloudMachines(now + 1999); assert.equal(reads, 1);
  await assert.rejects(reconcileCloudMachines(now + 2000), /truncated/);
  unchanged(); assert.equal(reads, 2); assert.equal(messages.length, 1);
  await reconcileCloudMachines(now + 4999); assert.equal(reads, 2);
  truncated = false;
  await reconcileCloudMachines(now + 5000);
  assert.equal(reads, 3); assert.equal(getTask(card.id).status, "ready");
  assert.equal(getTask(card.id).workspace_path, repo);
  assert.ok(getDb().prepare("SELECT ended_at FROM runs WHERE id = ?").get(result.lastInsertRowid)!.ended_at);
  const events = getDb().prepare("SELECT kind, data_json FROM events WHERE task_id = ? AND kind IN ('cloud_run_cleaned', 'cloud_run_settled') ORDER BY id").all(card.id);
  assert.deepEqual(events.map(row => row.kind), ["cloud_run_cleaned", "cloud_run_settled"]);
  assert.ok(events.every(row => JSON.parse(String(row.data_json)).generation === 4));
  assert.equal(cloudQueueReason(getTask(queued.id)), null);
  assert.equal(messages.length, 2); assert.match(messages[1], /recovered/);
  await reconcileCloudMachines(now + 6000); assert.equal(reads, 3); assert.equal(messages.length, 2);
});

test("a rejected recovery notice cannot turn successful reconciliation into a cloud hold", async () => {
  const card = task();
  const settings = loadConfig(); settings.supervisorAgentId = "fixture-leader"; saveConfig(settings);
  const messages: string[] = [];
  setAgentAliveCheck(() => true); setWakeSender((_id, text) => { messages.push(text); });
  let failing = true; let reads = 0;
  setCloudRuntimeForTests({ ...fixtureRuntime, run: async (command, args, options) => {
    if (command === "instabox" && args[0] === "ls") {
      reads++;
      if (failing) return { code: 1, stdout: "", stderr: "internal error" };
    }
    return fixtureRuntime.run(command, args, options);
  } });
  const now = Date.now() + 1000;
  await assert.rejects(reconcileCloudMachines(now));
  assert.ok(cloudQueueReason(getTask(card.id))); assert.equal(messages.length, 1);
  failing = false; let noticeRejected = 0;
  // triageRecipient executes inside notifyCloudReconcile, before sendWake can catch errors.
  setAgentAliveCheck(() => { noticeRejected++; throw new Error("fixture notice preparation rejected"); });
  await reconcileCloudMachines(now + 900_000);
  assert.equal(noticeRejected, 1); assert.equal(reads, 2);
  assert.equal(cloudQueueReason(getTask(card.id)), null); assert.equal(messages.length, 1);
  await reconcileCloudMachines(now + 901_000);
  assert.equal(cloudQueueReason(getTask(card.id)), null); assert.equal(reads, 2);
  setAgentAliveCheck(() => true);
  await reconcileCloudMachines(now + 902_000); await reconcileCloudMachines(now + 903_000);
  assert.equal(cloudQueueReason(getTask(card.id)), null); assert.equal(reads, 2);
  assert.equal(messages.length, 2); assert.match(messages[1], /recovered/);
});


test("default inventory backoff skips the next production-period tick despite timer drift", async () => {
  const settings = loadConfig(); settings.supervisorAgentId = "fixture-leader"; saveConfig(settings);
  setAgentAliveCheck(() => true); setWakeSender(() => {}); noteTickSuccess();
  let reads = 0;
  setCloudRuntimeForTests({ ...fixtureRuntime, run: async () => { reads++; return { code: 1, stdout: "", stderr: "internal error" }; } });
  const now = Date.now() + 1000;
  const failedTicks: number[] = []; let previousFailed = false;
  for (let index = 0; index < 21; index++) {
    // One-minute production cadence plus a second of drift; the CLI fails immediately.
    const tick = await runTick({ launcher, profiles: [], now: new Date(now + index * 61_000) });
    const failed = tick.errors.length > 0;
    assert.equal(previousFailed && failed, false, `consecutive errors at tick ${index}`);
    if (failed) { failedTicks.push(index); noteTickFailure(tick.errors.join("\n")); }
    else { assert.deepEqual(tick.errors, []); noteTickSuccess(); }
    assert.equal(hasBoardWakeMark("tick_error"), false);
    previousFailed = failed;
  }
  assert.deepEqual(failedTicks, [0, 2, 7, 17]); assert.equal(reads, 4);
});

// Local mirrors exercise the same fake CLI, real Git and production transfer workers.
function localTask() {
  git(repo, "remote", "remove", "origin");
  const current = loadConfig();
  current.projects!["paseo-kanban"] = { ...current.projects!["paseo-clear-chat"], code: "DEMO", cloudRunner: { ...current.projects!["paseo-clear-chat"].cloudRunner!, source: "localMirror" } };
  delete current.projects!["paseo-clear-chat"]; saveConfig(current);
  setCloudRuntimeForTests({ ...fixtureRuntime, publicRepository: async () => { throw new Error("Local mirror called GitHub"); } });
  return createTask({ project: "paseo-kanban", title: "Improve fixture", brief: "Update the fixture and run tests.", role: "executor", workspacePath: repo, contract: "local-only", tags: ["cloud"] });
}
function noGithub() {
  assert.equal(log().some(x => x.command === "gh" || x.args.includes("push") || x.args.includes("ls-remote") || x.args.some(a => a.includes("https://github.com/"))), false);
}
for (const setting of ["absent", "default-source", "localMirror"] as const) test(`local project stays local with cloud configuration ${setting} disabled`, async () => {
  const card = localTask(); const current = loadConfig();
  if (setting === "absent") delete current.projects!["paseo-kanban"].cloudRunner;
  else {
    current.projects!["paseo-kanban"].cloudRunner!.enabled = false;
    if (setting === "default-source") delete (current.projects!["paseo-kanban"].cloudRunner as { source?: string }).source;
  }
  saveConfig(current);
  await start(card.id); await settled();
  assert.equal(getTask(card.id).status, "running"); assert.equal(getTask(card.id).agent_id, "local-fixture");
  assert.equal(localCreates, 1); assert.equal(cloudRunRecord(card.id), null);
  assert.equal(log().some(x => x.command === "instabox"), false); noGithub();
});

test("local parallel cards retain separate pinned bases when main advances between uploads", { timeout: 60000 }, async () => {
  const first = localTask(); const baseA = git(repo, "rev-parse", "main");
  let entered!: () => void; const firstUploaded = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void; const secondUploaded = new Promise<void>(resolve => { release = resolve; });
  let executions = 0;
  setCloudRuntimeForTests({ ...fixtureRuntime, publicRepository: async () => { throw new Error("Local mirror called GitHub"); }, run: async (file, args, options) => {
    if (file === "instabox" && args[0] === "exec" && args.at(-1)?.startsWith("echo ")) {
      const script = Buffer.from(args.at(-1)!.split(" ")[1], "base64").toString("utf8");
      if (script.includes('clone --template= --single-branch --branch source')) {
        if (++executions === 1) { entered(); await secondUploaded; } else release();
      }
    }
    return fixtureRuntime.run(file, args, options);
  } });
  try {
    await start(first.id); await firstUploaded;
    writeFileSync(join(repo, "advance.txt"), "Concurrent baseline\n"); git(repo, "add", "."); git(repo, "commit", "-m", "Advance baseline");
    const baseB = git(repo, "rev-parse", "main");
    const second = createTask({ project: "paseo-kanban", title: "Second fixture", brief: "Update the fixture and run tests.", role: "executor", workspacePath: repo, contract: "local-only", tags: ["cloud"] });
    await start(second.id); await settled();
    assert.equal(executions, 2);
    const receipts = [localCloudReceipt(first.id)!, localCloudReceipt(second.id)!];
    assert.deepEqual(receipts.map(row => row?.sourceBase), [baseA, baseB]);
    assert.notEqual(receipts[0].snapshotCommit, receipts[1].snapshotCommit);
    assert.notEqual(getTask(first.id).workspace_path, getTask(second.id).workspace_path);
    for (const [index, card] of [first, second].entries()) {
      assert.equal(getTask(card.id).status, "in_review");
      assert.equal(git(repo, "rev-parse", `${receipts[index].localHead}^`), receipts[index].sourceBase);
      await startTask(card.id, launcher, "test", { profiles: [codex, reviewer], chosen: reviewer });
      assert.equal(getTask(card.id).status, "reviewing");
      assert.equal(git(getTask(card.id).workspace_path!, "rev-parse", "HEAD"), receipts[index].localHead);
    }
    assert.equal(existsSync(join(getTask(first.id).workspace_path!, "advance.txt")), false);
    assert.equal(readFileSync(join(getTask(second.id).workspace_path!, "advance.txt"), "utf8"), "Concurrent baseline\n");
    assert.equal(git(repo, "rev-parse", "main"), baseB); noGithub();
  } finally { release(); }
});

test("local source snapshot tree mismatch is rejected before importing a result into the project", async () => {
  const card = localTask(); const base = git(repo, "rev-parse", "main"); let checkedTree = false;
  setCloudRuntimeForTests({ ...fixtureRuntime, run: async (file, args, options) => {
    const result = await fixtureRuntime.run(file, args, options);
    if (file === "git" && args.includes("rev-parse") && args.some(value => value.endsWith("^{tree}")) && args.some(value => value.endsWith("result.git"))) {
      checkedTree = true;
      // A successful Git read reports a tree that disagrees with the host-stamped source mapping.
      return { ...result, stdout: "0".repeat(40) + "\n" };
    }
    return result;
  } });
  await start(card.id); await settled(); assert.equal(checkedTree, true);
  assert.equal(getTask(card.id).status, "blocked"); assert.equal(localCloudReceipt(card.id), null);
  assert.equal(git(repo, "rev-parse", "main"), base);
  assert.equal(git(repo, "for-each-ref", "--format=%(refname)", "refs/heads/kanban/"), "");
  const row = getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'cloud_stage_failed'").get(card.id)!;
  assert.equal(JSON.parse(row.data_json as string).code, "cloud_local_result_invalid"); noGithub();
});

test("local Grok template expiry refuses dispatch before creating or uploading", async () => {
  const card = localTask(); const current = loadConfig();
  current.projects!["paseo-kanban"].cloudRunner!.templateRefreshedAt = new Date(Date.now() - 8 * 86_400_000).toISOString(); saveConfig(current);
  await start(card.id, grok); await settled();
  assert.equal(getTask(card.id).blocked_kind, "capability"); assert.match(getTask(card.id).blocked_reason!, /Grok.*expired.*refresh/i);
  assert.equal(cloudRunRecord(card.id), null); assert.equal(localCloudReceipt(card.id), null);
  assert.equal(log().some(x => x.command === "instabox" && ["create", "exec"].includes(x.args[0])), false); noGithub();
});

for (const failure of ["expired-zero", "agent-no-capacity", "agent-quota-exceeded"]) test(`local Grok ${failure} after upload deletes the machine without capacity requeue`, async () => {
  const card = localTask(); const base = git(repo, "rev-parse", "main"); mode(failure);
  await start(card.id, grok); await settled();
  assert.equal(getTask(card.id).blocked_kind, "capability"); assert.equal(getTask(card.id).fail_count, 0);
  assert.match(getTask(card.id).blocked_reason!, failure === "expired-zero" ? /Grok.*expired.*refresh/i : /validation failed/i);
  assert.ok(log().some(x => x.command === "instabox" && x.args.at(-1)?.includes('"op":"upload-finish"')));
  assert.ok(log().some(x => x.command === "grok"));
  assert.equal(getDb().prepare("SELECT id FROM events WHERE task_id = ? AND kind = 'cloud_capacity_wait'").get(card.id), undefined);
  assert.equal(localCloudReceipt(card.id), null); assert.equal(git(repo, "rev-parse", "main"), base); noGithub();
});

test("local creation no_capacity releases slots before sending any source bytes", async () => {
  const card = localTask(); mode("capacity-always"); await start(card.id, grok); await settled();
  assert.equal(getTask(card.id).status, "ready"); assert.equal(getTask(card.id).fail_count, 0);
  assert.equal(currentOccupancy([grok]).global, 0); assert.ok(cloudRunRecord(card.id)!.snapshotCommit);
  assert.equal(log().some(x => x.command === "instabox" && x.args[0] === "exec"), false);
  assert.equal(localCloudReceipt(card.id), null); noGithub();
});

for (const phase of ["upload", "import"]) test(`local archive during ${phase} deletes the machine and preserves cancellation`, { timeout: 30000 }, async () => {
  const card = localTask(); let enter!: () => void; const entered = new Promise<void>(resolve => { enter = resolve; });
  let aborted = false;
  setCloudRuntimeForTests({ ...fixtureRuntime, run: async (file, args, options) => {
    if ((phase === "upload" && file === "instabox" && args.at(-1)?.includes('"op":"upload-init"')) ||
        (phase === "import" && file === "git" && args.includes("commit-tree"))) {
      enter(); await new Promise<void>(resolve => options.signal!.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true }));
      return { code: 130, stdout: "", stderr: "aborted" };
    }
    if (file === "instabox" && args[0] === "rm") assert.equal(options.signal?.aborted ?? false, false);
    return fixtureRuntime.run(file, args, options);
  } });
  await start(card.id); await entered; archiveTask(card.id, "Fixture cancelled"); await settled();
  assert.equal(aborted, true); assert.equal(getTask(card.id).status, "archived"); assert.equal(localCloudReceipt(card.id), null); noGithub();
});
for (const executor of [codex, grok]) test(`local mirror routes ${executor.provider} executor candidates through delivery`, async () => {
  const card = localTask();
  await start(card.id, { ...executor, role: "candidate", candidateFor: "executor" }); await settled();
  assert.equal(getTask(card.id).status, "in_review", getTask(card.id).blocked_reason ?? "");
  assert.equal(git(getTask(card.id).workspace_path!, "rev-parse", "HEAD"), localCloudReceipt(card.id)!.localHead); noGithub();
});
test("local mirror refuses reviewer candidates before creating a machine", async () => {
  const card = localTask();
  await start(card.id, { ...codex, role: "candidate", candidateFor: "reviewer" }); await settled();
  assert.equal(getTask(card.id).blocked_kind, "needs_human");
  assert.equal(log().some(x => x.command === "instabox" && x.args[0] === "create"), false); noGithub();
});
test("local cloud script rejects an agent HTTPS push and cannot deliver its result", async () => {
  const card = localTask(); mode("local-push"); const base = git(repo, "rev-parse", "HEAD");
  await start(card.id); await settled();
  const attempt = JSON.parse(readFileSync(join(dir, "push-result.json"), "utf8"));
  assert.equal(attempt.policy, "never"); assert.equal(attempt.ssh, "never");
  assert.notEqual(attempt.status, 0); assert.match(attempt.stderr, /transport 'https' not allowed/);
  assert.equal(getTask(card.id).status, "blocked"); assert.equal(localCloudReceipt(card.id), null);
  assert.equal(git(repo, "rev-parse", "main"), base);
  assert.equal(log().some(x => !x.cwd?.includes("/boxes/") && (x.command === "gh" || x.args.includes("push") || x.args.includes("ls-remote"))), false);
});
test("local accept refuses commits added after review starts", async () => {
  const card = localTask(); const base = git(repo, "rev-parse", "main"); await start(card.id); await settled();
  await startTask(card.id, launcher, "test", { profiles: [codex, reviewer], chosen: reviewer });
  assert.equal(getTask(card.id).status, "reviewing");
  const directory = getTask(card.id).workspace_path!;
  writeFileSync(join(directory, "extra.txt"), "Unreviewed change\n"); git(directory, "add", "."); git(directory, "commit", "-m", "Add unreviewed change");
  await approveTask(card.id, "Fixture reviewed"); const status = getTask(card.id).status;
  await assert.rejects(acceptTask(card.id), /no longer matches its reviewed commit/);
  assert.equal(getTask(card.id).status, status); assert.equal(git(repo, "rev-parse", "main"), base);
  assert.equal(getDb().prepare("SELECT id FROM events WHERE task_id = ? AND kind = 'landed'").get(card.id), undefined); noGithub();
});
test("local mirror replays onto the real base, reviews L and accepts through local landing", async () => {
  const card = localTask(); const base = git(repo, "rev-parse", "HEAD");
  await start(card.id); await settled();
  const done = getTask(card.id); assert.equal(done.status, "in_review", done.blocked_reason ?? done.handoff_json ?? "");
  const receipt = localCloudReceipt(card.id)!; assert.ok(receipt); assert.equal(receipt.sourceBase, base);
  assert.notEqual(receipt.localHead, receipt.cloudHead);
  assert.equal(git(repo, "rev-parse", receipt.localHead + "^"), base);
  assert.equal(git(repo, "rev-parse", "main"), base);
  assert.equal(git(done.workspace_path!, "rev-parse", "HEAD"), receipt.localHead);
  assert.equal(done.workspace_kind, "worktree"); assert.equal(cloudDelivery(card.id), null);
  assert.ok(resolveReviewTarget(done, true)?.ok);
  await startTask(card.id, launcher, "test", { profiles: [codex, reviewer], chosen: reviewer });
  assert.equal(getTask(card.id).status, "reviewing"); assert.equal(git(getTask(card.id).workspace_path!, "rev-parse", "HEAD"), receipt.localHead);
  await approveTask(card.id, "Fixture reviewed"); await acceptTask(card.id);
  assert.equal(getTask(card.id).status, "done"); assert.equal(git(repo, "rev-parse", "main"), receipt.localHead);
  assert.equal(readFileSync(join(repo, "fixture.txt"), "utf8"), "After\n"); noGithub();
});
test("local outbound findings block before any machine creation", async () => {
  const card = localTask(); writeFileSync(join(repo, "secret.txt"), "CloudPrivateTerm\n");
  git(repo, "add", "."); git(repo, "commit", "-m", "Add fixture");
  await start(card.id); await settled(); assert.equal(getTask(card.id).blocked_kind, "needs_human");
  assert.equal(log().some(x => x.command === "instabox" && x.args[0] === "create"), false); noGithub();
});
test("local rework exports the last L tree and continues the same owned branch", async () => {
  const card = localTask(); await start(card.id); await settled();
  const first = localCloudReceipt(card.id)!; assert.ok(first);
  const directory = getTask(card.id).workspace_path!; const branch = git(directory, "branch", "--show-current");
  await startTask(card.id, launcher, "test", { profiles: [codex, reviewer], chosen: reviewer });
  requestChanges(card.id, "Refine fixture", "Add another edit."); mode("edit-again");
  await start(card.id); await settled(); const second = localCloudReceipt(card.id)!;
  assert.equal(getTask(card.id).status, "in_review", getTask(card.id).blocked_reason ?? ""); assert.equal(second.sourceBase, first.localHead);
  assert.equal(second.generation, 2); assert.equal(getTask(card.id).workspace_path, directory);
  assert.equal(git(directory, "branch", "--show-current"), branch);
  assert.equal(git(repo, "rev-parse", second.localHead + "^"), first.localHead); noGithub();
});
test("local result persists before deletion and restart finishes without another run or replay", async () => {
  const card = localTask(); await start(card.id); await settled(); const receipt = localCloudReceipt(card.id)!; assert.ok(receipt);
  getDb().prepare("UPDATE tasks SET status = 'running', workspace_kind = 'none', handoff_json = NULL WHERE id = ?").run(card.id);
  getDb().prepare("DELETE FROM events WHERE task_id = ? AND kind IN ('cloud_run_cleaned', 'cloud_run_settled')").run(card.id);
  const count = log().filter(x => x.command === "instabox" && x.args[0] === "create").length;
  setCloudRuntimeForTests(fixtureRuntime); await reconcileCloudMachines();
  assert.equal(getTask(card.id).status, "in_review"); assert.equal(localCloudReceipt(card.id)!.localHead, receipt.localHead);
  assert.equal(log().filter(x => x.command === "instabox" && x.args[0] === "create").length, count); noGithub();
});
test("local machine deletion failure retains L but never hands it to review", async () => {
  const card = localTask(); mode("rm-fail"); await start(card.id); await waitForCloudRuns();
  assert.equal(getTask(card.id).blocked_kind, "needs_human"); assert.ok(localCloudReceipt(card.id));
  assert.equal(getTask(card.id).status, "blocked"); assert.equal(machines().length, 1); noGithub();
});
test("local accept returns a conflicting baseline advance to the card", async () => {
  const card = localTask(); await start(card.id); await settled(); assert.ok(localCloudReceipt(card.id));
  await startTask(card.id, launcher, "test", { profiles: [codex, reviewer], chosen: reviewer }); await approveTask(card.id, "Fixture reviewed");
  writeFileSync(join(repo, "fixture.txt"), "Concurrent base change\n"); git(repo, "add", "."); git(repo, "commit", "-m", "Advance base");
  await assert.rejects(acceptTask(card.id)); assert.equal(getTask(card.id).status, "rework");
  assert.equal(readFileSync(join(repo, "fixture.txt"), "utf8"), "Concurrent base change\n"); noGithub();
});

for (const attack of ["local-extra-ref", "local-multi", "local-wrong-parent", "local-tree-mismatch", "local-symlink", "privacy"]) test(`local result rejects ${attack} before creating a delivery branch`, async () => {
  const card = localTask(); const base = git(repo, "rev-parse", "HEAD"); mode(attack);
  await start(card.id); await settled(); assert.equal(getTask(card.id).status, "blocked");
  assert.equal(localCloudReceipt(card.id), null); assert.equal(git(repo, "rev-parse", "HEAD"), base);
  const stage = getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'cloud_stage_failed' ORDER BY id DESC LIMIT 1").get(card.id) as {data_json:string} | undefined;
  assert.equal(stage && JSON.parse(stage.data_json).code, attack === "privacy" ? "cloud_local_privacy" : "cloud_local_result_invalid", "must reach host verification instead of failing inside the fake cloud shell");
  assert.equal(git(repo, "for-each-ref", "--format=%(refname)", "refs/heads/kanban/"), ""); noGithub();
});
test("local no_capacity retries pin and scan the advanced base before uploading", async () => {
  const card = localTask(); mode("capacity-once"); await start(card.id); await settled(); const first = cloudRunRecord(card.id)!;
  writeFileSync(join(repo, "advance.txt"), "New baseline\n"); git(repo, "add", "."); git(repo, "commit", "-m", "Advance fixture");
  const base = git(repo, "rev-parse", "HEAD");
  getDb().prepare("UPDATE events SET data_json = json_set(data_json, '$.retryAt', 0) WHERE task_id = ? AND kind = 'cloud_capacity_wait'").run(card.id);
  await start(card.id); await settled(); assert.equal(getTask(card.id).status, "in_review", getTask(card.id).blocked_reason ?? "");
  assert.equal(localCloudReceipt(card.id)!.sourceBase, base); assert.notEqual(cloudRunRecord(card.id)!.sourceBase, first.sourceBase); noGithub();
});
test("local capacity retry rescans the source instead of uploading an older approved tree", async () => {
  const card = localTask(); mode("capacity-once"); await start(card.id); await settled();
  writeFileSync(join(repo, "advance.txt"), "CloudPrivateTerm\n"); git(repo, "add", "."); git(repo, "commit", "-m", "Advance fixture");
  getDb().prepare("UPDATE events SET data_json = json_set(data_json, '$.retryAt', 0) WHERE task_id = ? AND kind = 'cloud_capacity_wait'").run(card.id);
  await start(card.id); await settled(); assert.equal(getTask(card.id).blocked_kind, "needs_human");
  assert.equal(log().filter(x => x.command === "instabox" && x.args[0] === "create").length, 1); noGithub();
});
for (const limit of ["maxSourceBytes", "maxResultBytes"] as const) test(`local ${limit} refuses oversized artifacts`, async () => {
  const card = localTask(); const current = loadConfig(); current.projects!["paseo-kanban"].cloudRunner![limit] = 1; saveConfig(current);
  await start(card.id); await settled(); assert.equal(getTask(card.id).status, "blocked"); assert.equal(localCloudReceipt(card.id), null);
  if (limit === "maxSourceBytes") assert.equal(log().some(x => x.command === "instabox" && x.args[0] === "create"), false);
  noGithub();
});
for (const phase of ["before-merge", "after-merge"]) test(`local restart resumes the import journal ${phase} without a second cloud execution`, async () => {
  const card = localTask(); let interrupted = false;
  setCloudRuntimeForTests({ ...fixtureRuntime, run: async (file, args, options) => {
    if (file === "git" && args.includes("merge") && !interrupted) {
      interrupted = true;
      if (phase === "after-merge") await fixtureRuntime.run(file, args, options);
      return { code: 71, stdout: "", stderr: "simulated host interruption" };
    }
    return fixtureRuntime.run(file, args, options);
  } });
  await start(card.id); await settled(); assert.equal(interrupted, true); assert.equal(localCloudReceipt(card.id), null);
  const journal = JSON.parse((getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'cloud_local_import'").get(card.id) as {data_json:string}).data_json);
  getDb().prepare("UPDATE tasks SET status = 'running', blocked_kind = NULL, blocked_reason = NULL WHERE id = ?").run(card.id);
  getDb().prepare("DELETE FROM events WHERE task_id = ? AND kind IN ('cloud_run_cleaned', 'cloud_run_settled')").run(card.id);
  setCloudRuntimeForTests(fixtureRuntime); await reconcileCloudMachines();
  assert.equal(getTask(card.id).status, "in_review"); assert.equal(localCloudReceipt(card.id)!.localHead, journal.receipt.localHead);
  assert.equal(log().filter(x => x.command === "instabox" && x.args[0] === "create").length, 1); noGithub();
});
for (const phase of ["upload", "import"]) test(`local cancellation during ${phase} uses fresh cleanup signals and cannot hand off`, { timeout: 30000 }, async () => {
  const card = localTask(); let enter!: () => void; const entered = new Promise<void>(resolve => { enter = resolve; });
  let cancelledSignal: AbortSignal | undefined;
  setCloudRuntimeForTests({ ...fixtureRuntime, run: async (file, args, options) => {
    if ((phase === "upload" && file === "instabox" && args.at(-1)?.includes('"op":"upload-init"')) ||
        (phase === "import" && file === "git" && args.includes("commit-tree"))) {
      cancelledSignal = options.signal; enter();
      await new Promise<void>(resolve => options.signal!.addEventListener("abort", () => resolve(), {once:true}));
      return { code: 130, stdout: "", stderr: "aborted" };
    }
    if (file === "instabox" && args[0] === "rm") assert.equal(options.signal?.aborted ?? false, false);
    return fixtureRuntime.run(file, args, options);
  } });
  await start(card.id); await entered; await stopCloudRuns(); await settled();
  assert.ok(cancelledSignal?.aborted); assert.equal(localCloudReceipt(card.id), null);
  assert.equal(getTask(card.id).status, "ready"); noGithub();
});
test("local receipt alone recovers a registered L without rerunning the executor", async () => {
  const card = localTask(); await start(card.id); await settled(); const receipt = localCloudReceipt(card.id)!; assert.ok(receipt);
  getDb().prepare("UPDATE tasks SET status = 'running', handoff_json = NULL WHERE id = ?").run(card.id);
  getDb().prepare("DELETE FROM events WHERE task_id = ? AND kind IN ('cloud_local_import', 'cloud_run_cleaned', 'cloud_run_settled')").run(card.id);
  setCloudRuntimeForTests(fixtureRuntime); await reconcileCloudMachines();
  assert.equal(getTask(card.id).status, "in_review"); assert.equal(localCloudReceipt(card.id)!.localHead, receipt.localHead);
  assert.equal(log().filter(x => x.command === "instabox" && x.args[0] === "create").length, 1); noGithub();
});
test("local import and accept disable configured host Git filters", async () => {
  const card = localTask(); const marker = join(dir, "filter-ran");
  writeFileSync(join(repo, ".gitattributes"), "fixture.txt filter=demo\n"); git(repo, "add", "."); git(repo, "commit", "-m", "Add attributes");
  const driver = `${process.execPath} -e 'require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran"); process.stdin.pipe(process.stdout)'`;
  git(repo, "config", "filter.demo.smudge", driver); git(repo, "config", "filter.demo.clean", driver);
  await start(card.id); await settled(); assert.equal(getTask(card.id).status, "in_review", getTask(card.id).blocked_reason ?? "");
  assert.equal(existsSync(marker), false, "import must not run host filters");
  await startTask(card.id, launcher, "test", { profiles: [codex, reviewer], chosen: reviewer }); await approveTask(card.id, "Fixture reviewed");
  await acceptTask(card.id); assert.equal(existsSync(marker), false, "landing must not run host filters"); noGithub();
});
for (const stage of ["upload", "import"]) test(`local deadline aborts ${stage} and confirms deletion`, { timeout: 60000 }, async () => {
  const card = localTask(); const current = loadConfig(); current.projects!["paseo-kanban"].cloudRunner!.taskTimeoutSec = 20; saveConfig(current);
  let reached = false;
  setCloudRuntimeForTests({ ...fixtureRuntime, run: async (file, args, options) => {
    if ((stage === "upload" && file === "instabox" && args.at(-1)?.includes('"op":"upload-init"')) ||
        (stage === "import" && file === "git" && args.includes("commit-tree"))) {
      reached = true;
      await new Promise<void>(resolve => options.signal!.addEventListener("abort", () => resolve(), { once: true }));
      return { code: 130, stdout: "", stderr: "aborted" };
    }
    return fixtureRuntime.run(file, args, options);
  } });
  await start(card.id); await settled(); assert.ok(reached); assert.equal(getTask(card.id).status, "blocked");
  assert.match(getTask(card.id).blocked_reason!, /timed out/i); assert.equal(localCloudReceipt(card.id), null); noGithub();
});
test("a superseded local import cannot register a worktree or complete the replacement run", async () => {
  const card = localTask(); let fenced = false;
  setCloudRuntimeForTests({ ...fixtureRuntime, run: async (file, args, options) => {
    if (file === "git" && args.includes("commit-tree")) {
      fenced = true;
      getDb().prepare("UPDATE tasks SET agent_id = 'replacement', executor_agent_id = 'replacement', workspace_kind = 'dir' WHERE id = ?").run(card.id);
      getDb().prepare("INSERT INTO runs(task_id, agent_id, role, started_at) VALUES (?, 'replacement', 'executor', ?)").run(card.id, new Date().toISOString());
    }
    return fixtureRuntime.run(file, args, options);
  } });
  await start(card.id); await settled(); assert.equal(fenced, true);
  assert.equal(getTask(card.id).status, "running"); assert.equal(getTask(card.id).agent_id, "replacement");
  assert.equal(localCloudReceipt(card.id), null); assert.equal(git(repo, "for-each-ref", "--format=%(refname)", "refs/heads/kanban/"), ""); noGithub();
});
for (const field of ["brief", "feedback", "environment"]) test(`local outbound scans the actual ${field} before opening a machine`, async () => {
  const card = localTask();
  if (field === "brief") getDb().prepare("UPDATE tasks SET brief = 'CloudPrivateTerm' WHERE id = ?").run(card.id);
  if (field === "feedback") appendEvent(card.id, "request_changes", null, null, "reviewer", { reason: "CloudPrivateTerm" });
  if (field === "environment") { const current = loadConfig(); current.projects!["paseo-kanban"].cloudRunner!.environment = { DEMO_VALUE: "CloudPrivateTerm" }; saveConfig(current); }
  await start(card.id); await settled(); assert.equal(getTask(card.id).blocked_kind, "needs_human");
  assert.match(getTask(card.id).blocked_reason!, new RegExp(field));
  assert.equal(log().some(x => x.command === "instabox" && x.args[0] === "create"), false); noGithub();
});
test("local delivery reuses a registered writable card worktree", async () => {
  const card = localTask(); const directory = join(process.env.KANBAN_WORKTREES_ROOT!, "existing"); const branch = "kanban/DEMO_0001-existing";
  mkdirSync(process.env.KANBAN_WORKTREES_ROOT!, {recursive:true}); git(repo, "worktree", "add", "-b", branch, directory, "main");
  appendEvent(card.id, "worktree_created", null, null, "scheduler", { directory, root: repo, base: "main", branch });
  appendEvent(card.id, "temp_workspace", null, null, "scheduler", { directory, root: repo, base: "main" });
  getDb().prepare("UPDATE tasks SET workspace_path = ?, workspace_kind = 'worktree' WHERE id = ?").run(directory, card.id);
  await start(card.id); await settled(); assert.equal(getTask(card.id).status, "in_review", getTask(card.id).blocked_reason ?? "");
  assert.equal(getTask(card.id).workspace_path, directory); assert.equal(git(directory, "branch", "--show-current"), branch); noGithub();
});
test("local capacity retries advance an empty owned worktree to the newly pinned baseline", async () => {
  const card = localTask(); const directory = join(process.env.KANBAN_WORKTREES_ROOT!, "existing"); const branch = "kanban/DEMO_0001-existing";
  mkdirSync(process.env.KANBAN_WORKTREES_ROOT!, {recursive:true}); git(repo, "worktree", "add", "-b", branch, directory, "main");
  appendEvent(card.id, "worktree_created", null, null, "scheduler", { directory, root: repo, base: "main", branch });
  appendEvent(card.id, "temp_workspace", null, null, "scheduler", { directory, root: repo, base: "main" });
  getDb().prepare("UPDATE tasks SET workspace_path = ?, workspace_kind = 'worktree' WHERE id = ?").run(directory, card.id);
  mode("capacity-once"); await start(card.id); await settled(); assert.equal(getTask(card.id).status, "ready");
  writeFileSync(join(repo, "advance.txt"), "Next base\n"); git(repo, "add", "."); git(repo, "commit", "-m", "Advance fixture"); const base = git(repo, "rev-parse", "HEAD");
  getDb().prepare("UPDATE events SET data_json = json_set(data_json, '$.retryAt', 0) WHERE task_id = ? AND kind = 'cloud_capacity_wait'").run(card.id);
  await start(card.id); await settled(); assert.equal(getTask(card.id).status, "in_review", getTask(card.id).blocked_reason ?? "");
  assert.equal(localCloudReceipt(card.id)!.sourceBase, base); assert.equal(getTask(card.id).workspace_path, directory); noGithub();
});
test("local restart before a rework result requeues with the previous delivery intact", async () => {
  const card = localTask(); await start(card.id); await settled(); const previous = localCloudReceipt(card.id)!;
  await startTask(card.id, launcher, "test", { profiles: [codex, reviewer], chosen: reviewer }); requestChanges(card.id, "Refine fixture", "Add another edit.");
  mode("capacity-once"); rmSync(join(dir, "attempts")); await start(card.id); await settled(); assert.equal(getTask(card.id).status, "ready");
  getDb().prepare("UPDATE tasks SET status = 'running' WHERE id = ?").run(card.id);
  getDb().prepare("DELETE FROM events WHERE task_id = ? AND kind IN ('cloud_run_cleaned', 'cloud_run_settled') AND json_extract(data_json, '$.generation') = 2").run(card.id);
  setCloudRuntimeForTests(fixtureRuntime); await reconcileCloudMachines();
  assert.equal(getTask(card.id).status, "ready"); assert.equal(localCloudReceipt(card.id)!.localHead, previous.localHead);
  assert.equal(log().filter(x => x.command === "instabox" && x.args[0] === "create").length, 2); noGithub();
});
test("local outbound scans install and test arguments as transmitted settings", async () => {
  const card = localTask(); const current = loadConfig(); current.projects!["paseo-kanban"].cloudRunner!.installCommand.push("CloudPrivateTerm"); saveConfig(current);
  await start(card.id); await settled(); assert.equal(getTask(card.id).blocked_kind, "needs_human");
  assert.equal(log().some(x => x.command === "instabox" && x.args[0] === "create"), false); noGithub();
});
test("local mode refuses a card bound to remote publication before creating a machine", async () => {
  const card = localTask(); getDb().prepare("UPDATE tasks SET contract_json = ? WHERE id = ?").run("github:example/paseo-clear-chat", card.id);
  await start(card.id); await settled(); assert.equal(getTask(card.id).blocked_kind, "needs_human");
  assert.equal(log().some(x => x.command === "instabox" && x.args[0] === "create"), false); noGithub();
});
test("local deletion cannot be confirmed by a truncated empty inventory", async () => {
  const card = localTask(); let created = false;
  setCloudRuntimeForTests({ ...fixtureRuntime, run: async (file, args, options) => {
    if (file === "instabox" && args[0] === "rm") return { code: 7, stdout: "", stderr: "fixture deletion failure" };
    if (created && file === "instabox" && args[0] === "ls") return { code: 0, stdout: '{"machines":[]}', stderr: "", truncated: true };
    const result = await fixtureRuntime.run(file, args, options);
    if (file === "instabox" && args[0] === "create" && result.code === 0) created = true;
    return result;
  } });
  await start(card.id); await waitForCloudRuns();
  assert.equal(getTask(card.id).status, "blocked"); assert.equal(getTask(card.id).blocked_kind, "needs_human");
  assert.ok(localCloudReceipt(card.id)); assert.equal(machines().length, 1); noGithub();
});

function cloudSettings(patch: Record<string, unknown>) {
  saveConfig(parseConfig({ ...loadConfig(), cloud: { allowedProjects: ["paseo-clear-chat"], maxMachines: 3, deleteTimeoutSec: 4, deletePollIntervalSec: 1, ...patch } }));
}

function runningCloud(project: string) {
  const card = createTask({ project, title: "Existing cloud run", role: "executor", workspacePath: repo, contract: "local-only" });
  const run = getDb().prepare("INSERT INTO runs (task_id, role, started_at) VALUES (?, 'executor', ?)").run(card.id, new Date().toISOString());
  getDb().prepare("UPDATE tasks SET status = 'running', workspace_kind = 'none' WHERE id = ?").run(card.id);
  appendEvent(card.id, "cloud_run_started", null, null, "scheduler", { generation: 1, machine: `existing-${card.id}`, runId: Number(run.lastInsertRowid) });
}

for (const limit of [undefined, 1, 4]) test(`board cloud machine limit ${limit ?? "default"} holds before creation across projects`, async () => {
  config({ maxParallel: 5 });
  if (limit !== undefined) cloudSettings({ maxMachines: limit });
  await reconcileCloudMachines();
  for (let i = 0; i < (limit ?? 3); i++) runningCloud("other-project");
  const card = task(); await start(card.id); await waitForCloudRuns();
  assert.equal(getTask(card.id).status, "ready"); assert.match(getTask(card.id).hold_reason!, /parallel/i);
  assert.equal(log().some(x => x.command === "instabox" && x.args[0] === "create"), false);
});

test("project maxParallel counts its own runs independently of other projects", async () => {
  config({ maxParallel: 1 }); cloudSettings({ maxMachines: 3 }); await reconcileCloudMachines();
  runningCloud("other-project");
  const card = task(); await start(card.id); await settled();
  assert.equal(getTask(card.id).status, "in_review");
});

for (const output of ["quota_exceeded: machine limit reached", '{"error":{"code":"quota_exceeded","message":"machine limit reached"}}']) test(`account creation rejection queues and retries: ${output}`, async () => {
  let attempts = 0;
  setCloudRuntimeForTests({ ...fixtureRuntime, run: async (file, args, options) => {
    if (file === "instabox" && args[0] === "create" && ++attempts === 1) return { code: 1, stdout: "", stderr: output };
    return fixtureRuntime.run(file, args, options);
  } });
  const card = task(); await start(card.id); await settled();
  assert.equal(getTask(card.id).status, "ready"); assert.equal(getTask(card.id).fail_count, 0);
  assert.match(getTask(card.id).hold_reason!, /retry queued/i); assert.equal(currentOccupancy([codex]).global, 0);
  getDb().prepare("UPDATE events SET data_json = json_set(data_json, '$.retryAt', 0) WHERE task_id = ? AND kind = 'cloud_capacity_wait'").run(card.id);
  await start(card.id); await settled(); assert.equal(getTask(card.id).status, "in_review"); assert.equal(attempts, 2);
});

test("unknown create rejection is not treated as capacity", async () => {
  setCloudRuntimeForTests({ ...fixtureRuntime, run: (file, args, options) => file === "instabox" && args[0] === "create"
    ? Promise.resolve({ code: 1, stdout: "", stderr: "unknown_failure: request failed" }) : fixtureRuntime.run(file, args, options) });
  const card = task(); await start(card.id); await settled();
  assert.equal(getTask(card.id).status, "blocked"); assert.equal(getTask(card.id).blocked_kind, "capability");
  assert.equal(getDb().prepare("SELECT id FROM events WHERE task_id = ? AND kind = 'cloud_capacity_wait'").get(card.id), undefined);
});

function delayedDeletion(options: { disappear?: boolean; invalid?: boolean; truncated?: boolean } = {}) {
  const lists: number[] = []; const removes: number[] = []; let deleting = "";
  setCloudRuntimeForTests({ ...fixtureRuntime, run: async (file, args, commandOptions) => {
    if (file === "instabox" && args[0] === "rm") {
      removes.push(Date.now()); deleting = args[1];
      assert.equal(args.includes("--no-wait"), false);
      assert.ok((commandOptions.timeoutMs ?? 0) <= 4000, "rm must use the cleanup budget");
      assert.equal(commandOptions.signal?.aborted ?? false, false, "cleanup must outlive task cancellation");
      return { code: 0, stdout: "operation accepted", stderr: "" };
    }
    if (file === "instabox" && args[0] === "ls" && deleting) {
      lists.push(Date.now());
      if (options.disappear && lists.length === 3) rmSync(join(dir, "boxes", deleting), { recursive: true, force: true });
      if (options.invalid) return { code: 0, stdout: "not json", stderr: "" };
      if (options.truncated) return { code: 0, stdout: '{"machines":[]}', stderr: "", truncated: true };
    }
    return fixtureRuntime.run(file, args, commandOptions);
  } });
  return { lists, removes };
}

for (const startup of [false, true]) test(`asynchronous deletion waits for the third list at ${startup ? "startup" : "delivery"}`, async () => {
  const card = startup ? null : localTask();
  cloudSettings({}); const observed = delayedDeletion({ disappear: true });
  if (startup) {
    mkdirSync(join(dir, "boxes", `${cloudBoardPrefix()}demo-0001-g1`)); await reconcileCloudMachines();
  } else {
    await start(card!.id); await settled(); assert.equal(getTask(card!.id).status, "in_review"); noGithub();
  }
  assert.equal(observed.removes.length, 1); assert.equal(observed.lists.length, 3); assert.deepEqual(machines(), []);
  for (let i = 1; i < observed.lists.length; i++) assert.ok(observed.lists[i] - observed.lists[i - 1] >= 900, "inventory checks must be spaced apart");
});

for (const issue of ["present", "invalid", "truncated"]) test(`deletion ${issue} inventory times out and retains local receipt without review`, async () => {
  const card = localTask();
  cloudSettings({ deleteTimeoutSec: 1 }); const observed = delayedDeletion({ invalid: issue === "invalid", truncated: issue === "truncated" });
  const began = Date.now(); await start(card.id); await waitForCloudRuns();
  assert.equal(getTask(card.id).status, "blocked"); assert.equal(getTask(card.id).blocked_kind, "needs_human");
  assert.ok(localCloudReceipt(card.id)); assert.ok(Date.now() - began >= 900); assert.equal(observed.removes.length, 1);
  assert.ok(Date.now() - observed.removes[0] >= 900, "inconclusive inventory must exhaust the cleanup budget");
  assert.match(getTask(card.id).blocked_reason!, /deletion/i); assert.equal(machines().length, 1); noGithub();
  assert.ok(getDb().prepare("SELECT id FROM events WHERE task_id = ? AND kind = 'cloud_cleanup_pending'").get(card.id));
  assert.ok(getDb().prepare("SELECT id FROM events WHERE task_id = ? AND kind = 'cloud_leader_notice'").get(card.id));
});

test("startup deletion timeout holds admission until a later cleanup succeeds", async () => {
  cloudSettings({ deleteTimeoutSec: 1 }); const observed = delayedDeletion();
  mkdirSync(join(dir, "boxes", `${cloudBoardPrefix()}demo-0001-g1`));
  await assert.rejects(reconcileCloudMachines(), /cleanup failed/i); assert.equal(observed.removes.length, 1);
  const card = task(); await start(card.id); await waitForCloudRuns();
  assert.equal(getTask(card.id).status, "ready"); assert.ok(getTask(card.id).hold_reason);
  assert.equal(log().some(x => x.command === "instabox" && x.args[0] === "create"), false);
  setCloudRuntimeForTests(fixtureRuntime); await reconcileCloudMachines(); assert.deepEqual(machines(), []);
});

test("global cloud settings default, round-trip and reject invalid limits", () => {
  assert.deepEqual(parseConfig({}).cloud, { allowedProjects: [], maxMachines: 3, deleteTimeoutSec: 180, deletePollIntervalSec: 5 });
  cloudSettings({ allowedProjects: ["paseo-clear-chat"], maxMachines: 4, deleteTimeoutSec: 120, deletePollIntervalSec: 2 });
  assert.deepEqual(loadConfig().cloud, { allowedProjects: ["paseo-clear-chat"], maxMachines: 4, deleteTimeoutSec: 120, deletePollIntervalSec: 2 });
  for (const cloud of [null, [], { allowedProjects: "demo" }, { allowedProjects: [1] }, { maxMachines: 0 }, { maxMachines: 6 }, { maxMachines: 1.5 }, { deleteTimeoutSec: 0 }, { deleteTimeoutSec: 601 }, { deletePollIntervalSec: 0 }, { deletePollIntervalSec: 1.5 }, { unexpected: 1 }]) {
    assert.throws(() => parseConfig({ cloud }), Error);
  }
});


// Every external command below is a fixture; no runtime download or cloud account is used.
test("cloud versions map the legacy alias and validate exact pins", () => {
  const parse = (cloudRunner: Record<string, unknown>) => parseConfig({ projects: { "paseo-clear-chat": { defaultWorkspace: "dir", cloudRunner } } }).projects!["paseo-clear-chat"].cloudRunner!;
  assert.equal(parse({ runtimeVersion: "24.20.0" }).nodeVersion, "24.20.0");
  assert.equal(parse({ runtimeVersion: "24.20.0", nodeVersion: "24.21.0" }).nodeVersion, "24.21.0");
  assert.equal(parse({}).installBun, false);
  for (const field of ["nodeVersion", "bunVersion"]) for (const value of ["24", "v1.4.2", "1.4.2;echo demo", "01.4.2"]) assert.throws(() => parse({ [field]: value }));
  assert.throws(() => parse({ installBun: true }));
  assert.throws(() => parse({ installBun: true, bunVersion: "1.4.2" }));
  assert.throws(() => parse({ installBun: true, bunVersion: "9.9.9", bunSha256: { "1.4.2": { x64: "a".repeat(64) } } }));
  assert.throws(() => parse({ bunSha256: { "1.4.2": { x64: "invalid" } } }));
});

function bunConfig(patch: Record<string, unknown> = {}) {
  config({ bunSha256: { "1.4.2": { x64: createHash("sha256").update("fixture release").digest("hex"), aarch64: createHash("sha256").update("fixture release").digest("hex") } }, runtime: "bun", nodeVersion: process.versions.node, bunVersion: "1.4.4",
    installCommand: ["bun", "install", "--frozen-lockfile"], testCommand: ["bun", "test"], ...patch });
}
function bunLock(name: string | null) {
  git(repo, "rm", "package-lock.json");
  if (name) { writeFileSync(join(repo, name), "fixture lock\n"); git(repo, "add", name); }
  git(repo, "commit", "-m", "Use runtime lock");
  git(repo, "push", remote, "main");
}
for (const lock of ["bun.lock", "bun.lockb"]) test(`bun runtime installs and tests with ${lock} and deletes its machine`, async () => {
  bunLock(lock); bunConfig();
  const card = task(); await start(card.id); await settled();
  assert.equal(getTask(card.id).status, "in_review");
  assert.ok(log().some(x => x.command === "bun" && x.args[0] === "install"));
  assert.ok(log().some(x => x.command === "bun" && x.args[0] === "test"));
  assert.equal(log().some(x => x.command === "curl"), false);
});
for (const runtime of ["npm", "bun"]) test(`${runtime} rejects a missing runtime lock before installing`, async () => {
  bunLock(null); if (runtime === "bun") bunConfig();
  const card = task(); await start(card.id); await settled();
  assert.equal(getTask(card.id).blocked_kind, "capability");
  assert.equal(log().some(x => ["npm", "bun"].includes(x.command) && ["ci", "install", "test"].includes(x.args[0])), false);
});
test("bun exact version mismatch fails before installing packages", async () => {
  bunLock("bun.lock"); bunConfig({ bunVersion: "1.4.2" });
  const card = task(); await start(card.id); await settled();
  assert.equal(getTask(card.id).blocked_kind, "capability");
  assert.equal(log().some(x => x.command === "bun" && x.args[0] === "install"), false);
  assert.match(getTask(card.id).blocked_reason!, /bun version mismatch or missing; expected 1.4.2/);
  assert.ok(log().some(x => x.command === "instabox" && x.args[0] === "create"));
});
for (const fixtureMode of ["", "bun-missing", "bun-arm"]) test(`bun installs exact version in HOME when missing or mismatched (${fixtureMode})`, async () => {
  mode(fixtureMode); bunLock("bun.lock"); bunConfig({ bunVersion: "1.4.2", installBun: true });
  const card = task(); await start(card.id); await settled();
  assert.equal(getTask(card.id).status, "in_review", JSON.stringify({reason:getTask(card.id).blocked_reason,calls:log().filter(x=>["curl","bun"].includes(x.command))}));
  assert.ok(log().some(x => x.command === "curl" && x.args.includes(`https://github.com/oven-sh/bun/releases/download/bun-v1.4.2/bun-linux-${fixtureMode === "bun-arm" ? "aarch64" : "x64"}.zip`)));
  assert.ok(log().some(x => x.command === "bun" && x.args[0] === "install"));
});
for (const fixtureMode of ["bun-install-fail", "bun-install-wrong", "bun-checksum-wrong", "bun-unsupported", "bun-no-digest", "bun-unzip-fail"]) test(`bun installer failure or wrong resulting version fails and deletes machine (${fixtureMode})`, async () => {
  mode(fixtureMode); bunLock("bun.lock"); bunConfig({ bunVersion: "1.4.2", installBun: true, ...(fixtureMode === "bun-no-digest" ? { bunSha256: { "1.4.2": { x64: "a".repeat(64) } } } : {}) });
  const card = task(); await start(card.id); await settled();
  assert.equal(getTask(card.id).blocked_kind, "capability");
  assert.equal(log().some(x => x.command === "bun" && x.args[0] === "install"), false);
  assert.ok(log().some(x => x.command === "instabox" && x.args[0] === "rm"));
  if (fixtureMode === "bun-checksum-wrong") assert.equal(log().some(x => x.command === "unzip"), false);
});

test("bun already installed in HOME is found without login shell setup or downloads", async () => {
  mode("bun-home"); bunLock("bun.lock"); bunConfig({ bunVersion: "1.4.2", installBun: true });
  const card = task(); await start(card.id); await settled();
  assert.equal(getTask(card.id).status, "in_review");
  assert.equal(log().some(x => x.command === "curl"), false);
});
test("missing bun without opt-in installation fails with an exact version reason", async () => {
  mode("bun-missing"); bunLock("bun.lock"); bunConfig({ bunVersion: "1.4.2" });
  const card = task(); await start(card.id); await settled();
  assert.equal(getTask(card.id).blocked_kind, "capability");
  assert.match(getTask(card.id).blocked_reason!, /bun version mismatch or missing; expected 1.4.2/);
  assert.equal(log().some(x => x.command === "curl"), false);
});

test("paid Cursor models are refused before any cloud machine or local agent is created", async () => {
  const card = task();
  const paid = { ...codex, provider: "cursor", model: "gpt-demo", family: "xai", pool: "x-ultra" };
  await start(card.id, paid);
  assert.match(getTask(card.id).blocked_reason ?? getTask(card.id).hold_reason ?? "", /third-party.*paid/i);
  assert.equal(localCreates, 0);
  assert.equal(log().some(x => x.command === "instabox" && x.args[0] === "create"), false);
});

test("optional directories use overrides, skip missing packages and report accurate verification", async () => {
  directoriesFixture();
  config({ directories: [".", { path: "web", optional: true, installCommand: ["npm", "ci", "--ignore-scripts"], testCommand: ["npm", "run", "test:cov"] }, { path: "pipeline", skipTest: true }, { path: "astro", optional: true, skipTest: true }] });
  const card = task(); await start(card.id); await settled();
  assert.equal(getTask(card.id).status, "in_review");
  assert.deepEqual(log().filter(x => x.command === "npm").map(x => [x.cwd!.split("/").at(-1), x.args]), [
    ["paseo-clear-chat", ["ci", "--no-audit", "--no-fund"]], ["web", ["ci", "--ignore-scripts"]], ["pipeline", ["ci", "--no-audit", "--no-fund"]], ["paseo-clear-chat", ["test"]], ["web", ["run", "test:cov"]],
  ]);
  const verification = cloudDelivery(card.id)!.verification!;
  assert.ok(verification.includes("astro: skipped (optional, missing)"));
  assert.ok(verification.includes("web: npm run test:cov: passed on cloud machine"));
  assert.ok(verification.includes("pipeline: skipped test (skipTest)"));
  assert.ok(verification.every(line => !line.includes("[object Object]")));
});

test("missing required directory fails before the agent and deletes the machine", async () => {
  config({ directories: [{ path: "missing" }] });
  const card = task(); await start(card.id); await settled();
  assert.equal(getTask(card.id).status, "blocked");
  assert.equal(log().some(x => x.command === "codex"), false);
});

test("existing optional directory still requires its lockfile", async () => {
  directoriesFixture(); rmSync(join(repo, "web", "package-lock.json"));
  git(repo, "add", "."); git(repo, "commit", "-m", "Remove fixture lock"); git(remote, "fetch", repo, "main:main");
  config({ directories: [{ path: "web", optional: true }] });
  const card = task(); await start(card.id); await settled();
  assert.equal(getTask(card.id).status, "blocked");
  assert.equal(log().some(x => x.command === "codex"), false);
});

for (const lock of ["bun.lock", "bun.lockb"]) test(`bun optional directories preserve overrides and skipTest with ${lock}`, async () => {
  directoriesFixture();
  for (const name of [".", "web", "pipeline"]) {
    rmSync(join(repo, name, "package-lock.json"));
    writeFileSync(join(repo, name, lock), "fixture lock\n");
  }
  git(repo, "add", "."); git(repo, "commit", "-m", "Use Bun package locks"); git(remote, "fetch", repo, "main:main");
  bunConfig({ testCommand: ["bun", "run", "test"], directories: [".",
    { path: "web", optional: true, testCommand: ["bun", "run", "test:cov"] },
    { path: "pipeline", optional: true, skipTest: true }, { path: "astro", optional: true, skipTest: true }] });
  const card = task(); await start(card.id); await settled();
  assert.equal(getTask(card.id).status, "in_review", getTask(card.id).blocked_reason ?? "");
  assert.deepEqual(log().filter(x => x.command === "bun" && x.args[0] !== "--version").map(x => [x.cwd!.split("/").at(-1), x.args]), [
    ["paseo-clear-chat", ["install", "--frozen-lockfile"]], ["web", ["install", "--frozen-lockfile"]],
    ["pipeline", ["install", "--frozen-lockfile"]], ["paseo-clear-chat", ["run", "test"]], ["web", ["run", "test:cov"]],
  ]);
  const verification = cloudDelivery(card.id)!.verification!;
  assert.ok(verification.includes("astro: skipped (optional, missing)"));
  assert.ok(verification.includes("pipeline: skipped test (skipTest)"));
  assert.ok(verification.includes("web: bun run test:cov: passed on cloud machine"));
});

test("bun optional existing directory rejects an npm-only lock before the agent", async () => {
  directoriesFixture();
  bunConfig({ directories: [{ path: "web", optional: true }] });
  const card = task(); await start(card.id); await settled();
  assert.equal(getTask(card.id).status, "blocked");
  assert.equal(log().some(x => x.command === "codex"), false);
  assert.equal(log().some(x => x.command === "bun" && x.args[0] === "install"), false);
});

for (const source of ["publicGithub", "localMirror"] as const) test(`20 GiB fake cloud board delivers ${source} to independent review`, async () => {
  const card = source === "localMirror" ? localTask() : task();
  const gib = 1024 ** 3;
  // This is the board process's filesystem, including when that board runs on a small cloud VM.
  // Provider admission is a separate fake CLI boundary; no real machine or remote is contacted.
  setCapacityProbeForTests({ du: () => gib, statfs: () => ({ blocks: 20 * gib, bavail: 6 * gib, bsize: 1 }) });
  await refreshCapacityGuard({ config: loadConfig(), notify: false });
  assert.equal(capacityHoldReason(), null);
  await start(card.id); await settled();
  const done = getTask(card.id);
  assert.equal(done.status, "in_review", done.blocked_reason ?? done.hold_reason ?? "");
  assert.equal(done.hold_reason, null);
  assert.equal(done.fail_count, 0);
  assert.equal(getDb().prepare("SELECT id FROM events WHERE task_id = ? AND kind = 'cloud_capacity_wait'").get(card.id), undefined);
  assert.ok(log().some(x => x.command === "npm" && x.args[0] === "test"));
  assert.ok(log().some(x => x.command === "instabox" && x.args[0] === "rm"));
  const target = resolveReviewTarget(done, true); assert.ok(target?.ok);
  assert.equal(reviewFamilyBlock(reviewer, target), null);
  if (source === "localMirror") { assert.ok(localCloudReceipt(card.id)); noGithub(); }
  else assert.match(done.handoff_json!, /https:\/\/github.com\/example\/paseo-clear-chat\/pull\/1/);
  console.log(JSON.stringify({ scenario: "20GiB-cloud-board", source, totalGiB: 20, freeGiB: 6, reserveGiB: 5, status: done.status, executorModel: codex.model, reviewerModel: reviewer.model, machinesRemaining: machines().length }));
});
