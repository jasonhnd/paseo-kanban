/** Shared by the action panel and Leader tab; no RPC or storage access here. */
import { isNoLeaderOwner, REPLY_CHOICE } from "./decisions";
import { t } from "./i18n";

export interface UnownedDecision {
  id: string;
  project: string;
  kind: string;
  source: string;
  owner?: string;
  leaderMissing?: boolean;
}

export interface UnownedGroup<T extends UnownedDecision = UnownedDecision> {
  project: string;
  items: T[];
}

export function noLeaderHint(): string {
  return t("decisions.unowned.hint");
}

export function noLeaderTitle(project: string): string {
  return t("decisions.unowned.title", { project });
}

export function isUnownedDecision(item: UnownedDecision): boolean {
  return item.kind === "decide" && item.source !== "Kanban"
    && (item.leaderMissing === true || isNoLeaderOwner(item.owner));
}

/** A written note only goes to the <leader>; items without a <leader> can only record a letter. */
export function canWriteToLeader(item: UnownedDecision): boolean {
  return !isUnownedDecision(item);
}

export function partitionUnownedDecisions<T extends UnownedDecision>(items: readonly T[]): {
  owned: T[]; unowned: UnownedGroup<T>[];
} {
  const owned: T[] = [];
  const groups = new Map<string, UnownedGroup<T>>();
  for (const item of items) {
    if (!isUnownedDecision(item)) { owned.push(item); continue; }
    const key = item.project.toLowerCase();
    const group = groups.get(key) ?? { project: item.project, items: [] };
    group.items.push(item);
    groups.set(key, group);
  }
  return { owned, unowned: [...groups.values()] };
}

export type DecisionReply = (input: { id: string; choice: string; text: string }) => Promise<{ ok: boolean; message: string }>;

/** Explicit confirmation is required. Each item goes through the existing decide-reply RPC. */
export async function shelveUnownedGroup(group: UnownedGroup, confirmed: boolean, reply: DecisionReply): Promise<{ ok: boolean; message: string }> {
  if (!confirmed) return { ok: false, message: t("decisions.unowned.confirmFirst") };
  let closed = 0;
  const failures: string[] = [];
  for (const item of group.items) {
    if (!isUnownedDecision(item) || item.project.toLowerCase() !== group.project.toLowerCase()) {
      failures.push(t("decisions.unowned.itemFailure", { id: item.id, message: t("decisions.unowned.notInGroup") }));
      continue;
    }
    try {
      const result = await reply({ id: item.id, choice: REPLY_CHOICE.shelve, text: "" });
      if (result.ok) closed++;
      else failures.push(t("decisions.unowned.itemFailure", { id: item.id, message: result.message }));
    } catch (error) {
      failures.push(t("decisions.unowned.itemFailure", { id: item.id, message: String(error).slice(0, 160) }));
    }
  }
  const total = group.items.length;
  const message = failures.length
    ? t("decisions.unowned.shelvedWithFailures", { closed, total, failures: failures.join(t("decisions.unowned.failureSeparator")) })
    : t("decisions.unowned.shelved", { closed, total });
  return { ok: failures.length === 0, message };
}
