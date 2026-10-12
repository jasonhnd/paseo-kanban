import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { checkSingleSource } from "./check-single-source.mjs";
import { writeManifest } from "./sync-contract.mjs";
const source = resolve(import.meta.dirname, "..");
async function fixture(fn) {
  const root = mkdtempSync(join(tmpdir(), "single-source-fixture-"));
  try {
    for (const path of ["package.json", "package-lock.json", "paseo-plugin.json", ".githooks", "scripts/verify.mjs", "scripts/local-gates.json", "shared/contract", "server/contract", "shared/fleet/policy-snapshot.ts"]) {
      mkdirSync(join(root, path, ".."), { recursive: true });
      cpSync(join(source, path), join(root, path), { recursive: true });
    }
    mkdirSync(join(root, "client"));
    await writeManifest({ root });
    await fn(root);
  } finally { rmSync(root, { recursive: true, force: true }); }
}
const document = (root, name, edit) => writeFileSync(join(root, name), JSON.stringify(edit(JSON.parse(readFileSync(join(root, name), "utf8")))));
test("single source validates one package, complete local gates and real compatibility inputs", () => fixture(async root => {
  assert.deepEqual(await checkSingleSource(root, "contract"), []);
  assert.deepEqual(await checkSingleSource(root, "gates"), []);
  document(root, "package.json", pkg => ({ ...pkg, dependencies: Object.fromEntries(Object.entries(pkg.dependencies).reverse()) }));
  assert.deepEqual(await checkSingleSource(root, "gates"), [], "dependency order is not dependency identity");
}));
for (const mutation of ["schema", "fixture", "manifest", "duplicate"]) test(`contract refuses ${mutation} divergence`, () => fixture(async root => {
  if (mutation === "schema") writeFileSync(join(root, "shared/contract/schema.ts"), "export const contract = {};\n");
  if (mutation === "fixture") rmSync(join(root, "server/contract/test/model-review.fixture.json"));
  if (mutation === "manifest") document(root, "contract.manifest.json", doc => ({ ...doc, files: {} }));
  if (mutation === "duplicate") mkdirSync(join(root, "shared/fleet/contract"));
  assert.ok((await checkSingleSource(root, "contract")).length > 0);
}));
for (const mutation of ["lock", "identity", "package", "gate", "command", "hook"]) test(`local gates refuse ${mutation} divergence`, () => fixture(async root => {
  if (mutation === "lock") document(root, "package-lock.json", doc => { doc.packages[""].dependencies.zod = "0.0.0"; return doc; });
  if (mutation === "identity") document(root, "paseo-plugin.json", doc => ({ ...doc, id: "duplicate-plugin" }));
  if (mutation === "package") writeFileSync(join(root, "client/package.json"), "{}\n");
  if (mutation === "gate") document(root, "scripts/local-gates.json", doc => doc.filter(name => name !== "pack:check"));
  if (mutation === "command") writeFileSync(join(root, "scripts/verify.mjs"), readFileSync(join(root, "scripts/verify.mjs"), "utf8").replace('node("scripts/check-package-files.mjs", "--secret-scan")', 'node("-e", "process.exit(0)")'));
  if (mutation === "hook") writeFileSync(join(root, ".githooks/pre-push"), "#!/bin/sh\nexit 0\n");
  assert.ok((await checkSingleSource(root, "gates")).length > 0);
}));
