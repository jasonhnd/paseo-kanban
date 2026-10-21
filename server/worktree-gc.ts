/// <reference types="node" />
import { existsSync, realpathSync } from "./perf-fs";
import { isAbsolute, relative, resolve } from "node:path";
import { translate, t } from "../shared/i18n";
import { agentsOpenedBy, nextRetryAt, readCleanupEvents, retryReady, waitReason, type CleanupRecord } from "./archive-book";
import { judgedWorktree } from "./branch-observed";
import { deleteSquashedBranch, headRef, isProtectedBranch, originRef, refOk, runGit, type GitResult, type GitRunner } from "./git";
import { canonicalPath, paseoWorktreesRoot } from "./paths";
import { samePath } from "./placement";
import { prByHead, prHeadOid, prMergeState, readContract } from "./pr";
import { directoryState, placeholderAfterRemoval, retainAgentsBeforeDirectoryRemoval, agentListUnreadReason, type AgentRunState, type CwdAgent } from "./missing-cwd";
import { appendEvent, getTask, type TaskRow } from "./store";
import { readWorktreeCreated } from "./worktree-record";
import { cleanupGeneration, cleanupMark, trackCleanupWork } from "./cleanup-state";
import { tempCleaned } from "./temp-mark";
import { branchOwnedByCard } from "./workspace";
import { readOnlyBranchName } from "./readonly-worktree";
import { projectWorkspace } from "./config";
import { integrationBranchContaining } from "./integration-branches";

export interface OwnedWorktree {
  directory: string;
  branch: string;
  base: string;
  root: string;
  readOnly?: boolean;
  head?: string;
}

interface CreatedEvent {
  directory?: string;
  branch?: string;
  base?: string;
  root?: string;
  readOnly?: boolean;
  head?: string;
}

const inflight = new Map<string, Promise<unknown>>();

export function resetWorktreeRemovalForTests(): void {
  inflight.clear();
}

/** Real path of an existing target; a missing one resolves its existing parents. Null on a symlink loop or read error. */
function realLocation(path: string): string | null {
  try {
    return realpathSync(resolve(path));
  } catch {
    try {
      return canonicalPath(path);
    } catch {
      return null;
    }
  }
}

