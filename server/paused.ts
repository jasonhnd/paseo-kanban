/// <reference types="node" />
import { readFileSync, statSync } from "node:fs";
import { cockpitStateFile } from "./afc-sources";

const FILE_NAME = "paused-projects.json";

/**
 * Read only: AFC owns this file. The board never creates, repairs or rewrites it.
 * ROLES_STATE_DIR (the same override AFC's command line uses) first; null when no cockpit state directory has it.
 */
export function pausedProjectsPath(): string | null {
  return cockpitStateFile(FILE_NAME);
}

interface Snapshot {
  key: string;
  projects: ReadonlySet<string>;
}

const NONE: ReadonlySet<string> = new Set();
let cached: Snapshot | null = null;
let lastLogged: string | null = null;

/** A bad file is logged once per distinct problem, not once per wake. */
function logOnce(message: string): void {
  if (message === lastLogged) return;
  lastLogged = message;
  console.error("[paseo-kanban] paused-projects", message);
}

function parse(raw: string): ReadonlySet<string> {
  const rows: unknown = JSON.parse(raw);
  if (!Array.isArray(rows)) throw new Error("not an array");
  const names = rows
    .map((row) => (row && typeof row === "object" ? (row as { project?: unknown }).project : undefined))
    .filter((name): name is string => typeof name === "string" && name.trim() !== "")
    .map((name) => name.trim());
  return new Set(names);
}

/**
 * Projects the user paused in AFC. A missing file means nothing is paused; an unreadable or
 * malformed one is treated the same way and logged, so a broken file never silences the board.
 */
export function readPausedProjects(): ReadonlySet<string> {
  const path = pausedProjectsPath();
  if (!path) {
    cached = null;
    return NONE;
  }
  let key: string;
  try {
    const stat = statSync(path);
    key = `${path}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  } catch (err) {
    cached = null;
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") logOnce(`${path} cannot be read: ${err instanceof Error ? err.message : String(err)}`);
    return NONE;
  }
  if (cached?.key === key) return cached.projects;
  try {
    const projects = parse(readFileSync(path, "utf8"));
    cached = { key, projects };
    lastLogged = null;
    return projects;
  } catch (err) {
    cached = null;
    logOnce(`${path} is malformed, treating nothing as paused: ${err instanceof Error ? err.message : String(err)}`);
    return NONE;
  }
}

export function isProjectPaused(project: string | null | undefined): boolean {
  return Boolean(project) && readPausedProjects().has(project!.trim());
}
