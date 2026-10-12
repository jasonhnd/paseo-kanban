/// <reference types="node" />
import { t } from "../shared/i18n";
import { existsSync } from "./perf-fs";
import { nextRetryAt, retryReady, type CleanupRecord } from "./archive-book";
import { projectWorkspace } from "./config";
import { getDb } from "./db";
import { KanbanError } from "./errors";
import { deleteSquashedBranch, resolveWorktreeBase, runGit, type GitRunner } from "./git";
import { pickWorkspace, samePath, type ListedWorkspace } from "./placement";
import { prHeadOid, prMergeState, readContract } from "./pr";
import { cardMark } from "./card-ref";
import { appendEvent, type TaskRow } from "./store";
import { laneBranchName, laneName } from "./workspace";

export interface LaneBinding {
  lane: string;
  directory: string;
  workspaceId?: string | null;
  name?: string | null;
  branch: string;
  base: string;
  root: string;
  ref?: string;
}

interface LaneUse {
  taskId: number;
  status: string;
  contractJson: string | null;
  binding: LaneBinding;
}

const laneLocks = new Map<string, Promise<void>>();

export function resetLaneLocksForTests(): void {
  laneLocks.clear();
}

async function withLaneLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = laneLocks.get(key) ?? Promise.resolve();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => gate);
  laneLocks.set(key, tail);
  await previous.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    if (laneLocks.get(key) === tail) laneLocks.delete(key);
  }
}

function parseBinding(raw: string): LaneBinding | null {
  try {
    const data = JSON.parse(raw) as Partial<LaneBinding>;
    if (!data.lane || !data.directory || !data.branch || !data.root) return null;
    return {
      lane: data.lane,
      directory: data.directory,
      workspaceId: data.workspaceId ?? null,
      name: data.name ?? null,
      branch: data.branch,
      base: data.base?.trim() || "main",
      root: data.root,
      ref: data.ref,
    };
  } catch {
    return null;
  }
}

export function laneBinding(taskId: number): LaneBinding | null {
  const row = getDb()
    .prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'lane_bound' ORDER BY id DESC LIMIT 1")
    .get(taskId) as { data_json: string } | undefined;
  if (!row) return null;
  return parseBinding(row.data_json);
}

function latestLaneUses(project: string, root: string): Map<string, LaneUse> {
  const rows = getDb()
    .prepare(
      `SELECT t.id AS task_id, t.status, t.contract_json, e.data_json
       FROM events e JOIN tasks t ON t.id = e.task_id
       WHERE e.kind = 'lane_bound' AND t.project = ?
       ORDER BY e.id DESC`,
    )
    .all(project) as unknown as Array<{ task_id: number; status: string; contract_json: string | null; data_json: string }>;
  const found = new Map<string, LaneUse>();
  for (const row of rows) {
    const binding = parseBinding(row.data_json);
    if (!binding || !samePath(binding.root, root) || found.has(binding.lane)) continue;
    found.set(binding.lane, { taskId: row.task_id, status: row.status, contractJson: row.contract_json, binding });
  }
  return found;
}

function occupies(status: string): boolean {
  return status !== "done" && status !== "archived";
}

function holdText(lane: string, kind: "busy" | "dirty" | "unpushed", taskId: number, branch?: string): string {
  if (kind === "busy") return t("lane.busy", { lane, card: cardMark(taskId) });
  const who = branch ? t("lane.prevWithBranch", { card: cardMark(taskId), branch }) : t("lane.prev", { card: cardMark(taskId) });
  if (kind === "dirty") return t("lane.dirty", { lane, who });
  return t("lane.unpushed", { lane, who });
}

function worktreePathForBranch(stdout: string, branch: string): string | null {
  let directory: string | null = null;
  for (const line of stdout.split(/\n/)) {
    if (line.startsWith("worktree ")) directory = line.slice("worktree ".length).trim();
    else if (line === `branch refs/heads/${branch}` && directory) return directory;
  }
  return null;
}

