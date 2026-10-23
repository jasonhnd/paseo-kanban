import { cursorPaidModel, isCursorChannel } from "../shared/fleet/cursor-dispatch";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { get as httpsGet } from "node:https";
import { clearInterval, clearTimeout, setInterval, setTimeout } from "node:timers";
import { loadConfig, roleLimit, type KanbanConfig } from "./config";
import { assertLocalMirrorEligibility, cloudSettingsSchema, DEFAULT_CLOUD_RECONCILE_RETRY_SEC, parseCloudRunner, type CloudRunnerConfig } from "./cloud-config";
import { cloudDelivery, cloudEvent, localCloudReceipt, cloudRunRecord, isCloudRunning, type CloudDelivery, type CloudRunRecord } from "./cloud-record";
import { executeCloudCommand, type CloudCommand, type CloudCommandOptions, type CloudCommandResult } from "./cloud-command";
import { cloudDirectoryVerification, cloudDraftPrBody, cloudScratchScript, cloudTaskScript, encodedCloudCommand } from "./cloud-script";
import { cloudPrivacyFindings, cloudPrivateDenylistFindings } from "./cloud-privacy";
import { createSourceSnapshot, scanOutbound } from "./cloud-source";
import { uploadFile, downloadFile } from "./cloud-transfer";
import { localGit, localCloudFeedback, recoverLocalDelivery, localDeliveryWorktree, prepareLocalImport, resumeLocalImport, verifyLocalResult, type LocalImport, type LocalMapping } from "./cloud-local";
import { readContract } from "./pr";
import { refOk } from "./git";
import { KanbanError } from "./errors";
import { prepareTaskTmpEnv } from "./card-tmp-record";
import { cardMark } from "./card-ref";
import { getDb } from "./db";
import { completeTask, latestChangeNote } from "./flow";
import { dataDir } from "./paths";
import { projectRepository } from "./project-repo";
import { currentOccupancy } from "./routing";
import { actualFamily, type Profile } from "./profiles";
import { addComment, appendEvent, blockTask, getTask, setHold, type TaskRow } from "./store";
import { notifyCloudProjectRefusal, notifyCloudReconcile, notifyTask } from "./wake";
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
export function setCloudRuntimeForTests(value: CloudRuntime | null): void { runtime = value ?? defaults; reconciled.clear(); reconcileFailures.clear(); stopping = false; }

