/// <reference types="node" />
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import { closeDb, getDb } from "../server/db";
import { loadConfig, parseConfig, saveConfig, setProjectCode, setProjectWorkspace } from "../server/config";
import { createTask, getTask, archiveTask, appendEvent } from "../server/store";
import { startTask } from "./helpers/compat-dispatch";
import { runTick } from "./helpers/compat-schedule";
import type { AgentLauncher } from "../server/dispatch";
import type { Profile } from "../server/profiles";
import { currentOccupancy } from "../server/routing";
import { resolveReviewTarget, reviewFamilyBlock } from "../server/review-target";
import { bindCloudRunner, cloudBoardPrefix, executeCloudCommand, reconcileCloudMachines, setCloudRuntimeForTests, stopCloudRuns, waitForCloudRuns, type CloudRuntime } from "../server/cloud-runner";
import { setLanguage } from "../shared/i18n";
import { cloudDelivery, cloudRunRecord } from "../server/cloud-record";
import { cloudPrivacyFindings } from "../server/cloud-privacy";
import { requestChanges } from "../server/flow";
import { executable as fixtureExecutable } from "../scripts/isolated-environment.mjs";

delete process.env.KANBAN_TOKEN;
delete process.env.PASEO_AGENT_ID;
const root = mkdtempSync(join(tmpdir(), "cloud-runner-"));
const realGit = fixtureExecutable("git");
// The remote shell fixture declares its POSIX tools without inheriting provider executables.
const shellTools = ["mkdir", "grep", "tail"].map(name => [name, fixtureExecutable(name, `${process.env.PATH}:/bin:/usr/bin`)]);
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

