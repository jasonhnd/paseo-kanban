/** Thresholds for the decision list. Pure helpers; no file or network access. */
import { t, tAll } from "./i18n";

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Open items at least this old get one reminder, including blocking items. */
export const REMIND_AFTER_MS = 3 * DAY_MS;

/** Non-blocking open items at least this old are shelved. Blocking items are never shelved. */
export const SHELVE_AFTER_MS = 7 * DAY_MS;

/** Non-blocking items older than this are marked "may be stale". Strictly greater than 3 days. */
export const MAYBE_STALE_AFTER_MS = 3 * DAY_MS;

/** Supervisor decisions newer than this stay in "decided for you (can be overturned)". */
export const SUPERVISOR_WINDOW_MS = 7 * DAY_MS;

export const DECISION_TOP_N = 5;

/** First maintenance pass after the plugin loads, then once a day. */
export const MAINT_FIRST_DELAY_MS = 5 * 60 * 1000;
export const MAINT_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Note on an item the daily pass shelved. bin/roles also gets `--as shelved`, so any language classifies right. */
export function autoShelveNote(): string {
  return t("decisions.maint.autoShelveNote");
}

export interface OpenDecision {
  id: string;
  project: string;
  title: string;
  detail: string;
  blocking: boolean;
  source: string;
  createdAt: string;
  agentId: string | null;
}

export interface DecisionGroup<T extends OpenDecision = OpenDecision> {
  project: string;
  items: T[];
}

export interface GroupedDecisions<T extends OpenDecision = OpenDecision> {
  top: T[];
  rest: DecisionGroup<T>[];
}

export interface SupervisorDecision {
  id: string;
  project: string;
  title: string;
  note: string;
  decidedAt: string;
}

/** Loose record so writers keep fields they do not understand. */
export type DecisionRecord = Record<string, unknown> & { id?: string };

/** One decision's line. A daily pass merges lines for the same leader into one send. */
export interface MaintNotice {
  agentId: string;
  text: string;
  kind?: "remind" | "shelve";
  id?: string;
  project?: string;
  title?: string;
  days?: number;
  blocking?: boolean;
}

export interface MaintState {
  enabled: boolean;
  reminded: Record<string, string>;
  lastRunDay?: string;
  pendingNotifications?: MaintNotice[];
}

export function ageMs(iso: string | null | undefined, now: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return now - t;
}

export function hangingDays(iso: string | null | undefined, now: number): number | null {
  const age = ageMs(iso, now);
  if (age === null) return null;
  if (age < 0) return 0;
  return Math.floor(age / DAY_MS);
}

export function hangingLabel(iso: string | null | undefined, now: number): string {
  const days = hangingDays(iso, now);
  if (days === null) return t("decisions.hanging.unknown");
  if (days <= 0) return t("decisions.hanging.underDay");
  return t("decisions.hanging.days", { days });
}

export function maybeStale(item: { blocking: boolean; createdAt: string }, now: number): boolean {
  if (item.blocking) return false;
  const age = ageMs(item.createdAt, now);
  return age !== null && age > MAYBE_STALE_AFTER_MS;
}

