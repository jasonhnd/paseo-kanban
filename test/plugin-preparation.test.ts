import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";
// The preparation entry is plain Node code, also shipped in npm packages.
// @ts-expect-error preparation runs without a TypeScript loader
import { preparePlugin } from "../server/prepare.mjs";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(bundles = true) {
  const root = mkdtempSync(join(tmpdir(), "plugin-preparation-")); roots.push(root);
  mkdirSync(join(root, "bin"));
  if (bundles) for (const name of ["cli", "local-decisions", "migrate", "check-missing-cwd", "fleet-roles", "fleet-doctor", "fleet-coupon", "fleet-leader"]) writeFileSync(join(root, "bin", `${name}.bundle.mjs`), "");
  return root;
}

test("Git sources install locked compiler inputs and generate missing commands", () => {
  const root = fixture(false);
  writeFileSync(join(root, "package-lock.json"), "{}");
  mkdirSync(join(root, "scripts")); writeFileSync(join(root, "scripts/build-cli.mjs"), "");
  const calls: string[][] = [];
  preparePlugin(root, (command: string, args: string[], cwd: string) => {
    assert.equal(cwd, root); calls.push([command, ...args]);
    if (command === process.execPath) for (const name of ["cli", "local-decisions", "migrate", "check-missing-cwd", "fleet-roles", "fleet-doctor", "fleet-coupon", "fleet-leader"]) writeFileSync(join(root, "bin", `${name}.bundle.mjs`), "");
  });
  assert.deepEqual(calls[0], ["npm", "ci", "--include=dev", "--ignore-scripts", "--no-audit", "--no-fund"]);
  assert.deepEqual(calls[1], [process.execPath, join(root, "scripts/build-cli.mjs")]);
});

test("prepacked npm sources do not invoke repository-only scripts", () => {
  const root = fixture(); const calls: string[][] = [];
  preparePlugin(root, (command: string, args: string[]) => calls.push([command, ...args]));
  assert.deepEqual(calls, [["npm", "install", "--include=dev", "--ignore-scripts", "--no-audit", "--no-fund"]]);
});

test("an incomplete prepacked command set refuses activation", () => {
  assert.throws(() => preparePlugin(fixture(false), () => {}), /Missing prepared command/);
});

test("dependency preparation failures stop before command generation", () => {
  const root = fixture(); let calls = 0;
  assert.throws(() => preparePlugin(root, () => { calls++; throw new Error("dependency installation failed"); }), /dependency installation failed/);
  assert.equal(calls, 1);
});

test("the plain Node entry prepares a package reached through a symlink", () => {
  const root = fixture(); mkdirSync(join(root, "server")); mkdirSync(join(root, "tools"));
  copyFileSync(fileURLToPath(new URL("../server/prepare.mjs", import.meta.url)), join(root, "server/prepare.mjs"));
  writeFileSync(join(root, "tools/npm"), `#!${process.execPath}\nrequire("node:fs").writeFileSync("prepared", "yes");\n`, { mode: 0o755 });
  symlinkSync(root, join(root, "alias"), "dir");
  const result = spawnSync(process.execPath, [join(root, "alias/server/prepare.mjs")], {
    encoding: "utf8", env: { ...process.env, PATH: `${join(root, "tools")}${delimiter}${process.env.PATH}` },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(join(root, "prepared")), "the executable entry must run preparation");
});
