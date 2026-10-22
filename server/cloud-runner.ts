import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { get as httpsGet } from "node:https";
import { clearInterval, clearTimeout, setInterval, setTimeout } from "node:timers";
import { loadConfig, roleLimit } from "./config";
import { CLOUD_PROJECT, parseCloudRunner, type CloudRunnerConfig } from "./cloud-config";
import { cloudDelivery, cloudEvent, cloudRunRecord, isCloudRunning, type CloudDelivery, type CloudRunRecord } from "./cloud-record";
import { executeCloudCommand, type CloudCommand, type CloudCommandOptions, type CloudCommandResult } from "./cloud-command";
import { cloudScratchScript, cloudTaskScript, encodedCloudCommand } from "./cloud-script";
import { cloudPrivacyFindings, cloudPrivateDenylistFindings } from "./cloud-privacy";
import { prepareTaskTmpEnv } from "./card-tmp-record";
import { cardMark } from "./card-ref";
import { getDb } from "./db";
import { completeTask, latestChangeNote } from "./flow";
import { dataDir } from "./paths";
import { projectRepository } from "./project-repo";
import { currentOccupancy } from "./routing";
import { actualFamily, type Profile } from "./profiles";
import { addComment, appendEvent, blockTask, getTask, setHold, type TaskRow } from "./store";
import { notifyTask } from "./wake";
import { t } from "../shared/i18n";
import { parseTags } from "./profile-rules";

export { executeCloudCommand };
export interface CloudRuntime {
  run: CloudCommand;
  publicRepository(repo: string): Promise<boolean>;
}
const defaults: CloudRuntime = {
  run: executeCloudCommand,
  publicRepository: repo => new Promise((resolve, reject) => {
    const request = httpsGet(`https://api.github.com/repos/${repo}`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "paseo-kanban" }, timeout: 20_000,
    }, response => {
      if (response.statusCode !== 200) { response.resume(); resolve(false); return; }
      let text = "";
      response.setEncoding("utf8");
      response.on("data", value => { text += value; if (text.length > 1_000_000) request.destroy(new Error("Public repository receipt too large")); });
      response.on("end", () => {
        try {
          const value = JSON.parse(text) as { private?: unknown; visibility?: unknown; full_name?: unknown };
          resolve(value.private === false && value.visibility === "public" && typeof value.full_name === "string" && value.full_name.toLowerCase() === repo.toLowerCase());
        } catch { resolve(false); }
      });
      response.on("error", reject);
    });
    request.on("timeout", () => request.destroy(new Error("Public repository check timed out")));
    request.on("error", reject);
  }),
};
let runtime = defaults;
/** Trusted fixture dependencies; never exposed through project settings or RPC. */
export function setCloudRuntimeForTests(value: CloudRuntime | null): void { runtime = value ?? defaults; reconciled.clear(); stopping = false; }

