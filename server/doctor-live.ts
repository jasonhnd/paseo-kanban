/// <reference types="node" />
import { removedProjects } from "./paseo-projects";
import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "./perf-fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import { createPaseoClient } from "@getpaseo/client";
import { t } from "../shared/i18n";
import { parsePluginJson } from "./compat";
import { doctorSettings, loadConfigForReport, type DoctorSettings } from "./config";
import { getReadOnlyDb } from "./db";
import {
  parseWorktreePorcelain,
  readLastDoctorReport,
  remoteTipFromLs,
  runDoctor,
  type DoctorAgent,
  type DoctorBoard,
  type DoctorDirs,
  type DoctorGit,
  type DoctorPrResult,
  type DoctorSources,
  type DoctorWorkspace,
  type DoctorWorktree,
} from "./doctor";
import { type GitResult, runGit } from "./git";
import { readSchedulerTickAt } from "./liveness";
import { loadDispatchMatrix } from "./matrix";
import { PLACEHOLDER_NAME, placeholderAgentIdsFromText, scanProblemAgents } from "./missing-cwd";
import { agentsDir } from "./open";
import { listActivePaseoAgents, listPaseoWorkspaces } from "./paseo";
import { checkoutsRoot, paseoWorktreesRoot } from "./paths";
import { samePath } from "./placement";
import { readPoolSnapshot } from "./pools";
import { cockpitHealth } from "./afc-sources";

const PASEO_BIN = join(homedir(), ".local", "bin", "paseo");

let running = false;

function within<T>(work: Promise<T>, ms: number): Promise<T> {
  if (ms <= 0) return Promise.reject(new Error(t("doctorLive.timeout")));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(t("doctorLive.timeout"))), ms);
    (timer as unknown as { unref?: () => void }).unref?.();
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

function command(cmd: string, args: string[], cwd: string | undefined, timeoutMs: number): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout: timeoutMs, maxBuffer: 1_000_000 }, (err, stdout, stderr) => {
      if (!err) {
        resolve({ code: 0, stdout: String(stdout), stderr: String(stderr) });
        return;
      }
      const raw = err as { code?: unknown };
      const code = typeof raw.code === "number" ? raw.code : 1;
      resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr || err.message) });
    });
  });
}

function rememberRepo(found: string[], path: string): void {
  if (!path.trim() || !existsSync(path)) return;
  try {
    if (!statSync(path).isDirectory()) return;
  } catch {
    return;
  }
  if (found.some((dir) => samePath(dir, path))) return;
  found.push(path);
}

function configuredCheckout(name: string, workspaces: DoctorWorkspace[]): string {
  const fromPaseo = workspaces.find((workspace) => {
    if (workspace.archived || workspace.kind === "worktree" || !workspace.projectRoot) return false;
    if (workspace.name === name) return true;
    if (basename(workspace.projectRoot) === name) return true;
    return workspace.directory != null && basename(workspace.directory) === name;
  });
  return fromPaseo?.projectRoot ?? join(checkoutsRoot(), name);
}