interface ActiveRun { controller: AbortController; promise: Promise<void>; generation: number; stopping: boolean }
const active = new Map<number, ActiveRun>();
const starting = new Set<Promise<{ message: string }>>();
let stopping = false;
let bindings = 0;
let bindingReady = Promise.resolve();
const reconciled = new Set<string>();
interface ReconcileFailure { attempts: number; retryAt: number; inventory: boolean }
const reconcileFailures = new Map<string, ReconcileFailure>();
function reconcileHold(): string | null {
  const failure = reconcileFailures.get(dataDir());
  if (!failure) return null;
  const at = new Date(failure.retryAt);
  const until = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
  return t(failure.inventory ? "cloud.inventoryHeld" : "cloud.reconcileHeld", { until });
}
/** Keep diagnostic wording, but never forward credentials or local identities to AFC. */
function inventoryError(error: unknown): string {
  let text = error instanceof Error ? error.message : String(error);
  for (const [key, value] of Object.entries(process.env)) {
    if (value && value.length >= 4 && /TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY/i.test(key)) text = text.split(value).join("[redacted]");
  }
  return text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[url redacted]")
    .replace(/\b(?:Bearer|Basic)\s+[^\s]+/gi, "[authorization redacted]")
    .replace(/(["']?[\w-]*(?:token|secret|password|credential|api[_-]?key)[\w-]*["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}]+)/gi, "$1[redacted]")
    .replace(/\b(?:gh[pousr]_|github_pat_|sk-|xai-)[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/\/(?:Users|home)\/[^\s]+/g, "[path redacted]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email redacted]")
    .replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 1600);
}
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
  if (result.code !== 0 || result.truncated) throw new Error(`Cloud ${stage} failed (exit ${result.code})`);
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
  const settings = cloudSettingsSchema.parse(loadConfig().cloud ?? {});
  const deadline = Date.now() + settings.deleteTimeoutSec * 1000;
  // rm waits for the API operation by default. Never use --no-wait or the cancelled task signal.
  const signal = AbortSignal.timeout(settings.deleteTimeoutSec * 1000);
  try { await run("instabox", ["rm", name], { env, signal, timeoutMs: settings.deleteTimeoutSec * 1000 }); }
  catch { /* Even an unsuccessful rm can only be cleared by a complete inventory proving absence. */ }
  while (Date.now() < deadline) {
    try {
      const list = await run("instabox", ["ls", "--json"], { env, signal, timeoutMs: Math.min(20_000, deadline - Date.now()) });
      if (Date.now() < deadline && list.code === 0 && !list.truncated && !machineNames(list.stdout).includes(name)) return true;
    } catch { /* Invalid/unavailable inventory is inconclusive; retry within the same cleanup budget. */ }
    const remaining = deadline - Date.now();
    if (remaining > 0) await new Promise<void>(resolve => setTimeout(resolve, Math.min(settings.deletePollIntervalSec * 1000, remaining)));
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
  getDb().prepare("UPDATE tasks SET workspace_path = ?, workspace_kind = ? WHERE id = ?").run(record.originalPath, record.originalKind ?? "none", id);
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

/** Notice failures leave their durable mark retryable; they never change reconciliation state. */
async function cloudReconcileNotices(detail: string, recovered: boolean, projects?: string[]): Promise<void> {
  try {
    await Promise.allSettled((projects ?? Object.keys(loadConfig().projects ?? {}))
      .map(project => notifyCloudReconcile(project, detail, recovered)));
  } catch { /* Configuration or notice preparation may be temporarily unavailable. Retry next tick. */ }
}

function submitLocalDelivery(id: number, delivery: LocalImport): void {
  const { receipt, worktree } = delivery;
  if (cloudRunRecord(id)?.generation !== receipt.generation || !isCloudRunning(getTask(id))) throw new Error("Cloud local delivery superseded");
  appendEvent(id, "cloud_capacity_wait", null, null, "scheduler", { generation: receipt.generation, attempts: 0, retryAt: 0 });
  appendEvent(id, "branch_observed", null, null, "scheduler", { branch: worktree.branch, head: receipt.localHead, pushed: false });
  getDb().prepare("UPDATE tasks SET workspace_path = ?, workspace_kind = 'worktree', workspace_base = ?, paseo_workspace_id = NULL, paseo_workspace_name = NULL WHERE id = ?")
    .run(worktree.directory, worktree.base, id);
  completeTask(id, "executor", "Local cloud changes are ready for independent review", {
    files: delivery.files, verification: [...delivery.verification, "isolated bundle graph, file inventory and local replay privacy scan: passed", "machine deletion: confirmed"],
    risks: ["Cloud tests ran in a disposable sandbox; review the replayed local commit before acceptance"],
    commit: receipt.localHead, branch: worktree.branch, receipt,
  });
}

/** Startup barrier. A disabled, unused feature never invokes the cloud CLI. */
export async function reconcileCloudMachines(now = Date.now()): Promise<void> {
  if (stopping) return;
  const key = dataDir();
  if (reconciled.has(key)) {
    // A temporarily unavailable leader or AFC transport must not lose the recovery notice.
    reconcileFailures.delete(key);
    await cloudReconcileNotices(t("cloud.inventoryRecovered"), true);
    return;
  }
  const prior = reconciling.get(key); if (prior) return prior;
  const failure = reconcileFailures.get(key);
  if (failure && now < failure.retryAt) return;
  const settings = loadConfig();
  const records = getDb().prepare("SELECT DISTINCT task_id FROM events WHERE kind = 'cloud_run_started'").all() as unknown as Array<{ task_id: number }>;
  const unfinished = records.filter(row => {
    const record = cloudRunRecord(row.task_id)!;
    return !active.has(row.task_id) && !anotherLiveOwner(record) && (cloudEvent<{ generation: number }>(row.task_id, "cloud_run_cleaned")?.generation !== record.generation ||
      cloudEvent<{ generation: number }>(row.task_id, "cloud_run_settled")?.generation !== record.generation);
  });
  if (!Object.keys(settings.projects ?? {}).some(project => admittedCloudProject(settings, project)) && unfinished.length === 0) return;
  let inventory = true;
  const mine = (async () => {
    const run = runtime.run; const env = hostEnv(); const prefix = cloudBoardPrefix();
    const result = await run("instabox", ["ls", "--json"], { env, timeoutMs: 20_000 });
    if (result.code !== 0) throw new Error(`Cloud inventory failed (exit ${result.code}): ${result.stderr || result.stdout}`);
    if (result.truncated) throw new Error("Cloud inventory failed: output truncated");
    const names = machineNames(result.stdout);
    inventory = false;
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
        if (record.source === "localMirror") {
          const scratch = prepareTaskTmpEnv(getTask(id), "scheduler").KANBAN_TMP!;
          const config = settings.projects?.[getTask(id).project]?.cloudRunner;
          const signal = AbortSignal.timeout((config?.taskTimeoutSec ?? 30) * 1000);
          const git = localGit(run, scratch, signal, () => {
            if (!isCloudRunning(getTask(id)) || cloudRunRecord(id)?.generation !== record.generation) throw new Error("Cloud local recovery superseded");
          });
          try {
            const delivery = await recoverLocalDelivery(id, git);
            if (delivery) {
              await resumeLocalImport(id, delivery, git); submitLocalDelivery(id, delivery);
            } else {
              restoreWorkspace(record, id);
              getDb().prepare("UPDATE tasks SET status = 'ready', hold_reason = ?, updated_at = ? WHERE id = ? AND status = 'running'")
                .run(t("cloud.restarted"), new Date().toISOString(), id);
            }
          } catch { block(id, "needs_human", "Local cloud receipt could not be recovered safely"); }
        } else if (receipt?.generation === record.generation) submitDelivery(id, receipt);
        else {
          restoreWorkspace(record, id);
          getDb().prepare("UPDATE tasks SET status = 'ready', hold_reason = ?, updated_at = ? WHERE id = ? AND status = 'running'")
            .run(t("cloud.restarted"), new Date().toISOString(), id);
        }
      }
      endRun(record, "cloud_restart");
      appendEvent(id, "cloud_run_settled", null, null, "scheduler", { generation: record.generation, outcome: "restart" });
    }
  })().catch(async error => {
    const attempts = (failure?.attempts ?? 0) + 1;
    const schedules = Object.keys(settings.projects ?? {}).flatMap(project => admittedCloudProject(settings, project) ? [settings.projects![project].cloudRunner!.reconcileRetrySec] : []);
    const delay = Math.min(...(schedules.length ? schedules : [DEFAULT_CLOUD_RECONCILE_RETRY_SEC]).map(steps => steps[Math.min(attempts - 1, steps.length - 1)]));
    // Start the delay when the attempt finishes, including a slow inventory timeout.
    reconcileFailures.set(key, { attempts, retryAt: Math.max(now, Date.now()) + delay * 1000, inventory });
    const detail = inventoryError(error);
    await cloudReconcileNotices(`${reconcileHold()}: ${detail}`, false, Object.keys(settings.projects ?? {})
      .filter(project => admittedCloudProject(settings, project) || unfinished.some(row => getTask(row.task_id).project === project)));
    throw new Error(detail);
  }).then(async () => {
    // Commit success outside the failure handler, before attempting any recovery notice.
    reconcileFailures.delete(key);
    reconciled.add(key);
    await cloudReconcileNotices(t("cloud.inventoryRecovered"), true);
  }).finally(() => { reconciling.delete(key); });
  reconciling.set(key, mine); return mine;
}

