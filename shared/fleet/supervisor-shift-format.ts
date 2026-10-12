// Pure text and lamp helpers for the homepage <leader> rows and the takeover message.
import { DEFAULT_LEADER_THRESHOLDS, type LeaderThresholds } from "./leader-usage";
import { TOKYO_OFFSET_MS } from "./dispatch";
import { t, tAll } from "./i18n";
import { HANDOVER_PREVIEW_LINES, takenOverReply, type Lamp } from "./supervisor-shift-types";

/** Joins card codes in a sentence. */
export function joinList(items: readonly string[]): string {
  return items.join(t("shift.list.separator"));
}

/** Empty means none; null means the read failed, so do not claim there are none. */
export function shiftConfirmation(code: string, acceptanceCards: readonly string[] | null): string {
  const question = t("shift.confirm.question", { code });
  if (acceptanceCards === null) return `${question}\n${t("shift.confirm.cardsUnreadable")}`;
  if (acceptanceCards.length === 0) return question;
  return `${question}\n${t("shift.confirm.cardsPending", { count: acceptanceCards.length, cards: joinList(acceptanceCards) })}`;
}

export function contextLamp(tokens: number | null, thresholds: LeaderThresholds = DEFAULT_LEADER_THRESHOLDS): Lamp {
  if (tokens === null || !Number.isFinite(tokens) || tokens < 0) return "unknown";
  if (tokens > thresholds.warningTokens) return "red";
  if (tokens > thresholds.reminderTokens) return "yellow";
  return "green";
}

export function isBusy(status: string): boolean {
  const name = status.trim().toLowerCase();
  return name === "running" || name === "initializing";
}

/** True when a row's statusText says busy, in any language (the panel may have been built by another process). */
export function isBusyStatusText(statusText: string): boolean {
  return tAll("leader.status.busy").includes(statusText);
}

/** Running, or sitting on a permission the user has not answered. Either one means keep waiting. */
export function isShiftBlocked(agent: { status: string; pendingApproval?: boolean }): boolean {
  return isBusy(agent.status) || agent.pendingApproval === true;
}

/** True only for a user click. Callers must not start a shift when this is false. */
export function shouldStartShift(clicked: boolean): boolean {
  return clicked === true;
}

export function formatStarted(createdAt: string | null, now: number): string | null {
  if (!createdAt) return null;
  const ms = Date.parse(createdAt);
  if (Number.isNaN(ms)) return null;
  const at = new Date(ms + TOKYO_OFFSET_MS);
  const clock = `${at.getUTCMonth() + 1}/${at.getUTCDate()} ${String(at.getUTCHours()).padStart(2, "0")}:${String(at.getUTCMinutes()).padStart(2, "0")}`;
  return t("shift.started", { clock, elapsed: formatElapsed(Math.max(0, now - ms)) });
}

function formatElapsed(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  if (days > 0 && restHours > 0) return t("shift.elapsed.daysHours", { days, hours: restHours });
  if (days > 0) return t("shift.elapsed.days", { days });
  if (hours > 0) return t("shift.elapsed.hours", { hours });
  if (minutes > 0) return t("shift.elapsed.minutes", { minutes });
  return t("shift.elapsed.underMinute");
}

/**
 * Context size in the catalog's unit (`shift.context.unit`: 10,000 in Chinese, 1,000 in English), with one decimal
 * below 100 units so 25.5 is not rounded back to 25.
 */
export function formatContextTokens(tokens: number): string {
  const unit = Number(t("shift.context.unit")) || 1e4;
  const value = tokens / unit;
  if (!Number.isFinite(value)) return t("shift.context.unreadable");
  const n = value >= 100 ? String(Math.round(value)) : String(Math.round(value * 10) / 10).replace(/\.0$/, "");
  return t("shift.context.amount", { n });
}

export function formatTodayUsd(usd: number | null): string | null {
  if (usd === null || !Number.isFinite(usd) || usd <= 0) return null;
  const text = usd >= 10 ? String(Math.round(usd)) : String(Math.round(usd * 10) / 10).replace(/\.0$/, "");
  return t("shift.todayUsd", { usd: text });
}

export function handoverPreview(text: string, lines = HANDOVER_PREVIEW_LINES): string {
  return text.split(/\r?\n/).slice(0, lines).join("\n");
}

/** Short excerpt for the new session's first message: the current-work section, or the first 30 lines. */
export function handoverSummary(text: string): string {
  const lines = text.split(/\r?\n/);
  const markers = tAll("shift.handover.sectionMarker");
  const start = lines.findIndex((line) => markers.some((marker) => line.includes(marker)));
  if (start >= 0) {
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      if (/^##\s/.test(lines[i])) {
        end = i;
        break;
      }
    }
    return lines.slice(start, end).slice(0, 40).join("\n").trim();
  }
  return lines.slice(0, HANDOVER_PREVIEW_LINES).join("\n").trim();
}

export function takeoverPrompt(input: {
  projectLabel: string;
  oldId: string;
  handoverPath: string | null;
  handoverSummary: string | null;
  acceptanceCards?: readonly string[] | null;
}): string {
  const body = t("shift.takeover.body", { project: input.projectLabel, oldId: input.oldId, taken: takenOverReply() });
  const path = input.handoverPath ?? t("shift.takeover.noFile");
  const summary = input.handoverSummary?.trim() ? input.handoverSummary.trim() : t("shift.takeover.emptyFile");
  const cards = input.acceptanceCards;
  const acceptance = cards == null
    ? t("shift.takeover.cardsUnreadable")
    : cards.length === 0
      ? t("shift.takeover.noCards")
      : t("shift.takeover.cards", { count: cards.length, cards: joinList(cards) });
  return t("shift.takeover.message", { body, acceptance, path, summary });
}

export function providerModel(provider: string, model: string): string {
  if (provider.includes("/")) return provider;
  if (!provider || !model) return provider || model;
  return `${provider}/${model}`;
}
