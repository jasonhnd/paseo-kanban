/// <reference types="node" />
// Classify unfinished Kanban cards that are waiting or stuck, and decide which ones to alarm.
import { withoutPaused } from "../../shared/fleet/paused";
import { t, tAll, type MessageKey } from "../../shared/fleet/i18n";
// Reading the database stays in kanban.ts. This file is pure so the rules can be tested without kanban.db.

/** Waiting for the folder, for a slot, unattended, other, or acceptance: alarm after this long in the current status. */
export const QUEUE_WAIT_ALERT_MINUTES = 30;

/** Running or reviewing while the agent has been idle, closed or errored this long counts as stuck. Classification and alarm share it. */
export const QUEUE_AGENT_IDLE_MINUTES = 15;

/** The overview's waiting-cards list shows at most this many rows, longest wait first. */
export const QUEUE_VISIBLE_LIMIT = 15;

/** Overview titles are cut to this many characters. */
export const QUEUE_TITLE_LIMIT = 36;

const AGENT_IDLE_STATUSES = new Set(["idle", "closed", "error"]);

/** These kinds alarm once their time in the current status passes QUEUE_WAIT_ALERT_MINUTES. Auto-start off and waiting on parents do not. */
const TIMED_ALERT_KINDS = new Set<WaitKind>(["waitDir", "waitSlot", "unattended", "other", "acceptance"]);

/** Why a card waits. Stable codes; the shown label is `queue.category.<kind>` in the current language. */
export type WaitKind =
  | "waitParent"
  | "waitSlot"
  | "waitDir"
  | "autoStartOff"
  | "unattended"
  | "acceptance"
  | "agentIdle"
  | "other";

/** The shown category label (current language). */
export type WaitCategory = string;

export function waitCategoryLabel(kind: WaitKind): WaitCategory {
  return t(`queue.category.${kind}`);
}

export interface QueueTask {
  id: number;
  /** Display number (`DEMO_0022` or `#111`). Absent on hand-built fixtures; those fall back to `#<id>`. */
  code?: string;
  project: string;
  title: string;
  status: string;
  role: string;
  holdReason: string | null;
  cooldownUntil: string | null;
  agentId: string | null;
  blockedKind: string | null;
  unattendedAt: string | null;
  /** Latest events.at whose to_status equals the card's current status. */
  statusSince: string | null;
  parentIds: number[];
}

/** Paseo agent record fields this classifier needs. `records.ts` already loads them. */
export interface QueueAgent {
  status: string;
  lastActivityAt: string | null;
}

export interface WaitingCard {
  id: number;
  /** `DEMO_0022`, or `#<id>` when the project has no short code or the card has no code_seq. */
  code: string;
  project: string;
  title: string;
  waitKind: WaitKind;
  category: WaitCategory;
  /** Original hold_reason when there is one; otherwise a short fallback so the cell is not blank. */
  reason: string;
  waitedMinutes: number | null;
  agentIdleMinutes: number | null;
  agentId: string | null;
  parentIds: number[];
}

export interface QueueAlert {
  cardId: number;
  level: "red" | "yellow";
  kind: string;
  text: string;
  agentId: string | null;
}

export interface QueueRow {
  id: number;
  code: string;
  project: string;
  title: string;
  waitKind: WaitKind;
  category: WaitCategory;
  reason: string;
  waitedLabel: string;
  agentId: string | null;
  alarming: boolean;
}

export function minutesSinceIso(iso: string | null | undefined, nowMs: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return (nowMs - t) / 60_000;
}

export function formatWaited(minutes: number | null): string {
  if (minutes === null || minutes < 0) return t("queue.waited.unknown");
  if (minutes < 1) return t("queue.waited.underMinute");
  const total = Math.floor(minutes);
  const days = Math.floor(total / 1440);
  const hours = Math.floor((total % 1440) / 60);
  const mins = total % 60;
  if (days > 0) return hours > 0 ? t("queue.waited.daysHours", { days, hours }) : t("queue.waited.days", { days });
  if (hours > 0) return mins > 0 ? t("queue.waited.hoursMinutes", { hours, mins }) : t("queue.waited.hours", { hours });
  return t("queue.waited.minutes", { mins });
}

