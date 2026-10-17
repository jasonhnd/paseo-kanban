import type { Language } from "../shared/i18n";
import { cliFallback } from "./fallback";
import { protocolText } from "./protocol-text";

/** Marker recorded when a leader-start create hook actually delivered this protocol. */
export const PROTOCOL_VERSION = "kanban/v1";

// The texts live in server/protocol/<language>/*.md. Notes kept with them:
// - progress-note: the leader is woken by the board, so ending its turn to wait is normal for it.
// - no-wait-rule: workers are never woken again once their turn ends (Codex background sessions and
//   Claude ScheduleWakeup do not wake them), so ending the turn to wait is the main cause of nudged cards.
// - tmp-home: dispatch sets TMPDIR and KANBAN_TMP to the project’s .kanban-work/<card>/; the cleanup deletes that directory once the card is done or archived.
// - db-readonly: open the production database in place with ro+immutable, never copy the whole database.

/** Sent with every board nudge: a nudged agent is often waiting on a background result. */
export function noWaitNudge(): string {
  return protocolText("no-wait-nudge");
}

/** Shared instruction for every leader wake; keep policy independent of the wake reason. */
export function leaderActionNote(language?: Language): string {
  return protocolText("leader-action-note", undefined, language);
}

function workerParts(language?: Language): Record<string, string> {
  return {
    noWaitRule: protocolText("no-wait-rule", undefined, language),
    subagentWait: protocolText("subagent-wait", undefined, language),
    tmpHome: protocolText("tmp-home", undefined, language),
    dbReadonly: protocolText("db-readonly", undefined, language),
  };
}

export function protocolFor(role: string, options?: { worktree?: boolean; language?: Language }): string {
  const language = options?.language;
  const fallback = cliFallback(language);
  const parts = workerParts(language);
  if (role === "reviewer") return protocolText("reviewer", { ...parts, cliFallback: fallback }, language);
  if (role === "supervisor") {
    return protocolText("supervisor", { leaderActionNote: leaderActionNote(language), progressNote: protocolText("progress-note", undefined, language), cliFallback: fallback }, language);
  }
  if (role === "reader" || role === "decision") return protocolText("readonly", { ...parts, cliFallback: fallback }, language);
  if (role === "batch") return protocolText("executor", { ...parts, cliFallback: `${protocolText("batch-empty-commit", undefined, language)}\n${fallback}` }, language);
  const executor = protocolText("executor", { ...parts, cliFallback: fallback }, language);
  if (role === "executor" && options?.worktree) return `${executor}\n${protocolText("worktree", undefined, language)}`;
  return executor;
}
