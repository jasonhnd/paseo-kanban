// Tests for sync-contract.mjs on two throwaway repositories: a source and a vendored copy.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, beforeEach, test } from "node:test";
import { MANIFEST, parseArgs } from "./sync-contract.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "sync-contract.mjs");
const EMPTY = `${JSON.stringify({ contract: "fleet-quota/v1", files: {} }, null, 2)}\n`;
const temps = [];
let source;
let copy;

async function put(root, file, text) {
  const path = join(root, file);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, "utf8");
}
const env = { ...process.env };
delete env.FLEET_CONTRACT_SOURCE;
const run = (root, ...args) => spawnSync(process.execPath, [SCRIPT, "--root", root, ...args], { encoding: "utf8", env });
const manifestOf = async (root) => JSON.parse(await readFile(join(root, MANIFEST), "utf8"));

/** Every file under a folder with its size, modification time and content: a check must leave it all as it was. */
async function snapshot(root) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const files = {};
  for (const entry of entries.filter((item) => item.isFile())) {
    const path = join(entry.parentPath, entry.name);
    const info = await stat(path);
    files[path.slice(root.length)] = `${info.size}:${info.mtimeMs}:${await readFile(path, "utf8")}`;
  }
  return files;
}

beforeEach(async () => {
  source = await mkdtemp(join(tmpdir(), "sync-contract-source-"));
  copy = await mkdtemp(join(tmpdir(), "sync-contract-copy-"));
  temps.push(source, copy);
  await put(source, MANIFEST, EMPTY);
  await put(copy, MANIFEST, EMPTY);
});

after(async () => {
  for (const dir of temps) await rm(dir, { recursive: true, force: true });
});

test("arguments, with the source from the environment", () => {
  assert.equal(parseArgs(["--check"], {}).check, true);
  assert.equal(parseArgs([], {}).copy, false, "no arguments only checks");
  assert.equal(parseArgs([], { FLEET_CONTRACT_SOURCE: "/src" }).copy, false, "the environment never copies");
  assert.equal(parseArgs(["--source", "/src"], {}).copy, true);
  assert.equal(parseArgs(["--check", "--source", "/src"], {}).copy, false);
  assert.throws(() => parseArgs(["--write-manifest", "--source", "/src"], {}), /cannot be combined/);
  assert.equal(parseArgs(["--root", "/x"], {}).root, "/x");
  assert.equal(parseArgs([], {}).source, null);
  assert.equal(parseArgs([], { FLEET_CONTRACT_SOURCE: "/src" }).source, "/src");
  assert.equal(parseArgs(["--source", "/other"], { FLEET_CONTRACT_SOURCE: "/src" }).source, "/other");
  assert.throws(() => parseArgs(["--root"], {}));
  assert.throws(() => parseArgs(["--check", "--write-manifest"], {}), /cannot be combined/);
  assert.throws(() => parseArgs(["extra"], {}), /unknown argument/);
});

test("with no arguments, an empty contract and manifest pass (skeleton)", () => {
  for (const args of [[], ["--check"]]) {
    const out = run(copy, ...args);
    assert.equal(out.status, 0, out.stdout + out.stderr);
    assert.match(out.stdout, /contract in sync \(fleet-quota\/v1, 0 file\(s\), manifest only \(no source given\)\)/);
  }
});

test("with no arguments, a file that does not match the manifest fails", async () => {
  await put(copy, "shared/contract/schema.ts", "export const A = 1;\n");
  assert.equal(run(copy, "--write-manifest").status, 0);
  assert.equal(run(copy).status, 0);
  await put(copy, "shared/contract/schema.ts", "export const A = 2;\n");
  const out = run(copy);
  assert.equal(out.status, 1);
  assert.match(out.stdout, /changed {2}shared\/contract\/schema\.ts \(not as in contract\.manifest\.json\)/);
});

test("a check writes nothing, with or without a source, even when the copy differs", async () => {
  await put(source, "shared/contract/schema.ts", "export const A = 1;\n");
  await put(source, "server/contract/io.ts", "// io\n");
  assert.equal(run(source, "--write-manifest").status, 0);
  await put(copy, "shared/contract/schema.ts", "export const A = 0;\n");
  await put(copy, "shared/contract/old.ts", "// stale\n");
  const before = { source: await snapshot(source), copy: await snapshot(copy) };
  assert.equal(run(copy).status, 1);
  assert.equal(run(copy, "--check").status, 1);
  assert.equal(run(copy, "--check", "--source", source).status, 1);
  const viaEnv = spawnSync(process.execPath, [SCRIPT, "--root", copy], { encoding: "utf8", env: { ...env, FLEET_CONTRACT_SOURCE: source } });
  assert.equal(viaEnv.status, 1, "FLEET_CONTRACT_SOURCE without --source only checks");
  assert.match(viaEnv.stdout, /checked against the source/);
  assert.deepEqual(await snapshot(copy), before.copy);
  assert.deepEqual(await snapshot(source), before.source);
});

