/// <reference types="node" />
// Reconcile compatibility coverage after a host upgrade or a plugin installation/check change.
// The timer and the real `paseo send` live in upgrade-watch.ts; tests call this with fakes.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { PLUGIN_IDS } from "../contract";
import { readSupervisorTable } from "../../shared/fleet/decisions";
import { type MessageKey, t, tAll } from "../../shared/fleet/i18n";
import { checkoutName, installedPluginDirs, kanbanConfigPath } from "./paths";
import { isLeaderTitle } from "./records";
import { BIN, CONFIG, PASEO_DIR, type Json, logSwallowed, readJson, STATE_DIR } from "./util";
import { kanbanSource } from "./kanban-source";
import { parseDaemonVersion } from "./daemon-log";
import { readRemovedProjects } from "./removed";

export const COMPAT_STATE_PATH = join(STATE_DIR, "compat-state.json");
/** Read-only. Supervisors are registered here by `kanban supervise`. */
export const KANBAN_CONFIG_PATH = kanbanConfigPath();

const WORKER_ROLE_KEYS: MessageKey[] = ["upgrade.workerRole.executor", "upgrade.workerRole.reviewer", "upgrade.workerRole.reader", "upgrade.workerRole.decision", "upgrade.workerRole.batch"];
const HANDOFF_MARK_KEYS: MessageKey[] = ["upgrade.handoffMark.supervisor", "upgrade.handoffMark.takeover"];

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const anyOf = (keys: readonly MessageKey[]): string => keys.flatMap((key) => tAll(key)).map(escapeRegex).join("|");

/** Titles of role workers, in any language (older titles are Chinese). The plugin's own supervisor is whoever is left in that cwd. */
export function workerTitle(): RegExp {
  return new RegExp(`^【(${anyOf(WORKER_ROLE_KEYS)})`);
}

/** A title that reads like a supervisor handoff chat, in any language. */
function handoffTitle(): RegExp {
  return new RegExp(`${anyOf(HANDOFF_MARK_KEYS)}|<leader>|handoff`, "i");
}

export interface CompatPlugin {
  id: string;
  label: string;
  dir: string;
  /** Substring of the supervisor session's cwd. Used only when the registry misses. */
  cwdMatch: string;
  /** Key in kanban.config.json `supervisors`. */
  project: string;
}

export interface ListedAgent {
  id: string;
  title: string;
  cwd: string;
  archivedAt: string | null;
  labels?: Record<string, string>;
}

export interface PluginCompatResult {
  id: string;
  label: string;
  status: "pass" | "fail" | "timeout" | "missing" | "unknown" | "pending";
  conclusion: string;
  at: string;
  supervisorId: string | null;
  notified: boolean;
  /** Installation and package/check fingerprint; absent on legacy snapshots. */
  identity?: string;
  /** Old evidence remains visible, but cannot establish current compatibility. */
  stale?: boolean;
}

export interface PluginInspection {
  identity: string | null;
  /** null means the package could not be inspected, rather than a missing script. */
  hasCompatScript: boolean | null;
}

export interface CompatContext {
  version: string | null;
  /** null means the current plugin inventory could not be read. */
  plugins: readonly (CompatPlugin & PluginInspection)[] | null;
}

export interface CompatState {
  version: string;
  recordedAt: string;
  checkedAt: string | null;
  results: PluginCompatResult[];
}

export interface CompatAlert {
  level: "red" | "yellow" | "info";
  kind: string;
  text: string;
  agentId: string | null;
}

export interface UpgradeDeps {
  readState(): Promise<CompatState | null>;
  writeState(state: CompatState): Promise<void>;
  currentVersion(): Promise<string | null>;
  plugins: readonly CompatPlugin[] | null;
  inspectPlugin(dir: string): Promise<PluginInspection>;
  runCompat(dir: string): Promise<{ ok: boolean; timedOut: boolean; output: string }>;
  listAgents(): Promise<ListedAgent[]>;
  send(agentId: string, text: string): Promise<void>;
  now(): string;
  /**
   * Project name → supervisor agent id from kanban.config.json.
   * Omit to read the file. Null, or a throw, falls back to findSupervisor.
   */
  readSupervisors?: () => Promise<Record<string, string> | null>;
  /** Projects that left Paseo get no notice. Omit to read the Paseo project list. */
  removedProjects?: () => ReadonlySet<string>;
}