export function shortTitle(title: string, limit = QUEUE_TITLE_LIMIT): string {
  const text = title.replace(/\s+/g, " ").trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}…`;
}

function clip(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= limit) return flat;
  return `${flat.slice(0, limit)}…`;
}

function reasonOf(task: QueueTask): string {
  return task.holdReason?.trim() ?? "";
}

/** Kanban writes hold reasons in its own language; match every language's token. */
function holdHas(reason: string, key: MessageKey): boolean {
  return tAll(key).some((token) => reason.includes(token));
}

function cooldownPending(until: string | null, nowMs: number): boolean {
  if (!until) return false;
  const t = Date.parse(until);
  return !Number.isNaN(t) && t > nowMs;
}

function agentIdleMinutes(agent: QueueAgent | undefined, nowMs: number): number | null {
  if (!agent) return null;
  if (!AGENT_IDLE_STATUSES.has(agent.status.trim().toLowerCase())) return null;
  const idle = minutesSinceIso(agent.lastActivityAt, nowMs);
  if (idle === null || idle <= QUEUE_AGENT_IDLE_MINUTES) return null;
  return idle;
}

/**
 * First match wins, in the order the overview brief lists the categories.
 * Returns null when the card is not waiting and not stuck (for example a running card whose agent is still working).
 */
export function classifyWait(task: QueueTask, agent: QueueAgent | undefined, nowMs: number): WaitingCard | null {
  if (task.status === "done" || task.status === "archived") return null;
  const reason = reasonOf(task);
  const waitedMinutes = minutesSinceIso(task.statusSince, nowMs);
  const idle = agentIdleMinutes(agent, nowMs);

  const classified = classifyKind(task, reason, idle, nowMs);
  if (!classified) return null;
  const { kind, shown } = classified;
  return {
    id: task.id,
    code: task.code?.trim() || `#${task.id}`,
    project: task.project,
    title: task.title,
    waitKind: kind,
    category: waitCategoryLabel(kind),
    reason: shown,
    waitedMinutes,
    agentIdleMinutes: kind === "agentIdle" ? idle : null,
    agentId: task.agentId,
    parentIds: task.parentIds,
  };
}

function classifyKind(task: QueueTask, reason: string, idle: number | null, nowMs: number): { kind: WaitKind; shown: string } | null {
  if (holdHas(reason, "queue.hold.parent") || task.status === "waiting") {
    return { kind: "waitParent", shown: reason || t("queue.shown.waitParent") };
  }
  if (
    holdHas(reason, "queue.hold.concurrencyFull") ||
    holdHas(reason, "queue.hold.poolUnavailable") ||
    holdHas(reason, "queue.hold.cooldown") ||
    cooldownPending(task.cooldownUntil, nowMs)
  ) {
    const fallback = task.cooldownUntil ? t("queue.shown.cooldown", { until: task.cooldownUntil }) : t("queue.shown.waitSlot");
    return { kind: "waitSlot", shown: reason || fallback };
  }
  if (holdHas(reason, "queue.hold.sameDir")) return { kind: "waitDir", shown: reason };
  if (holdHas(reason, "queue.hold.autoStartOff")) return { kind: "autoStartOff", shown: reason };
  if ((task.unattendedAt?.trim() ?? "") !== "" || holdHas(reason, "queue.hold.noSupervisorOld") || holdHas(reason, "queue.hold.noLeader")) {
    return { kind: "unattended", shown: reason || t("queue.shown.unattended") };
  }
  if (task.status === "acceptance") return { kind: "acceptance", shown: reason || t("queue.shown.acceptance") };
  if ((task.status === "running" || task.status === "reviewing") && idle !== null) {
    return { kind: "agentIdle", shown: reason || t("queue.shown.agentIdle") };
  }
  return reason ? { kind: "other", shown: reason } : null;
}

function cardLabel(card: WaitingCard): string {
  return t("queue.cardLabel", { code: card.code, project: card.project, title: shortTitle(card.title, 24) });
}

function timedAlert(card: WaitingCard): QueueAlert {
  const waited = formatWaited(card.waitedMinutes);
  const why = clip(card.reason, 80);
  if (card.waitKind === "acceptance") {
    return {
      cardId: card.id,
      level: "yellow",
      kind: card.category,
      text: t("queue.alert.acceptance", { card: cardLabel(card), waited }),
      agentId: card.agentId,
    };
  }
  const verb =
    card.waitKind === "waitDir" ? t("queue.verb.waitDir") :
    card.waitKind === "waitSlot" ? t("queue.verb.waitSlot") :
    card.waitKind === "unattended" ? t("queue.verb.unattended") :
    t("queue.verb.stalled");
  return {
    cardId: card.id,
    level: "yellow",
    kind: card.category,
    text: t("queue.alert.timed", { card: cardLabel(card), verb, waited, why }),
    agentId: card.agentId,
  };
}

