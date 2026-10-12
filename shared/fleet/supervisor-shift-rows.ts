// Which sessions the homepage lists, and the row each one gets.
import type { LeaderThresholds } from "./leader-usage";
import { tokyoDayStart } from "./dispatch";
import { t } from "./i18n";
import { contextLamp, formatContextTokens, formatStarted, formatTodayUsd, isBusy } from "./supervisor-shift-format";
import type { SupervisorAgentView, SupervisorConfig, SupervisorRow, SupervisorSlot } from "./supervisor-shift-types";


function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function codeFor(project: string, projects: Record<string, unknown>): string {
  const row = asRecord(projects[project]);
  const code = row.code;
  if (typeof code === "string" && code.trim()) return code.trim();
  return project;
}

/**
 * One row per registered project. `supervisorAgentId` (Kanban's own supervisor) is added only when that id is
 * not already listed, under `kanbanProject`, the board's name for the Kanban checkout.
 */
export function supervisorSlots(config: SupervisorConfig, kanbanProject = "paseo-kanban"): SupervisorSlot[] {
  const projects = asRecord(config.projects);
  const rows: SupervisorSlot[] = [];
  const ids = new Set<string>();
  const supers = asRecord(config.supervisors);
  for (const project of Object.keys(supers)) {
    const id = supers[project];
    if (typeof id !== "string" || !id.trim()) continue;
    const agentId = id.trim();
    rows.push({ project, code: codeFor(project, projects), agentId });
    ids.add(agentId);
  }
  const kanban = typeof config.supervisorAgentId === "string" ? config.supervisorAgentId.trim() : "";
  if (kanban && !ids.has(kanban)) {
    rows.push({ project: kanbanProject, code: codeFor(kanbanProject, projects), agentId: kanban });
  }
  return rows.sort((a, b) => a.code.localeCompare(b.code) || a.project.localeCompare(b.project));
}

export function buildSupervisorRows(input: {
  thresholds?: LeaderThresholds;
  slots: SupervisorSlot[];
  agents: SupervisorAgentView[];
  todayUsd: Record<string, number | null>;
  now: number;
  acceptanceByProject?: Record<string, string[] | null>;
}): SupervisorRow[] {
  const byId = new Map(input.agents.map((agent) => [agent.id, agent]));
  return input.slots.map((slot) => {
    const agent = byId.get(slot.agentId);
    const tokens = agent?.contextTokens ?? null;
    const lamp = contextLamp(tokens, input.thresholds);
    const found = agent?.found === true;
    return {
      project: slot.project,
      code: slot.code,
      agentId: slot.agentId,
      contextTokens: tokens,
      contextText: tokens === null ? t("shift.context.unreadable") : formatContextTokens(tokens),
      startedText: formatStarted(agent?.createdAt ?? null, input.now) ?? t("shift.started.unreadable"),
      todayText: formatTodayUsd(input.todayUsd[slot.agentId] ?? null),
      statusText: !found ? t("leader.status.notListed") : isBusy(agent?.status ?? "") ? t("leader.status.busy") : t("leader.status.idle"),
      lamp,
      lampText: lamp === "red" ? t("leader.usage.warning") : lamp === "yellow" ? t("leader.usage.reminder") : null,
      highlight: lamp === "yellow" || lamp === "red",
      handoverPath: agent?.handoverPath ?? null,
      handoverPreview: agent?.handoverPreview ?? null,
      acceptanceCards: input.acceptanceByProject?.[slot.project] ?? null,
    };
  });
}

export function sumTodayUsd(
  hits: Array<{ sessionId: string; hour: number; usd: number }>,
  sessionIds: string[],
  now: number,
): number | null {
  const ids = new Set(sessionIds.filter(Boolean));
  const start = tokyoDayStart(now);
  let sum = 0;
  let any = false;
  for (const hit of hits) {
    if (!ids.has(hit.sessionId) || hit.hour < start || !Number.isFinite(hit.usd)) continue;
    any = true;
    sum += hit.usd;
  }
  return any ? sum : null;
}
