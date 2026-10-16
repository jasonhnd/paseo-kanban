/// <reference types="node" />
import { execFileSync } from "node:child_process";
import { chmodSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import { t } from "../shared/i18n";
import { loadConfig, type KanbanConfig } from "./config";
import { getDb } from "./db";
import { KanbanError } from "./errors";
import { readFileSync, statSync } from "./perf-fs";
import { dataDir } from "./paths";

/**
 * Paseo's project list is the only list of projects. The board keeps its own project settings and
 * leader table, but a board project whose directory is no longer a Paseo project has left Paseo:
 * it is hidden, never woken and never dispatched, while its cards and history stay readable.
 *
 * Projects are compared by directory (never by name: the two sides name a project differently).
 * The last list read from Paseo is kept in memory and in `paseo-projects.json` in the data
 * directory. When Paseo cannot be read, that list is used again. Before the first successful read
 * nothing is filtered, which is how the board behaved before this existed.
 */

const FILE_NAME = "paseo-projects.json";
const READ_TIMEOUT_MS = 8_000;
const CLI_TIMEOUT_MS = 8_000;
/** Newest cards per project that tell the board where the project lives when the config does not say. */
const CARD_DIRECTORIES_PER_PROJECT = 30;

export interface PaseoProject {
  id: string;
  name: string;
  /** Normalised root directory (see normalizeProjectPath). */
  path: string;
}

interface Stored {
  readAt: string;
  projects: PaseoProject[];
}

/** What `paseo.projects.list()` needs to answer. A narrower type than PaseoApi keeps tests small. */
export type ProjectLister = { projects: Pick<PaseoApi["projects"], "list"> } | { projects: { list(): Promise<unknown> } };

let memory: Stored | null = null;
let fileKey: string | null = null;
let fileValue: Stored | null = null;
let lastLogged: string | null = null;
let cardDirectories: { key: string; byProject: Map<string, string[]> } | null = null;

function logOnce(message: string): void {
  if (message === lastLogged) return;
  lastLogged = message;
  console.error("[paseo-kanban] paseo-projects", message);
}

export function paseoProjectsPath(): string {
  return join(dataDir(), FILE_NAME);
}

/**
 * One comparable absolute directory, or null when the text is not an absolute path.
 * Drops a `dir:` prefix and trailing slashes and follows symbolic links when the directory exists.
 */
export function normalizeProjectPath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let text = raw.trim();
  if (text.startsWith("dir:")) text = text.slice("dir:".length).trim();
  if (!text.startsWith(sep)) return null;
  const absolute = resolve(text);
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

function toProject(id: string, name: string, path: unknown): PaseoProject | null {
  const normalised = normalizeProjectPath(path);
  return normalised ? { id, name, path: normalised } : null;
}

/** The client's `projects.list()` answer. Throws when the shape cannot be trusted, so it is never read as "no projects". */
export function parsePaseoProjectList(result: unknown): PaseoProject[] {
  if (!result || typeof result !== "object") throw new KanbanError("paseo_shape", t("paseoProjects.shape.notObject"));
  const rows = (result as { projects?: unknown }).projects;
  if (!Array.isArray(rows)) throw new KanbanError("paseo_shape", t("paseoProjects.shape.noProjects"));
  return rows.map((row) => {
    const item = row && typeof row === "object" ? (row as Record<string, unknown>) : {};
    const id = typeof item.projectId === "string" ? item.projectId : "";
    const name = typeof item.projectDisplayName === "string" ? item.projectDisplayName : "";
    const project = id ? toProject(id, name, item.projectRootPath) : null;
    if (!project) throw new KanbanError("paseo_shape", t("paseoProjects.shape.badProject"));
    return project;
  });
}

/** `paseo project ls --json`: `[{ projectId, name, kind, path }]`. */
function parseCliProjectList(text: string): PaseoProject[] {
  const rows: unknown = JSON.parse(text);
  if (!Array.isArray(rows)) throw new KanbanError("paseo_shape", t("paseoProjects.shape.noProjects"));
  return rows.map((row) => {
    const item = row && typeof row === "object" ? (row as Record<string, unknown>) : {};
    const id = typeof item.projectId === "string" ? item.projectId : "";
    const project = id ? toProject(id, typeof item.name === "string" ? item.name : "", item.path) : null;
    if (!project) throw new KanbanError("paseo_shape", t("paseoProjects.shape.badProject"));
    return project;
  });
}

function writeStored(value: Stored): void {
  const path = paseoProjectsPath();
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  } catch (err) {
    logOnce(`cannot store the Paseo project list: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Remember a list read from Paseo, in memory and for other processes. */
export function recordPaseoProjects(projects: PaseoProject[], now: Date = new Date()): void {
  memory = { readAt: now.toISOString(), projects };
  cardDirectories = null;
  writeStored(memory);
  fileKey = null;
}

function readStored(): Stored | null {
  const path = paseoProjectsPath();
  let key: string;
  try {
    const stat = statSync(path);
    key = `${path}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    fileKey = null;
    fileValue = null;
    return null;
  }
  if (key === fileKey) return fileValue;
  fileKey = key;
  fileValue = null;
  try {
    const raw = JSON.parse(String(readFileSync(path, "utf8"))) as { readAt?: unknown; projects?: unknown };
    if (typeof raw.readAt !== "string" || !Array.isArray(raw.projects)) throw new Error("unexpected shape");
    const projects = raw.projects.flatMap((row): PaseoProject[] => {
      const item = row as Record<string, unknown> | null;
      const path = normalizeProjectPath(item?.path);
      return path ? [{ id: String(item?.id ?? ""), name: String(item?.name ?? ""), path }] : [];
    });
    fileValue = { readAt: raw.readAt, projects };
  } catch (err) {
    logOnce(`${path} is not usable, treating Paseo as never read: ${err instanceof Error ? err.message : String(err)}`);
  }
  return fileValue;
}

/** The newer of this process's list and the stored one. Null before the first successful read. */
function currentList(): Stored | null {
  const stored = readStored();
  if (memory && stored) return memory.readAt >= stored.readAt ? memory : stored;
  return memory ?? stored;
}

/** When the list in use was read, or null when it never was. */
export function paseoProjectsReadAt(): string | null {
  return currentList()?.readAt ?? null;
}

/** Directories of the projects Paseo lists, or null when Paseo has never been read. */
export function paseoProjectPaths(): ReadonlySet<string> | null {
  const list = currentList();
  return list ? new Set(list.projects.map((project) => project.path)) : null;
}

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    (timer as unknown as { unref?: () => void }).unref?.();
  });
  try { return await Promise.race([work, timeout]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}

/**
 * Read the project list through the Paseo client and keep it. Returns false, and keeps the previous
 * list, when Paseo cannot be read, answers with an unexpected shape, or lists no project at all:
 * a daemon that has just started can briefly list none, and that must not hide every project.
 */
export async function refreshPaseoProjects(paseo: ProjectLister, options: { timeoutMs?: number; now?: Date } = {}): Promise<boolean> {
  try {
    const projects = parsePaseoProjectList(await withTimeout(Promise.resolve((paseo.projects.list as () => Promise<unknown>)()), options.timeoutMs ?? READ_TIMEOUT_MS));
    if (projects.length === 0) throw new Error("Paseo listed no projects");
    recordPaseoProjects(projects, options.now);
    lastLogged = null;
    return true;
  } catch (err) {
    logOnce(`cannot read the Paseo project list, keeping the last one: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/** Same as refreshPaseoProjects through `paseo project ls --json`, for a process that has no client. */
export function refreshPaseoProjectsFromCli(
  run: () => string = () => execFileSync("paseo", ["project", "ls", "--json"], { encoding: "utf8", timeout: CLI_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"] }),
  options: { now?: Date } = {},
): boolean {
  try {
    const projects = parseCliProjectList(run());
    if (projects.length === 0) throw new Error("Paseo listed no projects");
    recordPaseoProjects(projects, options.now);
    lastLogged = null;
    return true;
  } catch (err) {
    logOnce(`cannot read the Paseo project list from the command line, keeping the last one: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/** Forget what this process knows. `clearFile` also removes the stored list. Used by tests. */
export function resetPaseoProjects(options: { clearFile?: boolean } = {}): void {
  memory = null;
  fileKey = null;
  fileValue = null;
  lastLogged = null;
  cardDirectories = null;
  if (options.clearFile) {
    try { renameSync(paseoProjectsPath(), `${paseoProjectsPath()}.${process.pid}.gone`); } catch { /* nothing stored */ }
  }
}

/** `dir:/x`, `/x`, `lane:/x@main` and `worktree:/x@main` name /x. Anything else names no directory. */
function cardPathDirectory(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim().replace(/^(?:lane|worktree):/, "").replace(/@[^/]+$/, "");
  return normalizeProjectPath(text);
}

function loadCardDirectories(): Map<string, string[]> {
  const db = getDb();
  const tasks = db.prepare("SELECT COUNT(*) AS n, COALESCE(MAX(id), 0) AS last FROM tasks").get() as { n: number; last: number };
  const events = db.prepare("SELECT COALESCE(MAX(id), 0) AS last FROM events").get() as { last: number };
  const key = `${tasks.n}:${tasks.last}:${events.last}`;
  if (cardDirectories?.key === key) return cardDirectories.byProject;
  const byProject = new Map<string, Set<string>>();
  const add = (project: string, raw: unknown) => {
    const directory = cardPathDirectory(raw);
    if (directory) byProject.set(project, (byProject.get(project) ?? new Set<string>()).add(directory));
  };
  // A card in a temporary worktree overwrites its path with the worktree; its recorded root is the project's directory.
  const paths = db.prepare(
    `SELECT project, workspace_path AS path FROM (
       SELECT project, workspace_path, ROW_NUMBER() OVER (PARTITION BY project ORDER BY id DESC) AS rank
       FROM tasks WHERE workspace_kind = 'dir' AND workspace_path IS NOT NULL
     ) WHERE rank <= ?`,
  ).all(CARD_DIRECTORIES_PER_PROJECT) as Array<{ project: string; path: string }>;
  for (const row of paths) add(row.project, row.path);
  const roots = db.prepare(
    `SELECT project, root FROM (
       SELECT t.project AS project, json_extract(e.data_json, '$.root') AS root,
              ROW_NUMBER() OVER (PARTITION BY t.project ORDER BY e.id DESC) AS rank
       FROM events e JOIN tasks t ON t.id = e.task_id WHERE e.kind = 'temp_workspace'
     ) WHERE root IS NOT NULL AND rank <= ?`,
  ).all(CARD_DIRECTORIES_PER_PROJECT) as Array<{ project: string; root: string }>;
  for (const row of roots) add(row.project, row.root);
  const out = new Map([...byProject].map(([project, set]) => [project, [...set]]));
  cardDirectories = { key, byProject: out };
  return out;
}

/**
 * The directories that identify a board project. The configured `workspacePath` wins; otherwise the
 * directories its recent cards ran in. Empty when nothing says where the project lives.
 */
export function projectDirectories(project: string, config: KanbanConfig = loadConfig()): string[] {
  const row = config.projects?.[project] as { workspacePath?: unknown; workspace?: unknown } | undefined;
  const configured = normalizeProjectPath(row?.workspacePath ?? row?.workspace);
  if (configured) return [configured];
  try {
    return loadCardDirectories().get(project) ?? [];
  } catch (err) {
    logOnce(`cannot read card directories: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * True when Paseo is known and none of the project's directories is a Paseo project. A project with no
 * known directory is never removed: nothing can prove it is gone.
 */
export function isProjectRemoved(project: string | null | undefined, config?: KanbanConfig): boolean {
  const name = project?.trim();
  if (!name) return false;
  const known = paseoProjectPaths();
  if (!known) return false;
  const directories = projectDirectories(name, config);
  return directories.length > 0 && !directories.some((directory) => known.has(directory));
}

/** Every board project (configured, with a leader, or with cards) that has left Paseo. */
export function removedProjects(config: KanbanConfig = loadConfig()): ReadonlySet<string> {
  const out = new Set<string>();
  if (!paseoProjectPaths()) return out;
  const names = new Set<string>([...Object.keys(config.projects ?? {}), ...Object.keys(config.supervisors ?? {})]);
  try {
    for (const row of getDb().prepare("SELECT DISTINCT project FROM tasks").all() as Array<{ project: string }>) names.add(row.project);
  } catch (err) {
    logOnce(`cannot list card projects: ${err instanceof Error ? err.message : String(err)}`);
  }
  for (const name of names) if (isProjectRemoved(name, config)) out.add(name);
  return out;
}

/** Create and start refuse a project that left Paseo, with a message that says so. */
export function assertProjectInPaseo(project: string | null | undefined, config?: KanbanConfig): void {
  const name = project?.trim();
  if (name && isProjectRemoved(name, config)) throw new KanbanError("project_removed", t("paseoProjects.removed", { project: name }));
}
