/// <reference types="node" />
import type { PaseoApi } from "./paseo-api";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { type BoardSnapshot, ROLE_ORDER } from "../../shared/fleet/board";
import type { DispatchProfile } from "../../shared/fleet/dispatch";
import { recentChoices } from "../../shared/fleet/decision-change";
import { recentSupervisorDecisions } from "../../shared/fleet/decisions";
import { readDecisionMaintView } from "./decisions-maint";
import { loadProfiles } from "./dispatch";
import { buildHomeView } from "./home-feed";
import { readSupervisorPanel } from "./supervisor-shift";
import { readLeaderDetails } from "./leader-panel";
import { readPausedProjects } from "./paused";
import { countsWithoutPaused, isPausedProject } from "../../shared/fleet/paused";
import { productionCheckDeps, runOpenDecisionChecks, sourcesFromStored } from "./decision-check";
import { productionNudgeDeps, runLeaderNudges } from "./leader-nudge";
import { kanbanView, readWaitingTasks } from "./kanban";
import {
  assembleDecisions, buildRoles, classifyLive, kanbanDecisions, type LiveAgent, readChanges, RECENT_MS, storedDecisions,
} from "./snapshot-parts";
import { assembleQueueWithout } from "./queue";
import { readSweepView } from "./sweep";
import { POOL_STATUS, poolAlerts } from "./pools";
import { CURSOR_API, poolIdsOf, poolNames } from "../../shared/fleet/quota-adapters";
import { readPoolCatalog } from "./adapters/plans";
import { couponHomeAlerts, couponHomeBanner } from "./reset-coupons";
import { parseDaemonRestartTimes } from "./daemon-log";
import { readDaemonHealth } from "./daemon-watch";
import { readCursorLoginView } from "./cursor-login";
import { readKeychainAlerts } from "./keychain-probe";
import { type AgentRecord, nameToRoleKey, readAgentRecords } from "./records";
import { readCompatAlerts, readKanbanSupervisors } from "./upgrade-check";
import { createStepTimer, type StepTimer } from "./timing";
import { BIN, cached, DECISIONS, type Json, PASEO_DIR, readJson, runJson } from "./util";
import { language, t } from "../../shared/fleet/i18n";

type Alert = BoardSnapshot["alerts"][number];

async function liveAgents(paseo: PaseoApi): Promise<LiveAgent[]> {
  const result = (await paseo.agents.list({
    sort: [{ key: "updated_at", direction: "desc" }],
    page: { limit: 200 },
  })) as unknown as { entries?: Json[] };
  return (result.entries ?? []).map((raw) => {
    const a = (raw.agent ?? raw) as Json;
    return {
      id: String(a.id),
      title: String(a.title ?? ""),
      labels: (a.labels ?? {}) as Record<string, string>,
      status: String(a.status ?? "unknown"),
      cwd: String(a.cwd ?? ""),
      updatedAt: a.updatedAt ?? null,
      lastActivityAt: a.lastActivityAt ?? a.updatedAt ?? null,
      requiresAttention: Boolean(a.requiresAttention),
      attentionReason: a.attentionReason ?? null,
      lastError: a.lastError ?? null,
      archivedAt: a.archivedAt ?? null,
      createdAt: typeof a.createdAt === "string" ? a.createdAt : null,
      contextTokens: typeof a.lastUsage?.contextWindowUsedTokens === "number" ? a.lastUsage.contextWindowUsedTokens : null,
    };
  });
}

/** Daemon restart times in the last ~26 h, from the daemon logs. Cached 5 min. */
export function restartTimes(): Promise<number[]> {
  return cached("restarts", 5 * 60_000, async () => {
    const files = [join(PASEO_DIR, "daemon.log")];
    const listed = await readFile(join(PASEO_DIR, "daemon.log.txt"), "utf8").catch(() => "");
    files.push(...listed.split("\n").map((s) => s.trim()).filter(Boolean));
    const since = Date.now() - 26 * 3600_000;
    const times: number[] = [];
    for (const f of files) {
      const st = await stat(f).catch(() => null);
      if (!st || st.mtimeMs < since) continue;
      const text = await readFile(f, "utf8").catch(() => "");
      for (const at of parseDaemonRestartTimes(text)) if (at > since) times.push(at);
    }
    return times.sort();
  });
}

export function interruptedBy(rec: AgentRecord, restarts: number[]): number | null {
  if (!rec.lastActivityAt || rec.role === "supervisor") return null;
  const at = Date.parse(rec.lastActivityAt);
  for (const r of restarts) if (at <= r && r - at < 2 * 60_000) return r;
  return null;
}

