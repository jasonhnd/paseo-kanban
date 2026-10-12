#!/usr/bin/env node
// Portable, offline-provider tests. All builds, state and subprocess HOME stay in a disposable tree.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { exportCommit, git } from "./git-objects.mjs";
import { isolatedEnvironment } from "./isolated-environment.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function testSteps({ buildCheck = false } = {}) {
  return ["typecheck", "test", "build", ...(buildCheck ? ["build:check"] : []), "test:plugin"];
}

export function initializeFixture(root, env) {
  git(root, ["init", "-q"], { env });
  git(root, ["config", "user.name", "paseo-fleet contributors"], { env });
  git(root, ["config", "user.email", "noreply@example.invalid"], { env });
  git(root, ["add", "."], { env });
  git(root, ["commit", "-qm", "Anonymous source-tree fixture"], { env });
  mkdirSync(join(root, ".git/info"), { recursive: true });
  writeFileSync(join(root, ".git/info/exclude"), "node_modules\n");
}

export function runTestNode(argv = []) {
  if (argv.some(arg => !["--build-check", "--keep"].includes(arg))) throw new Error("usage: test-node.mjs [--build-check] [--keep]");
  if (!existsSync(join(ROOT, "node_modules/typescript"))) throw new Error("run npm ci before test:node");
  const temporary = mkdtempSync(join(tmpdir(), "paseo-node-"));
  try {
    const env = isolatedEnvironment(temporary);
    const fixture = join(temporary, "source"); mkdirSync(fixture);
    const source = exportCommit(ROOT, "HEAD", fixture);
    initializeFixture(fixture, env);
    symlinkSync(join(ROOT, "node_modules"), join(fixture, "node_modules"), "dir");
    console.log(`test:node: ${source.commit}; ${source.files} files; ${process.platform}; Node ${process.version}; no Python/provider/daemon on PATH`);
    for (const step of testSteps({ buildCheck: argv.includes("--build-check") })) {
      console.log(`test:node: npm run ${step}`);
      const out = spawnSync("npm", ["run", "--silent", step], { cwd: fixture, env, stdio: "inherit" });
      if (out.error) throw out.error;
      if (out.status !== 0) return out.status ?? 1;
    }
    return 0;
  } finally {
    if (argv.includes("--keep")) console.log(`test:node: kept disposable evidence at ${temporary}`);
    else rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exitCode = runTestNode(process.argv.slice(2)); }
  catch (error) { console.error(`test:node: ${error.message}`); process.exitCode = 2; }
}
