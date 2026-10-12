/// <reference types="node" />
import { actualModel, differentReviewModels } from "../shared/fleet/review-model";
import { t } from "../shared/i18n";
import { getDb } from "./db";
import { resolveReviewTarget, reviewFamilyBlock, type ReviewTarget } from "./review-target";
import { submitsToReview } from "./flow";
import { fleetRules, loadConfig } from "./config";
import { familyRuleFor, isBannedProfile, type BannedProfiles, type FamilyRule } from "./fleet-rules";
import { isOpsRole, isWildcardRole, loadDispatchMatrix, priorityActive, type DispatchMatrix, type MatrixItem } from "./matrix";
import { onlyRolesBlock, readPoolSnapshot, staleMinutes, unmarkedPool, type PoolSnapshot } from "./pools";
import { cardRouteContext, checkRule, ruleFor, type ProfileRules, type RuleVerdict } from "./profile-rules";
import { actualFamily, isGoogleProfile, officialAntigravityAcp, readProfiles, type Profile } from "./profiles";
import { setProfileHintSource, type ProfilePriorityHint } from "./task-create";
import type { TaskRow } from "./task-record";
import { downgradeEffort, isEffortValue, resolveTier, type Tier } from "./tier";
import type { Effort } from "./effort";
import { roleLabel } from "../shared/labels";

function findProfile(profiles: Profile[], override: string): Profile | undefined {
  const exact = profiles.filter((profile) => profile.name === override || profile.id === override);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return undefined;
  const prefixed = profiles.filter((profile) => profile.name.startsWith(override));
  if (prefixed.length === 1) return prefixed[0];
  return undefined;
}

export interface RouteInput {
  profiles: Profile[];
  role: string;
  review: boolean;
  profileOverride?: string | null;
  executorFamily?: string | null;
  executorProfile?: string | null;
  /** Recorded run facts, independent of the current profile's mutable labels. */
  executorProvider?: string | null;
  executorModel?: string | null;
  /**
   * Set when this review checks an executor's delivery (not a standalone review
   * card). A missing executor family is then resolved from executorProfile; when
   * that fails the review is not dispatched, so an unknown family never passes
   * as "different family".
   */
  reviewsExecutor?: boolean;
  /** Persisted target work-run evidence, resolved by the scheduler/start handler. */
  reviewTarget?: ReviewTarget | null;
  /** Pools that just rate-limited or ran out of quota. Prefer a different pool. */
  avoidPools?: string[];
  byPool: Record<string, number>;
  poolLimits: Record<string, number>;
  snapshot: PoolSnapshot;
  /** The card's project. Profile rules can prefer or limit a profile per project. */
  project?: string | null;
  /** The card's tags, for example high-risk or complex-docs. */
  tags?: readonly string[];
  /** Profile scope rules. Missing means no rules (older callers and unit tests). */
  rules?: ProfileRules;
  /** Starts of a profile today, Tokyo time. Needed for dailyLimit; missing skips that check. */
  runsToday?: (profile: Profile) => number;
  /** Set when the dispatch matrix file parsed. Null or missing means the old roster. */
  matrix?: DispatchMatrix | null;
  /** Tier stored on the card. Empty means resolve from tags and the matrix default. */
  tier?: string | null;
  /** Card effort for this start. Already limited to the card's own role. */
  cardEffort?: Effort | null;
  /**
   * When set, a candidate whose resolved depth is rejected is skipped.
   * Production rejects only depths confirmed unsupported during this start.
   * Unknown catalogs must be held by the caller, never rejected here.
   */
  supportsEffort?: (profile: Profile, effort: string) => boolean;
  /** Clock for the matrix priority window. Missing means Date.now(). */
  now?: number;
}

export type EffortSource = "card" | "matrix" | "profile" | "downgrade";

export type RouteDecision =
  | {
      ok: true;
      profile: Profile;
      reason: string;
      /** Set by matrix routing. Missing means the caller applies the card-or-profile depth itself. */
      effort?: string | null;
      effortSource?: EffortSource;
      /** True when this depth came from the matrix and the tier may still drop one step at start. */
      allowDowngrade?: boolean;
    }
  | {
      ok: false;
      action: "block" | "hold";
      kind: "quota" | "needs_human";
      reason: string;
      /** Set when this failure already named one profile, so the event can record that pool. */
      pool?: string | null;
      /** No candidate can run a confirmed depth; hold and notify the leader. */
      unsupportedEffort?: boolean;
      /**
       * The card stays in its current queue until a pool opens.
       * Not set for scope rules, concurrency, or a permanent failure.
       */
      quotaWait?: boolean;
      /** At least one eligible candidate is queued for capacity, without a scope/reservation hold. */
      concurrencyWait?: boolean;
    };

type SkipKind = "pool" | "family" | "codex" | "concurrency" | "reserve" | "rule" | "cursor" | "snapshot" | "effort" | "login" | "missing";

interface Skip {
  profile: Profile;
  why: string;
  fatal: SkipKind;
}

/** Skip reasons of the family rule. Callers compare a returned reason with these in the same language. */
export function modelNotAllowed(): string {
  return t("routing.modelNotAllowed");
}
export function fastNotAllowed(): string {
  return t("routing.fastNotAllowed");
}
export function depthNotAllowed(): string {
  return t("routing.depthNotAllowed");
}
export function poolUnseenReason(): string {
  return t("routing.poolUnseenReason");
}
export function profileBannedReason(): string {
  return t("routing.profileBannedReason");
}
/**
 * plan auto-approves switchMode on the ACP session, so a reviewer can leave plan and write
 * without a Paseo permission. ask does not run commands, so git log/diff is unavailable.
 * Neither mode is applied to read-only roles.
 */
export function cursorReadonlyReason(): string {
  return t("routing.cursorReadonly");
}

function skipLine(skip: Skip): string {
  return t("routing.skipItem", { name: skip.profile.name, why: skip.why });
}

function poolClosed(pool: string | null | undefined, reason: string | null | undefined): string {
  const name = pool ?? unmarkedPool();
  return reason ? t("routing.poolClosedWhy", { pool: name, reason }) : t("routing.poolClosed", { pool: name });
}

const READ_ONLY_ROLES = new Set(["reader", "decision", "reviewer"]);

function assignsReadOnly(input: RouteInput): boolean {
  return input.review || READ_ONLY_ROLES.has(input.role);
}

/** Explicit exclusions from kanban.config.json `bannedProviders`. */
export function isDispatchBanned(profile: Profile, banned: BannedProfiles = fleetRules().banned): boolean {
  return isBannedProfile(profile, banned) || isBannedProfile({ ...profile, family: actualFamily(profile) }, banned);
}

/** Operator pause mark. Code points keep this source free of CJK, which this tree allows only in locale files. */
const PAUSED_NOTE = new RegExp(`${String.fromCodePoint(0x3010, 0x6682, 0x505c, 0x3011)}|\\[Paused\\]`);

