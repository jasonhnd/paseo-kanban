/// <reference types="node" />
// One tick of coupon bookkeeping: spot a used coupon, classify usage drops, and queue notices.
// Pure over its inputs except for the in-flight send marks in reset-coupons-notify.
import { USED_DROP_POINTS } from "../../shared/fleet/reset-coupons";
import { inflight, type PendingNotify, type Send } from "./reset-coupons-notify";
import type { CouponNotice, ResetCouponState } from "./reset-coupons-types";
import { claudeView, modeAlerts, shownOf } from "./reset-coupons-view";
import {
  afcJustUsed,
  claudeCouponWeekStart,
  classifyUsageDrop,
  countDropped,
  doubleWeekAnnounce,
  doubleWeekPlan,
  officialResetText,
  sameResetWindow,
  shouldClearClaudeUsed,
  addWorkNotice,
  surplusKeys,
  surplusMessage,
  surplusResetReady,
  usageLooksUsed,
  type CouponAlert,
  type CouponCompany,
  type ResetCoupon,
  type ShownCoupon,
  type SurplusPool,
} from "../../shared/fleet/reset-coupons";
import { t } from "../../shared/fleet/i18n";

export interface CouponSignalExtra {
  codexUsedPct?: number | null;
  codexResetsAt?: string | null;
  /** True only when `codexCountNow` was read with this usage sample. */
  anchorCodexCount?: boolean;
  /**
   * Coupon count from the same moment as `codexUsedPct`.
   * Undefined keeps the count already on the company. Null means this round does not know, so the stored count is not the current one.
   */
  codexCountNow?: number | null;
  surplusPools?: SurplusPool[];
  /**
   * True when Paseo Kanban is absent: the burn-week "send more work" notice is off (nobody would dispatch the work).
   * Unsent surplus notices are dropped, because every tick rebuilds them; other coupon notices are unaffected.
   */
  surplusOff?: boolean;
  /** The Codex pool's id among `surplusPools` (plans.json names it). */
  codexPoolId?: string;
}

type Seeds = Record<CouponCompany, ResetCoupon | null>;
type ClaudeShown = ReturnType<typeof claudeView>;

/** What the previous tick stored, read before this tick overwrites it. */
interface ClaudeReading {
  liveCount: number | null;
  prevWeekly: number | null;
  prevWeeklyReset: string | null;
  prevCount: number | null;
}

interface NoticeBook {
  readonly sent: Set<string>;
  readonly queued: CouponNotice[];
  readonly gens: Partial<Record<string, number>>;
  remember(kind: string, text: string): void;
  queue(notice: CouponNotice): void;
  episode(id: string, scope: string): string;
  retire(id: string, scope: string, active: boolean): void;
}

const HOME_NOTES_KEPT = 8;
const CLAUDE_BASELINE_MAX_PCT = 15;

/** One coupon command explains one drop. After that drop is classified, the mark cannot cover a later one. */
function consumeAfcYes(state: ResetCouponState, company: "claude" | "codex"): void {
  if (!state.afcYesAt?.[company]) return;
  const rest = { ...state.afcYesAt };
  delete rest[company];
  state.afcYesAt = rest.claude || rest.codex ? rest : null;
}

/** Decide whether the Claude coupon was used, or an old mark is stale, and move the weekly readings forward. */
function trackClaudeUsedMark(next: ResetCouponState, now: number, weeklyUsedPct: number | null, weeklyResetsAt: string | null): ClaudeReading {
  const live = next.companies.claude;
  const liveCount = live?.confirmedAt ? live.count : null;
  const confirmedAt = live?.confirmedAt || null;
  const prevWeekly = next.lastWeeklyUsedPct;
  const prevWeeklyReset = next.lastWeeklyResetsAt;
  const prevCount = next.lastClaudeCount;
  const afcClaude = afcJustUsed(next.afcYesAt?.claude, now);
  if (!next.claudeUsedAt && afcClaude && usageLooksUsed(prevWeekly, weeklyUsedPct, now, weeklyResetsAt, prevWeeklyReset)) {
    next.claudeUsedAt = new Date(now).toISOString();
    if (typeof weeklyUsedPct === "number") next.claudeBurnBaselinePct = weeklyUsedPct;
  }
  if (!next.claudeUsedAt && countDropped(prevCount, liveCount)) {
    next.claudeUsedAt = new Date(now).toISOString();
    if (typeof weeklyUsedPct === "number" && weeklyUsedPct <= CLAUDE_BASELINE_MAX_PCT) next.claudeBurnBaselinePct = weeklyUsedPct;
  }
  if (next.claudeUsedAt && next.claudeBurnBaselinePct === null && typeof weeklyUsedPct === "number" && weeklyUsedPct <= CLAUDE_BASELINE_MAX_PCT) {
    next.claudeBurnBaselinePct = weeklyUsedPct;
  }
  if (shouldClearClaudeUsed({
    usedAt: next.claudeUsedAt,
    previousCount: prevCount,
    liveCount,
    confirmedAt,
    prevResetsAt: prevWeeklyReset,
    weekStartMs: claudeCouponWeekStart(now, weeklyResetsAt),
  })) {
    next.claudeUsedAt = null;
    next.claudeBurnBaselinePct = null;
  }
  if (typeof liveCount === "number") next.lastClaudeCount = liveCount;
  if (typeof weeklyUsedPct === "number") next.lastWeeklyUsedPct = weeklyUsedPct;
  if (weeklyResetsAt) next.lastWeeklyResetsAt = weeklyResetsAt;
  return { liveCount, prevWeekly, prevWeeklyReset, prevCount };
}

