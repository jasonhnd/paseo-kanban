import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { tIn, type Language } from "./i18n";
import { differentReviewModels } from "./review-model";

const id = z.string().trim().min(1).max(200);
const option = z.object({ id, label: z.string() });
export const providerSchema = z.object({
  provider: id,
  state: z.enum(["discoverable", "unavailable", "unknown"]),
  enabled: z.boolean(),
  models: z.array(z.object({ id, label: z.string(), thinking: z.array(option) })),
  modes: z.array(option),
});
export const discoverySchema = z.object({
  status: z.enum(["ready", "timeout", "unknown"]),
  providers: z.array(providerSchema),
});
export type Discovery = z.infer<typeof discoverySchema>;
export const choiceSchema = z.object({
  provider: id, model: id, family: id, confirmedFamily: z.literal(true),
  modeId: id.optional(), thinkingOptionId: id.optional(),
});
export type RoleChoice = z.infer<typeof choiceSchema>;
export const generatedProfileSchema = z.object({
  id, name: id, provider: id, model: id, family: id, role: id,
  modeId: id.optional(), thinkingOptionId: id.optional(), notes: z.string(),
});
export type GeneratedProfile = z.infer<typeof generatedProfileSchema>;
export const previewSchema = z.object({
  status: z.enum(["ready", "invalid", "unavailable"]),
  issue: z.enum(["none", "capability", "family", "model", "options", "timeout", "unknown"]),
  review: z.enum(["independent", "manual"]),
  profiles: z.array(generatedProfileSchema),
});
export type RolePreview = z.infer<typeof previewSchema>;
export const discoverRolesRpc = defineRpc({ name: "roles.discover", input: z.object({}), output: discoverySchema });
export const previewRolesRpc = defineRpc({
  name: "roles.preview",
  input: z.object({ executor: choiceSchema, reviewer: choiceSchema.optional(), language: z.enum(["en", "zh-CN"]) }),
  output: previewSchema,
});

const ROLES = ["supervisor", "executor", "reader", "decision", "batch"] as const;
const invalid = (issue: RolePreview["issue"]): RolePreview => ({ status: "invalid", issue, review: "manual", profiles: [] });

/** A preview is data only. It has no host configuration or write capability. */
export function buildRolePreview(discovery: Discovery, executor: RoleChoice, reviewer: RoleChoice | undefined, language: Language): RolePreview {
  for (const choice of [executor, ...(reviewer ? [reviewer] : [])]) {
    if (!choice.confirmedFamily || !choice.family.trim() || choice.family.trim().toLowerCase() === "unknown") return invalid("family");
    const provider = discovery.providers.find(row => row.provider === choice.provider && row.enabled && row.state === "discoverable");
    const model = provider?.models.find(row => row.id === choice.model);
    if (!model) return invalid("capability");
    if (choice.modeId && !provider!.modes.some(row => row.id === choice.modeId)) return invalid("options");
    if (choice.thinkingOptionId && !model.thinking.some(row => row.id === choice.thinkingOptionId)) return invalid("options");
  }
  if (reviewer && !differentReviewModels(executor.model, reviewer.model)) return invalid("model");
  const profile = (role: typeof ROLES[number] | "reviewer", choice: RoleChoice): GeneratedProfile => ({
    id: `fleet-${role}`, name: tIn(language, `onboarding.role.${role}`), role,
    provider: choice.provider, model: choice.model, family: choice.family.trim().toLowerCase(),
    ...(choice.modeId ? { modeId: choice.modeId } : {}),
    ...(choice.thinkingOptionId ? { thinkingOptionId: choice.thinkingOptionId } : {}),
    notes: [tIn("en", `onboarding.notes.${role}`), tIn("zh-CN", `onboarding.notes.${role}`)].join("\n\n"),
  });
  const profiles = ROLES.map(role => profile(role, executor));
  if (reviewer) profiles.splice(2, 0, profile("reviewer", reviewer));
  return { status: "ready", issue: "none", review: reviewer ? "independent" : "manual", profiles };
}
