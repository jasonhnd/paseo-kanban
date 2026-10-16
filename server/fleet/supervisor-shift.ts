/// <reference types="node" />
import { randomUUID } from "node:crypto";
import { providerBanned } from "../../shared/fleet/provider-policy";
import { readBannedProviders, readLeaderThresholds } from "./adapters/config";
// Manual <leader> shift. The RPC calls requestSupervisorShift after the user confirms,
// continues, or cancels. A queue saved on disk resumes from the next homepage snapshot.
import { markProxies } from "../../shared/fleet/leader-proxy";
import type { PaseoApi } from "./paseo-api";
import { appendFile, mkdir, readFile, unlink } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { publicPriceUsd, tokyoDayStart } from "../../shared/fleet/dispatch";
import { t } from "../../shared/fleet/i18n";
import {
  buildSupervisorRows,
  cancelledLabel,
  EMPTY_SUPERVISOR_PANEL,
  handoverPreview,
  handoverSummary,
  HANDOVER_PREVIEW_LINES,
  isBusy,
  isCancelledLabel,
  parseHandoffs,
  phaseLabel,
  parseShiftState,
  providerModel,
  recoverOldId,
  restoreShiftForDisplay,
  runSupervisorShift,
  serializeHandoff,
  queueStartedAt,
  serializeShiftState,
  SHIFT_DONE_HOLD_MS,
  shiftOpen,
  sumTodayUsd,
  supervisorSlots,
  type HandoffLogLine,
  type ShiftAgent,
  type ShiftPorts,
  type ShiftProgress,
  type ShiftResume,
  type StoredShift,
  type SupervisorAgentView,
  type SupervisorPanel,
} from "../../shared/fleet/supervisor-shift";
import { KANBAN_CONFIG } from "./decisions-maint";
import { formatCardCode } from "./kanban";
import { ledgerBuckets } from "./ledger";
import { priceFor } from "./prices";
import { type AgentRecord, readAgentRecords } from "./records";
import type { BoardSummary } from "../contract";
import { kanbanSource } from "./kanban-source";
import { kanbanProjectName } from "./paths";
import { readRemovedProjects, visibleSupervisorSlots } from "./removed";
import { BIN, cached, type Json, readJson, runJson, STATE_DIR, writeJson } from "./util";
import { PLANS } from "./usage";

export const HANDOFF_LOG = join(STATE_DIR, "supervisor-handoffs.log");
/** In-progress shifts. Gitignored. A plugin reload reads this and shows the same step. */
export const SHIFT_STATE = join(STATE_DIR, "supervisor-shift-state.json");
const SCAN = join(STATE_DIR, "usage-scan-cache.json");
/** Codes of a project's cards waiting for acceptance, from the board summary, in code order. */
export function acceptanceFromSummary(summary: BoardSummary, project: string): string[] {
  return summary.cards
    .filter((card) => card.project === project && card.status === "acceptance")
    .map((card) => card.code)
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
}

/**
 * Full project list, independent of the homepage's 15-row waiting table. Never writes to Kanban.
 * Without an explicit `dbPath` the board summary answers; the database it names is the fallback.
 * Null means unknown: Kanban is absent or nothing could be read.
 */