function idleAlert(card: WaitingCard): QueueAlert {
  const idle = formatWaited(card.agentIdleMinutes);
  const sameSpan =
    card.waitedMinutes !== null &&
    card.agentIdleMinutes !== null &&
    Math.floor(card.waitedMinutes) === Math.floor(card.agentIdleMinutes);
  const stayed = card.waitedMinutes !== null && !sameSpan ? t("queue.alert.stayed", { waited: formatWaited(card.waitedMinutes) }) : "";
  return {
    cardId: card.id,
    level: "red",
    kind: t("queue.alert.kind.stuck"),
    text: t("queue.alert.idle", { card: cardLabel(card), stayed, idle }),
    agentId: card.agentId,
  };
}

function selfAlert(card: WaitingCard): QueueAlert | null {
  if (card.waitKind === "agentIdle") return idleAlert(card);
  if (TIMED_ALERT_KINDS.has(card.waitKind) && (card.waitedMinutes ?? -1) > QUEUE_WAIT_ALERT_MINUTES) {
    return timedAlert(card);
  }
  return null;
}

/**
 * Direct parent when that parent is already alarming.
 * If the direct parent is itself only waiting on its parents (which does not alarm on its own),
 * follow that chain to the card that is actually alarming, so a stuck card names every waiter behind it.
 */
function alertingAncestors(
  card: WaitingCard,
  byId: Map<number, WaitingCard>,
  alarming: Set<number>,
  seen: Set<number>,
): number[] {
  const found: number[] = [];
  for (const parentId of card.parentIds) {
    if (seen.has(parentId)) continue;
    seen.add(parentId);
    if (alarming.has(parentId)) {
      found.push(parentId);
      continue;
    }
    const parent = byId.get(parentId);
    if (parent?.waitKind === "waitParent") found.push(...alertingAncestors(parent, byId, alarming, seen));
  }
  return found;
}

export function alertsForWaiting(cards: WaitingCard[]): QueueAlert[] {
  const alerts: QueueAlert[] = [];
  const alarming = new Set<number>();
  for (const card of cards) {
    const alert = selfAlert(card);
    if (!alert) continue;
    alerts.push(alert);
    alarming.add(card.id);
  }
  const byId = new Map(cards.map((card) => [card.id, card]));
  for (const card of cards) {
    if (card.waitKind !== "waitParent") continue;
    const blockers = [...new Set(alertingAncestors(card, byId, alarming, new Set([card.id])))];
    if (blockers.length === 0) continue;
    const names = blockers.map((id) => byId.get(id)?.code ?? `#${id}`).join(t("queue.alert.nameSeparator"));
    const parent = byId.get(blockers[0] ?? -1);
    alerts.push({
      cardId: card.id,
      level: "yellow",
      kind: t("queue.alert.kind.blockedByParent"),
      text: t("queue.alert.blockedByParent", { card: cardLabel(card), names }),
      agentId: parent?.agentId ?? card.agentId,
    });
  }
  return alerts;
}

export function waitingRows(cards: WaitingCard[], alerts: QueueAlert[] = alertsForWaiting(cards)): QueueRow[] {
  const alarming = new Set(alerts.map((alert) => alert.cardId));
  return [...cards]
    .sort((a, b) => (b.waitedMinutes ?? -1) - (a.waitedMinutes ?? -1) || a.id - b.id)
    .slice(0, QUEUE_VISIBLE_LIMIT)
    .map((card) => ({
      id: card.id,
      code: card.code,
      project: card.project,
      title: shortTitle(card.title),
      waitKind: card.waitKind,
      category: card.category,
      reason: card.reason,
      waitedLabel: formatWaited(card.waitedMinutes),
      agentId: card.agentId,
      alarming: alarming.has(card.id),
    }));
}

/** Cards of paused projects raise no alert and are not listed; the visible-row limit applies to what is left. */
export function assembleQueueWithout(
  tasks: QueueTask[],
  agents: ReadonlyMap<string, QueueAgent>,
  nowMs: number,
  paused: readonly { project: string }[],
): { cards: WaitingCard[]; rows: QueueRow[]; alerts: QueueAlert[] } {
  const all = assembleQueue(tasks, agents, nowMs);
  if (paused.length === 0) return all;
  const cards = withoutPaused(all.cards, paused);
  const kept = new Set(cards.map((c) => c.id));
  const alerts = all.alerts.filter((a) => kept.has(a.cardId));
  return { cards, alerts, rows: waitingRows(cards, alerts) };
}

export function assembleQueue(
  tasks: QueueTask[],
  agents: ReadonlyMap<string, QueueAgent>,
  nowMs: number,
): { cards: WaitingCard[]; rows: QueueRow[]; alerts: QueueAlert[] } {
  const cards = tasks.flatMap((task) => {
    const card = classifyWait(task, task.agentId ? agents.get(task.agentId) : undefined, nowMs);
    return card ? [card] : [];
  });
  const alerts = alertsForWaiting(cards);
  return { cards, alerts, rows: waitingRows(cards, alerts) };
}
