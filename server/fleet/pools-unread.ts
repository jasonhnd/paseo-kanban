/// <reference types="node" />
// What to do when a refresh has no usedPct for Claude's main week or ChatGPT's week.
import { sameResetWindow } from "../../shared/fleet/reset-coupons";
import type { UsageWindow } from "../../shared/fleet/usage";
import { t, tAll, tIn, LANGUAGES, type MessageKey } from "../../shared/fleet/i18n";

/**
 * Claude's main week and ChatGPT's week. A missed read may reuse a successful usedPct this recent.
 * Older than this, or no previous reading, that pool stops taking new work.
 */
export const CLAUDE_UNREAD_MAX_AGE_MS = 30 * 60 * 1000;
/** Shown on the Claude main pool (and copied onto its Fable week) when there is nothing fresh enough to reuse. */
export function claudeUnreadStop(): string {
  return t("pools.unread.claudeStop");
}
/**
 * The previous reading's weekly reset has already passed, so that percent is last week's.
 * Reusing it would apply last week's 75% line to a new week. Stopping would also freeze
 * the fleet on a fresh week. The missed read is treated as unknown and may dispatch.
 */
export function claudeUnreadReset(): string {
  return t("pools.unread.claudeReset");
}

/** True when a reason says the missed read was let through as unknown (any language). */
export function unknownAllowed(reason: string): boolean {
  return tAll("pools.unread.unknownAllowedToken").some((token) => reason.includes(token));
}
/** Codex has no supervisor reserve to protect, but a missed read must not be treated as free to use. */
export function codexUnreadStop(): string {
  return t("pools.unread.codexStop");
}

/** One successful Claude main-week reading, and when it was taken. */
export interface ClaudeUsedReading {
  usedPct: number;
  resetsAt: string | null;
  at: string;
}

/**
 * Where the carried-reading mark (pools.unread.carryMark, any language) starts; -1 when absent.
 * The mark is stamped onto a carried reason so the next missed read keeps the original clock.
 */
function carryMarkIndex(reason: string): number {
  const hits = tAll("pools.unread.carryMark").map((mark) => reason.indexOf(mark)).filter((at) => at >= 0);
  return hits.length > 0 ? Math.min(...hits) : -1;
}

/** True when the reason carries a previous reading (written in any language). */
export function hasCarryMark(reason: string): boolean {
  return carryMarkIndex(reason) >= 0;
}

export function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A regex matching `key`'s text in every language, each `{name}` placeholder replaced by the capture `groups[name]`.
 * For reading reasons that an earlier run (maybe in the other language) wrote.
 */
export function catalogRegex(key: MessageKey, groups: Readonly<Record<string, string>>): RegExp {
  const marks = Object.fromEntries(Object.keys(groups).map((name, i) => [name, `\u0000${i}\u0000`]));
  const sources = LANGUAGES.map((lang) => {
    let source = escapeRegex(tIn(lang, key, marks));
    Object.keys(groups).forEach((name, i) => {
      source = source.split(`\u0000${i}\u0000`).join(groups[name]);
    });
    return source;
  });
  return new RegExp([...new Set(sources)].map((source) => `(?:${source})`).join("|"));
}

const ISO_AT = "([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z)";

function carriedReadAt(reason: string): string | undefined {
  const match = catalogRegex("pools.unread.readAt", { at: ISO_AT }).exec(reason);
  return match?.slice(1).find((group) => group !== undefined);
}

/** The parenthetical that names the original read. Empty when this reason is a fresh reading. */
export function carriedSuffix(reason: string): string {
  const start = carryMarkIndex(reason);
  if (start < 0) return "";
  const opens = tAll("pools.unread.paren", { text: "" }).map((paren) => paren.trim().charAt(0));
  let open = Math.max(...opens.map((char) => reason.lastIndexOf(char, start)));
  if (open > 0 && reason[open] === "(" && reason[open - 1] === " ") open -= 1;
  return open >= 0 ? reason.slice(open) : t("pools.unread.paren", { text: reason.slice(start) });
}

export function claudeReadingFromSnapshot(
  file: {
    generatedAt?: unknown;
    pools?: Record<string, { usedPct?: unknown; resetsAt?: unknown; reason?: unknown; observedAt?: unknown }>;
  } | null,
  pool: string,
): ClaudeUsedReading | null {
  const row = file?.pools?.[pool];
  if (!row || typeof row.usedPct !== "number" || !Number.isFinite(row.usedPct)) return null;
  const reason = typeof row.reason === "string" ? row.reason : "";
  const at = carriedReadAt(reason) ?? ("observedAt" in row ? typeof row.observedAt === "string" ? row.observedAt : "" : typeof file?.generatedAt === "string" ? file.generatedAt : "");
  if (Number.isNaN(Date.parse(at))) return null;
  return {
    usedPct: row.usedPct,
    resetsAt: typeof row.resetsAt === "string" ? row.resetsAt : null,
    at,
  };
}

