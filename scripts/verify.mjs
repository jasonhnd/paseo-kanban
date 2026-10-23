#!/usr/bin/env node
// `npm run verify`: the release gates, run locally. No hosted CI is required.
// pre-push runs this gate set in each immutable outgoing target and refuses on failure.
// Contract, compatibility fixtures and gate commands are checked inside the one package.
//
// Every step runs, even after a failure, so one run lists everything that is wrong. Steps that have
// nothing to check yet (no plugin code) pass with a note; they never skip an error.
// PASEO_SERVER_DIR or PASEO_PLUGIN_COMPILER selects the actual supported compiler entry.
// Exit: 0 when every step passed, 1 otherwise.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const node = (...args) => [process.execPath, ...args];
const scriptTests = () => readdirSync(join(ROOT, "scripts")).filter((name) => name.endsWith(".test.mjs")).sort().map((name) => `scripts/${name}`);

/** The local release gate set. */
export function steps() {
  return [
    { name: "typecheck", command: node("scripts/typecheck.mjs") },
    { name: "test (scripts)", command: node("scripts/test-scripts.mjs", ...scriptTests()) },
    { name: "build (CLI)", command: node("scripts/build-cli.mjs") },
    { name: "build (Paseo)", command: node("scripts/paseo-build-check.mjs", "--strict") },
    { name: "test (plugin)", command: node("scripts/test-plugin.mjs") },
    { name: "scan (check-private --all)", command: node("scripts/check-private.mjs", "--all", "--quiet") },
    { name: "scan (public occurrence freshness)", command: node("scripts/check-public-occurrences.mjs") },
    { name: "scan (reachable history)", command: node("scripts/check-private.mjs", "--history", "HEAD", "--quiet") },
    { name: "identity (next commit)", command: node("scripts/check-identity.mjs") },
    { name: "identity (history)", command: node("scripts/check-identity.mjs", "--history") },
    { name: "gitleaks (history)", command: ["gitleaks", "git", "--log-opts=HEAD", "--redact", "--no-banner", "."], missing: "gitleaks is required for publication verification" },
    { name: "contract (single source + compatibility)", command: node("scripts/check-single-source.mjs", "contract") },
    { name: "shared gates (single source)", command: node("scripts/check-single-source.mjs", "gates") },
    { name: "pack:check", command: node("scripts/check-package-files.mjs", "--secret-scan") },
  ];
}

/** Run each step with inherited output; returns one { name, ok, why } per step. */
export function runSteps(list, cwd = ROOT, log = console.log) {
  const results = [];
  for (const step of list) {
    log(`\n=== verify: ${step.name}`);
    const out = spawnSync(step.command[0], step.command.slice(1), { cwd, stdio: ["ignore", "inherit", "inherit"] });
    if (out.error?.code === "ENOENT") results.push({ name: step.name, ok: false, why: step.missing ?? `${step.command[0]} not found` });
    else results.push({ name: step.name, ok: out.status === 0, why: out.status === 0 ? "" : `exit ${out.status ?? out.signal}` });
  }
  return results;
}

async function main() {
  const { createTestTmp, removeTestTmp } = await import("../test/helpers/test-tmp.mjs");
  const { privateTestEnvironment } = await import("../test/helpers/test-environment.mjs");
  const { assertTestEnvironment } = await import("../server/storage/test-safety.ts");
  assertTestEnvironment(process.env);
  const root = createTestTmp();
  const previous = { ...process.env };
  let results;
  try {
    const env = privateTestEnvironment(root);
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
    Object.assign(process.env, env);
    results = runSteps(steps());
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    removeTestTmp(root);
  }
  console.log("\n=== verify: summary");
  for (const result of results) console.log(`${result.ok ? "ok    " : "FAILED"} ${result.name}${result.why ? ` (${result.why})` : ""}`);
  const failed = results.filter((result) => !result.ok).length;
  console.log(failed === 0 ? "verify: all gates passed" : `verify: ${failed} gate(s) failed`);
  return failed === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