interface ActiveRun { controller: AbortController; promise: Promise<void>; generation: number; stopping: boolean }
const active = new Map<number, ActiveRun>();
const starting = new Set<Promise<{ message: string }>>();
let stopping = false;
let bindings = 0;
let bindingReady = Promise.resolve();
const reconciled = new Set<string>();
const reconciling = new Map<string, Promise<void>>();
const mirrorLocks = new Map<string, Promise<void>>();
export const cloudBoardPrefix = (): string => `pkb-${createHash("sha256").update(dataDir()).digest("hex").slice(0, 12)}-`;
function hostEnv(scratch?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "LANG", "LC_ALL", "SSH_AUTH_SOCK", "XDG_CONFIG_HOME"]) if (process.env[key]) env[key] = process.env[key];
  if (scratch) env.TMPDIR = env.KANBAN_TMP = scratch;
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}
function anonymousEnv(scratch: string): NodeJS.ProcessEnv {
  const home = join(scratch, "anonymous"); mkdirSync(home, { recursive: true, mode: 0o700 });
  return { PATH: process.env.PATH, HOME: home, TMPDIR: scratch, KANBAN_TMP: scratch,
    GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_ASKPASS: "/usr/bin/false", SSH_ASKPASS: "/usr/bin/false" };
}
function checked(result: CloudCommandResult, stage: string): string {
  if (result.code !== 0) throw new Error(`Cloud ${stage} failed (exit ${result.code})`);
  return result.stdout;
}
function leaderNotice(id: number, reason: string): void {
  appendEvent(id, "cloud_leader_notice", null, null, "scheduler", { reason });
  notifyTask(getTask(id), "blocked", reason);
}
function block(id: number, kind: "capability" | "needs_human", reason: string): void {
  const task = getTask(id);
  if (!["ready", "running", "rework"].includes(task.status)) return;
  blockTask(id, kind, reason, "scheduler"); leaderNotice(id, reason);
}
async function removeMachine(name: string, run: CloudCommand, env: NodeJS.ProcessEnv): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    await run("instabox", ["rm", name], { env, timeoutMs: 20_000 });
    // A failed deletion is never assumed successful: only a successful list proves absence.
    const list = await run("instabox", ["ls", "--json"], { env, timeoutMs: 20_000 });
    if (list.code === 0 && !machineNames(list.stdout).includes(name)) return true;
  }
  return false;
}
function anotherLiveOwner(record: CloudRunRecord): boolean {
  if (!record.ownerPid || record.ownerPid === process.pid) return false;
  try { process.kill(record.ownerPid, 0); return true; } catch { return false; }
}
function machineNames(text: string): string[] {
  const value = JSON.parse(text) as unknown;
  const rows = Array.isArray(value) ? value : value && typeof value === "object"
    ? (value as { machines?: unknown; boxes?: unknown }).machines ?? (value as { boxes?: unknown }).boxes : null;
  if (!Array.isArray(rows) || rows.some(row => !row || typeof row.name !== "string")) throw new Error("Cloud machine inventory is invalid");
  return rows.map(row => row.name as string);
}
function restoreWorkspace(record: CloudRunRecord, id: number): void {
  getDb().prepare("UPDATE tasks SET workspace_path = ?, workspace_kind = ? WHERE id = ?").run(record.originalPath, record.originalKind, id);
}
function endRun(record: CloudRunRecord, outcome: string): void {
  getDb().prepare("UPDATE runs SET ended_at = ?, end_kind = ? WHERE id = ? AND ended_at IS NULL").run(new Date().toISOString(), outcome, record.runId);
}
function submitDelivery(id: number, delivery: CloudDelivery): void {
  appendEvent(id, "cloud_delivery", null, null, "scheduler", { ...delivery });
  appendEvent(id, "cloud_capacity_wait", null, null, "scheduler", { generation: delivery.generation, attempts: 0, retryAt: 0 });
  appendEvent(id, "branch_observed", null, null, "scheduler", { branch: delivery.branch, head: delivery.head, pushed: true });
  getDb().prepare("UPDATE tasks SET workspace_path = ?, workspace_kind = 'dir', paseo_workspace_id = NULL, paseo_workspace_name = NULL WHERE id = ?").run(delivery.mirror, id);
  completeTask(id, "executor", t("cloud.ready"), {
    files: delivery.files, verification: [...(delivery.verification ?? []), "bundle fetch and privacy/identity scan: passed", "machine deletion: confirmed"],
    risks: [t("cloud.reviewRisk")], prUrl: delivery.pr, commit: delivery.head, mirror: delivery.mirror, branch: delivery.branch,
  });
}

