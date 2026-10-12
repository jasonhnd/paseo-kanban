import { t, tAll } from "./i18n";

/** On the overview, point "see below" at the Leader tab instead. */
export function homeHeadline(line: string): string {
  const target = tAll("home.status.seeBelow").find((text) => line.includes(text));
  return target ? line.replace(target, t("home.status.seeLeader")) : line;
}

export function statusColorKey(tone: "danger" | "warning" | "success"): "red" | "amber" | "green" {
  if (tone === "danger") return "red";
  if (tone === "warning") return "amber";
  return "green";
}

export function waitingSummary(available: boolean, cards: number): string {
  return available ? t("home.summary.cards", { count: cards }) : t("home.summary.kanbanUnreadable");
}

export function decisionSummary(count: number, unread: number): string {
  return t("home.summary.decisions", { count }) + (unread > 0 ? t("home.summary.newReplies", { count: unread }) : "");
}

export function companyHeadline(company: { name: string; headline: string }): string {
  return `${company.name} · ${company.headline}`;
}

export function leaderLampKey(paused: boolean, lamp: string): "red" | "amber" | "green" | "hint" {
  if (paused) return "hint";
  if (lamp === "red") return "red";
  if (lamp === "yellow") return "amber";
  if (lamp === "green") return "green";
  return "hint";
}

export function leaderDots<T extends { project: string; code: string; contextText: string; statusText: string; lamp: string; lampText: string | null }>(
  rows: readonly T[],
  paused: (project: string) => boolean,
): Array<{ project: string; code: string; paused: boolean; lamp: string; label: string; a11y: string }> {
  return [...rows].sort((a, b) => a.code.localeCompare(b.code)).map((row) => dotOf(row, paused(row.project)));
}

function dotOf(
  row: { project: string; code: string; contextText: string; statusText: string; lamp: string; lampText: string | null },
  paused: boolean,
): { project: string; code: string; paused: boolean; lamp: string; label: string; a11y: string } {
  const label = paused ? t("home.dot.paused", { code: row.code }) : row.code;
  const a11y = paused
    ? t("home.dot.pausedA11y", { code: row.code })
    : t("home.dot.a11y", { code: row.code, context: row.contextText, status: row.statusText, lamp: row.lampText ?? t("home.dot.normal") });
  return { project: row.project, code: row.code, paused, lamp: row.lamp, label, a11y };
}
