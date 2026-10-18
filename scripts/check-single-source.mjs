#!/usr/bin/env node
// The merged plugin owns one schema, lock, compiler and complete local gate set.
import { existsSync, readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { check as checkManifest } from "./sync-contract.mjs";
import { isolatedEnvironment } from "./isolated-environment.mjs";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (root, path) => readFileSync(join(root, path), "utf8");
export async function checkSingleSource(root, scope) {
  const failures = [];
  if (scope === "contract") {
    const manifest = await checkManifest({ root, source: null });
    if (manifest.count < 10) failures.push("canonical contract is incomplete");
    failures.push(...manifest.lines);
    for (const path of ["shared/contract/schema.ts", "server/contract/test/model-review.fixture.json", "server/contract/test/schema.test.ts", "server/contract/test/io.test.ts"]) {
      if (!existsSync(join(root, path))) failures.push(`missing compatibility input: ${path}`);
    }
    for (const path of ["shared/fleet/contract", "server/fleet/contract"]) if (existsSync(join(root, path))) failures.push(`duplicate contract: ${path}`);
    const snapshot = read(root, "shared/fleet/policy-snapshot.ts");
    if (!snapshot.includes('from "../contract/schema"')) failures.push("policy does not use canonical schemas");
  } else if (scope === "gates") {
    const pkg = JSON.parse(read(root, "package.json")), lock = JSON.parse(read(root, "package-lock.json"));
    const plugin = JSON.parse(read(root, "paseo-plugin.json"));
    if (plugin.id !== "paseo-kanban" || plugin.name !== "Paseo Kanban") failures.push("plugin identity differs");
    const sortedDependencies = value => Object.entries(value ?? {}).sort(([a], [b]) => a.localeCompare(b));
    if (pkg.name !== lock.name || pkg.version !== lock.version || JSON.stringify(sortedDependencies(pkg.dependencies)) !== JSON.stringify(sortedDependencies(lock.packages?.[""]?.dependencies))) failures.push("package and lock differ");
    for (const dir of ["client", "server", "shared"]) for (const entry of readdirSync(join(root, dir), { recursive: true, withFileTypes: true })) {
      if (entry.isFile() && ["paseo-plugin.json", "package-lock.json", "package.json", "index.server.ts", "index.client.tsx"].includes(entry.name)) failures.push(`second package/registration: ${entry.name}`);
    }
    const required = ["typecheck", "test (scripts)", "build (CLI)", "build (Paseo)", "test (plugin)", "scan (check-private --all)", "scan (public occurrence freshness)", "scan (reachable history)", "identity (next commit)", "identity (history)", "gitleaks (history)", "contract (single source + compatibility)", "shared gates (single source)", "pack:check"];
    const configured = JSON.parse(read(root, "scripts/local-gates.json"));
    const verifierPath = join(root, "scripts/verify.mjs");
    const verifier = await import(`${pathToFileURL(verifierPath).href}?content=${createHash("sha256").update(readFileSync(verifierPath)).digest("hex")}`);
    const local = verifier.steps();
    if (JSON.stringify(configured) !== JSON.stringify(required) || JSON.stringify(local.map(step => step.name)) !== JSON.stringify(required)) failures.push("local gates are incomplete or differ from the required set");
    // This independent contract prevents a modified verifier from approving its own substituted command.
    const commands = {
      "typecheck": ["scripts/typecheck.mjs"],
      "test (scripts)": ["--test", ...readdirSync(join(root, "scripts")).filter(name => name.endsWith(".test.mjs")).sort().map(name => `scripts/${name}`)],
      "build (CLI)": ["scripts/build-cli.mjs"],
      "build (Paseo)": ["scripts/paseo-build-check.mjs", "--strict"],
      "test (plugin)": ["scripts/test-plugin.mjs"],
      "scan (check-private --all)": ["scripts/check-private.mjs", "--all", "--quiet"],
      "scan (public occurrence freshness)": ["scripts/check-public-occurrences.mjs"],
      "scan (reachable history)": ["scripts/check-private.mjs", "--history", "HEAD", "--quiet"],
      "identity (next commit)": ["scripts/check-identity.mjs"],
      "identity (history)": ["scripts/check-identity.mjs", "--history"],
      "gitleaks (history)": ["git", "--log-opts=HEAD", "--redact", "--no-banner", "."],
      "contract (single source + compatibility)": ["scripts/check-single-source.mjs", "contract"],
      "shared gates (single source)": ["scripts/check-single-source.mjs", "gates"],
      "pack:check": ["scripts/check-package-files.mjs", "--secret-scan"],
    };
    for (const step of local) {
      const args = commands[step.name];
      const executable = step.name === "gitleaks (history)" ? "gitleaks" : process.execPath;
      if (!args || step.command[0] !== executable || JSON.stringify(step.command.slice(1)) !== JSON.stringify(args)) failures.push(`wrong local command: ${step.name}`);
    }
    for (const [key, value] of Object.entries({ verify: "node scripts/verify.mjs", "contract:check": "node scripts/check-single-source.mjs contract", "shared:check": "node scripts/check-single-source.mjs gates" })) if (pkg.scripts[key] !== value) failures.push(`wrong package gate: ${key}`);
    for (const hook of ["pre-commit", "pre-push"]) if (!read(root, `.githooks/${hook}`).trim() || !read(root, `.githooks/${hook}`).includes("node")) failures.push(`missing effective hook: ${hook}`);
  } else throw new Error("scope must be contract or gates");
  return failures;
}
async function main() {
  const scope = process.argv[2];
  const failures = await checkSingleSource(ROOT, scope);
  if (failures.length) { console.error(failures.join("\n")); return 1; }
  if (scope === "contract") {
    const temp = mkdtempSync(join(tmpdir(), "single-source-"));
    try {
      const env = isolatedEnvironment(temp);
      const tests = ["server/contract/test/schema.test.ts", "server/contract/test/io.test.ts", "server/contract/test/paths.test.ts", "test/policy-snapshot.test.ts", "test/actual-model-routing.test.ts", "test/immutable-admission.test.ts"];
      if (tests.some(path => !existsSync(join(ROOT, path)))) throw new Error("required compatibility/policy tests are missing");
      const result = spawnSync(process.execPath, ["--import", "tsx", "--test", ...tests], { cwd: ROOT, env, stdio: "inherit" });
      if (result.status !== 0) return result.status ?? 1;
    } finally { rmSync(temp, { recursive: true, force: true }); }
  }
  console.log(`single-source: ${scope} invariants passed`);
  return 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exitCode = await main(); } catch (error) { console.error(`single-source: ${error.message}`); process.exitCode = 2; }
}