/** Strictly inside the worktrees root after following symlinks, so a link placed under the root cannot reach out. */
export function isUnderWorktrees(directory: string, root = paseoWorktreesRoot()): boolean {
  const base = realLocation(root);
  const dir = realLocation(directory);
  if (!base || !dir) return false;
  const rel = relative(base, dir);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** Why this worktree record cannot be treated as the card's own copy. Null when there is no record, or the checks pass. */
export function worktreeOwnershipError(taskId: number, event: CreatedEvent | null, worktreesRoot = paseoWorktreesRoot()): string | null {
  if (!event) return null;
  if (!event.directory || !event.branch || !event.root) return t("worktreeGc.owner.incomplete");
  if (event.readOnly === true ? event.branch !== readOnlyBranchName(taskId) || !event.head || !/^[0-9a-f]{40,64}$/i.test(event.head) :
    !branchOwnedByCard(taskId, event.branch)) return t("worktreeGc.owner.notCardBranch", { branch: event.branch });
  if (!isUnderWorktrees(event.directory, worktreesRoot)) return t("worktreeGc.owner.outsideRoot", { directory: event.directory });
  if (samePath(event.directory, event.root)) return t("worktreeGc.owner.isMain");
  return null;
}

/** The worktree this card opened, and only when all three ownership checks pass. */
export function ownedWorktree(taskId: number, event: CreatedEvent | null, worktreesRoot = paseoWorktreesRoot()): OwnedWorktree | null {
  if (!event?.directory || !event.branch || !event.root) return null;
  if (worktreeOwnershipError(taskId, event, worktreesRoot)) return null;
  return {
    directory: event.directory,
    branch: event.branch,
    base: event.base?.trim() || "main",
    root: event.root,
    ...(event.readOnly ? { readOnly: true, head: event.head } : {}),
  };
}

export function createdWorktree(taskId: number): CreatedEvent | null {
  return readWorktreeCreated(taskId);
}

/** False while a failed remove is still backing off, or after the copy is already gone. */
export function gitRemovalDue(task: TaskRow, events: CleanupRecord[], now: Date, worktreesRoot?: string): boolean {
  const owned = ownedWorktree(task.id, createdWorktree(task.id), worktreesRoot);
  if (!owned) return true;
  if (events.some((event) => event.action === "remove_worktree" && event.ok === true && event.directory === owned.directory)) return false;
  if (events.some((event) => event.action === "skip_worktree" && event.ok === true && event.directory === owned.directory)) return false;
  return retryReady(events, "remove_worktree", owned.directory, now);
}

type Attempt =
  | { kind: "not_merged"; error?: string; missingPr?: boolean }
  | { kind: "error"; error: string }
  | { kind: "removed"; basis?: string }
  | { kind: "gone" }
  | { kind: "waiting"; agentIds: string[] };

type AgentActivity = (agentId: string) => Promise<AgentRunState>;

function remoteNames(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

async function githubOrigin(root: string, run: GitRunner): Promise<string | null> {
  const url = await run(root, ["remote", "get-url", "origin"]);
  if (url.code !== 0) return null;
  const text = url.stdout.trim().replace(/\.git$/, "");
  const match = text.match(/github\.com[:/]([\w.-]+)\/([\w.-]+)$/);
  if (!match?.[1] || !match[2]) return null;
  return `${match[1]}/${match[2]}`;
}

/** Exit 0 when ref and the branch have the same tree. A missing ref is an error, not "different". */
async function sameTree(owned: OwnedWorktree, ref: string, run: GitRunner): Promise<"same" | "differ" | { error: string }> {
  const diff = await run(owned.root, ["diff", "--quiet", ref, headRef(owned.branch)]);
  if (diff.code === 0) return "same";
  if (diff.code === 1) return "differ";
  return { error: failure(diff, t("worktreeGc.gitFailed", { command: "git diff" })) };
}

/** Fetch origin/<base>. A failed fetch is not a view of the remote: the caller must not delete. */
async function fetchOriginBase(owned: OwnedWorktree, run: GitRunner): Promise<{ ref: string } | { error: string }> {
  if (!refOk(owned.base)) return { error: t("worktreeGc.base.badName", { base: owned.base }) };
  const fetched = await run(owned.root, ["fetch", "origin", owned.base]);
  if (fetched.code !== 0) {
    return { error: t("worktreeGc.base.fetchFailed", { base: owned.base, error: failure(fetched, t("worktreeGc.gitFailed", { command: "git fetch" })) }) };
  }
  return { ref: originRef(owned.base) };
}

/** Whether the branch tip is already contained in ref. Exit 1 is "no"; anything else is unreadable. */
async function ancestorOf(owned: OwnedWorktree, ref: string, run: GitRunner): Promise<{ yes: boolean } | { error: string }> {
  const ancestor = await run(owned.root, ["merge-base", "--is-ancestor", headRef(owned.branch), ref]);
  if (ancestor.code === 0) return { yes: true };
  if (ancestor.code === 1) return { yes: false };
  return { error: failure(ancestor, t("worktreeGc.gitFailed", { command: "merge-base" })) };
}

async function mergedEnough(task: TaskRow, owned: OwnedWorktree, run: GitRunner, now: number): Promise<Attempt | { kind: "go" }> {
  const listed = await run(owned.root, ["branch", "--list", owned.branch]);
  if (listed.code !== 0) return { kind: "error", error: failure(listed, t("worktreeGc.gitFailed", { command: "git branch --list" })) };
  const branchHere = Boolean(listed.stdout.trim());
  // Someone already removed the copy. A recorded PR must not be asked first: gh failing would
  // keep reporting not_merged after the directory and the branch are both gone.
  if (!branchHere && directoryState(owned.directory) === "missing") return { kind: "gone" };
  if (branchHere) {
    const integrated = await integrationBranchContaining(owned.root, owned.branch, projectWorkspace(task.project).integrationBranches ?? [], run);
    if (integrated) return "ref" in integrated ? { kind: "go" } : { kind: "error", error: integrated.error };
  }
  const contract = readContract(task.contract_json);
  const remotes = await run(owned.root, ["remote"]);
  if (remotes.code !== 0) return { kind: "error", error: failure(remotes, t("worktreeGc.gitFailed", { command: "git remote" })) };
  const hasOrigin = remoteNames(remotes.stdout).includes("origin");
  // Local containment is independent proof: no card commit is lost even when
  // origin is behind, unreachable, or a recorded PR is still open.
  const local = branchHere ? await ancestorOf(owned, headRef(owned.base), run) : null;
  if (local && "yes" in local && local.yes) return { kind: "go" };
  // origin/<base> is its own proof, including when the card names a PR that is still
  // open or whose gh query fails. A failed fetch is not that proof.
  let fetchError: string | undefined;
  if (hasOrigin && branchHere) {
    const remote = await fetchOriginBase(owned, run);
    if ("error" in remote) {
      fetchError = remote.error;
    } else {
      const contained = await ancestorOf(owned, remote.ref, run);
      if ("error" in contained) return { kind: "error", error: contained.error };
      if (contained.yes) return { kind: "go" };
    }
  }
  // A recorded PR is the fallback when the remote base does not contain the tip.
  if (contract.pr) {
    const state = await prMergeState(contract.pr, { now });
    if (state.merged) return { kind: "go" };
    return { kind: "not_merged", error: state.error ?? undefined };
  }
  // Without ancestry proof, a GitHub card with no recorded PR is not merged.
  // A failed fetch is a read error, not proof that no PR exists. Temp cleanup treats
  // missingPr on an archived card as keep-the-branch, and does not ask gh.
  if (contract.kind === "github") {
    if (fetchError) return { kind: "not_merged", error: fetchError };
    return { kind: "not_merged", missingPr: true };
  }
  if (!hasOrigin) {
    if (!branchHere) return { kind: "error", error: t("worktreeGc.branch.localGone") };
    return local && "error" in local ? { kind: "error", error: local.error } : { kind: "not_merged" };
  }
  // A failed fetch is unreadable: a matching local tree alone is not containment.
  // Squash leaves the branch tip outside the remote base: an empty diff against
  // origin/<base> after a successful fetch, or gh saying MERGED, is enough.
  if (!branchHere) return { kind: "not_merged" };
  if (!fetchError) {
    if (local && "error" in local) return { kind: "error", error: local.error };
    const trees = await sameTree(owned, originRef(owned.base), run);
    if (trees === "same") return { kind: "go" };
    if (typeof trees === "object") return { kind: "error", error: trees.error };
  }
  const repo = await githubOrigin(owned.root, run);
  if (!repo) return fetchError ? { kind: "error", error: fetchError } : { kind: "not_merged" };
  const found = await prByHead(owned.branch, repo, { now });
  if (found.error) return { kind: "not_merged", error: found.error };
  if (found.merged) return { kind: "go" };
  if (fetchError) return { kind: "error", error: fetchError };
  return { kind: "not_merged" };
}

function failure(result: GitResult, fallback: string): string {
  return (result.stderr || result.stdout || fallback).trim();
}

/**
 * Contained in origin/<base> is its own reason to delete, including when the card
 * already names a PR whose head is a later commit. A failed fetch is not containment.
 */
async function originContainedBasis(
  owned: OwnedWorktree,
  run: GitRunner,
): Promise<{ basis: string } | { fetchError: string } | { remoteError: string } | { noOrigin: true } | { notContained: true }> {
  const remotes = await run(owned.root, ["remote"]);
  if (remotes.code !== 0) return { remoteError: failure(remotes, t("worktreeGc.gitFailed", { command: "git remote" })) };
  if (!remoteNames(remotes.stdout).includes("origin")) return { noOrigin: true };
  const remote = await fetchOriginBase(owned, run);
  if ("error" in remote) return { fetchError: remote.error };
  const contained = await ancestorOf(owned, remote.ref, run);
  if ("error" in contained) return { fetchError: contained.error };
  if (contained.yes) return { basis: t("worktreeGc.basis.inOriginBase", { base: owned.base }) };
  return { notContained: true };
}

/**
 * Why `git branch -D` is refused, or the basis when it is allowed.
 * Allowed when the tip is already in the local base or origin/<base> (no commit is lost),
 * even if a recorded PR head is a different commit. Otherwise the card's PR must be
 * merged and the local tip must equal that head, or the branch tree must match
 * origin/<base> after a successful fetch. A matching local tree alone is not enough.
 * A failed fetch is not a basis. ownedWorktree already checked ownership, and
 * deleteSquashedBranch checks the branch name once more.
 */
async function forceDelete(task: TaskRow, owned: OwnedWorktree, run: GitRunner): Promise<{ basis: string } | { reason: string }> {
  // Recheck the current tip before deletion; a prior directory-removal proof is not enough.
  const integrated = await integrationBranchContaining(owned.root, owned.branch, projectWorkspace(task.project).integrationBranches ?? [], run);
  if (integrated) return "ref" in integrated
    ? { basis: t("worktreeGc.basis.inIntegration", { ref: integrated.ref }) }
    : { reason: integrated.error };
  const localBase = await ancestorOf(owned, headRef(owned.base), run);
  if ("yes" in localBase && localBase.yes) return { basis: t("worktreeGc.basis.inBase", { base: owned.base }) };
  const remote = await originContainedBasis(owned, run);
  if ("basis" in remote) return remote;
  if ("noOrigin" in remote && "error" in localBase) return { reason: localBase.error };
  const pr = readContract(task.contract_json).pr;
  if (pr) {
    const merge = await prMergeState(pr);
    if (merge.error) return { reason: t("worktreeGc.pr.mergeStateFailed", { error: merge.error }) };
    if (!merge.merged) return { reason: t("worktreeGc.pr.notMerged") };
    const head = await prHeadOid(pr);
    if ("error" in head) return { reason: t("worktreeGc.pr.headFailed", { error: head.error }) };
    const local = await run(owned.root, ["rev-parse", "--verify", `refs/heads/${owned.branch}`]);
    if (local.code !== 0) return { reason: t("worktreeGc.branch.localUnreadable", { error: failure(local, t("worktreeGc.gitFailed", { command: "git rev-parse" })) }) };
    if (local.stdout.trim().toLowerCase() !== head.oid) return { reason: t("worktreeGc.branch.commitsNotInPr") };
    return { basis: t("worktreeGc.basis.prMerged") };
  }
  if ("remoteError" in remote) return { reason: remote.remoteError };
  const fetchError = "fetchError" in remote ? remote.fetchError : undefined;
  if (!fetchError) {
    const remoteName = `origin/${owned.base}`;
    const ref = "notContained" in remote ? originRef(owned.base) : headRef(owned.base);
    const trees = await sameTree(owned, ref, run);
    if (trees === "same") return { basis: "notContained" in remote ? t("worktreeGc.basis.sameTreeAs", { ref: remoteName }) : t("worktreeGc.basis.sameTreeAsBase") };
    if (typeof trees === "object") return { reason: trees.error };
  }
  const repo = await githubOrigin(owned.root, run);
  if (!repo) return { reason: fetchError ?? t("worktreeGc.pr.none") };
  const found = await prByHead(owned.branch, repo);
  if (found.error) return { reason: t("worktreeGc.pr.mergeStateFailed", { error: found.error }) };
  if (!found.merged) return { reason: fetchError ?? t("worktreeGc.pr.notMerged") };
  if (!found.headOid) return { reason: t("worktreeGc.pr.noHeadOid") };
  const local = await run(owned.root, ["rev-parse", "--verify", `refs/heads/${owned.branch}`]);
  if (local.code !== 0) return { reason: t("worktreeGc.branch.localUnreadable", { error: failure(local, t("worktreeGc.gitFailed", { command: "git rev-parse" })) }) };
  if (local.stdout.trim().toLowerCase() !== found.headOid) return { reason: t("worktreeGc.branch.commitsNotInPr") };
  return { basis: t("worktreeGc.basis.prMerged") };
}

/** Basis recorded when the branch tip is on origin under the same name. Stored in events and read back by later rounds. */
export function pushedCleanupBasis(): string {
  return t("worktreeGc.basis.pushed");
}

/** Older rows carry the Chinese pushed basis. */
const LEGACY_PUSHED_CLEANUP_BASIS = "\u5df2\u63a8\u9001\uff0cPR \u672a\u5408\u5e76\uff0c\u8fdc\u7aef\u4fdd\u7559";

/** True for the pushed basis in any language, including rows written before translation. */
export function isPushedCleanupBasis(basis: string | undefined): boolean {
  if (!basis) return false;
  return basis === LEGACY_PUSHED_CLEANUP_BASIS ||
    basis === translate("en", "worktreeGc.basis.pushed") || basis === translate("zh-CN", "worktreeGc.basis.pushed");
}

/** pushedWorktreeBasis refuses to prove anything while the copy has uncommitted files. Callers compare against this. */
export function dirtyWorktreeError(): string {
  return t("worktreeGc.error.dirty");
}
export const PUSHED_ANCESTOR_BASIS = "pushed_ancestor";
/** The tip equals or sits inside an origin branch with a different name (a card working on an existing PR branch). */
export const PUSHED_OTHER_BRANCH_BASIS = "pushed_other_branch";

/** These proofs only allow removing the directory. The local branch needs origin/<base> too. */
export function isDirectoryOnlyBasis(basis: string | undefined): boolean {
  return basis === PUSHED_ANCESTOR_BASIS || basis === PUSHED_OTHER_BRANCH_BASIS;
}

/**
 * `keepable` marks an origin that cannot prove the tip (not pushed, ahead, or unreadable) on an attached branch.
 * Cleanup may then keep the branch and drop the directory. A detached HEAD is never keepable: its commits live nowhere else.
 */
type PushedBasis = { basis: string; originBranch?: string } | { noOrigin: true } | { notPushed: true; keepable?: true } | { error: string; keepable?: true };

/** Fresh origin proof, never the observed pushed flag or an old tracking ref. No remote writes. */
export async function pushedWorktreeBasis(task: TaskRow, owned: OwnedWorktree, run: GitRunner): Promise<PushedBasis> {
  if (task.status !== "done" && task.status !== "archived") return { error: t("worktreeGc.pushed.notDone") };
  const actual = judgedWorktree(task.id, owned);
  if (!refOk(actual.branch) || actual.branch === actual.base || isProtectedBranch(actual.branch)) {
    return { error: t("worktreeGc.pushed.protectedBranch") };
  }
  const remotes = await run(actual.root, ["remote"]);
  if (remotes.code !== 0) return { error: failure(remotes, t("worktreeGc.gitFailed", { command: "git remote" })) };
  const hasOrigin = remoteNames(remotes.stdout).includes("origin");
  let detachedHead: string | null = null;
  if (directoryState(actual.directory) === "present") {
    const status = await run(actual.directory, ["status", "--porcelain", "--untracked-files=all"]);
    if (status.code !== 0) return { error: failure(status, t("worktreeGc.gitFailed", { command: "git status" })) };
    if (status.stdout.trim()) {
      // A dirty tree can still be saved as a WIP on an attached card branch, so tell the caller which kind it is.
      const here = await run(actual.directory, ["branch", "--show-current"]);
      const attached = here.code === 0 && here.stdout.trim() === actual.branch;
      return { error: dirtyWorktreeError(), ...(attached ? { keepable: true as const } : {}) };
    }
    const current = await run(actual.directory, ["branch", "--show-current"]);
    if (current.code !== 0) return { error: failure(current, t("worktreeGc.branch.actualUnreadable")) };
    if (!current.stdout.trim()) {
      const head = await run(actual.directory, ["rev-parse", "--verify", "HEAD"]);
      if (head.code !== 0 || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(head.stdout.trim())) {
        return { error: t("worktreeGc.pushed.detachedUnreadable") };
      }
      detachedHead = head.stdout.trim();
    } else if (current.stdout.trim() !== actual.branch) return { error: t("worktreeGc.pushed.branchMismatch") };
  }
  if (!hasOrigin) return detachedHead ? { error: t("worktreeGc.pushed.detachedNoOrigin") } : { noOrigin: true };
  if (detachedHead) {
    const proof = await originHeadsProof(actual, run, detachedHead, true);
    if (!("noMatch" in proof)) return proof;
    // Retain the existing independent proof for a detached PR head.
    const pr = readContract(task.contract_json).pr;
    if (!pr) return { notPushed: true };
    const head = await prHeadOid(pr);
    if ("error" in head) return { error: t("worktreeGc.pr.headFailed", { error: head.error }) };
    return head.oid === detachedHead.toLowerCase() ? { basis: pushedCleanupBasis() } : { notPushed: true };
  }
  const named = await originHeadsProof(actual, run, null, false);
  if (!("noMatch" in named)) return named;
  // The tip may sit on another origin branch, such as the PR head the card was merging into.
  const other = await originHeadsProof(actual, run, null, true);
  if (!("noMatch" in other)) {
    return "basis" in other ? { basis: PUSHED_OTHER_BRANCH_BASIS, originBranch: other.originBranch } : other;
  }
  return { notPushed: true, keepable: true };
}

/**
 * Compare the local tip with live origin heads: the same-named branch, or every branch.
 * `noMatch` means the snapshot was read cleanly and no head equals or contains the tip.
 */
async function originHeadsProof(
  actual: OwnedWorktree,
  run: GitRunner,
  detachedHead: string | null,
  allHeads: boolean,
): Promise<PushedBasis | { noMatch: true }> {
  const keepableUnlessDetached = detachedHead ? {} : { keepable: true as const };
  const branch = headRef(actual.branch);
  // Enumerate only live remote heads, so stale tracking refs cannot authorize removal.
  const listed = await run(actual.root, ["ls-remote", "--heads", "origin", ...(allHeads ? [] : [branch])]);
  if (listed.code !== 0) return { error: t("worktreeGc.origin.listFailed", { error: failure(listed, t("worktreeGc.gitFailed", { command: "git ls-remote" })) }), ...keepableUnlessDetached };
  const heads: Array<{ oid: string; ref: string }> = [];
  for (const line of remoteNames(listed.stdout)) {
    const parts = line.split(/\s+/);
    const [oid, ref] = parts;
    if (parts.length !== 2 || !/^[0-9a-f]{40,64}$/i.test(oid ?? "") ||
        !ref?.startsWith("refs/heads/") || (!allHeads && ref !== branch)) {
      return { error: t("worktreeGc.origin.tipsIncomplete"), ...keepableUnlessDetached };
    }
    heads.push({ oid, ref });
  }
  if (heads.length === 0) return { noMatch: true };
  // Explicit refspec also works with a base-only fetch configuration. It only
  // refreshes local tracking refs, including after a remote rewind.
  const refspec = allHeads ? "+refs/heads/*:refs/remotes/origin/*" : `+${branch}:${originRef(actual.branch)}`;
  const fetched = await run(actual.root, ["fetch", "--no-tags", "origin", refspec]);
  if (fetched.code !== 0) return { error: t("worktreeGc.origin.fetchFailed", { error: failure(fetched, t("worktreeGc.gitFailed", { command: "git fetch" })) }), ...keepableUnlessDetached };
  const local = detachedHead ? { code: 0, stdout: detachedHead } : await run(actual.root, ["rev-parse", "--verify", branch]);
  if (local.code !== 0) return { error: t("worktreeGc.branch.localTipUnreadable") };
  // Validate the complete snapshot before accepting any containment proof.
  for (const head of heads) {
    const fresh = await run(actual.root, ["rev-parse", "--verify", originRef(head.ref.slice("refs/heads/".length))]);
    if (fresh.code !== 0) return { error: t("worktreeGc.origin.tipUnreadable"), ...keepableUnlessDetached };
    if (fresh.stdout.trim() !== head.oid) return { error: t("worktreeGc.origin.tipChanged"), ...keepableUnlessDetached };
  }
  const tip = local.stdout.trim();
  const equal = heads.find(head => tip === head.oid);
  if (equal) return { basis: pushedCleanupBasis(), originBranch: equal.ref.slice("refs/heads/".length) };
  for (const head of heads) {
    const contained = await run(actual.root, ["merge-base", "--is-ancestor", tip, head.oid]);
    if (contained.code === 0) return { basis: PUSHED_ANCESTOR_BASIS, originBranch: head.ref.slice("refs/heads/".length) };
    if (contained.code !== 1) return { error: failure(contained, t("worktreeGc.gitFailed", { command: "merge-base" })), ...keepableUnlessDetached };
  }
  return { noMatch: true };
}

export async function worktreeLanded(
  task: TaskRow,
  owned: OwnedWorktree,
  run: GitRunner,
  now = Date.now(),
): Promise<{ landed: true; gone?: boolean } | { landed: false; error?: string; missingPr?: boolean }> {
  if (directoryState(owned.directory) === "present") {
    const current = await run(owned.directory, ["branch", "--show-current"]);
    if (current.code !== 0) return { landed: false, error: failure(current, t("worktreeGc.branch.actualUnreadable")) };
    // The named branch can be landed while detached HEAD has unique commits.
    // Route detached copies through fresh pushed proof before any removal.
    if (!current.stdout.trim()) return { landed: false };
  }
  const gate = await mergedEnough(task, judgedWorktree(task.id, owned), run, now);
  if (gate.kind === "gone") return { landed: true, gone: true };
  if (gate.kind === "go") return { landed: true };
  if (gate.kind === "not_merged") return { landed: false, error: gate.error, missingPr: gate.missingPr === true };
  if (gate.kind === "error") return { landed: false, error: gate.error };
  return { landed: false };
}

async function deleteBranch(
  task: TaskRow,
  owned: OwnedWorktree,
  run: GitRunner,
  force: GitRunner | undefined,
  requirePushed: boolean,
): Promise<{ kind: "removed"; basis?: string } | { kind: "error"; error: string }> {
  // Decide from the configured local/origin base or PR head before deleting.
  // git branch -d follows HEAD, which may be an unrelated branch.
  const pushed = requirePushed ? await pushedWorktreeBasis(task, owned, run) : null;
  const decision = pushed
    ? ("basis" in pushed ? pushed : { reason: "error" in pushed ? pushed.error : t("worktreeGc.branch.differsFromOrigin") })
    : await forceDelete(task, owned, run);
  if ("reason" in decision) return { kind: "error", error: t("worktreeGc.branch.forceRefused", { reason: decision.reason }) };
  const forced = await removeBranchRef(task, owned, force);
  if (forced.code !== 0) return { kind: "error", error: failure(forced, t("worktreeGc.gitFailed", { command: "git branch -D" })) };
  return { kind: "removed", basis: decision.basis };
}

/** Delete the branch forceDelete already approved. Only a branch branchOwnedByCard accepts; anything else is refused. */
async function removeBranchRef(task: TaskRow, owned: OwnedWorktree, force: GitRunner | undefined): Promise<GitResult> {
  try {
    return await deleteSquashedBranch(owned.root, task.id, owned.branch, force);
  } catch (err) {
    return { code: 1, stdout: "", stderr: err instanceof Error ? err.message : String(err) };
  }
}

async function deleteOne(
  task: TaskRow,
  owned: OwnedWorktree,
  run: GitRunner,
  force: GitRunner | undefined,
  requirePushed: boolean,
  requireOriginBase: boolean,
  proofName: string,
): Promise<{ ok: true; basis?: string; kept?: boolean } | { ok: false; error: string }> {
  const listed = await run(owned.root, ["branch", "--list", owned.branch]);
  if (listed.code !== 0) return { ok: false, error: failure(listed, t("worktreeGc.gitFailed", { command: "git branch --list" })) };
  if (!listed.stdout.trim()) return { ok: true, basis: branchAlreadyGone() };
  if (requireOriginBase) {
    // A pushed ancestor authorizes directory removal, not local branch deletion.
    const remote = await originContainedBasis(owned, run);
    if ("fetchError" in remote) return { ok: false, error: remote.fetchError };
    if ("remoteError" in remote) return { ok: false, error: remote.remoteError };
    if (!("basis" in remote)) return { ok: true, kept: true, basis: t("worktreeGc.basis.notInOriginBaseKept", { proof: proofName, base: owned.base }) };
    const forced = await removeBranchRef(task, owned, force);
    return forced.code === 0 ? { ok: true, basis: remote.basis } : { ok: false, error: failure(forced, t("worktreeGc.gitFailed", { command: "git branch -D" })) };
  }
  if (requirePushed) {
    const pushed = await pushedWorktreeBasis(task, owned, run);
    // Directory proof may come from the PR head. Keep a local namesake that
    // differs from origin; that branch has not been approved for deletion.
    if ("notPushed" in pushed) return { ok: true, basis: t("worktreeGc.basis.differsFromOriginKept") };
    if (!("basis" in pushed)) return { ok: false, error: "error" in pushed ? pushed.error : t("worktreeGc.origin.unreadable") };
  }
  const result = await deleteBranch(task, owned, run, force, requirePushed);
  if (result.kind === "removed") return { ok: true, basis: result.basis };
  const error = "error" in result ? result.error : undefined;
  return { ok: false, error: error ?? t("worktreeGc.branch.notDeleted") };
}

/**
 * The original kanban branch has nothing of its own when its tip is already on the
 * actual branch, or already on origin/<base>. A failed read is not "empty".
 */
async function lacksUniqueCommits(
  owned: OwnedWorktree,
  actual: string,
  run: GitRunner,
): Promise<true | false | { error: string }> {
  const listed = await run(owned.root, ["branch", "--list", owned.branch]);
  if (listed.code !== 0) return { error: failure(listed, t("worktreeGc.gitFailed", { command: "git branch --list" })) };
  if (!listed.stdout.trim()) return true;
  const actualListed = await run(owned.root, ["branch", "--list", actual]);
  if (actualListed.code !== 0) return { error: failure(actualListed, t("worktreeGc.gitFailed", { command: "git branch --list" })) };
  if (actualListed.stdout.trim()) {
    const inActual = await run(owned.root, ["merge-base", "--is-ancestor", headRef(owned.branch), headRef(actual)]);
    if (inActual.code === 0) return true;
    if (inActual.code !== 1) return { error: failure(inActual, t("worktreeGc.gitFailed", { command: "merge-base" })) };
  }
  const remote = await originContainedBasis(owned, run);
  if ("basis" in remote) return true;
  if ("noOrigin" in remote) {
    const local = await ancestorOf(owned, headRef(owned.base), run);
    if ("error" in local) return { error: local.error };
    return local.yes;
  }
  if ("fetchError" in remote) return { error: remote.fetchError };
  if ("remoteError" in remote) return { error: remote.remoteError };
  return false;
}

async function deleteOriginalBranch(
  task: TaskRow,
  owned: OwnedWorktree,
  run: GitRunner,
  force: GitRunner | undefined,
): Promise<{ ok: true; basis?: string } | { ok: false; error: string }> {
  const listed = await run(owned.root, ["branch", "--list", owned.branch]);
  if (listed.code !== 0) return { ok: false, error: failure(listed, t("worktreeGc.gitFailed", { command: "git branch --list" })) };
  if (!listed.stdout.trim()) return { ok: true, basis: t("worktreeGc.basis.noUniqueCommits") };
  try {
    const forced = await deleteSquashedBranch(owned.root, task.id, owned.branch, force);
    if (forced.code !== 0) return { ok: false, error: failure(forced, t("worktreeGc.gitFailed", { command: "git branch -D" })) };
    return { ok: true, basis: t("worktreeGc.basis.noUniqueCommits") };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** The original card branch still has commits of its own. Nothing is wrong; the branch is kept and cleanup ends. */
export function keptUniqueCommits(): string {
  return t("worktreeGc.basis.keptUniqueCommits");
}

/** The executor's checkout is a branch this card did not create. Only its local name stays; no commit is lost. */
export function foreignBranchKept(branch: string): string {
  return t("worktreeGc.basis.foreignBranchKept", { branch });
}

export function branchAlreadyGone(): string {
  return t("worktreeGc.basis.branchGone");
}

/** git's "no such branch" error when it runs under a Chinese locale. */
const GIT_ZH_BRANCH_NOT_FOUND = /\u6ca1\u6709\u8fd9\u4e2a\u5206\u652f/;
/** Older rows carry the Chinese "local branch has commits the PR lacks" reason. */
const LEGACY_COMMITS_NOT_IN_PR = "\u672c\u5730\u5206\u652f\u6709 PR \u91cc\u6ca1\u6709\u7684\u63d0\u4ea4";

/**
 * Sort a failed branch delete by its error text. "gone": git says the branch does not exist, so the goal is met.
 * "keep": the branch is checked out elsewhere, git refuses an unmerged delete, or the board saw commits the PR lacks;
 * the rules say keep it. Anything else is a real error and stays a retry.
 */
export function branchFailureKind(error: string): "gone" | "keep" | null {
  if (/branch '[^']*' not found/.test(error) || GIT_ZH_BRANCH_NOT_FOUND.test(error)) return "gone";
  if (/used by worktree|checked out at|not fully merged/.test(error) || error.includes(LEGACY_COMMITS_NOT_IN_PR) ||
    error.includes(translate("en", "worktreeGc.branch.commitsNotInPr")) || error.includes(translate("zh-CN", "worktreeGc.branch.commitsNotInPr"))) return "keep";
  return null;
}

/** Delete a merged card branch, or a terminal card branch freshly proven pushed. Does not remove the directory. */
export async function deleteOwnedBranch(
  task: TaskRow,
  owned: OwnedWorktree,
  run: GitRunner,
  force?: GitRunner,
  requirePushed = false,
  requireOriginBase = false,
  proofName = PUSHED_ANCESTOR_BASIS,
): Promise<{ ok: true; basis?: string; kept?: boolean } | { ok: false; error: string }> {
  const judged = judgedWorktree(task.id, owned);
  if (judged.branch === owned.branch) return deleteOne(task, owned, run, force, requirePushed, requireOriginBase, proofName);
  const empty = await lacksUniqueCommits(owned, judged.branch, run);
  if (typeof empty === "object") return { ok: false, error: empty.error };
  // The branch_observed event only says what was checked out, not who made the branch.
  // A checkout this card did not create (another card's branch, a team branch) is never deleted.
  const primary: Awaited<ReturnType<typeof deleteOne>> = branchOwnedByCard(task.id, judged.branch)
    ? await deleteOne(task, judged, run, force, requirePushed, requireOriginBase, proofName)
    : { ok: true, kept: true, basis: foreignBranchKept(judged.branch) };
  if (!primary.ok) return primary;
  if (!empty) return { ok: true, kept: true, basis: primary.kept && primary.basis ? `${primary.basis}${t("common.semicolon")}${keptUniqueCommits()}` : keptUniqueCommits() };
  const extra = await deleteOriginalBranch(task, owned, run, force);
  if (!extra.ok) return extra;
  return { ok: true, basis: primary.basis ?? extra.basis, kept: primary.kept };
}

async function retainOrUnknown(
  task: TaskRow,
  directory: string,
  activity?: AgentActivity,
): Promise<{ kept: CwdAgent[] | "unknown" } | { hold: Attempt }> {
  try {
    const result = await retainAgentsBeforeDirectoryRemoval(directory, activity, { taskId: task.id, recorded: new Set(agentsOpenedBy(task)) });
    if (result.unread.length > 0) {
      const onlyList = result.unread.length === 1 && result.unread[0] === agentListUnreadReason();
      const error = onlyList ? agentListUnreadReason() : t("worktreeGc.agents.unreadable", { detail: result.unread.join(t("common.listSep")) });
      return { hold: { kind: "error", error } };
    }
    if (result.waiting.length > 0) return { hold: { kind: "waiting", agentIds: result.waiting } };
    if (result.outside.length > 0) return { hold: { kind: "error", error: t("tempWorkspace.agents.foreignDirectory") } };
    return { kept: result.kept };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[paseo-kanban] missing-cwd", message);
    return { hold: { kind: "error", error: t("worktreeGc.agents.unreadable", { detail: message }) } };
  }
}

function placeAfterRemoval(taskId: number, directory: string, kept: CwdAgent[] | "unknown"): Attempt | null {
  if (existsSync(directory)) return null;
  try {
    placeholderAfterRemoval(directory, kept, t("worktreeGc.placeholder.note"), taskId);
    return null;
  } catch (err) {
    return { kind: "error", error: t("worktreeGc.placeholder.failed", { error: err instanceof Error ? err.message : String(err) }) };
  }
}

async function attempt(task: TaskRow, owned: OwnedWorktree, run: GitRunner, now: number, force?: GitRunner, activity?: AgentActivity): Promise<Attempt> {
  const judged = judgedWorktree(task.id, owned);
  const gate = await mergedEnough(task, judged, run, now);
  if (gate.kind === "gone") {
    const deleted = await deleteOwnedBranch(task, owned, run, force);
    if (!deleted.ok) return { kind: "error", error: deleted.error };
    return { kind: "removed", basis: deleted.basis };
  }
  if (gate.kind !== "go") return gate;
  // A placeholder is not a worktree. git status there fails with "not a git repository"
  // and would stop every later attempt from deleting the branch.
  if (directoryState(owned.directory) === "present") {
    const status = await run(owned.directory, ["status", "--porcelain"]);
    if (status.code !== 0) return { kind: "error", error: (status.stderr || status.stdout || t("worktreeGc.gitFailed", { command: "git status" })).trim() };
    if (status.stdout.trim()) return { kind: "error", error: dirtyWorktreeError() };
    const retained = await retainOrUnknown(task, owned.directory, activity);
    if ("hold" in retained) return retained.hold;
    const removed = await run(owned.root, ["worktree", "remove", owned.directory]);
    if (removed.code !== 0) {
      return { kind: "error", error: (removed.stderr || removed.stdout || t("worktreeGc.gitFailed", { command: "git worktree remove" })).trim() };
    }
    const placed = placeAfterRemoval(task.id, owned.directory, retained.kept);
    if (placed) return placed;
  } else {
    const retained = await retainOrUnknown(task, owned.directory, activity);
    if ("hold" in retained) return retained.hold;
    const placed = placeAfterRemoval(task.id, owned.directory, retained.kept);
    if (placed) return placed;
  }
  const deleted = await deleteOwnedBranch(task, owned, run, force);
  if (!deleted.ok) return { kind: "error", error: deleted.error };
  return { kind: "removed", basis: deleted.basis };
}

function withTimeout(work: Promise<Attempt>, ms: number): Promise<Attempt | "timeout"> {
  return new Promise((resolve) => {
    // The timer stays referenced. An unref'd timer never fires when this await is the
    // only thing left on the event loop, so a hung git would skip the timeout record.
    const timer = setTimeout(() => resolve("timeout"), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        resolve({ kind: "error", error: err instanceof Error ? err.message : String(err) });
      },
    );
  });
}

function noteLate(taskId: number, owned: OwnedWorktree, boundary: number): void {
  try {
    appendEvent(taskId, "cleanup", null, null, "kanban", {
      action: "remove_worktree",
      cleanupGeneration: boundary,
      directory: owned.directory,
      branch: owned.branch,
      ok: true,
      late: true,
    });
    const task = getTask(taskId);
    if ((task.status === "done" || task.status === "archived") && task.workspace_path &&
        samePath(task.workspace_path, owned.directory) && cleanupGeneration(taskId) === boundary && !cleanupMark(taskId, ["cleanup_finished"]))
      appendEvent(taskId, "cleanup_finished", null, null, "kanban", { cleanupGeneration: boundary });
  } catch (err) {
    console.error("[paseo-kanban] cleanup", err instanceof Error ? err.message : err);
  }
}

export async function settleOwnedWorktree(input: {
  task: TaskRow;
  events: CleanupRecord[];
  now: Date;
  timeoutMs: number;
  record: (data: Omit<CleanupRecord, "at">) => void;
  /** Tests pass a fake git. It also receives the one allowed `branch -D`; the real runner never does. */
  run?: GitRunner;
  worktreesRoot?: string;
  /** Same clock temp cleanup uses. Busy waits; unknown or a thrown query keeps the directory. */
  agentActivity?: AgentActivity;
}): Promise<"settled" | "pending"> {
  const { task, events, now, record } = input;
  const run = input.run ?? ((cwd: string, args: string[]) => runGit(cwd, args));
  const owned = ownedWorktree(task.id, createdWorktree(task.id), input.worktreesRoot);
  const judged = owned ? judgedWorktree(task.id, owned) : null;
  if (!owned || !judged) {
    if (!events.some((event) => event.action === "skip_worktree" && event.ok === true && event.reason === "not_ours")) {
      record({ action: "skip_worktree", ok: true, reason: "not_ours" });
    }
    return "settled";
  }
  if (events.some((event) => event.action === "remove_worktree" && event.ok === true && event.directory === owned.directory)) return "settled";
  if (!retryReady(events, "remove_worktree", owned.directory, now)) return "pending";
  if (inflight.has(owned.directory)) return "pending";

  const boundary = cleanupGeneration(task.id);
  const job = attempt(task, owned, run, now.getTime(), input.run, input.agentActivity);
  inflight.set(owned.directory, job);
  trackCleanupWork(task.id, job);
  let timedOut = false;
  void job.finally(() => {
    if (inflight.get(owned.directory) === job) inflight.delete(owned.directory);
  });
  const result = await withTimeout(job, input.timeoutMs);
  if (result === "timeout") {
    timedOut = true;
    void job.then((value) => {
      if (timedOut && value.kind === "removed") noteLate(task.id, judged, boundary);
    });
    record({
      action: "remove_worktree",
      directory: owned.directory,
      branch: judged.branch,
      ok: false,
      outcome: "timeout",
      error: t("worktreeGc.timeout"),
      retryAt: nextRetryAt(events, "remove_worktree", owned.directory, now),
    });
    return "pending";
  }
  if (result.kind === "not_merged") {
    const previous = [...events].reverse().find((event) => event.action === "skip_worktree" && event.reason === "not_merged" && event.directory === owned.directory);
    if (!previous || previous.error !== result.error) {
      record({
        action: "skip_worktree",
        directory: owned.directory,
        branch: judged.branch,
        ok: false,
        reason: "not_merged",
        ...(result.error ? { error: result.error } : {}),
      });
    }
    return "pending";
  }
  if (result.kind === "waiting") {
    for (const agentId of result.agentIds) {
      if (events.some((event) => event.action === "wait_turn" && event.agentId === agentId && event.retryAt == null)) continue;
      record({ action: "wait_turn", agentId, directory: owned.directory, branch: judged.branch, ok: false, reason: waitReason() });
    }
    return "pending";
  }
  if (result.kind === "error") {
    record({
      action: "remove_worktree",
      directory: owned.directory,
      branch: judged.branch,
      ok: false,
      outcome: "error",
      error: result.error,
      retryAt: nextRetryAt(events, "remove_worktree", owned.directory, now),
    });
    return "pending";
  }
  record({
    action: "remove_worktree",
    directory: owned.directory,
    branch: judged.branch,
    ok: true,
    ...("basis" in result && result.basis ? { reason: result.basis } : {}),
  });
  return "settled";
}

/** Archived cards whose copy was left in place, and any remove that failed. */
export function leftoverGitWorktrees(task: TaskRow): string[] {
  if (tempCleaned(task.id)) return [];
  const events = readCleanupEvents(task.id);
  if (events.some((event) => event.action === "remove_worktree" && event.ok === true)) return [];
  const lines: string[] = [];
  const failed = [...events].reverse().find((event) => event.action === "remove_worktree" && event.ok === false);
  if (failed) lines.push(failed.error || failed.reason || t("worktreeGc.leftover.removeFailed"));
  if (task.status === "archived" && !failed) {
    const skipped = [...events].reverse().find((event) => event.action === "skip_worktree" && event.reason === "not_merged");
    if (skipped) lines.push(skipped.error ? t("worktreeGc.leftover.notMergedWith", { error: skipped.error }) : t("worktreeGc.leftover.notMerged"));
  }
  return lines;
}

export type { GitResult };
