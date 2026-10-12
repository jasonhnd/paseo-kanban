import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { shiftProgressSchema } from "./board";
import { leaderUsageReportSchema } from "./leader-usage";

export const leaderUsageRpc = defineRpc({ name: "leader.usage", input: z.object({}), output: leaderUsageReportSchema });
export const leaderSwapRpc = defineRpc({
  name: "leader.swap",
  input: z.object({ project: z.string().trim().min(1), action: z.enum(["run", "status", "cancel"]).default("run"), dryRun: z.boolean().default(false), again: z.boolean().default(false) }),
  output: z.object({
    ok: z.boolean(), dryRun: z.boolean(), running: z.boolean(), message: z.string(),
    job: shiftProgressSchema.nullable(), events: z.array(shiftProgressSchema).default([]), eventsOffset: z.number().int().nonnegative().default(0),
    plan: z.object({ project: z.string(), agentId: z.string(), workspaceId: z.string().nullable(), title: z.string(), provider: z.string(), model: z.string(), modeId: z.string().nullable(), thinkingOptionId: z.string().nullable(), featureValues: z.record(z.string(), z.unknown()) }).nullable(),
  }),
});
export type LeaderSwapInput = z.infer<typeof leaderSwapRpc.input>;
export type LeaderSwapResult = z.infer<typeof leaderSwapRpc.output>;
