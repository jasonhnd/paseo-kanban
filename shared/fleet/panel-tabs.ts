import type { BoardInsights, BoardSnapshot } from "./board";
import { withoutPaused } from "./paused";
import { homeCounts } from "./home-status";
import { leaderSummary } from "./leader-panel";
import { PAGE_ROLES } from "./roles-page";
import { t } from "./i18n";

/** Tab ids in order; `label` is read at render time so it follows the panel language. */
export const PANEL_TABS = [
  { id: "overview", get label() { return t("tabs.overview"); } },
  { id: "leader", label: "Leader" },
  { id: "quota", get label() { return t("tabs.quota"); } },
  { id: "usage", get label() { return t("tabs.usage"); } },
  { id: "roles", get label() { return t("tabs.roles"); } },
  { id: "records", get label() { return t("tabs.records"); } },
  { id: "access", get label() { return t("tabs.access"); } },
] as const;
export const PANEL_TAB_IDS = ["overview", "leader", "quota", "usage", "roles", "records", "access"] as const;
export type PanelTab = (typeof PANEL_TAB_IDS)[number];

export function isPanelTab(value: unknown): value is PanelTab {
  return PANEL_TABS.some((tab) => tab.id === value);
}

export function panelTabLabel(tab: PanelTab): string {
  return PANEL_TABS.find(t=>t.id === tab)!.label;
}

export function panelAttention(data: Pick<BoardSnapshot, "decisions" | "kanban"> & Partial<Pick<BoardSnapshot, "pausedProjects">>) {
  const decisions = withoutPaused(data.decisions, data.pausedProjects).filter((row) => row.kind === "decide" && row.source !== "Kanban");
  const blocked = data.kanban.available
    ? data.kanban.counts.find((row) => row.status === "blocked")?.count ?? 0
    : data.decisions.filter((row) => row.kind === "decide" && row.source === "Kanban").length;
  const acceptance = data.kanban.available
    ? data.kanban.counts.find((row) => row.status === "acceptance")?.count ?? 0
    : 0;
  return {
    decisions: decisions.length,
    waitingCards: blocked + acceptance,
    leader: decisions.length + blocked + acceptance,
    blocking: blocked > 0 || decisions.some((row) => row.blocking),
  };
}

/** Counts refer to actionable items, monitored companies, roles, and registered services. */
export function panelTabBadges(data?: BoardSnapshot, insights?: BoardInsights, services = 0): Record<PanelTab, { count: number; danger: boolean }> {
  const attention = data ? panelAttention(data) : { leader: 0, blocking: false };
  const status = data ? homeCounts({ ...data, decisions: withoutPaused(data.decisions, data.pausedProjects) }) : { unread: 0, problems: 0 };
  return {
    overview: { count: attention.leader + status.unread + status.problems, danger: attention.blocking || status.problems > 0 },
    leader: { count: data?.supervisorPanel?.details ? leaderSummary(data.supervisorPanel.rows, data.supervisorPanel.details, data.decisions, data.pausedProjects).waitingItems : attention.leader, danger: attention.blocking },
    quota: { count: data?.home.companies.length ?? 0, danger: false },
    usage: { count: data?.home.roleCards.length ?? 0, danger: false },
    roles: { count: PAGE_ROLES.length, danger: false },
    records: { count: (insights?.unreviewedMerges.length ?? 0) + (insights?.models.filter((model) => model.isNew).length ?? 0), danger: false },
    access: { count: services, danger: false },
  };
}
