/// <reference types="node" />
// What each company shows on the quota page: counts, notes, burn-week view, and the one-line summary.
import {
  CODEX_BURN_STOP_PCT,
  claudeWeekMode,
  confirmAgeNote,
  couponAlertsForMode,
  couponCliKind,
  couponInHand,
  formatCouponLine,
  manualCouponNote,
  type CouponAlert,
  type CouponCompany,
  type ResetCoupon,
  type ShownCoupon,
} from "../../shared/fleet/reset-coupons";
import type { CompanyLive, CouponBoardView, CouponBurnView, ResetCouponState } from "./reset-coupons-types";
import { t } from "../../shared/fleet/i18n";

export function shownOf(company: CouponCompany, seed: ResetCoupon | null, live: CompanyLive | undefined, used: boolean, now: number, cliOn: boolean): ShownCoupon {
  const canRead = couponCliKind(company) !== "none";
  const trusted = live?.via === "paseo" || (canRead && cliOn && live?.via === "cli");
  const fresh = Boolean(live?.status === "ok" && live.confirmedAt && trusted);
  const kept = Boolean(live?.status === "unreadable" && live.confirmedAt && trusted);
  const useNumbers = fresh || kept;
  const count = useNumbers && live ? live.count : seed?.count ?? 0;
  const kind = useNumbers && live ? live.kind : seed?.kind ?? "unknown";
  const expiresAt = (useNumbers && live ? live.expiresAt : null) ?? seed?.expiresAt ?? null;
  let confirmNote = "";
  if (fresh) confirmNote = "";
  else if (kept) confirmNote = confirmAgeNote(live?.confirmedAt || null, now, true);
  else if (!canRead) confirmNote = manualCouponNote(seed?.verifiedAt ?? null, false);
  else if (!cliOn) confirmNote = manualCouponNote(seed?.verifiedAt ?? null, true);
  else if (live?.status === "unreadable") confirmNote = confirmAgeNote(live.confirmedAt || seed?.verifiedAt || null, now, true);
  return {
    count,
    kind,
    expiresAt,
    shiftsWeeklyReset: seed?.shiftsWeeklyReset ?? false,
    where: seed?.where ?? "",
    confirmNote,
    used,
    ...(live?.typeText ? { typeText: live.typeText } : {}),
    ...(live?.items && live.items.length > 0 ? { pieces: live.items } : {}),
  };
}

export function claudeView(seed: ResetCoupon | null, live: CompanyLive | undefined, state: ResetCouponState, now: number, cliOn: boolean): { shown: ShownCoupon; mode: ReturnType<typeof claudeWeekMode> } {
  const shown = shownOf("claude", seed, live, Boolean(state.claudeUsedAt), now, cliOn);
  if (state.claudeRefillText) shown.typeText = state.claudeRefillText;
  const mode = claudeWeekMode({
    now,
    used: shown.used,
    shiftsWeeklyReset: seed?.shiftsWeeklyReset ?? false,
    count: shown.count,
    expiresAt: shown.expiresAt,
    burnWeek: seed?.burnWeek ?? null,
    unpauseProfiles: seed?.unpauseProfiles ?? [],
  });
  return { shown, mode };
}

function burnView(mode: ReturnType<typeof claudeWeekMode>, state: ResetCouponState): CouponBurnView | null {
  if (!mode.burn) return null;
  const usedAt = state.claudeUsedAt ? Date.parse(state.claudeUsedAt) : Number.NaN;
  return {
    ...mode.burn,
    baselinePct: state.claudeBurnBaselinePct ?? 0,
    usedAtMs: Number.isNaN(usedAt) ? mode.burn.startMs : usedAt,
  };
}

