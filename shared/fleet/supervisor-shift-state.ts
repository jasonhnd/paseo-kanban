// Shift state written outside git (so a reload can show it again) and the handoff log.
import { phaseLabel, type HandoffLogLine, type ShiftPhase, type ShiftProgress, type ShiftResume, type StoredShift } from "./supervisor-shift-types";

export function serializeHandoff(line: HandoffLogLine): string {
  return JSON.stringify({
    at: line.at,
    project: line.project,
    oldId: line.oldId,
    newId: line.newId,
    contextTokens: line.contextTokens,
    result: line.result.replace(/\s+/g, " ").trim().slice(0, 300),
  });
}

function isPhase(value: unknown): value is ShiftPhase {
  return value === "queued" || value === "handover" || value === "opening" || value === "detaching" || value === "waiting" || value === "done" || value === "failed";
}

function isResume(value: unknown): value is ShiftResume {
  return value === "queue" || value === "start" || value === "open" || value === "wait";
}

export function serializeShiftState(rows: StoredShift[]): string {
  return JSON.stringify(rows);
}

export function parseShiftState(text: string): StoredShift[] {
  if (!text.trim()) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const rows: StoredShift[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const row = item as { creationKey?: unknown; eventsOffset?: unknown; events?: unknown[]; progress?: Partial<ShiftProgress>; resume?: unknown; queuedAt?: unknown };
    const progress = row.progress;
    if (!progress || !isPhase(progress.phase) || typeof progress.project !== "string" || !progress.project) continue;
    if (progress.phase === "done") continue;
    rows.push({
      ...(typeof row.creationKey === "string" && row.creationKey ? { creationKey: row.creationKey } : {}),
      ...(typeof row.eventsOffset === "number" && Number.isSafeInteger(row.eventsOffset) && row.eventsOffset >= 0 ? { eventsOffset: row.eventsOffset } : {}),
      ...(Array.isArray(row.events) ? { events: parseShiftState(JSON.stringify(row.events.slice(-40).map(progress => ({ progress })))).map(row => row.progress) } : {}),
      progress: {
        phase: progress.phase,
        ...(typeof progress.step === "string" ? { step: progress.step } : {}),
        label: typeof progress.label === "string" && progress.label ? progress.label : phaseLabel(progress.phase),
        detail: typeof progress.detail === "string" ? progress.detail : "",
        project: progress.project,
        code: typeof progress.code === "string" ? progress.code : "",
        oldId: typeof progress.oldId === "string" ? progress.oldId : "",
        newId: typeof progress.newId === "string" && progress.newId ? progress.newId : null,
        contextTokens: typeof progress.contextTokens === "number" ? progress.contextTokens : null,
        canContinue: progress.canContinue === true,
        canCancel: progress.canCancel === true,
        openAgentId: typeof progress.openAgentId === "string" && progress.openAgentId ? progress.openAgentId : null,
      },
      resume: isResume(row.resume) ? row.resume : "start",
      queuedAt: typeof row.queuedAt === "number" ? row.queuedAt : null,
    });
  }
  return rows;
}

/**
 * After a reload the shift is not running. Show the step it stopped on,
 * and offer Continue and Cancel. A failure keeps Retry (canContinue) and drops Cancel.
 */
export function restoreShiftForDisplay(rows: StoredShift[]): StoredShift[] {
  return rows.map((row) => {
    if (row.progress.phase === "done") return row;
    if (row.progress.phase === "failed") {
      return { ...row, progress: { ...row.progress, canCancel: false, label: row.progress.label || phaseLabel("failed") } };
    }
    return {
      ...row,
      progress: { ...row.progress, canContinue: true, canCancel: true },
    };
  });
}

export function parseHandoffs(text: string, limit = 10): HandoffLogLine[] {
  const rows: HandoffLogLine[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const raw = JSON.parse(line) as Partial<HandoffLogLine>;
      if (!raw || typeof raw.at !== "string" || typeof raw.project !== "string" || typeof raw.oldId !== "string") continue;
      rows.push({
        at: raw.at,
        project: raw.project,
        oldId: raw.oldId,
        newId: typeof raw.newId === "string" && raw.newId ? raw.newId : null,
        contextTokens: typeof raw.contextTokens === "number" ? raw.contextTokens : null,
        result: typeof raw.result === "string" ? raw.result : "",
      });
    } catch {
      continue;
    }
  }
  return rows.slice(-limit).reverse();
}

/**
 * A shift saved before the upgrade may not know the old session, and the registry may already point
 * at the new one. Look the old id up from the queue row first, then the handoff log (latest first).
 * Null means it cannot be recovered and the caller must ask for a manual archive.
 */
export function recoverOldId(input: { code: string; newId: string; queueOldId?: string | null; handoffs: HandoffLogLine[] }): string | null {
  const { code, newId, queueOldId, handoffs } = input;
  if (queueOldId && queueOldId !== newId) return queueOldId;
  const matches = handoffs
    .filter((line) => line.project === code && line.newId === newId && line.oldId && line.oldId !== newId)
    .sort((left, right) => right.at.localeCompare(left.at));
  return matches[0]?.oldId ?? null;
}