/** Invariant shared by roster, matrix, explicit selection and reviewer reservation. */
function googleDispatchBlock(profile: Profile, input: RouteInput): string | null {
  if (!isGoogleProfile(profile)) return null;
  const role = input.review ? "reviewer" : input.role;
  if (profile.provider !== "antigravity" || profile.model !== "gemini-3.8-flash-medium"
    || (profile.modeId !== undefined && profile.modeId !== "default") || !officialAntigravityAcp()) return t("routing.google.entry");
  if (!["executor", "batch", "reader"].includes(role)
    || (input.tier != null && input.tier !== "" && !["L1", "L2"].includes(input.tier))
    || !["L1", "L2"].includes(cardTier(input, input.matrix ?? null))) {
    return t("routing.google.scope");
  }
  if (profile.pool !== "antigravity-gemini" || profile.paused === true || profile.pausedCandidateFor || PAUSED_NOTE.test(profile.notes ?? "") ||
    !(profile.role === role || (profile.role === "candidate" && profile.candidateFor === role))) return t("routing.google.profile");
  // Neither strategy inherits the generic open fallback. Only this exact entry/pool
  // can opt out of quota protection; unknown readings remain null, never synthetic zero.
  const entry = input.snapshot.entry(profile.pool ?? null);
  if (input.snapshot.state !== "fresh" || !profile.pool || !input.snapshot.hasPool?.(profile.pool)
    || entry.dispatchable !== true || entry.dispatchableExplicit === false) return t("routing.google.quota");
  if (entry.quotaProtection === "pause") {
    if (typeof entry.usedPct !== "number" || !Number.isFinite(entry.usedPct) || entry.usedPct < 0 || entry.usedPct >= 100
      || !(Date.parse(entry.readingExpiresAt ?? "") > (input.now ?? Date.now()))) return t("routing.google.quota");
  } else if (entry.quotaProtection === "none") {
    // Explicit risk acceptance still requires a current, listed matrix candidate.
    if (!input.matrix || input.matrix.stale === true) return t("routing.google.matrix");
  } else return t("routing.google.quota");
  if (input.matrix) {
    const list = listForRole(input, input.matrix, cardTier(input, input.matrix));
    const item = "items" in list ? list.items.find(item => findProfile(input.profiles, item.profile)?.id === profile.id) : undefined;
    if (!item || item.paused) return t("routing.google.matrix");
  }
  return null;
}

/**
 * Depth used when the card and the matrix do not name one.
 * `ultra` is kept so it can be refused. Any other unknown id is not a depth.
 */
export function profileDepth(profile: Profile): string | null {
  const own = profile.thinkingOptionId?.trim() ?? "";
  if (!own) return null;
  if (isEffortValue(own)) return own;
  // Only a family that refuses ultra keeps it, so it can be refused. Others keep an unknown id on the archive itself.
  if (own === "ultra" && familyRuleFor(profile, fleetRules().families)?.noUltra) return "ultra";
  return null;
}

/**
 * Why this profile's family rule (kanban.config.json `families`) refuses the work. Null when no
 * rule applies. Restrictions are opt-in and apply equally to every configured family.
 * `effort` is the depth this start would actually use: the card, then the matrix, then the profile.
 * openai is an ordinary family; same-family review is a separate check.
 */
export function familyDispatchBlock(
  profile: Profile,
  effort: string | null | undefined,
  snapshot: PoolSnapshot,
  families: Readonly<Record<string, FamilyRule>> = fleetRules().families,
): string | null {
  const rule = familyRuleFor({ ...profile, family: actualFamily(profile) }, families);
  if (!rule) return null;
  if (rule.modelPrefixes.length > 0 && !rule.modelPrefixes.some((prefix) => (profile.model ?? "").startsWith(prefix))) return modelNotAllowed();
  if (rule.noFast && profile.featureValues?.fast_mode === true) return fastNotAllowed();
  if (rule.noUltra && effort === "ultra") return depthNotAllowed();
  if (rule.requirePoolSeen && poolUnseen(profile, snapshot)) return poolUnseenReason();
  return null;
}

/**
 * A missing file, a file that does not list this pool, or a stale file without a usedPct reading
 * for it. Other pools stay open. A stale reading at or past the stop line is refused as not dispatchable.
 */
function poolUnseen(profile: Profile, snapshot: PoolSnapshot): boolean {
  if (snapshot.state === "missing") return true;
  const pool = profile.pool ?? null;
  if (!pool || !snapshot.hasPool || !snapshot.hasPool(pool)) return true;
  if (snapshot.state === "stale") return snapshot.entry(pool).usedPct == null;
  return false;
}

/** One step down. ultra is refused and is never lowered into max or any other depth. */
function lowerDepth(effort: string | null | undefined): Effort | null {
  if (!effort || effort === "ultra" || !isEffortValue(effort)) return null;
  return downgradeEffort(effort);
}

/**
 * Role checked against a pool's onlyRoles.
 * Review work is reviewer. Otherwise the profile's role, and a candidate uses candidateFor.
 */
export function profilePoolRole(profile: Profile | null, review: boolean): string | null {
  if (review) return "reviewer";
  if (!profile) return null;
  if (profile.role === "candidate") return profile.candidateFor ?? null;
  return profile.role ?? null;
}

function roster(profiles: Profile[], role: string): Profile[] {
  const official = profiles.filter((profile) => profile.role === role);
  const candidates = profiles
    .filter((profile) => profile.role === "candidate" && profile.candidateFor === role)
    .sort((a, b) => a.name.localeCompare(b.name, "zh"));
  return [...official, ...candidates];
}

function reviewerOk(profile: Profile, executor: Profile, input: RouteInput, effort?: string | null): string | null {
  const snapshot = input.snapshot;
  const depth = effort !== undefined ? effort : profileDepth(profile);
  const gpt = familyDispatchBlock(profile, depth, snapshot);
  if (gpt) return gpt;
  if (isDispatchBanned(profile)) return profileBannedReason();
  const google = googleDispatchBlock(profile, { ...input, role: "reviewer", review: true });
  if (google) return google;
  if (profile.provider === "cursor") return cursorReadonlyReason();
  const entry = snapshot.entry(profile.pool ?? null);
  if (!entry.dispatchable) return poolClosed(profile.pool, entry.reason);
  const limited = onlyRolesBlock(entry, profile.pool ?? null, "reviewer");
  if (limited) return limited;
  if (profile.paused || !differentReviewModels(executor.model, profile.model)) return t("routing.reviewModelUnavailable");
  return null;
}

/** Rule verdict for one profile. No rule, or no rules at all, means it may run and is not preferred. */
function ruleVerdict(profile: Profile, input: RouteInput, executorFamily: string | null, daily: boolean): RuleVerdict & { key?: string } {
  const match = input.rules ? ruleFor(profile.name, input.rules) : null;
  if (!match) return { ok: true, preferred: null, note: null };
  const verdict = checkRule(profile, match.rule, {
    tags: input.tags ?? [],
    project: input.project ?? null,
    executorFamily,
    pool: input.snapshot.entry(profile.pool ?? null),
    runsToday: daily && match.rule.dailyLimit != null && input.runsToday ? input.runsToday(profile) : undefined,
  });
  return { ...verdict, key: match.key };
}

