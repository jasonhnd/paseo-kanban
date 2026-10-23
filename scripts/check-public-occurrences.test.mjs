import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, renameSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { occurrenceFingerprint } from "./check-private.mjs";

function fixture(action) {
  const root = mkdtempSync(join(tmpdir(), "public-occurrence-test-"));
  try {
    mkdirSync(join(root, "scripts"));
    for (const name of ["check-public-occurrences.mjs", "check-private.mjs", "private-identifiers.mjs", "git-objects.mjs"]) {
      cpSync(new URL(name, import.meta.url), join(root, "scripts", name));
    }
    mkdirSync(join(root, "shared"));
    for (const name of ["privacy-denylist.mjs"]) cpSync(new URL(`../shared/${name}`, import.meta.url), join(root, "shared", name));
    const line = 'export const provider = "PublicVendor";';
    const match = [...line.matchAll(/PublicVendor/g)][0];
    writeFileSync(join(root, "public.ts"), line + "\n");
    mkdirSync(join(root, "server"), { recursive: true });
    cpSync(new URL("../server/privacy-scanner.mjs", import.meta.url), join(root, "server/privacy-scanner.mjs"));
    writeFileSync(join(root, "shared/privacy-rules.mjs"), `export default ${JSON.stringify({
      publicOccurrenceLiterals: ["PublicVendor"],
      publicOccurrenceFingerprints: [occurrenceFingerprint("public.ts", line, match, "PublicVendor")],
    })};`);
    execFileSync("git", ["init", "-q", root]);
    const check = () => spawnSync(process.execPath, ["scripts/check-public-occurrences.mjs"], {
      cwd: root, encoding: "utf8", env: {...process.env, FLEET_PRIVATE_DENYLIST: join(root, "missing-private-list")},
    });
    action(root, check);
  } finally { rmSync(root, {recursive: true, force: true}); }
}

test("freshness does not require or substitute a contributor private denylist", () => fixture((root, check) => {
  const result = check();
  assert.equal(result.status, 0, result.stderr);
  const privacy = spawnSync(process.execPath, ["scripts/check-private.mjs", "--all", "--list", "missing-private-list"], {cwd: root});
  assert.equal(privacy.status, 2, "the real private scan still fails closed without its list");
}));
for (const mutation of ["changed", "renamed", "removed"]) test(`freshness refuses ${mutation} approved content`, () => fixture((root, check) => {
  if (mutation === "changed") writeFileSync(join(root, "public.ts"), '// PublicVendor\n');
  if (mutation === "renamed") renameSync(join(root, "public.ts"), join(root, "renamed.ts"));
  if (mutation === "removed") rmSync(join(root, "public.ts"));
  assert.equal(check().status, 1);
}));

const commitAll = (root) => {
  execFileSync("git", ["-C", root, "add", "-A"]);
  execFileSync("git", ["-C", root, "-c", "user.name=demo", "-c", "user.email=demo@users.noreply.github.com", "-c", "commit.gpgsign=false",
    "commit", "-q", "--no-verify", "-m", "demo"]);
};

test("freshness keeps an approval whose line was edited after commit while history still holds it", () => fixture((root, check) => {
  commitAll(root);
  writeFileSync(join(root, "public.ts"), "export const provider = null;\n");
  assert.equal(check().status, 0, "the reachable-history privacy gate still needs this approval");
}));
test("freshness refuses an approval that matches neither the working tree nor reachable history", () => fixture((root, check) => {
  commitAll(root);
  const rules = join(root, "shared/privacy-rules.mjs");
  const json = JSON.parse(readFileSync(rules, "utf8").replace(/^export default /, "").replace(/;$/, ""));
  json.publicOccurrenceFingerprints.push(occurrenceFingerprint("public.ts", "// PublicVendor", { index: 3, 0: "PublicVendor" }, "PublicVendor"));
  writeFileSync(rules, `export default ${JSON.stringify(json)};`);
  assert.equal(check().status, 1);
}));

function reviewedSpan(root) {
  const path = "public.ts";
  const line = readFileSync(join(root, path), "utf8").trimEnd();
  const match = [...line.matchAll(/PublicVendor/g)][0];
  const rulesPath = join(root, "shared/privacy-rules.mjs");
  writeFileSync(rulesPath, `export default ${JSON.stringify({
    ignorePaths: ["^public\\.ts$"],
    reviewedOccurrences: [{ path, rule: "private", index: match.index, length: match[0].length,
      fingerprint: occurrenceFingerprint(path, line, match, "private") }],
  })};`);
}

test("freshness checks reviewed private spans in ignored files without reading the denylist", () => fixture((root, check) => {
  reviewedSpan(root);
  assert.equal(check().status, 0);
  writeFileSync(join(root, "public.ts"), readFileSync(join(root, "public.ts"), "utf8").trimEnd() + " // edited\n");
  assert.equal(check().status, 1);
}));

test("reviewed span freshness retains reachable history but rejects a renamed-only approval", () => fixture((root, check) => {
  reviewedSpan(root);
  renameSync(join(root, "public.ts"), join(root, "renamed.ts"));
  assert.equal(check().status, 1);
  renameSync(join(root, "renamed.ts"), join(root, "public.ts"));
  commitAll(root);
  rmSync(join(root, "public.ts"));
  assert.equal(check().status, 0);
}));