export function readAcceptanceCards(project: string, dbPath?: string | null, codesPath = KANBAN_CONFIG): string[] | null {
  let path = dbPath;
  if (path === undefined) {
    const source = kanbanSource();
    if (source.presence === "absent") return null;
    if (source.summary) return acceptanceFromSummary(source.summary, project);
    path = source.dbPath;
  }
  if (path === null) return null;
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const columns = db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
    const sequence = columns.some((column) => column.name === "code_seq") ? "code_seq" : "NULL";
    const cards = db.prepare(`SELECT id, ${sequence} AS code_seq FROM tasks WHERE project = ? AND status = 'acceptance' ORDER BY id`).all(project) as Array<{ id: number; code_seq: number | null }>;
    return cards.map((card) => formatCardCode(project, card.id, card.code_seq, codesPath));
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

interface LiveBit {
  id: string;
  status: string;
  createdAt: string | null;
  contextTokens: number | null;
  archivedAt: string | null;
}

interface JobMeta {
  creationKey?: string;
  /** Absent only for legacy state that did not record the old session. */
  oldId?: string;
  resume: ShiftResume;
  newId: string | null;
  queuedAt: number | null;
}

const tasks = new Map<string, ShiftProgress>();
const eventOffsets = new Map<string, number>();
const events = new Map<string, ShiftProgress[]>();
const meta = new Map<string, JobMeta>();
const finishedAt = new Map<string, number>();
const inflight = new Set<string>();
const cancelFlags = new Set<string>();
const resumeStarted = new Set<string>();
let hydrated = false;
let hydration: Promise<void> | null = null;
let statePath = SHIFT_STATE;
let configPath = KANBAN_CONFIG;
let handoffLogPath = HANDOFF_LOG;
let stateWrites: Promise<void> = Promise.resolve();

/** Tests use temporary state, config and log files, without changing the real registration. */
export function setShiftStatePathForTests(path: string, paths?: { config: string; log: string }): void {
  statePath = path;
  configPath = paths?.config ?? KANBAN_CONFIG;
  handoffLogPath = paths?.log ?? HANDOFF_LOG;
}

/** Claim before any await. A second start for the same project gets false and must not run. */
export function claimShiftProject(project: string): boolean {
  if (inflight.has(project)) return false;
  inflight.add(project);
  return true;
}

export function releaseShiftProject(project: string): void {
  inflight.delete(project);
}

export function resetShiftClaimsForTests(): void {
  inflight.clear();
  tasks.clear();
  meta.clear();
  events.clear();
  eventOffsets.clear();
  finishedAt.clear();
  cancelFlags.clear();
  resumeStarted.clear();
  hydrated = false;
  hydration = null;
}

/** Plant a job without talking to Paseo. Tests use this to prove a second click does not start another queue. */
export function noteShiftForTests(job: ShiftProgress, options?: { inflight?: boolean; saved?: JobMeta; finishedAt?: number }): void {
  tasks.set(job.project, job);
  if (options?.inflight) inflight.add(job.project);
  if (options?.saved) meta.set(job.project, options.saved);
  if (typeof options?.finishedAt === "number") finishedAt.set(job.project, options.finishedAt);
}

export function currentShiftJobs(now = Date.now()): ShiftProgress[] {
  const rows: ShiftProgress[] = [];
  for (const [project, job] of tasks) {
    if (job.phase === "done") {
      const at = finishedAt.get(project) ?? now;
      if (!finishedAt.has(project)) finishedAt.set(project, at);
      if (now - at >= SHIFT_DONE_HOLD_MS) {
        tasks.delete(project);
        finishedAt.delete(project);
        meta.delete(project);
        continue;
      }
    }
    rows.push(job);
  }
  return rows;
}

async function readLogText(): Promise<string> {
  return readFile(handoffLogPath, "utf8").catch(() => "");
}

export async function readHandoffs(limit = 10): Promise<HandoffLogLine[]> {
  return parseHandoffs(await readLogText(), limit);
}

async function appendHandoff(line: HandoffLogLine): Promise<void> {
  await mkdir(dirname(handoffLogPath), { recursive: true });
  await appendFile(handoffLogPath, `${serializeHandoff(line)}\n`, "utf8");
}

export async function readHandoverFile(cwd: string): Promise<{ path: string; preview: string; summary: string } | null> {
  if (!cwd) return null;
  const statusPath = join(cwd, "docs", "STATUS.md");
  const handoverPath = join(cwd, "HANDOVER.md");
  const status = await readFile(statusPath, "utf8").catch(() => null);
  if (status !== null) {
    return { path: relative(cwd, statusPath) || "docs/STATUS.md", preview: handoverPreview(status, HANDOVER_PREVIEW_LINES), summary: handoverSummary(status) };
  }
  const handover = await readFile(handoverPath, "utf8").catch(() => null);
  if (handover !== null) {
    return { path: "HANDOVER.md", preview: handoverPreview(handover, HANDOVER_PREVIEW_LINES), summary: handoverSummary(handover) };
  }
  return null;
}

async function refreshTokens(paseo: PaseoApi, id: string): Promise<number | null> {
  const handle = paseo.agents.ref(id);
  await handle.refresh();
  const tokens = handle.lastUsage?.contextWindowUsedTokens;
  return typeof tokens === "number" && Number.isFinite(tokens) ? tokens : null;
}

async function sessionHits(sinceMs: number): Promise<Array<{ sessionId: string; hour: number; usd: number }>> {
  const plans = await readJson<{ prices?: Record<string, Json> }>(PLANS, {});
  const overrides = plans.prices ?? {};
  const memo = new Map<string, Awaited<ReturnType<typeof priceFor>>>();
  const priceOf = async (provider: string, model: string) => {
    const key = `${provider}|${model}`;
    const cachedPrice = memo.get(key);
    if (cachedPrice !== undefined) return cachedPrice;
    const price = await priceFor(provider, model, overrides).catch(() => null);
    memo.set(key, price);
    return price;
  };
  const hits: Array<{ sessionId: string; hour: number; usd: number }> = [];
  const banned = readBannedProviders();
  const consume = async (sessionId: string, buckets: Record<string, number[]>) => {
    for (const [key, bucket] of Object.entries(buckets)) {
      if (!Array.isArray(bucket)) continue;
      const [hour, provider, model, long] = key.split("|");
      const ms = Date.parse(`${hour}:00:00.000Z`);
      if (!hour || Number.isNaN(ms) || ms < sinceMs) continue;
      if (providerBanned({ provider, model }, banned)) continue;
      const price = await priceOf(provider ?? "", model ?? "");
      const rates = price
        ? { input: price.input, output: price.output, cacheRead: price.cacheRead, cacheWrite: price.cacheWrite, long: price.long }
        : null;
      const usd = publicPriceUsd(bucket, long === "1", rates);
      if (usd === null) continue;
      hits.push({ sessionId, hour: ms, usd });
    }
  };
  const text = await readFile(SCAN, "utf8").catch(() => "");
  if (text) {
    try {
      const parsed = JSON.parse(text) as { files?: Record<string, { provider?: string; sessionId?: string; b?: Record<string, number[]> }> };
      for (const file of Object.values(parsed.files ?? {})) {
        if (!file?.b || !file.sessionId) continue;
        if (providerBanned(file, banned)) continue;
        await consume(file.sessionId, file.b);
      }
    } catch {
      // A broken cache leaves today's amount blank.
    }
  }
  for (const row of await ledgerBuckets().catch(() => [])) await consume(row.sessionId, row.b);
  return hits;
}

async function todayByAgent(records: AgentRecord[], now: number): Promise<Map<string, number>> {
  return cached(`supervisor-today-usd:${readBannedProviders().join("|")}`, 60_000, async () => {
    const hits = await sessionHits(tokyoDayStart(now));
    const out = new Map<string, number>();
    for (const rec of records) {
      const ids = [rec.id, rec.sessionId ?? ""].filter(Boolean);
      const usd = sumTodayUsd(hits, ids, now);
      if (usd !== null && usd > 0) out.set(rec.id, usd);
    }
    return out;
  });
}

export async function readSupervisorPanel(
  paseo: PaseoApi | null,
  live: LiveBit[],
  records: AgentRecord[],
  now: number,
): Promise<SupervisorPanel> {
  const thresholds = readLeaderThresholds();
  try {
    // Shifts belong to Kanban's leader registry: without Kanban there are no rows to shift and no queue to resume.
    // Saved tasks stay listed so a leftover queue can still be cancelled.
    if (shiftsOff()) {
      const tasks = currentShiftJobs().map((job) => ({ ...job, canContinue: false }));
      return { ...EMPTY_SUPERVISOR_PANEL, thresholds, tasks, handoffs: await readHandoffs(10) };
    }
    const config = await readJson<Json>(configPath, {});
    const slots = visibleSupervisorSlots(config);
    const recordById = new Map(records.map((rec) => [rec.id, rec]));
    const liveById = new Map(live.map((row) => [row.id, row]));
    const usd = await todayByAgent(records, now).catch(() => new Map<string, number>());
    const agents: SupervisorAgentView[] = [];
    for (const slot of slots) {
      const rec = recordById.get(slot.agentId);
      const seen = liveById.get(slot.agentId);
      let tokens = seen?.contextTokens ?? null;
      if (tokens === null && paseo) {
        tokens = await cached(`supervisor-tokens:${slot.agentId}`, 30_000, () => refreshTokens(paseo, slot.agentId)).catch(() => null);
      }
      const cwd = rec?.cwd ?? "";
      const handover = cwd ? await readHandoverFile(cwd).catch(() => null) : null;
      const found = Boolean((seen && !seen.archivedAt) || (rec && !rec.archivedAt));
      agents.push({
        id: slot.agentId,
        status: seen?.status ?? rec?.status ?? "unknown",
        createdAt: seen?.createdAt ?? rec?.createdAt ?? null,
        contextTokens: tokens,
        handoverPath: handover?.path ?? null,
        handoverPreview: handover?.preview ?? null,
        found,
      });
    }
    const todayUsd: Record<string, number | null> = {};
    for (const [id, value] of usd) todayUsd[id] = value;
    await hydrateShiftJobs();
    if (paseo) scheduleQueueResume(paseo);
    return {
      thresholds,
      rows: markProxies(buildSupervisorRows({
        slots, agents, todayUsd, now, thresholds,
        acceptanceByProject: Object.fromEntries(slots.map((slot) => [slot.project, readAcceptanceCards(slot.project)])),
      }), new Map(records.map((rec) => [rec.id, { title: rec.title, cwd: rec.cwd }]))),
      tasks: currentShiftJobs(),
      handoffs: await readHandoffs(10),
    };
  } catch (error) {
    console.error("[afc] supervisor panel:", String(error).slice(0, 200));
    return { ...EMPTY_SUPERVISOR_PANEL, thresholds, tasks: currentShiftJobs(), handoffs: await readHandoffs(10).catch(() => []) };
  }
}

export async function loadShiftAgent(paseo: PaseoApi, id: string): Promise<ShiftAgent | null> {
  const records = await readAgentRecords().catch(() => []);
  const rec = records.find((row) => row.id === id) ?? null;
  const handle = paseo.agents.ref(id);
  let snap: {
    status?: string;
    title?: string | null;
    workspaceId?: string;
    cwd?: string;
    provider?: string;
    model?: string | null;
    currentModeId?: string | null;
    thinkingOptionId?: string | null;
    labels?: Record<string, string>;
    createdAt?: string;
    lastUsage?: { contextWindowUsedTokens?: number };
  } | null = null;
  try {
    const refreshed = await handle.refresh();
    snap = refreshed?.agent ?? handle.current();
  } catch {
    snap = null;
  }
  if (!snap && !rec) return null;
  const tokens = snap?.lastUsage?.contextWindowUsedTokens;
  return {
    id,
    status: snap?.status ?? rec?.status ?? "unknown",
    title: snap?.title || rec?.title || "",
    workspaceId: snap?.workspaceId ?? rec?.workspaceId ?? null,
    cwd: snap?.cwd || rec?.cwd || "",
    provider: snap?.provider || rec?.provider || "",
    model: snap?.model || rec?.model || "",
    modeId: snap?.currentModeId ?? rec?.modeId ?? null,
    thinkingOptionId: snap?.thinkingOptionId ?? rec?.thinkingOptionId ?? null,
    featureValues: rec?.featureValues ?? {},
    labels: snap?.labels ?? rec?.labels ?? {},
    contextTokens: typeof tokens === "number" && Number.isFinite(tokens) ? tokens : null,
    pendingApproval: rec?.attentionReason === "permission",
  };
}

function permitAgentIds(raw: unknown): string[] {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as Json).items)
      ? ((raw as Json).items as unknown[])
      : raw && typeof raw === "object" && Array.isArray((raw as Json).requests)
        ? ((raw as Json).requests as unknown[])
        : null;
  if (!list) return [];
  const ids: string[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const id = String((item as Json).agentId ?? (item as Json).agent ?? "");
    if (id) ids.push(id);
  }
  return ids;
}

