/// <reference types="node" />
// Dispatch rules about model families and banned profiles, read from kanban.config.json
// (`families`, `bannedProviders`). A missing field keeps the built-in defaults below; a present
// field replaces them whole, so an empty object turns the rule off.

/** Extra limits on one model family. Every limit is off unless set. */
export interface FamilyRule {
  /** Providers that count as this family even when a profile does not name its family. */
  providers: string[];
  /** Only models whose id starts with one of these may run. Empty allows any model. */
  modelPrefixes: string[];
  /** Compatibility setting; routing always refuses fast/priority profiles for every family. */
  noFast: boolean;
  /** Refuse a start whose depth is ultra. */
  noUltra: boolean;
  /**
   * Refuse while the pool snapshot has not seen this profile's pool: no snapshot, a fresh one
   * that does not list the pool, or a stale one without a usage reading for it.
   */
  requirePoolSeen: boolean;
}

/** Profiles that are never dispatched. Names and models match case-insensitively by substring. */
export interface BannedProfiles {
  providers: string[];
  families: string[];
  pools: string[];
  /** Matched against both the profile name and its model id. */
  models: string[];
}

// Public defaults impose no vendor, model, mode, or profile preference.
export const DEFAULT_FAMILIES: Readonly<Record<string, FamilyRule>> = {};
export const DEFAULT_BANNED: Readonly<BannedProfiles> = {
  providers: [], families: [], pools: [], models: [],
};

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean))];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function familyRule(value: unknown): FamilyRule {
  const raw = isObject(value) ? value : {};
  return {
    providers: strings(raw.providers),
    modelPrefixes: strings(raw.modelPrefixes),
    noFast: raw.noFast === true,
    noUltra: raw.noUltra === true,
    requirePoolSeen: raw.requirePoolSeen === true,
  };
}

function cloneFamilies(source: Readonly<Record<string, FamilyRule>>): Record<string, FamilyRule> {
  return Object.fromEntries(Object.entries(source).map(([name, rule]) => [name, familyRule(rule)]));
}

/** `families` from the config file. Missing or not an object keeps the defaults. */
export function parseFamilies(value: unknown): Record<string, FamilyRule> {
  if (!isObject(value)) return cloneFamilies(DEFAULT_FAMILIES);
  const families: Record<string, FamilyRule> = {};
  for (const [name, rule] of Object.entries(value)) {
    if (name.trim()) families[name.trim()] = familyRule(rule);
  }
  return families;
}

/** `bannedProviders` from the config file. Missing or not an object keeps the defaults. */
export function parseBanned(value: unknown): BannedProfiles {
  const raw = isObject(value) ? value : (DEFAULT_BANNED as unknown as Record<string, unknown>);
  return { providers: strings(raw.providers), families: strings(raw.families), pools: strings(raw.pools), models: strings(raw.models) };
}

interface ProfileFacts {
  name: string;
  provider?: string | null;
  family?: string | null;
  pool?: string | null;
  model?: string | null;
}

/** The family rule that applies: the profile's own family, else a rule that claims its provider. */
export function familyRuleFor(profile: ProfileFacts, families: Readonly<Record<string, FamilyRule>>): FamilyRule | null {
  if (profile.family && families[profile.family]) return families[profile.family];
  if (!profile.provider) return null;
  return Object.values(families).find((rule) => rule.providers.includes(profile.provider!)) ?? null;
}

export function isBannedProfile(profile: ProfileFacts, banned: BannedProfiles): boolean {
  const text = [profile.name, profile.model ?? ""].map((item) => item.toLowerCase());
  return (
    (profile.provider != null && banned.providers.includes(profile.provider)) ||
    (profile.family != null && banned.families.includes(profile.family)) ||
    (profile.pool != null && banned.pools.includes(profile.pool)) ||
    banned.models.some((term) => text.some((item) => item.includes(term.toLowerCase())))
  );
}
