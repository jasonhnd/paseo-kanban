/// <reference types="node" />
import type { KanbanConfig } from "./config";

/** Thresholds for `bin/kanban doctor`, moved out of config.ts unchanged (DEMO_0001). config.ts re-exports them. */

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Hours a blocked card may sit before doctor reports it, by blocked_kind. */
export interface DoctorBlockedHours {
  dependency: number;
  needs_human: number;
  capability: number;
  quota: number;
  rate_limit: number;
  transient: number;
}

/** Read-only checkup. Times are milliseconds unless the name says Hours or Minutes. */
export interface DoctorSettings {
  /** How often the scheduler runs a checkup. */
  intervalMs: number;
  blockedHours: DoctorBlockedHours;
  /** acceptance with nobody accepting. */
  acceptanceHours: number;
  /** ready this long, and the hold is not a normal queue, is reported. */
  readyHours: number;
  /** land_pending, including conflicts. */
  landPendingMinutes: number;
  /** cleanup ok:false whose retryAt (or the row itself) is this far in the past. */
  cleanupStaleHours: number;
  /** Last scheduler tick older than this. */
  tickStaleMs: number;
  /** Quota snapshot older than this. */
  quotaStaleMs: number;
  /** Dispatch matrix generatedAt older than this. */
  matrixStaleMs: number;
  /** The whole checkup stops starting new work after this. */
  totalTimeoutMs: number;
  /** One git or gh command. */
  commandTimeoutMs: number;
}

export const DEFAULT_DOCTOR_BLOCKED_HOURS: DoctorBlockedHours = {
  dependency: 48,
  needs_human: 8,
  capability: 8,
  quota: 24,
  rate_limit: 4,
  transient: 2,
};

export const DEFAULT_DOCTOR: DoctorSettings = {
  intervalMs: 30 * 60_000,
  blockedHours: { ...DEFAULT_DOCTOR_BLOCKED_HOURS },
  acceptanceHours: 8,
  readyHours: 12,
  landPendingMinutes: 30,
  cleanupStaleHours: 2,
  tickStaleMs: 5 * 60_000,
  quotaStaleMs: 30 * 60_000,
  matrixStaleMs: 24 * 60 * 60_000,
  totalTimeoutMs: 90_000,
  commandTimeoutMs: 8_000,
};

function doctorBlockedHours(value: unknown): DoctorBlockedHours {
  const next = { ...DEFAULT_DOCTOR_BLOCKED_HOURS };
  if (!value || typeof value !== "object") return next;
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(next) as (keyof DoctorBlockedHours)[]) {
    next[key] = positiveNumber(raw[key], next[key]);
  }
  return next;
}

export function doctorSettings(config: Pick<KanbanConfig, "doctor"> | null | undefined): DoctorSettings {
  const raw = config?.doctor;
  if (!raw) return { ...DEFAULT_DOCTOR, blockedHours: { ...DEFAULT_DOCTOR_BLOCKED_HOURS } };
  return {
    intervalMs: positiveNumber(raw.intervalMs, DEFAULT_DOCTOR.intervalMs),
    blockedHours: doctorBlockedHours(raw.blockedHours),
    acceptanceHours: positiveNumber(raw.acceptanceHours, DEFAULT_DOCTOR.acceptanceHours),
    readyHours: positiveNumber(raw.readyHours, DEFAULT_DOCTOR.readyHours),
    landPendingMinutes: positiveNumber(raw.landPendingMinutes, DEFAULT_DOCTOR.landPendingMinutes),
    cleanupStaleHours: positiveNumber(raw.cleanupStaleHours, DEFAULT_DOCTOR.cleanupStaleHours),
    tickStaleMs: positiveNumber(raw.tickStaleMs, DEFAULT_DOCTOR.tickStaleMs),
    quotaStaleMs: positiveNumber(raw.quotaStaleMs, DEFAULT_DOCTOR.quotaStaleMs),
    matrixStaleMs: positiveNumber(raw.matrixStaleMs, DEFAULT_DOCTOR.matrixStaleMs),
    totalTimeoutMs: positiveNumber(raw.totalTimeoutMs, DEFAULT_DOCTOR.totalTimeoutMs),
    commandTimeoutMs: positiveNumber(raw.commandTimeoutMs, DEFAULT_DOCTOR.commandTimeoutMs),
  };
}