/** Configured project checkouts first, then directories already recorded on cards. */
export function collectRepoRoots(workspaces: DoctorWorkspace[] = []): {
  repos: string[];
  missing: Array<{ project: string; path: string }>;
  skipped: Array<{ project: string; path: string }>;
} {
  const repos: string[] = [];
  const missing: Array<{ project: string; path: string }> = [];
  const skipped: Array<{ project: string; path: string }> = [];
  let unfinishedProjects: Set<string> | null = null;
  try {
    const rows = getReadOnlyDb().prepare(
      "SELECT DISTINCT project FROM tasks WHERE status NOT IN ('done', 'archived')",
    ).all() as Array<{ project: string }>;
    unfinishedProjects = new Set(rows.map((row) => row.project));
  } catch (err) {
    // Unknown card state must not make a missing checkout look safely unused.
    console.error("[paseo-kanban] doctor unfinished projects", err instanceof Error ? err.message : err);
  }
  const config = loadConfigForReport();
  let leftPaseo: ReadonlySet<string> = new Set();
  try { leftPaseo = removedProjects(config); } catch (err) { console.error("[paseo-kanban] doctor removed projects", err instanceof Error ? err.message : String(err)); }
  for (const name of Object.keys(config.projects ?? {})) {
    if (leftPaseo.has(name)) continue;
    const path = configuredCheckout(name, workspaces);
    try {
      if (!statSync(path).isDirectory()) {
        missing.push({ project: name, path });
        continue;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT" && unfinishedProjects != null && !unfinishedProjects.has(name)) {
        skipped.push({ project: name, path });
      } else {
        missing.push({ project: name, path });
      }
      continue;
    }
    rememberRepo(repos, path);
  }
  try {
    const db = getReadOnlyDb();
    const rows = db.prepare(
      `SELECT workspace_path FROM tasks WHERE workspace_kind = 'dir' AND workspace_path IS NOT NULL`,
    ).all() as Array<{ workspace_path: string }>;
    for (const row of rows) rememberRepo(repos, row.workspace_path);
    const events = db.prepare(`SELECT data_json FROM events WHERE kind = 'worktree_created'`).all() as Array<{ data_json: string }>;
    for (const event of events) {
      try {
        const data = JSON.parse(event.data_json) as { root?: unknown };
        if (typeof data.root === "string") rememberRepo(repos, data.root);
      } catch {
        // a broken event is not a repo
      }
    }
  } catch (err) {
    console.error("[paseo-kanban] doctor repos", err instanceof Error ? err.message : err);
  }
  return { repos, missing, skipped };
}

function gitApi(timeoutFor: () => number, repos: string[]): DoctorGit {
  const listed = new Map<string, Promise<DoctorWorktree[]>>();
  const tip = async (repo: string, branch: string): Promise<string | "unknown"> => {
    const timeoutMs = timeoutFor();
    if (timeoutMs <= 0) return "unknown";
    const result = await runGit(repo, ["rev-parse", "--verify", `refs/heads/${branch}`], (cwd, args) => command("git", args, cwd, timeoutMs));
    if (result.code !== 0) return "unknown";
    const sha = result.stdout.trim();
    return /^[0-9a-f]{7,64}$/i.test(sha) ? sha : "unknown";
  };
  return {
    repos,
    worktrees(repo: string): Promise<DoctorWorktree[]> {
      const hit = listed.get(repo);
      if (hit) return hit;
      const pending = (async () => {
        const timeoutMs = timeoutFor();
        if (timeoutMs <= 0) throw new Error(t("doctorLive.timeout"));
        const result = await runGit(repo, ["worktree", "list", "--porcelain"], (cwd, args) => command("git", args, cwd, timeoutMs));
        if (result.code !== 0) throw new Error((result.stderr || result.stdout || t("doctorLive.worktreeListFailed")).trim());
        return parseWorktreePorcelain(result.stdout);
      })();
      listed.set(repo, pending);
      return pending;
    },
    async dirty(path: string): Promise<boolean | "unknown"> {
      const timeoutMs = timeoutFor();
      if (timeoutMs <= 0) return "unknown";
      const result = await runGit(path, ["status", "--porcelain"], (cwd, args) => command("git", args, cwd, timeoutMs));
      if (result.code !== 0) return "unknown";
      return result.stdout.trim().length > 0;
    },
    async branches(repo: string): Promise<string[]> {
      const timeoutMs = timeoutFor();
      if (timeoutMs <= 0) throw new Error(t("doctorLive.timeout"));
      const result = await runGit(repo, ["branch", "--list", "kanban/*"], (cwd, args) => command("git", args, cwd, timeoutMs));
      if (result.code !== 0) throw new Error((result.stderr || result.stdout || t("doctorLive.branchFailed")).trim());
      return result.stdout
        .split(/\r?\n/)
        .map((line) => line.trim().replace(/^\* /, ""))
        .filter((line) => line.startsWith("kanban/"));
    },
    tip,
    async pushed(repo: string, branch: string): Promise<boolean | "unknown"> {
      const local = await tip(repo, branch);
      if (local === "unknown") return "unknown";
      const timeoutMs = timeoutFor();
      if (timeoutMs <= 0) return "unknown";
      const result = await runGit(repo, ["ls-remote", "--heads", "origin", `refs/heads/${branch}`], (cwd, args) =>
        command("git", args, cwd, timeoutMs),
      );
      if (result.code !== 0) return "unknown";
      const remote = remoteTipFromLs(result.stdout, branch);
      if (!remote) return false;
      return local === remote;
    },
    async pr(repo: string, branch: string): Promise<DoctorPrResult> {
      const timeoutMs = timeoutFor();
      if (timeoutMs <= 0) return "unknown";
      const result = await command(
        "gh",
        ["pr", "list", "--head", branch, "--state", "all", "--json", "state,mergedAt,headRefOid", "--limit", "5"],
        repo,
        timeoutMs,
      );
      if (result.code !== 0) return "unknown";
      try {
        const data = JSON.parse(result.stdout) as Array<{ state?: unknown; mergedAt?: unknown; headRefOid?: unknown }>;
        if (!Array.isArray(data)) return "unknown";
        if (data.length === 0) return "none";
        const merged = data.find((item) => item.mergedAt || item.state === "MERGED");
        if (merged) {
          const headOid = typeof merged.headRefOid === "string" && merged.headRefOid ? merged.headRefOid : null;
          return { state: "merged", headOid };
        }
        if (data.some((item) => item.state === "OPEN")) return "open";
        if (data.some((item) => item.state === "CLOSED")) return "closed";
        return "unknown";
      } catch {
        return "unknown";
      }
    },
  };
}

