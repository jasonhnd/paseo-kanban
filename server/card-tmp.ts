/// <reference types="node" />
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { accessSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { loadConfig } from "./config";
import { unifiedDataRoot } from "./storage/root";

export const TMP_GENERATION_FILE = ".kanban-tmp-generation";
export const CARD_WORK_DIR = ".kanban-work";
export interface CardTmpContext {
  project?: string;
  workspacePath?: string | null;
}

function projectSegment(project?: string): string {
  const name = project?.trim() || "unassigned";
  return /^\.+$/.test(name) ? name.replaceAll(".", "%2E") : encodeURIComponent(name);
}

export function cardTmpFallbackRoot(project?: string): string {
  return join(unifiedDataRoot(), "work", projectSegment(project));
}

/** Configured project directory wins over a card's disposable checkout. */
export function cardTmpWorkspace(context: CardTmpContext): string | null {
  let configured: string | undefined;
  if (context.project) configured = loadConfig().projects?.[context.project]?.workspacePath;
  const value = (configured ?? context.workspacePath)?.trim().replace(/^dir:/, "");
  return value && isAbsolute(value) ? resolve(value) : null;
}

/** Discovery never creates a directory or changes repository files. */
export function cardTmpRoots(context: CardTmpContext = {}): string[] {
  const override = process.env.KANBAN_TMP_ROOT?.trim();
  const workspace = cardTmpWorkspace(context);
  return [...new Set([
    ...(override ? [resolve(override)] : []),
    ...(workspace ? [join(workspace, CARD_WORK_DIR)] : []),
    cardTmpFallbackRoot(context.project),
  ])];
}

function excludePath(workspace: string): string {
  // Git resolves the common info/exclude correctly for both normal repos and linked worktrees.
  const top = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: workspace, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000 }).trim();
  if (realpathSync(top) !== realpathSync(workspace)) throw new Error("project workspace is not a repository root");
  return execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"], {
    cwd: workspace, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000,
  }).trim();
}

function writableWorkspace(workspace: string): boolean {
  try {
    accessSync(workspace, constants.W_OK);
    const exclude = excludePath(workspace);
    const info = lstatSync(exclude, { throwIfNoEntry: false });
    if (info && (!info.isFile() || info.nlink !== 1)) return false;
    accessSync(info ? exclude : dirname(exclude), constants.W_OK);
    return true;
  } catch { return false; }
}

/** Add only a local ignore rule, preserving the file's existing contents. Never follow links. */
function ensureWorkspaceExclude(workspace: string): void {
  const path = excludePath(workspace);
  const fd = openSync(path, constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1) throw new Error("unsafe repository exclude");
    const text = readFileSync(fd, "utf8");
    if (!text.split(/\r?\n/).includes(`${CARD_WORK_DIR}/`)) {
      writeFileSync(fd, `${text && !text.endsWith("\n") ? "\n" : ""}${CARD_WORK_DIR}/\n`);
    }
  } finally { closeSync(fd); }
}

function makeRealDirectory(path: string): void {
  const before = lstatSync(path, { throwIfNoEntry: false });
  if (before && !before.isDirectory()) throw new Error("card work path is not a real directory");
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (!lstatSync(path).isDirectory()) throw new Error("card work path is not a real directory");
}

/** Missing markers are legacy directories. Unreadable or unsafe markers fail closed. */
export function cardTmpGeneration(dir: string): string | null {
  let fd: number;
  try {
    fd = openSync(join(dir, TMP_GENERATION_FILE), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || info.size > 128) throw new Error("invalid tmp generation marker");
    return readFileSync(fd, "utf8");
  } finally { closeSync(fd); }
}

/** Prefer a writable Git project; otherwise use the per-project plugin-data work directory. */
export function cardTmpRoot(context: CardTmpContext = {}): string {
  const override = process.env.KANBAN_TMP_ROOT?.trim();
  if (override) return resolve(override);
  const workspace = cardTmpWorkspace(context);
  return workspace && writableWorkspace(workspace) ? join(realpathSync(workspace), CARD_WORK_DIR) : cardTmpFallbackRoot(context.project);
}

/**
 * Each card gets its own project work directory and atomic generation marker.
 * An explicit override is authoritative; project failures try the plugin-data work directory.
 * Resume rotates the recorded directory used by the original agent.
 */
export function cardTmpEnv(code: string, context: CardTmpContext = {}, existingDir?: string | null): Record<string, string> {
  if (!/^[A-Za-z0-9]+_\d+$/.test(code)) return {};
  if (existingDir && (!isAbsolute(existingDir) || basename(existingDir) !== code)) return {};
  const root = existingDir ? dirname(existingDir) : cardTmpRoot(context);
  const env = prepare(root, code, context, Boolean(existingDir));
  if (env.KANBAN_TMP || existingDir || process.env.KANBAN_TMP_ROOT?.trim() || root === cardTmpFallbackRoot(context.project)) return env;
  return prepare(cardTmpFallbackRoot(context.project), code, context, false);
}

function prepare(root: string, code: string, context: CardTmpContext, resuming: boolean): Record<string, string> {
  const dir = join(root, code);
  try {
    if (!resuming && !process.env.KANBAN_TMP_ROOT?.trim()) {
      if (root !== cardTmpFallbackRoot(context.project)) {
        const workspace = cardTmpWorkspace(context);
        if (!workspace) throw new Error("project workspace missing");
        ensureWorkspaceExclude(workspace);
      }
    }
    makeRealDirectory(root);
    makeRealDirectory(dir);
    const marker = join(dir, TMP_GENERATION_FILE);
    const existing = lstatSync(marker, { throwIfNoEntry: false });
    if (existing && !existing.isFile()) throw new Error("unsafe tmp generation marker");
    const generation = randomUUID();
    const pending = `${marker}.${generation}`;
    writeFileSync(pending, generation, { flag: "wx", mode: 0o600 });
    try { renameSync(pending, marker); } finally {
      // Atomic replacement also avoids truncating an existing hard link or exposing a partial marker.
      try { unlinkSync(pending); } catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
    }
  } catch (err) {
    console.error("[paseo-kanban] card tmp dir", dir, err instanceof Error ? err.message : err);
    return {};
  }
  return { TMPDIR: `${dir}/`, KANBAN_TMP: dir };
}
