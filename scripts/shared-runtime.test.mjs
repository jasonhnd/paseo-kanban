import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { cloneWritableRuntime, ensureSharedRuntime, hostCommand } from "./shared-runtime.mjs";

function scratch() {
  return mkdtempSync(join(process.env.KANBAN_TMP || process.env.TMPDIR || tmpdir(), "shared-runtime-"));
}

function manifest(dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "shared-runtime-fixture", private: true, version: "0.0.0" }) + "\n");
  const lock = JSON.stringify({ name: "shared-runtime-fixture", lockfileVersion: 3, requires: true, packages: { "": { name: "shared-runtime-fixture" } } }) + "\n";
  writeFileSync(join(dir, "package-lock.json"), lock);
  return lock;
}

function fakeNpm(dir) {
  mkdirSync(dir, { recursive: true });
  const bin = join(dir, "npm.cjs");
  // The release lab PATH has node and not sleep or mkdir. .cjs stays CommonJS even when a parent package is a module.
  writeFileSync(bin, `#!${process.execPath}\nconst { appendFileSync, mkdirSync, writeFileSync } = require("node:fs");\nappendFileSync(process.env.SHARED_RUNTIME_INSTALL_LOG, process.cwd() + "\\n");\nAtomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 600);\nmkdirSync("node_modules/@getpaseo/server", { recursive: true });\nwriteFileSync("node_modules/@getpaseo/server/marker", "installed\\n");\n`);
  chmodSync(bin, 0o700);
  return bin;
}

function runChild(env) {
  const program = `
    import { ensureSharedRuntime } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, "shared-runtime.mjs")).href)};
    const result = ensureSharedRuntime({
      manifestDir: process.env.MANIFEST,
      cacheRoot: process.env.CACHE,
      env: process.env,
      npmBin: process.env.NPM_BIN,
    });
    process.stdout.write(JSON.stringify(result));
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", program], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { err += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(JSON.parse(out)) : reject(new Error(err || out || `child ${code}`)));
  });
}

test("one lock hash is installed once, stays read-only, and host state stays separate", async () => {
  const root = scratch();
  try {
    const manifestDir = join(root, "manifest");
    const lock = manifest(manifestDir);
    const expected = createHash("sha256").update(lock).digest("hex");
    const cache = join(root, "cache");
    const log = join(root, "installs.log");
    writeFileSync(log, "");
    const npmBin = fakeNpm(join(root, "bin"), log);
    const env = {
      ...process.env,
      MANIFEST: manifestDir,
      CACHE: cache,
      NPM_BIN: npmBin,
      SHARED_RUNTIME_INSTALL_LOG: log,
      PATH: process.env.PATH,
    };
    const [first, second] = await Promise.all([runChild(env), runChild(env)]);
    assert.equal(first.dir, second.dir);
    assert.equal(first.hash, expected);
    assert.equal(readFileSync(log, "utf8").trim().split("\n").filter(Boolean).length, 1);
    assert.equal(readFileSync(join(first.dir, "package-lock.json"), "utf8"), lock);
    assert.throws(() => writeFileSync(join(first.dir, "intruder.txt"), "no"));
    const again = ensureSharedRuntime({ manifestDir, cacheRoot: cache, env, npmBin });
    assert.equal(again.installed, false);
    assert.equal(readFileSync(log, "utf8").trim().split("\n").filter(Boolean).length, 1);
    assert.equal(readFileSync(join(first.dir, "package-lock.json"), "utf8"), lock);

    const copy = cloneWritableRuntime(first.dir, join(root, "writable-copy"));
    writeFileSync(join(copy, "local-note.txt"), "host-only");
    assert.equal(existsSync(join(first.dir, "local-note.txt")), false);
    assert.equal(readFileSync(join(first.dir, "package-lock.json"), "utf8"), lock);
    assert.throws(() => writeFileSync(join(first.dir, "intruder-2.txt"), "no"));

    const hostA = join(root, "host-a");
    const hostB = join(root, "host-b");
    mkdirSync(hostA); mkdirSync(hostB);
    writeFileSync(join(hostA, "state.txt"), "A");
    writeFileSync(join(hostB, "state.txt"), "B");
    assert.notEqual(hostA, hostB);
    assert.equal(readFileSync(join(hostA, "state.txt"), "utf8"), "A");
    assert.equal(readFileSync(join(hostB, "state.txt"), "utf8"), "B");
    assert.equal(existsSync(join(hostA, "local-note.txt")), false);
  } finally {
    spawnSync(hostCommand("chmod"), ["-R", "u+w", root]);
    rmSync(root, { recursive: true, force: true });
  }
});