function createNoticeBook(next: ResetCouponState, now: number): NoticeBook {
  const sent = new Set(next.sentNoticeKeys ?? []);
  // Rebuild unsent surplus notices with current estimates and reset clocks on every tick.
  const queued: CouponNotice[] = (next.pendingNotices ?? []).filter((notice) => !notice.key.startsWith("surplus:"));
  const gens: Partial<Record<string, number>> = { ...(next.noticeGen ?? {}) };
  const episode = (id: string, scope: string) => `${id}:${scope}:${gens[id] ?? 0}`;
  return {
    sent,
    queued,
    gens,
    remember(kind, text) {
      const notes = next.homeNotes ?? [];
      if (notes.some((note) => note.text === text)) return;
      next.homeNotes = [...notes, { kind, text, at: new Date(now).toISOString() }].slice(-HOME_NOTES_KEPT);
    },
    queue(notice) {
      if (sent.has(notice.key) || queued.some((row) => row.key === notice.key) || inflight.keys.has(notice.key)) return;
      queued.push(notice);
    },
    episode,
    retire(id, scope, active) {
      if (!active && sent.has(episode(id, scope))) gens[id] = (gens[id] ?? 0) + 1;
    },
  };
}

function noteClaudeDrop(book: NoticeBook, next: ResetCouponState, now: number, reading: ClaudeReading, weeklyUsedPct: number | null, weeklyResetsAt: string | null): void {
  const drop = classifyUsageDrop({
    company: "claude",
    prevPct: reading.prevWeekly,
    nextPct: weeklyUsedPct,
    now,
    resetsAt: weeklyResetsAt,
    prevResetsAt: reading.prevWeeklyReset,
    prevCount: reading.prevCount,
    nextCount: reading.liveCount,
    afcYesAt: next.afcYesAt?.claude,
  });
  const scope = weeklyResetsAt ?? "na";
  const prevPct = Math.round(reading.prevWeekly ?? 0);
  if (drop?.kind === "coupon" && !next.claudeUsedAt) {
    next.claudeUsedAt = new Date(now).toISOString();
    if (typeof weeklyUsedPct === "number" && weeklyUsedPct <= CLAUDE_BASELINE_MAX_PCT) next.claudeBurnBaselinePct = weeklyUsedPct;
  }
  if (drop?.kind === "coupon") {
    consumeAfcYes(next, "claude");
    const text = t("coupons.signals.usedText", { company: "Claude", points: Math.round(drop.points) });
    book.queue({ key: `drop:claude:${scope}:${prevPct}`, who: "afc", text });
    book.remember(t("coupons.signals.usedKind"), text);
  } else if (drop?.kind === "suspected") {
    const text = t("coupons.signals.suspectedText", { points: Math.round(drop.points) });
    book.queue({ key: `drop:claude:suspected:${scope}:${prevPct}`, who: "afc", text });
    book.remember(t("coupons.signals.suspectedKind"), text);
  }
}

