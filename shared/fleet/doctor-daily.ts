import type { DoctorFinding, DoctorReport } from "./doctor";
import { t } from "./i18n";

// The daily 08:30 (Asia/Tokyo) run: when it is due, which reds are new today, and the line sent to the <leader>.

export const DAILY_HOUR = 8;
export const DAILY_MINUTE = 30;
const TOKYO = "Asia/Tokyo";

export interface DoctorDailyState {
  /** Tokyo date (YYYY-MM-DD) of the last daily run. */
  lastRunDay: string;
  /** Reds already announced, only valid for `day`. */
  notified: { day: string; keys: string[] };
  /** A notice that could not be sent; retried the same day only. */
  pending: { day: string; text: string; keys: string[] } | null;
}

export const emptyDailyState = (): DoctorDailyState => ({ lastRunDay: "", notified: { day: "", keys: [] }, pending: null });

export function normalizeDailyState(raw: unknown): DoctorDailyState {
  const row = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const notified = typeof row.notified === "object" && row.notified !== null ? (row.notified as Record<string, unknown>) : {};
  const pending = typeof row.pending === "object" && row.pending !== null ? (row.pending as Record<string, unknown>) : null;
  return {
    pending: pending && typeof pending.day === "string" && typeof pending.text === "string"
      ? { day: pending.day, text: pending.text, keys: Array.isArray(pending.keys) ? pending.keys.filter((key): key is string => typeof key === "string") : [] }
      : null,
    lastRunDay: typeof row.lastRunDay === "string" ? row.lastRunDay : "",
    notified: {
      day: typeof notified.day === "string" ? notified.day : "",
      keys: Array.isArray(notified.keys) ? notified.keys.filter((key): key is string => typeof key === "string") : [],
    },
  };
}

export function tokyoClock(now: number): { day: string; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: TOKYO, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(now));
  const at = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  return { day: `${at("year")}-${at("month")}-${at("day")}`, minutes: Number(at("hour")) * 60 + Number(at("minute")) };
}

/** Due once per Tokyo day, from 08:30 on. A run that was missed (plugin was down) is caught up later the same day. */
export function dailyRunDue(now: number, state: DoctorDailyState): boolean {
  const clock = tokyoClock(now);
  return clock.minutes >= DAILY_HOUR * 60 + DAILY_MINUTE && state.lastRunDay !== clock.day;
}

export function redFindings(report: DoctorReport): Array<DoctorFinding & { title: string }> {
  return report.items.flatMap((item) => item.findings.filter((row) => row.status === "red").map((row) => ({ ...row, title: item.title })));
}

/** Reds not yet announced today. */
export function newReds(report: DoctorReport, state: DoctorDailyState, day: string): Array<DoctorFinding & { title: string }> {
  const done = new Set(state.notified.day === day ? state.notified.keys : []);
  return redFindings(report).filter((row) => !done.has(row.key));
}

export function recordNotified(state: DoctorDailyState, day: string, keys: string[]): DoctorDailyState {
  const kept = state.notified.day === day ? state.notified.keys : [];
  return { ...state, notified: { day, keys: [...new Set([...kept, ...keys])] } };
}

const MAX_LISTED = 8;

export function doctorNotice(reds: Array<DoctorFinding & { title: string }>, day: string): string {
  const lines = reds.slice(0, MAX_LISTED).map((row) => t("doctor.daily.line", { title: row.title, text: row.text }));
  if (reds.length > MAX_LISTED) lines.push(t("doctor.daily.more", { count: reds.length - MAX_LISTED }));
  return t("doctor.daily.notice", { day, count: reds.length, lines: lines.join("\n") });
}

/** One history line: small on purpose, the full report is one `bin/afc-doctor --json` away. */
export function historyLine(report: DoctorReport): string {
  return JSON.stringify({
    at: report.at,
    worst: report.worst,
    counts: report.counts,
    items: report.items.map((item) => ({ id: item.id, status: item.status, summary: item.summary, reds: item.findings.filter((row) => row.status === "red").map((row) => row.key) })),
  });
}