function scanWorktreeDirs(root: string): { paths: string[]; error?: string; unread: string[] } {
  const unread: string[] = [];
  const out: string[] = [];
  let top: string[] = [];
  try {
    top = readdirSync(root, { withFileTypes: true, encoding: "utf8" }).flatMap((entry) => (entry.isDirectory() ? [entry.name] : []));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { paths: [], unread };
    return { paths: [], error: `${root}: ${readFailure(err)}`, unread: [root] };
  }
  // Paseo owns the first-level project buckets, including empty ones.
  // Only their immediate children are worktree or placeholder candidates.
  for (const name of top) {
    const project = join(root, name);
    try {
      const children = readdirSync(project, { withFileTypes: true, encoding: "utf8" });
      for (const entry of children) {
        if (entry.isDirectory()) out.push(join(project, entry.name));
      }
    } catch (err) {
      unread.push(project);
      console.error("[paseo-kanban] doctor dir", project, readFailure(err));
    }
  }
  return { paths: out, unread };
}

function placeholderAgents(dir: string): string[] | null | "unknown" {
  const readme = join(dir, PLACEHOLDER_NAME);
  let text: string;
  try {
    text = readFileSync(readme, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    console.error("[paseo-kanban] doctor placeholder", readme, readFailure(err));
    return "unknown";
  }
  return placeholderAgentIdsFromText(text);
}

function newest(values: Array<string | null | undefined>): string | null {
  let best: string | null = null;
  let bestMs = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (!value) continue;
    const ms = Date.parse(value);
    if (!Number.isFinite(ms) || ms < bestMs) continue;
    bestMs = ms;
    best = value;
  }
  return best;
}

function readFailure(err: unknown): string {
  return err instanceof Error ? err.message : t("doctorLive.unreadable");
}

function diskAgents(): { agents: DoctorAgent[]; error?: string } {
  const root = agentsDir();
  const found: DoctorAgent[] = [];
  const errors: string[] = [];
  let dirs: string[] = [];
  try {
    dirs = readdirSync(root);
  } catch (err) {
    return { agents: found, error: readFailure(err) };
  }
  for (const dir of dirs) {
    const provider = join(root, dir);
    let names: string[] = [];
    try {
      names = readdirSync(provider);
    } catch (err) {
      errors.push(`${provider}: ${readFailure(err)}`);
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const file = join(provider, name);
      try {
        const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          errors.push(t("doctorLive.notAgentRecord", { file }));
          continue;
        }
        const data = parsed as Record<string, unknown>;
        const id = typeof data.id === "string" && data.id ? data.id : name.slice(0, -".json".length);
        const labels =
          data.labels && typeof data.labels === "object" && !Array.isArray(data.labels) ? (data.labels as Record<string, string>) : {};
        const attention = typeof data.attentionTimestamp === "string" ? data.attentionTimestamp : null;
        const activity = typeof data.lastActivityAt === "string" ? data.lastActivityAt : null;
        const updated = typeof data.updatedAt === "string" ? data.updatedAt : null;
        found.push({
          id,
          title: typeof data.title === "string" ? data.title : null,
          archived: typeof data.archivedAt === "string" && data.archivedAt.length > 0,
          cwd: typeof data.cwd === "string" ? data.cwd : "",
          labels,
          status: typeof data.lastStatus === "string" ? data.lastStatus : null,
          idleSince: newest([attention, activity, updated]),
        });
      } catch (err) {
        errors.push(`${file}: ${readFailure(err)}`);
      }
    }
  }
  return { agents: found, ...(errors.length > 0 ? { error: errors.join(t("common.semicolon")) } : {}) };
}

