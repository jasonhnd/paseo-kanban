/// <reference types="node" />
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from "./perf-fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { dataDir } from "./paths";

/** Markers this close belong to one restart. A crash loop of a minute stays one episode. */
export const RESTART_EPISODE_GAP_MS = 120_000;

const CURSOR_FILE = "daemon-restart.json";

export interface DaemonEpisode {
  /** First marker in this burst. Same id means the same restart. */
  id: string;
  /** Latest marker. Grace and "activity before the restart" use this. */
  at: string;
}

interface StoredWatch {
  dev: number;
  ino: number;
  offset: number;
  episodeId: string | null;
  episodeAt: string | null;
  /** Episode id whose running cards have already been checked after the grace. */
  appliedFor: string | null;
}

export interface DaemonObserveResult {
  episode: DaemonEpisode | null;
  /** Bytes of complete lines parsed on this call. */
  chunkBytes: number;
  /** True when the file was new, replaced, or shorter than the saved offset. */
  fromStart: boolean;
  /** Restart markers found in the new bytes only. */
  markers: number;
}

export function daemonLogPath(): string {
  const override = process.env.KANBAN_DAEMON_LOG?.trim();
  if (override) return override;
  return join(homedir(), ".paseo", "daemon.log");
}

export function daemonPidPath(): string {
  const override = process.env.KANBAN_DAEMON_PID?.trim();
  if (override) return override;
  return join(homedir(), ".paseo", "paseo.pid");
}

function cursorPath(): string {
  return join(dataDir(), CURSOR_FILE);
}

/** Keep only whole lines. A trailing partial line stays unread until the next newline. */
export function takeLogChunk(text: string, offset: number): { chunk: string; nextOffset: number; fromStart: boolean } {
  const fromStart = offset < 0 || offset > text.length;
  const start = fromStart ? 0 : offset;
  const rest = text.slice(start);
  const nl = rest.lastIndexOf("\n");
  if (nl < 0) return { chunk: "", nextOffset: start, fromStart };
  const chunk = rest.slice(0, nl + 1);
  return { chunk, nextOffset: start + chunk.length, fromStart };
}

/**
 * Byte offset of the last complete line. The search is on the raw buffer,
 * so a multi-byte character cannot move the file position.
 */
export function takeLogChunkBytes(buf: Buffer): { chunk: Buffer; nextOffset: number } {
  const nl = buf.lastIndexOf(0x0a);
  if (nl < 0) return { chunk: Buffer.alloc(0), nextOffset: 0 };
  const end = nl + 1;
  return { chunk: buf.subarray(0, end), nextOffset: end };
}

function timeOf(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = new Date(value).getTime();
    return Number.isNaN(ms) ? null : new Date(ms).toISOString();
  }
  if (typeof value !== "string" || !value.trim()) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** One JSON line. Non-JSON noise and unrelated messages are ignored. */
export function markerFromLine(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  let row: { level?: unknown; time?: unknown; msg?: unknown };
  try {
    row = JSON.parse(trimmed) as { level?: unknown; time?: unknown; msg?: unknown };
  } catch {
    return null;
  }
  const msg = typeof row.msg === "string" ? row.msg : "";
  const fatal = row.level === 60 || row.level === "60";
  const hit = msg.includes("Worker crashed") || msg.includes("Worker ready") || (fatal && msg.includes("daemon crashing"));
  if (!hit) return null;
  return timeOf(row.time);
}

export function markersIn(chunk: string): string[] {
  const found: string[] = [];
  for (const line of chunk.split("\n")) {
    const at = markerFromLine(line);
    if (at) found.push(at);
  }
  return found;
}

/** Fold one marker into the latest episode. Older markers do not rewind it. */
export function foldEpisode(current: DaemonEpisode | null, at: string, gapMs = RESTART_EPISODE_GAP_MS): DaemonEpisode | null {
  const ms = Date.parse(at);
  if (Number.isNaN(ms)) return current;
  const iso = new Date(ms).toISOString();
  if (!current) return { id: iso, at: iso };
  const currentMs = Date.parse(current.at);
  if (Number.isNaN(currentMs)) return { id: iso, at: iso };
  if (ms <= currentMs) return current;
  if (ms - currentMs <= gapMs) return { id: current.id, at: iso };
  return { id: iso, at: iso };
}

export function foldMarkers(current: DaemonEpisode | null, times: string[], gapMs = RESTART_EPISODE_GAP_MS): DaemonEpisode | null {
  let episode = current;
  for (const at of times) episode = foldEpisode(episode, at, gapMs);
  return episode;
}

