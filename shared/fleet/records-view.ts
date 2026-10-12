import type { BoardInsights, BoardSnapshot } from "./board";
import { roleLabel as dispatchRoleLabel } from "./dispatch";
import { type MessageKey, t } from "./i18n";

const SWEEP_RESULT_LABEL: Record<BoardSnapshot["sweep"]["entries"][number]["result"], MessageKey> = {
  archived: "records.sweep.archived",
  failed: "records.sweep.failed",
  would_archive: "records.sweep.wouldArchive",
  aborted: "records.sweep.aborted",
};

export function recordsAttention(data: Pick<BoardInsights, "unreviewedMerges" | "models">): number {
  return data.unreviewedMerges.length + data.models.filter((model) => model.isNew).length;
}

export function freshModels<T extends { isNew: boolean }>(models: readonly T[]): T[] {
  return models.filter((model) => model.isNew);
}

export function sortByRuns<T extends { runs: number }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => b.runs - a.runs);
}

export function roleLabel(role: string, known?: string): string {
  return known ?? dispatchRoleLabel(role) ?? role;
}

export function kanbanCountSummary(available: boolean, counts: readonly { count: number }[]): string {
  if (!available) return t("records.unreadable");
  return t("records.cards", { count: counts.reduce((sum, row) => sum + row.count, 0) });
}

export function waitingCountSummary(queueShown: boolean, waiting: number): string {
  return queueShown ? t("records.cards", { count: waiting }) : t("records.unreadable");
}

export function scheduleStatusLine(
  row: Pick<BoardSnapshot["schedules"][number], "cadence" | "status" | "nextRunAt" | "owner" | "idle">,
  nextRun: string,
): string {
  const status = row.status !== "active" ? ` · ${row.status}` : "";
  const next = row.nextRunAt ? t("records.schedule.next", { when: nextRun }) : "";
  const owner = row.owner ? t("records.schedule.owner", { owner: row.owner }) : "";
  const idle = row.idle ? t("records.schedule.idle") : "";
  return `${row.cadence}${status}${next}${owner}${idle}`;
}

export function scheduleLastLine(
  row: Pick<BoardSnapshot["schedules"][number], "lastResult" | "lastOutput">,
  lastRun: string,
): string | null {
  if (!row.lastResult) return null;
  const result = row.lastResult === "succeeded" ? t("records.schedule.succeeded") : row.lastResult;
  const output = row.lastOutput ? ` · ${row.lastOutput}` : "";
  return t("records.schedule.last", { when: lastRun, result, output });
}

export function scheduleIsQuiet(row: Pick<BoardSnapshot["schedules"][number], "status" | "idle">): boolean {
  return row.status !== "active" || !row.idle;
}

export function handoffClock(at: string): string {
  return at.replace("T", " ").slice(0, 16);
}

export function handoffMove(
  line: Pick<BoardSnapshot["supervisorPanel"]["handoffs"][number], "oldId" | "newId" | "contextTokens" | "result">,
  tokens: string | null,
): string {
  const next = line.newId ? line.newId.slice(0, 8) : t("records.handoff.noNewSession");
  const ctx = line.contextTokens === null || tokens === null ? "" : t("records.handoff.before", { tokens });
  return `${line.oldId.slice(0, 8)} → ${next}${ctx} · ${line.result}`;
}

export function reversed<T>(rows: readonly T[]): T[] {
  return [...rows].reverse();
}

export function changeClock(at: string): string {
  return at.replace("T", " ");
}

export function sweepHeadline(entry: BoardSnapshot["sweep"]["entries"][number]): string {
  const label = t(SWEEP_RESULT_LABEL[entry.result]);
  const hours = entry.idleHours !== null ? t("records.sweep.idleHours", { hours: entry.idleHours }) : "";
  return `${entry.at.replace("T", " ")} · ${label}${hours}`;
}

export function sweepAlarm(result: BoardSnapshot["sweep"]["entries"][number]["result"]): boolean {
  return result === "failed" || result === "aborted";
}

export function sweepTitleLine(title: string, agentId: string | null): string | null {
  if (!title) return null;
  return `${title}${agentId ? ` · ${agentId.slice(0, 8)}` : ""}`;
}

export function baselinePrefix(at: string | null): string {
  return at ? t("records.baseline", { date: at.slice(0, 10) }) : "";
}

export function providerList(models: readonly { provider: string }[]): string {
  return [...new Set(models.map((model) => model.provider))].join(t("records.listJoin"));
}

export function usedModels(models: readonly { usedBy: readonly string[]; id: string }[]): string {
  const used = models.filter((model) => model.usedBy.length).map((model) => `${model.usedBy.join("/")}=${model.id}`);
  return used.join(t("records.usedJoin")) || t("records.none");
}
