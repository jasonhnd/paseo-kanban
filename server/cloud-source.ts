/// <reference types="node" />
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { checkoutRoot, pluginRoot } from "./paths";
import { compileRules, scanFile } from "./privacy-scanner.mjs";
import { parseDenylist } from "../shared/privacy-denylist.mjs";
import { KanbanError } from "./errors";

const objectId = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const maxBuffer = 128 * 1024 * 1024;
const anonymous = { GIT_AUTHOR_NAME: "Anonymous contributor", GIT_COMMITTER_NAME: "Anonymous contributor",
  GIT_AUTHOR_EMAIL: "noreply@github.com", GIT_COMMITTER_EMAIL: "noreply@github.com",
  GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z" };

/** No inherited Git overrides, replacement refs, global templates, hooks or author identity. */
function git(repoRoot: string, args: string[], input?: string | Buffer): Buffer {
  return execFileSync("git", ["--no-replace-objects", "-c", "protocol.allow=never", "-c", "core.hooksPath=/dev/null", "-c", "core.attributesFile=/dev/null", "-C", repoRoot, ...args], {
    env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, LANG: "C", GIT_NO_LAZY_FETCH: "1", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", ...anonymous },
    input, maxBuffer, stdio: ["pipe", "pipe", "pipe"],
  });
}
const gitText = (repoRoot: string, args: string[], input?: string | Buffer) => git(repoRoot, args, input).toString("utf8").trim();

function entries(repoRoot: string, tree: string) {
  if (!objectId.test(tree) || gitText(repoRoot, ["cat-file", "-t", tree]) !== "tree") throw new Error("invalid tree");
  const bytes = git(repoRoot, ["ls-tree", "-r", "-t", "-z", "--full-tree", tree]);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (text && !text.endsWith("\0")) throw new Error("incomplete tree");
  return text.split("\0").filter(Boolean).map(row => {
    const match = /^(\d{6}) (blob|tree|commit) ([0-9a-f]{40,64})\t([\s\S]+)$/.exec(row);
    if (!match) throw new Error("invalid tree entry");
    return { mode: match[1], type: match[2], id: match[3], path: match[4] };
  });
}
function safeEntry(entry: ReturnType<typeof entries>[number]): boolean {
  return ((entry.type === "blob" && ["100644", "100755"].includes(entry.mode)) || (entry.type === "tree" && entry.mode === "040000")) && !entry.path.startsWith("/") &&
    !/[\x00-\x1f\x7f\\]/.test(entry.path) && entry.path.split("/").every(part => part && part !== "." && part !== ".." && !/^\.git(?:$|[ .])/i.test(part));
}

/** Bound memory and validate every batch frame; never start a subprocess per source file. */
function readBlobs(repoRoot: string, ids: string[]): Map<string, Buffer> {
  const blobs = new Map<string, Buffer>();
  const unique = [...new Set(ids)]; let total = 0;
  for (let start = 0; start < unique.length; start += 128) {
    const batch = unique.slice(start, start + 128);
    const bytes = git(repoRoot, ["cat-file", "--batch"], `${batch.join("\n")}\n`);
    let offset = 0;
    for (const id of batch) {
      const end = bytes.indexOf(10, offset);
      const header = /^(\w+) blob (\d+)$/.exec(bytes.subarray(offset, end).toString("ascii"));
      const size = Number(header?.[2]);
      if (end < 0 || header?.[1] !== id || !Number.isSafeInteger(size) || size < 0 ||
          end + 1 + size >= bytes.length || bytes[end + 1 + size] !== 10) throw new Error("invalid blob frame");
      total += size;
      if (total > maxBuffer) throw new Error("source scan exceeds memory limit");
      blobs.set(id, bytes.subarray(end + 1, end + 1 + size));
      offset = end + 2 + size;
    }
    if (offset !== bytes.length) throw new Error("unexpected blob bytes");
  }
  return blobs;
}

export interface SourceSnapshot {
  bundlePath: string; sourceBase: string; snapshotCommit: string; tree: string; bytes: number; sha256: string;
}

/** Export the pinned tree into fresh object storage, then bundle only its anonymous root.
 * Caller must scan this exact tree and all transmitted metadata and enforce maxSourceBytes before upload. */
export function createSourceSnapshot(input: { repoRoot: string; baseCommit: string; scratchDir: string }): SourceSnapshot {
  const { repoRoot, baseCommit, scratchDir } = input;
  let created = false;
  try {
    if (!objectId.test(baseCommit) || gitText(repoRoot, ["cat-file", "-t", baseCommit]) !== "commit") throw new Error("unpinned source");
    if (!isAbsolute(scratchDir) || realpathSync(scratchDir) !== resolve(scratchDir) || readdirSync(scratchDir).length) throw new Error("scratch must be empty and canonical");
    const tree = gitText(repoRoot, ["rev-parse", "--verify", `${baseCommit}^{tree}`]);
    if (entries(repoRoot, tree).some(entry => !safeEntry(entry))) throw new Error("unsupported tree entry");
    const isolated = join(scratchDir, "source.git"); mkdirSync(isolated, { mode: 0o700 }); created = true;
    const format = baseCommit.length === 64 ? "sha256" : "sha1";
    git(isolated, ["init", "--bare", "--template=", `--object-format=${format}`]);
    // A tree traversal includes no original commits. Disable delta reuse to keep the object set exact.
    const pack = git(repoRoot, ["pack-objects", "--stdout", "--revs", "--no-reuse-object", "--no-reuse-delta", "--window=0"], `${tree}\n`);
    git(isolated, ["index-pack", "--stdin"], pack);
    const snapshotCommit = gitText(isolated, ["commit-tree", tree], "Anonymous source snapshot\n");
    git(isolated, ["update-ref", "refs/heads/source", snapshotCommit]);
    git(isolated, ["symbolic-ref", "HEAD", "refs/heads/source"]);
    const bundlePath = join(scratchDir, "source.bundle");
    git(isolated, ["bundle", "create", bundlePath, "HEAD", "refs/heads/source"]);
    git(isolated, ["bundle", "verify", bundlePath]);
    const bundle = readFileSync(bundlePath);
    rmSync(isolated, { recursive: true, force: true });
    return { bundlePath, sourceBase: baseCommit, snapshotCommit, tree, bytes: bundle.length,
      sha256: createHash("sha256").update(bundle).digest("hex") };
  } catch {
    if (created) {
      rmSync(join(scratchDir, "source.git"), { recursive: true, force: true });
      rmSync(join(scratchDir, "source.bundle"), { force: true });
    }
    throw new KanbanError("cloud_source_invalid", "Cannot create an anonymous source snapshot");
  }
}

export interface Finding { scope: "tree" | "brief" | "feedback" | "environment" | "setup"; rule: string; file?: number; line?: number }

/** Findings contain categories/ordinals only, never source paths, denied terms or input text. */
export function scanOutbound(input: {
  repoRoot: string; tree: string; brief: string; feedback: string; environment: Record<string, string>;
}): Finding[] {
  try {
    const { repoRoot, tree, brief, feedback, environment } = input;
    if (typeof brief !== "string" || typeof feedback !== "string" || !environment || typeof environment !== "object" || Array.isArray(environment)) throw new Error("invalid scan inputs");
    // Keep policy data at its canonical published path, and keep unrelated standalone CLI commands independent of it.
    const policy = createRequire(join(checkoutRoot() ?? pluginRoot(), "package.json"))("./shared/privacy-rules.mjs") as { default: object };
    const compiled = compileRules(policy.default);
    // Outbound scans every byte, including binaries and extensions ignored by the contributor gate.
    compiled.ignore = [];
    compiled.rules.push(...compiled.outboundRules);
    // Runtime does not apply development-only AST identifier exceptions: uncertain matches refuse export.
    const denylistPath = process.env.FLEET_PRIVATE_DENYLIST?.trim() || join(homedir(), ".config", "paseo-fleet", "private-denylist.txt");
    const privateRules = parseDenylist(readFileSync(denylistPath, "utf8"));
    const findings: Finding[] = [];
    const scan = (scope: Finding["scope"], path: string, text: string, file?: number, binary = false, pathOnly = false) => {
      const policy = binary ? { ...compiled, rules: compiled.rules.filter(rule => rule.id !== "cjk-outside-locales") } : compiled;
      for (const hit of scanFile(path, text, policy, pathOnly ? [] : privateRules)) findings.push({ scope, rule: hit.rule, file, line: hit.line });
      // The real host home is never treated as a demonstration placeholder.
      if (text.includes(homedir())) findings.push({ scope, rule: "local-path", file });
    };
    const files = entries(repoRoot, tree);
    const blobs = readBlobs(repoRoot, files.filter(entry => entry.type === "blob" && safeEntry(entry)).map(entry => entry.id));
    files.forEach((entry, file) => {
      if (!safeEntry(entry)) { findings.push({ scope: "tree", rule: "unsupported-mode", file }); return; }
      if (/(?:^|\/)(?:\.local-evidence|notebooks?|handoffs?)(?:[./_-]|$)/i.test(entry.path)) findings.push({ scope: "tree", rule: "private-evidence", file });
      // Private path matches are already scanned by scanFile with path-bound fingerprints.
      scan("tree", entry.path, `/${entry.path}`, file, false, true);
      if (entry.type === "tree") {
        for (const hit of scanFile(entry.path, null, compiled, privateRules)) findings.push({ scope: "tree", rule: hit.rule, file, line: hit.line });
        return;
      }
      const data = blobs.get(entry.id)!;
      const binary = data.includes(0) || new TextDecoder("utf-8").decode(data).includes("\ufffd");
      scan("tree", entry.path, data.toString("utf8"), file, binary);
      // Do not let UTF-16 text or a binary NUL suppress content scanning.
      if (data.includes(0) || (data[0] === 255 && data[1] === 254)) scan("tree", entry.path, data.toString("utf16le"), file, true);
      if (data[0] === 254 && data[1] === 255) scan("tree", entry.path, Buffer.from(data).swap16().toString("utf16le"), file, true);
    });
    scan("brief", "outbound/brief.txt", brief);
    scan("feedback", "outbound/feedback.txt", feedback);
    for (const [key, value] of Object.entries(environment)) {
      if (typeof value !== "string") throw new Error("invalid environment");
      scan("environment", "outbound/environment.txt", `${key}\n${value}`);
    }
    return findings;
  } catch { return [{ scope: "setup", rule: "scan-unavailable" }]; }
}
