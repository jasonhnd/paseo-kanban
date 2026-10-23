import { canonicalPoolId } from "./x-ultra";
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { parseDispatchPriority } from "./dispatch-priority";
import { ADAPTER_IDS, ANTIGRAVITY_BUCKETS, ANTIGRAVITY_CLI } from "./quota-adapters";
import { dispatchOverridesSchema, dispatchSettingRowSchema } from "./dispatch-overrides";
import { copiedQuotaSchema, quotaCycleSchema } from "./quota-cycle";

import { leaderThresholdsSchema } from "./leader-usage";
import { opsProjectSchema } from "./ops-project";

const strings = z.array(z.string().trim().min(1));
export const planSchema = z.object({
  id: z.string().trim().min(1), name: z.string().trim().min(1),
  adapter: z.enum(ADAPTER_IDS).optional(), providers: strings.optional(),
  usageProvider: z.string().optional(), priceUsdMonthly: z.number().nonnegative().nullable().optional(),
  dispatch: z.boolean().optional(), pacePause: z.boolean().optional(),
  xUltraReserve: z.object({ botPct: z.number().min(0).max(100).nullable().optional(), userPct: z.number().min(0).max(100).nullable().optional() })
    .refine(value => (value.botPct ?? 0) + (value.userPct ?? 0) <= 100, "Shared reserve exceeds 100%").optional(),
  reservePct: z.number().min(0).max(100).optional(),
  stopPct: z.number().min(0).max(100).optional(), cycleDay: z.number().int().min(1).max(31).optional(),
  quotaCycle: quotaCycleSchema.optional(), manual: copiedQuotaSchema.nullable().optional(),
  manualOverride: copiedQuotaSchema.nullable().optional(), quotaProtection: z.enum(["pause", "none"]).optional(),
  antigravityBucket: z.enum(ANTIGRAVITY_BUCKETS).optional(),
}).passthrough();
export const plansSchema = z.object({
  schemaVersion: z.literal(2).optional(),
  plans: z.array(planSchema).refine(rows => new Set(rows.map(row => row.id)).size === rows.length, "Duplicate pool ids"),
  dispatchPriority: z.object({ order: z.array(z.string()), until: z.string(), note: z.string().optional() }).passthrough()
    .refine(value => parseDispatchPriority(value) !== null, "Invalid dispatch priority").nullable().optional(),
}).passthrough().superRefine((document, ctx) => {
  if (document.schemaVersion === 2 && document.dispatchPriority) {
    const ids = new Set(document.plans.map(plan => canonicalPoolId(plan.id)));
    for (const id of document.dispatchPriority.order) if (!ids.has(canonicalPoolId(id))) ctx.addIssue({ code: "custom", path: ["dispatchPriority", "order"], message: "Priority references an unknown pool" });
  }
});
// Unknown keys survive edits alongside the validated settings.
export const afcSettingsSchema = z.object({
  opsProject: opsProjectSchema.optional(),
  language: z.enum(["system", "en", "zh-CN"]).optional(), hiddenPlans: z.array(z.string().refine(value => value.trim().length > 0, "Empty hidden pool term")).optional(),
  bannedProviders: z.array(z.string()).transform(values => [...new Set(values.map(value => value.trim()).filter(Boolean))]).optional(),
  adapters: z.object({ "cursor-api": z.boolean().optional(), keychain: z.boolean().optional(), [ANTIGRAVITY_CLI]: z.boolean().optional() }).passthrough().optional(),
  dispatchOverrides: dispatchOverridesSchema.optional(),
  leaderUsage: leaderThresholdsSchema.optional(),
}).passthrough();
export type PlansDocument = z.infer<typeof plansSchema>;
export type ConfigDocument = z.infer<typeof afcSettingsSchema>;
export const fileSchema = z.enum(["plans", "config"]);
export type SettingsFile = z.infer<typeof fileSchema>;
const documentSchema = z.record(z.string(), z.unknown());
const snapshotSchema = z.object({ document: documentSchema, revision: z.string(), effectiveAdapters: z.object({ "cursor-api": z.boolean(), keychain: z.boolean(), [ANTIGRAVITY_CLI]: z.boolean() }).optional(), language: z.enum(["en", "zh-CN"]), dispatchRows: z.array(dispatchSettingRowSchema).optional() });
export type SettingsSnapshot = z.infer<typeof snapshotSchema>;
export const configReadRpc = defineRpc({ name: "config.read", input: z.object({ file: fileSchema }), output: snapshotSchema });
export const configWriteRpc = defineRpc({
  name: "config.write", input: z.object({ file: fileSchema, revision: z.string(), document: documentSchema }),
  output: z.object({ status: z.enum(["saved", "conflict"]), snapshot: snapshotSchema }),
});