export interface UpgradeOutcome {
  ran: boolean;
  reason: string;
  state: CompatState | null;
  alerts: CompatAlert[];
  notifications: Array<{ agentId: string; text: string }>;
}

/** Short ids and labels for the two plugins of this suite; any other plugin keeps its own id. */
const KNOWN_PLUGINS: Record<string, { id: string; label: string }> = {
  [PLUGIN_IDS.cockpit]: { id: "afc", label: "Paseo Kanban" },
  [PLUGIN_IDS.kanban]: { id: "kanban", label: "Paseo Kanban" },
};

/**
 * Every plugin Paseo loads from a directory (`plugins.<id>.path` in Paseo's config.json). The checkout
 * name doubles as the board project key and as the cwd match for its supervisor.
 */
export function defaultPlugins(installed: Array<{ id: string; dir: string }> = installedPluginDirs()): CompatPlugin[] {
  return installed.map(({ id, dir }) => {
    const known = KNOWN_PLUGINS[id];
    const name = checkoutName(dir);
    return { id: known?.id ?? id, label: known?.label ?? id, dir, cwdMatch: name, project: name };
  });
}

/** Read metadata only: no compatibility command is executed by snapshot consumers. */
export async function inspectCompatPlugin(dir: string): Promise<PluginInspection> {
  const path = join(dir, "package.json");
  const [real, install, metadata, text] = await Promise.all([realpath(dir), stat(dir), stat(path), readFile(path, "utf8")]);
  const pkg = JSON.parse(text) as { scripts?: { compat?: unknown } } | null;
  if (!pkg || typeof pkg !== "object" || Array.isArray(pkg)) throw new Error("Invalid package metadata");
  const script = pkg.scripts?.compat;
  // Real path and inode/birth time detect replacements (including a retargeted symlink).
  // Package bytes and file metadata detect version, npm lifecycle and compat-command edits.
  const identity = createHash("sha256").update(JSON.stringify([
    real, install.dev, install.ino, install.birthtimeMs,
    metadata.dev, metadata.ino, metadata.mtimeMs, metadata.ctimeMs, text,
  ])).digest("hex");
  return { identity, hasCompatScript: typeof script === "string" && script.trim().length > 0 };
}

async function inspectPlugins(plugins: UpgradeDeps["plugins"], inspect: UpgradeDeps["inspectPlugin"]): Promise<CompatContext["plugins"]> {
  if (plugins === null) return null;
  return Promise.all(plugins.map(async (plugin) => {
    try {
      return { ...plugin, ...await inspect(plugin.dir) };
    } catch (error) {
      logSwallowed(`upgrade-check inspect ${plugin.id}`, error);
      return { ...plugin, identity: null, hasCompatScript: null };
    }
  }));
}

export async function currentPaseoVersion(): Promise<string | null> {
  const fromCli = await new Promise<string>((resolve) => {
    execFile(BIN.paseo, ["--version"], { timeout: 15_000 }, (err, stdout) => resolve(err ? "" : String(stdout ?? "")));
  });
  const parsed = parseVersion(fromCli);
  if (parsed) return parsed;
  return parseDaemonVersion(await readFile(join(PASEO_DIR, "daemon.log"), "utf8").catch(() => ""));
}

export async function currentCompatContext(): Promise<CompatContext> {
  const version = await currentPaseoVersion();
  try {
    const config = JSON.parse(await readFile(CONFIG, "utf8")) as { plugins?: Record<string, { path?: unknown }> };
    if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("Invalid host config");
    if (config.plugins !== undefined && (!config.plugins || typeof config.plugins !== "object" || Array.isArray(config.plugins))) throw new Error("Invalid plugin inventory");
    const installed = Object.entries(config.plugins ?? {}).flatMap(([id, row]) => (
      row && typeof row.path === "string" && row.path.trim() ? [{ id, dir: row.path.trim() }] : []
    ));
    return { version, plugins: await inspectPlugins(defaultPlugins(installed), inspectCompatPlugin) };
  } catch (error) {
    logSwallowed("upgrade-check read plugin inventory", error);
    return { version, plugins: null };
  }
}