function admittedCloudProject(settings: KanbanConfig, project: string): boolean {
  const config = settings.projects?.[project]?.cloudRunner;
  return config?.enabled === true && (config.source === "localMirror" || (settings.cloud?.allowedProjects ?? []).includes(project));
}

// This routes an opted-in card to cloud admission even when its project is refused; never fall back locally.
export function cloudExecutionEnabled(task: TaskRow): boolean {
  return task.role === "executor" && parseTags(task.tags).includes("cloud") && ["ready", "rework"].includes(task.status) && loadConfig().projects?.[task.project]?.cloudRunner?.enabled === true;
}

/** Read before the ordinary scheduler's workspace and liveness gates. */
export function cloudQueueReason(task: TaskRow, now = Date.now()): string | null {
  if (!cloudExecutionEnabled(task)) return null;
  const settings = loadConfig();
  const config = settings.projects![task.project].cloudRunner!;
  const refusal = admittedCloudProject(settings, task.project) ? null : t("cloud.projectRefused", { project: task.project });
  // Notice transport/configuration failures must never interrupt scheduling.
  void notifyCloudProjectRefusal(task.project, refusal).catch(() => undefined);
  if (refusal) {
    if (!cloudEvent(task.id, "cloud_project_refused")) {
      addComment(task.id, "scheduler", refusal);
      appendEvent(task.id, "cloud_project_refused", null, null, "scheduler", { reason: refusal });
    }
    return refusal;
  }
  const held = reconcileHold(); if (held) return held;
  const wait = cloudEvent<{ attempts: number; retryAt: number }>(task.id, "cloud_capacity_wait");
  if (wait && wait.attempts >= config.maxCreateAttempts) return t("cloud.capacityLimit");
  if (wait && wait.retryAt > now) return t("cloud.retryAfter", { until: new Date(wait.retryAt).toISOString() });
  return null;
}

