import { t } from "./i18n";
import {
  cancelledLabel,
  isBusyStatusText,
  isCancelledLabel,
  keepShiftRow,
  phaseLabel,
  queueDetail,
  shiftInFlight,
  shiftStepIndex,
  shiftStepLabel,
  type ShiftPhase,
  type ShiftProgress,
} from "./supervisor-shift";
import { elapsedLabel } from "./leader-panel";

/** A row the screen invents before the server has answered. */
export function blankShiftJob(project: string, code: string, phase: ShiftPhase, detail: string): ShiftProgress {
  return {
    phase,
    label: shiftStepLabel(phase),
    detail,
    project,
    code,
    oldId: "",
    newId: null,
    contextTokens: null,
    canContinue: false,
    canCancel: phase === "queued",
    openAgentId: null,
  };
}

/**
 * The server job, unless this screen already moved further
 * (or the server row is a finished one from last time).
 */
export function preferShiftJob(remote: ShiftProgress | undefined, mine: ShiftProgress | undefined): ShiftProgress | undefined {
  if (!mine) return remote;
  if (!remote) return mine;
  if (remote.phase === "failed" && (shiftInFlight(mine.phase) || isCancelledLabel(mine.label))) return mine;
  if (remote.phase === "failed") return remote;
  if (remote.phase === "done" && mine.phase !== "done") return mine;
  if (shiftStepIndex(remote.phase) >= shiftStepIndex(mine.phase)) return remote;
  return mine;
}

/** Rows first, then a server job whose project is not already on screen. */
export function mergeShiftJobs(
  rowProjects: readonly string[],
  remoteJobs: readonly ShiftProgress[],
  local: Readonly<Record<string, ShiftProgress>>,
): ShiftProgress[] {
  const forRow = (project: string) => preferShiftJob(remoteJobs.find((job) => job.project === project), local[project]);
  const merged = rowProjects.map(forRow).filter((job): job is ShiftProgress => Boolean(job));
  const extra = remoteJobs
    .filter((job) => !merged.some((row) => row.project === job.project))
    .map((job) => preferShiftJob(job, local[job.project]) ?? job);
  return [...merged, ...extra];
}

export function shiftJobsKey(tasks: readonly Pick<ShiftProgress, "project" | "phase" | "label">[]): string {
  return tasks.map((job) => `${job.project}:${job.phase}:${job.label}`).join("|");
}

/** Same object when nothing changed, so the effect does not schedule another render. */
export function stampFinishedAt(
  prev: Readonly<Record<string, number>>,
  tasks: readonly Pick<ShiftProgress, "project" | "phase">[],
  now: number,
): Record<string, number> {
  let next: Record<string, number> | null = null;
  const current = () => next ?? prev;
  for (const job of tasks) {
    const value = current()[job.project];
    if (job.phase === "done" && value === undefined) next = { ...current(), [job.project]: now };
    if (job.phase !== "done" && value !== undefined) next = omitKey(current(), job.project);
  }
  return next ?? prev;
}

function omitKey(source: Readonly<Record<string, number>>, key: string): Record<string, number> {
  const copy = { ...source };
  delete copy[key];
  return copy;
}

/** Drop a dismissal once the job is no longer a failure or a cancel. */
export function releaseDismissed(
  prev: ReadonlySet<string>,
  tasks: readonly Pick<ShiftProgress, "project" | "phase" | "label">[],
): ReadonlySet<string> {
  const drop = tasks.filter((job) => prev.has(job.project) && job.phase !== "failed" && !isCancelledLabel(job.label));
  if (drop.length === 0) return prev;
  const next = new Set(prev);
  for (const job of drop) next.delete(job.project);
  return next;
}

export function dismissProject(prev: ReadonlySet<string>, project: string): Set<string> {
  return new Set(prev).add(project);
}

export function withLocalJob(
  prev: Readonly<Record<string, ShiftProgress>>,
  project: string,
  job: ShiftProgress,
): Record<string, ShiftProgress> {
  return { ...prev, [project]: job };
}

export function shiftTrackVisible(job: ShiftProgress | undefined, finishedAt: number | null, now: number): boolean {
  if (!job) return false;
  const stillThere = keepShiftRow(job.phase, finishedAt, now);
  const flying = shiftInFlight(job.phase);
  const settled = job.phase === "done" || (job.phase === "failed" && job.canContinue);
  return stillThere && (flying || settled);
}

export function failedLocalJob(current: ShiftProgress | undefined, project: string, error: unknown): ShiftProgress {
  return {
    phase: "failed",
    label: phaseLabel("failed"),
    detail: String(error).slice(0, 160),
    project,
    code: current?.code ?? "",
    oldId: current?.oldId ?? "",
    newId: current?.newId ?? null,
    contextTokens: current?.contextTokens ?? null,
    canContinue: false,
    canCancel: false,
    openAgentId: null,
  };
}

export function shiftArmId(current: ShiftProgress | undefined): string | null {
  return current?.phase === "done" ? current.openAgentId : null;
}

export function startOptimistic(project: string, code: string, statusText: string): ShiftProgress {
  const busy = isBusyStatusText(statusText);
  return blankShiftJob(project, code, busy ? "queued" : "handover", busy ? queueDetail() : t("shift.view.starting"));
}

export function retryOptimistic(project: string, code: string, action: "start" | "continue"): ShiftProgress {
  return blankShiftJob(project, code, action === "continue" ? "waiting" : "handover", t("shift.view.retrying"));
}

export function cancelOptimistic(job: ShiftProgress): ShiftProgress {
  return { ...job, phase: "failed", label: cancelledLabel(), detail: t("shift.detail.cancelled"), canContinue: false, canCancel: false };
}

export function continueOptimistic(job: ShiftProgress): ShiftProgress {
  return { ...job, canContinue: false, detail: t("shift.view.continuing") };
}

export function clockMs(generatedAt: string, fallback: number): number {
  return Date.parse(generatedAt) || fallback;
}

export function leaderStatusLine(statusText: string, lastReplyAt: string | null | undefined, nowMs: number): string {
  const reply = lastReplyAt ? t("leader.lastReply.ago", { elapsed: elapsedLabel(lastReplyAt, nowMs) }) : t("leader.lastReply.unreadable");
  return `${statusText} · ${reply}`;
}

export function hasUnreadReply(decisions: readonly { kind: string; agentId: string | null }[], agentId: string): boolean {
  return decisions.some((row) => row.kind === "unread" && row.agentId === agentId);
}

export function leaderContextLine(row: { contextText: string; statusText: string; lamp: string; lampText: string | null }): string {
  const normal = row.lamp === "green" ? ` · ${t("leader.lamp.normal")}` : "";
  const lamp = row.lampText ? ` · ${row.lampText}` : "";
  return `${row.contextText} · ${row.statusText}${normal}${lamp}`;
}

export function unresponsiveLine(count: number): string | null {
  if (count <= 0) return null;
  return t("leader.unresponsiveLine", { count });
}
