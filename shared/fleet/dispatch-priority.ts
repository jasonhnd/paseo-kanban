// Dispatch pool order (DEMO_0124). Pure functions.
// By default the order comes from the quota: dispatchable pools sorted by needPerDay (points per day still to use
// before reset), biggest first. plans.json top-level `dispatchPriority` (DEMO_0123) is now an optional override the
// user can set for a while; missing, invalid, or past `until` means the quota order applies.
// The order is written to dispatch-matrix.json `priority` with `until` at most 30 minutes ahead, so Kanban falls
// back to its old ranking by itself when AFC stops refreshing.
import { t } from "./i18n";

export interface DispatchPriority {
  order: string[];
  until: string;
  note?: string;
}

/** How long a written order stays in force without a refresh. AFC rewrites it every quota round (about 5 minutes). */
export const PRIORITY_TTL_MS = 30 * 60 * 1000;

export type PriorityMode = "quota" | "manual";

/** The order in force. `overrideUntil` is the user's own end time, kept for the quota page. */
export interface ResolvedPriority {
  order: string[];
  until: string;
  mode: PriorityMode;
  needPerDay: Record<string, number | null>;
  /**
   * Sort key per listed pool (0 first): its place in `order`, so the page, the matrix and roles ls agree, ties
   * included. A pool with unknown need has none and falls back to the old rank and base-matrix order.
   */
  places: Record<string, number>;
  overrideUntil?: string;
}

/** What the quota page reads (BoardUsage.priority). */
export interface PriorityLineInput {
  order: string[];
  until: string;
  mode?: PriorityMode;
  needPerDay?: Record<string, number | null>;
  overrideUntil?: string;
}

interface NeedRow {
  dispatchable: boolean;
  deprioritize?: boolean;
  needPerDay?: number | null;
}

const TOKYO_OFFSET_MS = 9 * 60 * 60 * 1000;

export function parseDispatchPriority(raw: unknown): DispatchPriority | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as { order?: unknown; until?: unknown; note?: unknown };
  if (!Array.isArray(row.order) || row.order.length === 0) return null;
  const order = row.order.filter((pool): pool is string => typeof pool === "string" && pool.length > 0);
  if (order.length !== row.order.length || new Set(order).size !== order.length) return null;
  if (typeof row.until !== "string" || Number.isNaN(Date.parse(row.until))) return null;
  const note = typeof row.note === "string" && row.note ? row.note : undefined;
  return { order, until: row.until, ...(note ? { note } : {}) };
}

/** Active only while `now` is strictly before `until`. */
export function isPriorityActive(priority: DispatchPriority | null, now: number): priority is DispatchPriority {
  return priority !== null && now < Date.parse(priority.until);
}

/** plans.json `dispatchPriority`, parsed and still in force at `now`. Null otherwise. */
export function activeDispatchPriority(plansFile: unknown, now: number): DispatchPriority | null {
  if (!plansFile || typeof plansFile !== "object") return null;
  const priority = parseDispatchPriority((plansFile as { dispatchPriority?: unknown }).dispatchPriority);
  return isPriorityActive(priority, now) ? priority : null;
}

/** Any order with an end time: a plans.json override or the resolved order (which also carries `places`). */
type PoolOrder = { order: string[]; until: string; places?: Record<string, number> };

/** Place of the pool in the order, 0 first. Null when there is no order or the pool has no place in it. */
export function priorityIndexOf(priority: PoolOrder | null, pool: string): number | null {
  if (!priority) return null;
  if (priority.places) return priority.places[pool] ?? null;
  const index = priority.order.indexOf(pool);
  return index >= 0 ? index : null;
}

/** Copy of each pool row with `priorityIndex` set from the order (null for every row when none). */
export function withPriorityIndex<T extends object>(pools: Record<string, T>, priority: PoolOrder | null): Record<string, T & { priorityIndex: number | null }> {
  const out: Record<string, T & { priorityIndex: number | null }> = {};
  for (const [key, pool] of Object.entries(pools)) out[key] = { ...pool, priorityIndex: priorityIndexOf(priority, key) };
  return out;
}

/**
 * pool-status.json rows: `priorityIndex` on every row (null when not listed or no order is in force), plus
 * `priorityUntil` on listed rows so a reader of an older snapshot can drop an expired index.
 */
export function withPoolPriority<T extends object>(
  pools: Record<string, T>,
  priority: PoolOrder | null,
): Record<string, T & { priorityIndex: number | null; priorityUntil?: string }> {
  const out: Record<string, T & { priorityIndex: number | null; priorityUntil?: string }> = {};
  for (const [key, row] of Object.entries(withPriorityIndex(pools, priority))) {
    out[key] = row.priorityIndex !== null && priority ? { ...row, priorityUntil: priority.until } : row;
  }
  return out;
}