type CloudLaunchInput = { task: TaskRow; profile: Profile; profiles: Profile[]; effort: string | null; reason?: string; guard: () => void };
export function launchCloudTask(input: CloudLaunchInput): Promise<{ message: string }> {
  const promise = startCloudTask(input); starting.add(promise);
  void promise.finally(() => starting.delete(promise)).catch(() => undefined);
  return promise;
}
async function startCloudTask(input: CloudLaunchInput): Promise<{ message: string }> {
  const { task, profile } = input;
  if (isCursorChannel(profile)) {
    const reason = t(cursorPaidModel(profile) ? "routing.cursorPaidModel" : "routing.cursorReserved");
    block(task.id, "needs_human", reason); return { message: reason };
  }
  const stopped = () => { const reason = t("cloud.stopping"); setHold(task.id, reason); return { message: reason }; };
  if (stopping) return stopped();
  if (active.has(task.id)) { const reason = t("cloud.cleaning"); setHold(task.id, reason); return { message: reason }; }
  const settings = loadConfig();
  if (!cloudExecutionEnabled(task)) throw new KanbanError("cloud_ineligible", "Cloud execution requires an enabled executor card with the cloud tag");
  const config = parseCloudRunner(task.project, settings.projects![task.project].cloudRunner);
  const wait = cloudQueueReason(task); if (wait) { setHold(task.id, wait); return { message: wait }; }
  if (config.mode !== "per-card") {
    block(task.id, "capability", t("cloud.unimplemented"));
    return { message: getTask(task.id).hold_reason! };
  }
  const provider = profile.provider === "codex" && actualFamily(profile) === "openai" && /^gpt-/i.test(profile.model ?? "") ? "codex"
    : profile.provider === "grok" && actualFamily(profile) === "xai" && /^grok-/i.test(profile.model ?? "") ? "grok" : null;
  if (!provider) { block(task.id, "capability", t("cloud.profileRefused")); return { message: getTask(task.id).hold_reason! }; }
  const local = config.source === "localMirror";
  const registeredRoot = settings.projects![task.project].workspacePath;
  if (local) {
    const contract = readContract(task.contract_json);
    if (contract.kind !== "local-only" || contract.pr) {
      block(task.id, "needs_human", "Local mirror requires a local-only card without remote publication");
      return { message: getTask(task.id).hold_reason! };
    }
    try {
      assertLocalMirrorEligibility({ project: task.project, repoRoot: registeredRoot!, registeredRepoRoot: registeredRoot ?? undefined,
        config, role: task.role, tags: parseTags(task.tags), profile: { ...profile, family: actualFamily(profile) ?? undefined } });
    } catch { block(task.id, "needs_human", "Local mirror eligibility could not be established"); return { message: getTask(task.id).hold_reason! }; }
  }
  const previous = cloudRunRecord(task.id);
  const repo = local ? "" : projectRepository({ project: task.project, workspacePath: previous ? previous.originalPath : task.workspace_path });
  if (!local && !repo) {
    block(task.id, "capability", t("cloud.repositoryRequired")); return { message: getTask(task.id).hold_reason! };
  }
  const scratch = prepareTaskTmpEnv(task, "scheduler").KANBAN_TMP;
  if (!scratch) { block(task.id, "capability", t("cloud.scratchMissing")); return { message: getTask(task.id).hold_reason! }; }
  const run = runtime.run;
  let publicRepo = false;
  try {
    publicRepo = local || await runtime.publicRepository(repo!);
    if (publicRepo && !local) {
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
  catch { const reason = reconcileHold() ?? t("cloud.startupHeld"); setHold(task.id, reason); return { message: reason }; }
  const held = reconcileHold(); if (held) { setHold(task.id, held); return { message: held }; }
  if (stopping) return stopped();
  const generation = (previous?.generation ?? 0) + 1;
  const machine = `${cloudBoardPrefix()}${cardMark(task.id).toLowerCase().replaceAll("_", "-")}-g${generation}`;
  const branch = `kanban/cloud-${createHash("sha256").update(`${dataDir()}:${task.id}:${generation}`).digest("hex").slice(0, 20)}`;
  // A prior null is deliberate: the card may now point at its delivery/review copy.
  const originalPath = settings.projects![task.project].workspacePath ?? (previous ? previous.originalPath : task.workspace_path);
  const originalKind = previous ? previous.originalKind : task.workspace_kind;
  const mirror = join(config.mirrorRoot ?? join(dataDir(), "mirrors"), `${encodeURIComponent(task.project)}.git`);
  let record: CloudRunRecord;
  const db = getDb(); db.exec("BEGIN IMMEDIATE");
  try {
    input.guard();
    const current = getTask(task.id);
    if (current.status !== task.status || current.wait_decision) throw new Error("Cloud start superseded");
    const occupancy = currentOccupancy(input.profiles);
    const cloudTasks = (db.prepare("SELECT id, status, project FROM tasks WHERE status = 'running'").all() as unknown as Array<Pick<TaskRow, "id" | "status" | "project">>).filter(isCloudRunning);
    const globalCloud = cloudSettingsSchema.parse(settings.cloud ?? {});
    const reason = cloudTasks.length >= globalCloud.maxMachines || cloudTasks.filter(row => row.project === task.project).length >= config.maxParallel ? t("cloud.parallelFull")
      : occupancy.global >= settings.concurrency.global ? t("cloud.globalFull")
      : (occupancy.byRole.executor ?? 0) >= roleLimit(settings.concurrency, "executor") ? t("cloud.roleFull")
      : profile.pool && settings.concurrency.pools[profile.pool] != null && (occupancy.byPool[profile.pool] ?? 0) >= settings.concurrency.pools[profile.pool] ? t("cloud.poolFull") : null;
    if (reason) { setHold(task.id, reason); db.exec("COMMIT"); return { message: reason }; }
    const at = new Date().toISOString();
    db.prepare("UPDATE tasks SET status = 'running', agent_id = NULL, executor_agent_id = NULL, executor_profile = ?, executor_family = ?, workspace_kind = 'none', hold_reason = NULL, updated_at = ? WHERE id = ?")
      .run(profile.name, actualFamily(profile), at, task.id);
    const result = db.prepare("INSERT INTO runs (task_id, agent_id, role, profile_name, provider, model, family, auto_accept, thinking_option_id, effort, started_at) VALUES (?, NULL, 'executor', ?, ?, ?, ?, 0, ?, ?, ?)")
      .run(task.id, profile.name, provider, profile.model!, actualFamily(profile), input.effort, input.effort, at);
    record = { generation, machine, branch, repo: repo!, ...(local ? { source: "localMirror", project: task.project, repoRoot: registeredRoot! } : {}), base: settings.projects![task.project].baseBranch, mirror, originalPath, originalKind, runId: Number(result.lastInsertRowid), ownerPid: process.pid };
    appendEvent(task.id, "cloud_run_started", task.status, "running", "scheduler", { ...record, ...(input.reason ? { reason: input.reason } : {}) });
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
  let outcome = "failed"; let delivery: CloudDelivery | null = null; let localDelivery: LocalImport | null = null; let attemptedCreate = false; let capacity = false; let failure = t("cloud.failed");
  let failureKind: "capability" | "needs_human" = "capability";
  const expiresAt = Date.now() + config.taskTimeoutSec * 1000;
  const owned = () => Date.now() < expiresAt && isCloudRunning(getTask(task.id)) && cloudRunRecord(task.id)?.generation === record.generation && !signal.aborted;
  const ensureOwned = () => {
    if (Date.now() >= expiresAt) { outcome = "timeout"; controller.abort(); }
    if (!owned()) throw new Error("Cloud generation cancelled");
  };
  const poll = setInterval(() => { if (!owned()) controller.abort(); }, 100);
  const deadline = setTimeout(() => { outcome = "timeout"; controller.abort(); }, config.taskTimeoutSec * 1000);
  const command = async (file: string, args: string[], extra: Partial<CloudCommandOptions> = {}) => {
    ensureOwned();
    const result = await run(file, args, { env, signal, timeoutMs: Math.max(1, expiresAt - Date.now()), ...extra });
    ensureOwned(); return result;
  };
  const remote = (script: string) => {
    const line = encodedCloudCommand(`${cloudScratchScript(cardMark(task.id))}\n${script}`);
    if (record.source === "localMirror" && Buffer.byteLength(line) > 61_440) throw new Error("Cloud command exceeds limit");
    return command("instabox", ["exec", record.machine, "--", line]);
  };
  const bundle = join(scratch, `task-g${record.generation}.bundle`);
  const body = join(scratch, `pr-g${record.generation}.md`);
  let localScratch: string | undefined;
  const gitLocal = localGit(run, scratch, signal, ensureOwned);
  // Preserve the transfer's own fresh cleanup signal; never wrap this adapter with ensureOwned.
  const transferCommand: CloudCommand = (file, args, options) => run(file, args, { ...options, env: hostEnv(scratch) });
  const localEligibility = () => {
    const current = getTask(task.id); const project = loadConfig().projects?.[task.project];
    assertLocalMirrorEligibility({ project: task.project, repoRoot: record.repoRoot!, registeredRepoRoot: project?.workspacePath ?? undefined,
      config: parseCloudRunner(task.project, project?.cloudRunner), role: current.role, tags: parseTags(current.tags),
      profile: { ...profile, family: actualFamily(profile) ?? undefined } });
    const contract = readContract(current.contract_json);
    if (contract.kind !== "local-only" || contract.pr) throw new KanbanError("cloud_local_mirror_refused", "Local cloud contract changed during execution");
  };
  const remotePath = (name: string) => `$HOME/work/.kanban-work/${cardMark(task.id)}/${name}`;
  try {
    let snapshot: ReturnType<typeof createSourceSnapshot> | undefined;
    const feedback = record.source === "localMirror" ? localCloudFeedback(task.id) : task.status === "rework" ? latestChangeNote(task.id) : "";
    const brief = task.brief || task.title;
    if (record.source === "localMirror") {
      localEligibility();
      if (!refOk(record.base)) throw new Error("Invalid local base");
      const prior = localCloudReceipt(task.id);
      const sourceBase = prior ? prior.localHead : (await gitLocal(record.repoRoot!, ["rev-parse", "--verify", `refs/heads/${record.base}^{commit}`])).trim();
      if (prior && (prior.repoRoot !== record.repoRoot || prior.project !== task.project || prior.generation >= record.generation)) throw new KanbanError("cloud_local_mirror_refused", "Local cloud source mapping no longer belongs to this project");
      await localDeliveryWorktree(task.id, record.repoRoot!, record.base, sourceBase, gitLocal, !prior);
      ensureOwned();
      localScratch = mkdtempSync(join(scratch, `local-g${record.generation}-`));
      const sourceScratch = join(localScratch, "source"); mkdirSync(sourceScratch, { mode: 0o700 });
      snapshot = createSourceSnapshot({ repoRoot: record.repoRoot!, baseCommit: sourceBase, scratchDir: sourceScratch });
      const findings = scanOutbound({ repoRoot: record.repoRoot!, tree: snapshot.tree, brief, feedback,
        environment: { ...config.environment, ":execution-settings": JSON.stringify({ installCommand: config.installCommand, testCommand: config.testCommand,
          directories: config.directories, runtime: config.runtime, nodeVersion: config.nodeVersion, bunVersion: config.bunVersion, bunSha256: config.bunSha256, installBun: config.installBun, provider, model: profile.model, effort: input.effort, snapshot: config.snapshot }) } });
      if (findings.length) {
        failureKind = "needs_human"; failure = `Local cloud outbound scan blocked: ${[...new Set(findings.map(hit => `${hit.scope}:${hit.rule}`))].join(", ")}`;
        throw new Error("outbound privacy");
      }
      if (snapshot.bytes > config.maxSourceBytes) throw new KanbanError("cloud_transfer_too_large", "Local cloud source exceeds the configured size limit");
      ensureOwned(); Object.assign(record, { sourceBase, snapshotCommit: snapshot.snapshotCommit, tree: snapshot.tree });
      // The host stamps the exact scanned mapping before the first possible machine creation/upload.
      appendEvent(task.id, "cloud_run_started", null, "running", "scheduler", { ...record });
    }
    if (snapshot) localEligibility();
    ensureOwned(); attemptedCreate = true;
    const create = await command("instabox", ["create", "--name", record.machine, "--snapshot", config.snapshot, "--auto-suspend", "0", "--timeout", `${config.machineTimeoutSec}s`, "--on-timeout", "kill"]);
    // InstaBox documents quota_exceeded for account limits; only creation failures enter this queue.
    if (!create.truncated && create.code !== 0 && /\b(?:no_capacity|quota_exceeded)\b/i.test(`${create.stdout}\n${create.stderr}`)) { capacity = true; outcome = "no_capacity"; return; }
    checked(create, "create");
    checked(await command("instabox", ["get", record.machine]), "machine readiness");
    const previous = cloudDelivery(task.id);
    const source = task.status === "rework" && previous ? previous.branch : record.base;
    if (snapshot) {
      localEligibility(); ensureOwned();
      const uploaded = await uploadFile({ machine: record.machine, localPath: snapshot.bundlePath, remotePath: remotePath("source.bundle"), exec: transferCommand, signal, maxBytes: config.maxSourceBytes });
      if (uploaded.bytes !== snapshot.bytes || uploaded.sha256 !== snapshot.sha256) throw new Error("Cloud source changed during upload");
      ensureOwned();
    }
    const result = await remote(cloudTaskScript({ repo: record.repo, branch: record.branch, base: record.base, source,
      localSnapshot: snapshot?.snapshotCommit, provider, model: profile.model!, effort: input.effort, prompt: `${brief}${feedback ? `\nReview feedback:\n${feedback}` : ""}`, timeoutSec: config.taskTimeoutSec,
      installCommand: config.installCommand, testCommand: config.testCommand, directories: config.directories,
      runtime: config.runtime, nodeVersion: config.nodeVersion, bunVersion: config.bunVersion, bunSha256: config.bunSha256, installBun: config.installBun, environment: config.environment }));
    if (result.truncated) throw new Error("Cloud task receipt truncated");
    if (result.code !== 0) {
      if (provider === "grok" && /(?:PKB_GROK_LOGIN_EXPIRED|not (?:logged|signed) in|not authenticated|unauthenticated|authentication (?:expired|required|failed)|(?:login|session|token|credential)[^\n]{0,80}(?:expired|invalid)|(?:please|run)[^\n]{0,40}grok login|\b401\b)/i.test(`${result.stdout}\n${result.stderr}`)) {
        failure = t("cloud.grokExpired", { snapshot: config.snapshot });
      } else {
        const runtimeFailure = result.stdout.match(/^PKB_RUNTIME_FAILURE=(node version mismatch or missing; expected [0-9.]+|bun version mismatch or missing; expected [0-9.]+|bun installation failed)$/m)?.[1];
        failure = runtimeFailure ?? t("cloud.validationFailed", { code: result.code });
      }
      return;
    }
    if (/^PKB_NO_CHANGES$/m.test(result.stdout)) { failure = t("cloud.noChanges"); return; }
    const baseHead = result.stdout.match(/^PKB_BASE=([0-9a-f]{40,64})$/m)?.[1];
    const head = result.stdout.match(/^PKB_HEAD=([0-9a-f]{40,64})$/m)?.[1];
    if (!baseHead || !head || !/^PKB_TEST_OK$/m.test(result.stdout)) throw new Error("Cloud test receipt missing");
    if (snapshot) {
      if (baseHead !== snapshot.snapshotCommit) throw new Error("Cloud snapshot base mismatch");
      const resultTree = result.stdout.match(/^PKB_TREE=([0-9a-f]{40,64})$/m)?.[1];
      if (!resultTree) throw new Error("Cloud result tree receipt missing");
      await downloadFile({ machine: record.machine, remotePath: remotePath("task.bundle"), localPath: bundle, exec: transferCommand, signal, maxBytes: config.maxResultBytes });
      ensureOwned();
      const isolated = join(localScratch!, "result.git");
      const verified = await verifyLocalResult({ record: record as LocalMapping, sourceBundle: snapshot.bundlePath, resultBundle: bundle,
        head, resultTree, maxBytes: config.maxResultBytes, isolated, git: gitLocal });
      ensureOwned();
      localDelivery = await prepareLocalImport({ id: task.id, record: record as LocalMapping, isolated, head, resultTree: verified.tree, files: verified.files, git: gitLocal,
        verification: cloudDirectoryVerification(config, result.stdout) });
      ensureOwned(); outcome = "success"; return;
    }
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
      writeFileSync(body, cloudDraftPrBody(config, provider, result.stdout), { flag: "wx", mode: 0o600 });
      const pr = checked(await command("gh", ["pr", "create", "--repo", record.repo, "--draft", "--head", record.branch, "--base", record.base, "--title", "Implement cloud task", "--body-file", body]), "draft PR").trim();
      if (!new RegExp(`^https://github\\.com/${record.repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/pull/\\d+$`).test(pr)) throw new Error("Cloud draft PR receipt invalid");
      const receipt = { ...record, head, baseHead, pr, files, verification: cloudDirectoryVerification(config, result.stdout) };
      appendEvent(task.id, "cloud_pr_created", null, null, "scheduler", receipt);
      return receipt;
    });
    outcome = "success";
  } catch (error) {
    if (error instanceof KanbanError) {
      if (error.code === "cloud_local_privacy" || error.code === "cloud_local_mirror_refused") { failureKind = "needs_human"; failure = error.message; }
      appendEvent(task.id, "cloud_stage_failed", null, null, "scheduler", { generation: record.generation, code: error.code,
        cleanupFailed: error.details?.cleanupFailed === true, localCleanupFailed: error.details?.localCleanupFailed === true });
    }
    // Only bounded, category-level diagnostics reach board events.
  }
  finally {
    clearInterval(poll); clearTimeout(deadline);
    const removed = !attemptedCreate || await removeMachine(record.machine, run, env).catch(() => false);
    rmSync(bundle, { force: true }); rmSync(body, { force: true });
    if (localScratch) rmSync(localScratch, { recursive: true, force: true });
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
      } else if (localDelivery && outcome === "success" && !signal.aborted && !item.stopping) {
        submitLocalDelivery(task.id, localDelivery);
      } else if (delivery && outcome === "success" && !signal.aborted && !item.stopping) {
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
  if (bindings++ === 0) bindingReady = stopCloudRuns().then(() => { stopping = false; reconciled.clear(); reconcileFailures.clear(); });
  let released = false;
  return { ready: bindingReady, async release() {
    if (released) return; released = true;
    if (--bindings === 0) { await bindingReady; if (bindings === 0) await stopCloudRuns(); }
  } };
}
