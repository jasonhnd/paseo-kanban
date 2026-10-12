/// <reference types="node" />
// One read-only `codex app-server` call: initialize, then account/rateLimits/read.
// Never login, logout, or consume. Never keeps account ids or credit ids.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { HOME } from "./util";
import { codexRateLimitsRequest, codexStderrLooksLoggedOut, couponCliArgv } from "../../shared/fleet/reset-coupons";
import { t } from "../../shared/fleet/i18n";

const CLI_TIMEOUT_MS = 20_000;
const MAX_STDOUT_BUFFER = 512 * 1024;
const STDERR_TAIL_CHARS = 500;
const SENSITIVE_ENV = /(token|secret|password|authorization|api[-_]?key|bearer)/i;

async function cliEnv(): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (SENSITIVE_ENV.test(key)) continue;
    env[key] = value;
  }
  let nvmBins: string[] = [];
  try {
    const root = join(HOME, ".nvm", "versions", "node");
    const rank = (name: string) => name.replace(/^v/, "").split(".").map((part) => Number(part) || 0);
    nvmBins = (await readdir(root))
      .sort((a, b) => {
        const av = rank(a);
        const bv = rank(b);
        for (let i = 0; i < 3; i += 1) {
          if ((bv[i] ?? 0) !== (av[i] ?? 0)) return (bv[i] ?? 0) - (av[i] ?? 0);
        }
        return 0;
      })
      .map((version) => join(root, version, "bin"));
  } catch {
    nvmBins = [];
  }
  env.PATH = [...nvmBins, join(HOME, ".local", "bin"), join(HOME, ".grok", "bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", env.PATH ?? ""].join(":");
  return env;
}

/** Harness stand-in for `spawn`. Production uses the real one. */
export type CodexSpawn = (
  command: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; stdio: ["pipe", "pipe", "pipe"] },
) => ChildProcessWithoutNullStreams;

interface RpcMessage {
  id?: unknown;
  error?: unknown;
  result?: unknown;
}

type Finish = (error: Error | null, value?: unknown) => void;
type Waiters = Map<number, (message: RpcMessage) => void>;

/** Resolve or reject once. Closing stdin and killing the child never throw. */
function createFinisher(child: ChildProcessWithoutNullStreams, resolve: (value: unknown) => void, reject: (error: Error) => void): Finish {
  let settled = false;
  const timer = setTimeout(() => finish(new Error(t("coupons.codexRead.timeout"))), CLI_TIMEOUT_MS);
  function finish(error: Error | null, value?: unknown): void {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    try {
      child.stdin.destroy();
    } catch {
      // The pipe is already gone.
    }
    try {
      child.kill("SIGKILL");
    } catch {
      // Already exited, or the binary never started.
    }
    if (error) reject(error);
    else resolve(value);
  }
  return finish;
}

function createSender(child: ChildProcessWithoutNullStreams): (message: unknown) => void {
  return (message) => {
    const stdin = child.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable) return;
    try {
      stdin.write(`${JSON.stringify(message)}\n`);
    } catch {
      // Synchronous EPIPE. The stdin error listener covers the async one.
    }
  };
}

/** Parse one stdout line. A line that is not JSON is skipped, and the first one per read is logged (length only, never content). */
function parseRpcLine(line: string, onBad: (error: unknown) => void): RpcMessage | null {
  try {
    return JSON.parse(line) as RpcMessage;
  } catch (error) {
    onBad(error);
    return null;
  }
}

function listenStdout(child: ChildProcessWithoutNullStreams, waiters: Waiters, finish: Finish): void {
  let buffer = "";
  let warned = false;
  // The parse error text quotes the line, so only the length is logged.
  const warnOnce = (line: string) => () => {
    if (warned) return;
    warned = true;
    console.error(`[afc] reset coupons: skipped a non-JSON line in codex output (${line.length} chars)`);
  };
  child.stdout.on("data", (chunk: Buffer | string) => {
    buffer += String(chunk);
    if (buffer.length > MAX_STDOUT_BUFFER) {
      buffer = "";
      finish(new Error(t("coupons.codexRead.tooLong")));
      return;
    }
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (!line) continue;
      const message = parseRpcLine(line, warnOnce(line));
      if (message && typeof message.id === "number") waiters.get(message.id)?.(message);
    }
  });
}

function listenStderr(child: ChildProcessWithoutNullStreams, finish: Finish): void {
  let stderrTail = "";
  child.stderr.on("data", (chunk: Buffer | string) => {
    stderrTail = (stderrTail + String(chunk)).slice(-STDERR_TAIL_CHARS);
    if (codexStderrLooksLoggedOut(stderrTail)) finish(new Error(t("coupons.codexRead.loggedOut")));
  });
}

/** Pipe errors only matter through `finish`. An early exit, EPIPE, or ENOENT rejects the read instead of crashing. */
function listenLifecycle(child: ChildProcessWithoutNullStreams, isSettled: () => boolean, finish: Finish): void {
  child.stdin.on("error", () => {
    // EPIPE after codex exits early, or ENOENT before the pipe is up.
  });
  child.stdout.on("error", () => {});
  child.stderr.on("error", () => {});
  child.on("error", (error) => finish(error));
  child.on("exit", () => {
    // Let a stderr chunk queued in this turn win over the generic interrupt.
    setImmediate(() => {
      if (!isSettled()) finish(new Error(t("coupons.codexRead.interrupted")));
    });
  });
}

function runRateLimitsProtocol(send: (message: unknown) => void, waiters: Waiters, finish: Finish): void {
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "afc-reset-coupons", version: "0" }, capabilities: {} } });
  waiters.set(1, (message) => {
    if (message.error) {
      finish(new Error(t("coupons.codexRead.initFailed")));
      return;
    }
    send({ jsonrpc: "2.0", method: "initialized", params: {} });
    send(codexRateLimitsRequest(2));
  });
  waiters.set(2, (message) => {
    if (message.error) finish(new Error(t("coupons.codexRead.readFailed")));
    else finish(null, message.result);
  });
}

function startCodexSession(child: ChildProcessWithoutNullStreams, resolve: (value: unknown) => void, reject: (error: Error) => void): void {
  let settled = false;
  const inner = createFinisher(child, resolve, reject);
  const finish: Finish = (error, value) => {
    settled = true;
    inner(error, value);
  };
  const waiters: Waiters = new Map();
  listenLifecycle(child, () => settled, finish);
  listenStdout(child, waiters, finish);
  listenStderr(child, finish);
  runRateLimitsProtocol(createSender(child), waiters, finish);
}

/** The only command this module will start. Anything else is refused. */
function codexCommand(): { bin: string; args: string[] } {
  const argv = couponCliArgv("chatgpt", true);
  const bin = argv[0];
  const args = argv.slice(1);
  if (bin !== "codex" || args.join(" ") !== "app-server --listen stdio://") {
    throw new Error(t("coupons.codexRead.refused"));
  }
  return { bin, args };
}

/**
 * One non-interactive Codex read. Starts nothing unless couponCliArgv says so.
 * Sends initialize, then account/rateLimits/read. Never login, logout, or consume.
 * Stdin and the child both listen for errors, so an early exit, EPIPE, or ENOENT
 * rejects this promise instead of becoming an uncaught exception.
 */
export async function readCodexRateLimits(spawnCommand: CodexSpawn = spawn as CodexSpawn): Promise<unknown> {
  const { bin, args } = codexCommand();
  const env = await cliEnv();
  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawnCommand(bin, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    startCodexSession(child, resolve, reject);
  });
}
