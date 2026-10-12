/// <reference types="node" />
import { lstat, readdir } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { agentsOpenedBy, type CleanupRecord } from "./archive-book";
import { getDb } from "./db";
import { headRef, isProtectedBranch, refOk, runGit } from "./git";
import { laneBinding } from "./lane";
import { samePath } from "./placement";
import { getTask, type TaskRow } from "./store";
import { createdWorktree, ownedWorktree } from "./worktree-gc";
import { branchOwnedByCard } from "./workspace";
import type { AgentSnapshot } from "./cleanup";

/** Absence is a read result, never a request to delete, resume, or finish the whole card. */
export interface GoneReader {
  workspaceIds(): Promise<ReadonlySet<string>>;
  agent(id: string): Promise<AgentSnapshot | null>;
  /** Also covers a rebind, reopened card and the round's time budget. */
  current(): boolean;
}

const RESOURCE_ACTIONS = new Set(["archive_agent", "wait_turn", "restore_stuck", "archive_workspace", "purge_agents", "drop_directory", "delete_branch", "delete_lane_branch", "remove_worktree", "skip_worktree", "wip_commit"]);
export const GONE_TARGET_CAP = 32;
const cursors = new Map<number, number>();
export function resetGoneScan(): void { cursors.clear(); }

function target(row: CleanupRecord): string {
  return JSON.stringify([row.action, row.agentId ?? null, row.workspaceId ?? null, row.directory ?? null, row.branch ?? null]);
}

/** Only unresolved failures. Each later success covers the same target, not its neighbors. */
function pendingTargets(events: CleanupRecord[]): CleanupRecord[] {
  const latest = new Map<string, CleanupRecord>();
  for (const row of events) {
    if (!row.action || !RESOURCE_ACTIONS.has(row.action)) continue;
    latest.set(target(row), row);
  }
  return [...latest.values()].filter(row => row.ok === false && !events.some(later =>
    (later.rowId ?? 0) > (row.rowId ?? 0) && later.ok === true && (
      target(later) === target(row) ||
      (row.agentId && ["archive_agent", "wait_turn", "restore_stuck"].includes(row.action!) && later.action === "archive_agent" && later.agentId === row.agentId) ||
      (row.action === "purge_agents" && later.action === "purge_agents" && !later.agentId && later.directory === row.directory)
    ),
  ));
}

/** ENOENT alone may come from a dangling ancestor. Confirm a missing entry in a readable parent. */
export async function directoryAbsent(directory: string, fs = { lstat, readdir }): Promise<boolean> {
  try {
    await fs.lstat(directory); // A symlink, file or placeholder still exists.
    return false;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") return false;
  }
  const parent = dirname(directory);
  if (parent === directory) return false;
  try {
    const names = await fs.readdir(parent);
    return !names.includes(basename(directory));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") return false;
    return directoryAbsent(parent, fs);
  }
}

async function branchAbsent(root: string, branch: string): Promise<boolean> {
  if (!refOk(branch) || isProtectedBranch(branch)) return false;
  // A non-zero exit (including an unreadable/missing repository) is unknown.
  // Unlike show-ref's exit 1, this successful complete read distinguishes no ref from a read failure.
  const read = await runGit(root, ["for-each-ref", "--format=%(refname)", headRef(branch)]);
  return read.code === 0 && !read.stdout.split(/\r?\n/).includes(headRef(branch));
}

function activeSharer(task: TaskRow, column: "paseo_workspace_id" | "workspace_path", value: string): boolean {
  if (column === "paseo_workspace_id") {
    return Boolean(getDb().prepare("SELECT 1 FROM tasks WHERE id != ? AND status NOT IN ('done', 'archived') AND paseo_workspace_id = ? LIMIT 1").get(task.id, value));
  }
  // Paths can alias through symlinks. Bound that comparison too; a saturated ownership read is unknown,
  // so retain the failure rather than walking every active card for every resource in the sweep.
  const cap = 100;
  const rows = getDb().prepare("SELECT workspace_path AS value FROM tasks WHERE id != ? AND status NOT IN ('done', 'archived') AND workspace_path IS NOT NULL LIMIT ?").all(task.id, cap + 1) as Array<{ value: string }>;
  return rows.length > cap || rows.some(row => samePath(row.value, value));
}

