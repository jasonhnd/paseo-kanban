/// <reference types="node" />
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { resolve } from "node:path";
import { t } from "../shared/i18n";
import { getDb } from "./db";
import { KanbanError } from "./errors";
import { headRef, refOk, runGit, type GitRunner } from "./git";

/** Cleanup keeps a branch when the recorded acceptance commit is outside the local base. */
export const ARTIFACT_KEEP_BRANCH = "artifact_not_in_base";

const FILE_LIMIT = 64 * 1024 * 1024;
const INPUT_LIMIT = 8000;
const SHA = /^[0-9a-fA-F]{7,64}$/;
const FULL_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const PULL_REQUEST = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*\/?$/;

/** Detector built from pieces so the source file does not contain a complete credential. */
function secretDetector(): RegExp {
  const marker = (...parts: string[]) => parts.join("");
  const body = [
    `${marker("gh", "p_")}[A-Za-z0-9]{20,}`,
    `${marker("github", "_pat_")}[A-Za-z0-9_]{20,}`,
    `${marker("s", "k-")}[A-Za-z0-9_-]{20,}`,
    `${marker("xo", "x")}[abpr]-[A-Za-z0-9-]{10,}`,
    `${marker("AK", "IA")}[0-9A-Z]{16}`,
    `${marker("AI", "za")}[0-9A-Za-z_-]{20,}`,
    `${marker("np", "m_")}[A-Za-z0-9]{20,}`,
    `${marker("xa", "i-")}[A-Za-z0-9]{20,}`,
    marker("-----BEGIN ", "[A-Z ]*PRIVATE KEY-----"),
    `${marker("Bear", "er ")}[A-Za-z0-9._~+/-]{16,}`,
    "[?&](?:token|key|secret|sig)=",
  ].join("|");
  return new RegExp(`(?:${body})`, "i");
}

const SECRET = secretDetector();

export interface ArtifactBranch {
  root: string;
  branch: string;
  base: string;
}

export interface ArtifactAcceptance {
  sha: string;
  tree: string;
  branch: string | null;
  base: string | null;
  evidenceKind: "commit" | "file" | "pull_request";
  evidence: string;
  evidencePath?: string;
  evidenceSha256?: string;
  evidenceBytes?: number;
  reason?: string;
}

interface CommitId {
  sha: string;
  tree: string;
}

function invalid(key: "artifactAccept.badEvidence" | "artifactAccept.emptyFile" | "artifactAccept.missing" | "artifactAccept.noTarget" | "artifactAccept.notFile" | "artifactAccept.prReason" | "artifactAccept.secret" | "artifactAccept.unreadable", vars?: Record<string, string | number>): never {
  throw new KanbanError("invalid", t(key, vars));
}

function mismatch(sha: string): never {
  throw new KanbanError("invalid", t("artifactAccept.shaMismatch", { sha }));
}

function hasSecret(value: string): boolean {
  return SECRET.test(value);
}

function refuseSecret(value: string): void {
  if (hasSecret(value)) invalid("artifactAccept.secret");
}

/** Latest recorded acceptance commit, or null when this card has no artifact acceptance. */
export function artifactAcceptanceSha(taskId: number): string | null {
  const row = getDb()
    .prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'artifact_accepted' ORDER BY id DESC LIMIT 1")
    .get(taskId) as { data_json: string } | undefined;
  if (!row) return null;
  try {
    const data = JSON.parse(row.data_json) as { sha?: unknown };
    return typeof data.sha === "string" && FULL_SHA.test(data.sha) ? data.sha : null;
  } catch {
    return null;
  }
}

/** True only when git can prove the commit is already in the local base branch. */
export async function artifactCommitInBase(root: string, sha: string, base: string, run: GitRunner = (cwd, args) => runGit(cwd, args)): Promise<boolean> {
  if (!FULL_SHA.test(sha) || !refOk(base)) return false;
  const result = await run(root, ["merge-base", "--is-ancestor", sha, headRef(base)]);
  return result.code === 0;
}

async function verifyCommit(cwd: string, spec: string): Promise<CommitId | null> {
  if (!SHA.test(spec)) return null;
  const commit = await runGit(cwd, ["rev-parse", "--verify", "--end-of-options", `${spec}^{commit}`]);
  if (commit.code !== 0) return null;
  const sha = commit.stdout.trim().toLowerCase();
  if (!FULL_SHA.test(sha)) return null;
  const tree = await runGit(cwd, ["rev-parse", "--verify", "--end-of-options", `${sha}^{tree}`]);
  if (tree.code !== 0) return null;
  const treeSha = tree.stdout.trim().toLowerCase();
  if (!FULL_SHA.test(treeSha)) return null;
  return { sha, tree: treeSha };
}

async function branchTip(owned: ArtifactBranch): Promise<CommitId | null> {
  if (!refOk(owned.branch)) return null;
  const listed = await runGit(owned.root, ["rev-parse", "--verify", "--end-of-options", headRef(owned.branch)]);
  if (listed.code !== 0) return null;
  return verifyCommit(owned.root, listed.stdout.trim());
}

function containsSha(text: string, sha: string): boolean {
  return new RegExp(`(?:^|[^0-9a-fA-F])${sha}(?![0-9a-fA-F])`, "i").test(text);
}

async function soleCommit(cwd: string, text: string): Promise<CommitId | "many" | null> {
  const tokens = [...new Set((text.match(/\b[0-9a-fA-F]{7,64}\b/g) ?? []).map((item) => item.toLowerCase()))].slice(0, 40);
  let found: CommitId | null = null;
  for (const token of tokens) {
    const verified = await verifyCommit(cwd, token);
    if (!verified) continue;
    if (found && found.sha !== verified.sha) return "many";
    found = verified;
  }
  return found;
}