function failure(result: { stdout: string; stderr: string }, fallback: string): string {
  return (result.stderr || result.stdout || fallback).trim();
}

async function workingTreeDirty(directory: string, run: GitRunner): Promise<{ dirty: boolean } | { error: string }> {
  const status = await run(directory, ["status", "--porcelain"]);
  if (status.code !== 0) return { error: failure(status, t("lane.gitFailed", { command: "git status" })) };
  return { dirty: status.stdout.trim().length > 0 };
}

/**
 * The previous card's branch can be left behind when it is merged into base,
 * or when the PR contract says it was pushed (the remote has the tip, or the PR is merged).
 * A local-only repo with no origin has nothing to push; a clean tree is enough.
 */
async function branchDelivered(use: LaneUse, run: GitRunner): Promise<"ok" | "unpushed" | { error: string }> {
  const { binding } = use;
  const listed = await run(binding.directory, ["rev-parse", "--verify", `refs/heads/${binding.branch}`]);
  if (listed.code !== 0) return "ok";
  const ancestor = await run(binding.directory, ["merge-base", "--is-ancestor", binding.branch, binding.base]);
  if (ancestor.code === 0) return "ok";
  // Exit codes other than 0 or 1 (a missing local base, for example) are not an ancestor.
  // Keep going: a merged PR or an origin tip still counts. No origin uses the local rule below.
  const contract = readContract(use.contractJson);
  if (contract.pr) {
    const merge = await prMergeState(contract.pr);
    if (merge.merged) return "ok";
  }
  const remotes = await run(binding.directory, ["remote"]);
  const hasOrigin = remotes.code === 0 && remotes.stdout.split(/\r?\n/).some((line) => line.trim() === "origin");
  if (hasOrigin) {
    const remote = await run(binding.directory, ["rev-parse", "--verify", `refs/remotes/origin/${binding.branch}`]);
    if (remote.code === 0) {
      const local = listed.stdout.trim();
      const contains = await run(binding.directory, ["merge-base", "--is-ancestor", local, remote.stdout.trim()]);
      if (contains.code === 0) return "ok";
    }
  }
  if (!hasOrigin && contract.kind !== "github") return "ok";
  return "unpushed";
}

async function findLaneDirectory(
  root: string,
  lane: string,
  remembered: LaneBinding | undefined,
  listed: ListedWorkspace[],
  run: GitRunner,
): Promise<{ directory: string; workspaceId?: string | null; name?: string | null } | null> {
  if (remembered?.directory && existsSync(remembered.directory)) {
    return { directory: remembered.directory, workspaceId: remembered.workspaceId, name: remembered.name ?? lane };
  }
  const named = listed.find(
    (entry) => !entry.archived && entry.name === lane && samePath(entry.projectRoot, root) && entry.directory && existsSync(entry.directory),
  );
  if (named?.directory) return { directory: named.directory, workspaceId: named.id, name: named.name ?? lane };
  const porcelain = await run(root, ["worktree", "list", "--porcelain"]);
  if (porcelain.code !== 0) return null;
  const directory = worktreePathForBranch(porcelain.stdout, lane);
  if (!directory || !existsSync(directory)) return null;
  const hit = listed.find((entry) => !entry.archived && samePath(entry.directory, directory));
  return { directory, workspaceId: hit?.id, name: hit?.name ?? lane };
}

export async function placeLane(
  task: TaskRow,
  launcher: {
    listWorkspaces?: () => Promise<ListedWorkspace[]>;
    createWorktree?: (options: { cwd: string; branchName: string; baseBranch: string; projectId?: string | null }) => Promise<{
      directory: string;
      workspaceId?: string;
      name?: string | null;
    }>;
  },
  run: GitRunner = runGit,
): Promise<{ cwd: string; workspaceId?: string; name?: string | null } | { hold: string }> {
  const saved = laneBinding(task.id);
  if (saved?.directory) {
    if (!existsSync(saved.directory)) {
      return { hold: t("lane.cwdMissingNoAgent", { path: saved.directory }) };
    }
    return { cwd: saved.directory, workspaceId: saved.workspaceId ?? undefined, name: saved.name ?? saved.lane };
  }
  const root = task.workspace_path;
  if (!root || root === "lane") return { hold: t("lane.needsRepo") };
  return withLaneLock(`${task.project}\0${root}`, () => claimLane(task, root, launcher, run));
}