/** Last run of a schedule; runs are read with the CLI, so cache them for a few minutes. */
function lastRun(id: string): Promise<{ at: string | null; result: string | null; output: string }> {
  return cached(`schedule-run:${id}`, 5 * 60_000, async () => {
    const runs = await runJson<Json>(BIN.paseo, ["schedule", "logs", id, "--json"], 15_000).catch(() => null);
    const list: Json[] = Array.isArray(runs) ? runs : Array.isArray(runs?.runs) ? runs.runs : Array.isArray(runs?.items) ? runs.items : [];
    const r = [...list].sort((a, b) => String(b?.startedAt ?? b?.started ?? "").localeCompare(String(a?.startedAt ?? a?.started ?? "")))[0];
    if (!r || typeof r !== "object") return { at: null, result: null, output: "" };
    return { at: r.startedAt ?? r.started ?? null, result: r.status ?? null, output: String(r.output ?? r.error ?? "").replace(/\s+/g, " ").slice(0, 160) };
  });
}

async function schedules(records: AgentRecord[], live: LiveAgent[]): Promise<{ rows: BoardSnapshot["schedules"]; warning: string | null }> {
  let raw: unknown;
  try {
    raw = await runJson<unknown>(BIN.paseo, ["schedule", "ls", "--json"], 15_000);
  } catch {
    return { rows: [], warning: null };
  }
  if (!Array.isArray(raw)) return { rows: [], warning: t("snapshot.schedulesFormatChanged") };
  const list = raw.filter((s): s is Json => Boolean(s) && typeof s === "object" && !Array.isArray(s));
  const byId = new Map(records.map((r) => [r.id, r]));
  const running = new Set(live.filter((a) => a.status === "running").map((a) => a.id));
  return {
    rows: await Promise.all(
    list.map(async (s) => {
      const target = String(s.target ?? "");
      const ownerId = /^agent:(.+)$/.exec(target)?.[1] ?? s.target?.agentId ?? null;
      const busy = ownerId ? running.has(ownerId) || records.some((r) => r.parentId === ownerId && running.has(r.id)) : false;
      const id = String(s.id ?? "?");
      const last = await lastRun(id);
      return {
        id,
        name: String(s.name ?? s.prompt ?? "").slice(0, 80),
        cadence: String(s.cadence ?? s.cron ?? ""),
        target,
        status: String(s.status ?? ""),
        nextRunAt: s.nextRunAt ?? null,
        lastRunAt: s.lastRunAt ?? last.at,
        lastResult: last.result,
        lastOutput: last.output,
        owner: ownerId ? (byId.get(ownerId)?.title ?? ownerId.slice(0, 8)) : null,
        ownerId,
        idle: ownerId ? !busy : false,
      };
    }),
    ),
    warning: null,
  };
}

function permitList(raw: unknown): Json[] | null {
  if (Array.isArray(raw)) return raw.filter((p): p is Json => Boolean(p) && typeof p === "object");
  if (raw && typeof raw === "object") {
    const o = raw as Json;
    if (Array.isArray(o.items)) return o.items.filter((p): p is Json => Boolean(p) && typeof p === "object");
    if (Array.isArray(o.requests)) return o.requests.filter((p): p is Json => Boolean(p) && typeof p === "object");
  }
  return null;
}

async function permissionAlerts(live: LiveAgent[]): Promise<{ alerts: BoardSnapshot["alerts"]; warning: string | null }> {
  let raw: unknown;
  try {
    raw = await runJson<unknown>(BIN.paseo, ["permit", "ls", "--json"], 15_000);
  } catch {
    return { alerts: [], warning: null };
  }
  const pending = permitList(raw);
  if (!pending) return { alerts: [], warning: t("snapshot.permitsFormatChanged") };
  const title = (id: string) => live.find((a) => a.id.startsWith(id))?.title ?? id;
  return {
    alerts: pending.map((p) => {
      const id = String(p.agentId ?? p.agent ?? "");
      const full = live.find((a) => a.id.startsWith(id))?.id ?? null;
      return { level: "yellow" as const, kind: t("snapshot.alertKind.awaitingApproval"), text: t("snapshot.permitRequest", { title: title(id), tool: p.tool ?? p.toolName ?? t("snapshot.permitAction") }), agentId: full };
    }),
    warning: null,
  };
}


function logSkipped(what: string, error: unknown): void {
  console.error(`[afc] snapshot: ${what}:`, String(error).slice(0, 200));
}