/** One card in the existing bounded sweep. No destructive operation is reachable from this function. */
export async function reconcileGone(task: TaskRow, events: CleanupRecord[], read: GoneReader, record: (data: Omit<CleanupRecord, "at">) => void): Promise<void> {
  const targets = pendingTargets(events);
  if (!targets.length) { cursors.delete(task.id); return; }
  const start = (cursors.get(task.id) ?? 0) % targets.length;
  const todo = [...targets.slice(start), ...targets.slice(0, start)].slice(0, GONE_TARGET_CAP);
  cursors.set(task.id, (start + todo.length) % targets.length);
  const ours = new Set(agentsOpenedBy(task));
  const owned = ownedWorktree(task.id, createdWorktree(task.id));
  const lane = task.workspace_kind === "lane" ? laneBinding(task.id) : null;
  const agentReads = new Map<string, Promise<AgentSnapshot | null>>();
  const agentGone = async (id: string): Promise<boolean> => {
    if (!ours.has(id)) return false;
    const active = getDb().prepare(`SELECT 1 FROM tasks t WHERE t.status NOT IN ('done', 'archived') AND
      (t.agent_id = ? OR t.executor_agent_id = ? OR EXISTS (SELECT 1 FROM runs r WHERE r.task_id = t.id AND r.agent_id = ?)) LIMIT 1`).get(id, id, id);
    if (active) return false;
    if (!agentReads.has(id)) agentReads.set(id, read.agent(id));
    return (await agentReads.get(id)) === null;
  };
  for (const failed of todo) {
    if (!read.current()) return;
    // An earlier target in this batch may have covered the same agent's wait/restore failure.
    if (!pendingTargets(events).includes(failed)) continue;
    let gone = false;
    try {
      if (failed.agentId && ["archive_agent", "wait_turn", "restore_stuck", "purge_agents"].includes(failed.action!)) {
        gone = await agentGone(failed.agentId);
      } else if (failed.action === "archive_workspace" && failed.workspaceId) {
        if (task.workspace_kind !== "worktree" || failed.workspaceId !== task.paseo_workspace_id || activeSharer(task, "paseo_workspace_id", failed.workspaceId)) continue;
        gone = !(await read.workspaceIds()).has(failed.workspaceId);
      } else {
        const binding = failed.action === "delete_lane_branch" ? lane : owned;
        if (!binding || !failed.directory || !samePath(failed.directory, binding.directory)) continue;
        if (activeSharer(task, "workspace_path", binding.directory) && failed.action !== "delete_lane_branch") continue;
        const branch = failed.branch ?? binding.branch;
        if (branch !== binding.branch || (!owned?.readOnly && !branchOwnedByCard(task.id, branch))) continue;
        if (failed.action === "drop_directory") gone = await directoryAbsent(binding.directory);
        else if (failed.action === "delete_branch" || failed.action === "delete_lane_branch") gone = await branchAbsent(binding.root, branch);
        else if (failed.action === "purge_agents") {
          // Directory-level purge succeeds only when every card-owned agent is absent.
          gone = ours.size > 0;
          for (const id of ours) { if (!read.current() || !await agentGone(id)) { gone = false; break; } }
        } else if (["remove_worktree", "skip_worktree", "wip_commit"].includes(failed.action!)) {
          // These steps have both a directory and branch obligation. A missing directory alone cannot cover an unmerged branch.
          gone = await directoryAbsent(binding.directory) && await branchAbsent(binding.root, branch);
        }
      }
    } catch {
      // A timeout, disconnected client, permission error or incomplete inventory is unknown.
      continue;
    }
    if (!gone || !read.current()) continue;
    const latest = getTask(task.id);
    if (latest.status !== "done" && latest.status !== "archived") return;
    if (latest.paseo_workspace_id !== task.paseo_workspace_id || latest.workspace_path !== task.workspace_path) return;
    const action = failed.action === "wait_turn" || failed.action === "restore_stuck" ? "archive_agent" : failed.action;
    record({ action, agentId: failed.agentId, workspaceId: failed.workspaceId, directory: failed.directory, branch: failed.branch,
      ok: true, reason: "gone", reconciled: true, failureRowId: failed.rowId });
  }
}
