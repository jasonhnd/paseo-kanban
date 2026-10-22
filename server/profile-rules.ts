/// <reference types="node" />
import { t } from "../shared/i18n";
import { getDb } from "./db";
import { KanbanError } from "./errors";
import type { PoolEntry } from "./pools";
import type { Profile } from "./profiles";

/**
 * When a profile may be picked, by profile name. Written as rules instead of parsing the notes
 * text in the Paseo profile. A profile with no rule is always a candidate.
 */
export interface ProfileRule {
  /** Only a candidate when the card carries one of these tags. A match also ranks it first. */
  tags?: string[];
  /** With `tags`: also a candidate, without the tag, when its own pool is marked prefer. */
  orPoolPrefer?: boolean;
  /** Ranked first for these projects, whatever family the executor is. */
  projects?: string[];
  /** With `projects`: on any other project, only a candidate when the executor is one of these families. */
  otherProjectsExecutorFamilies?: string[];
  /** At most this many starts per day (Tokyo time), counted from the runs table. */
  dailyLimit?: number;
}

export type ProfileRules = Record<string, ProfileRule>;

/** Optional tags have meaning only through the user's configured profile rules. */
export function knownTags(): Record<string, string> {
  return {
    "high-risk": t("profileRules.tag.highRisk"),
    "complex-docs": t("profileRules.tag.complexDocs"),
  };
}

/** Fresh public boards have no profile-name-specific routing policy. */
export const DEFAULT_PROFILE_RULES: ProfileRules = {};

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const list = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
  return list.length > 0 ? list : undefined;
}

/** Parse one rule from config. Unknown or malformed fields are dropped. */
export function parseProfileRule(value: unknown): ProfileRule | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const rule: ProfileRule = {};
  const tags = stringList(raw.tags);
  if (tags) rule.tags = tags;
  if (raw.orPoolPrefer === true) rule.orPoolPrefer = true;
  const projects = stringList(raw.projects);
  if (projects) rule.projects = projects;
  const families = stringList(raw.otherProjectsExecutorFamilies);
  if (families) rule.otherProjectsExecutorFamilies = families;
  if (typeof raw.dailyLimit === "number" && Number.isInteger(raw.dailyLimit) && raw.dailyLimit >= 0) rule.dailyLimit = raw.dailyLimit;
  return rule;
}

/** Config overrides as stored: a rule, or null to drop a built-in rule. */
export function parseProfileRuleOverrides(value: unknown): Record<string, ProfileRule | null> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const next: Record<string, ProfileRule | null> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const name = key.trim();
    if (!name) continue;
    if (item === null) {
      next[name] = null;
      continue;
    }
    const rule = parseProfileRule(item);
    if (rule) next[name] = rule;
  }
  return next;
}

/** Built-in rules with the config overrides applied. */
export function effectiveProfileRules(overrides?: Record<string, ProfileRule | null>): ProfileRules {
  const rules: ProfileRules = { ...DEFAULT_PROFILE_RULES };
  for (const [name, rule] of Object.entries(overrides ?? {})) {
    if (rule === null) delete rules[name];
    else rules[name] = rule;
  }
  return rules;
}

/** The rule for a profile. Keys match by name prefix; the longest key wins. */
export function ruleFor(name: string, rules: ProfileRules): { key: string; rule: ProfileRule } | null {
  let best: { key: string; rule: ProfileRule } | null = null;
  for (const [key, rule] of Object.entries(rules)) {
    if (name !== key && !name.startsWith(key)) continue;
    if (!best || key.length > best.key.length) best = { key, rule };
  }
  return best;
}

export interface RuleContext {
  tags: readonly string[];
  project: string | null;
  executorFamily: string | null;
  pool: PoolEntry;
  /** Starts of this profile today (Tokyo time). Skip the daily check when missing. */
  runsToday?: number;
}

export type RuleVerdict = { ok: true; preferred: string | null; note: string | null } | { ok: false; why: string };

