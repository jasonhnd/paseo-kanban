/// <reference types="node" />
import { unifiedDataRoot } from "./storage/root";
import { homedir, tmpdir } from "node:os";
import { t } from "../shared/i18n";
import * as pathFs from "./perf-fs";
import * as testFs from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { paseoHome, PLUGIN_IDS, type PluginId } from "./contract";

export const HOME = homedir();

/** This plugin's id in Paseo's config and under `plugin-data/`. */
export const PLUGIN_ID = PLUGIN_IDS.kanban;

/** Where the data directory came from: the override, Paseo's plugin-data directory, or the pre-migration `data/` beside the plugin. */
export type DataDirSource = "env" | "plugin-data" | "legacy";

export interface DataDirChoice {
  dir: string;
  source: DataDirSource;
  /** The plugin-data directory this installation moves to once it is migrated. */
  pluginDataDir: string;
  /** `<plugin root>/data`, the directory used before plugin-data existed. */
  legacyDir: string;
}

export interface DataDirInput {
  env: NodeJS.ProcessEnv;
  home: string;
  pluginRoot: string;
  exists: (path: string) => boolean;
}

/** `$PASEO_HOME/plugin-data/paseo-kanban`, ignoring KANBAN_DATA_DIR. */
export function defaultPluginDataDir(env: NodeJS.ProcessEnv = process.env, home = HOME): string {
  return unifiedDataRoot({ ...env, KANBAN_DATA_DIR: undefined }, home);
}

/**
 * Pick the data directory. KANBAN_DATA_DIR wins. Otherwise Paseo's plugin-data directory, unless
 * it has no board yet while the legacy `data/` beside the plugin does: an installation that has not
 * been migrated keeps its board. When both have a board, plugin-data wins.
 */
export function chooseDataDir(input: DataDirInput): DataDirChoice {
  const pluginDataDir = defaultPluginDataDir(input.env, input.home);
  const legacyDir = join(input.pluginRoot, "data");
  const dir = unifiedDataRoot(input.env, input.home);
  return { dir, source: input.env.KANBAN_DATA_DIR?.trim() ? "env" : "plugin-data", pluginDataDir, legacyDir };
}

/** Decided once per process (per set of inputs), so a board created later never switches directories mid-run. */
let startupChoice: { key: string; choice: DataDirChoice } | null = null;

/** The data directory in use when KANBAN_DATA_DIR is not set. */
export function dataDirChoice(env: NodeJS.ProcessEnv = process.env): DataDirChoice {
  const explicit = env.KANBAN_DATA_DIR?.trim();
  if (explicit) return chooseDataDir({ env, home: HOME, pluginRoot: pluginRoot(env), exists: () => false });
  const key = JSON.stringify([HOME, env.PASEO_HOME ?? null, env.KANBAN_HOME ?? null, env.KANBAN_PASEO_CONFIG ?? null]);
  if (startupChoice?.key !== key) {
    startupChoice = { key, choice: chooseDataDir({ env, home: HOME, pluginRoot: pluginRoot(env), exists: testFs.existsSync }) };
  }
  return startupChoice.choice;
}

/** One log line naming the data directory and why it was chosen. */
export function describeDataDir(choice: DataDirChoice = dataDirChoice()): string {
  if (choice.source === "legacy") {
    return `data directory: ${choice.dir} (legacy directory beside the plugin; not migrated to ${choice.pluginDataDir} yet)`;
  }
  if (choice.source === "env") return `data directory: ${choice.dir} (KANBAN_DATA_DIR)`;
  return `data directory: ${choice.dir}`;
}

/** The data directory this process asks for, before the test isolation guard. Only getDb uses it, to recognise its open handle. */
export function requestedDataDir(): string {
  return unifiedDataRoot();
}

export function dataDir(): string {
  const dir = requestedDataDir();
  assertTestDataPath(dir);
  return dir;
}

let testRoots: { key: string; temporary: string[]; production: string[] } | null = null;