function sameAgent(left: string, right: string): boolean {
  if (left === right) return true;
  const short = left.length <= right.length ? left : right;
  const long = left.length <= right.length ? right : left;
  return short.length >= 8 && long.startsWith(short);
}

/** Pending approvals live in `paseo permit ls`. A failed read does not invent one. */
async function permitPending(agentId: string): Promise<boolean> {
  try {
    const ids = await cached("shift-permit-ids", 4_000, async () => {
      const raw = await runJson<unknown>(BIN.paseo, ["permit", "ls", "--json"], 8_000);
      return permitAgentIds(raw);
    });
    return ids.some((id) => sameAgent(id, agentId));
  } catch {
    return false;
  }
}

export function supervisorShiftPorts(paseo: PaseoApi, project: string, hasPermit = permitPending): ShiftPorts {
  return {
    now: () => Date.now(),
    cancelled: () => cancelFlags.has(project),
    getAgent: async (id) => {
      const agent = await loadShiftAgent(paseo, id);
      if (!agent || agent.pendingApproval || isBusy(agent.status)) return agent;
      const pending = await hasPermit(id);
      return pending ? { ...agent, pendingApproval: true } : agent;
    },
    sendAndWait: async (id, prompt, timeoutMs) => {
      const result = await paseo.agents.ref(id).run(prompt, { timeoutMs });
      return {
        timedOut: result.status === "timeout",
        reply: result.lastMessage,
        error: result.status === "error" ? (result.error ?? t("shift.server.oldSessionError")) : null,
      };
    },
    readHandover: (cwd) => readHandoverFile(cwd),
    readAcceptanceCards: async (project) => readAcceptanceCards(project),
    createAgent: async (input) => {
      // Same workspace only. This path does not call workspaces.create.
      const handle = await paseo.workspaces.ref(input.workspaceId).agents.create({
        idempotencyKey: input.idempotencyKey,
        labels: input.labels,
        title: input.title,
        prompt: input.prompt,
        config: {
          provider: providerModel(input.provider, input.model),
          ...(input.modeId ? { modeId: input.modeId } : {}),
          ...(input.thinkingOptionId ? { thinkingOptionId: input.thinkingOptionId } : {}),
          featureValues: input.featureValues,
        },
      });
      await handle.refresh().catch(() => null);
      const current = handle.current();
      return {
        id: handle.id,
        labels: current?.labels ?? {},
        workspaceId: handle.workspaceId ?? current?.workspaceId ?? input.workspaceId,
      };
    },
    detach: async (id) => {
      await paseo.agents.ref(id).detach();
    },
    archive: async (id) => {
      const handle = paseo.agents.ref(id);
      await handle.refresh();
      if (!handle.archivedAt) await handle.archive();
    },
    registeredSupervisor: async (project) => {
      const config = await readJson<Json>(configPath, {});
      const supers = config.supervisors;
      if (supers && typeof supers === "object" && !Array.isArray(supers)) {
        const id = (supers as Json)[project];
        if (typeof id === "string" && id.trim()) return id.trim();
      }
      if (project === kanbanProjectName() && typeof config.supervisorAgentId === "string") return config.supervisorAgentId.trim();
      return null;
    },
    latestReply: async (id) => {
      const handle = paseo.agents.ref(id);
      const result = await handle.waitForFinish(1_500);
      return result.lastMessage;
    },
  };
}