/** Keep only current plugins; retain stale failures as failures and mark new coverage pending. */
export function reconcileCompatState(state: CompatState | null, context: CompatContext): CompatState {
  const base = state ?? { version: context.version ?? "?", recordedAt: "", checkedAt: null, results: [] };
  if (context.plugins === null) return { ...base, results: base.results.map(row => ({ ...row, stale: true })) };
  return { ...base, results: context.plugins.map(plugin => {
    // A config ID can change without changing the installation or the executed check.
    // Carry that failure forward until a current check replaces it; never inherit a pass.
    const old = base.results.find(row => row.id === plugin.id) ?? (plugin.identity ? base.results.find(row => (
      row.identity === plugin.identity && (row.status === "fail" || row.status === "timeout")
    )) : undefined);
    if (!old) return { id: plugin.id, label: plugin.label, status: "pending", conclusion: t("upgrade.conclusion.pending", { label: plugin.label }), at: "", supervisorId: null, notified: false };
    const stale = old.id !== plugin.id || old.stale === true || !context.version || base.version !== context.version || !plugin.identity || old.identity !== plugin.identity;
    return { ...old, id: plugin.id, label: plugin.label, ...(stale ? { stale: true } : {}) };
  }) };
}

export async function readCompatSnapshot(raw: unknown, readContext = currentCompatContext): Promise<CompatState> {
  let context: CompatContext = { version: null, plugins: null };
  try {
    context = await readContext();
  } catch (error) {
    logSwallowed("upgrade-check inspect current context", error);
  }
  return reconcileCompatState(normalizeState(raw), context);
}

export function parseVersion(text: string): string | null {
  const m = text.match(/\d+\.\d+\.\d+/);
  return m ? m[0] : null;
}

export function conclusionFromOutput(output: string, ok: boolean, timedOut: boolean): string {
  if (timedOut) return t("upgrade.conclusion.timedOut");
  const line = output.split("\n").map((s) => s.trim()).filter(Boolean).pop();
  if (line) return line.slice(0, 300);
  return ok ? t("upgrade.conclusion.passed") : t("upgrade.conclusion.failed");
}

export function failureNotice(label: string, from: string | null, to: string, conclusion: string): string {
  const change = from && from !== to ? t("upgrade.notice.versionChange", { from, to }) : t("upgrade.notice.version", { to });
  return t("upgrade.notice.failure", { change, label, conclusion })
    .replace(/\s+/g, " ")
    .slice(0, 500);
}

/**
 * Read supervisors from kanban.config.json. A missing file, bad JSON, or an unusable
 * `supervisors` field returns null and is logged. It never throws.
 * Without an explicit path and with Kanban absent (no exports/kanban.json) it returns null quietly:
 * the snapshot calls this every round, and a missing board is not a problem to log.
 */
export async function readKanbanSupervisors(path?: string): Promise<Record<string, string> | null> {
  if (path === undefined && kanbanSource().presence === "absent") return null;
  let text: string;
  try {
    text = await readFile(path ?? KANBAN_CONFIG_PATH, "utf8");
  } catch (error) {
    console.error("[afc] upgrade-check: cannot read kanban.config.json:", String(error).slice(0, 200));
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    console.error("[afc] upgrade-check: kanban.config.json is not valid JSON:", String(error).slice(0, 200));
    return null;
  }
  const table = readSupervisorTable(parsed);
  if (!table) {
    console.error("[afc] upgrade-check: kanban.config.json has no usable supervisors");
    return null;
  }
  return table;
}

function isWorker(agent: ListedAgent): boolean {
  if (agent.labels?.role === "supervisor" || isLeaderTitle(agent.title)) return false;
  return workerTitle().test(agent.title);
}

/** Prefer a <leader> title or labels.role=supervisor, then a handoff chat, then any non-worker in that cwd. */
export function findSupervisor(agents: readonly ListedAgent[], cwdNeedle: string): string | null {
  const hits = agents.filter((a) => a.id && !a.archivedAt && a.cwd.includes(cwdNeedle) && !isWorker(a));
  if (hits.length === 0) return null;
  // The old supervisor title, the new <leader> title and labels.role=supervisor all count; isLeaderTitle knows the old title.
  const boss = hits.find((a) => a.labels?.role === "supervisor" || isLeaderTitle(a.title));
  if (boss) return boss.id;
  const handoff = hits.find((a) => handoffTitle().test(a.title));
  if (handoff) return handoff.id;
  const plain = hits.find((a) => !a.title.startsWith("【"));
  return (plain ?? hits[0]).id;
}