/** Whether some reviewer could take this executor's card. Null when yes, otherwise the skip. */
function reviewerGap(executor: Profile, input: RouteInput): { why: string; fatal: SkipKind } | null {
  if (input.matrix) return matrixReviewerGap(executor, input);
  const listed = roster(input.profiles, "reviewer");
  const reviewers = listed.filter((profile) => reviewerOk(profile, executor, input) === null);
  if (reviewers.length === 0) {
    const details = listed
      .map((profile) => {
        const why = reviewerOk(profile, executor, input);
        return why ? t("routing.skipItem", { name: profile.name, why }) : "";
      })
      .filter(Boolean)
      .slice(0, 4);
    const why = details.length > 0 ? `${t("routing.noReviewer")}${t("common.paren", { text: details.join(t("common.semicolon")) })}` : t("routing.noReviewer");
    return { why, fatal: "reserve" };
  }
  // The daily limit resets tomorrow, so it does not stop the executor from starting today.
  const scoped = reviewers.map((profile) => ({ profile, verdict: ruleVerdict(profile, input, actualFamily(executor), false) }));
  if (scoped.some((item) => item.verdict.ok)) return null;
  const why = scoped.map((item) => `${item.profile.name}${item.verdict.ok ? "" : t("common.paren", { text: item.verdict.why })}`).join(t("common.listSep"));
  return { why: t("routing.ruleBlocked", { list: why }), fatal: "rule" };
}

interface Ranked {
  profile: Profile;
  index: number;
  tier: number;
  preferred: string | null;
  note: string | null;
}

/** Lower tier first: 100 = just rate-limited, 10 = deprioritize. */
function tierOf(profile: Profile, snapshot: PoolSnapshot, avoid: Set<string>): number {
  let score = 0;
  if (profile.pool && avoid.has(profile.pool)) score += 100;
  if (profile.pool && snapshot.entry(profile.pool).deprioritize) score += 10;
  return score;
}

function resetsAtMs(value: string | null): number {
  const ms = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
}

/**
 * Order: not dispatchable never gets here; just-rate-limited pools last; deprioritize after that.
 * Among the rest, a rule that names this card (tag or project) first, then pools marked prefer,
 * the earliest resetsAt first when several prefer. Otherwise the roster order: official profiles,
 * then candidates by name.
 */
function compareRanked(a: Ranked, b: Ranked, snapshot: PoolSnapshot): number {
  if (a.tier !== b.tier) return a.tier - b.tier;
  if (Boolean(a.preferred) !== Boolean(b.preferred)) return a.preferred ? -1 : 1;
  const pa = snapshot.entry(a.profile.pool ?? null);
  const pb = snapshot.entry(b.profile.pool ?? null);
  const preferA = Boolean(a.profile.pool) && pa.prefer;
  const preferB = Boolean(b.profile.pool) && pb.prefer;
  if (preferA !== preferB) return preferA ? -1 : 1;
  if (preferA && preferB) {
    const diff = resetsAtMs(pa.resetsAt) - resetsAtMs(pb.resetsAt);
    if (diff !== 0) return diff;
  }
  return a.index - b.index;
}

function snapshotNote(snapshot: PoolSnapshot): string | null {
  return snapshot.state === "fresh" ? null : snapshot.message;
}

function summarize(chosen: Ranked, skips: Skip[], snapshot: PoolSnapshot, avoid: Set<string>): string {
  const profile = chosen.profile;
  const bits = [t("routing.sum.chosen", { name: profile.name })];
  if (profile.pool) bits.push(t("routing.sum.pool", { pool: profile.pool }));
  if (profile.family) bits.push(t("routing.sum.family", { family: profile.family }));
  const entry = snapshot.entry(profile.pool ?? null);
  if (profile.pool && avoid.has(profile.pool)) bits.push(t("routing.sum.onlyLimited"));
  else if (profile.pool && entry.deprioritize) bits.push(t("routing.sum.deprioritized"));
  else if ([...avoid].length > 0) bits.push(t("routing.sum.avoid", { pools: [...avoid].join(t("common.listSep")) }));
  if (chosen.preferred) bits.push(t("routing.sum.rulePreferred", { why: chosen.preferred }));
  else if (chosen.note) bits.push(t("routing.sum.ruleNote", { note: chosen.note }));
  if (profile.pool && entry.prefer && !entry.deprioritize && !avoid.has(profile.pool)) bits.push(t("routing.sum.preferPool", { pool: profile.pool }));
  const stale = snapshotNote(snapshot);
  if (stale) bits.push(stale);
  const notes = skips.slice(0, 8).map(skipLine);
  if (notes.length > 0) bits.push(t("routing.sum.skipped", { list: notes.join(t("common.semicolon")) }));
  return bits.join(t("common.comma"));
}

function withSnapshot(reason: string, snapshot: PoolSnapshot): string {
  const stale = snapshotNote(snapshot);
  return stale ? `${reason}${t("common.paren", { text: stale })}` : reason;
}

/** Skip reason when a pool has no free slot. Callers recognize it with isPoolFullReason. */
export function poolFullReason(pool: string): string {
  return t("routing.poolFull", { pool });
}

/** Chinese "pool concurrency is full", the text older hold reasons and events carry. */
const LEGACY_POOL_FULL = "\u6c60\u5e76\u53d1\u5df2\u6ee1";

/** True when a reason (possibly wrapped, e.g. in a quota-wait label) says a pool has no free slot. */
export function isPoolFullReason(reason: string): boolean {
  const marker = poolFullReason("").trim();
  return (marker !== "" && reason.includes(marker)) || reason.includes(LEGACY_POOL_FULL);
}

const REVIEW_WAIT = new Set(["pool", "rule", "reserve", "concurrency", "snapshot"]);

/**
 * A pool the human must sign in to. Quota pace and the 5-hour window are not this.
 * Matches the pool reason AFC writes: "\u672a\u767b\u5f55" is Chinese for "not logged in"; the rest are provider texts.
 */
function loggedOutReason(reason: string | null | undefined): boolean {
  if (!reason) return false;
  return /\u672a\u767b\u5f55|not logged in|please run \/login|authentication_failed/i.test(reason);
}

/** A review with no compliant reviewer waits. Family, a paused candidate, or an empty pool can all clear. */
function reviewWaits(skips: Skip[]): boolean {
  if (skips.length === 0) return true;
  return skips.some((skip) => REVIEW_WAIT.has(skip.fatal));
}

const TEMP_QUOTA = new Set<SkipKind>(["pool", "snapshot"]);

/** Pool pause, pace, the 5-hour window, or an unseen pool. The card queues; it does not block. */
function quotaWaitDecision(skips: Skip[], emptyReason: string, snapshot: PoolSnapshot): RouteDecision {
  const pools = [...new Set(skips.filter((skip) => skip.fatal === "pool" && skip.profile.pool).map((skip) => skip.profile.pool as string))];
  const detail = skips
    .filter((skip) => skip.fatal === "pool")
    .map((skip) => `${skip.profile.pool ?? skip.profile.name}${t("common.paren", { text: skip.why })}`)
    .join(t("common.listSep"));
  const other = skips
    .filter((skip) => skip.fatal !== "pool")
    .map(skipLine)
    .join(t("common.semicolon"));
  const head = pools.length > 0 ? t("routing.noneHead", { pools: detail || pools.join(t("common.listSep")) }) : "";
  const why = [head, other].filter(Boolean).join(t("common.semicolon")) || emptyReason;
  return {
    ok: false,
    action: "hold",
    kind: "quota",
    quotaWait: true,
    pool: pools.length > 0 ? pools.join(t("common.listSep")) : null,
    reason: withSnapshot(why, snapshot),
  };
}

function permanentDecision(skips: Skip[], emptyReason: string, snapshot: PoolSnapshot): RouteDecision {
  const why = skips.map(skipLine).join(t("common.semicolon"));
  return { ok: false, action: "block", kind: "needs_human", reason: withSnapshot(why || emptyReason, snapshot) };
}

