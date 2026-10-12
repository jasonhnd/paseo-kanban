/// <reference types="node" />
import { t } from "../shared/i18n";
import { configFileProblem, type ConfigProblem } from "./config";
import { releaseBoardWake, wakeKanbanSupervisor, type BoardProblemKind } from "./wake";

/** While the file stays missing or broken, the Kanban <leader> is woken again this often. Every round still logs. */
export const CONFIG_ALARM_REPEAT_MS = 30 * 60_000;

const KINDS: Record<ConfigProblem["state"], BoardProblemKind> = {
  missing: "config_missing",
  broken: "config_broken",
};

/** The problem the current reminder window belongs to, and when that window opened. */
let armed: { kind: BoardProblemKind; at: number } | null = null;

export function resetConfigAlarmForTests(): void {
  armed = null;
}

function running(problem: ConfigProblem): string {
  return problem.memoryAt
    ? t("configAlarm.running.memory", { memoryAt: problem.memoryAt })
    : t("configAlarm.running.none");
}

/**
 * Run at the start of every scheduler round (DEMO_0001). A missing or broken kanban.config.json on a board that
 * has had one is logged every round and wakes the Kanban <leader>: once when found, again every
 * CONFIG_ALARM_REPEAT_MS while it lasts, and again after a refused send (the wake's own retry).
 * A fixed file clears the alarm. Returns the problem, or null.
 */
export function alarmConfigProblem(now: number = Date.now()): ConfigProblem | null {
  const problem = configFileProblem();
  if (!problem) {
    if (armed) {
      for (const kind of Object.values(KINDS)) releaseBoardWake(kind);
      armed = null;
    }
    return null;
  }
  const kind = KINDS[problem.state];
  const detail = `${problem.message}\n${running(problem)}`;
  console.error(`[paseo-kanban] ${problem.message} ${running(problem)}`);
  if (!armed || armed.kind !== kind) {
    armed = { kind, at: now };
  } else if (now - armed.at >= CONFIG_ALARM_REPEAT_MS) {
    releaseBoardWake(kind);
    armed = { kind, at: now };
  }
  wakeKanbanSupervisor({ taskId: null, kind, detail });
  return problem;
}
