import { KanbanError } from "./errors";
import { t } from "../shared/i18n";
import { statusLabel, type Status } from "../shared/labels";

const NEXT: Record<Status, readonly Status[]> = {
  draft: ["waiting", "ready", "triage", "blocked", "archived"],
  triage: ["acceptance", "blocked", "archived"],
  waiting: ["ready", "blocked", "archived"],
  ready: ["running", "reviewing", "waiting", "blocked", "archived"],
  running: ["in_review", "acceptance", "ready", "blocked", "archived"],
  in_review: ["reviewing", "rework", "acceptance", "blocked", "archived"],
  reviewing: ["acceptance", "rework", "in_review", "ready", "blocked", "archived", "done"],
  rework: ["running", "acceptance", "blocked", "archived"],
  acceptance: ["done", "rework", "blocked", "archived"],
  done: ["archived", "blocked", "rework"],
  blocked: ["draft", "triage", "waiting", "ready", "running", "in_review", "reviewing", "rework", "acceptance", "done", "archived"],
  archived: ["rework", "blocked"],
};

export function canTransition(from: Status, to: Status): boolean {
  return NEXT[from].includes(to);
}

export function assertTransition(from: Status, to: Status): void {
  if (!canTransition(from, to)) {
    throw new KanbanError("illegal_transition", t("state.illegalTransition", { from: statusLabel(from), to: statusLabel(to) }), { from, to });
  }
}
