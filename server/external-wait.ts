import { getDb } from "./db";
import { KanbanError } from "./errors";
import { t } from "../shared/i18n";
import { externalWaitLabel } from "../shared/blocked";

/** Why a block that is really an external wait was refused. */
export function externalWaitMessage(): string {
  return t("externalWait.message");
}

/**
 * Recognize routine external waits, while preserving reports that need a person.
 * Block reasons are written by people and agents in Chinese or English; the Chinese words are \u escapes.
 */
export function isExternalWait(reason: string): boolean {
  // Needs a person. Chinese: permission, authorize, log in (two spellings), user, manual, decide (pending decision),
  // credentials, secret key, approve.
  if (/\u6743\u9650|\u6388\u6743|\u767b\u5f55|\u767b\u5165|\u7528\u6237|\u4eba\u5de5|\u62cd\u677f|\u51ed\u8bc1|\u5bc6\u94a5|\u6279\u51c6|permission|authoriz|authenticat|credential|\blog[ -]?in\b|human|manual|user.{0,20}decision|access denied|\b403\b/i.test(reason)) return false;
  // Asks for a repair of a failure. Chinese: repair, fixed; failed, error reported.
  if (/\u4fee\u590d|\u4fee\u597d|fix|repair/i.test(reason) && /\u5931\u8d25|\u62a5\u9519|fail|error/i.test(reason)) return false;
  // Says it waits. Chinese: "wait" followed by wait/await/-ing/space/CI/PR/other/its/parent/upstream/card/task/a card
  // code/#n; or "pending" followed by space/CI/PR/merge/card/task/parent.
  const waiting = /\u7b49(?:\u5f85|\u5019|\u7740|\s|CI\b|PR\b|\u522b|\u5176|\u524d|\u4e0a|\u5361|\u4efb\u52a1|[A-Z]+_\d|#\d)|\u5f85(?:\s|CI\b|PR\b|\u5408\u5e76|\u5361|\u4efb\u52a1|\u524d\u7f6e)|\bwait(?:ing)?\b|\bawait(?:ing)?\b|\bpending\b|\bdependenc(?:y|ies)\b|\bblocked by\b/i.test(reason);
  // Names something external. Chinese: continuous integration, pipeline, parent, other card (two spellings), card,
  // "card #n" / "card number n", "task #n".
  const external = /\bCI\b|\bPR\b|pull[ -]request|\u6301\u7eed\u96c6\u6210|\u6d41\u6c34\u7ebf|\u524d\u7f6e|\u5176\u4ed6\u5361|\u522b\u7684\u5361|\u5361\u7247|\u5361\s*[#\u53f7:]?\s*\d|\u4efb\u52a1\s*#?\d|\b[A-Z][A-Z0-9]*_\d+\b|\b(?:card|task|issue)\s*#?\d+\b|#[0-9]+/i.test(reason);
  return waiting && external;
}

export function waitingOn(handoff: unknown): string | null {
  // CLI --handoff and older callers pass JSON as text; retain that storage format.
  if (typeof handoff === "string") {
    try { handoff = JSON.parse(handoff); } catch { return null; }
  }
  if (!handoff || typeof handoff !== "object" || Array.isArray(handoff)) return null;
  const value = (handoff as Record<string, unknown>).waitingOn;
  if (value == null) return null;
  if (typeof value !== "string") throw new KanbanError("invalid", t("externalWait.error.notText"));
  return value.trim() || null;
}

export function storedWaitingOn(raw: string | null): string | null {
  try {
    return raw ? waitingOn(JSON.parse(raw).handoff) : null;
  } catch {
    return null;
  }
}

/** Use the existing board nextStep field so the RPC contract needs no migration. */
export function completionNextStep(raw: string | null, hold: string | null, status: string): string | null {
  const wait = ["in_review", "reviewing", "acceptance"].includes(status) ? storedWaitingOn(raw) : null;
  return wait ? [externalWaitLabel(wait), hold].filter(Boolean).join("\n") : hold;
}

/** Invalidate only the current declaration; complete events remain historical evidence. */
export function clearExternalWait(id: number): void {
  const db = getDb();
  const row = db.prepare("SELECT handoff_json FROM tasks WHERE id = ?").get(id) as { handoff_json: string | null } | undefined;
  if (!row?.handoff_json) return;
  let next: string;
  try {
    const stored = JSON.parse(row.handoff_json);
    const text = typeof stored?.handoff === "string";
    const handoff = text ? JSON.parse(stored.handoff) : stored?.handoff;
    if (!handoff || typeof handoff !== "object" || Array.isArray(handoff) || !("waitingOn" in handoff)) return;
    delete handoff.waitingOn;
    stored.handoff = text ? JSON.stringify(handoff) : handoff;
    next = JSON.stringify(stored);
  } catch {
    // Malformed legacy handoffs are preserved and already ignored by the board.
    return;
  }
  db.prepare("UPDATE tasks SET handoff_json = ? WHERE id = ? AND handoff_json = ?")
    .run(next, id, row.handoff_json);
}
