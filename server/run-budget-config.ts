import { KanbanError } from "./errors";
import type { KanbanConfig } from "./config";

export interface RunBudgetLimits {
  maxDurationMs: number;
  maxTurns: number;
  maxTokens: number;
  maxConsecutiveWaits: number;
}
export const DEFAULT_RUN_BUDGET: Readonly<RunBudgetLimits> = Object.freeze({
  maxDurationMs: 3 * 60 * 60_000,
  maxTurns: 150,
  maxTokens: 30_000_000,
  maxConsecutiveWaits: 8,
});

/** Invalid limits fail closed; a typo must not silently disable the brake. */
export function parseRunBudget(value: unknown): Partial<RunBudgetLimits> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new KanbanError("invalid", "runBudget must be an object");
  const result: Partial<RunBudgetLimits> = {};
  for (const [key, limit] of Object.entries(value)) {
    if (!Object.hasOwn(DEFAULT_RUN_BUDGET, key) || typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1) {
      throw new KanbanError("invalid", `runBudget.${key} must be a positive safe integer`);
    }
    result[key as keyof RunBudgetLimits] = limit;
  }
  return result;
}

export function effectiveRunBudget(project: string, config: KanbanConfig, card?: unknown): RunBudgetLimits {
  return { ...DEFAULT_RUN_BUDGET, ...parseRunBudget(config.runBudget), ...parseRunBudget(config.projects?.[project]?.runBudget), ...parseRunBudget(card) };
}