/** Startup barrier. A disabled, unused feature never invokes the cloud CLI. */
export async function reconcileCloudMachines(): Promise<void> {
  if (stopping) return;
  const key = dataDir();
  if (reconciled.has(key)) return;
  const prior = reconciling.get(key); if (prior) return prior;
  const settings = loadConfig();
  const records = getDb().prepare("SELECT DISTINCT task_id FROM events WHERE kind = 'cloud_run_started'").all() as unknown as Array<{ task_id: number }>;
  const unfinished = records.filter(row => {
    const record = cloudRunRecord(row.task_id)!;
    return !active.has(row.task_id) && !anotherLiveOwner(record) && (cloudEvent<{ generation: number }>(row.task_id, "cloud_run_cleaned")?.generation !== record.generation ||
      cloudEvent<{ generation: number }>(row.task_id, "cloud_run_settled")?.generation !== record.generation);
  });
  if (!Object.values(settings.projects ?? {}).some(row => row.cloudRunner?.enabled) && unfinished.length === 0) return;
  const mine = (async () => {
    const run = runtime.run; const env = hostEnv(); const prefix = cloudBoardPrefix();
    const names = machineNames(checked(await run("instabox", ["ls", "--json"], { env, timeoutMs: 20_000 }), "inventory"));
    const live = new Set([...active.keys()].map(id => cloudRunRecord(id)?.machine));
    for (const row of records) {
      const record = cloudRunRecord(row.task_id)!;
      if (anotherLiveOwner(record) && cloudEvent<{ generation: number }>(row.task_id, "cloud_run_cleaned")?.generation !== record.generation) live.add(record.machine);
    }
    for (const name of names) {
      if (!name.startsWith(prefix) || !/^[a-z0-9-]+-g\d+$/.test(name.slice(prefix.length)) || live.has(name)) continue;
      if (!await removeMachine(name, run, env)) throw new Error("Cloud startup cleanup failed; dispatch held");
    }
    for (const { task_id: id } of unfinished) {
      const record = cloudRunRecord(id)!;
      appendEvent(id, "cloud_run_cleaned", null, null, "scheduler", { generation: record.generation, machine: record.machine, via: "startup" });
      const receipt = cloudEvent<CloudDelivery>(id, "cloud_pr_created");
      if (isCloudRunning(getTask(id))) {
        if (receipt?.generation === record.generation) submitDelivery(id, receipt);
        else {
          restoreWorkspace(record, id);
          getDb().prepare("UPDATE tasks SET status = 'ready', hold_reason = ?, updated_at = ? WHERE id = ? AND status = 'running'")
            .run(t("cloud.restarted"), new Date().toISOString(), id);
        }
      }
      endRun(record, "cloud_restart");
      appendEvent(id, "cloud_run_settled", null, null, "scheduler", { generation: record.generation, outcome: "restart" });
    }
    reconciled.add(key);
  })().finally(() => { reconciling.delete(key); });
  reconciling.set(key, mine); return mine;
}

export function cloudExecutionEnabled(task: TaskRow): boolean {
  return task.role === "executor" && parseTags(task.tags).includes("cloud") && ["ready", "rework"].includes(task.status) && loadConfig().projects?.[task.project]?.cloudRunner?.enabled === true;
}

/** Read before the ordinary scheduler's workspace and liveness gates. */
export function cloudQueueReason(task: TaskRow, now = Date.now()): string | null {
  if (!cloudExecutionEnabled(task)) return null;
  const config = loadConfig().projects![task.project].cloudRunner!;
  const wait = cloudEvent<{ attempts: number; retryAt: number }>(task.id, "cloud_capacity_wait");
  if (wait && wait.attempts >= config.maxCreateAttempts) return t("cloud.capacityLimit");
  if (wait && wait.retryAt > now) return t("cloud.retryAfter", { until: new Date(wait.retryAt).toISOString() });
  return null;
}