test("a missing or malformed manifest is a setup problem", async () => {
  await rm(join(copy, MANIFEST));
  assert.equal(run(copy, "--check").status, 2);
  await put(copy, MANIFEST, JSON.stringify({ contract: "v1", files: {} }));
  assert.match(run(copy, "--check").stderr, /must look like fleet-quota\/v1/);
  await put(copy, MANIFEST, JSON.stringify({ contract: "fleet-quota/v1", files: { "server/x.ts": "0".repeat(64) } }));
  assert.match(run(copy, "--check").stderr, /outside shared\/contract and server\/contract/);
});

test("--write-manifest records the hashes, and --check then catches an edit", async () => {
  await put(source, "shared/contract/schema.ts", "export const A = 1;\n");
  await put(source, "server/contract/nested/io.ts", "// io\n");
  assert.equal(run(source, "--write-manifest").status, 0);
  const manifest = await manifestOf(source);
  assert.equal(manifest.contract, "fleet-quota/v1");
  assert.deepEqual(Object.keys(manifest.files), ["server/contract/nested/io.ts", "shared/contract/schema.ts"]);
  assert.equal(run(source, "--check").status, 0);
  await put(source, "shared/contract/schema.ts", "export const A = 2;\n");
  await put(source, "shared/contract/new.ts", "// new\n");
  const out = run(source, "--check");
  assert.equal(out.status, 1);
  assert.match(out.stdout, /changed {2}shared\/contract\/schema\.ts \(not as in contract\.manifest\.json\)/);
  assert.match(out.stdout, /extra {4}shared\/contract\/new\.ts/);
});

test("--check against the source lists copy differences and a version mismatch, and writes nothing", async () => {
  await put(source, "shared/contract/schema.ts", "export const A = 1;\n");
  await put(source, "server/contract/io.ts", "// io\n");
  assert.equal(run(source, "--write-manifest").status, 0);
  await put(copy, "shared/contract/schema.ts", "export const A = 0;\n");
  await put(copy, "shared/contract/old.ts", "// stale\n");
  assert.equal(run(copy, "--write-manifest").status, 0);
  assert.equal(run(copy, "--check").status, 0, "the copy matches its own manifest");
  const out = run(copy, "--check", "--source", source);
  assert.equal(out.status, 1);
  assert.match(out.stdout, /changed {2}shared\/contract\/schema\.ts \(copy differs from the source\)/);
  assert.match(out.stdout, /extra {4}shared\/contract\/old\.ts \(copy differs from the source\)/);
  assert.match(out.stdout, /missing {2}server\/contract\/io\.ts \(copy differs from the source\)/);
  const viaEnv = spawnSync(process.execPath, [SCRIPT, "--root", copy, "--check"], { encoding: "utf8", env: { ...env, FLEET_CONTRACT_SOURCE: source } });
  assert.equal(viaEnv.status, 1);
  assert.equal(await readFile(join(copy, "shared/contract/schema.ts"), "utf8"), "export const A = 0;\n");
  await put(source, MANIFEST, `${JSON.stringify({ ...(await manifestOf(source)), contract: "fleet-quota/v2" })}\n`);
  assert.match(run(copy, "--check", "--source", source).stdout, /version {2}here fleet-quota\/v1, source fleet-quota\/v2/);
});

test("a sync mirrors the source and its manifest, then --check against the source passes", async () => {
  await put(source, "shared/contract/schema.ts", "export const A = 1;\n");
  await put(source, "server/contract/nested/paths.ts", "// paths\n");
  assert.equal(run(source, "--write-manifest").status, 0);
  await put(copy, "shared/contract/old.ts", "// stale\n");
  const out = run(copy, "--source", source);
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.equal(await readFile(join(copy, "server/contract/nested/paths.ts"), "utf8"), "// paths\n");
  await assert.rejects(readFile(join(copy, "shared/contract/old.ts")));
  assert.deepEqual(await manifestOf(copy), await manifestOf(source));
  assert.equal(run(copy, "--check", "--source", source).status, 0);
});

test("a sync refuses an inconsistent source and never empties a copy", async () => {
  await put(source, "shared/contract/schema.ts", "// not in the manifest\n");
  const inconsistent = run(copy, "--source", source);
  assert.equal(inconsistent.status, 2);
  assert.match(inconsistent.stderr, /fails its own check/);
  await rm(join(source, "shared"), { recursive: true });
  await put(copy, "shared/contract/schema.ts", "// copy\n");
  const out = run(copy, "--source", source);
  assert.equal(out.status, 2);
  assert.match(out.stderr, /refusing to delete/);
  assert.equal(await readFile(join(copy, "shared/contract/schema.ts"), "utf8"), "// copy\n");
});
