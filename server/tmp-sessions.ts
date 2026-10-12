/// <reference types="node" />
import { execFile } from "node:child_process";
import { lstat, readdir, realpath, rmdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { dataDir, isProductionDataDir } from "./paths";
import { countIo, round } from "./perf";

/** An empty /tmp/sessions/<uuid> must be this old before it is removed. */
export const SESSION_DIR_MIN_AGE_MS = 24 * 60 * 60_000;
/** At most this many are removed per round; the backlog drains over the next rounds. */
export const SESSION_DIRS_PER_ROUND = 200;
/** The scan reads /tmp/sessions at most this often. */
export const SESSION_SCAN_EVERY_MS = 5 * 60_000;
const DEFAULT_ROOTS = ["/tmp/sessions", "/private/tmp/sessions"];
const UUID = /^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})$/i;

export interface SessionCleanOptions {
  now?: Date;
  roots?: string[];
  limit?: number;
  /** Start times (ms) of every running claude process, or null when they cannot be listed. Tests inject this. */
  claudeStarts?: () => Promise<number[] | null>;
  /** Tests skip the throttle. */
  force?: boolean;
}

let lastScanAt = 0;
let running: Promise<number> | null = null;

export function resetSessionCleanupForTests(): void {
  lastScanAt = 0;
  running = null;
}

/**
 * Is this `ps` command line a Claude Code CLI? Covers the native binary (`claude`, `claude.exe`) and the Node form
 * (`node .../@anthropic-ai/claude-code/cli.js`). `claude.exe --chrome-native-host` is the browser extension's
 * host: it stays up for days and is not a session, so it does not count.
 * Only the program and its first three arguments are looked at, so a prompt that mentions claude does not count.
 * The desktop app (`Claude`, `Claude Helper`) is a different program and is not matched.
 */
export function isClaudeCli(command: string): boolean {
  const words = command.trim().split(/\s+/).slice(0, 4);
  if (words.includes("--chrome-native-host")) return false;
  const names = words.map((word) => basename(word));
  if (names[0] === "claude" || names[0] === "claude.exe") return true;
  if (/^node(js)?(\.exe)?$/.test(names[0] ?? "") && (names[1] === "claude" || names[1] === "claude.exe")) return true;
  return words.some((word) => word.includes("/claude-code/") || word.includes("\\claude-code\\"));
}

/** Start times of running Claude Code CLI processes. null when `ps` fails or a matching row cannot be read: then nothing is removed. */
export function parseClaudeStarts(stdout: string): number[] | null {
  const starts: number[] = [];
  for (const line of stdout.split("\n")) {
    // lstart is fixed width: "Sat Oct  3 18:13:12 2026".
    if (!isClaudeCli(line.slice(25))) continue;
    const started = Date.parse(line.slice(0, 24));
    if (!Number.isFinite(started)) return null;
    starts.push(started);
  }
  return starts;
}

export function listClaudeStarts(): Promise<number[] | null> {
  return new Promise((resolve) => {
    execFile("ps", ["-axo", "lstart=,command="], { timeout: 10_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? null : parseClaudeStarts(String(stdout)));
    });
  });
}

/**
 * The real /tmp/sessions belongs to the running production board. A `node --test` child, or any board on an isolated
 * data directory (tests, compat's disposable board), must never touch it unless it hands in its own roots.
 */
export function mayUseDefaultRoots(): boolean {
  if (process.env.NODE_TEST_CONTEXT) return false;
  try {
    return isProductionDataDir(dataDir());
  } catch {
    return false;
  }
}

/** UUIDv7 carries a millisecond timestamp in its first 48 bits. Other versions return null. */
export function uuidV7Time(name: string): number | null {
  const match = UUID.exec(name);
  if (!match || match[3]![0] !== "7") return null;
  return Number.parseInt(`${match[1]}${match[2]}`, 16);
}

async function realRoots(list: string[]): Promise<string[]> {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const root of list) {
    try {
      const real = await realpath(root);
      if (seen.has(real)) continue;
      seen.add(real);
      out.push(root);
    } catch {
      // root missing: nothing to clean there
    }
  }
  return out;
}

/**
 * Remove empty /tmp/sessions/<uuid> directories left by claude CLI launches (they never delete them).
 * Only `rmdir` (never recursive, so a directory with anything inside survives), only real directories
 * named like a UUID, only those born more than a day ago and before the oldest running claude process.
 */
export async function cleanSessionDirs(options: SessionCleanOptions = {}): Promise<number> {
  if (!options.roots && !mayUseDefaultRoots()) return 0;
  const now = (options.now ?? new Date()).getTime();
  const budget = options.limit ?? SESSION_DIRS_PER_ROUND;
  const found = await realRoots(options.roots ?? DEFAULT_ROOTS);
  if (found.length === 0) return 0;
  const starts = await (options.claudeStarts ?? listClaudeStarts)();
  if (!starts) return 0;
  const cutoff = Math.min(now - SESSION_DIR_MIN_AGE_MS, ...starts);
  let removed = 0;
  for (const root of found) {
    let names: string[];
    try {
      countIo("readdir");
      names = (await readdir(root)).filter((name) => UUID.test(name)).sort();
    } catch (err) {
      console.error("[paseo-kanban] session dir cleanup", err instanceof Error ? err.message : err);
      continue;
    }
    for (const name of names) {
      if (removed >= budget) return removed;
      const stamp = uuidV7Time(name);
      if (stamp !== null && stamp >= cutoff) continue;
      const path = join(root, name);
      try {
        countIo("stat");
        const info = await lstat(path);
        if (info.isSymbolicLink() || !info.isDirectory()) continue;
        const born = info.birthtimeMs > 0 ? info.birthtimeMs : info.mtimeMs;
        if (born >= cutoff) continue;
        await rmdir(path);
        removed += 1;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "ENOTEMPTY" && code !== "ENOENT" && code !== "EEXIST") {
          console.error("[paseo-kanban] session dir cleanup", path, err instanceof Error ? err.message : err);
        }
      }
    }
  }
  return removed;
}

/** Scheduler hook: throttled, one scan at a time, never awaited by the tick. */
export function scheduleSessionCleanup(options: SessionCleanOptions = {}): void {
  const now = (options.now ?? new Date()).getTime();
  if (running || (!options.force && now - lastScanAt < SESSION_SCAN_EVERY_MS)) return;
  lastScanAt = now;
  running = round("sessionDirCleanup", () => cleanSessionDirs(options))
    .catch((err) => {
      console.error("[paseo-kanban] session dir cleanup", err instanceof Error ? err.message : err);
      return 0;
    })
    .finally(() => {
      running = null;
    });
}

/** Wait for the scan in flight. For tests. */
export async function flushSessionCleanup(): Promise<void> {
  if (running) await running;
}