export const SHIFTS_OFF = "Kanban is not installed (kanban absent): leader shifts are off.";

/** Leader shifts need Kanban (its leader registry and cards); they are off while Kanban is absent. */
function shiftsOff(): boolean {
  return kanbanSource().presence === "absent";
}

function emptyJob(project: string, detail: string, code = ""): ShiftProgress {
  return {
    phase: "failed",
    label: phaseLabel("failed"),
    detail,
    project,
    code,
    oldId: "",
    newId: null,
    contextTokens: null,
    canContinue: false,
    canCancel: false,
    openAgentId: null,
  };
}

function storedResume(job: ShiftProgress, saved: JobMeta | undefined): ShiftResume {
  if (job.phase === "queued") return "queue";
  if (job.phase === "waiting" || job.phase === "detaching" || job.newId) return "wait";
  if (job.phase === "opening") return "open";
  if (saved?.resume === "open" || saved?.resume === "wait" || saved?.resume === "queue") return saved.resume === "queue" ? "start" : saved.resume;
  return "start";
}

async function persistActive(): Promise<void> {
  const rows: StoredShift[] = [];
  for (const job of tasks.values()) {
    if (job.phase === "done") continue;
    const saved = meta.get(job.project);
    rows.push({
      progress: job,
      creationKey: saved?.creationKey,
      events: events.get(job.project) ?? [],
      eventsOffset: eventOffsets.get(job.project) ?? 0,
      resume: storedResume(job, saved),
      queuedAt: saved?.queuedAt ?? null,
    });
  }
  // Progress callbacks can arrive before the previous write finishes. Keep their
  // snapshots in order so they neither share writeJson's .tmp file nor overwrite
  // the final newId/resume with an earlier step.
  const path = statePath;
  const snapshot = JSON.parse(serializeShiftState(rows));
  const write = stateWrites.catch(() => undefined).then(async () => {
    if (rows.length === 0) await unlink(path).catch(() => undefined);
    else await writeJson(path, snapshot);
  });
  stateWrites = write;
  await write;
}