function noneLeft(skips: Skip[], emptyReason: string, snapshot: PoolSnapshot, review = false, waitForOtherFamily = false): RouteDecision {
  if (skips.length === 0) return permanentDecision(skips, emptyReason, snapshot);
  if (skips.some((skip) => skip.fatal === "effort")) {
    const reason = skips.map((skip) => t("routing.skipNamed", { name: skip.profile.name, why: skip.why })).join(t("common.semicolon"));
    const unsupportedEffort = skips.every((skip) => skip.fatal === "effort");
    return { ok: false, action: "hold", kind: unsupportedEffort ? "needs_human" : "quota", unsupportedEffort,
      reason: withSnapshot(t("routing.noEffort", { reasons: reason }), snapshot) };
  }
  const rules = skips.filter((skip) => skip.fatal === "rule");
  const capacity = skips.filter((skip) => skip.fatal === "concurrency");
  const reserved = skips.filter((skip) => skip.fatal === "reserve");
  if (rules.length > 0 || capacity.length > 0 || reserved.length > 0) {
    // Waiting can clear these: a slot frees up, the daily count resets, a reviewer appears, or someone tags the card.
    const stoppedPools = skips.filter((skip) => skip.fatal === "pool");
    const why = [...rules, ...capacity, ...reserved, ...stoppedPools].map(skipLine).join(t("common.semicolon"));
    const head = rules.length > 0 ? t("routing.ruleWaitHead") : "";
    return { ok: false, action: "hold", kind: "quota", reason: withSnapshot(`${head}${why || emptyReason}`, snapshot),
      ...(capacity.length > 0 && rules.length === 0 && reserved.length === 0 ? { concurrencyWait: true } : {}) };
  }
  // A paused, over-pace, 5-hour, or unseen pool keeps the card queued even when another
  // candidate is logged out or missing. Those permanent failures only block when nothing can recover.
  if (skips.some((skip) => TEMP_QUOTA.has(skip.fatal))) return quotaWaitDecision(skips, emptyReason, snapshot);
  const why = skips.map(skipLine).join(t("common.semicolon"));
  if (review && reviewWaits(skips)) {
    return { ok: false, action: "hold", kind: "quota", reason: withSnapshot(why || emptyReason, snapshot) };
  }
  // A target-bound automatic review can wait for a different family to become available.
  // Login, missing profiles, and hard bans must still notify the leader as permanent failures.
  if (waitForOtherFamily && skips.every((skip) => skip.fatal === "family")) {
    return { ok: false, action: "hold", kind: "quota", reason: withSnapshot(why, snapshot) };
  }
  // Logged out, missing profile, unresolved family, or a configured dispatch restriction.
  return permanentDecision(skips, emptyReason, snapshot);
}

interface Considered {
  ok: boolean;
  preferred: string | null;
  note: string | null;
}

const REJECTED: Considered = { ok: false, preferred: null, note: null };

/** Whether this profile may take the card now. `scoped` false skips the profile rules (explicit --profile). */
function consider(profile: Profile, input: RouteInput, skips: Skip[], scoped: boolean, effort?: string | null): Considered {
  const depth = effort !== undefined ? effort : (input.cardEffort ?? profileDepth(profile));
  const gpt = familyDispatchBlock(profile, depth, input.snapshot);
  if (gpt) {
    skips.push({ profile, why: gpt, fatal: gpt === poolUnseenReason() ? "snapshot" : "codex" });
    return REJECTED;
  }
  if (isDispatchBanned(profile)) {
    skips.push({ profile, why: profileBannedReason(), fatal: "codex" });
    return REJECTED;
  }
  const google = googleDispatchBlock(profile, input);
  if (google) {
    skips.push({ profile, why: google, fatal: google === t("routing.google.quota") ? "snapshot" : "rule" });
    return REJECTED;
  }
  if (profile.provider === "cursor" && assignsReadOnly(input)) {
    skips.push({ profile, why: cursorReadonlyReason(), fatal: "cursor" });
    return REJECTED;
  }
  const entry = input.snapshot.entry(profile.pool ?? null);
  if (!entry.dispatchable) {
    const why = poolClosed(profile.pool, entry.reason);
    skips.push({ profile, why, fatal: loggedOutReason(entry.reason) ? "login" : "pool" });
    return REJECTED;
  }
  const limited = onlyRolesBlock(entry, profile.pool ?? null, profilePoolRole(profile, input.review));
  if (limited) {
    skips.push({ profile, why: limited, fatal: "pool" });
    return REJECTED;
  }
  if (input.review) {
    const targetBlock = reviewFamilyBlock(profile, input.reviewTarget);
    if (targetBlock) {
      skips.push({ profile, why: targetBlock, fatal: "family" });
      return REJECTED;
    }
    // openai is compared like any other family: a GPT execution is not reviewed by GPT.
    if (!actualModel(profile.model) || profile.paused || (!input.reviewTarget && input.reviewsExecutor && !differentReviewModels(input.executorModel, profile.model))) {
      skips.push({ profile, why: t("routing.reviewModelUnavailable"), fatal: "family" });
      return REJECTED;
    }
  }
  let preferred: string | null = null;
  let note: string | null = null;
  if (scoped) {
    const verdict = ruleVerdict(profile, input, input.review ? (input.executorFamily ?? null) : (profile.family ?? null), true);
    if (!verdict.ok) {
      skips.push({ profile, why: verdict.why, fatal: "rule" });
      return REJECTED;
    }
    preferred = verdict.preferred;
    note = verdict.note;
  }
  // Only a role that later enters in_review needs a reviewer reserved up front.
  if (!input.review && (submitsToReview(input.role) || (isGoogleProfile(profile) && input.role === "batch"))) {
    const gap = reviewerGap(profile, input);
    if (gap) {
      skips.push({ profile, why: gap.why, fatal: gap.fatal });
      return REJECTED;
    }
  }
  if (profile.pool) {
    const cap = input.poolLimits[profile.pool];
    if (cap != null && (input.byPool[profile.pool] ?? 0) >= cap) {
      skips.push({ profile, why: poolFullReason(profile.pool), fatal: "concurrency" });
      return REJECTED;
    }
  }
  return { ok: true, preferred, note };
}

/** "Pinned profile X is not swapped. skipped X: does not support effort Y". */
function pinnedNoEffort(name: string, effort: string | null | undefined): string {
  const why = t("routing.skipNamed", { name, why: t("routing.noEffortSupport", { effort: effort ?? "" }) });
  return t("routing.pinnedBlocked", { name, why });
}

