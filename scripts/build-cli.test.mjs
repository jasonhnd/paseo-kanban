import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildCli, ENTRIES, FLEET_ENTRIES } from "./build-cli.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const temps = [];
after(() => { for (const dir of temps) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cli-bundle-test-")));
  temps.push(root);
  mkdirSync(join(root, "server"));
  return root;
}

test("an empty skeleton is allowed; a partial command set fails", async () => {
  const root = fixture();
  await buildCli(root);
  writeFileSync(join(root, "server/cli.ts"), "export {};\n");
  await assert.rejects(buildCli(root), /incomplete CLI source set/);
});

test("all routes run bundled TypeScript under Node with no node_modules", async () => {
  const root = fixture();
  writeFileSync(join(root, "server/helper.ts"), `
import { pathToFileURL } from "node:url";
export const word: string = "ready";
const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invoked) { console.error("unintended-main"); process.exitCode = 19; }
`);
  for (const name of ENTRIES) writeFileSync(join(root, "server", `${name}.ts`), `
import { pathToFileURL } from "node:url";
import { word } from "./helper";
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log("${name}", word, ...process.argv.slice(2));
  if (process.argv.includes("--parent")) console.log("parent:" + process.ppid);
  if (process.argv.includes("--fail")) process.exitCode = 7;
}
`);
  await buildCli(root);
  for (const name of ENTRIES) {
    const out = spawnSync(process.execPath, [join(root, "bin", `${name}.bundle.mjs`), "--help"], { encoding: "utf8" });
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, new RegExp(`${name} ready --help`));
  }
  if (!existsSync(join(ROOT, "bin/paseo-kanban.mjs"))) return;
  for (const name of ["paseo-kanban.mjs", "check-missing-cwd"]) copyFileSync(join(ROOT, "bin", name), join(root, "bin", name));
  assert.equal(existsSync(join(root, "node_modules")), false);
  const run = (bin, ...args) => spawnSync(process.execPath, [join(root, "bin", bin), ...args], { encoding: "utf8" });
  assert.match(run("paseo-kanban.mjs", "--help").stdout, /cli ready --help/);
  assert.match(run("paseo-kanban.mjs", "decide", "--help").stdout, /local-decisions ready --help/);
  assert.match(run("paseo-kanban.mjs", "migrate", "--help").stdout, /migrate ready --help/);
  assert.match(run("check-missing-cwd", "--json").stdout, /check-missing-cwd ready --json/);
  assert.match(run("check-missing-cwd", "--help").stdout, /Usage: check-missing-cwd/);
  assert.equal(run("paseo-kanban.mjs", "--fail").status, 7);
  for (const args of [["wait-bg", "--parent"], ["--json", "wait-bg", "--parent"]]) {
    assert.match(run("paseo-kanban.mjs", ...args).stdout, new RegExp(`parent:${process.pid}\\b`));
  }
  assert.doesNotMatch(readFileSync(join(root, "bin/cli.bundle.mjs"), "utf8"), /from ["']\.\/helper/);
});

test("a failed build writes no partial command bundles", async () => {
  const root = fixture();
  for (const name of ENTRIES) writeFileSync(join(root, "server", `${name}.ts`), name === "migrate" ? 'import "./missing";\n' : 'export {};\n');
  await assert.rejects(buildCli(root));
  assert.equal(existsSync(join(root, "bin/cli.bundle.mjs")), false);
});

test("prepack builds the commands without contaminating npm's JSON output", () => {
  const root = fixture();
  for (const name of ENTRIES) writeFileSync(join(root, "server", `${name}.ts`), 'export {};\n');
  writeFileSync(join(root, "package.json"), JSON.stringify({
    name: "@demo/commands", version: "1.0.0", files: ["bin/"], scripts: { prepack: "node prepack.mjs" },
  }));
  writeFileSync(join(root, "prepack.mjs"), `import { buildCli } from ${JSON.stringify(new URL("./build-cli.mjs", import.meta.url).href)}; await buildCli(process.cwd());\n`);
  const out = spawnSync("npm", ["pack", "--dry-run", "--json"], { cwd: root, encoding: "utf8" });
  assert.equal(out.status, 0, out.stderr);
  const parsed = JSON.parse(out.stdout);
  const result = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
  assert.ok(result.files.some(file => file.path === "bin/cli.bundle.mjs"));
});

// Each plugin has a distinct source layout; both must produce complete standalone command sets.
test("Fleet commands build atomically and run without a runtime loader", async () => {
  const root = fixture();
  mkdirSync(join(root, "bin"));
  for (const [name, source] of Object.entries(FLEET_ENTRIES)) {
    writeFileSync(join(root, source), `console.log("${name}", ...process.argv.slice(2));\n`);
  }
  await buildCli(root);
  for (const name of Object.keys(FLEET_ENTRIES)) {
    const out = spawnSync(process.execPath, [join(root, "bin", `${name}.bundle.mjs`), "--help"], { encoding: "utf8" });
    assert.equal(out.status, 0, out.stderr);
    assert.equal(out.stdout.trim(), `${name} --help`);
  }
  assert.equal(existsSync(join(root, "node_modules")), false);
  const partial = fixture();
  writeFileSync(join(partial, FLEET_ENTRIES.roles), "export {};\n");
  await assert.rejects(buildCli(partial), /incomplete CLI source set/);
  assert.equal(existsSync(join(partial, "bin/roles.bundle.mjs")), false);
});

test("bundled schema validation keeps only used Zod exports", async () => {
  const root = fixture();
  symlinkSync(join(ROOT, "node_modules"), join(root, "node_modules"), "dir");
  for (const name of ENTRIES) writeFileSync(join(root, "server", `${name}.ts`), `
import { z } from "zod";
console.log(z.object({ text: z.string() }).safeParse({ text: 42 }).error.issues[0].message);
`);
  await buildCli(root);
  rmSync(join(root, "node_modules"));
  const out = spawnSync(process.execPath, [join(root, "bin/cli.bundle.mjs")], { encoding: "utf8" });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /expected string/);
  const bundle = readFileSync(join(root, "bin/cli.bundle.mjs"), "utf8");
  assert.doesNotMatch(bundle, /locales\/de\.js|classic\/from-json-schema\.js/);
});

test("CLI loads the canonical packaged privacy policy without embedding path-bound approvals", async () => {
  const root = fixture(); mkdirSync(join(root, "shared"));
  writeFileSync(join(root, "shared/privacy-rules.mjs"), 'export default { marker: "demo-policy-sentinel" };\n');
  for (const name of ENTRIES) writeFileSync(join(root, "server", `${name}.ts`), 'import rules from "../shared/privacy-rules.mjs"; console.log(rules.marker);\n');
  await buildCli(root);
  const bundle = readFileSync(join(root, "bin/cli.bundle.mjs"), "utf8");
  assert.doesNotMatch(bundle, /demo-policy-sentinel/);
  const out = spawnSync(process.execPath, [join(root, "bin/cli.bundle.mjs")], {encoding:"utf8"});
  assert.equal(out.status, 0, out.stderr); assert.equal(out.stdout.trim(), "demo-policy-sentinel");
});
