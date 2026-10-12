import { cardMark } from "./card-ref";
import { t } from "../shared/i18n";
import { loadConfig } from "./config";

/** Appended to the brief when the agent starts in a fresh temporary worktree. */
export function freshCopyNote(): string {
  return t("workspace.freshCopy");
}

export type WorkspaceKind = "dir" | "worktree" | "lane" | "none";

export interface WorkspaceSpec {
  kind: WorkspaceKind;
  root: string | null;
  base: string | null;
}

export function parseWorkspace(input?: string | null, base?: string | null): WorkspaceSpec {
  const text = input?.trim() ?? "";
  // An omitted --workspace stays none. An empty dir would capability-block at start.
  if (!text || text === "none") return { kind: "none", root: null, base: null };
  if (text.startsWith("none:")) return { kind: "none", root: text.slice("none:".length) || null, base: null };
  if (text === "lane" || text === "worktree") return { kind: "lane", root: null, base: base?.trim() || null };
  if (text.startsWith("lane:") || text.startsWith("worktree:")) {
    const body = text.slice(text.indexOf(":") + 1);
    const inline = inlineBase(body);
    const root = inline ? body.slice(0, body.lastIndexOf("@")) : body;
    return { kind: "lane", root: root || null, base: base?.trim() || inline || null };
  }
  if (text.startsWith("dir:")) return { kind: "dir", root: text.slice("dir:".length) || null, base: null };
  return { kind: "dir", root: text, base: null };
}

/** The base written as worktree:<path>@<base>, or "" when there is none. */
function inlineBase(body: string): string {
  const at = body.lastIndexOf("@");
  return at > 0 && !body.slice(at + 1).includes("/") ? body.slice(at + 1) : "";
}

function isLaneRequest(text: string): boolean {
  return text === "lane" || text === "worktree" || text.startsWith("lane:") || text.startsWith("worktree:");
}

/**
 * A card is a lane only when create says so (`lane`, `worktree`, `lane:<repo>@<base>`, or `worktree:<repo>@<base>`).
 * A bare directory stays a directory. A project file that still says default worktree does not change that.
 * `worktree:<repo>` is a lane too: new cards do not open a fresh worktree per card.
 * The base is the inline @base, the explicit base, or the project's baseBranch.
 */
export function resolveCreateWorkspace(
  project: string,
  _role: string,
  workspacePath?: string,
  workspaceBase?: string,
): { path?: string; base?: string } {
  const text = workspacePath?.trim() ?? "";
  if (!isLaneRequest(text)) return { path: workspacePath, base: workspaceBase };
  const parsed = parseWorkspace(text, workspaceBase);
  const base = workspaceBase?.trim() || parsed.base || configuredBase(project);
  if (!parsed.root) return { path: "lane", base };
  return { path: `lane:${parsed.root}@${base}`, base };
}

function configuredBase(project: string): string {
  return loadConfig().projects?.[project]?.baseBranch || "main";
}

/** Fixed lane workspace name. n starts at 1. */
export function laneName(index: number): string {
  return `kanban-lane-${index}`;
}

/** Card branch inside a lane. The short title keeps ASCII letters, digits, and hyphens, at most 40. */
export function laneBranchName(id: number, title: string): string {
  const short = title
    .trim()
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `kanban/${id}-${short || "task"}`;
}

function shortTitle(title: string): string {
  const short = title
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return short || "task";
}

export function branchName(id: number, title: string): string {
  return `kanban/${id}-${shortTitle(title)}`;
}

/** ASCII only, so a later squash delete can name the branch. A Chinese title becomes "task". */
function asciiTitle(title: string): string {
  const short = title
    .trim()
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return short || "task";
}

/** Branch for a temporary workspace. The card number is the display code, such as DEMO_0001. */
export function tempBranchName(code: string, title: string): string {
  return `kanban/${code}-${asciiTitle(title)}`;
}

/**
 * A branch this card may delete. Legacy worktrees use the global id.
 * Temporary workspaces use the display code.
 */
export function branchOwnedByCard(taskId: number, branch: string): boolean {
  if (!branch.startsWith("kanban/") || branch.includes("..") || branch.startsWith("-")) return false;
  if (branch.startsWith(`kanban/${taskId}-`)) return true;
  const mark = cardMark(taskId);
  if (mark.startsWith("#")) return false;
  return branch.startsWith(`kanban/${mark}-`);
}