/** Read the state file once per process. Safe to call from tests with another path. */
export async function hydrateShiftJobsFrom(path: string): Promise<ShiftProgress[]> {
  const text = await readFile(path, "utf8").catch(() => "");
  for (const row of restoreShiftForDisplay(parseShiftState(text))) {
    if (tasks.has(row.progress.project)) continue;
    tasks.set(row.progress.project, row.progress);
    events.set(row.progress.project, row.events ?? []);
    eventOffsets.set(row.progress.project, row.eventsOffset ?? 0);
    meta.set(row.progress.project, { creationKey: row.creationKey, oldId: row.progress.oldId || undefined, resume: row.resume, newId: row.progress.newId, queuedAt: row.queuedAt });
  }
  return currentShiftJobs();
}

export async function hydrateShiftJobs(): Promise<void> {
  if (hydrated) return;
  hydration ??= hydrateShiftJobsFrom(statePath).then(() => { hydrated = true; });
  try { await hydration; } finally { hydration = null; }
}

function scheduleQueueResume(paseo: PaseoApi): void {
  // Not marked as started: a queue left while Kanban is absent resumes once Kanban is back.
  if (shiftsOff()) return;
  const removed = readRemovedProjects();
  for (const job of tasks.values()) {
    if (job.phase !== "queued") continue;
    if (resumeStarted.has(job.project) || inflight.has(job.project)) continue;
    if (removed.has(job.project)) continue;
    resumeStarted.add(job.project);
    void requestSupervisorShift(paseo, job.project, "continue").catch((error) => {
      console.error("[afc] supervisor queue resume:", String(error).slice(0, 160));
    });
  }
}