/** `paseo.pid` is JSON. `startedAt` is when this daemon process came up. */
export function readPidStartedAt(path: string): string | null {
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as { startedAt?: unknown };
    return timeOf(data.startedAt);
  } catch {
    return null;
  }
}

function emptyWatch(): StoredWatch {
  return { dev: 0, ino: 0, offset: 0, episodeId: null, episodeAt: null, appliedFor: null };
}

function loadWatch(): StoredWatch {
  try {
    const data = JSON.parse(readFileSync(cursorPath(), "utf8")) as Partial<StoredWatch>;
    return {
      dev: typeof data.dev === "number" ? data.dev : 0,
      ino: typeof data.ino === "number" ? data.ino : 0,
      offset: typeof data.offset === "number" && data.offset >= 0 ? data.offset : 0,
      episodeId: typeof data.episodeId === "string" ? data.episodeId : null,
      episodeAt: typeof data.episodeAt === "string" ? data.episodeAt : null,
      appliedFor: typeof data.appliedFor === "string" ? data.appliedFor : null,
    };
  } catch {
    return emptyWatch();
  }
}

function saveWatch(watch: StoredWatch): void {
  mkdirSync(dataDir(), { recursive: true });
  writeFileSync(cursorPath(), `${JSON.stringify(watch)}\n`);
}

function episodeOf(watch: StoredWatch): DaemonEpisode | null {
  if (!watch.episodeId || !watch.episodeAt) return null;
  return { id: watch.episodeId, at: watch.episodeAt };
}

export function currentEpisode(): DaemonEpisode | null {
  return episodeOf(loadWatch());
}

/** Remember an episode the caller already found, without reading the log. */
export function rememberEpisode(episode: DaemonEpisode): void {
  const watch = loadWatch();
  if (watch.episodeId !== episode.id) watch.appliedFor = null;
  watch.episodeId = episode.id;
  watch.episodeAt = episode.at;
  saveWatch(watch);
}

export function restartWasApplied(episodeId: string): boolean {
  return loadWatch().appliedFor === episodeId;
}

export function markRestartApplied(episodeId: string): void {
  const watch = loadWatch();
  if (watch.appliedFor === episodeId) return;
  watch.appliedFor = episodeId;
  saveWatch(watch);
}

/**
 * Read new daemon.log lines and fold restart markers into one episode.
 * A replaced or shorter file is read from the beginning. The pid file's
 * startedAt fills in a restart the current log no longer contains.
 */
export function observeDaemon(paths?: { logPath?: string; pidPath?: string }): DaemonObserveResult {
  const logPath = paths?.logPath ?? daemonLogPath();
  const pidPath = paths?.pidPath ?? daemonPidPath();
  const watch = loadWatch();
  let episode = episodeOf(watch);
  let chunkBytes = 0;
  let fromStart = false;
  let markers = 0;
  let fd: number | null = null;
  try {
    fd = openSync(logPath, "r");
  } catch {
    fd = null;
  }
  if (fd != null) {
    try {
      const stat = fstatSync(fd);
      const rotated = watch.dev !== stat.dev || watch.ino !== stat.ino || watch.offset > stat.size;
      fromStart = rotated;
      const start = rotated ? 0 : watch.offset;
      const length = stat.size - start;
      const buf = Buffer.alloc(length);
      let got = 0;
      while (got < length) {
        const n = readSync(fd, buf, got, length - got, start + got);
        if (n <= 0) break;
        got += n;
      }
      const taken = takeLogChunkBytes(buf.subarray(0, got));
      const text = taken.chunk.toString("utf8");
      chunkBytes = taken.nextOffset;
      const found = markersIn(text);
      markers = found.length;
      episode = foldMarkers(episode, found);
      watch.dev = stat.dev;
      watch.ino = stat.ino;
      watch.offset = start + taken.nextOffset;
    } finally {
      closeSync(fd);
    }
  }
  const started = readPidStartedAt(pidPath);
  if (started) episode = foldEpisode(episode, started);
  const previousId = watch.episodeId;
  watch.episodeId = episode?.id ?? null;
  watch.episodeAt = episode?.at ?? null;
  if (episode?.id !== previousId) watch.appliedFor = null;
  try {
    saveWatch(watch);
  } catch (err) {
    console.error("[paseo-kanban] daemon log", err instanceof Error ? err.message : err);
  }
  return { episode, chunkBytes, fromStart, markers };
}
