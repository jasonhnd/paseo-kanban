/// <reference types="node" />
// Decide when to re-check the three plugins after a Paseo upgrade.
// The timer and the real `paseo send` live in upgrade-watch.ts; tests call this with fakes.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PLUGIN_IDS } from "../contract";
import { readSupervisorTable } from "../../shared/fleet/decisions";
import { type MessageKey, t, tAll } from "../../shared/fleet/i18n";
import { checkoutName, installedPluginDirs, kanbanConfigPath } from "./paths";
import { isLeaderTitle } from "./records";
import { type Json, logSwallowed, readJson, STATE_DIR } from "./util";
import { kanbanSource } from "./kanban-source";

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
  status: "pass" | "fail" | "missing";
  conclusion: string;
  at: string;
  supervisorId: string | null;
  notified: boolean;
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
  plugins: readonly CompatPlugin[];
  hasCompatScript(dir: string): Promise<boolean>;
  runCompat(dir: string): Promise<{ ok: boolean; timedOut: boolean; output: string }>;
  listAgents(): Promise<ListedAgent[]>;
  send(agentId: string, text: string): Promise<void>;
  now(): string;
  /**
   * Project name → supervisor agent id from kanban.config.json.
   * Omit to read the file. Null, or a throw, falls back to findSupervisor.
   */
  readSupervisors?: () => Promise<Record<string, string> | null>;
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
  [PLUGIN_IDS.cockpit]: { id: "afc", label: "AFC" },
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

function isResult(x: unknown): x is PluginCompatResult {
  if (!x || typeof x !== "object") return false;
  const o = x as Json;
  return typeof o.label === "string" && (o.status === "pass" || o.status === "fail" || o.status === "missing") && typeof o.conclusion === "string";
}

export function normalizeState(raw: unknown): CompatState | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Json;
  if (typeof o.version !== "string" || !o.version) return null;
  return {
    version: o.version,
    recordedAt: typeof o.recordedAt === "string" ? o.recordedAt : "",
    checkedAt: typeof o.checkedAt === "string" ? o.checkedAt : null,
    results: Array.isArray(o.results) ? o.results.filter(isResult) : [],
  };
}

export function alertsFromState(state: CompatState | null): CompatAlert[] {
  if (!state) return [];
  const alerts: CompatAlert[] = [];
  for (const r of state.results) {
    if (r.status === "missing") {
      alerts.push({ level: "info", kind: t("upgrade.conclusion.missing"), text: t("upgrade.alert.missing", { label: r.label }), agentId: null });
      continue;
    }
    if (r.status === "fail") {
      const who = !r.supervisorId ? t("upgrade.alert.nobody") : r.notified ? "" : t("upgrade.alert.notSent");
      alerts.push({
        level: "red",
        kind: t("upgrade.conclusion.failed"),
        text: t("upgrade.alert.failed", { label: r.label, conclusion: r.conclusion, who }),
        agentId: r.supervisorId,
      });
    }
  }
  return alerts;
}

export async function readCompatAlerts(): Promise<CompatAlert[]> {
  try {
    const raw = await readJson<unknown>(COMPAT_STATE_PATH, null);
    return alertsFromState(normalizeState(raw));
  } catch (error) {
    logSwallowed("upgrade-check read compat state", error);
    return [];
  }
}

function emptyOutcome(reason: string, state: CompatState | null): UpgradeOutcome {
  return { ran: false, reason, state, alerts: alertsFromState(state), notifications: [] };
}

/** First sight of a version only records it. A later change, or force, runs each plugin. */
export async function runUpgradeCheck(deps: UpgradeDeps, opts: { force: boolean }): Promise<UpgradeOutcome> {
  const version = await deps.currentVersion();
  const prev = normalizeState(await deps.readState());
  if (!version) return emptyOutcome(t("upgrade.reason.noVersion"), prev);
  const now = deps.now();
  if (!opts.force && !prev?.version) {
    const state: CompatState = { version, recordedAt: now, checkedAt: null, results: [] };
    await deps.writeState(state);
    return emptyOutcome(t("upgrade.reason.firstSeen"), state);
  }
  if (!opts.force && prev?.version === version) return emptyOutcome(t("upgrade.reason.unchanged"), prev);

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
  const from = prev?.version ?? null;
  const results: PluginCompatResult[] = [];
  const notifications: UpgradeOutcome["notifications"] = [];
  for (const plugin of deps.plugins) {
    const supervisorId = resolveSupervisor(agents, plugin, supervisors);
    let has = false;
    try {
      has = await deps.hasCompatScript(plugin.dir);
    } catch (error) {
      logSwallowed(`upgrade-check hasCompatScript ${plugin.id}`, error);
      has = false;
    }
    if (!has) {
      results.push({
        id: plugin.id,
        label: plugin.label,
        status: "missing",
        conclusion: t("upgrade.conclusion.missing"),
        at: now,
        supervisorId,
        notified: false,
      });
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
    results.push({
      id: plugin.id,
      label: plugin.label,
      status,
      conclusion,
      at: now,
      supervisorId,
      notified,
    });
  }
  const state: CompatState = { version, recordedAt: now, checkedAt: now, results };
  await deps.writeState(state);
  return {
    ran: true,
    reason: opts.force ? t("upgrade.reason.manual") : t("upgrade.reason.changed"),
    state,
    alerts: alertsFromState(state),
    notifications,
  };
}
