import type { PaseoApi } from "./paseo-api";
import { t, tAll } from "../../shared/fleet/i18n";
import type { LeaderSwapInput, LeaderSwapResult } from "../../shared/fleet/leader-command";
import type { LeaderUsageReport } from "../../shared/fleet/leader-usage";
import { contextLamp, supervisorSlots, type ShiftPorts, type ShiftAgent } from "../../shared/fleet/supervisor-shift";
import { readLeaderThresholds } from "./adapters/config";
import { inspectSupervisorShift, loadShiftAgent, readHandoffs, requestSupervisorShift } from "./supervisor-shift";
import { KANBAN_CONFIG } from "./decisions-maint";
import { kanbanProjectName } from "./paths";
import { readJson } from "./util";

/** Fresh host usage; deliberately avoids the homepage reader, which resumes queued shifts. */
export async function readLeaderUsage(paseo: PaseoApi, configPath = KANBAN_CONFIG, load = (id: string) => loadShiftAgent(paseo, id)): Promise<LeaderUsageReport> {
  const config = await readJson(configPath, {});
  const thresholds = readLeaderThresholds();
  const rows = await Promise.all(supervisorSlots(config, kanbanProjectName()).map(async slot => {
    const agent = await load(slot.agentId).catch(() => null);
    const tokens = agent?.contextTokens ?? null;
    const lamp = contextLamp(tokens, thresholds);
    return { ...slot, contextTokens: tokens, level: lamp === "red" ? "warning" as const : lamp === "yellow" ? "reminder" as const : lamp === "green" ? "normal" as const : "unknown" as const };
  }));
  return { generatedAt: new Date().toISOString(), thresholds, rows };
}

/** One orchestration path for the CLI and homepage, with persisted automatic continuation. */
export async function leaderSwap(paseo: PaseoApi, input: LeaderSwapInput, ports?: ShiftPorts): Promise<LeaderSwapResult> {
  const { slot, job, running, available, events, eventsOffset } = await inspectSupervisorShift(input.project);
  const result = (ok: boolean, message: string, next = job, plan: LeaderSwapResult["plan"] = null): LeaderSwapResult => ({ ok, dryRun: input.dryRun, message, job: next, plan, running, events, eventsOffset });
  if (!slot) return result(false, t("shift.server.notRegistered"));
  if (!available && input.action !== "cancel") return result(false, t("leader.swap.noKanban"));
  if (input.action === "status") return result(job?.phase !== "failed", job?.detail ?? t("leader.swap.ready"));
  if (input.dryRun && input.action === "cancel") return { ...result(true, t("leader.swap.cancelDryRun"), null), events: [], eventsOffset: 0 };
  if (input.dryRun) {
    const oldId = job && job.phase !== "done" ? job.oldId || slot.agentId : slot.agentId;
    const agent: ShiftAgent | null = await (ports?.getAgent(oldId) ?? loadShiftAgent(paseo, oldId));
    if (!agent) return result(false, t("shift.detail.notFound"));
    const { workspaceId, title, provider, model, modeId, thinkingOptionId, featureValues } = agent;
    return result(Boolean(workspaceId && provider && model), !workspaceId ? t("shift.detail.noWorkspace") : !provider || !model ? t("shift.detail.noModel") : t("leader.swap.dryRun"), job, { project: slot.project, agentId: oldId, workspaceId, title, provider, model, modeId, thinkingOptionId, featureValues });
  }
  if (input.action === "cancel") {
    if (running) return result(false, t("leader.swap.cancelRunning"));
    await requestSupervisorShift(paseo, slot.project, "cancel", ports);
    return { ...result(true, t("leader.swap.cancelled"), null), events: [], eventsOffset: 0 };
  }
  if (running) return result(true, t("shift.server.alreadyRunning"));
  if (!input.again) {
    if (job?.phase === "done" && job.newId === slot.agentId) return result(true, job.detail);
    if (!job) {
      const last = (await readHandoffs(Number.MAX_SAFE_INTEGER)).find(row => row.project === slot.code);
      if (last?.newId === slot.agentId && tAll("shift.result.done").includes(last.result)) {
        return result(true, t("shift.detail.done"), { phase: "done", label: t("shift.phase.done"), detail: t("shift.detail.done"), project: slot.project, code: slot.code, oldId: last.oldId, newId: last.newId, contextTokens: last.contextTokens, canContinue: false, canCancel: false, openAgentId: last.newId });
      }
    }
  }
  if (input.again && job && job.phase !== "done") return result(false, t("leader.swap.pending"));
  if (job?.phase === "failed" && !job.canContinue) return result(false, job.detail);
  const next = await requestSupervisorShift(paseo, slot.project, job && job.phase !== "done" ? "continue" : "start", ports);
  const state = await inspectSupervisorShift(slot.project);
  return { ...result(next.phase !== "failed", next.detail, state.job ?? next), running: state.running, events: state.events, eventsOffset: state.eventsOffset };
}
