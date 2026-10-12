// What the homepage shows while a shift is on screen, and the one-shot open of the new session.
import { t, tAll } from "./i18n";
import { isCancelledLabel, phaseLabel, SHIFT_DONE_HOLD_MS, type ShiftPhase, type ShiftProgress, type ShiftResume } from "./supervisor-shift-types";

/** Five visible steps. Detach is part of opening the new session. */
export function shiftBarSteps(): string[] {
  return (["queued", "handover", "opening", "waiting", "done"] as const).map(phaseLabel);
}

export function shiftStepIndex(phase: ShiftPhase): number {
  if (phase === "queued") return 0;
  if (phase === "handover") return 1;
  if (phase === "opening" || phase === "detaching") return 2;
  if (phase === "waiting") return 3;
  if (phase === "done") return 4;
  return -1;
}

export function shiftStepLabel(phase: ShiftPhase): string {
  return phaseLabel(phase);
}

/**
 * Top-of-home sentence while a shift is on screen.
 * A failure names the last attempt and why. Done and cancelled go back to the normal sentence.
 */
export function shiftHeadline(
  tasks: readonly Pick<ShiftProgress, "phase" | "code" | "project" | "label" | "detail">[],
): string | null {
  const active = tasks.find((job) => job.phase !== "done" && !isCancelledLabel(job.label));
  if (!active) return null;
  const name = active.code || active.project;
  if (active.phase === "failed") {
    const reason = active.detail.trim() || active.label;
    return t("shift.headline.failed", { name, reason });
  }
  return t("shift.headline.running", { name, label: active.label });
}

/** Drop a failure from the top line after the user hits Retry or Cancel on that shift. */
export function jobsForHeadline<T extends { phase: ShiftPhase; project: string; label: string }>(
  tasks: readonly T[],
  dismissed: ReadonlySet<string>,
): T[] {
  return tasks.filter((job) => !(dismissed.has(job.project) && (job.phase === "failed" || isCancelledLabel(job.label))));
}

/** Finished rows stay for 10 minutes, then leave. Anything still running stays. */
export function keepShiftRow(phase: ShiftPhase, finishedAt: number | null, now: number): boolean {
  if (phase !== "done") return true;
  if (finishedAt === null) return true;
  return now - finishedAt < SHIFT_DONE_HOLD_MS;
}

/**
 * A live queue keeps the clock from the click that started it.
 * Retrying after that queue failed (or any fresh start) gets a new 30 minutes.
 */
export function queueStartedAt(
  action: "start" | "continue",
  saved: { resume: ShiftResume; queuedAt: number | null } | null | undefined,
  now: number,
): number {
  if (action === "continue" && saved?.resume === "queue" && typeof saved.queuedAt === "number") return saved.queuedAt;
  return now;
}

/** True when a row detail offers the Continue button (in any language: the detail may be stored). */
function mentionsContinue(detail: string): boolean {
  return tAll("shift.button.continue").some((word) => detail.includes(word));
}

/** Retry after a queue timeout starts over. Continue only when a later step already said so. */
export function retryShiftAction(job: Pick<ShiftProgress, "phase" | "canContinue" | "newId" | "detail">): "start" | "continue" {
  if (job.phase === "failed" && !job.newId && !mentionsContinue(job.detail)) return "start";
  if (job.canContinue && (job.newId || mentionsContinue(job.detail))) return "continue";
  return "start";
}

export function agentToOpen(progress: ShiftProgress): string | null {
  return progress.phase === "done" ? progress.openAgentId : null;
}

const armedOpens = new Map<string, string | null>();
const openedShiftIds = new Set<string>();

/**
 * Remember that this screen started a shift.
 * `alreadyDoneId` is a finished session already on screen; that one must not be opened again.
 */
export function armShiftOpen(project: string, alreadyDoneId: string | null): void {
  armedOpens.set(project, alreadyDoneId);
}

export function disarmShiftOpen(project: string): void {
  armedOpens.delete(project);
}

/**
 * Open the new session once, and only for a shift armed by a click on this screen.
 * A finished job left in memory does not open again after a tab change or a reload of the view.
 */
export function consumeShiftOpen(project: string, job: ShiftProgress | undefined): string | null {
  if (!armedOpens.has(project)) return null;
  const id = job ? agentToOpen(job) : null;
  if (!id || id === armedOpens.get(project) || openedShiftIds.has(id)) return null;
  openedShiftIds.add(id);
  armedOpens.delete(project);
  return id;
}

export function resetShiftOpenForTests(): void {
  armedOpens.clear();
  openedShiftIds.clear();
}

export function shiftInFlight(phase: ShiftPhase | undefined): boolean {
  return phase === "queued" || phase === "handover" || phase === "opening" || phase === "detaching" || phase === "waiting";
}

export function shiftOpen(phase: ShiftPhase | undefined): boolean {
  return shiftInFlight(phase);
}