function routeOverride(input: RouteInput, override: string, effort?: string | null): RouteDecision {
  const chosen = findProfile(input.profiles, override);
  if (!chosen) return { ok: false, action: "block", kind: "needs_human", reason: t("routing.profileNotFound", { name: override }) };
  const skips: Skip[] = [];
  // An explicit profile is never swapped and is not limited by the scope rules.
  if (!consider(chosen, input, skips, false, effort).ok) {
    const skip = skips[0];
    if (!skip) return { ok: false, action: "block", kind: "needs_human", reason: t("routing.profileNotDispatchable", { name: override }) };
    const reason = withSnapshot(t("routing.pinnedBlocked", { name: chosen.name, why: skip.why }), input.snapshot);
    const pool = chosen.pool ?? null;
    if (skip.fatal === "login" || skip.fatal === "missing") {
      return { ok: false, action: "block", kind: "needs_human", reason, pool };
    }
    if (skip.fatal === "snapshot") return { ok: false, action: "hold", kind: "quota", quotaWait: true, reason, pool };
    if (skip.fatal === "concurrency") {
      return { ok: false, action: "hold", kind: "quota", concurrencyWait: true, reason, pool };
    }
    if (skip.fatal === "reserve") {
      return { ok: false, action: "hold", kind: "quota", reason, pool };
    }
    if (skip.fatal === "pool") return { ok: false, action: "hold", kind: "quota", quotaWait: true, reason, pool };
    if (input.review && REVIEW_WAIT.has(skip.fatal)) return { ok: false, action: "hold", kind: "quota", reason, pool };
    return { ok: false, action: "block", kind: "needs_human", reason, pool };
  }
  if (effort === undefined && input.cardEffort && input.supportsEffort && !input.supportsEffort(chosen, input.cardEffort)) {
    return { ok: false, action: "hold", kind: "needs_human", unsupportedEffort: true,
      reason: pinnedNoEffort(chosen.name, input.cardEffort) };
  }
  const stale = snapshotNote(input.snapshot);
  return { ok: true, profile: chosen, reason: `${t("routing.pinnedOk", { name: chosen.name })}${stale ? `${t("common.comma")}${stale}` : ""}` };
}

function routeByRoster(input: RouteInput): RouteDecision {
  const avoid = new Set((input.avoidPools ?? []).filter(Boolean));
  if (input.profileOverride) return routeOverride(input, input.profileOverride);
  const skips: Skip[] = [];
  const viable: Ranked[] = [];
  roster(input.profiles, input.role).forEach((profile, index) => {
    const seen = consider(profile, input, skips, true);
    if (!seen.ok) return;
    if (input.cardEffort && input.supportsEffort && !input.supportsEffort(profile, input.cardEffort)) {
      skips.push({ profile, why: t("routing.noEffortSupport", { effort: input.cardEffort }), fatal: "effort" });
      return;
    }
    viable.push({ profile, index, tier: tierOf(profile, input.snapshot, avoid), preferred: seen.preferred, note: seen.note });
  });
  if (viable.length === 0) {
    return noneLeft(skips, input.review ? t("routing.noReviewProfile") : t("routing.noRoleProfile", { role: input.role }), input.snapshot, input.review, input.reviewTarget?.ok);
  }
  viable.sort((a, b) => compareRanked(a, b, input.snapshot));
  const chosen = viable[0];
  if (!chosen) return noneLeft(skips, t("routing.noProfile"), input.snapshot, input.review, input.reviewTarget?.ok);
  return { ok: true, profile: chosen.profile, reason: summarize(chosen, skips, input.snapshot, avoid) };
}

function highRiskTags(input: RouteInput): readonly string[] {
  const tags = input.tags ?? [];
  if (input.tier === "L4" && !tags.includes("high-risk")) return [...tags, "high-risk"];
  return tags;
}

function cardTier(input: RouteInput, matrix: DispatchMatrix | null): Tier {
  return resolveTier(input.tier ?? null, input.tags ?? [], matrix?.defaultTier ?? null);
}

/**
 * The candidate automatic routing would pick for this card from the matrix, ignoring any
 * explicit profile. Null when there is no matrix, the role falls back to the old roster,
 * or nobody in the list can go. Used for the create-time hint only.
 */
export function matrixFirstChoice(input: RouteInput): { profile: Profile; tier: Tier } | null {
  if (!input.matrix) return null;
  const tags = highRiskTags(input);
  const resolved = withExecutorFamily({ ...input, tags, profileOverride: null });
  if ("ok" in resolved) return null;
  const next = resolved;
  const via = routeByMatrix(next, input.matrix);
  if ("fallback" in via || !via.ok) return null;
  return { profile: via.profile, tier: cardTier(next, input.matrix) };
}

/** L4 is treated as high-risk for the old rules. A parsed matrix replaces the roster. */
/** Executor family for a review. Empty family falls back to the recorded executor profile. */
function withExecutorFamily(input: RouteInput): RouteInput | RouteDecision {
  if (input.reviewTarget) {
    if (!input.reviewTarget.ok) return { ok: false, action: "block", kind: "needs_human", reason: input.reviewTarget.reason };
    if (!actualModel(input.reviewTarget.model)) return { ok: false, action: "block", kind: "needs_human", reason: t("routing.reviewModelUnavailable") };
    return { ...input, review: true, executorFamily: input.reviewTarget.family, executorModel: input.reviewTarget.model, executorProvider: input.reviewTarget.provider, executorProfile: input.reviewTarget.profile, reviewsExecutor: true };
  }
  if (!input.review) return input;
  const named = input.executorProfile ? findProfile(input.profiles, input.executorProfile) : undefined;
  const bound = input.reviewsExecutor || Boolean(input.executorFamily || input.executorProfile || input.executorModel);
  if (!bound) return input;
  const model = actualModel(input.executorModel ?? named?.model);
  if (!model) return { ok: false, action: "block", kind: "needs_human", reason: t("routing.reviewModelUnavailable") };
  const family = input.executorProvider && isGoogleProfile({provider: input.executorProvider, model}) ? "google"
    : named && isGoogleProfile(named) ? "google" : input.executorFamily ?? (named ? actualFamily(named) : null);
  return { ...input, executorModel: model, executorFamily: family, reviewsExecutor: true };
}

/** Historical provider/model identity survives profile renames and label changes. */
export function recordedExecutorFacts(taskId: number): { executorProvider?: string; executorModel?: string | null } {
  const run = getDb().prepare("SELECT provider, model FROM runs WHERE task_id = ? AND role != 'reviewer' ORDER BY id DESC LIMIT 1").get(taskId) as { provider: string; model: string | null } | undefined;
  return run ? { executorProvider: run.provider, executorModel: run.model } : {};
}

export function routeProfile(input: RouteInput): RouteDecision {
  const decision = routeResolved(input);
  const target = input.reviewTarget;
  if (!target?.ok) return decision;
  return annotate(decision, t("reviewTarget.evidence", { card: target.card, family: target.family, source: target.source, run: target.runId ?? "legacy" }));
}

function routeResolved(input: RouteInput): RouteDecision {
  const resolved = withExecutorFamily(input);
  if ("ok" in resolved) return resolved;
  const tags = highRiskTags(resolved);
  const next = tags === resolved.tags ? resolved : { ...resolved, tags };
  if (next.matrix) {
    const via = routeByMatrix(next, next.matrix);
    if ("fallback" in via) {
      const old = routeByRoster({ ...next, matrix: null });
      return { ...old, reason: `${via.fallback}${old.reason}` };
    }
    return via;
  }
  return routeByRoster(next);
}

const EFFORT_SOURCE_KEYS = {
  card: "routing.effortSource.card",
  downgrade: "routing.effortSource.downgrade",
  matrix: "routing.effortSource.matrix",
  profile: "routing.effortSource.profile",
} as const satisfies Record<EffortSource, string>;

function effortPhrase(effort: string | null, source: EffortSource): string {
  const label = t(EFFORT_SOURCE_KEYS[source]);
  // The English paren starts with a space; without an effort in front it is not wanted.
  return effort ? `${effort}${t("common.paren", { text: label })}` : t("common.paren", { text: label }).trimStart();
}

