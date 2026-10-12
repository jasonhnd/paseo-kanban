/// <reference types="node" />
// Fleet compatibility exports are confined to the single plugin root.
import { existsSync, readFileSync } from "./perf-fs";
import { join } from "node:path";
import type { z } from "zod";
import {
  EXPORTS, exportPath, onceLogger, parseContract, PLUGIN_IDS, pluginDataDir,
  type Envelope, type ExportKind, type ExportPayload, type ReadResult,
} from "./contract";
import { HOME } from "./paths";

export const COCKPIT_ID = PLUGIN_IDS.cockpit;

/** Directories that may hold the cockpit's state files, most specific first. */
export function cockpitStateDirs(env: NodeJS.ProcessEnv = process.env, home = HOME): string[] {
  return [pluginDataDir(PLUGIN_IDS.cockpit, env, home)];
}
/** Reads are confined to root/fleet, even when an old export declares another directory. */
export function cockpitStateFile(name: string, env: NodeJS.ProcessEnv = process.env, home = HOME): string | null {
  if (name.includes("/") || name.includes("\\") || name === "..") throw new Error("Invalid Fleet state name");
  const path = join(cockpitStateDirs(env, home)[0], name);
  return existsSync(path) ? path : null;
}

/** Where a cockpit state file would be written: its existing location, else the first candidate directory. */
export function cockpitStateTarget(name: string, env: NodeJS.ProcessEnv = process.env, home = HOME): string {
  return cockpitStateFile(name, env, home) ?? join(cockpitStateDirs(env, home)[0], name);
}

/** Path of a contract export, under its producer's data directory. */
export function contractPath(kind: ExportKind, env: NodeJS.ProcessEnv = process.env, home = HOME): string {
  return exportPath(kind, env, home);
}

const logInvalid = onceLogger((message) => console.error("[paseo-kanban]", message));

/** Synchronous read of one contract file. Missing is absent; bad JSON or a wrong shape is invalid and logged once. */
export function readContractSync<K extends ExportKind>(
  kind: K,
  options: { now?: Date; path?: string } = {},
): ReadResult<ExportPayload<K>> & { path: string } {
  const path = options.path ?? contractPath(kind);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { state: "absent", path };
    const reason = `unreadable: ${err instanceof Error ? err.message : String(err)}`;
    logInvalid(path, reason);
    return { state: "invalid", reason, path };
  }
  const schema = EXPORTS[kind].schema as unknown as z.ZodType<Envelope>;
  const result = parseContract(text, schema, options.now ?? new Date()) as ReadResult<ExportPayload<K>>;
  if (result.state === "invalid") logInvalid(path, result.reason);
  return { ...result, path };
}

/** The cockpit's command line from `cockpit.json`, when the cockpit exports one. Stale still counts: the path does not age. */
export function cockpitCli(): string | null {
  const info = readContractSync("cockpit");
  if (info.state !== "fresh" && info.state !== "stale") return null;
  return info.value.cli?.trim() || null;
}

export type ContractState = "fresh" | "stale" | "invalid" | "absent";

/** The exports the cockpit writes and the board reads. */
export const COCKPIT_EXPORT_KINDS = ["cockpit", "poolStatus", "dispatchMatrix", "decisionsOpen"] as const;
export type CockpitExportKind = (typeof COCKPIT_EXPORT_KINDS)[number];
const LEGACY_STATE_FILES = ["pool-status.json", "dispatch-matrix.json", "decisions.json"] as const;

export interface ContractHealth {
  kind: CockpitExportKind;
  file: string;
  state: ContractState;
  /** From generatedAt; null when absent or invalid. */
  ageMs: number | null;
  ttlSeconds: number | null;
  /** Why an invalid file was rejected. */
  reason: string | null;
}

export interface CockpitHealth {
  /** False when no export, no legacy state file and no test snapshot exists: the cockpit is not installed. */
  installed: boolean;
  files: ContractHealth[];
}

/** One read of every cockpit export, for doctor. Never throws for missing or malformed files. */
export function cockpitHealth(now: Date = new Date(), env: NodeJS.ProcessEnv = process.env): CockpitHealth {
  const files = COCKPIT_EXPORT_KINDS.map((kind): ContractHealth => {
    const read = readContractSync(kind, { now, path: contractPath(kind, env) });
    const base = { kind, file: read.path, ageMs: null, ttlSeconds: null, reason: null };
    if (read.state === "absent") return { ...base, state: "absent" };
    if (read.state === "invalid") return { ...base, state: "invalid", reason: read.reason };
    return { ...base, state: read.state, ageMs: Math.round(read.ageSeconds * 1000), ttlSeconds: read.value.ttlSeconds };
  });
  const legacy = LEGACY_STATE_FILES.some((name) => {
    const file = cockpitStateFile(name, env);
    return file != null && existsSync(file);
  });
  const installed = legacy || files.some((item) => item.state !== "absent") || env.KANBAN_POOL_STATUS !== undefined;
  return { installed, files };
}
