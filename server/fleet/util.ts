/// <reference types="node" />
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, rename, open, rm, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { dataDir, paseoConfigPath } from "./paths";
import { findCommand, commandInvocation } from "./commands";
import { commandPath } from "./platform";
import { paseoHome } from "../contract";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = Record<string, any>;

export const HOME = homedir();
export const PASEO_DIR = paseoHome();
export const CONFIG = paseoConfigPath();
/** The cockpit's data directory; see server/paths.ts for the default and the transition rule. */
export const STATE_DIR = dataDir();
export const CHANGES = join(STATE_DIR, "changes.log");
export const DECISIONS = join(STATE_DIR, "decisions.json");
export const LEDGER = join(STATE_DIR, "usage-ledger.json");
export const SEEN_MODELS = join(STATE_DIR, "seen-models.json");
export const LOG_CACHE = join(STATE_DIR, "board-log-cache.json");

const commandOverrides: Partial<Record<"paseo" | "gh" | "git", string>> = {};
export const BIN = {
  get paseo() { return commandOverrides.paseo ?? findCommand("paseo") ?? "paseo"; },
  set paseo(value: string) { commandOverrides.paseo = value; },
  get gh() { return commandOverrides.gh ?? findCommand("gh") ?? "gh"; },
  set gh(value: string) { commandOverrides.gh = value; },
  get git() { return commandOverrides.git ?? findCommand("git") ?? "git"; },
  set git(value: string) { commandOverrides.git = value; },
};

const ENV = { ...process.env, PATH: commandPath() };

export function run(cmd: string, args: string[], timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const invocation = commandInvocation(cmd, args);
    execFile(invocation.command, invocation.args, { timeout: timeoutMs, env: ENV, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${basename(cmd)} ${args[0] ?? ""}: ${String(stderr || err.message).slice(0, 300)}`));
      else resolve(stdout);
    });
  });
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** One-line log for an error the caller deliberately degrades past. */
export function logSwallowed(tag: string, error: unknown): void {
  console.error(`[afc] ${tag}:`, String(error).slice(0, 300));
}

export const SEND_TIMEOUT_MS = 20_000;

/** Fire-and-forget `paseo send`; rejects with the CLI error (never swallowed). `opts.runner` lets callers inject `run`. */
export async function sendToAgent(
  id: string,
  text: string,
  opts: { timeoutMs?: number; runner?: (cmd: string, args: string[], timeoutMs: number) => Promise<unknown> } = {},
): Promise<void> {
  await (opts.runner ?? run)(BIN.paseo, ["send", id, "--no-wait", "--prompt", text], opts.timeoutMs ?? SEND_TIMEOUT_MS);
}

export interface RunOutcome {
  ok: boolean;
  stdout: string;
  timedOut: boolean;
  error: string | null;
  /** Process exit code. Null when the process did not exit (timeout, spawn error). `ok` stays true only for 0. */
  exitCode: number | null;
}

/** Like `run`, but a timeout or non-zero exit is a result instead of a thrown error. */
export function runOutcome(cmd: string, args: string[], timeoutMs = 30_000): Promise<RunOutcome> {
  return new Promise((resolve) => {
    const invocation = commandInvocation(cmd, args);
    execFile(invocation.command, invocation.args, { timeout: timeoutMs, env: ENV, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) {
        resolve({ ok: true, stdout: String(stdout ?? ""), timedOut: false, error: null, exitCode: 0 });
        return;
      }
      const failed = err as NodeJS.ErrnoException & { killed?: boolean };
      const rawCode = (err as { code?: unknown }).code;
      const timedOut = Boolean(failed.killed) || rawCode === "ETIMEDOUT";
      resolve({
        ok: false,
        stdout: String(stdout ?? ""),
        timedOut,
        error: String(stderr || err.message).replace(/\s+/g, " ").slice(0, 300),
        exitCode: typeof rawCode === "number" ? rawCode : null,
      });
    });
  });
}

export async function runJson<T>(cmd: string, args: string[], timeoutMs?: number): Promise<T> {
  return JSON.parse(await run(cmd, args, timeoutMs)) as T;
}

export async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/** Atomic replacement across processes; concurrent writers use their own sibling temp files.
 * Last rename wins. This does not serialize read/modify/write operations or sync data to disk.
 */
export async function writeJson(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  // Exclusive creation establishes ownership. If open fails, never remove that path.
  const file = await open(tmp, "wx");
  try {
    await file.writeFile(JSON.stringify(data, null, 2));
    await file.close();
    await rename(tmp, path);
  } catch (error) {
    await file.close().catch(() => {});
    await rm(tmp, { force: true }).catch((cleanup) => logSwallowed("JSON temp cleanup", cleanup));
    throw error;
  }
}

const memo = new Map<string, { at: number; value: Promise<unknown> }>();

/** In-memory TTL cache with in-flight de-duplication. Failed loads are not cached. */
export function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as Promise<T>;
  const value = load();
  memo.set(key, { at: Date.now(), value });
  value.catch(() => memo.delete(key));
  return value;
}

/** `fn` over `items` with at most `limit` calls in flight; results keep the input order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

export function clearCache(prefix = ""): void {
  for (const k of [...memo.keys()]) if (k.startsWith(prefix)) memo.delete(k);
}

const repoMemo = new Map<string, string | null>();

/** owner/repo of the git checkout at cwd, or null. */
export async function repoOf(cwd: string): Promise<string | null> {
  if (!cwd) return null;
  if (repoMemo.has(cwd)) return repoMemo.get(cwd) ?? null;
  let repo: string | null = null;
  try {
    const url = (await run(BIN.git, ["-C", cwd, "remote", "get-url", "origin"], 5_000)).trim();
    const m = /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/.exec(url);
    repo = m ? m[1] : null;
  } catch {
    repo = null;
  }
  repoMemo.set(cwd, repo);
  return repo;
}

/** Short human project name for a cwd (repo name when known). */
export async function projectOf(cwd: string): Promise<string> {
  const repo = await repoOf(cwd);
  if (repo) return repo.split("/")[1];
  return basename(cwd || "") || "?";
}

export function tilde(path: string): string {
  return path.startsWith(HOME) ? `~${path.slice(HOME.length)}` : path;
}

export function minutesSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : (Date.now() - t) / 60_000;
}
