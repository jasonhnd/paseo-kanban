import { z } from "zod";

export const runBudgetLimitsSchema = z.object({
  maxDurationMs: z.number().int().positive(),
  maxTurns: z.number().int().positive(),
  maxTokens: z.number().int().positive(),
  maxConsecutiveWaits: z.number().int().positive(),
});
export const runBudgetSchema = z.object({
  generation: z.string(), agentId: z.string(), startedAt: z.string(), durationMs: z.number(),
  turns: z.number(), tokens: z.number(), inputTokens: z.number(), outputTokens: z.number(), cachedInputTokens: z.number(),
  consecutiveWaits: z.number(), tokenStatus: z.enum(["available", "partial", "unavailable"]),
  source: z.string(), notes: z.array(z.string()), limits: runBudgetLimitsSchema,
  phase: z.enum(["running", "braking", "braked"]), recent: z.array(z.string()),
});
