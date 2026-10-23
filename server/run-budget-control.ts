import { getDb } from "./db";
import { carryRunBudget } from "./run-cost";
import { KanbanError } from "./errors";
import { t } from "../shared/i18n";

/** A stop already dispatched to Paseo must settle before a leader can reuse the agent. */
export function assertRunBudgetSettled(id: number): void {
  const row = getDb().prepare("SELECT state_json FROM run_budget_state WHERE task_id = ?").get(id) as { state_json: string } | undefined;
  if (row && JSON.parse(row.state_json).phase === "braking") throw new KanbanError("conflict", t("runBudget.interruptPending"));
}

/** The next active tick creates a fresh generation; history keeps the prior brake snapshot. */
export function resetRunBudget(id: number): void {
  const db = getDb();
  carryRunBudget(db, id);
  db.prepare("DELETE FROM run_budget_state WHERE task_id = ?").run(id);
  // A braked run has already been accounted for. Reusing its agent starts a new run.
  const last = db.prepare("SELECT * FROM runs WHERE task_id = ? ORDER BY id DESC LIMIT 1").get(id);
  const task = db.prepare("SELECT status, agent_id FROM tasks WHERE id = ?").get(id);
  if (last?.end_kind === "run_budget" && last.ended_at && last.agent_id === task?.agent_id
      && (task?.status === "running" || task?.status === "reviewing")) {
    db.prepare(`INSERT INTO runs(task_id,agent_id,role,profile_name,provider,model,family,auto_accept,thinking_option_id,effort,started_at)
      SELECT task_id,agent_id,role,profile_name,provider,model,family,auto_accept,thinking_option_id,effort,?
      FROM runs WHERE id = ?`).run(new Date().toISOString(), last.id);
  }
}
