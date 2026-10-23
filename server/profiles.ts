import { canonicalPoolId } from "../shared/fleet/x-ultra";
/// <reference types="node" />
import { t } from "../shared/i18n";
import { hasGoogleFacts } from "./execution-family";
import { readFileSync } from "./perf-fs";
import { paseoConfigPath } from "./paths";
import { routeProfile } from "./routing";

export interface Profile {
  id: string;
  name: string;
  role?: string;
  candidateFor?: string;
  pausedCandidateFor?: string;
  paused?: boolean;
  family?: string;
  /** AFC quota pool key, e.g. cursor or claude-max. Without it the profile is not limited per pool. */
  pool?: string;
  provider: string;
  model?: string;
  modeId?: string;
  thinkingOptionId?: string;
  featureValues?: Record<string, unknown>;
  /** Recognized for admission even when a host stores overrides outside featureValues. */
  serviceTier?: string;
  service_tier?: string;
  fast?: boolean | string;
  fast_mode?: boolean | string;
  fastMode?: boolean | string;
  config?: unknown;
  args?: unknown;
  cliArgs?: unknown;
  extraArgs?: unknown;
  command?: unknown;
  notes?: string;
}

export interface AgentCreateConfig {
  provider: string;
  modeId?: string;
  thinkingOptionId?: string;
  featureValues?: Record<string, unknown>;
}

export type ProfilePick = { ok: true; profile: Profile } | { ok: false; reason: string };

export { paseoConfigPath };

/** Adapt only the public RPC's top-level profile array. Never traverse other configuration fields. */
export function profilesFromRpcConfig(config: unknown): Profile[] {
  const list = config && typeof config === "object" ? (config as { agentProfiles?: unknown }).agentProfiles : undefined;
  return profilesFromText(JSON.stringify({ daemon: { agentProfiles: list } }));
}

/** Parse daemon.agentProfiles. Throws when the file shape cannot be trusted. */
export function profilesFromText(text: string): Profile[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(t("profiles.badJson"));
  }
  const list = (raw as { daemon?: { agentProfiles?: unknown } } | null)?.daemon?.agentProfiles;
  if (!Array.isArray(list)) throw new Error(t("profiles.notArray"));
  return list.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(t("profiles.itemNotObject", { index: index + 1 }));
    const profile = item as Profile;
    if (typeof profile.id !== "string" || typeof profile.name !== "string" || typeof profile.provider !== "string") {
      throw new Error(t("profiles.itemMissingFields", { index: index + 1 }));
    }
    if (profile.featureValues != null && (typeof profile.featureValues !== "object" || Array.isArray(profile.featureValues))) {
      throw new Error(t("profiles.featureValuesNotObject", { name: profile.name }));
    }
    return { ...profile, ...(profile.pool ? { pool: canonicalPoolId(profile.pool)! } : {}) };
  });
}

export function readProfiles(): Profile[] {
  const path = paseoConfigPath();
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(t("profiles.unreadable", { message }));
  }
  return profilesFromText(text);
}

/**
 * Copy the archive fields the daemon must receive. Absent fields stay absent; present values are not rewritten.
 * `thinkingOverride` replaces the profile's thinkingOptionId for this open only (a card's own-role effort).
 */
export function buildAgentConfig(profile: Profile, thinkingOverride?: string): AgentCreateConfig {
  const config: AgentCreateConfig = { provider: `${profile.provider}/${profile.model ?? ""}` };
  if (profile.modeId !== undefined) config.modeId = profile.modeId;
  const thinking = thinkingOverride ?? profile.thinkingOptionId;
  if (thinking !== undefined) config.thinkingOptionId = thinking;
  if (profile.featureValues !== undefined) config.featureValues = structuredClone(profile.featureValues);
  return config;
}

export function findProfile(profiles: Profile[], override: string): Profile | undefined {
  const exact = profiles.filter((profile) => profile.name === override || profile.id === override);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return undefined;
  const prefixed = profiles.filter((profile) => profile.name.startsWith(override));
  if (prefixed.length === 1) return prefixed[0];
  return undefined;
}

/** Provider/model facts win over a hand-edited family or pool label. */
export function isGoogleProfile(profile: Pick<Profile, "provider" | "model" | "family">): boolean {
  return hasGoogleFacts(profile) || profile.family?.toLowerCase() === "google";
}

export function actualFamily(profile: Pick<Profile, "provider" | "model" | "family">): string | null {
  return isGoogleProfile(profile) ? "google" : profile.family ?? null;
}

export const GOOGLE_DISPATCH_POLICY = "antigravity-acp-1.3.0-medium-L1L2-v1";

/** Only the official versioned ACP entry is covered by the temporary authorization. */
export function officialAntigravityAcp(): boolean {
  try {
    const raw = JSON.parse(readFileSync(paseoConfigPath(), "utf8"));
    const provider = raw?.agents?.providers?.antigravity;
    const command = provider?.command;
    return provider?.extends === "acp" && provider?.enabled !== false
      && Array.isArray(command) && command.length === 1 && typeof command[0] === "string"
      && /^\/.+\/agy-acp-server\/1\.3\.0\/agy_acp_server\.par$/.test(command[0]);
  } catch { return false; }
}

/** Used by older callers and unit tests. Treats every pool as dispatchable and ignores concurrency. */
export function selectProfile(
  profiles: Profile[],
  input: { role: string; profileOverride?: string | null; executorFamily?: string | null; executorModel?: string | null; executorProfile?: string | null; review: boolean },
): ProfilePick {
  const decision = routeProfile({
    profiles,
    role: input.role,
    review: input.review,
    profileOverride: input.profileOverride,
    executorFamily: input.executorFamily,
    executorModel: input.executorModel,
    executorProfile: input.executorProfile,
    byPool: {},
    poolLimits: {},
    snapshot: {
      state: "fresh",
      message: t("profiles.testSnapshot"),
      generatedAt: null,
      dispatchable: () => true,
      entry: () => ({ dispatchable: true, deprioritize: false, prefer: false, resetsAt: null, reason: null, onlyRoles: null }),
      hasPool: () => true,
    },
  });
  if (!decision.ok) return { ok: false, reason: decision.reason };
  return { ok: true, profile: decision.profile };
}