function mergeAgents(
  disk: { agents: DoctorAgent[]; error?: string },
  api: Array<{ id: string; archived: boolean; workspaceId: string | null }> | null,
  apiError?: string,
): DoctorSources["agents"] {
  const agents = disk.agents.map((agent) => ({ ...agent }));
  if (api) {
    const byId = new Map(agents.map((agent) => [agent.id, agent]));
    for (const item of api) {
      if (item.archived) continue;
      const found = byId.get(item.id);
      if (found) {
        found.archived = false;
        found.workspaceId = item.workspaceId ?? found.workspaceId ?? null;
      } else {
        const created = { id: item.id, archived: false, cwd: null, workspaceId: item.workspaceId };
        agents.push(created);
        byId.set(item.id, created);
      }
    }
  }
  const error = [apiError, disk.error].filter((item) => item).join(t("common.semicolon"));
  return {
    agents,
    ...(api ? { paseoIds: api.filter((item) => !item.archived).map((item) => item.id) } : {}),
    ...(error ? { error } : {}),
  };
}

function unreadableBoard(): DoctorBoard {
  let tickAt: string | null = null;
  try {
    tickAt = readSchedulerTickAt();
  } catch {
    tickAt = null;
  }
  return {
    plugin: "unknown",
    quota: "unknown",
    quotaAgeMs: null,
    matrix: "unknown",
    matrixAgeMs: null,
    tickAt,
    missingCwdCount: "unknown",
  };
}

/**
 * parsePluginJson's "plugin not running" detail names the status field in both languages (key compat.plugin.jsonStatus),
 * so "status" matches either. Keep accepting the Chinese word for "state" that older details used.
 */
const LEGACY_STATE_WORD = "\u72b6\u6001";

async function boardSnapshot(now: number, deadline: number): Promise<DoctorBoard> {
  // Tests set this so a failed snapshot is not stored as "files are missing".
  if (process.env.KANBAN_DOCTOR_BOARD_FAIL === "1") throw new Error(t("doctorLive.boardSnapshotFailed"));
  const settings = doctorSettings(loadConfigForReport());
  let plugin: DoctorBoard["plugin"] = "unknown";
  try {
    const bin = existsSync(PASEO_BIN) ? PASEO_BIN : "paseo";
    const wait = Math.min(settings.commandTimeoutMs, deadline - Date.now());
    const result = wait > 0 ? await command(bin, ["plugin", "ls", "--json"], undefined, wait) : { code: 1, stdout: "", stderr: t("doctorLive.timeout") };
    if (result.code === 0) {
      const parsed = parsePluginJson(result.stdout);
      plugin = parsed.ok ? "running" : parsed.detail.includes("status") || parsed.detail.includes(LEGACY_STATE_WORD) ? "stopped" : "unknown";
    }
  } catch {
    plugin = "unknown";
  }
  const pools = readPoolSnapshot(now);
  const quotaAge = pools.ageMs ?? null;
  let quota: DoctorBoard["quota"] = "fresh";
  if (pools.state === "missing") quota = pools.failure === "absent" ? "missing" : "unknown";
  else if (pools.state === "stale" || (quotaAge != null && quotaAge > settings.quotaStaleMs)) quota = "stale";
  const matrix = loadDispatchMatrix(now);
  let matrixState: DoctorBoard["matrix"] = "ok";
  let matrixAgeMs: number | null = null;
  if (matrix.state === "missing") matrixState = "missing";
  else if (matrix.state === "invalid") matrixState = matrix.updatedAt == null ? "unknown" : "invalid";
  else {
    const generated = matrix.matrix.generatedAt ? Date.parse(matrix.matrix.generatedAt) : Number.NaN;
    if (Number.isFinite(generated)) {
      matrixAgeMs = Math.max(0, now - generated);
      if (matrixAgeMs > settings.matrixStaleMs) matrixState = "stale";
    }
  }
  let missingCwdCount: number | "unknown" = "unknown";
  if (Date.now() < deadline) {
    try {
      missingCwdCount = scanProblemAgents().filter((item) => item.state === "missing").length;
    } catch {
      missingCwdCount = "unknown";
    }
  }
  return {
    plugin,
    quota,
    quotaAgeMs: quotaAge,
    matrix: matrixState,
    matrixAgeMs,
    tickAt: readSchedulerTickAt(),
    missingCwdCount,
    contracts: cockpitHealth(new Date(now)),
    policyRequired: true,
  };
}