type CloudLaunchInput = { task: TaskRow; profile: Profile; profiles: Profile[]; effort: string | null; guard: () => void };
export function launchCloudTask(input: CloudLaunchInput): Promise<{ message: string }> {
  const promise = startCloudTask(input); starting.add(promise);
  void promise.finally(() => starting.delete(promise)).catch(() => undefined);
  return promise;
}
async function startCloudTask(input: CloudLaunchInput): Promise<{ message: string }> {
  const { task, profile } = input;
  const stopped = () => { const reason = t("cloud.stopping"); setHold(task.id, reason); return { message: reason }; };
  if (stopping) return stopped();
  if (active.has(task.id)) { const reason = t("cloud.cleaning"); setHold(task.id, reason); return { message: reason }; }
  const settings = loadConfig();
  const config = parseCloudRunner(task.project, settings.projects![task.project].cloudRunner);
  if (config.runtime !== "npm" || config.mode !== "per-card") {
    block(task.id, "capability", t("cloud.unimplemented"));
    return { message: getTask(task.id).hold_reason! };
  }
  const provider = profile.provider === "codex" && actualFamily(profile) === "openai" && /^gpt-/i.test(profile.model ?? "") ? "codex"
    : profile.provider === "grok" && actualFamily(profile) === "xai" && /^grok-/i.test(profile.model ?? "") ? "grok" : null;
  if (!provider) { block(task.id, "capability", t("cloud.profileRefused")); return { message: getTask(task.id).hold_reason! }; }
  const wait = cloudQueueReason(task); if (wait) { setHold(task.id, wait); return { message: wait }; }
  const repo = projectRepository({ project: task.project, workspacePath: task.workspace_path });
  if (task.project !== CLOUD_PROJECT || repo?.split("/")[1] !== CLOUD_PROJECT) {
    block(task.id, "capability", t("cloud.repositoryRequired")); return { message: getTask(task.id).hold_reason! };
  }
  const scratch = prepareTaskTmpEnv(task, "scheduler").KANBAN_TMP;
  if (!scratch) { block(task.id, "capability", t("cloud.scratchMissing")); return { message: getTask(task.id).hold_reason! }; }
  const run = runtime.run;
  let publicRepo = false;
  try {
    publicRepo = await runtime.publicRepository(repo);
    if (publicRepo) {
      const proof = await run("git", ["-c", "credential.helper=", "-c", "http.extraHeader=", "ls-remote", `https://github.com/${repo}.git`, "HEAD"], { env: anonymousEnv(scratch), timeoutMs: 20_000 });
      publicRepo = proof.code === 0 && /^[0-9a-f]{40,64}\s+HEAD\s*$/m.test(proof.stdout);
    }
  } catch { /* Fail closed on an unavailable anonymous proof. */ }
  if (!publicRepo) { block(task.id, "capability", t("cloud.publicAccessRefused")); return { message: getTask(task.id).hold_reason! }; }
  if (provider === "grok" && config.templateRefreshedAt) {
    const age = (Date.now() - Date.parse(config.templateRefreshedAt)) / 86_400_000;
    if (age >= config.templateMaxAgeDays) { block(task.id, "capability", t("cloud.grokExpired", { snapshot: config.snapshot })); return { message: getTask(task.id).hold_reason! }; }
    if (age >= config.templateWarnAgeDays) {
      const reason = t("cloud.grokWarning", { snapshot: config.snapshot }); addComment(task.id, "scheduler", reason); leaderNotice(task.id, reason);
    }
  }
  try { await reconcileCloudMachines(); }
  catch { const reason = t("cloud.startupHeld"); setHold(task.id, reason); return { message: reason }; }
  if (stopping) return stopped();
  const previous = cloudRunRecord(task.id);
  const generation = (previous?.generation ?? 0) + 1;
  const machine = `${cloudBoardPrefix()}${cardMark(task.id).toLowerCase().replaceAll("_", "-")}-g${generation}`;
  const branch = `kanban/cloud-${createHash("sha256").update(`${dataDir()}:${task.id}:${generation}`).digest("hex").slice(0, 20)}`;
  const originalPath = settings.projects![task.project].workspacePath ?? previous?.originalPath ?? task.workspace_path;
  const originalKind = previous?.originalKind ?? task.workspace_kind;
  const mirror = join(config.mirrorRoot ?? join(dirname(originalPath!), "_mirrors"), `${CLOUD_PROJECT}.git`);
  let record: CloudRunRecord;
  const db = getDb(); db.exec("BEGIN IMMEDIATE");
  try {
    input.guard();
    const current = getTask(task.id);
    if (current.status !== task.status || current.wait_decision) throw new Error("Cloud start superseded");
    const occupancy = currentOccupancy(input.profiles);
    const cloudCount = (db.prepare("SELECT id, status FROM tasks WHERE status = 'running'").all() as unknown as Array<{ id: number; status: TaskRow["status"] }>).filter(isCloudRunning).length;
    const reason = cloudCount >= config.maxParallel ? t("cloud.parallelFull")
      : occupancy.global >= settings.concurrency.global ? t("cloud.globalFull")
      : (occupancy.byRole.executor ?? 0) >= roleLimit(settings.concurrency, "executor") ? t("cloud.roleFull")
      : profile.pool && settings.concurrency.pools[profile.pool] != null && (occupancy.byPool[profile.pool] ?? 0) >= settings.concurrency.pools[profile.pool] ? t("cloud.poolFull") : null;
    if (reason) { setHold(task.id, reason); db.exec("COMMIT"); return { message: reason }; }
    const at = new Date().toISOString();
    db.prepare("UPDATE tasks SET status = 'running', agent_id = NULL, executor_agent_id = NULL, executor_profile = ?, executor_family = ?, workspace_kind = 'none', hold_reason = NULL, updated_at = ? WHERE id = ?")
      .run(profile.name, actualFamily(profile), at, task.id);
    const result = db.prepare("INSERT INTO runs (task_id, agent_id, role, profile_name, provider, model, family, auto_accept, thinking_option_id, effort, started_at) VALUES (?, NULL, 'executor', ?, ?, ?, ?, 0, ?, ?, ?)")
      .run(task.id, profile.name, provider, profile.model!, actualFamily(profile), input.effort, input.effort, at);
    record = { generation, machine, branch, repo, base: settings.projects![task.project].baseBranch, mirror, originalPath, originalKind, runId: Number(result.lastInsertRowid), ownerPid: process.pid };
    appendEvent(task.id, "cloud_run_started", task.status, "running", "scheduler", { ...record });
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  const controller = new AbortController();
  const item: ActiveRun = { controller, generation, stopping: false, promise: Promise.resolve() };
  active.set(task.id, item);
  item.promise = executeTask({ task, profile, config, record, provider, effort: input.effort, scratch, controller, run, item })
    .catch(() => { if (isCloudRunning(getTask(task.id))) block(task.id, "capability", t("cloud.handoffFailed")); })
    .finally(() => { if (active.get(task.id) === item) active.delete(task.id); });
  return { message: t("cloud.started", { machine }) };
}

async function inMirror<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const prior = mirrorLocks.get(path) ?? Promise.resolve();
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const tail = prior.then(() => gate); mirrorLocks.set(path, tail); await prior;
  try { return await fn(); } finally { release(); if (mirrorLocks.get(path) === tail) mirrorLocks.delete(path); }
}

