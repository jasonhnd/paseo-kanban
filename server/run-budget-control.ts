import { getDb } from "./db";
import { KanbanError } from "./errors";
import { t } from "../shared/i18n";

/** A stop already dispatched to Paseo must settle before a leader can reuse the agent. */
export function assertRunBudgetSettled(id: number): void {
  const row = getDb().prepare("SELECT state_json FROM run_budget_state WHERE task_id = ?").get(id) as { state_json: string } | undefined;
  if (row && JSON.parse(row.state_json).phase === "braking") throw new KanbanError("conflict", t("runBudget.interruptPending"));
}

/** The next active tick creates a fresh generation; history keeps the prior brake snapshot. */
export function resetRunBudget(id: number): void {
  getDb().prepare("DELETE FROM run_budget_state WHERE task_id = ?").run(id);
}