/** The role-profile names the title parser needs, limited to profiles with a known role. */
function roleNames(profiles: DispatchProfile[]): Map<string, string> {
  return nameToRoleKey(profiles.flatMap((profile) => (
    profile.role && (ROLE_ORDER as readonly string[]).includes(profile.role)
      ? [{ id: profile.name, name: profile.name, role: profile.role, provider: profile.provider ?? "", model: profile.model ?? undefined, pool: profile.pool ?? undefined, family: profile.family ?? undefined }]
      : []
  )));
}

/** Everything read from Paseo and from disk at the start of a round. A failed read is a warning, not a crash. */
async function readSources(paseo: PaseoApi): Promise<{ live: LiveAgent[]; records: AgentRecord[]; restarts: number[]; warnings: string[] }> {
  const warnings: string[] = [];
  const [live, records, restarts] = await Promise.all([
    liveAgents(paseo).catch((e) => {
      warnings.push(t("snapshot.agentsReadFailed", { error: String(e).slice(0, 160) }));
      return [] as LiveAgent[];
    }),
    readAgentRecords().catch((e) => {
      warnings.push(t("snapshot.recordsReadFailed", { error: String(e).slice(0, 160) }));
      return [] as AgentRecord[];
    }),
    restartTimes().catch(() => [] as number[]),
  ]);
  return { live, records, restarts, warnings };
}

/** Agents whose last activity falls just before a daemon restart within the last day. */
function restartAlerts(records: AgentRecord[], restarts: number[], now: number): Alert[] {
  return records.flatMap((rec): Alert[] => {
    if (rec.archivedAt || !rec.role) return [];
    const r = interruptedBy(rec, restarts);
    if (!r || now - r >= RECENT_MS) return [];
    const clock = new Date(r).toLocaleTimeString(language(), { hour12: false });
    return [{ level: "red", kind: t("snapshot.alertKind.restartInterrupted"), text: t("snapshot.restartInterrupted", { title: rec.title, time: clock }), agentId: rec.id }];
  });
}

interface Part { alerts: Alert[]; warning: string | null }

async function couponPart(now: number): Promise<Part & { banner: string | null }> {
  let alerts: Alert[] = [];
  let banner: string | null = null;
  try {
    alerts = (await couponHomeAlerts(now)).map((alert) => ({ ...alert, agentId: null }));
    banner = await couponHomeBanner(now);
  } catch (error) {
    logSkipped("coupon alerts", error);
    return { alerts, banner, warning: t("snapshot.couponsUnread") };
  }
  return { alerts, banner, warning: null };
}

async function daemonPart(now: number): Promise<Part & { crashesToday: number }> {
  try {
    const health = await readDaemonHealth(now);
    return { alerts: [health.crash, health.missing].filter((a): a is NonNullable<typeof a> => a !== null), crashesToday: health.today, warning: null };
  } catch (error) {
    logSkipped("daemon crash log", error);
    return { alerts: [], crashesToday: 0, warning: t("snapshot.crashesUnread") };
  }
}

async function keychainPart(now: number): Promise<Part> {
  try {
    return { alerts: await readKeychainAlerts(now), warning: null };
  } catch (error) {
    logSkipped("keychain probe", error);
    return { alerts: [], warning: t("snapshot.keychainUnread") };
  }
}

async function cursorPart(): Promise<Part & { notes: BoardSnapshot["cursorNotes"] }> {
  try {
    const view = await readCursorLoginView();
    return { alerts: view.alerts, notes: view.notes.map((note) => ({ at: new Date(note.at).toISOString(), text: note.text })), warning: null };
  } catch (error) {
    logSkipped("Cursor login state", error);
    return { alerts: [], notes: [], warning: t("snapshot.cursorLoginUnread") };
  }
}

/** Alerts from the state files other watchers keep (compat, quota, coupons, daemon, keychain, Cursor login). */
async function readHealth(poolFile: Json, now: number, timer: StepTimer, cursorPools: readonly string[]): Promise<{ alerts: Alert[]; warnings: string[]; banner: string | null; daemonCrashesToday: number; cursorNotes: BoardSnapshot["cursorNotes"] }> {
  const step = timer.step;
  const compat = await step("health.compat", () => readCompatAlerts());
  const pool = poolAlerts(poolFile, now, cursorPools).map((a) => ({ ...a, agentId: null }));
  const coupon = await step("health.coupon", () => couponPart(now));
  const daemon = await step("health.daemon", () => daemonPart(now));
  const keychain = await step("health.keychain", () => keychainPart(now));
  const cursor = await step("health.cursor", () => cursorPart());
  return {
    alerts: [...compat, ...pool, ...coupon.alerts, ...daemon.alerts, ...keychain.alerts, ...cursor.alerts],
    warnings: [coupon, daemon, keychain, cursor].flatMap((part) => (part.warning ? [part.warning] : [])),
    banner: coupon.banner,
    daemonCrashesToday: daemon.crashesToday,
    cursorNotes: cursor.notes,
  };
}