function withMatrixNote(reason: string, note: string | null): string {
  return note ? `${reason}; ${note}` : reason;
}

function matrixReason(
  tier: Tier,
  profile: Profile,
  effort: string | null,
  source: EffortSource,
  skips: Skip[],
  snapshot: PoolSnapshot,
): string {
  const semicolon = t("common.semicolon");
  const notes = skips.slice(0, 8).map(skipLine);
  const skipText = notes.length > 0 ? `${semicolon}${t("routing.sum.skipped", { list: notes.join(semicolon) })}` : "";
  const stale = snapshotNote(snapshot);
  return `${tier}${t("common.comma")}${profile.name} ${effortPhrase(effort, source)}${skipText}${stale ? `${semicolon}${stale}` : ""}`;
}

function resolveItemEffort(
  item: MatrixItem | null,
  profile: Profile,
  card: Effort | null,
  lowered: boolean,
): { effort: string | null; source: EffortSource } {
  if (card) return { effort: card, source: "card" };
  if (item?.effort) return { effort: item.effort, source: lowered ? "downgrade" : "matrix" };
  return { effort: profileDepth(profile), source: "profile" };
}

/**
 * For candidates without explicit orders, lower goes first; ties keep the matrix order. While the matrix priority is in force,
 * AFC has already ordered the list by the user's pool order, so prefer ranks like a
 * normal pool. deprioritize and a pool that just rate-limited still go last.
 */
function matrixRank(profile: Profile | null, snapshot: PoolSnapshot, avoid: Set<string>, ordered: boolean): number {
  if (!profile?.pool) return 1;
  if (avoid.has(profile.pool)) return 3;
  const entry = snapshot.entry(profile.pool);
  if (entry.deprioritize) return 2;
  if (entry.prefer && !ordered) return 0;
  return 1;
}

/**
 * AFC writes the matrix and the pool snapshot together, so a stale snapshot means the matrix
 * pauses are just as old. They are ignored then, and so are the pauses of a matrix export that
 * is stale on its own; the stop lines in staleEntry still apply.
 */
function matrixPaused(item: MatrixItem, snapshot: PoolSnapshot, matrix: DispatchMatrix | null | undefined): boolean {
  return item.paused && snapshot.state !== "stale" && matrix?.stale !== true;
}

/** Said once in the reason when only the matrix is stale (a stale snapshot already says so). */
function matrixStaleNote(matrix: DispatchMatrix | null | undefined, snapshot: PoolSnapshot): string | null {
  if (matrix?.stale !== true || snapshot.state === "stale") return null;
  const minutes = matrix.ageMs != null ? staleMinutes(matrix.ageMs) : null;
  return `dispatch matrix is ${minutes != null ? `${minutes} minutes ` : ""}stale: its paused marks are ignored`;
}

function ghost(name: string, role: string): Profile {
  return { id: name, name, provider: "missing", role };
}

interface Pick {
  profile: Profile;
  effort: string | null;
  source: EffortSource;
  skips: Skip[];
}

/** Walk the reordered list once. Null when nobody in it can take the card. */
function pickFromList(items: MatrixItem[], input: RouteInput, tier: Tier, lowered: boolean): Pick | { skips: Skip[] } {
  const avoid = new Set((input.avoidPools ?? []).filter(Boolean));
  const byPriority = priorityActive(input.matrix, input.now ?? Date.now());
  const rank = (profile: Profile | null) => matrixRank(profile, input.snapshot, avoid, byPriority);
  const ordered = items
    .map((item, index) => ({ item, index, profile: findProfile(input.profiles, item.profile) ?? null }))
    .sort((a, b) => {
      const aOrder = a.item.order;
      const bOrder = b.item.order;
      if (aOrder !== undefined || bOrder !== undefined) {
        if (aOrder === undefined) return 1;
        if (bOrder === undefined) return -1;
        return aOrder - bOrder || a.index - b.index;
      }
      return rank(a.profile) - rank(b.profile) || a.index - b.index;
    });
  const skips: Skip[] = [];
  for (const entry of ordered) {
    if (matrixPaused(entry.item, input.snapshot, input.matrix)) {
      skips.push({ profile: entry.profile ?? ghost(entry.item.profile, input.role), why: t("routing.matrixPaused"), fatal: "pool" });
      continue;
    }
    if (!entry.profile) {
      skips.push({ profile: ghost(entry.item.profile, input.role), why: t("routing.profileMissing"), fatal: "missing" });
      continue;
    }
    const pausedProfile = opsProfileBlock(entry.profile, input);
    if (pausedProfile) {
      skips.push({ profile: entry.profile, why: pausedProfile, fatal: "pool" });
      continue;
    }
    const resolved = resolveItemEffort(entry.item, entry.profile, input.cardEffort ?? null, lowered);
    if (!consider(entry.profile, input, skips, false, resolved.effort).ok) continue;
    if (resolved.effort && input.supportsEffort && !input.supportsEffort(entry.profile, resolved.effort)) {
      skips.push({ profile: entry.profile, why: t("routing.noEffortSupport", { effort: resolved.effort }), fatal: "effort" });
      continue;
    }
    return { profile: entry.profile, effort: resolved.effort, source: resolved.source, skips };
  }
  return { skips };
}

function lowerItems(items: MatrixItem[], profiles: Profile[]): MatrixItem[] | null {
  let changed = false;
  const next = items.map((item) => {
    const own = findProfile(profiles, item.profile)?.thinkingOptionId ?? null;
    const base = item.effort ?? (own === "ultra" || isEffortValue(own) ? own : null);
    const lower = lowerDepth(base);
    if (!lower) return item;
    changed = true;
    return { ...item, effort: lower };
  });
  return changed ? next : null;
}

function finishPick(input: RouteInput, matrix: DispatchMatrix, tier: Tier, pick: Pick): RouteDecision {
  return {
    ok: true,
    profile: pick.profile,
    reason: withMatrixNote(matrixReason(tier, pick.profile, pick.effort, pick.source, pick.skips, input.snapshot), matrixStaleNote(matrix, input.snapshot)),
    effort: pick.effort,
    effortSource: pick.source,
    allowDowngrade: pick.source === "matrix" && matrix.downgradeWhenTight.includes(tier),
  };
}

function matrixNone(input: RouteInput, tier: Tier, skips: Skip[], downgraded: boolean): RouteDecision {
  const empty = input.review ? t("routing.noReviewProfile") : t("routing.noProfile");
  const decision = noneLeft(skips, empty, input.snapshot, input.review, input.reviewTarget?.ok);
  let reason = decision.reason.startsWith(tier) ? decision.reason : `${tier}${t("common.comma")}${decision.reason}`;
  if (downgraded) reason = `${reason}${t("common.semicolon")}${t("routing.downgradedStill")}`;
  return { ...decision, reason };
}

/** Select inside one matrix list. Does not look outside it. */
function selectList(items: MatrixItem[], input: RouteInput, matrix: DispatchMatrix, tier: Tier): RouteDecision {
  const first = pickFromList(items, input, tier, false);
  if ("profile" in first) return finishPick(input, matrix, tier, first);
  const tight = matrix.downgradeWhenTight.includes(tier) && !input.cardEffort;
  const lowered = tight ? lowerItems(items, input.profiles) : null;
  if (lowered) {
    const second = pickFromList(lowered, input, tier, true);
    if ("profile" in second) return finishPick(input, matrix, tier, second);
    return matrixNone(input, tier, second.skips, true);
  }
  return matrixNone(input, tier, first.skips, false);
}

