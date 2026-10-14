/// <reference types="node" />
import { lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import type { AgentPermissionRequest } from "@getpaseo/protocol/agent-types";

/** Supplied by the host's live run/task binding, never by a permission payload. */
export interface TaskReadScope { taskId: number; workspace: string; roots: string[]; temporaryRoot?: string }

function identity(path: string) {
  const info = statSync(path, { bigint: true });
  // No guessed case folding: compare identities supplied by this filesystem.
  // Missing/unverifiable identities throw into scopedReadAllowed's deny path.
  if (info.ino <= 0n) throw new Error("Unverifiable filesystem identity");
  return { dev: info.dev, ino: info.ino };
}

function samePath(left: string, right: string): boolean {
  const a = identity(left), b = identity(right);
  return a.dev === b.dev && a.ino === b.ino;
}

function within(root: string, path: string): boolean {
  const boundary = identity(root);
  for (let current = path; ; current = dirname(current)) {
    const entry = identity(current);
    if (entry.dev === boundary.dev && entry.ino === boundary.ino) return true;
    if (dirname(current) === current) return false;
  }
}

function canonical(path: string): string | null {
  try { return realpathSync(path); } catch { return null; }
}

function rootsOf(scope: TaskReadScope | undefined): string[] | null {
  if (!scope || !Number.isSafeInteger(scope.taskId) || scope.taskId <= 0 || !isAbsolute(scope.workspace) || !Array.isArray(scope.roots)) return null;
  const workspace = canonical(scope.workspace);
  if (!workspace || !statSync(workspace).isDirectory()) return null;
  const home = canonical(homedir()) ?? resolve(homedir());
  const tmp = canonical("/tmp") ?? "/tmp";
  const roots: string[] = [];
  for (const root of [scope.workspace, ...scope.roots]) {
    if (typeof root !== "string" || !isAbsolute(root)) return null;
    const real = canonical(root);
    // Neither workspace nor an explicit grant may silently become all HOME/tmp.
    if (!real || samePath(real, resolve("/")) || within(real, home) || samePath(real, tmp)) return null;
    roots.push(real);
  }
  if (scope.temporaryRoot !== undefined) {
    if (!isAbsolute(scope.temporaryRoot) || !lstatSync(scope.temporaryRoot).isDirectory()) return null;
    const real = canonical(scope.temporaryRoot);
    if (!real || samePath(real, resolve("/")) || samePath(real, tmp) || samePath(real, home)) return null;
    // The host derives this one card directory. In a fully isolated test it
    // can contain HOME; HOME itself is explicitly excluded by pathAllowed.
    roots.push(real);
  }
  return roots;
}

function pathAllowed(path: unknown, scope: TaskReadScope, roots: string[], recursive = false): boolean {
  if (typeof path !== "string" || !path.trim() || path.includes("\0")) return false;
  const lexical = resolve(scope.workspace, path);
  const real = canonical(lexical);
  if (!real || !roots.some(root => within(root, real))) return false;
  const home = canonical(homedir()) ?? resolve(homedir());
  const tempRoot = scope.temporaryRoot ? canonical(scope.temporaryRoot) : null;
  if (tempRoot && within(tempRoot, home) && within(home, real)) return false;
  try {
    const info = statSync(real);
    if (!info.isFile() && !info.isDirectory()) return false;
    if (!recursive && !info.isFile()) return false;
    // realpath cannot establish a hard-linked file's original scope.
    if (info.isFile() && info.nlink !== 1) return false;
    if (!recursive || !info.isDirectory()) return true;
    // A search handler may follow links below a permitted directory. Refuse
    // escaping links before it runs; missing/unreadable entries fail closed.
    const pending = [real]; const seen = new Set<string>(); let count = 0;
    while (pending.length) {
      const dir = pending.pop()!;
      if (seen.has(dir)) continue;
      seen.add(dir);
      for (const name of readdirSync(dir)) {
        if (++count > 50_000) return false;
        const child = resolve(dir, name); const target = canonical(child);
        if (!target || !roots.some(root => within(root, target))) return false;
        if (tempRoot && within(tempRoot, home) && within(home, target)) return false;
        const stat = lstatSync(child);
        const targetStat = statSync(target);
        if (!targetStat.isFile() && !targetStat.isDirectory()) return false;
        if (stat.isDirectory()) pending.push(target);
        else if (stat.isSymbolicLink() && targetStat.isDirectory()) pending.push(target);
        else if (targetStat.isFile() && targetStat.nlink !== 1) return false;
        else if (!stat.isFile() && !stat.isSymbolicLink()) return false;
      }
    }
    return true;
  } catch { return false; }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Inspect actual argument structure only to narrow access, never to grant roots. */
export function scopedReadAllowed(request: AgentPermissionRequest, scope: TaskReadScope | undefined): boolean {
  try {
    const roots = rootsOf(scope);
    if (!scope || !roots) return false;
    const detail = record(request.detail);
    if (detail?.type !== "read" && detail?.type !== "search") return false;
    const search = detail.type === "search";
    const metadata = record(request.metadata);
    const rawRequest = record(metadata?.rawRequest);
    const call = record(rawRequest?.toolCall);
    // Official ACP stores rawInput in metadata.rawRequest.toolCall, not input.
    // Its locations are NOT the search scope, and title fallback is not evidence.
    const acp = request.provider === "antigravity";
    if (acp && (!call || call.kind !== detail.type)) return false;
    if (call && call.kind !== detail.type) return false;
    const raw = record(call?.rawInput ?? request.input);
    // The ACP envelope and another adapter's input may coexist. Neither may
    // hide conflicting paths/commands behind the other representation.
    const inputs = [call?.rawInput, request.input].filter(value => value !== undefined && value !== null);
    if (inputs.some(value => !record(value))) return false;
    const keys = search
      ? new Set(["path", "filePath", "file", "paths", "query", "pattern", "caseSensitive", "maxResults", "mode"])
      : new Set(["path", "filePath", "file", "offset", "line", "limit"]);
    const paths: unknown[] = [];
    for (const input of inputs) {
      const raw = record(input)!;
      if (Object.keys(raw).some(key => !keys.has(key))) return false;
      for (const key of ["offset", "line", "limit", "maxResults"]) if (raw[key] !== undefined && (typeof raw[key] !== "number" || !Number.isSafeInteger(raw[key]) || Number(raw[key]) < 0)) return false;
      if (raw.caseSensitive !== undefined && typeof raw.caseSensitive !== "boolean") return false;
      if (raw.mode !== undefined && !["content", "files_with_matches", "count"].includes(String(raw.mode))) return false;
      if (search) for (const key of ["query", "pattern"]) if (raw[key] !== undefined && raw[key] !== detail.query) return false;
      for (const key of ["path", "filePath", "file"]) if (raw[key] !== undefined) paths.push(raw[key]);
      if (raw.paths !== undefined) {
        if (!Array.isArray(raw.paths)) return false;
        paths.push(...raw.paths);
      }
    }
    if (call?.locations !== undefined) {
      if (!Array.isArray(call.locations)) return false;
      for (const location of call.locations) paths.push(record(location)?.path);
    }
    if (search) {
      // No command/query parsing and no implicit cwd: a concrete search path
      // and literal pattern must survive the adapter. Opaque/glob/web forms deny.
      if (!raw || ![raw.path, raw.filePath, raw.file, ...(Array.isArray(raw.paths) ? raw.paths : [])].some(path => typeof path === "string")) return false;
      if (typeof detail.query !== "string" || ![raw.query, raw.pattern].includes(detail.query)) return false;
      if (detail.toolName !== undefined && !["search", "grep"].includes(String(detail.toolName))) return false;
      if (detail.filePaths !== undefined) {
        if (!Array.isArray(detail.filePaths)) return false;
        paths.push(...detail.filePaths);
      }
    } else {
      if (acp && paths.length === 0) return false;
      paths.push(detail.filePath);
    }
    return paths.length > 0 && paths.every(path => pathAllowed(path, scope, roots, search));
  } catch { return false; }
}