/** Test subprocesses inherit the runner marker even when Node drops NODE_TEST_CONTEXT. */
export function assertTestDataPath(path: string): void {
  const testing = process.env.NODE_TEST_CONTEXT !== undefined || process.env.KANBAN_TEST_TMP !== undefined
    || /(?:^|[/\\])kanban-test-\d+-/.test(process.env.TMPDIR ?? "");
  if (!testing) return;
  const refuse = () => {
    // Only fires under the test runner (often in a subprocess with no language set), so it stays English.
    throw new Error(`Tests may not touch unisolated board data: ${path}; set KANBAN_DATA_DIR to a temporary directory.`);
  };
  if (!process.env.KANBAN_DATA_DIR?.trim()) refuse();
  const canonical = (value: string) => canonicalPath(value, new Set(), testFs);
  const inside = (target: string, parent: string) => {
    const rel = relative(parent, target);
    return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
  };
  const target = canonical(path);
  const checkout = checkoutRoot();
  const registered = registeredPluginPath(PLUGIN_ID);
  const fresh = defaultPluginDataDir();
  const key = JSON.stringify([tmpdir(), HOME, checkout, registered, fresh]);
  if (!testRoots || testRoots.key !== key) {
    const temporary = [tmpdir(), "/tmp"].map(canonical);
    // The installation Paseo loads and Paseo's plugin-data directory are live data.
    const production = [fresh, ...(registered ? [join(registered, "data")] : [])].map(canonical);
    // A simulated installation inside TMPDIR is an isolated fixture, not live data.
    if (checkout && !temporary.some(parent => inside(canonical(checkout), parent))) production.push(canonical(join(checkout, "data")));
    testRoots = { key, temporary, production };
  }
  // Resolve the requested path on every access, including after a symlink is replaced.
  if (!testRoots.temporary.some(parent => inside(target, parent))
      || testRoots.production.some(parent => inside(target, parent))) refuse();
}

/** Paseo's config file with the agent profiles and plugins. Tests can point it elsewhere with KANBAN_PASEO_CONFIG. */
export function paseoConfigPath(env: NodeJS.ProcessEnv = process.env, home = HOME): string {
  const override = env.KANBAN_PASEO_CONFIG?.trim();
  if (override) return override;
  return join(paseoHome(env, home), "config.json");
}

/** Parsed `plugins` of Paseo's config, keyed by file identity so a busy caller does not re-parse an unchanged file. */
let pluginsCache: { path: string; mtimeMs: number; size: number; plugins: Record<string, unknown> | null } | null = null;

function registeredPlugins(path: string): Record<string, unknown> | null {
  let stat: { mtimeMs: number; size: number };
  try {
    stat = testFs.statSync(path);
  } catch {
    pluginsCache = null;
    return null;
  }
  // A file changed in the last two seconds is always read again: a same-size rewrite can keep its mtime.
  const settled = Date.now() - stat.mtimeMs > 2_000;
  if (settled && pluginsCache && pluginsCache.path === path && pluginsCache.mtimeMs === stat.mtimeMs && pluginsCache.size === stat.size) {
    return pluginsCache.plugins;
  }
  let plugins: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(testFs.readFileSync(path, "utf8"));
    const value = parsed && typeof parsed === "object" ? (parsed as { plugins?: unknown }).plugins : undefined;
    plugins = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    plugins = null;
  }
  pluginsCache = { path, mtimeMs: stat.mtimeMs, size: stat.size, plugins };
  return plugins;
}

/**
 * The directory Paseo loads a plugin from: `plugins[<id>].path` in Paseo's config.
 * Null when the config is missing, unreadable, or does not list the plugin with a path.
 */
export function registeredPluginPath(id: PluginId, env: NodeJS.ProcessEnv = process.env, home = HOME): string | null {
  const entry = registeredPlugins(paseoConfigPath(env, home))?.[id];
  const path = entry && typeof entry === "object" ? (entry as { path?: unknown }).path : undefined;
  return typeof path === "string" && path.trim() ? resolve(path.trim()) : null;
}

