import { z } from "zod";

export const CYCLE_KINDS = ["unknown", "day", "week", "month", "duration"] as const;
const instant = z.iso.datetime({ offset: true });
export const timeZoneSchema = z.string().refine(value => {
  try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; }
}, "Invalid IANA time zone");
const clock = { timeZone: timeZoneSchema, hour: z.number().int().min(0).max(23), minute: z.number().int().min(0).max(59) };
export const quotaCycleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("unknown") }),
  z.object({ kind: z.literal("day"), ...clock }),
  z.object({ kind: z.literal("week"), ...clock, weekday: z.number().int().min(0).max(6) }),
  z.object({ kind: z.literal("month"), ...clock, day: z.number().int().min(1).max(31) }),
  z.object({ kind: z.literal("duration"), seconds: z.number().int().positive().max(366 * 86400), startsAt: instant }),
]);
export type QuotaCycle = z.infer<typeof quotaCycleSchema>;
export const copiedQuotaSchema = z.object({
  usedPct: z.number().min(0).max(100), at: instant,
  source: z.string().trim().min(1).optional(), ttlSeconds: z.number().int().positive().max(366 * 86400).optional(),
  startsAt: instant.optional(), resetsAt: instant.optional(), cycleKey: z.string().optional(),
}).passthrough().refine(value => !value.startsAt || !value.resetsAt || Date.parse(value.startsAt) < Date.parse(value.resetsAt), "Invalid reading boundaries");
export type ManualReading = z.infer<typeof copiedQuotaSchema>;
export function cycleKey(cycle: QuotaCycle): string { return JSON.stringify(quotaCycleSchema.parse(cycle)); }

type Wall = { year: number; month: number; day: number; hour: number; minute: number };
const formatters = new Map<string, Intl.DateTimeFormat>();
function wallAt(ms: number, zone: string): Wall {
  let formatter = formatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-GB", { timeZone: zone, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", hourCycle: "h23" });
    formatters.set(zone, formatter);
  }
  const parts = Object.fromEntries(formatter.formatToParts(ms).map(part => [part.type, Number(part.value)]));
  return parts as Wall;
}
const wallMs = (wall: Wall) => Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
/** DST overlaps use the earlier instant; gaps move forward by the offset change. */
function instantOf(wall: Wall, zone: string): number {
  const nominal = wallMs(wall);
  const offsets = new Set<number>();
  for (let hours = -36; hours <= 36; hours += 6) {
    const sample = nominal + hours * 3600000;
    offsets.add(wallMs(wallAt(sample, zone)) - sample);
  }
  const candidates = [...offsets].map(offset => nominal - offset).sort((a, b) => a - b);
  const exact = candidates.filter(candidate => wallMs(wallAt(candidate, zone)) === nominal);
  if (exact.length) return exact[0];
  const forward = candidates.filter(candidate => wallMs(wallAt(candidate, zone)) > nominal);
  return forward.sort((a, b) => wallMs(wallAt(a, zone)) - wallMs(wallAt(b, zone)))[0] ?? candidates[0];
}
function dateShift(wall: Wall, days: number): Wall {
  const date = new Date(Date.UTC(wall.year, wall.month - 1, wall.day + days));
  return { ...wall, year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}
function monthWall(wall: Wall, offset: number, day: number): Wall {
  const date = new Date(Date.UTC(wall.year, wall.month - 1 + offset, 1));
  const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  return { ...wall, year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: Math.min(day, last) };
}
export interface CycleBounds { start: number; end: number }
/** Calendar cycles stay at the configured wall clock; durations are fixed elapsed seconds. */
export function cycleBounds(cycle: QuotaCycle, now: number): CycleBounds | null {
  if (!Number.isFinite(now) || cycle.kind === "unknown") return null;
  if (cycle.kind === "duration") {
    const anchor = Date.parse(cycle.startsAt), length = cycle.seconds * 1000;
    if (!Number.isFinite(anchor) || now < anchor) return null;
    const start = anchor + Math.floor((now - anchor) / length) * length;
    return { start, end: start + length };
  }
  const wall = { ...wallAt(now, cycle.timeZone), hour: cycle.hour, minute: cycle.minute };
  if (cycle.kind === "month") {
    const thisMonth = monthWall(wall, 0, cycle.day);
    const offset = instantOf(thisMonth, cycle.timeZone) > now ? -1 : 0;
    return { start: instantOf(monthWall(wall, offset, cycle.day), cycle.timeZone), end: instantOf(monthWall(wall, offset + 1, cycle.day), cycle.timeZone) };
  }
  const length = cycle.kind === "week" ? 7 : 1;
  const weekday = new Date(Date.UTC(wall.year, wall.month - 1, wall.day)).getUTCDay();
  let startWall = cycle.kind === "week" ? dateShift(wall, -((weekday - cycle.weekday + 7) % 7)) : wall;
  if (instantOf(startWall, cycle.timeZone) > now) startWall = dateShift(startWall, -length);
  return { start: instantOf(startWall, cycle.timeZone), end: instantOf(dateShift(startWall, length), cycle.timeZone) };
}
export function validPercent(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100; }

/** Explicit reset postponements require a new reading; changing a cycle invalidates its old copy. */
export function manualState(raw: unknown, cycle: QuotaCycle, now: number): { reading: ManualReading | null; state: "manual" | "stale" | "unknown"; bounds: CycleBounds | null } {
  const parsed = copiedQuotaSchema.safeParse(raw);
  const bounds = cycleBounds(cycle, now);
  if (!parsed.success) return { reading: null, state: "unknown", bounds };
  const reading = parsed.data, at = Date.parse(reading.at);
  const end = reading.resetsAt ? Date.parse(reading.resetsAt) : bounds?.end;
  const start = reading.startsAt ? Date.parse(reading.startsAt) : bounds?.start;
  const expired = at > now || now - at > (reading.ttlSeconds ?? 86400) * 1000
    || (end !== undefined && (now >= end || at >= end))
    || (start !== undefined && (at < start || now < start))
    || (bounds !== null && at < bounds.start)
    || (reading.cycleKey !== undefined && reading.cycleKey !== cycleKey(cycle));
  const explicit = start !== undefined && end !== undefined && start < end ? { start, end } : bounds;
  return { reading, state: expired ? "stale" : "manual", bounds: explicit };
}