/** Classify a ChatGPT usage drop, queue its notice, and store the new reading unless the count is unpaired. */
function noteCodexDrop(book: NoticeBook, next: ResetCouponState, now: number, extra: CouponSignalExtra, codex: ShownCoupon): void {
  const prevPct = next.lastCodexUsedPct ?? null;
  const prevReset = next.lastCodexResetsAt ?? null;
  const prevCount = next.codexCountAtLastUsage ?? null;
  const countNow = extra.codexCountNow !== undefined ? extra.codexCountNow : codex.count;
  const drop = extra.codexUsedPct === undefined
    ? null
    : classifyUsageDrop({
      company: "codex",
      prevPct,
      nextPct: extra.codexUsedPct,
      now,
      resetsAt: extra.codexResetsAt ?? null,
      prevResetsAt: prevReset,
      prevCount,
      nextCount: countNow,
      afcYesAt: next.afcYesAt?.codex,
    });
  const scope = extra.codexResetsAt ?? "na";
  const was = Math.round(prevPct ?? 0);
  if (drop?.kind === "coupon") {
    next.codexQuotaResetAt = new Date(now).toISOString();
    consumeAfcYes(next, "codex");
    const text = t("coupons.signals.usedText", { company: "ChatGPT", points: Math.round(drop.points) });
    book.queue({ key: `drop:codex:${scope}:${was}`, who: "afc", text });
    book.remember(t("coupons.signals.usedKind"), text);
  } else if (drop?.kind === "official") {
    next.codexQuotaResetAt = new Date(now).toISOString();
    const pool = extra.surplusPools?.find((row) => row.id === extra.codexPoolId);
    const text = officialResetText("ChatGPT", drop.points, pool?.perRunPct, pool?.roles ?? [], pool?.sampleCards);
    book.queue({ key: `drop:codex:official:${scope}:${was}`, who: "afc", text: addWorkNotice(text) });
    book.remember(t("coupons.signals.officialKind"), text);
  }
  const unpaired = extra.codexCountNow === null
    && typeof extra.codexUsedPct === "number"
    && typeof prevPct === "number"
    && prevPct - extra.codexUsedPct >= USED_DROP_POINTS;
  if (!unpaired && typeof extra.codexUsedPct === "number") {
    next.lastCodexUsedPct = extra.codexUsedPct;
    if (extra.anchorCodexCount && typeof countNow === "number") next.codexCountAtLastUsage = countNow;
  }
  if (!unpaired && extra.codexResetsAt) next.lastCodexResetsAt = extra.codexResetsAt;
}

/** "<kind>. <text>. AFC never uses a coupon by itself... <cli>." */
function episodeText(alert: CouponAlert, cli: "claude" | "codex"): string {
  return t("coupons.signals.episode", { kind: alert.kind, text: alert.text, noSelfUse: t("coupons.signals.noSelfUse"), cli });
}

interface EpisodeInput {
  alerts: CouponAlert[];
  codex: ShownCoupon;
  extra: CouponSignalExtra;
  weeklyUsedPct: number | null;
  weeklyResetsAt: string | null;
  prevWeeklyReset: string | null;
  /** lastCodexResetsAt as it stood before this tick wrote the new one. */
  prevCodexReset: string | null;
}

/** Once-per-episode "ask the user to use the coupon" notices. A finished episode bumps its generation so the next hit notifies again. */
function queueEpisodeNotices(book: NoticeBook, input: EpisodeInput): void {
  const { alerts, codex, extra } = input;
  const claudeScope = input.weeklyResetsAt ?? "na";
  const cap = alerts.find((alert) => alert.once === "claude-cap");
  const claudeKnown = typeof input.weeklyUsedPct === "number";
  const claudePeriodChanged = Boolean(input.prevWeeklyReset && input.weeklyResetsAt && !sameResetWindow(input.prevWeeklyReset, input.weeklyResetsAt));
  book.retire("claude-cap", claudeScope, Boolean(cap) || (!claudeKnown && !claudePeriodChanged));
  if (cap) book.queue({ key: book.episode("claude-cap", claudeScope), who: "afc", text: episodeText(cap, "claude") });
  const codexUseScope = extra.codexResetsAt ?? "na";
  const codexExpiryScope = codex.expiresAt ?? "na";
  const codexUse = alerts.find((alert) => alert.once === "codex-use");
  const codexExpiry = alerts.find((alert) => alert.once === "codex-expiry");
  const codexKnown = typeof extra.codexUsedPct === "number";
  const codexPeriodChanged = Boolean(input.prevCodexReset && extra.codexResetsAt && !sameResetWindow(input.prevCodexReset, extra.codexResetsAt));
  const codexEpisodeOpen = !codexKnown && !codexPeriodChanged;
  book.retire("codex-use", codexUseScope, Boolean(codexUse) || codexEpisodeOpen);
  book.retire("codex-expiry", codexExpiryScope, Boolean(codexExpiry) || codexEpisodeOpen);
  if (codexUse) book.queue({ key: book.episode("codex-use", codexUseScope), who: "afc", text: episodeText(codexUse, "codex") });
  if (codexExpiry) book.queue({ key: book.episode("codex-expiry", codexExpiryScope), who: "afc", text: episodeText(codexExpiry, "codex") });
}