async function claimLane(
  task: TaskRow,
  root: string,
  launcher: {
    listWorkspaces?: () => Promise<ListedWorkspace[]>;
    createWorktree?: (options: { cwd: string; branchName: string; baseBranch: string; projectId?: string | null }) => Promise<{
      directory: string;
      workspaceId?: string;
      name?: string | null;
    }>;
  },
  run: GitRunner,
): Promise<{ cwd: string; workspaceId?: string; name?: string | null } | { hold: string }> {
  const again = laneBinding(task.id);
  if (again?.directory && existsSync(again.directory)) {
    return { cwd: again.directory, workspaceId: again.workspaceId ?? undefined, name: again.name ?? again.lane };
  }
  const settings = projectWorkspace(task.project);
  const base = task.workspace_base || settings.baseBranch || "main";
  const uses = latestLaneUses(task.project, root);
  const blocks: string[] = [];
  let chosen: number | null = null;
  for (let index = 1; index <= settings.worktreeLanes; index += 1) {
    const lane = laneName(index);
    const use = uses.get(lane);
    if (!use || use.taskId === task.id) {
      chosen = index;
      break;
    }
    if (occupies(use.status)) {
      blocks.push(holdText(lane, "busy", use.taskId));
      continue;
    }
    if (!use.binding.directory || !existsSync(use.binding.directory)) {
      chosen = index;
      break;
    }
    const dirty = await workingTreeDirty(use.binding.directory, run);
    if ("error" in dirty) {
      blocks.push(t("lane.cannotReadWorktree", { lane, error: dirty.error }));
      continue;
    }
    if (dirty.dirty) {
      blocks.push(holdText(lane, "dirty", use.taskId, use.binding.branch));
      continue;
    }
    const delivered = await branchDelivered(use, run);
    if (delivered === "unpushed") {
      blocks.push(holdText(lane, "unpushed", use.taskId, use.binding.branch));
      continue;
    }
    if (delivered !== "ok") {
      blocks.push(t("lane.cannotReadBranch", { lane, error: delivered.error }));
      continue;
    }
    chosen = index;
    break;
  }
  if (chosen == null) return { hold: blocks.join(t("common.semicolon")) || t("lane.noFreeLane") };
  const lane = laneName(chosen);
  const resolved = await resolveWorktreeBase(root, base, run);
  if ("error" in resolved) throw new KanbanError("fetch_failed", resolved.error);
  const listed = launcher.listWorkspaces ? await launcher.listWorkspaces() : [];
  const remembered = uses.get(lane)?.binding;
  let directory = (await findLaneDirectory(root, lane, remembered, listed, run)) ?? null;
  if (!directory) {
    if (!launcher.createWorktree) throw new KanbanError("workspace_missing", t("lane.noCreateWorktree"));
    const main = pickWorkspace(listed, root);
    const created = await launcher.createWorktree({
      cwd: root,
      branchName: lane,
      baseBranch: resolved.ref,
      projectId: main?.projectId,
    });
    if (!created.directory || !existsSync(created.directory)) {
      throw new KanbanError("workspace_missing", t("lane.createdNoDirectory"));
    }
    directory = { directory: created.directory, workspaceId: created.workspaceId, name: created.name ?? lane };
  }
  const branch = laneBranchName(task.id, task.title);
  // checkout -B resets the branch and overwrites tracked files; never do that over someone's unsaved work.
  const dirty = await run(directory.directory, ["status", "--porcelain"]);
  if (dirty.code !== 0) throw new KanbanError("start_failed", failure(dirty, t("lane.gitFailed", { command: "git status" })));
  if (dirty.stdout.trim()) throw new KanbanError("start_failed", t("lane.dirtyNoSwitch", { lane, files: dirty.stdout.trim().split("\n").slice(0, 3).join(t("common.semicolon")) }));
  const switched = await run(directory.directory, ["checkout", "-B", branch, resolved.ref]);
  if (switched.code !== 0) throw new KanbanError("start_failed", failure(switched, t("lane.gitFailed", { command: "git checkout" })));
  appendEvent(task.id, "lane_bound", null, null, "scheduler", {
    lane,
    directory: directory.directory,
    workspaceId: directory.workspaceId ?? null,
    name: directory.name ?? lane,
    branch,
    base,
    ref: resolved.ref,
    root,
  });
  getDb().prepare("UPDATE tasks SET workspace_path = ?, updated_at = ? WHERE id = ?").run(directory.directory, new Date().toISOString(), task.id);
  return { cwd: directory.directory, workspaceId: directory.workspaceId ?? undefined, name: directory.name ?? lane };
}

