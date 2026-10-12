import { z } from "zod";
import { t } from "./i18n";

export const leaderTargetSchema = z.object({
  agentId: z.string().nullable(),
  reason: z.string().nullable(),
});
export type LeaderTarget = z.infer<typeof leaderTargetSchema>;

export const openDecisionSchema = z.object({
  id: z.string(),
  project: z.string().min(1),
  title: z.string(),
  detail: z.string(),
  blocking: z.boolean(),
  status: z.literal("open"),
  createdAt: z.string(),
  agentId: z.string().nullable().optional().transform((id) => id?.trim() || null),
/** Who owns the decision in the cockpit, e.g. "demo <leader>". A malformed value is dropped. */
  owner: z.string().nullable().optional().catch(null),
  /** The user's and leaders' later notes. Malformed notes are dropped so the whole list stays readable. */
  userComments: z.array(z.object({ at: z.string(), note: z.string() })).optional().catch(undefined),
});
export type OpenDecision = z.infer<typeof openDecisionSchema>;
export const decisionViewSchema = openDecisionSchema.extend({ leader: leaderTargetSchema });
export type DecisionView = z.infer<typeof decisionViewSchema>;
export const decisionsSnapshotSchema = z.object({
  items: z.array(decisionViewSchema),
  message: z.string().nullable(),
});
export type DecisionsSnapshot = z.infer<typeof decisionsSnapshotSchema>;

/** Blocking decisions first, then the oldest. Unknown dates come last. */
export function sortDecisions<T extends OpenDecision>(items: readonly T[]): T[] {
  const age = (item: T) => Number.isFinite(Date.parse(item.createdAt)) ? Date.parse(item.createdAt) : Number.MAX_SAFE_INTEGER;
  return [...items].sort((a, b) => Number(b.blocking) - Number(a.blocking)
    || age(a) - age(b));
}

export function decisionGroups(items: readonly DecisionView[]): Array<{ project: string; items: DecisionView[] }> {
  const groups = new Map<string, DecisionView[]>();
  for (const item of sortDecisions(items)) {
    const group = groups.get(item.project) ?? [];
    group.push(item);
    groups.set(item.project, group);
  }
  return [...groups].map(([project, items]) => ({ project, items }));
}

/** Match an entire displayed card code, including codes next to Chinese punctuation. */
export function cardDecisions(code: string, items: readonly DecisionView[]): DecisionView[] {
  if (!code) return [];
  const escaped = code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(^|[^a-z0-9_])${escaped}(?![a-z0-9_])`, "i");
  return sortDecisions(items.filter((item) => match.test(`${item.title}\n${item.detail}`)));
}

export function projectAttentionTotals(
  tasks: ReadonlyArray<{ project: string; status: string }>,
  decisions: readonly DecisionView[],
): Array<{ project: string; acceptance: number; blocked: number; decisions: number }> {
  const totals = new Map<string, { project: string; acceptance: number; blocked: number; decisions: number }>();
  function row(project: string) {
    let value = totals.get(project);
    if (!value) {
      value = { project, acceptance: 0, blocked: 0, decisions: 0 };
      totals.set(project, value);
    }
    return value;
  }
  for (const task of tasks) {
    const total = row(task.project);
    if (task.status === "acceptance") total.acceptance++;
    if (task.status === "blocked") total.blocked++;
  }
  for (const decision of decisions) row(decision.project).decisions++;
  return [...totals.values()].sort((a, b) => a.project.localeCompare(b.project));
}

/** Human-readable reason for a card that needs attention, alongside its leader link. */
export function cardHoldReason(task: {
  status: string; blockedReason: string | null; nextStep: string | null;
  returnNote: string | null; unattended: boolean; stallNote: string | null;
}): string | null {
  if (task.status === "done" || task.status === "archived") return null;
  if (task.status === "blocked") return task.blockedReason || task.nextStep || t("decisions.hold.blocked");
  if (task.status === "acceptance") return task.nextStep || t("decisions.hold.acceptance");
  if (task.status === "rework") return task.nextStep || task.returnNote || t("decisions.hold.rework");
  if (task.nextStep) return task.nextStep;
  if (task.stallNote) return task.stallNote;
  if (task.unattended) return t("decisions.hold.unattended");
  if (task.status === "triage") return t("decisions.hold.triage");
  return null;
}

const CARD_CODE = /(?<![A-Za-z0-9_])[A-Za-z]{2,8}_\d{4}(?![A-Za-z0-9_])/g;

/** Card codes named in a decision's title, detail and notes, upper-cased, in order of first mention. */
export function decisionCardCodes(item: Pick<OpenDecision, "title" | "detail" | "userComments">): string[] {
  const text = [item.title, item.detail, ...(item.userComments ?? []).map((comment) => comment.note)].join("\n");
  return [...new Set((text.match(CARD_CODE) ?? []).map((code) => code.toUpperCase()))];
}

/** The newest note, or null. Unparseable dates sort first so a dated note always wins. */
export function latestComment(item: Pick<OpenDecision, "userComments">): { at: string; note: string } | null {
  const comments = item.userComments ?? [];
  const time = (c: { at: string }) => Number.isFinite(Date.parse(c.at)) ? Date.parse(c.at) : -1;
  return comments.reduce<{ at: string; note: string } | null>((best, c) => (!best || time(c) >= time(best) ? c : best), null);
}