function timedOutSources(partial: DoctorSources): DoctorSources {
  partial.collectError = partial.collectError ?? t("doctorLive.totalTimeout.repos");
  return partial;
}

/** Snapshots only. Listing workspaces and agents does not archive or create anything. */
export async function collectLiveSources(paseo: PaseoApi | null, now = Date.now(), deadline = now + doctorSettings(loadConfigForReport()).totalTimeoutMs): Promise<DoctorSources> {
  const settings = doctorSettings(loadConfigForReport());
  const sources: DoctorSources = {};
  const remain = () => deadline - Date.now();
  if (remain() <= 0) return timedOutSources(sources);
  if (paseo) {
    try {
      sources.workspaces = await within(listPaseoWorkspaces(paseo), remain());
    } catch (err) {
      sources.workspaceError = err instanceof Error ? err.message : String(err);
      sources.workspaces = [];
    }
    if (remain() <= 0) return timedOutSources(sources);
    try {
      const active = await within(listActivePaseoAgents(paseo), remain());
      const disk = remain() > 0 ? diskAgents() : { agents: [], error: t("doctorLive.totalTimeout.agents") };
      sources.agents = mergeAgents(disk, active);
    } catch (err) {
      const disk = remain() > 0 ? diskAgents() : { agents: [], error: t("doctorLive.totalTimeout.agents") };
      sources.agents = mergeAgents(disk, null, err instanceof Error ? err.message : String(err));
    }
  } else {
    sources.workspaceError = t("doctorLive.noPaseo");
    sources.workspaces = [];
    sources.agents = mergeAgents(remain() > 0 ? diskAgents() : { agents: [], error: t("doctorLive.totalTimeout") }, null, t("doctorLive.noPaseo"));
  }
  if (remain() <= 0) return timedOutSources(sources);
  const collected = collectRepoRoots(sources.workspaces ?? []);
  sources.missingRepos = collected.missing;
  sources.skippedRepos = collected.skipped;
  const git = gitApi(() => Math.min(settings.commandTimeoutMs, remain()), collected.repos);
  sources.git = git;
  const root = paseoWorktreesRoot();
  const worktrees: string[] = [];
  // A configured checkout we could not open was not listed. An empty walk is not proof those worktrees are gone.
  let listedOk = collected.missing.length === 0;
  let stopped = false;
  for (const repo of collected.repos) {
    const wait = remain();
    if (wait <= 0) {
      stopped = true;
      listedOk = false;
      sources.collectError = t("doctorLive.totalTimeout.repos");
      break;
    }
    try {
      for (const tree of await within(git.worktrees(repo), wait)) worktrees.push(tree.path);
    } catch (err) {
      listedOk = false;
      console.error("[paseo-kanban] doctor worktree", repo, err instanceof Error ? err.message : err);
    }
  }
  if (!listedOk || stopped) {
    // Git could not be listed. An empty list must not look like a finished scan.
    sources.dirs = { root, worktrees: [], list: () => [], placeholderAgents, scanned: false };
  } else if (remain() <= 0) {
    sources.dirs = { root, worktrees: [], list: () => [], placeholderAgents, scanned: false };
    sources.collectError = t("doctorLive.totalTimeout.repos");
  } else {
    const walked = scanWorktreeDirs(root);
    sources.dirs = {
      root,
      worktrees,
      list: () => walked.paths,
      placeholderAgents,
      scanned: !walked.error,
      ...(walked.error ? { scanError: walked.error } : {}),
      ...(walked.unread.length > 0 ? { unread: walked.unread } : {}),
    };
  }
  if (remain() <= 0) return timedOutSources(sources);
  try {
    sources.board = await within(boardSnapshot(now, deadline), remain());
  } catch (err) {
    sources.board = unreadableBoard();
    console.error("[paseo-kanban] doctor board", err instanceof Error ? err.message : err);
  }
  return sources;
}