export function claudeReadingFromHistory(
  samples: Array<{ at?: unknown; pools?: Record<string, { usedPct?: unknown; resetsAt?: unknown; observedAt?: unknown }> }>,
  pool: string,
): ClaudeUsedReading | null {
  for (let i = samples.length - 1; i >= 0; i--) {
    const reading = readingFromSample(samples[i], pool);
    if (reading) return reading;
  }
  return null;
}

function readingFromSample(
  sample: { at?: unknown; pools?: Record<string, { usedPct?: unknown; resetsAt?: unknown; observedAt?: unknown }> } | undefined,
  pool: string,
): ClaudeUsedReading | null {
  const row = sample?.pools?.[pool];
  if (!row || typeof row.usedPct !== "number" || !Number.isFinite(row.usedPct)) return null;
  const at = "observedAt" in row ? typeof row.observedAt === "string" ? row.observedAt : "" : typeof sample.at === "string" ? sample.at : "";
  if (Number.isNaN(Date.parse(at))) return null;
  return {
    usedPct: row.usedPct,
    resetsAt: typeof row.resetsAt === "string" ? row.resetsAt : null,
    at,
  };
}

/** Newer successful reading. A carried snapshot keeps its original read-at time, so it does not outrank a real sample. */
export function newerClaudeReading(a: ClaudeUsedReading | null, b: ClaudeUsedReading | null): ClaudeUsedReading | null {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(a.at) >= Date.parse(b.at) ? a : b;
}

export type ClaudeUnreadDecision =
  | { kind: "carry"; usedPct: number; resetsAt: string | null; note: string }
  | { kind: "stop"; reason: string }
  | { kind: "reset" };

export interface UnreadPolicy {
  stopReason: string;
  /** Claude drops last week's percent and may dispatch. Codex stops: a missed read is not a free pass. */
  onRolled: "reset" | "stop";
}

/**
 * What to do when this refresh has no usedPct.
 * A weekly reset (the stored resetsAt is already past, or the live window is a different week)
 * drops the old percent. Claude then leaves the pool unknown. Codex stops instead.
 */
export function decidePoolUnread(
  now: number,
  prior: ClaudeUsedReading | null,
  liveResetsAt: string | null,
  policy: UnreadPolicy,
): ClaudeUnreadDecision {
  if (!prior || !Number.isFinite(prior.usedPct)) return { kind: "stop", reason: policy.stopReason };
  const at = Date.parse(prior.at);
  if (Number.isNaN(at)) return { kind: "stop", reason: policy.stopReason };
  if (weekRolled(now, prior.resetsAt, liveResetsAt)) {
    return policy.onRolled === "stop" ? { kind: "stop", reason: policy.stopReason } : { kind: "reset" };
  }
  if (now - at > CLAUDE_UNREAD_MAX_AGE_MS) return { kind: "stop", reason: policy.stopReason };
  return carryDecision(now, at, prior, liveResetsAt);
}

function weekRolled(now: number, priorResetsAt: string | null, liveResetsAt: string | null): boolean {
  const priorReset = priorResetsAt ? Date.parse(priorResetsAt) : Number.NaN;
  const liveReset = liveResetsAt ? Date.parse(liveResetsAt) : Number.NaN;
  const priorPassed = !Number.isNaN(priorReset) && now >= priorReset;
  const differentWeek = !Number.isNaN(liveReset) && !Number.isNaN(priorReset) && !sameResetWindow(priorResetsAt, liveResetsAt);
  return priorPassed || differentWeek;
}

function carryDecision(now: number, at: number, prior: ClaudeUsedReading, liveResetsAt: string | null): ClaudeUnreadDecision {
  const minutes = Math.round((now - at) / 60_000);
  const ago = minutes <= 0 ? t("pools.unread.agoUnderMinute") : t("pools.unread.agoMinutes", { minutes });
  const liveReset = liveResetsAt ? Date.parse(liveResetsAt) : Number.NaN;
  const resetsAt = !Number.isNaN(liveReset) ? liveResetsAt : prior.resetsAt;
  const readAt = t("pools.unread.readAt", { at: new Date(at).toISOString() });
  const note = t("pools.unread.carryNote", { mark: t("pools.unread.carryMark"), ago, pct: Math.round(prior.usedPct), readAt });
  return { kind: "carry", usedPct: prior.usedPct, resetsAt, note };
}

/** Claude's main week. A rolled week may dispatch; anything older than 30 minutes, or with no history, stops. */
export function decideClaudeUnread(now: number, prior: ClaudeUsedReading | null, liveResetsAt: string | null): ClaudeUnreadDecision {
  return decidePoolUnread(now, prior, liveResetsAt, { stopReason: claudeUnreadStop(), onRolled: "reset" });
}

export function withCarriedUsed(w: UsageWindow | undefined, usedPct: number, resetsAt: string | null): UsageWindow {
  if (w) return { ...w, usedPct, resetsAt: resetsAt ?? w.resetsAt };
  return {
    label: "Weekly",
    usedPct,
    resetsAt,
    startsAt: null,
    elapsedPct: null,
    projectedPct: null,
    runsOutAt: null,
    verdict: "unknown",
    apiUsd: 0,
    fullWindowUsd: null,
    planUsd: null,
    source: "provider",
    manualAt: null,
  };
}
