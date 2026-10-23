import { mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import type { CloudCommand } from "./cloud-command";
import { cloudEvent, cloudRunRecord, isCloudRunning, isCloudDeliveryRun, localCloudReceipt, parseCloudReceipt, type CloudRunRecord, type LocalCloudReceipt } from "./cloud-record";
import { cloudPrivacyFindings, cloudPrivateDenylistFindings } from "./cloud-privacy";
import { LOCAL_GIT_OPTIONS, disabledGitFilters } from "./cloud-git-policy";
import { loadConfig } from "./config";
import { cardMark } from "./card-ref";
import { getDb } from "./db";
import { KanbanError } from "./errors";
import { dataDir, paseoWorktreesRoot } from "./paths";
import { appendEvent, getTask } from "./store";
import { commitCloudWorktree, readWorktreeCreated, type WorktreeRecord } from "./worktree-record";
import { ownedWorktree, worktreeOwnershipError, type OwnedWorktree } from "./worktree-gc";
import { tempBranchName } from "./workspace";

export type LocalMapping = CloudRunRecord & Required<Pick<CloudRunRecord, "project" | "repoRoot" | "sourceBase" | "snapshotCommit" | "tree">>;
export interface LocalImport {
  receipt: LocalCloudReceipt;
  worktree: OwnedWorktree;
  resultTree: string;
  files: string[];
  verification: string[];
}
const oid = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const refused = () => new KanbanError("cloud_local_result_invalid", "Local cloud result failed isolated verification");

/** All Git reads/imports are local, without global config, hooks, replacement refs or lazy network fetches. */
export function localGit(run: CloudCommand, scratch: string, signal?: AbortSignal, guard: () => void = () => {}): (cwd: string, args: string[]) => Promise<string> {
  const filters = new Map<string, string[]>();
  return async (cwd, args) => {
    const call = async (argv: string[]) => {
      guard(); signal?.throwIfAborted();
      const result = await run("git", [...LOCAL_GIT_OPTIONS, "-C", cwd, ...argv], {
        signal, timeoutMs: 30_000,
        env: { PATH: process.env.PATH, TMPDIR: scratch, KANBAN_TMP: scratch, HOME: scratch, LANG: "C",
          GIT_ATTR_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1",
          GIT_AUTHOR_NAME: "Anonymous contributor", GIT_COMMITTER_NAME: "Anonymous contributor",
          GIT_AUTHOR_EMAIL: "noreply@github.com", GIT_COMMITTER_EMAIL: "noreply@github.com",
          GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z" },
      });
      guard(); signal?.throwIfAborted();
      return result;
    };
    if (!filters.has(cwd)) {
      const config = await call(["config", "--null", "--name-only", "--list"]);
      if (config.truncated || (config.code !== 0 && !args.includes("init"))) throw refused();
      if (config.code === 0) filters.set(cwd, disabledGitFilters(config.stdout));
    }
    const result = await call([...(filters.get(cwd) ?? []), ...args]);
    if (result.code !== 0 || result.truncated) throw refused();
    return result.stdout;
  };
}
export type LocalGit = ReturnType<typeof localGit>;
const text = async (git: LocalGit, cwd: string, args: string[]) => (await git(cwd, args)).trim();
const fetchBundle = (git: LocalGit, cwd: string, path: string, ref: string) => git(cwd, ["fetch", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", path, ref]);

/** Never allow a prior inspection/unowned checkout to become a writable delivery by relabeling it. */
export async function localDeliveryWorktree(id: number, root: string, base: string, sourceBase: string, git: LocalGit, advanceEmpty = false): Promise<OwnedWorktree> {
  const saved = readWorktreeCreated(id);
  if (saved) {
    const owned = ownedWorktree(id, saved);
    if (!owned || owned.readOnly || realpathSync(owned.root) !== root ||
        await text(git, owned.directory, ["branch", "--show-current"]) !== owned.branch ||
        (await git(owned.directory, ["status", "--porcelain"])) !== "") throw refused();
    const current = await text(git, owned.directory, ["rev-parse", "HEAD"]);
    if (current !== sourceBase) {
      if (!advanceEmpty) throw refused();
      await git(owned.root, ["merge-base", "--is-ancestor", current, sourceBase]);
      await git(owned.directory, ["merge", "--ff-only", sourceBase]);
    }
    return owned;
  }
  const code = cardMark(id);
  if (!/^[A-Z0-9]+_\d+$/.test(code)) throw refused();
  const namespace = createHash("sha256").update(`${root}:${dataDir()}`).digest("hex").slice(0, 16);
  const directory = join(paseoWorktreesRoot(), `cloud-${namespace}`, code);
  const owned = { directory, root, base, branch: tempBranchName(code, "cloud-delivery") };
  if (worktreeOwnershipError(id, owned)) throw refused();
  return owned;
}

/** Verify references, exact graph and complete file inventory before touching the project object store. */
export async function verifyLocalResult(input: {
  record: LocalMapping; sourceBundle: string; resultBundle: string; head: string; resultTree: string;
  maxBytes: number; isolated: string; git: LocalGit;
}): Promise<{ files: string[]; tree: string }> {
  const { record, sourceBundle, resultBundle, head, resultTree, isolated, git } = input;
  if (!oid.test(head) || !oid.test(resultTree) || head === record.snapshotCommit || statSync(resultBundle).size > input.maxBytes) throw refused();
  const bytes = readFileSync(resultBundle);
  const boundary = bytes.indexOf("\n\n");
  if (boundary < 0 || boundary > 16_384) throw refused();
  const header = bytes.subarray(0, boundary).toString("utf8").split("\n");
  const expectedHeader = record.sourceBase.length === 64 ? ["# v3 git bundle", "@object-format=sha256"] : ["# v2 git bundle"];
  if (expectedHeader.some((line, index) => header[index] !== line) || header.length !== expectedHeader.length + 2 ||
      !header[expectedHeader.length].startsWith(`-${record.snapshotCommit} `) ||
      header[expectedHeader.length + 1] !== `${head} refs/heads/result`) throw refused();
  mkdirSync(isolated, { mode: 0o700 });
  await git(isolated, ["init", "--bare", "--template=", `--object-format=${record.sourceBase.length === 64 ? "sha256" : "sha1"}`]);
  await fetchBundle(git, isolated, sourceBundle, "refs/heads/source:refs/heads/source");
  if (await text(git, isolated, ["rev-parse", "refs/heads/source"]) !== record.snapshotCommit ||
      await text(git, isolated, ["rev-parse", `${record.snapshotCommit}^{tree}`]) !== record.tree) throw refused();
  await git(isolated, ["bundle", "verify", resultBundle]);
  if (await text(git, isolated, ["bundle", "list-heads", resultBundle]) !== `${head} refs/heads/result`) throw refused();
  await fetchBundle(git, isolated, resultBundle, "refs/heads/result:refs/heads/result");
  // An exact commit object also rejects signatures, extra parents, encodings and private metadata.
  const commit = await git(isolated, ["cat-file", "commit", head]);
  const expected = `tree ${resultTree}\nparent ${record.snapshotCommit}\nauthor Anonymous cloud contributor <noreply@github.com> 946684800 +0000\ncommitter Anonymous cloud contributor <noreply@github.com> 946684800 +0000\n\nComplete cloud task\n`;
  if (commit !== expected || resultTree === record.tree ||
      await text(git, isolated, ["rev-list", "--count", `${record.snapshotCommit}..${head}`]) !== "1") throw refused();
  // Reject hidden pack objects too; they must not be smuggled into the host alongside the advertised head.
  const objects = (await git(isolated, ["cat-file", "--batch-all-objects", "--batch-check=%(objectname)"])).trim().split("\n").sort();
  const reachable = (await git(isolated, ["rev-list", "--objects", "--no-object-names", head])).trim().split("\n").sort();
  if (objects.join("\n") !== reachable.join("\n")) throw refused();
  const entries = (await git(isolated, ["ls-tree", "-r", "-t", "-z", "--full-tree", head])).split("\0").filter(Boolean);
  for (const row of entries) {
    const match = /^(040000 tree|100644 blob|100755 blob) [0-9a-f]{40,64}\t([^\0]+)$/.exec(row);
    const path = match?.[2];
    if (!path || /[\x00-\x1f\x7f\\\ufffd]/u.test(path) || path.split("/").some(part => !part || part === "." || part === ".." || /^\.git(?:$|[ .])/i.test(part))) throw refused();
  }
  const files = (await git(isolated, ["diff", "--no-ext-diff", "--no-textconv", "--name-only", "-z", record.snapshotCommit, head])).split("\0").filter(Boolean);
  if (!files.length) throw refused();
  return { files, tree: resultTree };
}

export async function scanLocalChanges(git: LocalGit, repo: string, base: string, head: string, files: string[]): Promise<void> {
  const patch = await git(repo, ["-c", "core.quotePath=false", "diff", "--no-ext-diff", "--no-textconv", "--binary", base, head]);
  const value = `${patch}\n${files.join("\n")}`;
  const findings = cloudPrivacyFindings(value);
  try { findings.push(...cloudPrivateDenylistFindings(value)); }
  catch { findings.push("denylist-unavailable"); }
  if (findings.length) throw new KanbanError("cloud_local_privacy", `Local cloud privacy scan blocked: ${[...new Set(findings)].join(", ")}`);
}

/** Journal before changing a worktree; restart resumes this exact L instead of launching a second machine. */
export async function prepareLocalImport(input: {
  id: number; record: LocalMapping; isolated: string; head: string; resultTree: string; files: string[]; git: LocalGit; verification: string[];
}): Promise<LocalImport> {
  const { id, record, git } = input;
  const worktree = await localDeliveryWorktree(id, record.repoRoot, record.base, record.sourceBase, git);
  await fetchBundle(git, record.repoRoot, input.isolated, input.head);
  const localHead = await text(git, record.repoRoot, ["commit-tree", input.resultTree, "-p", record.sourceBase, "-m", "chore: complete cloud task"]);
  if (!oid.test(localHead) || localHead === input.head) throw refused();
  // Recheck the actual local replay, which is the only artifact the reviewer will judge.
  await scanLocalChanges(git, record.repoRoot, record.sourceBase, localHead, input.files);
  const receipt: LocalCloudReceipt = { kind: "local", project: record.project, repoRoot: record.repoRoot,
    sourceBase: record.sourceBase, snapshotCommit: record.snapshotCommit, tree: record.tree, cloudHead: input.head, localHead,
    runId: record.runId, generation: record.generation };
  const journal: LocalImport = { receipt, worktree, resultTree: input.resultTree, files: input.files, verification: input.verification };
  appendEvent(id, "cloud_local_import", null, null, "scheduler", journal as unknown as Record<string, unknown>);
  await resumeLocalImport(id, journal, git);
  return journal;
}

export function localCloudFeedback(id: number): string {
  const row = getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind IN ('request_changes', 'leader_rework', 'land_conflict', 'rejected') ORDER BY id DESC LIMIT 1").get(id) as { data_json: string } | undefined;
  try {
    const value = JSON.parse(row?.data_json ?? "{}");
    return [value.reason, value.findings].filter(item => typeof item === "string").join("\n");
  } catch { throw refused(); }
}

export function localImportJournal(id: number): LocalImport | null {
  const row = getDb().prepare("SELECT actor, data_json FROM events WHERE task_id = ? AND kind = 'cloud_local_import' ORDER BY id DESC LIMIT 1").get(id) as { actor: string; data_json: string } | undefined;
  if (row?.actor !== "scheduler") return null;
  try {
    const value = JSON.parse(row.data_json) as LocalImport;
    const receipt = parseCloudReceipt(value.receipt); const record = cloudRunRecord(id);
    const started = getDb().prepare("SELECT actor FROM events WHERE task_id = ? AND kind = 'cloud_run_started' ORDER BY id DESC LIMIT 1").get(id) as { actor: string } | undefined;
    if (receipt?.kind !== "local" || !record || record.source !== "localMirror" || started?.actor !== "scheduler" ||
        loadConfig().projects?.[receipt.project]?.workspacePath !== receipt.repoRoot || realpathSync(receipt.repoRoot) !== receipt.repoRoot ||
        !["runId", "generation", "project", "repoRoot", "sourceBase", "snapshotCommit", "tree"].every(key => record[key as keyof CloudRunRecord] === receipt[key as keyof LocalCloudReceipt]) ||
        value.worktree?.root !== receipt.repoRoot || worktreeOwnershipError(id, value.worktree) || value.worktree.readOnly ||
        !oid.test(value.resultTree) || !Array.isArray(value.files) || !value.files.every(file => typeof file === "string") ||
        !Array.isArray(value.verification) || !value.verification.every(item => typeof item === "string")) return null;
    return value;
  } catch { return null; }
}

/** Compatibility/recovery authority is the receipt itself, even if an older host wrote no import journal. */
export async function recoverLocalDelivery(id: number, git: LocalGit): Promise<LocalImport | null> {
  const journal = localImportJournal(id);
  if (journal) return journal;
  const record = cloudRunRecord(id);
  const rawJournal = cloudEvent<LocalImport>(id, "cloud_local_import");
  if (rawJournal?.receipt?.generation === record?.generation) throw refused();
  const receipt = localCloudReceipt(id);
  if (!receipt || receipt.runId !== record?.runId || receipt.generation !== record.generation) return null;
  if (!isCloudDeliveryRun(id, receipt.runId)) throw refused();
  const worktree = ownedWorktree(id, readWorktreeCreated(id));
  if (!worktree || worktree.readOnly || worktree.root !== receipt.repoRoot) throw refused();
  const resultTree = await text(git, receipt.repoRoot, ["rev-parse", `${receipt.localHead}^{tree}`]);
  if (await text(git, receipt.repoRoot, ["rev-parse", `${receipt.cloudHead}^{tree}`]) !== resultTree ||
      await text(git, receipt.repoRoot, ["rev-list", "--parents", "-n", "1", receipt.cloudHead]) !== `${receipt.cloudHead} ${receipt.snapshotCommit}` ||
      await text(git, receipt.repoRoot, ["rev-parse", `${receipt.sourceBase}^{tree}`]) !== receipt.tree) throw refused();
  const files = (await git(receipt.repoRoot, ["diff", "--no-ext-diff", "--no-textconv", "--name-only", "-z", receipt.sourceBase, receipt.localHead])).split("\0").filter(Boolean);
  await scanLocalChanges(git, receipt.repoRoot, receipt.sourceBase, receipt.localHead, files);
  return { receipt, worktree, resultTree, files, verification: ["host-stamped local receipt and replay mapping: recovered"] };
}

export async function resumeLocalImport(id: number, journal: LocalImport, git: LocalGit): Promise<void> {
  const { receipt, worktree } = journal;
  if (!isCloudRunning(getTask(id)) || cloudRunRecord(id)?.generation !== receipt.generation) throw refused();
  const parent = await text(git, worktree.root, ["rev-parse", `${receipt.localHead}^`]);
  if (parent !== receipt.sourceBase || await text(git, worktree.root, ["rev-parse", `${receipt.localHead}^{tree}`]) !== journal.resultTree) throw refused();
  const saved = readWorktreeCreated(id);
  if (saved && (saved.directory !== worktree.directory || saved.branch !== worktree.branch || saved.root !== worktree.root || saved.readOnly)) throw refused();
  const list = await git(worktree.root, ["worktree", "list", "--porcelain"]);
  const exists = list.split("\n\n").some(row => row.split("\n").includes(`worktree ${worktree.directory}`) && row.split("\n").includes(`branch refs/heads/${worktree.branch}`));
  if (!exists) {
    if (saved) throw refused();
    mkdirSync(join(worktree.directory, ".."), { recursive: true, mode: 0o700 });
    await git(worktree.root, ["worktree", "add", "-b", worktree.branch, worktree.directory, receipt.sourceBase]);
  }
  if (realpathSync(worktree.directory) !== resolve(worktree.directory) || worktreeOwnershipError(id, worktree) ||
      await text(git, worktree.directory, ["rev-parse", "--show-toplevel"]) !== worktree.directory ||
      await text(git, worktree.directory, ["rev-parse", "--path-format=absolute", "--git-common-dir"]) !== await text(git, worktree.root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]) ||
      await text(git, worktree.directory, ["branch", "--show-current"]) !== worktree.branch ||
      (await git(worktree.directory, ["status", "--porcelain"])) !== "") throw refused();
  const head = await text(git, worktree.directory, ["rev-parse", "HEAD"]);
  if (head !== receipt.localHead) {
    if (head !== receipt.sourceBase) throw refused();
    await git(worktree.directory, ["merge", "--ff-only", receipt.localHead]);
  }
  const written = commitCloudWorktree({ taskId: id, runId: receipt.runId, generation: receipt.generation,
    directory: worktree.directory, data: { ...worktree, workspaceId: (saved as WorktreeRecord | null)?.workspaceId ?? null, temp: true },
    temp: { base: worktree.base, actor: "scheduler", holderId: null, code: cardMark(id), root: worktree.root, directory: worktree.directory } });
  if (!written.ok || written.intruders.length) throw refused();
  const prior = cloudEvent<LocalCloudReceipt>(id, "cloud_delivery");
  if (prior?.kind !== "local" || prior.localHead !== receipt.localHead || prior.generation !== receipt.generation) {
    appendEvent(id, "cloud_delivery", null, null, "scheduler", { ...receipt });
  }
}