function compareOpen(a: OpenDecision, b: OpenDecision, now: number): number {
  if (a.blocking !== b.blocking) return a.blocking ? -1 : 1;
  const ageA = ageMs(a.createdAt, now) ?? -1;
  const ageB = ageMs(b.createdAt, now) ?? -1;
  if (ageB !== ageA) return ageB - ageA;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Top band is at most 5: blocking first, then longest wait. The rest fold by project. */
export function groupOpenDecisions<T extends OpenDecision>(items: readonly T[], now: number): GroupedDecisions<T> {
  const sorted = [...items].sort((a, b) => compareOpen(a, b, now));
  const top = sorted.slice(0, DECISION_TOP_N);
  const topIds = new Set(top.map((item) => item.id));
  const map = new Map<string, T[]>();
  for (const item of sorted) {
    if (topIds.has(item.id)) continue;
    const list = map.get(item.project) ?? [];
    list.push(item);
    map.set(item.project, list);
  }
  const rest = [...map.entries()]
    .map(([project, group]) => ({ project, items: group }))
    .sort((a, b) => {
      const blockA = a.items.filter((item) => item.blocking).length;
      const blockB = b.items.filter((item) => item.blocking).length;
      if (blockB !== blockA) return blockB - blockA;
      if (b.items.length !== a.items.length) return b.items.length - a.items.length;
      return a.project < b.project ? -1 : a.project > b.project ? 1 : 0;
    });
  return { top, rest };
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Supervisor rows from the last 7 days, newest first. `decidedAt` is when it was recorded. */
export function recentSupervisorDecisions(items: readonly DecisionRecord[], now: number): SupervisorDecision[] {
  const rows: SupervisorDecision[] = [];
  for (const item of items) {
    if (item.status !== "supervisor") continue;
    const decidedAt = text(item.doneAt) || text(item.createdAt);
    const age = ageMs(decidedAt, now);
    if (age === null || age < 0 || age > SUPERVISOR_WINDOW_MS) continue;
    rows.push({
      id: text(item.id),
      project: text(item.project),
      title: text(item.title),
      note: text(item.note) || text(item.detail),
      decidedAt,
    });
  }
  rows.sort((a, b) => (a.decidedAt < b.decidedAt ? 1 : a.decidedAt > b.decidedAt ? -1 : a.id < b.id ? -1 : 1));
  return rows;
}

export function normalizeMaintState(raw: unknown): MaintState {
  const reminded: Record<string, string> = {};
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const bag = (raw as { reminded?: unknown }).reminded;
    if (bag && typeof bag === "object" && !Array.isArray(bag)) {
      for (const [id, value] of Object.entries(bag as Record<string, unknown>)) {
        if (typeof value === "string" && value) reminded[id] = value;
      }
    }
  }
  const enabled = !(raw && typeof raw === "object" && (raw as { enabled?: unknown }).enabled === false);
  const data = raw as Partial<MaintState> | null;
  const lastRunDay = typeof data?.lastRunDay === "string" ? data.lastRunDay : undefined;
  const pendingNotifications = Array.isArray(data?.pendingNotifications)
    ? data.pendingNotifications.map(normalizeNotice).filter((row): row is MaintNotice => row !== null) : [];
  return { enabled, reminded, lastRunDay, pendingNotifications };
}

function normalizeNotice(row: unknown): MaintNotice | null {
  if (!row || typeof row !== "object") return null;
  const data = row as Record<string, unknown>;
  if (typeof data.agentId !== "string" || !data.agentId || typeof data.text !== "string") return null;
  const notice: MaintNotice = { agentId: data.agentId, text: data.text };
  if (data.kind === "remind" || data.kind === "shelve") notice.kind = data.kind;
  if (typeof data.id === "string" && data.id) notice.id = data.id;
  if (typeof data.project === "string") notice.project = data.project;
  if (typeof data.title === "string") notice.title = data.title;
  if (typeof data.days === "number" && Number.isFinite(data.days)) notice.days = data.days;
  if (data.blocking === true) notice.blocking = true;
  return notice;
}

export function readSupervisorTable(config: unknown): Record<string, string> | null {
  if (!config || typeof config !== "object" || Array.isArray(config)) return null;
  const sup = (config as { supervisors?: unknown }).supervisors;
  if (!sup || typeof sup !== "object" || Array.isArray(sup)) return null;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(sup as Record<string, unknown>)) {
    if (typeof value === "string" && value.trim()) out[key] = value.trim();
  }
  return out;
}

export function supervisorIdFor(project: string, table: Record<string, string> | null): string | null {
  if (!table) return null;
  if (Object.hasOwn(table, project) && table[project]) return table[project];
  const low = project.toLowerCase();
  for (const [key, value] of Object.entries(table)) {
    if (key.toLowerCase() === low && value) return value;
  }
  return null;
}

/** Registration, rather than the item's author, determines who owns an open question. */
export function decisionOwner(project: string, table: Record<string, string> | null): {
  owner: string; delegated: boolean; leaderMissing: boolean; agentId: string | null;
} {
  const registered = supervisorIdFor(project, table);
  return registered
    ? { owner: `${project} <leader>`, delegated: false, leaderMissing: false, agentId: registered }
    : { owner: noLeaderLabel(), delegated: false, leaderMissing: true, agentId: null };
}

/** Owner label of a project without a <leader>. */
export function noLeaderLabel(): string {
  return t("decisions.owner.none");
}

/** True for the no-<leader> owner label in any language: ours, or the one bin/roles writes (cli.roles.ownerNone). */
export function isNoLeaderOwner(owner: string | null | undefined): boolean {
  return typeof owner === "string" && [...tAll("decisions.owner.none"), ...tAll("cli.roles.ownerNone")].includes(owner);
}

/** Non-letter answers the panel sends with a decide-reply. */
export const REPLY_CHOICE = { shelve: "shelve", askOptions: "askOptions", comment: "comment", dismiss: "dismiss", restore: "restore" } as const;

export interface MaintAction {
  kind: "remind" | "shelve";
  id: string;
  project: string;
  title: string;
  days: number;
  supervisorId: string | null;
  blocking: boolean;
}

