/** Homepage status sentence, badge, and how decisions split on the home list. Display only. */
import { t, tAll } from "./i18n";

export type DecisionKind = "decide" | "unread";

export interface HomeDecision {
  blocking: boolean;
  kind: DecisionKind;
}

export interface HomeAlert {
  level: "red" | "yellow" | "info";
  kind: string;
  text: string;
}

export interface HomeStatusCounts {
  blocking: number;
  relaxed: number;
  unread: number;
  problems: number;
}

/**
 * "Crashed in the last 24 hours, none today yet" is a history note, not something happening now.
 * The crash check (shared/daemon-crash.ts) raises it as the only yellow daemon-crash alert; today's crashes are red.
 */
export function isHistoricalCrashHint(alert: HomeAlert): boolean {
  return alert.level === "yellow" && tAll("daemon.crash.kind").includes(alert.kind);
}

/** Errors, permission waits, stuck work, today's crashes, missing directories, and similar. */
export function isCurrentProblem(alert: HomeAlert): boolean {
  if (alert.level === "info") return false;
  return !isHistoricalCrashHint(alert);
}

export function partitionHomeDecisions<T extends HomeDecision>(items: readonly T[]): {
  blocking: T[];
  relaxed: T[];
  unread: T[];
} {
  const blocking: T[] = [];
  const relaxed: T[] = [];
  const unread: T[] = [];
  for (const item of items) {
    if (item.kind === "unread") unread.push(item);
    else if (item.blocking) blocking.push(item);
    else relaxed.push(item);
  }
  return { blocking, relaxed, unread };
}

export function homeCounts(data: { decisions: readonly HomeDecision[]; alerts: readonly HomeAlert[] }): HomeStatusCounts {
  const parts = partitionHomeDecisions(data.decisions);
  return {
    blocking: parts.blocking.length,
    relaxed: parts.relaxed.length,
    unread: parts.unread.length,
    problems: data.alerts.filter(isCurrentProblem).length,
  };
}

/** Tab badge: blocking decisions, unread replies, and problems happening now. Relaxed items stay off it. */
export function homeBadgeCount(counts: Pick<HomeStatusCounts, "blocking" | "unread" | "problems">): number {
  return counts.blocking + counts.unread + counts.problems;
}

export function homeStatusLine(counts: HomeStatusCounts): string {
  const decide: string[] = [];
  if (counts.blocking > 0) decide.push(t("home.status.blocking", { count: counts.blocking }));
  if (counts.relaxed > 0) decide.push(t("home.status.relaxed", { count: counts.relaxed }));
  const clauses: string[] = [];
  if (decide.length > 0) clauses.push(decide.join(t("home.status.commaSep")));
  if (counts.unread > 0) clauses.push(t("home.status.unread", { count: counts.unread }));
  let line = clauses.join(t("home.status.clauseSep"));
  if (counts.problems > 0) {
    const problem = t("home.status.problems", { count: counts.problems, where: t("home.status.seeBelow") });
    line = line ? t("home.status.thenProblem", { line, problem }) : problem;
  }
  return line || t("home.status.allClear");
}

/** Red when something is happening now; yellow when work is blocked or a reply is unread. */
export function homeStatusTone(counts: HomeStatusCounts): "danger" | "warning" | "success" {
  if (counts.problems > 0) return "danger";
  if (counts.blocking > 0 || counts.unread > 0) return "warning";
  return "success";
}
