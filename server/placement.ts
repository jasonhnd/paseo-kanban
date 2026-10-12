/// <reference types="node" />
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

export interface ListedWorkspace {
  id: string;
  name: string | null;
  directory: string | null;
  projectRoot: string | null;
  projectId: string | null;
  kind: string;
  archived: boolean;
  pinned?: boolean;
}

export function samePath(left: string | null | undefined, right: string | null | undefined): boolean {
  if (!left?.trim() || !right?.trim()) return false;
  return canonical(left) === canonical(right);
}

function canonical(input: string): string {
  const trimmed = input.trim();
  try {
    return realpathSync(trimmed);
  } catch {
    return resolve(trimmed);
  }
}

/** A project's main workspace: not a worktree, not archived, cwd is the project root. */
export function isProjectMain(entry: ListedWorkspace, directory?: string): boolean {
  if (entry.archived || entry.kind === "worktree") return false;
  if (!entry.directory || !entry.projectRoot) return false;
  if (!samePath(entry.directory, entry.projectRoot)) return false;
  if (directory && !samePath(entry.directory, directory)) return false;
  return true;
}

function preferPinned(entries: ListedWorkspace[]): ListedWorkspace | null {
  if (entries.length === 0) return null;
  const pinned = entries.find((entry) => entry.pinned);
  if (pinned) return pinned;
  const namedMain = entries.find((entry) => entry.name === "main");
  return namedMain ?? entries[0];
}

/** The project's main checkout, ignoring worktrees and other directories. */
export function projectMain(entries: ListedWorkspace[], directory: string): ListedWorkspace | null {
  return preferPinned(entries.filter((entry) => isProjectMain(entry, directory)));
}

/**
 * Pick the workspace whose directory is exactly `directory`.
 * Prefer the project's main workspace. Return null when this directory has none,
 * so the caller creates one and then reuses it.
 */
export function pickWorkspace(entries: ListedWorkspace[], directory: string): ListedWorkspace | null {
  const active = entries.filter((entry) => !entry.archived && samePath(entry.directory, directory));
  const main = active.filter((entry) => isProjectMain(entry, directory));
  if (main.length > 0) return preferPinned(main);
  const local = active.filter((entry) => entry.kind !== "worktree");
  if (local.length > 0) return preferPinned(local);
  return preferPinned(active);
}
