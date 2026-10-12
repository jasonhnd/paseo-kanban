/// <reference types="node" />
import { cardMark } from "./card-ref";
import { getDb } from "./db";
import { reasonSummary } from "../shared/labels";
import { t } from "../shared/i18n";

/** Appended when the second review rejection waits for a leader ruling. */
export const REVIEW_LEADER_HOLD = "review_leader_hold";

/**
 * Shown on the card until the leader rules. The scheduler must not start over it.
 * Callers compare the stored hold_reason with this text only to skip rewriting the same hold.
 */
export function leaderHoldReason(): string {
  return t("reviewHold.holdReason");
}

export interface HoldRound {
  reviewRound: number;
  kind: string;
  reason: string;
  findings: string;
}

function readData(raw: string): Record<string, unknown> {
  try {
    const data: unknown = JSON.parse(raw);
    return data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** True while the latest ruling event is still the round-2 hold. A later leader_rework or leader_pass clears it. */
export function awaitingLeaderHold(taskId: number): boolean {
  const row = getDb()
    .prepare(
      `SELECT kind FROM events WHERE task_id = ? AND kind IN ('review_leader_hold', 'leader_rework', 'leader_pass') ORDER BY id DESC LIMIT 1`,
    )
    .get(taskId) as { kind: string } | undefined;
  return row?.kind === REVIEW_LEADER_HOLD;
}

/** The rejection that already counted, before the one being recorded. Land conflicts are not in this list. */
export function previousCountedRejection(taskId: number): { kind: string; reason: string; findings: string } | null {
  const row = getDb()
    .prepare(
      `SELECT kind, data_json FROM events WHERE task_id = ? AND kind IN ('request_changes', 'rejected') ORDER BY id DESC LIMIT 1`,
    )
    .get(taskId) as { kind: string; data_json: string } | undefined;
  if (!row) return null;
  const data = readData(row.data_json);
  return { kind: row.kind, reason: text(data.reason), findings: text(data.findings) };
}

export interface RejectionView {
  at: string;
  kind: string;
  reason: string;
  findings: string;
}

function holdEventRounds(taskId: number): RejectionView[] {
  const row = getDb()
    .prepare(`SELECT at, data_json FROM events WHERE task_id = ? AND kind = ? ORDER BY id DESC LIMIT 1`)
    .get(taskId, REVIEW_LEADER_HOLD) as { at: string; data_json: string } | undefined;
  if (!row) return [];
  const rounds = readData(row.data_json).rounds;
  if (!Array.isArray(rounds)) return [];
  const out: RejectionView[] = [];
  rounds.forEach((item, index) => {
    if (!item || typeof item !== "object") return;
    const data = item as Record<string, unknown>;
    const reason = text(data.reason);
    const findings = text(data.findings);
    if (!reason && !findings) return;
    // Stored rounds carry no timestamp; the last one was recorded with the hold event.
    out.push({ at: index === rounds.length - 1 ? row.at : "", kind: text(data.kind) || "request_changes", reason, findings });
  });
  return out;
}

/** The two rejections behind the round-2 hold, oldest first. Reads the rounds stored on review_leader_hold, else the latest request_changes. */
export function lastRejections(taskId: number, count: number): RejectionView[] {
  const stored = holdEventRounds(taskId);
  if (stored.length > 0) return stored.slice(-count);
  const rows = getDb()
    .prepare(`SELECT at, data_json FROM events WHERE task_id = ? AND kind = 'request_changes' ORDER BY id DESC LIMIT ?`)
    .all(taskId, count) as Array<{ at: string; data_json: string }>;
  return rows.reverse().map((row) => {
    const data = readData(row.data_json);
    return { at: row.at, kind: "request_changes", reason: text(data.reason), findings: text(data.findings) };
  });
}

function roundLine(round: number, reason: string, findings: string): string {
  const head = reasonSummary(reason) || t("reviewHold.noReason");
  const extra = findings ? `${t("common.semicolon")}${reasonSummary(findings)}` : "";
  return t("reviewHold.roundLine", { round, head, extra });
}

/** Wake copy and the structured rounds stored on review_leader_hold. */
export function reviewHoldNotice(
  taskId: number,
  current: { reason: string; findings: string },
): { lead: string; next: string; rounds: HoldRound[] } {
  const prior = previousCountedRejection(taskId);
  const rounds: HoldRound[] = [
    {
      reviewRound: 1,
      kind: prior?.kind ?? "request_changes",
      reason: prior?.reason ?? "",
      findings: prior?.findings ?? "",
    },
    { reviewRound: 2, kind: "request_changes", reason: current.reason.trim(), findings: current.findings.trim() },
  ];
  const mark = cardMark(taskId);
  const lead = [
    t("reviewHold.lead.title"),
    t("reviewHold.lead.rounds"),
    roundLine(1, rounds[0].reason, rounds[0].findings),
    roundLine(2, rounds[1].reason, rounds[1].findings),
  ].join("\n");
  const next = [
    t("reviewHold.next.rework", { card: mark }),
    t("reviewHold.next.pass", { card: mark }),
    t("reviewHold.next.check"),
  ].join("");
  return { lead, next, rounds };
}

export function holdPayload(taskId: number): { lead: string; next: string } | null {
  const row = getDb()
    .prepare(`SELECT data_json FROM events WHERE task_id = ? AND kind = ? ORDER BY id DESC LIMIT 1`)
    .get(taskId, REVIEW_LEADER_HOLD) as { data_json: string } | undefined;
  if (!row) return null;
  const data = readData(row.data_json);
  const lead = text(data.lead);
  const next = text(data.next);
  if (!lead || !next) return null;
  return { lead, next };
}