/** Paseo-managed git worktrees. Tests can point this at a temp dir with KANBAN_WORKTREES_ROOT. */
export function paseoWorktreesRoot(): string {
  const override = process.env.KANBAN_WORKTREES_ROOT?.trim();
  if (override) return override;
  return join(HOME, ".paseo", "worktrees");
}

/**
 * Directory that holds the user's project checkouts, side by side with this plugin's checkout.
 * KANBAN_PROJECTS_ROOT overrides it; tests may also use KANBAN_AGENTIC_ROOT.
 */
export function checkoutsRoot(): string {
  const override = process.env.KANBAN_PROJECTS_ROOT?.trim() || process.env.KANBAN_AGENTIC_ROOT?.trim();
  if (override) return override;
  return dirname(pluginRoot());
}

/** This plugin's repo. Tests can point it at a fixture with KANBAN_PROJECT_ROOT. */
export function projectRoot(): string {
  const override = process.env.KANBAN_PROJECT_ROOT?.trim();
  if (override) return override;
  return checkoutRoot() ?? pluginRoot();
}

/**
 * Installation authority, never inferred from cwd, git common-dir or test projectRoot.
 * KANBAN_HOME, then the path Paseo's config registers for this plugin, then the checkout this
 * code runs from (the command line), then the working directory.
 */
export function pluginRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.KANBAN_HOME?.trim() || registeredPluginPath(PLUGIN_ID, env) || checkoutRoot() || process.cwd();
}

/** The board command line inside an installation. */
export function kanbanCliPath(root = pluginRoot()): string {
  return join(root, "bin", "paseo-kanban.mjs");
}

/** ESM CLI knows its checkout. Paseo's eval-ed CJS bundle has no source URL. */
export function checkoutRoot(): string | null {
  const url = import.meta.url;
  return typeof url === "string" && url.startsWith("file:")
    ? resolve(dirname(fileURLToPath(url)), "..")
    : null;
}

/** Resolve existing parents too, so symlinked data directories cannot bypass the guard. */
export function canonicalPath(path: string, seen = new Set<string>(), io = pathFs): string {
  const absolute = resolve(path);
  if (seen.has(absolute)) throw new Error(t("paths.symlinkLoop", { path: absolute }));
  seen.add(absolute);
  if (io.existsSync(absolute)) return io.realpathSync(absolute);
  // A dangling DB symlink still points at production even before that DB is created.
  try {
    if (io.lstatSync(absolute).isSymbolicLink()) return canonicalPath(resolve(dirname(absolute), io.readlinkSync(absolute)), seen, io);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const parent = dirname(absolute);
  return parent === absolute ? absolute : join(canonicalPath(parent, seen, io), basename(absolute));
}

export function isPluginCheckout(env: NodeJS.ProcessEnv = process.env): boolean {
  const source = checkoutRoot();
  // Paseo compiles the registered installation directory into CJS, then evals it.
  // That runtime is installation code; CLI/worktree tsx processes retain a file URL.
  return source === null || canonicalPath(source) === canonicalPath(pluginRoot(env));
}

/** Live board directories: the installation's legacy `data/`, the registered installation's, and plugin-data. */
export function productionDataDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const registered = registeredPluginPath(PLUGIN_ID, env);
  const dirs = [join(pluginRoot(env), "data"), ...(registered ? [join(registered, "data")] : []), defaultPluginDataDir(env)];
  return [...new Set(dirs)];
}

export function isProductionDataDir(dir: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const file = canonicalPath(join(dir, "kanban.db"));
  return productionDataDirs(env).some(production => canonicalPath(join(production, "kanban.db")) === file);
}

export function canMigrateDataDir(dir: string): boolean {
  return !isProductionDataDir(dir) || isPluginCheckout();
}
