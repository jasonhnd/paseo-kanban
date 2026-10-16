/// <reference types="node" />
import { execFileSync } from "node:child_process";
import { readFileSync } from "./perf-fs";
import { isAbsolute, join, resolve } from "node:path";
import { dataDir } from "./paths";

/** Accepted repository identities: OWNER/REPO or a GitHub HTTPS/SSH origin. */
/** An owner or repo segment made only of dots ("." or "..") would walk out of repos/OWNER/REPO in an API path. */
export function dotSegment(segment: string): boolean {
  return /^\.+$/.test(segment);
}

export function githubRepository(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim().replace(/\/$/, "").replace(/\.git$/i, "");
  const match = text.match(/^(?:https?:\/\/github\.com\/|ssh:\/\/(?:git@)?github\.com\/|git@github\.com:)?([\w.-]+\/[\w.-]+)$/i);
  const slug = match?.[1] ?? null;
  return slug && !slug.split("/").some(dotSegment) ? slug : null;
}

const origins = new Map<string, string | null>();

/** Local git config only; no network call. Cache missing origins as well as hits. */
export function originRepository(path: string): string | null {
  const directory = resolve(path);
  if (origins.has(directory)) return origins.get(directory) ?? null;
  let repo: string | null = null;
  try {
    repo = githubRepository(execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: directory, encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "pipe"],
    }));
  } catch {
    // No origin or unreadable directory: there is no proven GitHub repository.
  }
  origins.set(directory, repo);
  return repo;
}

export interface ProjectRepoContext {
  project: string;
  workspacePath: string | null;
}

/** Contract repo is resolved by the caller before falling back to this project identity. */
export function projectRepository(context: ProjectRepoContext): string | null {
  let config: Record<string, unknown> = {};
  try {
    const raw = JSON.parse(readFileSync(join(dataDir(), "kanban.config.json"), "utf8"));
    const row = raw?.projects?.[context.project];
    if (row && typeof row === "object" && !Array.isArray(row)) config = row;
  } catch {
    // Older or absent configuration still works through the card's checkout.
  }
  const configured = config.repo ?? config.repository;
  const path = config.workspacePath ?? config.workspace ?? context.workspacePath;
  if (typeof path !== "string" || !path.trim() || path === "none") return githubRepository(configured);
  const directory = /^(?:worktree|lane):/.test(path)
    ? path.replace(/^(?:worktree|lane):/, "").replace(/@[^/]+$/, "")
    : path.replace(/^dir:/, "");
  // A relative path would resolve against the process cwd, which is not the project.
  if (!isAbsolute(directory)) return githubRepository(configured);
  const origin = originRepository(directory);
  // A local-only checkout without a GitHub origin must never acquire a PR dependency.
  if (!origin) return null;
  return configured != null ? githubRepository(configured) : origin;
}