export async function connectAndCollect(env: NodeJS.ProcessEnv = process.env, deadline = Date.now() + doctorSettings(loadConfigForReport()).totalTimeoutMs): Promise<DoctorSources> {
  const wait = deadline - Date.now();
  if (wait <= 0) return timedOutSources({ workspaces: [], workspaceError: t("doctorLive.timeout"), agents: { agents: [], error: t("doctorLive.timeout") } });
  const url = env.PASEO_URL ?? "ws://127.0.0.1:6767/ws";
  const client = createPaseoClient({ url, reconnect: { enabled: false }, connectTimeoutMs: Math.min(8_000, wait) });
  try {
    await within(client.connect(), wait);
  } catch (err) {
    await client.close().catch(() => undefined);
    if (Date.now() >= deadline) {
      return timedOutSources({
        workspaces: [],
        workspaceError: err instanceof Error ? err.message : String(err),
        agents: { agents: [], error: t("doctorLive.timeout") },
      });
    }
    const sources = await collectLiveSources(null, Date.now(), deadline);
    sources.workspaceError = err instanceof Error ? err.message : String(err);
    if (sources.agents) sources.agents.error = sources.workspaceError;
    return sources;
  }
  try {
    return await collectLiveSources(client, Date.now(), deadline);
  } finally {
    await client.close().catch(() => undefined);
  }
}

let lastStartedAt = Number.NEGATIVE_INFINITY;

export function resetDoctorLiveForTests(): void {
  running = false;
  lastStartedAt = Number.NEGATIVE_INFINITY;
}

/** Scheduler entry. Skips when the last scheduled run is still inside doctor.intervalMs. */
export async function maybeRunScheduledDoctor(
  now = new Date(),
  hooks?: { collect?: (env: NodeJS.ProcessEnv, deadline: number) => Promise<DoctorSources>; settings?: DoctorSettings },
): Promise<void> {
  if (running) return;
  const settings = hooks?.settings ?? doctorSettings(loadConfigForReport());
  const last = readLastDoctorReport();
  const stamp = last?.schedulerAt ? Date.parse(last.schedulerAt) : Number.NaN;
  if (Number.isFinite(stamp) && now.getTime() - stamp < settings.intervalMs) return;
  // The start is stamped too: a run that times out never writes a report, and must not be retried on every kick.
  const sinceStart = now.getTime() - lastStartedAt;
  if (sinceStart >= 0 && sinceStart < settings.intervalMs) return;
  lastStartedAt = now.getTime();
  running = true;
  // A timeout stops waiting, not the work. `running` is released only once the work itself has settled,
  // so a stuck collection cannot pile up a second one behind it.
  const underlying: Array<Promise<unknown>> = [];
  let unsettled = 0;
  const track = <T>(work: Promise<T>): Promise<T> => {
    unsettled += 1;
    underlying.push(work);
    const done = (): void => { unsettled -= 1; };
    work.then(done, done);
    return work;
  };
  try {
    const deadline = now.getTime() + settings.totalTimeoutMs;
    const collect = hooks?.collect ?? ((env: NodeJS.ProcessEnv, until: number) => connectAndCollect(env, until));
    let sources: DoctorSources;
    try {
      const wait = Math.min(settings.totalTimeoutMs, Math.max(1, deadline - Date.now()));
      sources = await within(track(collect(process.env, deadline)), wait);
    } catch (err) {
      sources = timedOutSources({
        workspaces: [],
        workspaceError: err instanceof Error ? err.message : String(err),
        agents: { agents: [], error: t("doctorLive.totalTimeout") },
      });
    }
    const left = Math.max(1, Math.min(settings.totalTimeoutMs, deadline - Date.now()));
    await within(track(runDoctor({ now, settings: { ...settings, totalTimeoutMs: left }, sources, wake: true, persist: true })), left + 500);
  } catch (err) {
    console.error("[paseo-kanban] doctor", err instanceof Error ? err.message : err);
  } finally {
    if (unsettled === 0) running = false;
    else void Promise.allSettled(underlying).then(() => { running = false; });
  }
}
