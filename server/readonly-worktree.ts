import { cpSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { t } from "../shared/i18n";
import { roleLabel } from "../shared/labels";
import { cardMark } from "./card-ref";
import { getDb } from "./db";
import { headRef, originRef, refOk, runGit, type GitResult, type GitRunner } from "./git";
import { dataDir } from "./paths";
import { addComment, appendEvent, getTask } from "./store";

async function wakeLeader(taskId: number, sentence: string): Promise<void> {
  // wake.ts registers a store listener at load time. Importing it here would cycle through worktree-record.
  const { notifyReadOnlyLeftovers } = await import("./wake");
  notifyReadOnlyLeftovers(taskId, sentence);
}

/** Inspection branches are disposable snapshots, never execution/landing branches. */
export function readOnlyBranchName(taskId: number): string {
  return `kanban-readonly/${cardMark(taskId)}`;
}

export const READONLY_CLEAN_BASE = "readonly_clean_base";
export const READONLY_CLEAN_ON_ORIGIN = "readonly_clean_on_origin";
export const READONLY_LEFTOVERS = "readonly_leftovers";

const SHA = /^[0-9a-f]{40,64}$/i;

/** Ignored files (generated output, local env files) are discarded with the copy; this event lists them for later lookup. */
export const READONLY_IGNORED_DROPPED = "readonly_ignored_dropped";
const IGNORED_LISTED_MAX = 50;
/** One export may copy at most this many bytes of untracked files and diff. Override with KANBAN_READONLY_EXPORT_MAX_BYTES. */
export const READONLY_EXPORT_MAX_BYTES = 256 * 1024 * 1024;

function exportLimit(): number {
  const value = Number(process.env.KANBAN_READONLY_EXPORT_MAX_BYTES);
  return Number.isFinite(value) && value > 0 ? value : READONLY_EXPORT_MAX_BYTES;
}

function treeBytes(path: string): number {
  const info = lstatSync(path);
  if (!info.isDirectory()) return info.size;
  let total = 0;
  for (const name of readdirSync(path)) total += treeBytes(join(path, name));
  return total;
}

export interface ReadOnlyCopy {
  directory: string;
  root: string;
  branch: string;
  head?: string;
}

interface OriginSnapshot {
  /** Empty when this repo has no origin, or origin has no branches. */
  oids: string[];
}

type Classified =
  | { kind: "clean"; reason: typeof READONLY_CLEAN_BASE | typeof READONLY_CLEAN_ON_ORIGIN; head: string; branchTip: string | null }
  | { kind: "local"; head: string; branchTip: string | null; dirty: boolean; exclude: string[] }
  | { kind: "error"; error: string };

function gitFail(result: GitResult, fallback: string): string {
  return (result.stderr || result.stdout || fallback).trim();
}

function norm(value: string): string {
  return value.trim().toLowerCase();
}

function safeSha(value: string | undefined): string | null {
  if (!value) return null;
  const sha = norm(value);
  return SHA.test(sha) ? sha : null;
}

function lines(stdout: string): string[] {
  return stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function eventRows(taskId: number, kind: string): Array<{ data_json: string }> {
  return getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = ? ORDER BY id").all(taskId, kind) as Array<{
    data_json: string;
  }>;
}

function hasEvent(taskId: number, kind: string): boolean {
  return eventRows(taskId, kind).length > 0;
}

/** Branch tips already inspected or saved. A later delete can match these without exporting again. */
function acceptedTips(taskId: number): Set<string> {
  const tips = new Set<string>();
  for (const kind of [READONLY_LEFTOVERS, "readonly_cleanup"]) {
    for (const row of eventRows(taskId, kind)) {
      try {
        const data = JSON.parse(row.data_json) as { branchTip?: unknown; head?: unknown };
        for (const value of [data.branchTip, data.head]) {
          if (typeof value === "string" && SHA.test(value)) tips.add(norm(value));
        }
      } catch {
        // ignore a broken event
      }
    }
  }
  return tips;
}

async function readSha(cwd: string, args: string[], run: GitRunner, unreadable: string): Promise<{ sha: string } | { missing: true } | { error: string }> {
  const result = await run(cwd, args);
  if (result.code !== 0) {
    const text = `${result.stderr}\n${result.stdout}`;
    if (result.code === 1 || /unknown revision|not a valid|ambiguous argument|needed a single revision/i.test(text)) return { missing: true };
    return { error: unreadable };
  }
  const sha = safeSha(result.stdout);
  return sha ? { sha } : { error: unreadable };
}

async function originSnapshot(root: string, run: GitRunner): Promise<OriginSnapshot | { error: string }> {
  const remotes = await run(root, ["remote"]);
  if (remotes.code !== 0) return { error: t("readonlyWorktree.origin.remoteUnreadable", { error: gitFail(remotes, t("readonlyWorktree.gitFailed", { command: "git remote" })) }) };
  if (!lines(remotes.stdout).includes("origin")) return { oids: [] };
  const listed = await run(root, ["ls-remote", "--heads", "origin"]);
  if (listed.code !== 0) return { error: t("readonlyWorktree.origin.listFailed", { error: gitFail(listed, t("readonlyWorktree.gitFailed", { command: "git ls-remote" })) }) };
  const heads: Array<{ name: string; oid: string }> = [];
  for (const line of lines(listed.stdout)) {
    const match = /^([0-9a-f]{40,64})\s+refs\/heads\/(\S+)$/i.exec(line);
    if (!match?.[1] || !match[2]) return { error: t("readonlyWorktree.origin.tipsIncomplete") };
    if (!refOk(match[2])) return { error: t("readonlyWorktree.origin.badName", { name: match[2] }) };
    heads.push({ name: match[2], oid: norm(match[1]) });
  }
  if (heads.length === 0) return { oids: [] };
  const fetched = await run(root, ["fetch", "--no-tags", "origin", "+refs/heads/*:refs/remotes/origin/*"]);
  if (fetched.code !== 0) return { error: t("readonlyWorktree.origin.fetchFailed", { error: gitFail(fetched, t("readonlyWorktree.gitFailed", { command: "git fetch" })) }) };
  const oids: string[] = [];
  for (const head of heads) {
    const fresh = await run(root, ["rev-parse", "--verify", originRef(head.name)]);
    if (fresh.code !== 0) return { error: t("readonlyWorktree.origin.tipUnreadable") };
    if (norm(fresh.stdout) !== head.oid) return { error: t("readonlyWorktree.origin.tipChanged") };
    oids.push(head.oid);
  }
  return { oids };
}

async function contained(root: string, sha: string, oids: string[], run: GitRunner): Promise<"yes" | "no" | { error: string }> {
  if (oids.includes(sha)) return "yes";
  for (const oid of oids) {
    const ancestor = await run(root, ["merge-base", "--is-ancestor", sha, oid]);
    if (ancestor.code === 0) return "yes";
    if (ancestor.code !== 1) return { error: t("readonlyWorktree.mergeBaseFailed", { error: gitFail(ancestor, t("readonlyWorktree.gitFailed", { command: "merge-base" })) }) };
  }
  return "no";
}

/**
 * Clean means there is nothing only this copy has: a clean worktree (including
 * untracked files) whose HEAD and readonly-branch tip are the creation baseline
 * or, after fetch, an ancestor or tip of some origin branch. Detached HEAD at
 * the same commit is clean. Anything else is local and must be saved first.
 */
export async function classifyReadOnlyCopy(copy: ReadOnlyCopy, run: GitRunner = runGit): Promise<Classified> {
  const baseline = safeSha(copy.head);
  if (!baseline) return { kind: "error", error: t("readonlyWorktree.copy.noBaseline") };
  const status = await run(copy.directory, ["status", "--porcelain", "--untracked-files=all"]);
  if (status.code !== 0) return { kind: "error", error: t("readonlyWorktree.copy.statusUnreadable") };
  const headRead = await readSha(copy.directory, ["rev-parse", "--verify", "HEAD"], run, t("readonlyWorktree.copy.headUnreadable"));
  if ("error" in headRead) return { kind: "error", error: headRead.error };
  if ("missing" in headRead) return { kind: "error", error: t("readonlyWorktree.copy.headUnreadable") };
  const tipRead = await readSha(copy.root, ["rev-parse", "--verify", "--quiet", headRef(copy.branch)], run, t("readonlyWorktree.branch.unreadable"));
  if ("error" in tipRead) return { kind: "error", error: tipRead.error };
  const head = headRead.sha;
  const branchTip = "sha" in tipRead ? tipRead.sha : null;
  const dirty = Boolean(status.stdout.trim());
  const needsOrigin = head !== baseline || (branchTip != null && branchTip !== baseline);
  let exclude: string[] = [];
  if (needsOrigin) {
    const origin = await originSnapshot(copy.root, run);
    if ("error" in origin) return { kind: "error", error: origin.error };
    exclude = origin.oids;
  }
  const headLocal = await isLocalCommit(copy.root, head, baseline, exclude, run);
  if (typeof headLocal === "object") return { kind: "error", error: headLocal.error };
  const tipLocal = branchTip == null || branchTip === head ? false : await isLocalCommit(copy.root, branchTip, baseline, exclude, run);
  if (typeof tipLocal === "object") return { kind: "error", error: tipLocal.error };
  if (!dirty && !headLocal && !tipLocal) {
    const reason = head === baseline && (branchTip == null || branchTip === baseline) ? READONLY_CLEAN_BASE : READONLY_CLEAN_ON_ORIGIN;
    return { kind: "clean", reason, head, branchTip };
  }
  return { kind: "local", head, branchTip, dirty, exclude };
}

/** True when this commit is neither the creation baseline nor on origin. */
async function isLocalCommit(
  root: string,
  sha: string,
  baseline: string,
  oids: string[],
  run: GitRunner,
): Promise<boolean | { error: string }> {
  if (sha === baseline) return false;
  const published = await contained(root, sha, oids, run);
  if (typeof published === "object") return published;
  return published === "no";
}

/** Ignored files and directories in the copy. The patch export never carries them; they go with the directory (d1007-091920-1). */
async function ignoredFiles(copy: ReadOnlyCopy, run: GitRunner): Promise<string[] | { error: string }> {
  const listed = await run(copy.directory, ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"]);
  if (listed.code !== 0) return { error: t("readonlyWorktree.copy.ignoredUnreadable", { error: gitFail(listed, t("readonlyWorktree.gitFailed", { command: "git ls-files" })) }) };
  return listed.stdout.split("\0").filter(Boolean);
}

/** Record once which ignored files are dropped with the copy. Listing failure never blocks cleanup. */
async function recordIgnoredDropped(taskId: number, copy: ReadOnlyCopy, run: GitRunner): Promise<void> {
  if (hasEvent(taskId, READONLY_IGNORED_DROPPED)) return;
  const files = await ignoredFiles(copy, run);
  if ("error" in files) {
    appendEvent(taskId, READONLY_IGNORED_DROPPED, null, null, "kanban", { error: files.error, directory: copy.directory });
    return;
  }
  if (files.length === 0) return;
  appendEvent(taskId, READONLY_IGNORED_DROPPED, null, null, "kanban", {
    files: files.slice(0, IGNORED_LISTED_MAX),
    count: files.length,
    directory: copy.directory,
  });
}

function leftoverDir(taskId: number): string {
  const mark = cardMark(taskId);
  const name = mark.includes("/") || mark.includes("..") || mark.startsWith(".") ? `task-${taskId}` : mark;
  return join(dataDir(), "readonly-leftovers", name);
}

function inside(root: string, relPath: string): string | null {
  if (!relPath || isAbsolute(relPath) || relPath.includes("\0")) return null;
  const dest = join(root, relPath);
  const back = relative(root, dest);
  if (back.startsWith("..") || isAbsolute(back)) return null;
  return dest;
}

async function nameList(cwd: string, args: string[], run: GitRunner): Promise<string[] | { error: string }> {
  const result = await run(cwd, args);
  if (result.code !== 0) return { error: t("readonlyWorktree.patch.failed", { error: gitFail(result, t("readonlyWorktree.gitFailed", { command: "git diff" })) }) };
  return lines(result.stdout);
}

async function formatUnique(
  cwd: string,
  baseline: string,
  until: string,
  dest: string,
  exclude: string[],
  run: GitRunner,
): Promise<{ commits: number; files: string[] } | { error: string }> {
  if (until === baseline) return { commits: 0, files: [] };
  const listed = await run(cwd, ["rev-list", "--reverse", until, "--not", baseline, ...exclude]);
  if (listed.code !== 0) return { error: t("readonlyWorktree.patch.failed", { error: gitFail(listed, t("readonlyWorktree.gitFailed", { command: "git rev-list" })) }) };
  const shas = lines(listed.stdout).map(norm).filter((sha) => SHA.test(sha));
  if (shas.length === 0) return { commits: 0, files: [] };
  const first = shas[0];
  if (!first) return { commits: 0, files: [] };
  const parent = await run(cwd, ["rev-parse", "--verify", `${first}^`]);
  const patch = parent.code === 0
    ? await run(cwd, ["format-patch", "-o", dest, `${norm(parent.stdout)}..${until}`])
    : await run(cwd, ["format-patch", "-o", dest, "--root", until]);
  if (patch.code !== 0) return { error: t("readonlyWorktree.patch.failed", { error: gitFail(patch, t("readonlyWorktree.gitFailed", { command: "git format-patch" })) }) };
  const from = parent.code === 0 ? norm(parent.stdout) : baseline;
  const names = await nameList(cwd, ["diff", "--name-only", from, until], run);
  if ("error" in names) return names;
  return { commits: shas.length, files: names };
}

function patchError(error: unknown): string {
  return t("readonlyWorktree.patch.failed", { error: error instanceof Error ? error.message : String(error) });
}

/** Replace finalDir with staging so a reader sees the old export or the new one, never a half-written directory. */
function swapIn(staging: string, finalDir: string, backup: string): void {
  rmSync(backup, { recursive: true, force: true });
  let moved = false;
  try {
    renameSync(finalDir, backup);
    moved = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    renameSync(staging, finalDir);
  } catch (error) {
    if (moved) renameSync(backup, finalDir);
    throw error;
  }
  if (moved) rmSync(backup, { recursive: true, force: true });
}

async function writeLeftovers(
  taskId: number,
  copy: ReadOnlyCopy,
  local: Extract<Classified, { kind: "local" }>,
  run: GitRunner,
): Promise<{ files: string[]; commits: number; path: string } | { error: string }> {
  const finalDir = leftoverDir(taskId);
  const staging = join(dataDir(), "readonly-leftovers", `.partial-${taskId}`);
  let published = false;
  try {
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    const baseline = safeSha(copy.head);
    if (!baseline) return { error: t("readonlyWorktree.copy.noBaseline") };
    const files = new Set<string>();
    let commits = 0;
    const headPatch = await formatUnique(copy.directory, baseline, local.head, staging, local.exclude, run);
    if ("error" in headPatch) return headPatch;
    commits += headPatch.commits;
    for (const file of headPatch.files) files.add(file);
    if (local.branchTip && local.branchTip !== local.head && local.branchTip !== baseline) {
      const branchDir = join(staging, "branch-tip");
      mkdirSync(branchDir, { recursive: true });
      const branchPatch = await formatUnique(copy.root, baseline, local.branchTip, branchDir, local.exclude, run);
      if ("error" in branchPatch) return branchPatch;
      commits += branchPatch.commits;
      for (const file of branchPatch.files) files.add(file);
    }
    const diff = await run(copy.directory, ["diff", "--binary", "HEAD"]);
    if (diff.code !== 0) return { error: t("readonlyWorktree.patch.failed", { error: gitFail(diff, t("readonlyWorktree.gitFailed", { command: "git diff" })) }) };
    let copied = Buffer.byteLength(diff.stdout);
    if (copied > exportLimit()) return { error: t("readonlyWorktree.patch.changesTooLarge", { limit: exportLimit() }) };
    if (diff.stdout.length > 0) writeFileSync(join(staging, "worktree.diff"), diff.stdout);
    const dirtyNames = await nameList(copy.directory, ["diff", "--name-only", "HEAD"], run);
    if ("error" in dirtyNames) return dirtyNames;
    for (const file of dirtyNames) files.add(file);
    const untracked = await run(copy.directory, ["ls-files", "--others", "--exclude-standard", "-z"]);
    if (untracked.code !== 0) return { error: t("readonlyWorktree.patch.failed", { error: gitFail(untracked, t("readonlyWorktree.gitFailed", { command: "git ls-files" })) }) };
    for (const relPath of untracked.stdout.split("\0").filter(Boolean)) {
      const src = inside(copy.directory, relPath);
      const dest = inside(join(staging, "untracked"), relPath);
      if (!src || !dest) return { error: t("readonlyWorktree.patch.badUntrackedPath", { path: relPath }) };
      copied += treeBytes(src);
      if (copied > exportLimit()) return { error: t("readonlyWorktree.patch.untrackedTooLarge", { limit: exportLimit() }) };
      mkdirSync(join(dest, ".."), { recursive: true });
      cpSync(src, dest, { recursive: true });
      files.add(relPath);
    }
    mkdirSync(join(finalDir, ".."), { recursive: true });
    const total = treeBytes(staging);
    if (total > exportLimit()) return { error: t("readonlyWorktree.patch.totalTooLarge", { total, limit: exportLimit() }) };
    swapIn(staging, finalDir, join(dataDir(), "readonly-leftovers", `.old-${taskId}`));
    published = true;
    return { files: [...files].sort(), commits, path: finalDir };
  } catch (error) {
    return { error: patchError(error) };
  } finally {
    if (!published) rmSync(staging, { recursive: true, force: true });
  }
}

function leftoversSentence(role: string, count: number, path: string): string {
  return t("readonlyWorktree.leftovers.sentence", { role: roleLabel(role), count, path });
}

function remember(
  taskId: number,
  kind: string,
  data: Record<string, unknown>,
): void {
  if (hasEvent(taskId, kind) && kind !== READONLY_LEFTOVERS) return;
  if (kind === READONLY_LEFTOVERS && hasEvent(taskId, kind)) return;
  appendEvent(taskId, kind, null, null, "kanban", data);
}

/**
 * Decide how a live read-only copy can be removed.
 * Local commits and uncommitted files are written under data/readonly-leftovers
 * before the caller deletes the directory. Export failure is the only keep.
 */
export async function captureReadOnlyCopy(
  task: { id: number; role: string },
  copy: ReadOnlyCopy,
  run: GitRunner = runGit,
): Promise<{ reason: string; branchTip: string | null } | { error: string }> {
  const found = await classifyReadOnlyCopy(copy, run);
  if (found.kind === "error") return { error: found.error };
  if (found.kind === "clean") {
    await recordIgnoredDropped(task.id, copy, run);
    remember(task.id, "readonly_cleanup", {
      reason: found.reason,
      head: found.head,
      branchTip: found.branchTip,
      directory: copy.directory,
    });
    return { reason: found.reason, branchTip: found.branchTip };
  }
  const saved = await writeLeftovers(task.id, copy, found, run);
  if ("error" in saved) return saved;
  await recordIgnoredDropped(task.id, copy, run);
  if (!hasEvent(task.id, READONLY_LEFTOVERS)) {
    const sentence = leftoversSentence(task.role, saved.files.length, saved.path);
    addComment(task.id, "kanban", sentence);
    appendEvent(task.id, READONLY_LEFTOVERS, null, null, "kanban", {
      files: saved.files,
      path: saved.path,
      commits: saved.commits,
      head: found.head,
      branchTip: found.branchTip,
      directory: copy.directory,
    });
    await wakeLeader(task.id, sentence);
  }
  return { reason: READONLY_LEFTOVERS, branchTip: found.branchTip };
}

/** Discard path: a clean copy can be deleted. Local work stays until archive cleanup saves it. */
export async function readOnlyCopyError(copy: ReadOnlyCopy, run: GitRunner = runGit): Promise<string | null> {
  const found = await classifyReadOnlyCopy(copy, run);
  if (found.kind === "error") return found.error;
  if (found.kind === "clean") return null;
  return found.dirty ? t("readonlyWorktree.copy.dirtyKept") : t("readonlyWorktree.copy.movedKept");
}

/**
 * Delete only this card's readonly ref. A tip that moved after inspection is
 * exported from the main repo first, so removing the worktree cannot drop it.
 */
export async function deleteReadOnlyBranch(taskId: number, copy: ReadOnlyCopy, run: GitRunner = runGit): Promise<string | null> {
  if (copy.branch !== readOnlyBranchName(taskId) || !safeSha(copy.head)) return t("readonlyWorktree.branch.notCard");
  const ref = headRef(copy.branch);
  const present = await run(copy.root, ["show-ref", "--verify", "--quiet", ref]);
  if (present.code === 1) return null;
  if (present.code !== 0) return t("readonlyWorktree.branch.unreadable");
  const tip = await readSha(copy.root, ["rev-parse", "--verify", ref], run, t("readonlyWorktree.branch.unreadable"));
  if ("error" in tip) return tip.error;
  if ("missing" in tip) return null;
  const baseline = safeSha(copy.head);
  if (!baseline) return t("readonlyWorktree.branch.notCard");
  const known = acceptedTips(taskId);
  known.add(baseline);
  if (!known.has(tip.sha)) {
    const origin = await originSnapshot(copy.root, run);
    if ("error" in origin) return origin.error;
    const published = await contained(copy.root, tip.sha, origin.oids, run);
    if (typeof published === "object") return published.error;
    if (published === "no") {
      const saved = await exportDetachedTip(taskId, copy, baseline, tip.sha, origin.oids, run);
      if (saved) return saved;
    }
  }
  const result = await run(copy.root, ["update-ref", "-d", ref, tip.sha]);
  return result.code === 0 ? null : gitFail(result, t("readonlyWorktree.branch.deleteFailed"));
}

async function exportDetachedTip(
  taskId: number,
  copy: ReadOnlyCopy,
  baseline: string,
  tip: string,
  exclude: string[],
  run: GitRunner,
): Promise<string | null> {
  const dest = join(leftoverDir(taskId), "branch-tip");
  try {
    mkdirSync(dest, { recursive: true });
    const saved = await formatUnique(copy.root, baseline, tip, dest, exclude, run);
    if ("error" in saved) return saved.error;
    if (!hasEvent(taskId, READONLY_LEFTOVERS)) {
      const task = getTask(taskId);
      const sentence = leftoversSentence(task.role, saved.files.length, leftoverDir(taskId));
      addComment(taskId, "kanban", sentence);
      appendEvent(taskId, READONLY_LEFTOVERS, null, null, "kanban", {
        files: saved.files,
        path: leftoverDir(taskId),
        commits: saved.commits,
        head: tip,
        branchTip: tip,
        directory: copy.directory,
      });
      await wakeLeader(taskId, sentence);
    } else {
      appendEvent(taskId, "readonly_cleanup", null, null, "kanban", { reason: READONLY_LEFTOVERS, branchTip: tip, head: tip });
    }
    return null;
  } catch (error) {
    return patchError(error);
  }
}