/** The burn-week "send more work" notice (AFC <leader> only), once the quota has settled after every reset. */
function queueSurplusNotice(book: NoticeBook, next: ResetCouponState, now: number, seeds: Seeds, claude: ClaudeShown, weeklyResetsAt: string | null, extra: CouponSignalExtra): void {
  if (extra.surplusOff) return;
  const inBurn = claude.mode.kind === "burn-front" || claude.mode.kind === "burn-back";
  const resetTimes = [
    new Date(claudeCouponWeekStart(now, weeklyResetsAt)).toISOString(),
    next.claudeUsedAt,
    next.afcYesAt?.claude,
    next.codexQuotaResetAt,
    next.afcYesAt?.codex,
    extra.codexResetsAt && Number.isFinite(Date.parse(extra.codexResetsAt))
      ? new Date(claudeCouponWeekStart(now, extra.codexResetsAt)).toISOString() : null,
    extra.surplusPools?.find((row) => row.id === extra.codexPoolId)?.resetAt,
  ];
  const ready = resetTimes.every((at) => surplusResetReady(now, at));
  const due = inBurn && ready ? surplusKeys(now, seeds.claude?.burnWeek, book.sent) : [];
  if (due.length === 0) return;
  const text = surplusMessage(extra.surplusPools ?? [], now);
  // No usable reading yet must not consume the slot; retry when the quota has settled.
  if (text && due.some((key) => !book.sent.has(key))) {
    book.queue({ key: `surplus:${due[0]}`, who: "afc", text, mark: due });
  }
}

/** Turn the alerts, the double-week announce, and the queued notices into sends. Marks them in flight. */
function collectSends(next: ResetCouponState, now: number, seeds: Seeds, claude: ClaudeShown, alerts: CouponAlert[], queued: CouponNotice[]): { sends: Send[]; pending: PendingNotify } {
  const sends: Send[] = [];
  const pending: PendingNotify = { use: false, announceKey: null, keys: [] };
  const red = alerts.find((alert) => alert.notifyUse && !alert.once);
  if (red && !inflight.use) {
    inflight.use = true;
    pending.use = true;
    sends.push({ who: "afc", text: t("coupons.signals.redUse", { kind: red.kind, text: red.text }), legacy: "use" });
  }
  // A named burn week replaces the computed double week, including the leader broadcast.
  const announce = seeds.claude?.burnWeek
    ? null
    : doubleWeekAnnounce(
      claude.shown.expiresAt && !claude.shown.shiftsWeeklyReset ? doubleWeekPlan(claude.shown.expiresAt) : null,
      now,
      claude.shown.used,
      next.announcedWeekStart,
    );
  if (announce && claude.shown.count > 0 && inflight.announce !== announce.key) {
    inflight.announce = announce.key;
    pending.announceKey = announce.key;
    sends.push({ who: "afc", text: addWorkNotice(announce.text), legacy: "announce" });
  }
  for (const notice of queued) {
    if (inflight.keys.has(notice.key)) continue;
    inflight.keys.add(notice.key);
    pending.keys.push(notice.key);
    sends.push({ who: notice.who, text: notice.text, keys: notice.mark ?? [notice.key] });
  }
  return { sends, pending };
}

export function signals(
  seeds: Seeds,
  state: ResetCouponState,
  now: number,
  weeklyUsedPct: number | null,
  weeklyResetsAt: string | null,
  cliRead: Partial<Record<CouponCompany, boolean>> = {},
  extra: CouponSignalExtra = {},
): { state: ResetCouponState; sends: Send[]; pending: PendingNotify } {
  const next: ResetCouponState = { ...state, companies: { ...state.companies } };
  const reading = trackClaudeUsedMark(next, now, weeklyUsedPct, weeklyResetsAt);
  const claude = claudeView(seeds.claude, next.companies.claude, next, now, cliRead.claude !== false);
  const codex = shownOf("chatgpt", seeds.chatgpt, next.companies.chatgpt, false, now, cliRead.chatgpt !== false);
  const alerts = modeAlerts(claude, codex, {
    now,
    usedPct: weeklyUsedPct,
    resetsAt: weeklyResetsAt,
    lastUseNotifyAt: next.lastUseNotifyAt,
    codexUsedPct: extra.codexUsedPct ?? null,
    codexResetsAt: extra.codexResetsAt ?? null,
  });
  const book = createNoticeBook(next, now);
  noteClaudeDrop(book, next, now, reading, weeklyUsedPct, weeklyResetsAt);
  const prevCodexReset = next.lastCodexResetsAt ?? null;
  noteCodexDrop(book, next, now, extra, codex);
  queueEpisodeNotices(book, { alerts, codex, extra, weeklyUsedPct, weeklyResetsAt, prevWeeklyReset: reading.prevWeeklyReset, prevCodexReset });
  queueSurplusNotice(book, next, now, seeds, claude, weeklyResetsAt, extra);
  next.pendingNotices = book.queued;
  next.sentNoticeKeys = [...book.sent];
  next.noticeGen = book.gens;
  return { state: next, ...collectSends(next, now, seeds, claude, alerts, book.queued) };
}
