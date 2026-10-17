#!/usr/bin/env node
// Prove a shared official runtime can start one speech-off host and one speech-on host.
// The speech-on host is stopped at the first model download and then deleted.
// Usage: node scripts/lean-host-check.mjs --manifest <dir> --work <dir> [--cache-root <dir>]
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isolatedEnvironment, testHostConfig } from "./isolated-environment.mjs";
import { ensureSharedRuntime } from "./shared-runtime.mjs";

const DOWNLOAD = "Starting model download";

function option(name, required = false) {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : "";
  if (required && !value) throw new Error(`${name} is required`);
  return value || "";
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

async function freePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  server.close();
  await once(server, "close");
  return port;
}

function files(dir, found = []) {
  if (!existsSync(dir)) return found;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) files(path, found);
    else if (statSync(path).size < 4_000_000) found.push(path);
  }
  return found;
}

function combined(dir) {
  return files(dir).map((path) => { try { return readFileSync(path); } catch { return ""; } }).join("\n");
}

function cliEntry(runtimeDir) {
  const candidates = [
    join(runtimeDir, "node_modules/@getpaseo/cli/dist/index.js"),
    join(runtimeDir, "node_modules/.bin/paseo"),
  ];
  const found = candidates.find((path) => existsSync(path));
  if (!found) throw new Error("official CLI entry was not installed");
  return found;
}

function sourceEnv(serverDir) {
  const env = { PATH: process.env.PATH };
  if (process.env.KANBAN_SHARED_NPM_CACHE) env.KANBAN_SHARED_NPM_CACHE = process.env.KANBAN_SHARED_NPM_CACHE;
  if (process.env.KANBAN_SHARED_RUNTIME_ROOT) env.KANBAN_SHARED_RUNTIME_ROOT = process.env.KANBAN_SHARED_RUNTIME_ROOT;
  if (serverDir) env.PASEO_SERVER_DIR = serverDir;
  return env;
}

async function prepareHost(root, serverDir, voice) {
  const env = isolatedEnvironment(root, { voice, sourceEnv: sourceEnv(serverDir) });
  const port = await freePort();
  const config = testHostConfig({
    daemon: { listen: `127.0.0.1:${port}` },
    features: voice ? { voiceMode: { enabled: true }, dictation: { enabled: true } } : {},
  });
  writeFileSync(join(env.PASEO_HOME, "config.json"), `${JSON.stringify(config, null, 2)}\n`);
  env.PASEO_URL = `ws://127.0.0.1:${port}/ws`;
  return { env, port, config };
}

function launch(cli, env, logPath) {
  const log = openSync(logPath, "a");
  const child = spawn(process.execPath, [cli, "--home", env.PASEO_HOME, "start", "--json"], {
    env, detached: true, stdio: ["ignore", log, log],
  });
  child.unref();
  return child.pid;
}

function stop(cli, env) {
  // `paseo stop` interrupts an agent. The daemon is `paseo daemon stop`.
  spawnSync(process.execPath, [cli, "--home", env.PASEO_HOME, "daemon", "stop"], { env, stdio: "ignore", timeout: 20_000 });
  sleep(500);
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function modelsDir(env) {
  return join(env.PASEO_HOME, "models", "local-speech");
}

async function main() {
  const manifestDir = option("--manifest", true);
  const work = option("--work", true);
  const cacheRoot = option("--cache-root");
  mkdirSync(work, { recursive: true });
  const runtime = ensureSharedRuntime({
    manifestDir,
    cacheRoot: cacheRoot || undefined,
    env: sourceEnv(""),
    npmBin: process.env.NPM_BIN || "npm",
  });
  const compiler = join(runtime.serverDir, "dist/server/server/plugins/compiler.js");
  if (!existsSync(compiler)) throw new Error("official compiler is missing from the shared runtime");
  const compilerBefore = sha256(compiler);
  const cli = cliEntry(runtime.dir);
  const offRoot = join(work, "speech-off");
  const onRoot = join(work, "speech-on");
  mkdirSync(offRoot, { recursive: true });
  const off = await prepareHost(offRoot, runtime.serverDir, false);
  const offLog = join(work, "speech-off.log");
  launch(cli, off.env, offLog);
  let offReady = false;
  for (let i = 0; i < 40; i += 1) {
    const status = spawnSync(process.execPath, [cli, "--home", off.env.PASEO_HOME, "status", "--json"], { env: off.env, encoding: "utf8", timeout: 10_000 });
    if (status.status === 0 && status.stdout.includes("127.0.0.1")) { offReady = true; break; }
    sleep(500);
  }
  sleep(5000);
  const offText = combined(off.env.PASEO_HOME) + "\n" + combined(offRoot) + "\n" + (existsSync(offLog) ? readFileSync(offLog, "utf8") : "");
  const offModels = existsSync(modelsDir(off.env));
  const offDownload = offText.includes(DOWNLOAD);
  stop(cli, off.env);
  if (!offReady || offDownload || offModels) {
    throw new Error(`speech-off host failed (ready=${offReady}, download=${offDownload}, models=${offModels})`);
  }

  mkdirSync(onRoot, { recursive: true });
  const on = await prepareHost(onRoot, runtime.serverDir, true);
  const onLog = join(work, "speech-on.log");
  launch(cli, on.env, onLog);
  let onDownload = false;
  for (let i = 0; i < 90; i += 1) {
    const sawModels = existsSync(modelsDir(on.env));
    const sawText = (existsSync(onLog) ? readFileSync(onLog, "utf8") : "").includes(DOWNLOAD)
      || combined(on.env.PASEO_HOME).includes(DOWNLOAD);
    if (sawModels || sawText) { onDownload = true; break; }
    sleep(1000);
  }
  stop(cli, on.env);
  spawnSync("chmod", ["-R", "u+w", onRoot]);
  spawnSync("rm", ["-rf", onRoot, onLog]);
  if (!onDownload) throw new Error("speech-on host did not start a model download");
  if (existsSync(onRoot) || existsSync(modelsDir(on.env))) throw new Error("speech-on host was not removed");
  const compilerAfter = sha256(compiler);
  if (compilerBefore !== compilerAfter) throw new Error("shared runtime compiler changed");
  const summary = {
    runtimeDir: runtime.dir,
    runtimeHash: runtime.hash,
    installedThisCall: runtime.installed,
    serverDir: runtime.serverDir,
    compilerSha256: compilerAfter,
    speechOffReady: true,
    speechOffDownload: false,
    speechOffModels: false,
    speechOnDownloadStarted: true,
    speechOnRemoved: !existsSync(onRoot),
    writableHomesIsolated: off.env.PASEO_HOME !== on.env.PASEO_HOME,
  };
  writeFileSync(join(work, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
