import type { FamilyRule, BannedProfiles } from "../../server/fleet-rules";
import type { ProfileRules } from "../../server/profile-rules";

export const complexDocsProfileName = "Documentation specialist";
export const highRiskProfileName = "Risk reviewer";
// Explicit fixture policy exercises opt-in filters; production has no such defaults.
export const DEMO_FAMILIES: Record<string, FamilyRule> = {
  openai: { providers: ["codex"], modelPrefixes: ["demo-v2-", "demo-v2."], noFast: true, noUltra: true, requirePoolSeen: true },
};
export const DEMO_BANNED: BannedProfiles = {
  providers: ["example-banned-provider"], families: ["example-banned-family"], pools: ["example-banned-pool"], models: ["example-banned-model"],
};
export const DEMO_PROFILE_RULES: ProfileRules = {
  [complexDocsProfileName]: { tags: ["complex-docs"] },
  [highRiskProfileName]: { tags: ["high-risk"], orPoolPrefer: true },
};