/**
 * Use the id registered for this plugin's project when that agent is still unarchived.
 * Otherwise guess with findSupervisor.
 */
export function resolveSupervisor(
  agents: readonly ListedAgent[],
  plugin: Pick<CompatPlugin, "cwdMatch" | "project">,
  table: Record<string, string> | null,
): string | null {
  const registered = table?.[plugin.project]?.trim();
  if (registered && agents.some((agent) => agent.id === registered && !agent.archivedAt)) return registered;
  return findSupervisor(agents, plugin.cwdMatch);
}

export function normalizeListed(raw: unknown): ListedAgent[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: ListedAgent[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const row = item as Json;
    const agent = row.agent && typeof row.agent === "object" ? (row.agent as Json) : row;
    const id = typeof agent.id === "string" ? agent.id : "";
    if (!id) continue;
    const archived = agent.archivedAt;
    const labelsRaw = agent.labels;
    const labels =
      labelsRaw && typeof labelsRaw === "object" && !Array.isArray(labelsRaw)
        ? Object.fromEntries(Object.entries(labelsRaw as Record<string, unknown>).flatMap(([key, value]) => (
          typeof value === "string" ? [[key, value] as const] : []
        )))
        : undefined;
    out.push({
      id,
      title: String(agent.title ?? agent.name ?? ""),
      cwd: String(agent.cwd ?? ""),
      archivedAt: archived ? String(archived) : null,
      ...(labels ? { labels } : {}),
    });
  }
  return out;
}

function normalizeResult(x: unknown): PluginCompatResult[] {
  if (!x || typeof x !== "object") return [];
  const o = x as Json;
  if (typeof o.id !== "string" || !o.id) return [];
  const status = ["pass", "fail", "timeout", "missing", "pending"].includes(String(o.status)) ? o.status as PluginCompatResult["status"] : "unknown";
  return [{
    id: o.id, label: typeof o.label === "string" ? o.label : o.id, status,
    conclusion: typeof o.conclusion === "string" ? o.conclusion : "",
    at: typeof o.at === "string" ? o.at : "",
    supervisorId: typeof o.supervisorId === "string" ? o.supervisorId : null,
    notified: o.notified === true,
    ...(typeof o.identity === "string" ? { identity: o.identity } : {}),
    ...(o.stale === true ? { stale: true } : {}),
  }];
}

export function normalizeState(raw: unknown): CompatState | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Json;
  if (typeof o.version !== "string" || !o.version) return null;
  return {
    version: o.version,
    recordedAt: typeof o.recordedAt === "string" ? o.recordedAt : "",
    checkedAt: typeof o.checkedAt === "string" ? o.checkedAt : null,
    results: Array.isArray(o.results) ? o.results.flatMap(normalizeResult) : [],
  };
}

export function alertsFromState(state: CompatState | null): CompatAlert[] {
  if (!state) return [];
  const alerts: CompatAlert[] = [];
  for (const r of state.results) {
    if (r.status === "fail" || r.status === "timeout") {
      const who = !r.supervisorId ? t("upgrade.alert.nobody") : r.notified ? "" : t("upgrade.alert.notSent");
      alerts.push({
        level: "red",
        kind: t("upgrade.conclusion.failed"),
        text: t("upgrade.alert.failed", { label: r.label, conclusion: r.conclusion, who }) + (r.stale ? t("upgrade.alert.stale") : ""),
        agentId: r.supervisorId,
      });
    } else if (r.status !== "pass" || r.stale) {
      const key = r.stale ? "upgrade.alert.staleResult" : r.status === "missing" ? "upgrade.alert.missing" : r.status === "pending" ? "upgrade.conclusion.pending" : "upgrade.conclusion.unknown";
      alerts.push({ level: "info", kind: t("upgrade.conclusion.unverified"), text: t(key, { label: r.label }), agentId: null });
    }
  }
  return alerts;
}

export async function readCompatAlerts(deps = {
  readState: () => readJson<unknown>(COMPAT_STATE_PATH, null),
  context: currentCompatContext,
}): Promise<CompatAlert[]> {
  try {
    const raw = await deps.readState();
    return alertsFromState(await readCompatSnapshot(raw, deps.context));
  } catch (error) {
    logSwallowed("upgrade-check read compat state", error);
    return [];
  }
}

