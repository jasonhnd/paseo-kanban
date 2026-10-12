import { z } from "zod";
import { t } from "./i18n";

export const DEFAULT_LEADER_THRESHOLDS = { reminderTokens: 500_000, warningTokens: 750_000 } as const;
export const leaderThresholdsSchema = z.object({
  reminderTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  warningTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).refine(value => value.warningTokens > value.reminderTokens, { error: () => t("settings.leaderUsage.invalidOrder") });
export type LeaderThresholds = z.infer<typeof leaderThresholdsSchema>;

/** Malformed file edits fall back together, so warning always exceeds reminder. */
export function leaderThresholds(raw: unknown): LeaderThresholds {
  const value = raw && typeof raw === "object" ? (raw as { leaderUsage?: unknown }).leaderUsage : undefined;
  const parsed = leaderThresholdsSchema.safeParse(value);
  return parsed.success ? parsed.data : { ...DEFAULT_LEADER_THRESHOLDS };
}

export const leaderUsageReportSchema = z.object({
  generatedAt: z.string(), thresholds: leaderThresholdsSchema,
  rows: z.array(z.object({ project: z.string(), code: z.string(), agentId: z.string(),
    contextTokens: z.number().nullable(), level: z.enum(["normal", "reminder", "warning", "unknown"]) })),
});
export type LeaderUsageReport = z.infer<typeof leaderUsageReportSchema>;