beforeEach(async () => {
  await stopCloudRuns(); closeDb();
  setLanguage("en");
  dir = mkdtempSync(join(root, "case-"));
  repo = join(dir, "paseo-clear-chat"); remote = join(dir, "remote.git");
  tools = join(dir, "tools"); calls = join(dir, "calls.txt");
  for (const path of [repo, tools, join(dir, "boxes"), join(dir, "scratch")]) mkdirSync(path, { recursive: true });
  writeFileSync(join(tools, "package.json"), '{"type":"commonjs"}\n');
  process.env.KANBAN_DATA_DIR = join(dir, "board");
  process.env.KANBAN_TMP_ROOT = join(dir, "scratch");
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
if (process.cwd().includes('/boxes/') && args.includes('push')) process.exit(91);
if (mode === 'anonymous-denied' && args.includes('ls-remote')) process.exit(9);
if (mode === 'bundle-fail' && args.includes('fetch') && args.some(x=>x.endsWith('.bundle'))) process.exit(6);
const out = cp.spawnSync(${JSON.stringify(realGit)}, args.map(x => ['https://github.com/example/paseo-clear-chat.git','https://github.com/example/paseo-clear-chat'].includes(x) ? path.join(root,'remote.git') : x), {stdio:'inherit'});
process.exit(out.status ?? 1);`);
  executable("npm", common + `if (mode === 'test-fail' && args[0] === 'test') process.exit(4); if (mode.startsWith('directory-fail-') && args[0] === 'ci' && process.cwd().endsWith('/'+mode.slice('directory-fail-'.length))) process.exit(5); process.exit(0);`);
  executable("base64", common + `if (args.includes('-d')) process.stdout.write(Buffer.from(fs.readFileSync(0,'utf8').trim(),'base64')); else process.stdout.write(fs.readFileSync(args.at(-1)).toString('base64'));`);
  executable("timeout", common + `
const child=cp.spawn(args[1],args.slice(2),{stdio:'inherit'}); let expired=false;
const timer=setTimeout(()=>{expired=true;child.kill('SIGKILL');},parseFloat(args[0])*1000);
process.on('SIGTERM',()=>child.kill('SIGKILL'));
child.on('error',()=>{clearTimeout(timer);process.exit(127);});
child.on('close',code=>{clearTimeout(timer);process.exit(expired?124:code??130);});`);
  const agent = common + `
if (mode === 'expired' || mode === 'expired-zero') { console.error('Authentication expired. Please run grok login.'); process.exit(mode === 'expired' ? 1 : 0); }
if (mode === 'unauthenticated') { console.error('You are not authenticated.'); process.exit(1); }
if (mode === 'agent-fail') { console.error('fixture execution failed'); process.exit(3); }
if (mode === 'hang') { setInterval(()=>{},1000); } else {
fs.writeFileSync('fixture.txt', mode === 'privacy' ? '/'+['Users','private-user','work'].join('/')+'\\n' : mode === 'short-ticket' ? 'PCC'+'_'+'1\\n' : mode === 'denylist' ? 'CloudPrivateTerm\\n' : mode === 'edit-again' ? 'After again\\n' : 'After\\n');
if (mode === 'cjk-path') fs.writeFileSync(String.fromCodePoint(0x65e5)+'.txt','');
console.log('Fixture agent finished'); }`;
  executable("codex", agent); executable("grok", agent);
  executable("gh", common + `
if (args[0] !== 'pr' || args[1] !== 'create' || !args.includes('--draft')) process.exit(92);
console.log('https://github.com/example/paseo-clear-chat/pull/1');`);
  executable("instabox", common + `
const boxes = path.join(root,'boxes'); const name = args[1]; const box = path.join(boxes, name ?? 'invalid');
if (args[0] === 'ls') { console.log(JSON.stringify({machines:fs.readdirSync(boxes).map(name=>({name}))})); }
else if (args[0] === 'create') {
 const countFile=path.join(root,'attempts'); const count=Number(fs.existsSync(countFile)?fs.readFileSync(countFile,'utf8'):0)+1; fs.writeFileSync(countFile,String(count));
 if (mode === 'capacity-always' || (mode === 'capacity-once' && count === 1)) { console.error('no_capacity'); process.exit(1); }
 const name=args[args.indexOf('--name')+1]; fs.mkdirSync(path.join(boxes,name,'home/.grok/bin'),{recursive:true});
 fs.symlinkSync(path.join(root,'tools/grok'),path.join(boxes,name,'home/.grok/bin/grok')); console.log('Created '+name);
 if (mode === 'create-hang') setInterval(()=>{},1000);
} else if (args[0] === 'rm') { if (mode === 'rm-fail') process.exit(7); fs.rmSync(box,{recursive:true,force:true}); }
else if (args[0] === 'get') { if (!fs.existsSync(box)) process.exit(1); console.log(JSON.stringify({name})); }
else if (args[0] === 'exec') {
 if (!fs.existsSync(box)) process.exit(2);
 const line=args.slice(args.indexOf('--')+1).join(' '); const match=line.match(/echo ([A-Za-z0-9+/=]+) \\| base64 -d \\| bash -l/);
 if (!match) process.exit(93);
 const script=Buffer.from(match[1],'base64').toString('utf8');
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
  saveConfig(parseConfig({ language: "en", families: {}, bannedProviders: { providers: [], families: [], pools: [], models: [] }, concurrency: { global: 10, roles: { executor: 10, reviewer: 10 }, pools: { demo: 10 } }, projects: { "paseo-clear-chat": { code: "DEMO", defaultWorkspace: "dir", workspacePath: repo, cloudRunner: { enabled: true, mirrorRoot: join(dir, "mirrors"), retryIntervalSec: 1, maxCreateAttempts: 2 } } } }));
});
after(async () => {
  await stopCloudRuns();
  const processes = execFileSync("/bin/ps", ["-axo", "pid=,args="], { encoding: "utf8" }).split("\n");
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
    assert.ok(cloudPrivacyFindings(ticket, "/home/reviewer").includes("internal-ticket"));
    assert.ok(cloudPrivacyFindings(`prefix${ticket}suffix`, "/home/reviewer").includes("internal-ticket"));
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

test("configuration defaults off, bounds limits and refuses other projects", () => {
  assert.equal(parseConfig({}).projects?.["paseo-clear-chat"]?.cloudRunner?.enabled ?? false, false);
  assert.throws(() => parseConfig({ projects: { other: { defaultWorkspace: "dir", cloudRunner: { enabled: true } } } }), /paseo-clear-chat/);
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

for (const reserved of [{ runtime: "bun", installCommand: ["bun", "install"], testCommand: ["bun", "test"] }, { mode: "persistent" }]) test(`reserved cloud configuration ${JSON.stringify(reserved)} refuses execution as unimplemented`, async () => {
  config(reserved); const card = task(); await start(card.id); await settled();
  assert.equal(getTask(card.id).blocked_kind, "capability"); assert.match(getTask(card.id).blocked_reason!, /not implemented/i);
  assert.equal(log().some(x => x.command === "instabox"), false);
});

test("scheduler leaves active cloud runs to cloud lifecycle instead of reclaiming a missing local session", async () => {
  mode("hang"); const card = task(); await start(card.id);
  await runTick({ launcher, profiles: [codex, reviewer], now: new Date(Date.now() + 180_000), agentState: () => "missing" });
  assert.equal(getTask(card.id).status, "running"); assert.equal(getTask(card.id).fail_count, 0); await stopCloudRuns();
});