async function bundleHeads(cwd: string, file: string): Promise<string[]> {
  const listed = await runGit(cwd, ["bundle", "list-heads", "--", file]);
  if (listed.code !== 0) return [];
  const shas = new Set<string>();
  for (const line of listed.stdout.split(/\r?\n/)) {
    const sha = line.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
    if (FULL_SHA.test(sha)) shas.add(sha);
  }
  return [...shas];
}

async function readRegularFile(file: string): Promise<{ sha256: string; bytes: number; text: string }> {
  let info;
  try {
    info = await lstat(file);
  } catch {
    invalid("artifactAccept.unreadable");
  }
  if (info.isSymbolicLink() || !info.isFile()) invalid("artifactAccept.notFile");
  if (info.size === 0) invalid("artifactAccept.emptyFile");
  if (info.size > FILE_LIMIT) throw new KanbanError("invalid", t("artifactAccept.tooLarge", { bytes: FILE_LIMIT }));
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    invalid("artifactAccept.unreadable");
  }
  try {
    const body = await handle.readFile();
    if (body.length === 0) invalid("artifactAccept.emptyFile");
    if (body.length > FILE_LIMIT) throw new KanbanError("invalid", t("artifactAccept.tooLarge", { bytes: FILE_LIMIT }));
    return {
      sha256: createHash("sha256").update(body).digest("hex"),
      bytes: body.length,
      text: body.toString("utf8"),
    };
  } catch (err) {
    if (err instanceof KanbanError) throw err;
    invalid("artifactAccept.unreadable");
  } finally {
    await handle.close();
  }
}

function storedReason(reason: string | undefined): string | undefined {
  if (reason == null) return undefined;
  if (reason.length > INPUT_LIMIT) invalid("artifactAccept.badEvidence");
  refuseSecret(reason);
  const trimmed = reason.trim();
  if (!trimmed || trimmed === "true") return undefined;
  return trimmed.slice(0, 2000);
}

/**
 * Read an explicit acceptance target. This only runs git reads (rev-parse and bundle list-heads).
 * A missing remote is not evidence and does not select this mode.
 */
export async function resolveArtifactEvidence(input: {
  evidence: string;
  reason?: string;
  workspacePath: string | null;
  owned: ArtifactBranch | null;
}): Promise<ArtifactAcceptance> {
  const evidence = input.evidence;
  if (evidence.length > INPUT_LIMIT) invalid("artifactAccept.badEvidence");
  const trimmed = evidence.trim();
  if (!trimmed || trimmed === "true") invalid("artifactAccept.missing");
  refuseSecret(evidence);
  const reason = storedReason(input.reason);
  const cwd = input.owned?.root ?? (input.workspacePath?.trim() || null);
  const tip = input.owned ? await branchTip(input.owned) : null;
  if (input.owned && !tip) invalid("artifactAccept.noTarget");

  const baseRecord = (target: CommitId, kind: ArtifactAcceptance["evidenceKind"], display: string, extra: Partial<ArtifactAcceptance> = {}): ArtifactAcceptance => ({
    sha: target.sha,
    tree: target.tree,
    branch: input.owned?.branch ?? null,
    base: input.owned?.base ?? null,
    evidenceKind: kind,
    evidence: display,
    ...(reason ? { reason } : {}),
    ...extra,
  });

  if (SHA.test(trimmed)) {
    if (!cwd) invalid("artifactAccept.noTarget");
    const resolved = await verifyCommit(cwd, trimmed);
    if (!resolved) throw tip ? mismatch(tip.sha) : invalid("artifactAccept.noTarget");
    if (tip && resolved.sha !== tip.sha) mismatch(tip.sha);
    return baseRecord(resolved, "commit", resolved.sha);
  }

  if (PULL_REQUEST.test(trimmed)) {
    if (!reason) invalid("artifactAccept.prReason");
    if (!tip) invalid("artifactAccept.noTarget");
    return baseRecord(tip, "pull_request", trimmed);
  }

  if (trimmed.startsWith("-") || /[\0\r\n]/.test(trimmed)) invalid("artifactAccept.badEvidence");
  const file = resolve(trimmed);
  refuseSecret(file);
  const body = await readRegularFile(file);
  if (!cwd) invalid("artifactAccept.noTarget");
  const fileExtra = { evidencePath: file, evidenceSha256: body.sha256, evidenceBytes: body.bytes };
  if (tip) {
    const heads = await bundleHeads(cwd, file);
    const named = heads.includes(tip.sha) || containsSha(body.text, tip.sha);
    if (!named) mismatch(tip.sha);
    return baseRecord(tip, "file", `file:${body.sha256}`, fileExtra);
  }
  const sole = await soleCommit(cwd, body.text);
  if (sole === "many") invalid("artifactAccept.badEvidence");
  if (sole) return baseRecord(sole, "file", `file:${body.sha256}`, fileExtra);
  const heads = await bundleHeads(cwd, file);
  if (heads.length !== 1) throw heads.length > 1 ? invalid("artifactAccept.badEvidence") : invalid("artifactAccept.noTarget");
  const bundled = await verifyCommit(cwd, heads[0] ?? "");
  if (!bundled) invalid("artifactAccept.noTarget");
  return baseRecord(bundled, "file", `file:${body.sha256}`, fileExtra);
}
