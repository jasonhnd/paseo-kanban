/// <reference types="node" />
import { assertTestSafePath } from "./test-safety";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export type StorageEnv = Readonly<Record<string, string | undefined>>;
const RETIRED = ["AFC_DATA_DIR", "ROLES_STATE_DIR", "AFC_LEGACY_DATA_DIR"] as const;

/** Retired overrides never select an alternate writer or import an old directory. */
export function assertStorageConfiguration(env: StorageEnv): void {
  const set = RETIRED.filter(name => env[name]?.trim());
  if (set.length) throw new Error(`Retired storage override: ${set.join(", ")}. Unset it and configure KANBAN_DATA_DIR; see docs/MANUAL-MIGRATION.md. No legacy data has been read or imported.`);
}

export function resolveStoragePath(raw: string | undefined, home: string): string | null {
  const value = raw?.trim();
  if (!value) return null;
  if (value === "~") return home;
  if (value.startsWith("~/")) return join(home, value.slice(2));
  return isAbsolute(value) ? value : resolve(value);
}

/** Identity comparison for an already checked open DB handle; never use this to open a path. */
export function requestedUnifiedDataRoot(env: StorageEnv = process.env, home = homedir()): string {
  assertStorageConfiguration(env);
  return resolveStoragePath(env.KANBAN_DATA_DIR, home)
    ?? join(resolveStoragePath(env.PASEO_HOME, home) ?? join(home, ".paseo"), "plugin-data", "paseo-kanban");
}

export function unifiedDataRoot(env: StorageEnv = process.env, home = homedir()): string {
  const dir = requestedUnifiedDataRoot(env, home);
  assertTestSafePath(dir);
  return dir;
}

export function fleetDataRoot(env: StorageEnv = process.env, home = homedir()): string {
  return join(unifiedDataRoot(env, home), "fleet");
}
