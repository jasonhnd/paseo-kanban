/// <reference types="node" />
import { isAbsolute } from "node:path";
import { t } from "../shared/i18n";
import { existsSync } from "./perf-fs";
import { getDb } from "./db";
import { refOk, runGit, type GitRunner } from "./git";
import { samePath } from "./placement";
import { cloudRunRecord, isCloudRunning } from "./cloud-record";
import { holdsStartClaim } from "./start-claim";
import { branchOwnedByCard } from "./workspace";
import { deleteReadOnlyBranch, readOnlyBranchName, readOnlyCopyError } from "./readonly-worktree";

export interface WorktreeRecord {
  directory?: string;
  branch?: string;
  base?: string;
  root?: string;
  workspaceId?: string | null;
  name?: string | null;
  discarded?: boolean;
  readOnly?: boolean;
  head?: string;
}

export interface RivalWorktree {
  directory: string;
  branch: string;
  root: string;
  base: string;
  workspaceId: string | null;
  readOnly?: boolean;
  head?: string;
}

function asRecord(value: string): WorktreeRecord | null {
  try {
    const data = JSON.parse(value) as WorktreeRecord;
    if (!data || typeof data !== "object") return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * The worktree this card should use. A discarded copy never counts.
 * Prefer the event whose workspaceId is tasks.paseo_workspace_id; otherwise the newest one.
 */
export function readWorktreeCreated(taskId: number, workspaceId?: string | null): WorktreeRecord | null {
  const db = getDb();
  const preferred =
    workspaceId === undefined
      ? (db.prepare("SELECT paseo_workspace_id FROM tasks WHERE id = ?").get(taskId) as { paseo_workspace_id: string | null } | undefined)
          ?.paseo_workspace_id
      : workspaceId;
  const rows = db.prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'worktree_created' ORDER BY id DESC").all(taskId) as Array<{
    data_json: string;
  }>;
  const usable: WorktreeRecord[] = [];
  for (const row of rows) {
    const data = asRecord(row.data_json);
    if (!data || data.discarded === true) continue;
    usable.push(data);
  }
  if (preferred) {
    const match = usable.find((item) => item.workspaceId && item.workspaceId === preferred);
    if (match) return match;
  }
  return usable[0] ?? null;
}

function rivalFrom(data: WorktreeRecord): RivalWorktree | null {
  if (!data.directory) return null;
  return {
    directory: data.directory,
    branch: data.branch ?? "",
    root: data.root ?? "",
    base: data.base ?? "",
    workspaceId: data.workspaceId ?? null,
    readOnly: data.readOnly,
    head: data.head,
  };
}

export interface WorktreeWrite {
  taskId: number;
  token: string;
  directory: string;
  data: Record<string, unknown>;
  temp: { base: string; actor: string; holderId: number | null; code: string; root: string; directory: string } | null;
}

function sameDirectory(left: string | undefined, right: string): boolean {
  return Boolean(left && samePath(left, right));
}

/**
 * Record this process's worktree only while it still holds the start claim.
 * Another directory already stored is returned so the caller can remove that copy.
 * Its event stays visible until that removal succeeds.
 */
export function commitWorktree(input: WorktreeWrite): ReturnType<typeof writeWorktree> {
  return writeWorktree(input, () => holdsStartClaim(input.taskId, input.token));
}

/** A cloud worker has outlived its start claim; only its current running generation may register a delivery. */
export function commitCloudWorktree(input: Omit<WorktreeWrite, "token"> & { runId: number; generation: number }): ReturnType<typeof writeWorktree> {
  return writeWorktree(input, () => {
    const record = cloudRunRecord(input.taskId);
    return record?.source === "localMirror" && record.runId === input.runId && record.generation === input.generation &&
      isCloudRunning({ id: input.taskId, status: "running" }) &&
      (getDb().prepare("SELECT status FROM tasks WHERE id = ?").get(input.taskId) as { status: string })?.status === "running";
  });
}
function writeWorktree(input: Omit<WorktreeWrite, "token">, authorized: () => boolean): { ok: true; intruders: RivalWorktree[] } | { ok: false } {
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    if (!authorized()) {
      db.exec("ROLLBACK");
      return { ok: false };
    }
    const rows = db
      .prepare("SELECT id, data_json FROM events WHERE task_id = ? AND kind = 'worktree_created' ORDER BY id")
      .all(input.taskId) as Array<{ id: number; data_json: string }>;
    const intruders: RivalWorktree[] = [];
    let haveOurs = false;
    const stamp = new Date().toISOString();
    for (const row of rows) {
      const data = asRecord(row.data_json);
      if (!data || data.discarded === true) continue;
      if (sameDirectory(data.directory, input.directory)) {
        haveOurs = true;
        continue;
      }
      const rival = rivalFrom(data);
      if (rival) intruders.push(rival);
    }
    if (!haveOurs) {
      db.prepare("INSERT INTO events (task_id, at, kind, from_status, to_status, actor, data_json) VALUES (?, ?, 'worktree_created', NULL, NULL, 'scheduler', ?)").run(
        input.taskId,
        stamp,
        JSON.stringify(input.data),
      );
    }
    const temps = db
      .prepare("SELECT id, data_json FROM events WHERE task_id = ? AND kind = 'temp_workspace' ORDER BY id")
      .all(input.taskId) as Array<{ id: number; data_json: string }>;
    let keptTemp = false;
    for (const row of temps) {
      const data = asRecord(row.data_json);
      if (!data || data.discarded === true) continue;
      if (data.directory && !sameDirectory(data.directory, input.directory)) continue;
      keptTemp = true;
    }
    if (input.temp) {
      db.prepare("UPDATE tasks SET workspace_path = ?, workspace_kind = 'worktree', workspace_base = ?, updated_at = ? WHERE id = ?").run(
        input.directory,
        input.temp.base,
        stamp,
        input.taskId,
      );
      if (!keptTemp) {
        db.prepare("INSERT INTO events (task_id, at, kind, from_status, to_status, actor, data_json) VALUES (?, ?, 'temp_workspace', NULL, NULL, ?, ?)").run(
          input.taskId,
          stamp,
          input.temp.actor,
          JSON.stringify({
            name: input.temp.code,
            root: input.temp.root,
            base: input.temp.base,
            ...(input.temp.holderId != null ? { holder: input.temp.holderId } : {}),
            directory: input.temp.directory,
          }),
        );
      }
    } else {
      db.prepare("UPDATE tasks SET workspace_path = ?, updated_at = ? WHERE id = ?").run(input.directory, stamp, input.taskId);
    }
    db.exec("COMMIT");
    return { ok: true, intruders };
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // The transaction is already closed.
    }
    throw err;
  }
}