export function planMaintenance(
  items: readonly DecisionRecord[],
  state: MaintState,
  now: number,
  supervisors: Record<string, string> | null,
): MaintAction[] {
  const actions: MaintAction[] = [];
  for (const item of items) {
    if (item.status !== "open") continue;
    const id = text(item.id);
    if (!id) continue;
    const createdAt = text(item.createdAt);
    const age = ageMs(createdAt, now);
    if (age === null || age < REMIND_AFTER_MS) continue;
    const project = text(item.project);
    const title = text(item.title);
    const days = Math.floor(age / DAY_MS);
    const supervisorId = decisionOwner(project, supervisors).agentId;
    const blocking = item.blocking === true;
    if (age >= SHELVE_AFTER_MS && !blocking) {
      actions.push({ kind: "shelve", id, project, title, days, supervisorId, blocking });
      continue;
    }
    if (!state.reminded[id]) {
      actions.push({ kind: "remind", id, project, title, days, supervisorId, blocking });
    }
  }
  return actions;
}

/** One line. The blocking sentence is only on a row that is actually blocking. */
export function remindMessage(action: Pick<MaintAction, "id" | "project" | "title" | "days" | "blocking">): string {
  const line = t("decisions.maint.remindLine", { id: action.id, project: action.project, title: action.title, days: action.days });
  return action.blocking ? t("decisions.maint.remindBlocking", { line }) : line;
}

export function shelveMessage(action: Pick<MaintAction, "id" | "project" | "title" | "days">): string {
  return t("decisions.maint.shelveLine", { id: action.id, project: action.project, title: action.title, days: action.days, note: autoShelveNote() });
}

/** 3-day reminders and 7-day shelve notices for one leader, as a single message. */
export function leaderDigest(rows: readonly MaintNotice[]): string {
  const counted = rows.filter((row) => row.kind === "remind" || row.kind === "shelve");
  const lines = rows.map((row) => row.text);
  if (counted.length === 0) return lines.join("\n");
  const reminds = counted.filter((row) => row.kind === "remind").length;
  const shelves = counted.filter((row) => row.kind === "shelve").length;
  const head = t("decisions.maint.digestHead", { reminds, shelves });
  return [head, ...lines].join("\n");
}

function noticeFor(action: MaintAction, text: string): MaintNotice {
  return {
    agentId: action.supervisorId ?? "",
    text,
    kind: action.kind,
    id: action.id,
    project: action.project,
    title: action.title,
    days: action.days,
    blocking: action.blocking,
  };
}

export function overturnNotice(project: string, title: string, detail: string): string {
  const body = detail.trim() || title;
  return t("decisions.overturn.notice", { project, title, body });
}

export interface MaintResult {
  items: DecisionRecord[];
  state: MaintState;
  logs: string[];
  messages: MaintNotice[];
  itemsChanged: boolean;
  stateChanged: boolean;
}

function logLine(at: string, verb: string, action: MaintAction): string {
  const who = action.supervisorId ?? "unregistered";
  return `${at}\t${verb}\t${action.id}\t${action.project}\topen ${action.days}d\t<leader> ${who}\t${action.title}`;
}

/**
 * Decide what the daily pass would do.
 * When `enabled` is false, only log "would …": no list edits, no reminders, no remembered ids.
 */
export function applyMaintenance(args: {
  items: readonly DecisionRecord[];
  state: MaintState;
  nowIso: string;
  actions: readonly MaintAction[];
  enabled: boolean;
}): MaintResult {
  const items = args.items.map((item) => ({ ...item }));
  const byId = new Map(items.map((item) => [text(item.id), item]));
  const state: MaintState = { ...args.state, reminded: { ...args.state.reminded } };
  const logs: string[] = [];
  const messages: MaintNotice[] = [];
  let itemsChanged = false;
  let stateChanged = false;
  for (const action of args.actions) {
    if (!args.enabled) {
      logs.push(logLine(args.nowIso, action.kind === "remind" ? "would remind" : "would shelve", action));
      continue;
    }
    if (action.kind === "shelve") {
      const item = byId.get(action.id);
      if (!item || item.status !== "open" || item.blocking === true) continue;
      item.status = "shelved";
      item.doneAt = args.nowIso;
      item.note = autoShelveNote();
      itemsChanged = true;
      logs.push(logLine(args.nowIso, "shelved", action));
      if (action.supervisorId) messages.push(noticeFor(action, shelveMessage(action)));
      else logs.push(logLine(args.nowIso, "shelved, not notified (project has no <leader>)", action));
      continue;
    }
    if (!action.supervisorId) {
      logs.push(logLine(args.nowIso, "not reminded (no registered <leader>)", action));
      continue;
    }
    state.reminded[action.id] = args.nowIso;
    stateChanged = true;
    messages.push(noticeFor(action, remindMessage(action)));
    logs.push(logLine(args.nowIso, "reminded", action));
  }
  return { items, state, logs, messages, itemsChanged, stateChanged };
}