export function boardView(seeds: Record<CouponCompany, ResetCoupon | null>, state: ResetCouponState, now: number, cliRead: Partial<Record<CouponCompany, boolean>> = {}): CouponBoardView {
  const claude = claudeView(seeds.claude, state.companies.claude, state, now, cliRead.claude !== false);
  const lines: CouponBoardView["lines"] = {
    claude: { line: formatCouponLine(claude.shown, now), plan: claude.mode.planText },
  };
  let codexCouponCount = 0;
  let codexCouponExpiresAt: string | null = null;
  const codexBurnWeek = seeds.chatgpt?.burnWeek ?? null;
  // Companies in plans.json order: the keys of `seeds` (server/reset-coupons-state.ts couponPlansOf).
  for (const company of Object.keys(seeds)) {
    if (company === "claude") continue;
    const shown = shownOf(company, seeds[company], state.companies[company], false, now, cliRead[company] !== false);
    if (company === "chatgpt") {
      codexCouponCount = shown.count;
      codexCouponExpiresAt = shown.expiresAt;
    }
    lines[company] = { line: formatCouponLine(shown, now), plan: null };
  }
  const chatgptBurn = couponInHand(codexCouponCount, codexCouponExpiresAt, now);
  if (chatgptBurn && lines.chatgpt) lines.chatgpt = { ...lines.chatgpt, plan: t("coupons.view.burnMode") };
  return {
    claudeDoubleWeek: claude.mode.kind === "double",
    claudeStopPct: claude.mode.stopPct,
    claudeBurn: burnView(claude.mode, state),
    banner: claude.mode.banner,
    lines,
    codexCouponCount,
    codexCouponExpiresAt,
    codexBurnWeek,
    codexStopPct: chatgptBurn ? CODEX_BURN_STOP_PCT : null,
  };
}

/** One line per company of `seeds`. `names`: company → name on the line (CouponPlans.names); missing shows the key. */
export function summary(seeds: Record<CouponCompany, ResetCoupon | null>, state: ResetCouponState, now: number, cliRead: Partial<Record<CouponCompany, boolean>>, names: Readonly<Record<CouponCompany, string>> = {}): string {
  return Object.keys(seeds).map((company) => {
    const shown = company === "claude"
      ? claudeView(seeds.claude, state.companies.claude, state, now, cliRead.claude !== false).shown
      : shownOf(company, seeds[company], state.companies[company], false, now, cliRead[company] !== false);
    const note = shown.confirmNote ? t("coupons.line.note", { note: shown.confirmNote }) : "";
    const name = names[company] ?? company;
    if (shown.count <= 0) return t("coupons.view.summaryNone", { name, note });
    const when = shown.expiresAt ? t("coupons.view.summaryExpires", { date: shown.expiresAt.slice(0, 10) }) : t("coupons.line.expiryUnknown");
    return t("coupons.view.summary", { name, count: shown.count, kind: shown.kind, when, note });
  }).join(t("coupons.view.summaryJoin"));
}

function codexTypeText(codex: ShownCoupon): string | null {
  if (!codex.pieces || codex.pieces.length === 0) return null;
  return [...new Set(codex.pieces.map((piece) => piece.title))].join("、");
}

export interface ModeAlertInput {
  now: number;
  usedPct: number | null;
  resetsAt: string | null;
  lastUseNotifyAt: string | null;
  codexUsedPct: number | null;
  codexResetsAt: string | null;
  /** Pool reason already says the burn week hit the cap. */
  atCap?: boolean;
}

/** Alerts for the current Claude week mode, from what the two companies show right now. */
export function modeAlerts(claude: ReturnType<typeof claudeView>, codex: ShownCoupon, input: ModeAlertInput): CouponAlert[] {
  return couponAlertsForMode(claude.mode, {
    now: input.now,
    claudeCount: claude.shown.count,
    claudeKind: claude.shown.kind,
    claudeExpiresAt: claude.shown.expiresAt,
    claudeShifts: claude.shown.shiftsWeeklyReset,
    claudeWhere: claude.shown.where,
    claudeUsed: claude.shown.used,
    claudeUsedPct: input.usedPct,
    claudeResetsAt: input.resetsAt,
    lastUseNotifyAt: input.lastUseNotifyAt,
    codexCount: codex.count,
    codexExpiresAt: codex.expiresAt,
    codexUsed: false,
    codexUsedPct: input.codexUsedPct,
    codexResetsAt: input.codexResetsAt,
    codexKind: codex.kind,
    claudeTypeText: claude.shown.typeText ?? null,
    codexTypeText: codexTypeText(codex),
    ...(input.atCap === undefined ? {} : { atCap: input.atCap }),
  });
}