/** Waiting Kanban cards. The columns are optional: a failure hides them and the rest of the overview stays up. */
function readQueue(records: AgentRecord[], now: number, paused: Awaited<ReturnType<typeof readPausedProjects>>): { shown: boolean; rows: BoardSnapshot["kanban"]["waiting"]; alerts: Alert[] } {
  try {
    const queue = readWaitingTasks();
    if (!queue.shown) return { shown: false, rows: [], alerts: [] };
    const agentsById = new Map(records.map((rec) => [rec.id, { status: rec.status, lastActivityAt: rec.lastActivityAt }]));
    const assembled = assembleQueueWithout(queue.tasks, agentsById, now, paused);
    return {
      shown: true,
      rows: assembled.rows,
      alerts: assembled.alerts.map((alert) => ({ level: alert.level, kind: alert.kind, text: alert.text, agentId: alert.agentId })),
    };
  } catch (error) {
    logSkipped("Kanban waiting queue", error);
    return { shown: false, rows: [], alerts: [] };
  }
}

const ALERT_ORDER = { red: 0, yellow: 1, info: 2 } as const;

/** First alert wins per kind + agent + text; red before yellow before info, otherwise in arrival order. */
function dedupAndSort(alerts: Alert[]): Alert[] {
  const seen = new Set<string>();
  const unique = alerts.filter((x) => {
    const k = `${x.kind}|${x.agentId ?? ""}|${x.text}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return unique.sort((a, b) => ALERT_ORDER[a.level] - ALERT_ORDER[b.level]);
}

interface PanelInput {
  paseo: PaseoApi;
  now: number;
  live: LiveAgent[];
  records: AgentRecord[];
  stored: Json[];
  paused: Awaited<ReturnType<typeof readPausedProjects>>;
  supervisors: Record<string, string> | null;
  home: Parameters<typeof buildHomeView>[0];
}

/** Home figures and the leader panel. Each falls back to an empty view on failure. */
async function readPanels(input: PanelInput, timer: StepTimer, nudge: boolean) {
  const { paseo, now, live, records, stored, paused } = input;
  const step = timer.step;
  const home = await step("panels.home", () => buildHomeView(input.home)).catch(() => ({ companies: [], days: [], roleShares: [], roleCards: [] }));
  const liveBits = live.map((agent) => ({ id: agent.id, status: agent.status, createdAt: agent.createdAt, contextTokens: agent.contextTokens, archivedAt: agent.archivedAt }));
  const supervisorPanel = await step("panels.supervisor", () => readSupervisorPanel(paseo, liveBits, records, now)).catch(() => ({ rows: [], tasks: [], handoffs: [] }));
  const registered = stored.map((d) => ({
    id: String(d.id ?? ""), project: String(d.project ?? ""), status: String(d.status ?? ""),
    title: String(d.title ?? ""), detail: String(d.detail ?? ""), createdAt: String(d.createdAt ?? ""),
  }));
  const sessions = new Map(records.map((r) => [r.id, { cwd: r.cwd, provider: r.provider }]));
  const details = await step("panels.leaderDetails", () => readLeaderDetails(paseo, supervisorPanel.rows, registered, now, sessions));
  if (nudge) {
    void runLeaderNudges(details, now, productionNudgeDeps(), paused).catch((error) => logSkipped("leader nudges", error));
    void runOpenDecisionChecks({
      items: sourcesFromStored(stored),
      details,
      supervisors: input.supervisors,
      paused,
      now,
    }, productionCheckDeps()).catch((error) => logSkipped("open decision checks", error));
  }
  return { home, supervisorPanel: { ...supervisorPanel, details } };
}

/** The schedule list (two `paseo` CLI calls). A failure is a warning for this round. */
function readSchedules(records: AgentRecord[], live: LiveAgent[]): Promise<{ rows: BoardSnapshot["schedules"]; warning: string | null }> {
  return schedules(records, live).catch(() => ({
    rows: [] as BoardSnapshot["schedules"],
    warning: t("snapshot.schedulesReadFailed") as string | null,
  }));
}

export interface SnapshotOptions {
  /** Records how long each step took. */
  timer?: StepTimer;
  /** Send leader nudges from this round (default true). Benchmarks turn it off. */
  nudge?: boolean;
}

/** Files and the Kanban db: none of these wait on Paseo, so they are read alongside the agent list. */
async function readLocal(timer: StepTimer) {
  const step = timer.step;
  const [paused, decisionMaint, supervisorTable, stored, kanban, changes, sweep] = await Promise.all([
    step("paused", () => readPausedProjects()),
    step("decisionMaint", () => readDecisionMaintView()),
    step("kanbanSupervisors", () => readKanbanSupervisors()),
    step("decisions", () => readJson<Json[]>(DECISIONS, [])),
    step("kanban", () => kanbanView()),
    step("changes", () => readChanges()),
    step("sweep", () => readSweepView()),
  ]);
  return { paused, decisionMaint, supervisorTable, stored, kanban, changes, sweep };
}

/**
 * One round of the board. Independent reads run side by side: the slow ones are the agent list and
 * two `paseo` CLI calls (permit ls, schedule ls), so a round costs about the slowest of them, not the sum.
 */
export async function buildSnapshot(paseo: PaseoApi, options: SnapshotOptions = {}): Promise<BoardSnapshot> {
  const timer = options.timer ?? createStepTimer();
  const step = timer.step;
  const now = Date.now();
  const localRead = readLocal(timer);
  // Awaited below; this only keeps an early failure from counting as unhandled while the first batch runs.
  localRead.catch(() => undefined);
  const [profilesOrNull, poolFile, catalog, sources] = await Promise.all([
    step("profiles", () => loadProfiles()),
    step("poolFile", () => readJson<Json>(POOL_STATUS, {})),
    step("catalog", () => readPoolCatalog()),
    step("sources", () => readSources(paseo)),
  ]);
  const profiles = profilesOrNull ?? [];
  const pools: Record<string, Json> = poolFile.pools ?? {};
  const { roles, warnings: roleWarnings } = buildRoles(profiles, pools, now, poolNames(catalog, "label"));
  const { live, records, restarts, warnings: sourceWarnings } = sources;
  const [fleet, perm, health, scheduleView, local] = await Promise.all([
    step("classifyLive", () => classifyLive(live, roleNames(profiles), now)),
    step("permit", () => permissionAlerts(live)),
    step("health", () => readHealth(poolFile, now, timer, poolIdsOf(catalog, CURSOR_API))),
    step("schedules", () => readSchedules(records, live)),
    localRead,
  ]);
  const { paused, decisionMaint, supervisorTable, stored, kanban, changes, sweep } = local;
  const queue = await step("queue", () => readQueue(records, now, paused));
  const alerts = [...fleet.alerts, ...restartAlerts(records, restarts, now), ...perm.alerts, ...health.alerts, ...queue.alerts];
  const { decisions, pausedDecisions } = assembleDecisions(fleet.decisions, storedDecisions(stored, supervisorTable), kanbanDecisions(kanban.needsPerson), paused);

  const agents = [...fleet.agents].sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  const cursorUsingManual = poolFile.cursorRead?.usingManual === true;
  const panels = await step("panels", () => readPanels({ paseo, now, live, records, stored, paused, supervisors: supervisorTable, home: { now, pools, roles, cursorUsingManual, banner: health.banner, via: poolNames(catalog, "via") } }, timer, options.nudge !== false));
  const warnings = [...roleWarnings, ...sourceWarnings, ...(perm.warning ? [perm.warning] : []), ...health.warnings, ...(kanban.warning ? [kanban.warning] : []), ...(scheduleView.warning ? [scheduleView.warning] : [])];

  return {
    generatedAt: new Date().toISOString(),
    roles,
    agents,
    alerts: dedupAndSort(alerts),
    decisions,
    supervisorDecisions: recentSupervisorDecisions(stored, now),
    recentChoices: recentChoices(stored, now),
    decisionMaint,
    schedules: scheduleView.rows,
    kanban: { presence: kanban.presence, available: kanban.available, counts: countsWithoutPaused(kanban.counts, kanban.byProject, paused), queueShown: queue.shown, waiting: queue.rows },
    changes,
    cursorNotes: health.cursorNotes,
    sweep,
    supervisors: fleet.supervisors,
    warnings,
    daemonCrashesToday: health.daemonCrashesToday,
    home: panels.home,
    supervisorPanel: panels.supervisorPanel,
    pausedProjects: paused.map((p) => ({ ...p, decisions: pausedDecisions.filter((d) => isPausedProject(d.project, [p])) })),
  };
}
