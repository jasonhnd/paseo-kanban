// Where each plugin keeps its data and its contract exports.
// The plugin SDK has no data-directory API, so plugins use `$PASEO_HOME/plugin-data/<plugin-id>`.
// Overrides, highest first: AFC_DATA_DIR / KANBAN_DATA_DIR (per plugin), then PASEO_HOME, then `~/.paseo`.
import { assertTestSafePath } from "../storage/test-safety";
import { unifiedDataRoot, fleetDataRoot } from "../storage/root";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { EXPORTS, PLUGIN_IDS, type ExportKind, type PluginId } from "../../shared/contract/schema";

export type Env = Readonly<Record<string, string | undefined>>;

export const EXPORTS_DIR_NAME = "exports";


function envPath(env: Env, name: string, home: string): string | null {
  const raw = env[name]?.trim();
  if (!raw) return null;
  if (raw === "~") return home;
  if (raw.startsWith("~/")) return join(home, raw.slice(2));
  return isAbsolute(raw) ? raw : resolve(raw);
}

/** Paseo's home directory: `PASEO_HOME`, else `~/.paseo`. */
export function paseoHome(env: Env = process.env, home: string = homedir()): string {
  const dir = envPath(env, "PASEO_HOME", home) ?? join(home, ".paseo");
  assertTestSafePath(join(dir, "config.json"));
  return dir;
}

/** A plugin's data directory, honouring its own override variable first. */
export function pluginDataDir(pluginId: PluginId, env: Env = process.env, home: string = homedir()): string {
  return pluginId === PLUGIN_IDS.cockpit ? fleetDataRoot(env, home) : unifiedDataRoot(env, home);
}

/** The directory a plugin writes its contract files into. */
export function exportsDir(pluginId: PluginId, env: Env = process.env, home: string = homedir()): string {
  return pluginId === PLUGIN_IDS.cockpit
    ? join(unifiedDataRoot(env, home), EXPORTS_DIR_NAME, "fleet")
    : join(unifiedDataRoot(env, home), EXPORTS_DIR_NAME);
}

/** Full path of one export file, located under its producer's data directory. */
export function exportPath(kind: ExportKind, env: Env = process.env, home: string = homedir()): string {
  const spec = EXPORTS[kind];
  return join(exportsDir(spec.producer, env, home), spec.file);
}