type MatrixList = { items: MatrixItem[] } | { fallback: string } | { unavailable: string };

function reviewBucket(input: RouteInput, matrix: DispatchMatrix) {
  if (matrix.reviewerModels !== undefined) {
    const model = actualModel(input.executorModel);
    return model ? matrix.reviewerModels[model] : undefined;
  }
  return input.executorFamily ? matrix.reviewerFamilies[input.executorFamily] : undefined;
}

function reviewList(input: RouteInput, matrix: DispatchMatrix, tier: Tier): MatrixList {
  if (matrix.reviewerModels !== undefined) {
    if (input.reviewsExecutor) {
      const bucket = reviewBucket(input, matrix);
      return bucket ? { items: bucket[tier] ?? [] } : { unavailable: t("routing.reviewModelUnavailable") };
    }
    const seen = new Set<string>();
    return { items: Object.values(matrix.reviewerModels).flatMap(bucket => bucket[tier] ?? []).filter(item => { if (seen.has(item.profile)) return false; seen.add(item.profile); return true; }) };
  }
  const families = matrix.reviewerFamilies;
  if (input.executorFamily) {
    const bucket = families[input.executorFamily];
    if (!bucket) {
      if (input.reviewTarget?.ok) return { unavailable: t("routing.noFamilyReviewRoster", { family: input.executorFamily }) };
      return { fallback: t("routing.noFamilyRoster", { family: input.executorFamily }) };
    }
    return { items: bucket[tier] ?? [] };
  }
  const specified = input.profileOverride ? findProfile(input.profiles, input.profileOverride) : undefined;
  for (const [family, bucket] of Object.entries(families)) {
    const items = bucket[tier] ?? [];
    if (items.length > 0) return { items };
  }
  return { fallback: t("routing.standaloneFallback") };
}

/**
 * Ops automatic matrix picks wait when the named profile is paused, or was turned into a
 * personal profile that is the paused candidate for this ops role. Matrix item.paused is separate.
 * Executor, reviewer, reader, decision and batch do not use this check.
 */
function opsProfileBlock(profile: Profile, input: RouteInput): string | null {
  if (input.review || !isOpsRole(input.role)) return null;
  if (profile.paused === true) return t("routing.opsProfilePaused");
  if (profile.role === "personal" && profile.pausedCandidateFor === input.role) return t("routing.opsProfilePersonal", { role: input.role });
  return null;
}

function listForRole(input: RouteInput, matrix: DispatchMatrix, tier: Tier): MatrixList {
  if (input.review || input.role === "reviewer") return reviewList(input, matrix, tier);
  if (input.role === "executor") return { items: matrix.executor[tier] ?? [] };
  if (isWildcardRole(input.role)) {
    const tierItems = isOpsRole(input.role) ? undefined : matrix.starTiers?.[input.role]?.[tier];
    return { items: tierItems ?? matrix.star[input.role] ?? [] };
  }
  return { items: [] };
}

function itemNamed(items: MatrixItem[], name: string): MatrixItem | null {
  return items.find((item) => item.profile === name) ?? null;
}

function routeMatrixOverride(input: RouteInput, matrix: DispatchMatrix, tier: Tier, items: MatrixItem[]): RouteDecision {
  const override = input.profileOverride ?? "";
  const chosen = findProfile(input.profiles, override);
  const item = chosen ? itemNamed(items, chosen.name) : null;
  let resolved = chosen ? resolveItemEffort(item, chosen, input.cardEffort ?? null, false) : { effort: null, source: "profile" as const };
  const decision = routeOverride(input, override, chosen ? resolved.effort : undefined);
  if (!decision.ok) return decision;
  if (resolved.effort && input.supportsEffort && !input.supportsEffort(decision.profile, resolved.effort)) {
    const lower = resolved.source === "matrix" ? lowerDepth(resolved.effort) : null;
    if (lower && matrix.downgradeWhenTight.includes(tier) && input.supportsEffort(decision.profile, lower)) {
      resolved = { effort: lower, source: "downgrade" };
    } else {
      const reason = `${tier}${t("common.comma")}${pinnedNoEffort(decision.profile.name, resolved.effort)}`;
      const pool = decision.profile.pool ?? null;
      return { ok: false, action: "hold", kind: "needs_human", unsupportedEffort: true, reason, pool };
    }
  }
  const stale = snapshotNote(input.snapshot);
  const semicolon = t("common.semicolon");
  const reason = `${tier}${t("common.comma")}${decision.profile.name} ${effortPhrase(resolved.effort, resolved.source)}${semicolon}${t("routing.pinnedShort")}${stale ? `${semicolon}${stale}` : ""}`;
  return {
    ok: true,
    profile: decision.profile,
    reason,
    effort: resolved.effort,
    effortSource: resolved.source,
    allowDowngrade: resolved.source === "matrix" && matrix.downgradeWhenTight.includes(tier),
  };
}

function highRiskReviewNote(): string {
  return t("routing.highRiskNote");
}

function isReviewRoute(input: RouteInput): boolean {
  return input.review || input.role === "reviewer";
}

function annotate(decision: RouteDecision, note: string | null): RouteDecision {
  if (!note || decision.reason.includes(note)) return decision;
  return { ...decision, reason: `${decision.reason}${t("common.semicolon")}${note}` };
}

interface ReviewRoster {
  tier: Tier;
  note: string | null;
}

/**
 * A high-risk review looks up the L4 roster even when the card stores a lower tier.
 * Execution keeps the stored tier. Reserving a reviewer before that execution starts
 * uses the same lookup. A missing L4 list falls back to the stored tier.
 * A missing family bucket queues target-bound automatic reviews; legacy callers keep the fallback.
 */
function reviewRoster(input: RouteInput, matrix: DispatchMatrix, stored: Tier): ReviewRoster {
  if (!isReviewRoute(input) || !(input.tags ?? []).includes("high-risk") || stored === "L4") {
    return { tier: stored, note: null };
  }
  if (input.executorFamily) {
    const bucket = reviewBucket(input, matrix);
    if (!bucket) return { tier: stored, note: null };
    if ((bucket.L4 ?? []).length === 0) return { tier: stored, note: t("routing.highRiskMissing", { tier: stored }) };
    return { tier: "L4", note: highRiskReviewNote() };
  }
  const elevated = reviewList(input, matrix, "L4");
  if ("items" in elevated && elevated.items.length > 0) return { tier: "L4", note: highRiskReviewNote() };
  const original = reviewList(input, matrix, stored);
  if ("items" in original && original.items.length > 0) {
    return { tier: stored, note: t("routing.highRiskMissing", { tier: stored }) };
  }
  return { tier: stored, note: null };
}

