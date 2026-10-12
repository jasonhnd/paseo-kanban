#!/usr/bin/env node
// Third gate: what `npm pack` would publish. The repository root is the plugin package: run
// `npm pack --ignore-scripts --json` there and scan the actual tarball, refusing files outside the whitelist,
// tests, fixtures, source maps, private content and, when required, secrets;
// any JSON data file that is not an example or a locale, and any path the private-scan rules forbid.
// The manifest files (package.json, paseo-plugin.json, OVERVIEW.md, LICENSE) must be in the package, and
// every file paseo-plugin.json points to (icon, media) must be in it too.
//
// Usage: node scripts/check-package-files.mjs [--print] [--secret-scan] [--root <repository>]
//   --print   list every packed file (for the human check before the first release)
//   --secret-scan   require gitleaks for the actual extracted package (used by all release entry points)
// Exit: 0 clean, 1 refused files, 2 setup problem.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { EXIT, isForbiddenPath, loadRules, loadDenylist, defaultListPath, scanFile } from "./check-private.mjs";
import { packageEntries } from "./package-artifact.mjs";

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const ALLOWED = /^(paseo-plugin\.json|OVERVIEW\.md|LICENSE|README\.md|package\.json|index\.(client\.tsx|server\.ts)|(client|server|shared|locales|bin|assets|examples)\/.+)$/;
export const BLOCKED = /(\.test\.|(^|\/)__fixtures__\/|\.map$|^bin\/(test|coverage)\.mjs$|^server\/(?:[^/]+\/)*test\/)/;
const JSON_ALLOWED = /^(package\.json|paseo-plugin\.json|(.+\/)?locales\/.+\.json|(.+\/)?[^/]+\.example\.json)$/;
export const REQUIRED = ["package.json", "paseo-plugin.json", "OVERVIEW.md", "LICENSE"];
const COMMAND_BUNDLES = ["cli", "check-missing-cwd", "local-decisions", "migrate"].map(name => `bin/${name}.bundle.mjs`);

export function parseArgs(argv) {
  const options = { print: false, secretScan: false, root: DEFAULT_ROOT };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--print") options.print = true;
    else if (arg === "--secret-scan") options.secretScan = true;
    else if (arg === "--root") {
      if (!argv[i + 1]) throw new Error("--root needs a directory");
      options.root = resolve(argv[(i += 1)]);
    } else throw new Error(`unknown argument ${arg}`);
  }
  return options;
}

/** Problems with one package's file list. `manifest` is the parsed paseo-plugin.json (or null). */
export function checkFiles(files, manifest, compiled = loadRules(), requiredCommands = []) {
  const problems = [];
  const present = new Set(files);
  for (const file of files) {
    if (!ALLOWED.test(file) || file.split("/").some(part => ["..", ".", ""].includes(part))) problems.push(`${file}: not in the whitelist`);
    else if (BLOCKED.test(file)) problems.push(`${file}: tests, fixtures and source maps are never published`);
    else if (file.endsWith(".json") && !JSON_ALLOWED.test(file)) problems.push(`${file}: JSON data files are never published (only *.example.json and locales/)`);
    if (isForbiddenPath(file, compiled)) problems.push(`${file}: forbidden by scripts/private-scan.rules.json`);
  }
  for (const file of [...REQUIRED, ...requiredCommands]) if (!present.has(file)) problems.push(`${file}: missing from the package`);
  const referenced = [manifest?.icon, ...(Array.isArray(manifest?.media) ? manifest.media : [])].filter((value) => typeof value === "string");
  for (const file of referenced) if (!present.has(file.replace(/^\.\//, ""))) problems.push(`${file}: named in paseo-plugin.json but not in the package`);
  return problems;
}

function packedContents(dir) {
  const temporary = mkdtempSync(join(tmpdir(), "package-scan-"));
  try {
    const out = execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", temporary], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const json = JSON.parse(out);
    const results = Array.isArray(json) ? json : Object.values(json ?? {});
    const expected = packResultFiles(json);
    const filename = results[0].filename;
    if (typeof filename !== "string" || !/^[A-Za-z0-9._-]+\.tgz$/.test(filename)) throw new Error("unsafe npm archive filename");
    const entries = packageEntries(readFileSync(join(temporary, filename)));
    const actual = entries.map(entry => entry.path).sort();
    if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error("npm package manifest does not match tarball contents");
    return entries;
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

/** npm 10 prints an array of results, npm 11 and later an object keyed by package name. */
export function packResultFiles(json) {
  const results = Array.isArray(json) ? json : Object.values(json ?? {});
  if (results.length !== 1 || !Array.isArray(results[0]?.files)) throw new Error("unexpected npm pack --json output");
  return results[0].files.map((file) => file.path).sort();
}

/** The root package's packed files and their problems. A private root package is a setup problem. */
export function run(options) {
  const compiled = loadRules();
  const pkg = JSON.parse(readFileSync(join(options.root, "package.json"), "utf8"));
  if (pkg.private) throw new Error("package.json is private; the repository root must be the published plugin package");
  const manifestPath = join(options.root, "paseo-plugin.json");
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : null;
  const entries = packedContents(options.root);
  const files = entries.map(entry => entry.path).sort();
  const commands = typeof pkg.bin === "string" ? [pkg.bin] : Object.values(pkg.bin ?? {});
  const requiredCommands = commands.some(path => typeof path === "string" && path.replace(/^\.\//, "") === "bin/paseo-kanban.mjs") ? COMMAND_BUNDLES : [];
  if (commands.includes("bin/afc.mjs")) requiredCommands.push(...["roles", "doctor", "coupon", "leader"].map(name => `bin/fleet-${name}.bundle.mjs`));
  const problems = checkFiles(files, manifest, compiled, requiredCommands);
  const privateRules = loadDenylist(defaultListPath());
  for (const entry of entries) {
    for (const hit of scanFile(entry.path, entry.data.includes(0) ? null : entry.data.toString("utf8"), compiled, privateRules)) {
      problems.push(`${entry.path}:${hit.line}: ${hit.rule} in actual package content (redacted)`);
    }
  }
  if (options.secretScan) {
    const temporary = mkdtempSync(join(tmpdir(), "package-secrets-"));
    try {
      for (const entry of entries) {
        const file = join(temporary, entry.path); mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, entry.data);
      }
      const out = spawnSync("gitleaks", ["dir", "--redact", "--no-banner", temporary], { stdio: ["ignore", "inherit", "inherit"] });
      if (out.error) throw new Error("gitleaks is required for package secret scanning");
      if (out.status !== 0) problems.push("actual package secret scan failed (redacted)");
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  }
  return { name: pkg.name, files, problems };
}

function main() {
  let report;
  try {
    const options = parseArgs(process.argv.slice(2));
    report = run(options);
    console.log(`${report.name}: ${report.files.length} file(s), ${report.problems.length} problem(s)`);
    if (options.print) for (const file of report.files) console.log(`  ${file}`);
    for (const problem of report.problems) console.log(`  refused: ${problem}`);
  } catch (error) {
    console.error(`check-package-files: ${error.message ?? error}`);
    return EXIT.setup;
  }
  return report.problems.length > 0 ? EXIT.hits : EXIT.clean;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
