import {
  acceptanceTone, groupLeaderCards, leaderCounts, projectDecisions, unresponsiveCards,
  type LeaderCounts, type LeaderDetail, type PanelDecision,
} from "./leader-panel";
import { isUnownedDecision, type UnownedDecision } from "./unowned-decisions";
import { t } from "./i18n";
import { isCancelledLabel } from "./supervisor-shift-types";

/** A registered decision as the Leader tab lists it. */
export type AttentionDecision = PanelDecision & UnownedDecision & { title: string; detail: string };
export interface AttentionLeader { project: string; code: string }

export type AttentionItem<D extends AttentionDecision = AttentionDecision> =
  | { kind: "decision"; key: string; project: string; code: string; decision: D }
  | { kind: "unresponsive"; key: string; project: string; code: string; count: number; wakes: number }
  | { kind: "stale-acceptance"; key: string; project: string; code: string; count: number }
  | { kind: "question"; key: string; project: string; code: string; text: string; at: string };

/**
 * Only what needs the user to act, across every <leader>: decisions that block work, a <leader> that stopped
 * answering, acceptance cards waiting over 2 hours, and a question asked but never registered.
 * The list is already in urgency order, so callers render it as is.
 */
export function attentionItems<D extends AttentionDecision>(
  rows: readonly AttentionLeader[], details: readonly LeaderDetail[], decisions: readonly D[], now: number,
): AttentionItem<D>[] {
  const byProject = new Map(details.map((d) => [d.project, d]));
  const blocking: AttentionItem<D>[] = [], stuck: AttentionItem<D>[] = [], stale: AttentionItem<D>[] = [], asks: AttentionItem<D>[] = [];
  for (const row of rows) {
    const detail = byProject.get(row.project);
    for (const decision of projectDecisions(decisions, row.project).filter((d) => !isUnownedDecision(d) && d.blocking)) {
      blocking.push({ kind: "decision", key: `decision-${decision.id}`, project: row.project, code: row.code, decision });
    }
    const silent = unresponsiveCards(detail);
    if (silent.length > 0) {
      const wakes = Math.max(...silent.map((c) => c.repeatWakes ?? 0));
      stuck.push({ kind: "unresponsive", key: `unresponsive-${row.project}`, project: row.project, code: row.code, count: silent.length, wakes });
    }
    const late = (detail?.cards ?? []).filter((c) => !c.unresponsive && acceptanceTone(c, now) === "red");
    if (late.length > 0) stale.push({ kind: "stale-acceptance", key: `stale-${row.project}`, project: row.project, code: row.code, count: late.length });
    if (detail?.question) asks.push({ kind: "question", key: `question-${row.project}`, project: row.project, code: row.code, text: detail.question.text, at: detail.question.at });
  }
  return [...blocking, ...stuck, ...stale, ...asks];
}

export type TagTone = "red" | "yellow" | "blue" | "neutral";
export interface LeaderTag { key: string; label: string; tone: TagTone }

/** Short chips for the compact card; a count of zero shows nothing. */
export function leaderTags(counts: LeaderCounts, extra: { unread?: boolean; shift?: { label: string; failed: boolean } | null; stale?: "red" | "yellow" | "normal" } = {}): LeaderTag[] {
  const tags: LeaderTag[] = [];
  if (counts.unresponsive > 0) tags.push({ key: "unresponsive", label: t("leader.tag.unresponsive", { count: counts.unresponsive }), tone: "red" });
  if (counts.waiting > 0) tags.push({ key: "waiting", label: t("leader.tag.waiting", { count: counts.waiting }), tone: counts.blocking ? "red" : "yellow" });
  if (counts.acceptance > 0) {
    const tone: TagTone = extra.stale === "red" ? "red" : extra.stale === "yellow" ? "yellow" : "neutral";
    tags.push({ key: "acceptance", label: t("leader.tag.acceptance", { count: counts.acceptance }), tone });
  }
  if (counts.blocked > 0) tags.push({ key: "blocked", label: t("leader.tag.blocked", { count: counts.blocked }), tone: "red" });
  if (counts.selfWorking) tags.push({ key: "self-work", label: t("leader.tag.selfWork"), tone: "yellow" });
  if (extra.unread) tags.push({ key: "unread", label: t("leader.tag.unread"), tone: "blue" });
  if (extra.shift) tags.push({ key: "shift", label: extra.shift.label, tone: extra.shift.failed ? "red" : "blue" });
  return tags;
}

/** The worst acceptance wait among this <leader>'s cards, which sets the acceptance chip colour. */
export function worstAcceptanceTone(detail: LeaderDetail | undefined, now: number): "red" | "yellow" | "normal" {
  const tones = groupLeaderCards(detail?.cards ?? []).acceptance.map((c) => acceptanceTone(c, now));
  return tones.includes("red") ? "red" : tones.includes("yellow") ? "yellow" : "normal";
}

export function tagsFor(project: string, detail: LeaderDetail | undefined, decisions: readonly PanelDecision[], now: number, extra: { unread?: boolean; shift?: { label: string; failed: boolean } | null } = {}): LeaderTag[] {
  return leaderTags(leaderCounts(project, detail, decisions), { ...extra, stale: worstAcceptanceTone(detail, now) });
}

export function attentionEmpty(): string {
  return t("leader.attention.empty");
}

export function attentionTitle(item: AttentionItem): string {
  if (item.kind === "decision") return `${item.code} · ${item.decision.title}`;
  if (item.kind === "unresponsive") return t("leader.attention.unresponsive", { code: item.code, count: item.count, wakes: item.wakes });
  if (item.kind === "stale-acceptance") return t("leader.attention.staleAcceptance", { code: item.code, count: item.count });
  return t("leader.attention.question", { code: item.code });
}

/** The shift track lives in the expanded part, so a running, finished or failed shift shows up as a chip. */
export function shiftTag(job: { phase: string; label: string; canContinue?: boolean } | undefined, trackVisible: boolean): { label: string; failed: boolean } | null {
  if (!job) return null;
  if (job.phase === "failed") {
    const cancelled = isCancelledLabel(job.label);
    return { label: cancelled ? t("leader.tag.shiftCancelled") : t("leader.tag.shiftFailed"), failed: !cancelled };
  }
  return trackVisible ? { label: t("leader.tag.shift", { label: job.label }), failed: false } : null;
}
