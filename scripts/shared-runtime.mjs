// One read-only official runtime per package-lock, outside any card root.
// A second caller for the same lock waits on a lock directory and reuses the tree.
// A writable copy is an APFS clone (cp -c), not another npm ci.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const READY = ".shared-runtime-ready";

export function sharedRuntimeRoot(env = process.env, home = homedir()) {
  const override = env.KANBAN_SHARED_RUNTIME_ROOT?.trim();
  return override || join(home, ".kanban-cache", "paseo-runtime");
}

export function sharedNpmCache(env = process.env, home = homedir()) {
  const override = env.KANBAN_SHARED_NPM_CACHE?.trim();
  return override || join(home, ".kanban-cache", "npm");
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function ready(dir, hash) {
  const marker = join(dir, READY);
  if (!existsSync(marker) || !existsSync(join(dir, "node_modules"))) return false;
  return readFileSync(marker, "utf8").trim() === hash;
}

function claim(lockDir, deadline) {
  while (Date.now() < deadline) {
    try {
      mkdirSync(lockDir);
      writeFileSync(join(lockDir, "pid"), `${process.pid}\n`);
      return true;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const pidPath = join(lockDir, "pid");
      const pid = existsSync(pidPath) ? Number(readFileSync(pidPath, "utf8")) : 0;
      const age = existsSync(lockDir) ? Date.now() - statSync(lockDir).mtimeMs : 0;
      if ((pid && !alive(pid)) || (!pid && age > 2000)) rmSync(lockDir, { recursive: true, force: true });
      else sleep(100);
    }
  }
  throw new Error("timed out waiting for the shared runtime lock");
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || `${command} failed`).trim());
}

function removeTree(dir) {
  if (!existsSync(dir)) return;
  spawnSync("chmod", ["-R", "u+w", dir]);
  rmSync(dir, { recursive: true, force: true });
}

export function ensureSharedRuntime({ manifestDir, cacheRoot, env = process.env, npmBin = "npm", waitMs = 30 * 60 * 1000 } = {}) {
  if (!manifestDir) throw new Error("manifestDir is required");
  const root = cacheRoot ?? sharedRuntimeRoot(env);
  const lockBytes = readFileSync(join(manifestDir, "package-lock.json"));
  const hash = createHash("sha256").update(lockBytes).digest("hex");
  const dir = join(root, hash);
  const serverDir = join(dir, "node_modules", "@getpaseo", "server");
  const done = () => ({ dir, hash, serverDir, installed: false });
  if (ready(dir, hash)) return done();
  mkdirSync(root, { recursive: true });
  const lockDir = join(root, `${hash}.lock`);
  const deadline = Date.now() + waitMs;
  let owned = false;
  try {
    while (!owned && Date.now() < deadline) {
      if (ready(dir, hash)) return done();
      owned = claim(lockDir, deadline);
      if (ready(dir, hash)) return done();
    }
    if (!owned) throw new Error("timed out waiting for the shared runtime lock");
    removeTree(dir);
    mkdirSync(dir, { recursive: true });
    copyFileSync(join(manifestDir, "package.json"), join(dir, "package.json"));
    copyFileSync(join(manifestDir, "package-lock.json"), join(dir, "package-lock.json"));
    const childEnv = { ...env, npm_config_cache: env.npm_config_cache?.trim() || sharedNpmCache(env) };
    const installed = spawnSync(npmBin, ["ci"], { cwd: dir, env: childEnv, encoding: "utf8" });
    if (installed.error || installed.status !== 0) {
      removeTree(dir);
      throw new Error((installed.stderr || installed.stdout || "shared runtime npm ci failed").trim());
    }
    const after = readFileSync(join(dir, "package-lock.json"));
    if (Buffer.compare(after, lockBytes) !== 0) {
      removeTree(dir);
      throw new Error("package-lock changed during shared runtime npm ci");
    }
    writeFileSync(join(dir, READY), `${hash}\n`);
    run("chmod", ["-R", "a-w", dir]);
    return { dir, hash, serverDir, installed: true };
  } finally {
    if (owned) rmSync(lockDir, { recursive: true, force: true });
  }
}

export function cloneWritableRuntime(source, destination) {
  if (existsSync(destination)) throw new Error("clone destination already exists");
  mkdirSync(dirname(destination), { recursive: true });
  run("cp", ["-c", "-R", source, destination]);
  run("chmod", ["-R", "u+w", destination]);
  return destination;
}