function remoteHasOrigin(stdout: string): boolean {
  return stdout.split(/\r?\n/).some((line) => line.trim() === "origin");
}

async function laneMerged(task: TaskRow, binding: LaneBinding, run: GitRunner): Promise<"go" | "not_merged" | { error: string }> {
  const contract = readContract(task.contract_json);
  if (contract.pr) {
    const merge = await prMergeState(contract.pr);
    if (merge.error) return { error: merge.error };
    return merge.merged ? "go" : "not_merged";
  }
  if (contract.kind === "github") return "not_merged";
  const remotes = await run(binding.root, ["remote"]);
  if (remotes.code !== 0) return { error: failure(remotes, t("lane.gitFailed", { command: "git remote" })) };
  if (remoteHasOrigin(remotes.stdout)) return "not_merged";
  const ancestor = await run(binding.root, ["merge-base", "--is-ancestor", binding.branch, binding.base]);
  if (ancestor.code === 0) return "go";
  if (ancestor.code === 1) return "not_merged";
  return { error: failure(ancestor, t("lane.gitFailed", { command: "merge-base" })) };
}

async function deleteLaneBranch(task: TaskRow, binding: LaneBinding, run: GitRunner, force?: GitRunner): Promise<string | null> {
  const listed = await run(binding.root, ["branch", "--list", binding.branch]);
  if (listed.code !== 0) return failure(listed, t("lane.gitFailed", { command: "git branch --list" }));
  if (!listed.stdout.trim()) return null;
  if (existsSync(binding.directory)) {
    const head = await run(binding.directory, ["rev-parse", "--abbrev-ref", "HEAD"]);
    if (head.code === 0 && head.stdout.trim() === binding.branch) {
      const status = await run(binding.directory, ["status", "--porcelain"]);
      if (status.code !== 0) return failure(status, t("lane.gitFailed", { command: "git status" }));
      if (status.stdout.trim()) return t("lane.uncommitted");
      const back = await run(binding.directory, ["checkout", binding.lane]);
      if (back.code !== 0) return failure(back, t("lane.gitFailed", { command: "git checkout" }));
    }
  }
  const deleted = await run(binding.root, ["branch", "-d", binding.branch]);
  if (deleted.code === 0) return null;
  const plain = failure(deleted, t("lane.gitFailed", { command: "git branch -d" }));
  const pr = readContract(task.contract_json).pr;
  if (!pr) return `${plain}${t("lane.noForce", { reason: t("lane.noPr") })}`;
  const merge = await prMergeState(pr);
  if (merge.error || !merge.merged) return `${plain}${t("lane.noForce", { reason: merge.error || t("lane.prNotMerged") })}`;
  const head = await prHeadOid(pr);
  if ("error" in head) return `${plain}${t("lane.noForce", { reason: head.error })}`;
  const local = await run(binding.root, ["rev-parse", "--verify", `refs/heads/${binding.branch}`]);
  if (local.code !== 0 || local.stdout.trim().toLowerCase() !== head.oid) return `${plain}${t("lane.noForce", { reason: t("lane.localAhead") })}`;
  const forced = await deleteSquashedBranch(binding.root, task.id, binding.branch, force);
  if (forced.code !== 0) return failure(forced, t("lane.gitFailed", { command: "git branch -D" }));
  return null;
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | "timeout" | Error> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve("timeout"), ms);
    (timer as unknown as { unref?: () => void }).unref?.();
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        resolve(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/**
 * Delete the card branch after it is merged. Never removes the lane directory
 * and never archives the lane workspace.
 */
export async function settleLaneBranch(input: {
  task: TaskRow;
  events: CleanupRecord[];
  now: Date;
  timeoutMs: number;
  record: (data: Omit<CleanupRecord, "at">) => void;
  run?: GitRunner;
}): Promise<"settled" | "pending"> {
  const binding = laneBinding(input.task.id);
  if (!binding) {
    if (!input.events.some((event) => event.action === "skip_lane" && event.ok === true && event.reason === "not_ours")) {
      input.record({ action: "skip_lane", ok: true, reason: "not_ours" });
    }
    return "settled";
  }
  if (input.events.some((event) => event.action === "delete_lane_branch" && event.ok === true && event.branch === binding.branch)) return "settled";
  if (!retryReady(input.events, "delete_lane_branch", binding.directory, input.now)) return "pending";
  const run = input.run ?? runGit;
  const recordDeleteFailure = (outcome: "timeout" | "error", error: string) => {
    input.record({
      action: "delete_lane_branch",
      directory: binding.directory,
      branch: binding.branch,
      ok: false,
      outcome,
      error,
      retryAt: nextRetryAt(input.events, "delete_lane_branch", binding.directory, input.now),
    });
  };
  const job = (async (): Promise<"settled" | "pending" | { error: string }> => {
    const gate = await laneMerged(input.task, binding, run);
    if (gate === "not_merged") return "pending";
    if (gate !== "go") return { error: gate.error };
    const error = await withLaneLock(`${input.task.project}\0${binding.root}`, () =>
      deleteLaneBranch(input.task, binding, run, input.run),
    );
    if (error) return { error };
    return "settled";
  })();
  const result = await withTimeout(job, input.timeoutMs);
  if (result === "timeout") {
    recordDeleteFailure("timeout", t("lane.timeout"));
    return "pending";
  }
  if (result instanceof Error) {
    recordDeleteFailure("error", result.message);
    return "pending";
  }
  if (result === "pending") {
    const previous = [...input.events].reverse().find((event) => event.action === "skip_lane" && event.reason === "not_merged" && event.branch === binding.branch);
    if (!previous) {
      input.record({
        action: "skip_lane",
        directory: binding.directory,
        branch: binding.branch,
        ok: false,
        reason: "not_merged",
      });
    }
    return "pending";
  }
  if (typeof result === "object") {
    recordDeleteFailure("error", result.error);
    return "pending";
  }
  input.record({ action: "delete_lane_branch", directory: binding.directory, branch: binding.branch, ok: true });
  return "settled";
}

/** False once the lane branch is deleted, this card never had a lane, or a failed delete is still backing off. The directory stays. */
export function laneBranchDue(taskId: number, events: CleanupRecord[], now: Date): boolean {
  if (events.some((event) => event.action === "delete_lane_branch" && event.ok === true)) return false;
  if (events.some((event) => event.action === "skip_lane" && event.ok === true && event.reason === "not_ours")) return false;
  const directory =
    laneBinding(taskId)?.directory ?? [...events].reverse().find((event) => event.action === "delete_lane_branch")?.directory;
  if (!directory) return true;
  return retryReady(events, "delete_lane_branch", directory, now);
}