const needOf = (row: NeedRow | undefined): number | null =>
  typeof row?.needPerDay === "number" && Number.isFinite(row.needPerDay) ? row.needPerDay : null;

/**
 * Dispatchable pools (not deprioritized, not paused) by needPerDay, biggest first. Unknown need goes after every
 * known one; ties keep the snapshot order. Deprioritized and paused pools are not listed, so they keep their place.
 */
export function quotaOrder(pools: Record<string, NeedRow>): string[] {
  // Ties keep the snapshot order, and `places` follows this list, so every reader sees the same tie order.
  return Object.entries(pools)
    .map(([pool, row], index) => ({ pool, row, index, need: needOf(row) }))
    .filter(({ row }) => row.dispatchable && !row.deprioritize)
    .sort((a, b) => {
      if (a.need === null || b.need === null) return (a.need === null ? 1 : 0) - (b.need === null ? 1 : 0) || a.index - b.index;
      return b.need - a.need || a.index - b.index;
    })
    .map(({ pool }) => pool);
}

/** Keys from `offset` up, in list order. Unknown need gets no key. */
function needPlaces(pools: Record<string, NeedRow>, listed: string[], offset: number): Record<string, number> {
  const places: Record<string, number> = {};
  listed.forEach((pool, i) => {
    if (needOf(pools[pool]) !== null) places[pool] = offset + i;
  });
  return places;
}

/**
 * The order in force at `now`. With an active override its order comes first, then the remaining quota order.
 * `until` is never more than 30 minutes ahead of `now`, override or not.
 */
export function resolveDispatchPriority(pools: Record<string, NeedRow>, override: DispatchPriority | null, now: number): ResolvedPriority {
  const auto = quotaOrder(pools);
  const cap = now + PRIORITY_TTL_MS;
  const active = isPriorityActive(override, now) ? override : null;
  const rest = active ? auto.filter((pool) => !active.order.includes(pool)) : auto;
  const order = active ? [...active.order, ...rest] : auto;
  const needPerDay = Object.fromEntries(order.map((pool) => [pool, needOf(pools[pool])]));
  const fixed = active ? Object.fromEntries(active.order.map((pool, i) => [pool, i])) : {};
  const places = { ...fixed, ...needPlaces(pools, rest, active ? active.order.length : 0) };
  if (!active) return { order, until: new Date(cap).toISOString(), mode: "quota", needPerDay, places };
  const until = new Date(Math.min(cap, Date.parse(active.until))).toISOString();
  return { order, until, mode: "manual", needPerDay, places, overrideUntil: active.until };
}

/** dispatch-matrix.json `priority`: what Kanban reads (it only uses order and until). */
export function priorityView(priority: ResolvedPriority | null): { order: string[]; until: string; mode: PriorityMode } | undefined {
  return priority ? { order: [...priority.order], until: priority.until, mode: priority.mode } : undefined;
}

/** pool-status.json and the quota page: the matrix fields plus the numbers behind the order. */
export function poolStatusPriority(priority: ResolvedPriority): PriorityLineInput {
  return {
    order: [...priority.order],
    until: priority.until,
    mode: priority.mode,
    needPerDay: { ...priority.needPerDay },
    ...(priority.overrideUntil ? { overrideUntil: priority.overrideUntil } : {}),
  };
}

function tokyoStamp(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  const tokyo = new Date(ms + TOKYO_OFFSET_MS);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${tokyo.getUTCMonth() + 1}/${tokyo.getUTCDate()} ${pad(tokyo.getUTCHours())}:${pad(tokyo.getUTCMinutes())}`;
}

function needText(need: number | null | undefined, first: boolean): string {
  const known = typeof need === "number" && Number.isFinite(need);
  if (first) return known ? t("dispatch.priority.needFirst", { need: Math.round(need) }) : t("dispatch.priority.unreadFirst");
  return known ? t("dispatch.priority.need", { need: Math.round(need) }) : t("dispatch.priority.unread");
}

/**
 * "Dispatch order (automatic, by quota): Claude (still 33 pts/day to use)→SuperGrok (14)→GPT (14)", or
 * "Dispatch order (set by you, until 10/10 13:26): ..." while plans.json overrides it. Null with no order.
 */
/**
 * `shortNames`: pool id → short name (shared/quota-adapters.ts poolNames(catalog, "short")). Unknown pools show their id.
 */
export function priorityLine(priority: PriorityLineInput | null | undefined, shortNames: Readonly<Record<string, string>> = {}): string | null {
  if (!priority || priority.order.length === 0) return null;
  const names = priority.order
    .map((pool, i) => `${shortNames[pool] ?? pool}${needText(priority.needPerDay?.[pool], i === 0)}`)
    .join("→");
  const how = priority.mode === "manual"
    ? t("dispatch.priority.manual", { until: tokyoStamp(priority.overrideUntil ?? priority.until) })
    : t("dispatch.priority.auto");
  return t("dispatch.priority.line", { how, names });
}
