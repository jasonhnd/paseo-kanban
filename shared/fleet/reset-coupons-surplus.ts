import { DAY_MS, SURPLUS_BEHIND_PCT, SURPLUS_RESET_QUIET_MS, CARD_ESTIMATE_MIN_SAMPLES, CARD_ESTIMATE_MAX, cardEstimateUnknown, type WeekWindow, tokyoParts, tokyoInstant } from "./reset-coupons-core";
import { t, type MessageKey } from "./i18n";

/** Work roles a surplus notice may offer, in display order. */
export const SURPLUS_ROLES = ["executor", "reviewer", "reader"] as const;
export type SurplusRole = (typeof SURPLUS_ROLES)[number];

const ROLE_LABEL: Record<SurplusRole, MessageKey> = {
  executor: "coupons.surplus.roleExecutor",
  reviewer: "coupons.surplus.roleReviewer",
  reader: "coupons.surplus.roleReader",
};

export function surplusRoleLabel(role: SurplusRole): string {
  return t(ROLE_LABEL[role]);
}

export function extraCards(points: number, perRunPct: number | null | undefined, sampleCards?: number | null): number | null {
  if (typeof sampleCards !== "number" || !Number.isFinite(sampleCards) || sampleCards < CARD_ESTIMATE_MIN_SAMPLES) return null;
  if (typeof perRunPct !== "number" || !Number.isFinite(perRunPct) || !(perRunPct > 0) || !Number.isFinite(points) || points < 0) return null;
  const cards = points / perRunPct;
  return cards > CARD_ESTIMATE_MAX ? null : Math.floor(cards);
}

/** Missing reset times keep other pools usable; a known reset must have settled for two hours. */
export function surplusResetReady(now: number, resetAt?: string | null): boolean {
  if (!resetAt) return true;
  const start = Date.parse(resetAt);
  return Number.isFinite(start) && now - start >= SURPLUS_RESET_QUIET_MS;
}

export interface SurplusPool {
  id: string;
  name: string;
  usedPct: number | null;
  pacePct: number | null;
  dailyPct: number | null;
  perRunPct: number | null;
  /** Cards dispatched on this pool in the last seven days, when the estimate has no sample count. */
  sampleCards?: number | null;
  /** Start of the current quota period, or the latest observed refill. */
  resetAt?: string | null;
  roles: SurplusRole[];
  /** A sub pool (Claude's Fable week, shared/quota-adapters.ts): it spends its main pool and is never offered. */
  sub?: boolean;
}


/** Any "send more work" notice goes to the AFC <leader> only; the user picks the projects. */
export function addWorkNotice(text: string): string {
  return t("coupons.surplus.notice", { prefix: t("coupons.surplus.addWorkPrefix"), text, suffix: t("coupons.surplus.addWorkSuffix") });
}

/** One notice line. Only pools at least 5 points under the progress line, and only the three work roles. */
export function surplusMessage(pools: SurplusPool[], now = Date.now()): string | null {
  const grouped = new Map<string, SurplusPool>();
  for (const pool of pools) {
    const prior = grouped.get(pool.id);
    grouped.set(pool.id, prior ? { ...prior, roles: [...new Set([...prior.roles, ...pool.roles])] } : pool);
  }
  const parts: string[] = [];
  for (const pool of grouped.values()) {
    // A sub pool (Fable) spends Claude's main quota and is reserved for high-risk reviews.
    if (pool.sub === true || !surplusResetReady(now, pool.resetAt)) continue;
    if (pool.usedPct === null || pool.pacePct === null || !Number.isFinite(pool.usedPct) || !Number.isFinite(pool.pacePct)) continue;
    if (pool.pacePct - pool.usedPct < SURPLUS_BEHIND_PCT) continue;
    if (pool.dailyPct === null || !Number.isFinite(pool.dailyPct) || !(pool.dailyPct > 0)) continue;
    const cards = extraCards(pool.dailyPct, pool.perRunPct, pool.sampleCards);
    const roles = SURPLUS_ROLES.filter((role) => pool.roles.includes(role));
    if (roles.length === 0) continue;
    const names = roles.map(surplusRoleLabel).join(t("coupons.surplus.roleJoin"));
    const many = roles.length > 1;
    parts.push(cards === null
      ? t("coupons.surplus.poolUnknown", { name: pool.name, share: t(many ? "coupons.surplus.allUsable" : "coupons.surplus.usable", { roles: names }), estimate: cardEstimateUnknown() })
      : t("coupons.surplus.poolCards", { name: pool.name, cards, share: t(many ? "coupons.surplus.shared" : "coupons.surplus.usable", { roles: names }) }));
  }
  if (parts.length === 0) return null;
  return addWorkNotice(t("coupons.surplus.message", { parts: parts.join(t("coupons.surplus.partJoin")) }));
}

/** Keys still due inside a burn week: the start, and the latest Tokyo 09:00 slot (even after midnight). */
export function surplusKeys(now: number, burn: WeekWindow | null | undefined, sent: ReadonlySet<string>): string[] {
  if (!burn) return [];
  const start = Date.parse(burn.start);
  const end = Date.parse(burn.end);
  if (Number.isNaN(start) || Number.isNaN(end) || !surplusResetReady(now, burn.start) || now >= end) return [];
  const keys: string[] = [];
  const startKey = `surplus:start:${burn.start}`;
  if (!sent.has(startKey)) keys.push(startKey);
  const today = tokyoParts(now);
  const p = today.hour >= 9 ? today : tokyoParts(now - DAY_MS);
  if (tokyoInstant(p.y, p.m, p.d, 9) >= start) {
    const day = `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
    const dayKey = `surplus:day:${day}`;
    if (!sent.has(dayKey)) keys.push(dayKey);
  }
  return keys;
}

export function officialResetText(name: string, points: number, perRunPct: number | null | undefined, roles: readonly SurplusRole[], sampleCards?: number | null): string {
  const cards = extraCards(points, perRunPct, sampleCards);
  const roleBit = roles.length > 0 ? t("coupons.surplus.officialRoles", { roles: roles.map(surplusRoleLabel).join(t("coupons.surplus.officialRoleJoin")) }) : "";
  const many = cards === null ? cardEstimateUnknown() : t("coupons.surplus.officialCards", { cards, roles: roleBit });
  return t("coupons.surplus.official", { name, pct: Math.round(points), many });
}