function routeByMatrix(input: RouteInput, matrix: DispatchMatrix): RouteDecision | { fallback: string } {
  const stored = cardTier(input, matrix);
  const roster = reviewRoster(input, matrix, stored);
  const tier = roster.tier;
  const listed = listForRole(input, matrix, tier);
  // An explicit profile stays even when this role has no usable list. The list is only for depth.
  if (input.profileOverride) return annotate(routeMatrixOverride(input, matrix, tier, "items" in listed ? listed.items : []), roster.note);
  if ("unavailable" in listed) {
    return annotate({ ok: false, action: "hold", kind: "quota", quotaWait: true, reason: listed.unavailable }, roster.note);
  }
  if ("fallback" in listed) {
    if (roster.note) return { fallback: t("routing.noteThen", { note: roster.note, rest: listed.fallback }) };
    return listed;
  }
  if (listed.items.length === 0) {
    const who = roleLabel(input.review ? "reviewer" : input.role);
    return annotate(
      {
        ok: false,
        action: "hold",
        kind: "quota",
        quotaWait: true,
        reason: t("routing.noCandidates", { tier, role: who }),
      },
      roster.note,
    );
  }
  // A missing or unusable quota export leaves non-GPT pools open. Ops automatic dispatch
  // does not use that fallback. Reader, decision, batch, executor and reviewer still do.
  if (!input.review && isOpsRole(input.role) && input.snapshot.state === "missing") {
    return annotate(
      {
        ok: false,
        action: "hold",
        kind: "quota",
        quotaWait: true,
        reason: t("routing.opsQuotaMissing", { tier }),
      },
      roster.note,
    );
  }
  return annotate(selectList(listed.items, input, matrix, tier), roster.note);
}

function withRosterNote(why: string, note: string | null): string {
  if (!note || why.includes(note)) return why;
  return t("routing.noteThen", { note, rest: why });
}

/** Reviewers named by the matrix for this executor's family. Profile rules are not applied.
 * A high-risk card reserves from the L4 review roster, the same lookup a later review uses.
 */
function matrixReviewerGap(executor: Profile, input: RouteInput): { why: string; fatal: SkipKind } | null {
  const matrix = input.matrix;
  if (!matrix) return null;
  const stored = cardTier(input, matrix);
  const family = actualFamily(executor) ?? "";
  const roster = reviewRoster(
    {
      ...input,
      review: true,
      role: "reviewer",
      executorFamily: family || input.executorFamily || null,
      executorModel: executor.model,
      reviewsExecutor: true,
    },
    matrix,
    stored,
  );
  const tier = roster.tier;
  const bucket = reviewBucket({ ...input, executorFamily: family, executorModel: executor.model }, matrix);
  if (!bucket) {
    return { why: withRosterNote(t("routing.noFamilyReviewRoster", { family: family || t("routing.unknown") }), roster.note), fatal: "reserve" };
  }
  const items = bucket[tier] ?? [];
  const notes: string[] = [];
  for (const item of items) {
    if (matrixPaused(item, input.snapshot, input.matrix)) {
      notes.push(t("routing.skipItem", { name: item.profile, why: t("routing.matrixPaused") }));
      continue;
    }
    const profile = findProfile(input.profiles, item.profile);
    if (!profile) {
      notes.push(t("routing.skipItem", { name: item.profile, why: t("routing.profileMissing") }));
      continue;
    }
    const why = reviewerOk(profile, executor, input, item.effort ?? profileDepth(profile));
    if (why) {
      notes.push(t("routing.skipItem", { name: profile.name, why }));
      continue;
    }
    return null;
  }
  const why = notes.length > 0 ? `${t("routing.noReviewer")}${t("common.paren", { text: notes.slice(0, 4).join(t("common.semicolon")) })}` : t("routing.noReviewer");
  return { why: withRosterNote(why, roster.note), fatal: "reserve" };
}

export interface Occupancy {
  global: number;
  byPool: Record<string, number>;
  byRole: Record<string, number>;
  /** Directories held by a card that may change files. Read-only work never lands here. */
  workspaces: Set<string>;
}

/**
 * Whether work in this role takes the directory lock. Only work that may change files does
 * (executor, batch, and any role we do not know). Reading, deciding and reviewing neither take
 * the lock nor wait for it.
 */
export function holdsWorkspace(role: string): boolean {
  return !READ_ONLY_ROLES.has(role);
}

export function currentOccupancy(profiles: Profile[]): Occupancy {
  const rows = getDb()
    .prepare(
      `SELECT t.workspace_path, t.workspace_kind, t.status, t.role AS task_role, r.role, r.profile_name
       FROM tasks t
       LEFT JOIN runs r ON r.id = (
         SELECT id FROM runs WHERE task_id = t.id ORDER BY id DESC LIMIT 1
       )
       WHERE t.status IN ('running', 'reviewing')`,
    )
    .all() as unknown as Array<{
    workspace_path: string | null;
    workspace_kind: string | null;
    status: string;
    task_role: string;
    role: string | null;
    profile_name: string | null;
  }>;
  const occ: Occupancy = { global: 0, byPool: {}, byRole: {}, workspaces: new Set() };
  for (const row of rows) {
    occ.global += 1;
    const role = row.role ?? (row.status === "reviewing" ? "reviewer" : row.task_role);
    occ.byRole[role] = (occ.byRole[role] ?? 0) + 1;
    const profile = row.profile_name ? profiles.find((item) => item.name === row.profile_name) : undefined;
    const pool = profile?.pool ?? null;
    if (pool) occ.byPool[pool] = (occ.byPool[pool] ?? 0) + 1;
    const kind = row.workspace_kind ?? "dir";
    const writes = row.status === "running" && holdsWorkspace(role);
    if (writes && kind === "dir" && row.workspace_path) occ.workspaces.add(row.workspace_path);
  }
  return occ;
}

function poolLabel(pool: string | null): string {
  return pool ?? unmarkedPool();
}

/**
 * DEMO_0001: a card that pins --profile in another pool than the matrix's first dispatchable
 * candidate gets one hint at create. Same lookup and pool concurrency as automatic routing.
 * If occupancy cannot be read, fall back to ignoring concurrency so create can continue.
 * No matrix, an unknown pinned profile, or nobody dispatchable means no hint.
 */
export function profilePriorityHint(task: TaskRow): ProfilePriorityHint | null {
  if (!task.profile_override) return null;
  const matrix = loadDispatchMatrix();
  if (matrix.state !== "ok") return null;
  const profiles = readProfiles();
  const pinned = findProfile(profiles, task.profile_override);
  if (!pinned) return null;
  const settings = loadConfig();
  let byPool: Record<string, number> = {};
  let poolLimits: Record<string, number> = {};
  try {
    byPool = currentOccupancy(profiles).byPool;
    poolLimits = settings.concurrency.pools;
  } catch {
    // The hint is advisory: an occupancy read failure must not prevent card creation.
  }
  const first = matrixFirstChoice({
    profiles,
    role: task.role,
    review: task.role === "reviewer",
    reviewTarget: resolveReviewTarget(task, task.role === "reviewer"),
    byPool,
    poolLimits,
    snapshot: readPoolSnapshot(),
    matrix: matrix.matrix,
    tier: task.tier,
    ...cardRouteContext(task, settings.profileRules),
  });
  if (!first) return null;
  const pool = pinned.pool ?? null;
  const suggestedPool = first.profile.pool ?? null;
  if (pool === suggestedPool) return null;
  const message = t("routing.priorityHint", { profile: pinned.name, pool: poolLabel(pool), suggested: first.profile.name, suggestedPool: poolLabel(suggestedPool) });
  return { profile: pinned.name, pool, suggested: first.profile.name, suggestedPool, role: task.role, tier: first.tier, message };
}

setProfileHintSource(profilePriorityHint);