function emptyOutcome(reason: string, state: CompatState | null): UpgradeOutcome {
  return { ran: false, reason, state, alerts: alertsFromState(state), notifications: [] };
}

/** First sight records pending coverage. Host or installation changes recheck affected plugins. */
export async function runUpgradeCheck(deps: UpgradeDeps, opts: { force: boolean }): Promise<UpgradeOutcome> {
  const version = await deps.currentVersion();
  const prev = normalizeState(await deps.readState());
  const plugins = await inspectPlugins(deps.plugins, deps.inspectPlugin);
  const reconciled = reconcileCompatState(prev, { version, plugins });
  if (!version) return emptyOutcome(t("upgrade.reason.noVersion"), reconciled);
  const now = deps.now();
  if (!opts.force && !prev?.version) {
    const state: CompatState = { ...reconciled, version, recordedAt: now, checkedAt: null };
    await deps.writeState(state);
    return emptyOutcome(t("upgrade.reason.firstSeen"), state);
  }
  const changed = opts.force || prev?.version !== version;
  const targets = (plugins ?? []).filter(plugin => {
    const row = reconciled.results.find(row => row.id === plugin.id);
    return changed || row?.stale || row?.status === "pending" || row?.status === "unknown";
  });
  // Persist pending/stale coverage before running commands so readers do not see an old green.
  if (JSON.stringify(prev) !== JSON.stringify(reconciled)) await deps.writeState(reconciled);
  if (targets.length === 0) return emptyOutcome(t("upgrade.reason.unchanged"), reconciled);

  let agents: ListedAgent[] = [];
  try {
    agents = await deps.listAgents();
  } catch (error) {
    logSwallowed("upgrade-check listAgents", error);
    agents = [];
  }
  let supervisors: Record<string, string> | null = null;
  try {
    supervisors = await (deps.readSupervisors ?? readKanbanSupervisors)();
  } catch (error) {
    console.error("[afc] upgrade-check: reading kanban.config.json failed:", String(error).slice(0, 300));
    supervisors = null;
  }
  const removed = (deps.removedProjects ?? readRemovedProjects)();
  const from = prev?.version ?? null;
  const results = [...reconciled.results];
  const notifications: UpgradeOutcome["notifications"] = [];
  for (const plugin of targets) {
    const index = results.findIndex(row => row.id === plugin.id);
    // Unreadable metadata is unverified; keep previous failure evidence until a check can run.
    if (!plugin.identity || plugin.hasCompatScript === null) continue;
    const supervisorId = removed.has(plugin.project) ? null : resolveSupervisor(agents, plugin, supervisors);
    if (!plugin.hasCompatScript) {
      const old = results[index];
      if (old.status === "fail" || old.status === "timeout") {
        results[index] = { ...old, stale: true };
        continue;
      }
      results[index] = {
        id: plugin.id,
        label: plugin.label,
        status: "missing",
        conclusion: t("upgrade.conclusion.missing"),
        at: now,
        supervisorId,
        notified: false,
        identity: plugin.identity,
      };
      continue;
    }
    let run: { ok: boolean; timedOut: boolean; output: string };
    try {
      run = await deps.runCompat(plugin.dir);
    } catch (e) {
      run = { ok: false, timedOut: false, output: String(e) };
    }
    const conclusion = conclusionFromOutput(run.output, run.ok, run.timedOut);
    const status = run.ok && !run.timedOut ? "pass" : "fail";
    let notified = false;
    if (status === "fail" && supervisorId) {
      const text = failureNotice(plugin.label, from, version, conclusion);
      try {
        await deps.send(supervisorId, text);
        notified = true;
        notifications.push({ agentId: supervisorId, text });
      } catch (error) {
        logSwallowed(`upgrade-check notify ${supervisorId}`, error);
        notified = false;
      }
    }
    results[index] = {
      id: plugin.id,
      label: plugin.label,
      status,
      conclusion,
      at: now,
      supervisorId,
      notified,
      identity: plugin.identity,
    };
  }
  const state: CompatState = { version, recordedAt: now, checkedAt: now, results };
  await deps.writeState(state);
  return {
    ran: true,
    reason: opts.force ? t("upgrade.reason.manual") : changed ? t("upgrade.reason.changed") : t("upgrade.reason.pluginsChanged"),
    state,
    alerts: alertsFromState(state),
    notifications,
  };
}
