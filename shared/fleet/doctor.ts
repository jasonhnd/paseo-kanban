import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { type MessageKey, t } from "./i18n";

// One-click health check. Types, the RPC, exit codes and the plain-text table.
// The checks themselves are in doctor-checks.ts (pure) and server/doctor.ts (reads the machine, read-only).

export type DoctorStatus = "green" | "yellow" | "red";

/** One thing a check found. `key` is stable across runs so the same red is only announced once a day. */
export interface DoctorFinding {
  key: string;
  status: DoctorStatus;
  text: string;
}

export interface DoctorItem {
  id: string;
  title: string;
  status: DoctorStatus;
  /** One plain-language sentence. */
  summary: string;
  /** Files or commands the verdict rests on. */
  evidence: string[];
  findings: DoctorFinding[];
}

export interface DoctorReport {
  at: string;
  durationMs: number;
  counts: { red: number; yellow: number; green: number };
  worst: DoctorStatus;
  items: DoctorItem[];
}

const RANK: Record<DoctorStatus, number> = { green: 0, yellow: 1, red: 2 };

export function worstStatus(statuses: readonly DoctorStatus[]): DoctorStatus {
  return statuses.reduce<DoctorStatus>((worst, next) => (RANK[next] > RANK[worst] ? next : worst), "green");
}

export function makeItem(input: { id: string; title: string; summary: string; evidence: string[]; findings: DoctorFinding[] }): DoctorItem {
  return { ...input, status: worstStatus(input.findings.map((finding) => finding.status)) };
}

export function buildReport(items: DoctorItem[], at: string, durationMs: number): DoctorReport {
  const counts = { red: 0, yellow: 0, green: 0 };
  for (const item of items) counts[item.status] += 1;
  return { at, durationMs, counts, worst: worstStatus(items.map((item) => item.status)), items };
}

/** Process exit code for `bin/afc-doctor`: any red 2, else any yellow 1, else 0. */
export function doctorExitCode(report: Pick<DoctorReport, "worst">): 0 | 1 | 2 {
  return report.worst === "red" ? 2 : report.worst === "yellow" ? 1 : 0;
}

const STATUS_KEY: Record<DoctorStatus, MessageKey> = { green: "doctor.status.green", yellow: "doctor.status.yellow", red: "doctor.status.red" };

/** The status word shown on badges and in the table. */
export function statusLabel(status: DoctorStatus): string {
  return t(STATUS_KEY[status]);
}

const TABLE_MAX_LISTED = 12;
const STATUS_DOT: Record<DoctorStatus, string> = { green: "🟢", yellow: "🟡", red: "🔴" };

/** The table `bin/afc-doctor` prints by default. */
export function formatDoctorTable(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push(t("doctor.table.header", { at: report.at, seconds: (report.durationMs / 1000).toFixed(1) }));
  lines.push(t("doctor.table.counts", report.counts));
  lines.push("");
  for (const item of report.items) {
    lines.push(`${STATUS_DOT[item.status]} ${statusLabel(item.status)}  ${item.title} — ${item.summary}`);
    // Long lists (every profile, every card) show only what is not green; --json has all of it.
    const compact = item.findings.length > TABLE_MAX_LISTED;
    const shown = item.findings.filter((finding) => !compact || finding.status !== "green");
    for (const finding of shown) lines.push(`      ${STATUS_DOT[finding.status]} ${finding.text}`);
    if (compact) lines.push(`      ${t("doctor.table.compact", { total: item.findings.length, hidden: item.findings.length - shown.length })}`);
    for (const evidence of item.evidence) lines.push(`      ${t("doctor.table.evidence", { evidence })}`);
  }
  return lines.join("\n");
}

const doctorFindingShape = z.object({ key: z.string(), status: z.enum(["green", "yellow", "red"]), text: z.string() });
const itemSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(["green", "yellow", "red"]),
  summary: z.string(),
  evidence: z.array(z.string()),
  findings: z.array(doctorFindingShape),
});

export const doctorRpc = defineRpc({
  name: "board.doctor",
  input: z.object({}),
  output: z.object({
    at: z.string(),
    durationMs: z.number(),
    counts: z.object({ red: z.number(), yellow: z.number(), green: z.number() }),
    worst: z.enum(["green", "yellow", "red"]),
    items: z.array(itemSchema),
  }),
});