/** Hide events for a directory only after that copy was archived or its empty branch was deleted. */
export function settleRivalRecord(taskId: number, directory: string, result: DiscardResult): void {
  if (result.skipped || (!result.archived && !result.removedBranch)) return;
  discardRecordedWorktree(taskId, directory);
}

export function discardRecordedWorktree(taskId: number, directory: string): void {
  const db = getDb();
  for (const kind of ["worktree_created", "temp_workspace"]) {
    const rows = db.prepare("SELECT id, data_json FROM events WHERE task_id = ? AND kind = ? ORDER BY id").all(taskId, kind) as Array<{
      id: number;
      data_json: string;
    }>;
    for (const row of rows) {
      const data = asRecord(row.data_json);
      if (!data || data.discarded === true || !sameDirectory(data.directory, directory)) continue;
      db.prepare("UPDATE events SET data_json = ? WHERE id = ?").run(JSON.stringify({ ...data, discarded: true }), row.id);
    }
  }
}

export interface DiscardResult {
  archived: boolean;
  removedBranch: boolean;
  skipped?: string;
}

/**
 * Put away a worktree this start does not get to keep.
 * Archive and delete the branch only when it has no live agent and no commits.
 */
export async function discardFreshWorktree(input: {
  taskId: number;
  directory: string;
  branch: string;
  root: string;
  base: string;
  workspaceId?: string | null;
  /** True when this call created the workspace and has not opened an agent in it. */
  assumeNoAgent?: boolean;
  listAgents?: (workspaceId: string) => Promise<Array<{ id: string; archived: boolean }>>;
  archiveWorkspace?: (workspaceId: string) => Promise<void>;
  run?: GitRunner;
  readOnly?: boolean;
  head?: string;
}): Promise<DiscardResult> {
  const workspaceId = input.workspaceId?.trim() || "";
  if (workspaceId && input.listAgents) {
    let agents: Array<{ id: string; archived: boolean }>;
    try {
      agents = await input.listAgents(workspaceId);
    } catch {
      return { archived: false, removedBranch: false, skipped: t("worktreeRecord.skip.agentsUnknown") };
    }
    if (agents.some((agent) => !agent.archived)) return { archived: false, removedBranch: false, skipped: t("worktreeRecord.skip.hasAgent") };
  } else if (!input.assumeNoAgent) {
    return { archived: false, removedBranch: false, skipped: t("worktreeRecord.skip.agentsUnknown") };
  }

  const run = input.run ?? runGit;
  if (!isAbsolute(input.directory) || samePath(input.directory, input.root)) {
    return { archived: false, removedBranch: false, skipped: t("worktreeRecord.skip.notCardCopy") };
  }
  if (input.readOnly) {
    if (input.branch !== readOnlyBranchName(input.taskId) || samePath(input.directory, input.root)) {
      return { archived: false, removedBranch: false, skipped: t("worktreeRecord.skip.readOnlyNotCard") };
    }
    const error = await readOnlyCopyError(input, run);
    if (error) return { archived: false, removedBranch: false, skipped: error };
  }
  let archived = false;
  if (workspaceId && input.archiveWorkspace) {
    try {
      await input.archiveWorkspace(workspaceId);
      archived = true;
    } catch (err) {
      return { archived: false, removedBranch: false, skipped: err instanceof Error ? err.message : String(err) };
    }
  }

  const branch = input.branch.trim();
  const base = input.base.trim() || "main";
  const root = input.root.trim();
  if (!root || !branch || !refOk(branch) || !refOk(base) ||
    !(input.readOnly ? branch === readOnlyBranchName(input.taskId) : branchOwnedByCard(input.taskId, branch))) {
    return { archived, removedBranch: false, skipped: t("worktreeRecord.skip.branchNotDeletable") };
  }
  if (input.readOnly) {
    if (existsSync(input.directory)) {
      const removed = await run(root, ["worktree", "remove", "--", input.directory]);
      if (removed.code !== 0 && existsSync(input.directory)) return { archived, removedBranch: false, skipped: t("worktreeRecord.skip.readOnlyNotRemoved") };
    }
    const error = await deleteReadOnlyBranch(input.taskId, input, run);
    return error ? { archived, removedBranch: false, skipped: error } : { archived, removedBranch: true };
  }
  const status = await run(input.directory, ["status", "--porcelain"]);
  if (status.code !== 0) return { archived, removedBranch: false, skipped: t("worktreeRecord.skip.commitsUnknown") };
  if (status.stdout.trim()) return { archived, removedBranch: false, skipped: t("worktreeRecord.skip.uncommitted") };
  const ahead = await run(root, ["rev-list", "--count", `${base}..${branch}`]);
  if (ahead.code !== 0) return { archived, removedBranch: false, skipped: t("worktreeRecord.skip.commitsUnknown") };
  if (ahead.stdout.trim() !== "0") return { archived, removedBranch: false, skipped: t("worktreeRecord.skip.hasCommits") };
  const removed = await run(root, ["worktree", "remove", "--", input.directory]);
  if (removed.code !== 0 && existsSync(input.directory)) return { archived, removedBranch: false, skipped: t("worktreeRecord.skip.copyNotRemoved") };
  const deleted = await run(root, ["branch", "-d", branch]);
  if (deleted.code !== 0) return { archived, removedBranch: false, skipped: t("worktreeRecord.skip.branchNotRemoved") };
  return { archived, removedBranch: true };
}