/** Check one profile against its rule. `preferred` names why the rule ranks it first. */
export function checkRule(profile: Profile, rule: ProfileRule, ctx: RuleContext): RuleVerdict {
  let preferred: string | null = null;
  let note: string | null = null;
  if (rule.tags && rule.tags.length > 0) {
    const hit = rule.tags.find((tag) => ctx.tags.includes(tag));
    if (hit) preferred = t("profileRules.preferredTag", { tag: hit });
    else if (rule.orPoolPrefer && ctx.pool.prefer) note = t("profileRules.poolPrefer", { pool: profile.pool ?? t("profileRules.itsPool") });
    else {
      const tags = rule.tags.join(t("profileRules.tagOr"));
      const tail = rule.orPoolPrefer ? t("profileRules.orPoolPreferTail", { pool: profile.pool ?? t("profileRules.itsPool") }) : "";
      return { ok: false, why: t("profileRules.onlyTagged", { tags, tail }) };
    }
  }
  if (rule.projects && rule.projects.length > 0) {
    if (ctx.project && rule.projects.includes(ctx.project)) preferred = preferred ?? t("profileRules.projectDefault", { project: ctx.project });
    else if (rule.otherProjectsExecutorFamilies && rule.otherProjectsExecutorFamilies.length > 0) {
      if (!ctx.executorFamily || !rule.otherProjectsExecutorFamilies.includes(ctx.executorFamily)) {
        const families = rule.otherProjectsExecutorFamilies.join(t("common.listSep"));
        return { ok: false, why: t("profileRules.otherProjects", { projects: rule.projects.join(t("common.listSep")), families }) };
      }
    }
  }
  if (rule.dailyLimit != null && ctx.runsToday != null && ctx.runsToday >= rule.dailyLimit) {
    return { ok: false, why: t("profileRules.dailyLimit", { count: ctx.runsToday, limit: rule.dailyLimit }) };
  }
  return { ok: true, preferred, note };
}

const TOKYO_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Midnight in Tokyo (no daylight saving) at or before `now`. */
export function tokyoDayStart(now: number): number {
  return Math.floor((now + TOKYO_OFFSET_MS) / DAY_MS) * DAY_MS - TOKYO_OFFSET_MS;
}

/** How many runs this profile started today, Tokyo time. */
export function countRunsToday(profileName: string, now = Date.now()): number {
  const since = new Date(tokyoDayStart(now)).toISOString();
  const row = getDb()
    .prepare("SELECT COUNT(*) AS n FROM runs WHERE profile_name = ? AND started_at >= ?")
    .get(profileName, since) as { n: number } | undefined;
  return row?.n ?? 0;
}

const TAG_SHAPE = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** Normalise tags from the CLI or MCP: lower case, trimmed, no repeats. Throws on a malformed tag. */
export function normalizeTags(input: unknown): string[] {
  if (input == null || input === "") return [];
  const values = Array.isArray(input) ? input : [input];
  const tags: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") throw new KanbanError("invalid", t("profileRules.tagNotText"));
    for (const part of value.split(",")) {
      const tag = part.trim().toLowerCase();
      if (!tag) continue;
      if (!TAG_SHAPE.test(tag)) throw new KanbanError("invalid", t("profileRules.tagInvalid", { tag: part.trim() }));
      if (!tags.includes(tag)) tags.push(tag);
    }
  }
  return tags;
}

/** Tags stored on a card. A broken value reads as no tags. */
export function parseTags(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const value = JSON.parse(json) as unknown;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

/** The routing fields that come from the card and the config. */
export function cardRouteContext(
  task: { project: string; tags: string | null; title?: string; brief?: string },
  overrides: Record<string, ProfileRule | null> | undefined,
  now = Date.now(),
): { project: string; tags: string[]; title?: string; brief?: string; rules: ProfileRules; runsToday: (profile: Profile) => number } {
  return {
    project: task.project,
    tags: parseTags(task.tags),
    ...(task.title !== undefined ? { title: task.title } : {}),
    ...(task.brief !== undefined ? { brief: task.brief } : {}),
    rules: effectiveProfileRules(overrides),
    runsToday: (profile) => countRunsToday(profile.name, now),
  };
}
