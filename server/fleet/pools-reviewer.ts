/// <reference types="node" />
// Temporary, dated relaxation of Claude's 75% reserve. Lives on plans.json `reviewerException` of the leader's
// pool (the Claude plan, shared/quota-adapters.ts leaderPool).
import { adapterSpec, baseAdapterOf, type PlanSource } from "../../shared/fleet/quota-adapters";
import type { UsagePlan } from "../../shared/fleet/usage";
import { readPlanSources } from "./adapters/plans";
import { SUPERVISOR_WEEKLY_RESERVE } from "./pools-windows";
import { t, tAll } from "../../shared/fleet/i18n";
import { escapeRegex } from "./pools-unread";

/**
 * Missing, invalid, or past `until` means the field is not there. A double week or a named burn week ignores it.
 */
export interface ReviewerException {
  roles: string[];
  stopPct: number;
  until: string;
  note?: string;
}

function isLeaderPlan(plan: PlanSource): boolean {
  return adapterSpec(baseAdapterOf(plan)).leaderPool;
}

export function parseReviewerException(raw: unknown): ReviewerException | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as { roles?: unknown; stopPct?: unknown; until?: unknown; note?: unknown };
  if (!Array.isArray(row.roles) || row.roles.length === 0) return null;
  const roles = row.roles.filter((role): role is string => typeof role === "string" && role.length > 0);
  if (roles.length !== row.roles.length) return null;
  if (typeof row.stopPct !== "number" || !Number.isFinite(row.stopPct) || row.stopPct <= SUPERVISOR_WEEKLY_RESERVE) return null;
  if (typeof row.until !== "string" || Number.isNaN(Date.parse(row.until))) return null;
  const note = typeof row.note === "string" && row.note ? row.note : undefined;
  return { roles, stopPct: row.stopPct, until: row.until, ...(note ? { note } : {}) };
}

function exceptionOnPlan(plan: UsagePlan): ReviewerException | null {
  return parseReviewerException((plan as { reviewerException?: unknown }).reviewerException);
}

/** Active only while `now` is strictly before `until`. A double week or burn week keeps its own stop line. */
export function activeReviewerException(plan: UsagePlan, now: number, doubleWeek: boolean): ReviewerException | null {
  if (doubleWeek) return null;
  const exception = exceptionOnPlan(plan);
  if (!exception) return null;
  return now < Date.parse(exception.until) ? exception : null;
}

function tokyoMonthDay(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return t("pools.reviewer.resetDay");
  const tokyo = new Date(ms + 9 * 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(tokyo.getUTCMonth() + 1)}/${pad(tokyo.getUTCDate())}`;
}

function decisionPhrase(exception: ReviewerException): string {
  const when = tokyoMonthDay(exception.until);
  const users = tAll("pools.reviewer.userToken").map(escapeRegex).join("|");
  const dated = new RegExp(`(?:${users})\\s*(\\d{4})-(\\d{2})-(\\d{2})`, "i").exec(exception.note ?? "");
  const who = dated ? t("pools.reviewer.userDecided", { date: `${dated[2]}-${dated[3]}` }) : t("pools.reviewer.temporary");
  return t("pools.reviewer.decision", { who, when });
}

export function reviewerBandReason(used: number, exception: ReviewerException): string {
  const who = exception.roles.length === 1 && exception.roles[0] === "reviewer"
    ? t("pools.reviewer.reviewRole")
    : exception.roles.join(t("pools.reviewer.roleSeparator"));
  return t("pools.reviewer.band", { used: Math.round(used), who, stop: exception.stopPct, decision: decisionPhrase(exception) });
}

export function reviewerStopReason(used: number, exception: ReviewerException): string {
  return t("pools.reviewer.stop", { used: Math.round(used), stop: exception.stopPct });
}

/** Read the leader plan's reviewerException from plans.json. Null when the field is missing or not usable. */
export async function readPlansReviewerException(): Promise<ReviewerException | null> {
  const plan = (await readPlanSources()).find(isLeaderPlan) as (PlanSource & { reviewerException?: unknown }) | undefined;
  return parseReviewerException(plan?.reviewerException);
}

/** Copy a parsed exception onto the leader plan when that plan object does not already carry one. */
export function withReviewerException(plans: UsagePlan[], exception: ReviewerException | null): UsagePlan[] {
  if (!exception) return plans;
  return plans.map((plan) => {
    if (!isLeaderPlan(plan) || exceptionOnPlan(plan)) return plan;
    return { ...plan, reviewerException: exception } as UsagePlan;
  });
}
