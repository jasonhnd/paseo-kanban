#!/usr/bin/env node
// Verify the immutable target, never an unrelated working checkout. No worktree or remote changes.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { exportCommit, objectId } from "./git-objects.mjs";
import { isolatedEnvironment } from "./isolated-environment.mjs";
import { defaultListPath } from "./check-private.mjs";
import { initializeFixture } from "./test-node.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function verifyRef(rev, { root = ROOT, keep = false, sourceEnv = process.env } = {}) {
  const commit = objectId(root, rev, "commit");
  const temporary = mkdtempSync(join(tmpdir(), "verify-ref-"));
  try {
    const env = isolatedEnvironment(temporary, { release: true,
      sourceEnv: { ...sourceEnv, FLEET_PRIVATE_DENYLIST: defaultListPath(sourceEnv) } });
    const fixture = join(temporary, "source"); mkdirSync(fixture);
    const source = exportCommit(root, commit, fixture);
    initializeFixture(fixture, env);
    console.log(`verify-ref: exact commit ${source.commit}, ${source.files} files`);
    for (const args of [["ci"], ["run", "--silent", "verify"]]) {
      const result = spawnSync("npm", args, { cwd: fixture, env, stdio: ["ignore", "inherit", "inherit"] });
      if (result.error) throw result.error;
      if (result.status !== 0) return result.status ?? 1;
    }
    return 0;
  } finally {
    if (keep) console.log(`verify-ref: evidence kept at ${temporary}`);
    else rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [ref, ...args] = process.argv.slice(2);
  try {
    if (!ref || args.some(arg => arg !== "--keep")) throw new Error("usage: verify-ref.mjs <commit-or-tag> [--keep]");
    process.exitCode = verifyRef(ref, { keep: args.includes("--keep") });
  } catch (error) { console.error(`verify-ref: ${error.message}`); process.exitCode = 2; }
}