/** The directory git itself lists as holding this branch, or null when no worktree has it checked out. */
export async function worktreeDirectoryForBranch(root: string, branch: string, run: GitRunner = runGit): Promise<string | null> {
  if (!root || !branch || !refOk(branch)) return null;
  const listed = await run(root, ["worktree", "list", "--porcelain"]);
  if (listed.code !== 0) return null;
  let directory = "";
  for (const line of listed.stdout.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) directory = line.slice("worktree ".length);
    else if (line === `branch refs/heads/${branch}` && directory && !samePath(directory, root)) return directory;
  }
  return null;
}

/**
 * Paseo can report a directory that differs from the one git actually created (a "-1" suffix on a name clash).
 * The reported directory wins only while it exists; otherwise the worktree git lists for the branch does.
 */
export async function actualWorktreeDirectory(root: string, branch: string, reported: string, run: GitRunner = runGit): Promise<string> {
  if (existsSync(reported)) return reported;
  return (await worktreeDirectoryForBranch(root, branch, run)) ?? reported;
}

/** Point the card's saved worktree record at the directory that really exists. */
export function rewriteRecordedDirectory(taskId: number, from: string, to: string): void {
  const db = getDb();
  const stamp = new Date().toISOString();
  for (const kind of ["worktree_created", "temp_workspace"]) {
    const rows = db.prepare("SELECT id, data_json FROM events WHERE task_id = ? AND kind = ? ORDER BY id").all(taskId, kind) as Array<{
      id: number;
      data_json: string;
    }>;
    for (const row of rows) {
      const data = asRecord(row.data_json);
      if (!data || data.discarded === true || !sameDirectory(data.directory, from)) continue;
      db.prepare("UPDATE events SET data_json = ? WHERE id = ?").run(JSON.stringify({ ...data, directory: to }), row.id);
    }
  }
  db.prepare("UPDATE tasks SET workspace_path = ?, updated_at = ? WHERE id = ? AND workspace_path = ?").run(to, stamp, taskId, from);
  db.prepare("INSERT INTO events (task_id, at, kind, from_status, to_status, actor, data_json) VALUES (?, ?, 'worktree_directory_corrected', NULL, NULL, 'kanban', ?)").run(
    taskId,
    stamp,
    JSON.stringify({ from, to }),
  );
}

/**
 * When the recorded directory is missing but git lists the card's branch at another path, correct the record and return it.
 * Null when nothing needed fixing, so a really missing copy still counts as gone.
 */
export async function reconcileRecordedDirectory(taskId: number, record: WorktreeRecord | null, run: GitRunner = runGit): Promise<WorktreeRecord | null> {
  if (!record?.directory || !record.branch || !record.root || existsSync(record.directory)) return null;
  const real = await worktreeDirectoryForBranch(record.root, record.branch, run);
  if (!real || samePath(real, record.directory)) return null;
  rewriteRecordedDirectory(taskId, record.directory, real);
  return { ...record, directory: real };
}

/** Directories this card's record used to name before reconcileRecordedDirectory corrected them. */
export function correctedFromDirectories(taskId: number): string[] {
  const rows = getDb()
    .prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'worktree_directory_corrected' ORDER BY id")
    .all(taskId) as Array<{ data_json: string }>;
  const from: string[] = [];
  for (const row of rows) {
    const data = asRecord(row.data_json) as { from?: unknown } | null;
    if (typeof data?.from === "string") from.push(data.from);
  }
  return from;
}