async function executeTask(input: {
  task: TaskRow; profile: Profile; config: CloudRunnerConfig; record: CloudRunRecord; provider: "codex" | "grok";
  effort: string | null; scratch: string; controller: AbortController; run: CloudCommand; item: ActiveRun;
}): Promise<void> {
  const { task, profile, config, record, provider, scratch, controller, run, item } = input;
  const env = hostEnv(scratch); const signal = controller.signal;
  let outcome = "failed"; let delivery: CloudDelivery | null = null; let capacity = false; let failure = t("cloud.failed");
  let failureKind: "capability" | "needs_human" = "capability";
  const owned = () => isCloudRunning(getTask(task.id)) && cloudRunRecord(task.id)?.generation === record.generation && !signal.aborted;
  const ensureOwned = () => { if (!owned()) throw new Error("Cloud generation cancelled"); };
  const poll = setInterval(() => { if (!owned()) controller.abort(); }, 100);
  const deadline = setTimeout(() => { outcome = "timeout"; controller.abort(); }, config.taskTimeoutSec * 1000);
  const command = async (file: string, args: string[], extra: Partial<CloudCommandOptions> = {}) => {
    ensureOwned(); return run(file, args, { env, signal, timeoutMs: config.taskTimeoutSec * 1000, ...extra });
  };
  const remote = (script: string) => command("instabox", ["exec", record.machine, "--", encodedCloudCommand(`${cloudScratchScript(cardMark(task.id))}\n${script}`)]);
  const bundle = join(scratch, `task-g${record.generation}.bundle`);
  const body = join(scratch, `pr-g${record.generation}.md`);
  try {
    const create = await command("instabox", ["create", "--name", record.machine, "--snapshot", config.snapshot, "--auto-suspend", "0", "--timeout", `${config.machineTimeoutSec}s`, "--on-timeout", "kill"]);
    if (/\bno_capacity\b/i.test(`${create.stdout}\n${create.stderr}`)) { capacity = true; outcome = "no_capacity"; return; }
    checked(create, "create");
    checked(await command("instabox", ["get", record.machine]), "machine readiness");
    const previous = cloudDelivery(task.id);
    const source = task.status === "rework" && previous ? previous.branch : record.base;
    const result = await remote(cloudTaskScript({ repo: record.repo, branch: record.branch, base: record.base, source,
      provider, model: profile.model!, effort: input.effort, prompt: `${task.brief || task.title}${task.status === "rework" ? `\nReview feedback:\n${latestChangeNote(task.id)}` : ""}`, timeoutSec: config.taskTimeoutSec,
      installCommand: config.installCommand, testCommand: config.testCommand, directories: config.directories,
      runtimeVersion: config.runtimeVersion, environment: config.environment }));
    if (result.code !== 0) {
      if (provider === "grok" && /(?:PKB_GROK_LOGIN_EXPIRED|not (?:logged|signed) in|not authenticated|unauthenticated|authentication (?:expired|required|failed)|(?:login|session|token|credential)[^\n]{0,80}(?:expired|invalid)|(?:please|run)[^\n]{0,40}grok login|\b401\b)/i.test(`${result.stdout}\n${result.stderr}`)) {
        failure = t("cloud.grokExpired", { snapshot: config.snapshot });
      } else failure = t("cloud.validationFailed", { code: result.code });
      return;
    }
    if (/^PKB_NO_CHANGES$/m.test(result.stdout)) { failure = t("cloud.noChanges"); return; }
    const baseHead = result.stdout.match(/^PKB_BASE=([0-9a-f]{40,64})$/m)?.[1];
    const head = result.stdout.match(/^PKB_HEAD=([0-9a-f]{40,64})$/m)?.[1];
    if (!baseHead || !head || !/^PKB_TEST_OK$/m.test(result.stdout)) throw new Error("Cloud test receipt missing");
    const encoded = checked(await remote('base64 -w0 "$KANBAN_TMP/task.bundle"; echo'), "bundle export")
      .split(/\r?\n/).filter(line => /^[A-Za-z0-9+/]{40,}={0,2}$/.test(line)).join("");
    if (!encoded || encoded.length % 4 !== 0) throw new Error("Cloud bundle encoding invalid");
    writeFileSync(bundle, Buffer.from(encoded, "base64"), { flag: "wx", mode: 0o600 });
    delivery = await inMirror(record.mirror, async () => {
      mkdirSync(dirname(record.mirror), { recursive: true });
      const git = async (args: string[], anonymous = false) => checked(await command("git", ["-C", record.mirror, ...args], anonymous ? { env: anonymousEnv(scratch) } : {}), "Git transfer");
      const url = `https://github.com/${record.repo}.git`;
      const exists = await command("git", ["-C", record.mirror, "rev-parse", "--is-bare-repository"]);
      if (exists.code !== 0) checked(await command("git", ["clone", "--bare", "--filter=blob:none", url, record.mirror], { env: anonymousEnv(scratch) }), "mirror clone");
      if ((await git(["rev-parse", "--is-bare-repository"])).trim() !== "true") throw new Error("Cloud mirror must be bare");
      await git(["-c", "credential.helper=", "fetch", url, `refs/heads/${record.base}:refs/remotes/origin/${record.base}`], true);
      await git(["bundle", "verify", bundle]);
      await git(["fetch", bundle, `refs/heads/${record.branch}:refs/heads/${record.branch}`]);
      if ((await git(["rev-parse", `refs/heads/${record.branch}`])).trim() !== head) throw new Error("Cloud bundle head mismatch");
      const range = `refs/remotes/origin/${record.base}..refs/heads/${record.branch}`;
      await git(["merge-base", "--is-ancestor", baseHead, head]);
      if (task.status === "rework" && previous) {
        if (baseHead !== previous.head) throw new Error("Cloud rework base changed");
      } else await git(["merge-base", "--is-ancestor", baseHead, `refs/remotes/origin/${record.base}`]);
      if ((await git(["rev-list", "--count", `${baseHead}..${head}`])).trim() !== "1") throw new Error("Cloud bundle must contain one anonymous commit");
      const patch = await git(["-c", "core.quotePath=false", "log", "--format=fuller", "--binary", "-p", range]);
      const files = (await git(["diff", "--name-only", "-z", `refs/remotes/origin/${record.base}...refs/heads/${record.branch}`])).split("\0").filter(Boolean);
      const findings = cloudPrivacyFindings(`${patch}\n${files.join("\n")}`);
      try { findings.push(...cloudPrivateDenylistFindings(`${patch}\n${files.join("\n")}`)); }
      catch { failureKind = "needs_human"; failure = t("cloud.denylistMissing"); throw new Error("privacy setup"); }
      const identities = await git(["log", "--format=%ae%n%ce", range]);
      if (identities.trim().split("\n").some(value => value.trim() !== "noreply@github.com")) findings.push("identity");
      if (findings.length) { failureKind = "needs_human"; failure = t("cloud.privacyBlocked", { categories: [...new Set(findings)].join(", ") }); throw new Error("privacy"); }
      ensureOwned();
      await git(["push", url, `refs/heads/${record.branch}:refs/heads/${record.branch}`]);
      appendEvent(task.id, "cloud_branch_pushed", null, null, "scheduler", { generation: record.generation, branch: record.branch, head });
      writeFileSync(body, `Implemented and tested in a disposable ${provider} sandbox.\n\nValidation: npm ci and npm test passed. Anonymous bundle scanned on the host. Independent review is required.\n`, { flag: "wx", mode: 0o600 });
      const pr = checked(await command("gh", ["pr", "create", "--repo", record.repo, "--draft", "--head", record.branch, "--base", record.base, "--title", "Implement cloud task", "--body-file", body]), "draft PR").trim();
      if (!new RegExp(`^https://github\\.com/${record.repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/pull/\\d+$`).test(pr)) throw new Error("Cloud draft PR receipt invalid");
      const receipt = { ...record, head, baseHead, pr, files, verification: config.directories.flatMap(directory => [`${directory}: ${config.installCommand.join(" ")}: passed on cloud machine`, `${directory}: ${config.testCommand.join(" ")}: passed on cloud machine`]) };
      appendEvent(task.id, "cloud_pr_created", null, null, "scheduler", receipt);
      return receipt;
    });
    outcome = "success";
  } catch { /* Only bounded, category-level diagnostics reach board events. */ }
  finally {
    clearInterval(poll); clearTimeout(deadline);
    const removed = await removeMachine(record.machine, run, env).catch(() => false);
    rmSync(bundle, { force: true }); rmSync(body, { force: true });
    if (!removed) {
      reconciled.delete(dataDir()); failureKind = "needs_human"; failure = t("cloud.cleanupPending");
      if (isCloudRunning(getTask(task.id))) block(task.id, failureKind, failure);
      else leaderNotice(task.id, failure);
      endRun(record, "cloud_cleanup_pending");
      appendEvent(task.id, "cloud_cleanup_pending", null, null, "scheduler", { generation: record.generation, machine: record.machine });
      return;
    }
    appendEvent(task.id, "cloud_run_cleaned", null, null, "scheduler", { generation: record.generation, machine: record.machine });
    if (cloudRunRecord(task.id)?.generation !== record.generation) return;
    if (isCloudRunning(getTask(task.id))) {
      if (capacity) {
        const attempts = (cloudEvent<{ attempts: number }>(task.id, "cloud_capacity_wait")?.attempts ?? 0) + 1;
        appendEvent(task.id, "cloud_capacity_wait", "running", "ready", "scheduler", { generation: record.generation, attempts, retryAt: Date.now() + config.retryIntervalSec * 1000 });
        restoreWorkspace(record, task.id);
        const reason = attempts >= config.maxCreateAttempts ? t("cloud.capacityHeld") : t("cloud.capacityQueued");
        getDb().prepare("UPDATE tasks SET status = 'ready', hold_reason = ?, updated_at = ? WHERE id = ?").run(reason, new Date().toISOString(), task.id);
      } else if (delivery && outcome === "success") {
        submitDelivery(task.id, delivery);
      } else if (item.stopping) {
        restoreWorkspace(record, task.id);
        getDb().prepare("UPDATE tasks SET status = 'ready', hold_reason = ?, updated_at = ? WHERE id = ?").run(t("cloud.stopped"), new Date().toISOString(), task.id);
        outcome = "stopped";
      } else {
        restoreWorkspace(record, task.id);
        if (outcome === "timeout") failure = t("cloud.timedOut");
        block(task.id, failureKind, failure);
      }
    }
    endRun(record, outcome);
    appendEvent(task.id, "cloud_run_settled", null, null, "scheduler", { generation: record.generation, outcome });
  }
}

export async function waitForCloudRuns(): Promise<void> { await Promise.all([...active.values()].map(value => value.promise)); }
export async function stopCloudRuns(): Promise<void> {
  stopping = true;
  await Promise.allSettled([...starting]);
  await Promise.allSettled([...reconciling.values()]);
  for (const value of active.values()) { value.stopping = true; value.controller.abort(); }
  await waitForCloudRuns();
}

/** Multiple host bindings share workers; a later plugin bind can restart a stopped runtime. */
export function bindCloudRunner(): { ready: Promise<void>; release(): Promise<void> } {
  if (bindings++ === 0) bindingReady = stopCloudRuns().then(() => { stopping = false; reconciled.clear(); });
  let released = false;
  return { ready: bindingReady, async release() {
    if (released) return; released = true;
    if (--bindings === 0) { await bindingReady; if (bindings === 0) await stopCloudRuns(); }
  } };
}