export async function requestSupervisorShift(
  paseo: PaseoApi,
  project: string,
  action: "start" | "continue" | "cancel",
  /** Offline tests supply mock ports; normal callers use the Paseo adapter. */
  ports?: ShiftPorts,
): Promise<ShiftProgress> {
  await hydrateShiftJobs();
  if (action === "cancel") {
    cancelFlags.add(project);
    const existing = tasks.get(project);
    if (!inflight.has(project)) {
      tasks.delete(project);
      meta.delete(project);
      await persistActive().catch(() => undefined);
      return {
        phase: "failed",
        label: cancelledLabel(),
        detail: t("shift.detail.cancelled"),
        project,
        code: existing?.code ?? "",
        oldId: existing?.oldId ?? "",
        newId: existing?.newId ?? null,
        contextTokens: existing?.contextTokens ?? null,
        canContinue: false,
        canCancel: false,
        openAgentId: null,
      };
    }
    return existing
      ? { ...existing, detail: t("shift.server.cancellingAfterCheck"), canCancel: false }
      : emptyJob(project, t("shift.server.cancelling"));
  }
  if (shiftsOff()) {
    // Start and continue need Kanban; nothing is sent, created or archived. Cancel above still works.
    const existing = tasks.get(project);
    return existing ? { ...existing, detail: SHIFTS_OFF, canContinue: false } : emptyJob(project, SHIFTS_OFF);
  }
  if (!claimShiftProject(project)) {
    const existing = tasks.get(project);
    if (existing) return { ...existing, detail: t("shift.server.alreadyRunning") };
    return {
      phase: "handover",
      label: phaseLabel("handover"),
      detail: t("shift.server.alreadyRunning"),
      project,
      code: "",
      oldId: "",
      newId: null,
      contextTokens: null,
      canContinue: false,
      canCancel: false,
      openAgentId: null,
    };
  }
  let handedOff = false;
  try {
  const open = tasks.get(project);
  if (action === "start" && open && shiftOpen(open.phase)) {
    return { ...open, detail: t("shift.server.alreadyRunning") };
  }
  const config = await readJson<Json>(configPath, {});
  const slot = supervisorSlots(config, kanbanProjectName()).find((row) => row.project === project);
  if (!slot) return emptyJob(project, t("shift.server.notRegistered"), project);
  // A leader of a project that left Paseo is never asked to hand over, and nothing new is created for it.
  if (readRemovedProjects().has(project)) return emptyJob(project, t("shift.server.removed"), slot.code);
  const existing = tasks.get(project);
  const saved = meta.get(project);
  if (action === "continue") {
    const allowed = Boolean(existing && (existing.canContinue || shiftOpen(existing.phase)));
    if (!allowed || !saved) {
      return existing ?? emptyJob(project, t("shift.server.nothingToContinue"), slot.code);
    }
  }
  cancelFlags.delete(project);
  if (action === "start") { events.set(project, []); eventOffsets.set(project, 0); }
  const recordEvent = (row: ShiftProgress) => {
    const history = events.get(project) ?? [];
    const key = (item: ShiftProgress | undefined) => item ? [item.phase, item.step, item.detail, item.oldId, item.newId].join("|") : "";
    if (key(history.at(-1)) !== key(row)) history.push(row);
    eventOffsets.set(project, (eventOffsets.get(project) ?? 0) + Math.max(0, history.length - 40));
    events.set(project, history.slice(-40));
  };
  const resume = action === "continue" && saved?.resume === "open" ? "open" : action === "continue" && saved?.resume === "wait" ? "wait" : "start";
  const existingNewId = action === "continue" && saved ? saved.newId : null;
  const existingOldId = action === "continue" ? saved?.oldId || slot.agentId : slot.agentId;
  // A queue saved before the upgrade can name no old session while the registry already points at the new one.
  const oldId = action === "continue" && existingNewId && existingOldId === existingNewId
    ? recoverOldId({ code: slot.code, newId: existingNewId, queueOldId: saved?.oldId, handoffs: parseHandoffs(await readLogText(), Number.MAX_SAFE_INTEGER) }) ?? existingOldId
    : existingOldId;
  const creationKey = action === "continue" ? saved?.creationKey ?? `afc-leader-swap:${slot.project}:${oldId}` : `afc-leader-swap:${randomUUID()}`;
  const queuedAt = queueStartedAt(action, saved, Date.now());
  meta.set(project, { creationKey, oldId, resume: saved?.resume === "queue" ? "queue" : resume, newId: existingNewId, queuedAt });
  const starting: ShiftProgress = {
    phase: "handover",
    label: phaseLabel("handover"),
    detail: t("shift.server.checkingBusy"),
    project: slot.project,
    code: slot.code,
    oldId,
    newId: existingNewId,
    contextTokens: null,
    canContinue: false,
    canCancel: false,
    openAgentId: null,
  };
  handedOff = true;
  let announced: ShiftProgress | null = null;
  let releaseGate = () => {};
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  const run = runSupervisorShift(
    { clicked: true, project: slot.project, code: slot.code, agentId: oldId, resume, existingNewId, queuedAt, creationKey },
    { ...(ports ?? supervisorShiftPorts(paseo, project)), checkpoint: async row => {
      await ports?.checkpoint?.(row);
      await persistActive();
    } },
    (row) => {
      tasks.set(project, row);
      recordEvent(row);
      if (row.phase === "queued") meta.set(project, { creationKey, oldId, resume: "queue", newId: null, queuedAt });
      else if (row.newId) meta.set(project, { creationKey, oldId, resume: "wait", newId: row.newId, queuedAt: null });
      if (!announced) {
        announced = row;
        releaseGate();
      }
    },
  ).then(async (outcome) => {
    cancelFlags.delete(project);
    if (isCancelledLabel(outcome.result)) {
      tasks.delete(project);
      meta.delete(project);
    } else {
      tasks.set(project, outcome.progress);
      recordEvent(outcome.progress);
      if (outcome.progress.phase === "done") finishedAt.set(project, Date.now());
      else finishedAt.delete(project);
      if (outcome.resumeNext) meta.set(project, { creationKey, oldId, resume: outcome.resumeNext, newId: outcome.progress.newId, queuedAt: null });
      else if (outcome.progress.canContinue) meta.set(project, { creationKey, oldId, resume: "start", newId: null, queuedAt: null });
      else meta.delete(project);
    }
    await persistActive();
    if (isCancelledLabel(outcome.result)) return;
    await appendHandoff({
      at: new Date().toISOString(),
      project: slot.code,
      oldId: outcome.progress.oldId,
      newId: outcome.progress.newId,
      contextTokens: outcome.progress.contextTokens,
      result: outcome.result,
    });
  }).catch(async (error) => {
    const latest = tasks.get(project) ?? starting;
    const failed: ShiftProgress = {
      step: latest.step,
      phase: "failed",
      label: phaseLabel("failed"),
      detail: t("shift.server.interrupted", { error: String(error).slice(0, 160) }),
      project: slot.project,
      code: slot.code,
      oldId,
      newId: latest.newId,
      contextTokens: latest.contextTokens,
      canContinue: true,
      canCancel: false,
      openAgentId: null,
    };
    meta.set(project, { creationKey, oldId, resume: latest.newId ? "wait" : latest.phase === "opening" ? "open" : "start", newId: latest.newId, queuedAt: null });
    tasks.set(project, failed);
    recordEvent(failed);
    await persistActive().catch(() => undefined);
    await appendHandoff({
      at: new Date().toISOString(),
      project: slot.code,
      oldId,
      newId: latest.newId,
      contextTokens: null,
      result: failed.detail,
    }).catch(() => undefined);
  }).finally(() => {
    releaseShiftProject(project);
    releaseGate();
  });
  void run;
  let announceTimer: ReturnType<typeof setTimeout> | undefined;
  const first = await Promise.race([
    gate.then(() => announced),
    new Promise<null>((resolve) => {
      announceTimer = setTimeout(() => resolve(null), 1_500);
    }),
  ]);
  clearTimeout(announceTimer);
  return first ?? tasks.get(project) ?? starting;
  } finally {
    if (!handedOff) releaseShiftProject(project);
  }
}

/** Read-only inspection never resumes a queue or mutates disk state. */
export async function inspectSupervisorShift(project: string) {
  await hydrateShiftJobs();
  const config = await readJson<Json>(configPath, {});
  const slot = supervisorSlots(config, kanbanProjectName()).find(row => row.project === project || row.code.toLowerCase() === project.toLowerCase());
  const job = slot ? currentShiftJobs().find(row => row.project === slot.project) ?? null : null;
  return { slot: slot ?? null, job, running: slot ? inflight.has(slot.project) : false, available: !shiftsOff(), eventsOffset: slot ? eventOffsets.get(slot.project) ?? 0 : 0, events: slot ? events.get(slot.project) ?? [] : [] };
}
