// The settings page document and the kanban.config.read / kanban.config.write shapes.
// Clients and the server share this file. It must not import node:.
import { z } from "zod";
import { t, type MessageKey } from "./i18n";

export const projectSettingsSchema = z.object({
  code: z.string(),
  baseBranch: z.string(),
  defaultWorkspace: z.enum(["dir", "worktree"]),
  worktreeLanes: z.number(),
  lanesEnabled: z.boolean(),
  parallel: z.boolean(),
  alwaysTemp: z.boolean(),
  waitParentPr: z.boolean(),
  autoStart: z.boolean(),
});
export type ProjectSettings = z.infer<typeof projectSettingsSchema>;

export const familySettingsSchema = z.object({
  providers: z.array(z.string()),
  modelPrefixes: z.array(z.string()),
  noFast: z.boolean(),
  noUltra: z.boolean(),
  requirePoolSeen: z.boolean(),
});
export type FamilySettings = z.infer<typeof familySettingsSchema>;

export const bannedSettingsSchema = z.object({
  providers: z.array(z.string()),
  families: z.array(z.string()),
  pools: z.array(z.string()),
  models: z.array(z.string()),
});
export type BannedSettings = z.infer<typeof bannedSettingsSchema>;

export const thresholdsSchema = z.object({
  archiveTimeoutMs: z.number(),
  cleanupConcurrency: z.number(),
  archiveVerifyMs: z.number(),
  reconcileIntervalMs: z.number(),
  stallIntervalMs: z.number(),
  stallIdleMs: z.number(),
  nudgeGraceMs: z.number(),
  loginBlipRetryMs: z.number(),
  transientRetryMinutes: z.number(),
  transientRetryLimit: z.number(),
  landConflictLimit: z.number(),
  reworkReassignHours: z.number(),
  progressGraceMs: z.number(),
  nudgeIntervalMs: z.number(),
  restartStallGraceMs: z.number(),
  autoArchiveAfterMs: z.number(),
  archiveDeadlineMs: z.number(),
  missingCwdPatrolMs: z.number(),
});
export type Thresholds = z.infer<typeof thresholdsSchema>;
export type ThresholdKey = keyof Thresholds;
export const THRESHOLD_KEYS = Object.keys(thresholdsSchema.shape) as ThresholdKey[];
/** Thresholds that have to be whole numbers of at least 1. The others are any number greater than 0. */
export const INTEGER_THRESHOLD_KEYS: readonly ThresholdKey[] = [
  "cleanupConcurrency",
  "transientRetryMinutes",
  "transientRetryLimit",
  "landConflictLimit",
  "reworkReassignHours",
];

const THRESHOLD_LABEL = {
  archiveTimeoutMs: "settings.thresholds.archiveTimeoutMs",
  cleanupConcurrency: "settings.thresholds.cleanupConcurrency",
  archiveVerifyMs: "settings.thresholds.archiveVerifyMs",
  reconcileIntervalMs: "settings.thresholds.reconcileIntervalMs",
  stallIntervalMs: "settings.thresholds.stallIntervalMs",
  stallIdleMs: "settings.thresholds.stallIdleMs",
  nudgeGraceMs: "settings.thresholds.nudgeGraceMs",
  loginBlipRetryMs: "settings.thresholds.loginBlipRetryMs",
  transientRetryMinutes: "settings.thresholds.transientRetryMinutes",
  transientRetryLimit: "settings.thresholds.transientRetryLimit",
  landConflictLimit: "settings.thresholds.landConflictLimit",
  reworkReassignHours: "settings.thresholds.reworkReassignHours",
  progressGraceMs: "settings.thresholds.progressGraceMs",
  nudgeIntervalMs: "settings.thresholds.nudgeIntervalMs",
  restartStallGraceMs: "settings.thresholds.restartStallGraceMs",
  autoArchiveAfterMs: "settings.thresholds.autoArchiveAfterMs",
  archiveDeadlineMs: "settings.thresholds.archiveDeadlineMs",
  missingCwdPatrolMs: "settings.thresholds.missingCwdPatrolMs",
} as const satisfies Record<ThresholdKey, MessageKey>;

/** Label for one threshold field, in the language currently in force. */
export function thresholdLabel(key: ThresholdKey): string {
  return t(THRESHOLD_LABEL[key]);
}

export const settingsDocumentSchema = z.object({
  language: z.enum(["en", "zh-CN", "system"]),
  projects: z.record(z.string(), projectSettingsSchema),
  concurrency: z.object({
    global: z.number(),
    pools: z.record(z.string(), z.number()),
    roles: z.record(z.string(), z.number()),
  }),
  staleStopPct: z.record(z.string(), z.number()),
  thresholds: thresholdsSchema,
  families: z.record(z.string(), familySettingsSchema),
  bannedProviders: bannedSettingsSchema,
  disabledPools: z.array(z.string()),
});
export type SettingsDocument = z.infer<typeof settingsDocumentSchema>;

export const candidateSchema = z.object({ name: z.string(), path: z.string() });
export type ConfigurationCandidate = z.infer<typeof candidateSchema>;

export const leaderRowSchema = z.object({ project: z.string(), agentId: z.string() });

/** What kanban.config.read returns. `language` is the effective setting, including an environment override. */
export const settingsReadSchema = z.object({
  language: z.enum(["en", "zh-CN", "system"]),
  revision: z.string(),
  needsSetup: z.boolean(),
  problem: z.string().nullable(),
  envOverride: z.boolean(),
  candidatesNote: z.string().nullable(),
  candidates: z.array(candidateSchema),
  leaders: z.array(leaderRowSchema),
  fallbackLeader: z.string().nullable(),
  document: settingsDocumentSchema.nullable(),
});
export type SettingsRead = z.infer<typeof settingsReadSchema>;

export const settingsWriteSchema = settingsReadSchema.extend({
  ok: z.boolean(),
  conflict: z.boolean(),
  message: z.string(),
});
export type SettingsWrite = z.infer<typeof settingsWriteSchema>;

/** A project row the settings page can add before the server has stored it. */
export function newProjectSettings(code: string): ProjectSettings {
  return {
    code,
    baseBranch: "main",
    defaultWorkspace: "dir",
    worktreeLanes: 1,
    lanesEnabled: false,
    parallel: true,
    alwaysTemp: false,
    waitParentPr: true,
    autoStart: true,
  };
}
