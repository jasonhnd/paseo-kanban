/// <reference types="node" />
import { parentArchivedUnmerged, parentPrClosed } from "../shared/board-view";
import { cardMark } from "./card-ref";
import { projectWorkspace } from "./config";
import { getDb } from "./db";
import { dependencyMet } from "./deps";
import { cachedMergeState, contractPullRequest, mergeError, parsePrUrl, prMergeState, readContract } from "./pr";
import { t } from "../shared/i18n";

export interface ParentRef {
  id: number;
  status: string;
  contract_json: string | null;
  project?: string;
}

export interface MergeChildRef {
  role: string;
  title: string;
  brief: string;
  project: string;
  contract_json: string | null;
}

/** Pure recognition: a batch card names this exact PR, with repository context. */
export function mergeCardDependency(child: MergeChildRef | undefined, parent: ParentRef): string | null {
  if (child?.role !== "batch") return null;
  const pr = contractPullRequest(readContract(parent.contract_json));
  const target = pr && parsePrUrl(pr);
  if (!pr || !target) return null;
  const repo = `${target.owner}/${target.repo}`.toLowerCase();
  const own = readContract(child.contract_json);
  const bound = own.pr && parsePrUrl(own.pr);
  if (bound && `${bound.owner}/${bound.repo}`.toLowerCase() === repo && bound.number === target.number) return pr;
  const text = `${child.title}\n${child.brief}`;
  const links = text.match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+\/?/gi) ?? [];
  if (links.some(link => link.replace(/\/$/, "").toLowerCase() === pr.replace(/\/$/, "").toLowerCase())) return pr;
  // Remove links before checking bare numbers: another repo URL must never match #N.
  // A link also ends at a full-width closing parenthesis (\uff09), common in Chinese briefs.
  const bare = text.replace(/https?:\/\/[^\s<>\uff09)]+/gi, " ");
  if (!Array.from(bare.matchAll(/#(\d+)\b/g)).some(match => match[1] === target.number)) return null;
  const repos = [
    ...(own.repo ? [own.repo.toLowerCase()] : []),
    ...(bound ? [`${bound.owner}/${bound.repo}`.toLowerCase()] : []),
    ...Array.from(text.matchAll(/https:\/\/github\.com\/([\w.-]+\/[\w.-]+)(?=$|[^\w.-])/gi), match => match[1]!.toLowerCase()),
    // Repository references must be declared or attached to a PR reference.
    // Paths such as e2e/menu-pointer.spec.js and refs such as origin/dev are not repos.
    // Briefs may be Chinese: \u4ed3\u5e93 = "repository", \u7684 = "of", \u6765\u81ea = "from", \u5c5e\u4e8e = "belongs to",
    // \uff1a and \uff08 are the full-width colon and opening parenthesis.
    ...Array.from(bare.matchAll(/(?:--repo|\brepo(?:sitory)?\b|\u4ed3\u5e93)\s*[:\uff1a=]?\s*([\w.-]+\/[\w.-]+)/gi), match => match[1]!.toLowerCase()),
    ...Array.from(bare.matchAll(/(?:^|[^\w./-])([\w.-]+\/[\w.-]+)\s*(?:(?:\u4ed3\u5e93|\u7684)\s*)?(?:PR\s*)?#\d+\b/gi), match => match[1]!.toLowerCase()),
    ...Array.from(bare.matchAll(/(?:PR\s*)?#\d+\s*(?:(?:\u6765\u81ea|\u5c5e\u4e8e|from|in|for)\s*|[\uff08(]\s*)([\w.-]+\/[\w.-]+)/gi), match => match[1]!.toLowerCase()),
  ];
  if (repos.some(named => named !== repo)) return null;
  return repos.includes(repo) || child.project === parent.project ? pr : null;
}

/** Advisory only: a likely merge job names none of its parents' PRs. */
export function mergeCardWarnings(child: MergeChildRef, parents: ParentRef[]): string[] {
  const text = `${child.title}\n${child.brief}`;
  // \u5408\u5e76 is "merge" in a Chinese title or brief.
  if (child.role !== "batch" || !/\u5408\u5e76|\bmerge\b/i.test(text) || !/#\d+|https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/i.test(text)) return [];
  const pulls = parents.filter(parent => contractPullRequest(readContract(parent.contract_json)));
  if (pulls.some(parent => mergeCardDependency(child, parent))) return [];
  return [t("parents.mergeWarning")];
}

export function mergeCardNotes(child: MergeChildRef, parents: ParentRef[]): string[] {
  return [...new Set(parents.flatMap(parent => {
    const pr = mergeCardDependency(child, parent);
    return pr ? [t("parents.mergeNote", { number: parsePrUrl(pr)!.number })] : [];
  }))];
}

export function taskParents(taskId: number): ParentRef[] {
  return getDb()
    .prepare(
      `SELECT t.id, t.status, t.contract_json, t.project FROM links l JOIN tasks t ON t.id = l.parent_id WHERE l.task_id = ? ORDER BY t.id`,
    )
    .all(taskId) as unknown as ParentRef[];
}

/** The child project controls the extra PR gate, including cross-project dependencies. */
function waitsForParentPr(child?: MergeChildRef): boolean {
  return !child || projectWorkspace(child.project).waitParentPr !== false;
}

/** Hold reason while a parent card has not finished yet. */
export function waitingParentsReason(): string {
  return t("parents.block.waitingParents");
}

/**
 * Null when this parent no longer blocks the child.
 * A card with a GitHub PR blocks until merged unless the child project opts out or the child merges it.
 * gh errors are not a merge: the reason is shown and the next round asks again.
 */
export function parentBlockReason(parent: ParentRef, now = Date.now(), child?: MergeChildRef): string | null {
  if (!dependencyMet(parent.status)) return waitingParentsReason();
  if (!waitsForParentPr(child) || mergeCardDependency(child, parent)) return null;
  const contract = readContract(parent.contract_json);
  const pr = contractPullRequest(contract);
  if (!pr && contract.kind !== "github") return null;
  if (pr && cachedMergeState(pr)?.merged) return null;
  const problem = parentMergeProblem(parent);
  const err = pr ? mergeError(pr, now) : null;
  const text = t("parents.block.waitingPr", { card: cardMark(parent.id) });
  const detail = [problem, err].filter(Boolean).join(t("common.semicolon"));
  return detail ? t("parents.block.withDetail", { text, detail }) : text;
}

export function parentsBlockReason(parents: ParentRef[], now = Date.now(), child?: MergeChildRef): string | null {
  const reasons = [...new Set(parents.map((parent) => parentBlockReason(parent, now, child)).filter((item): item is string => item !== null))];
  return reasons.length > 0 ? reasons.join(t("common.semicolon")) : null;
}

/** A terminal dependency problem needs the project leader; a merged PR always clears it. */
export function parentMergeProblem(parent: ParentRef, child?: MergeChildRef): string | null {
  if (!dependencyMet(parent.status) || !waitsForParentPr(child) || mergeCardDependency(child, parent)) return null;
  const pr = contractPullRequest(readContract(parent.contract_json));
  if (!pr) return null;
  const state = cachedMergeState(pr);
  if (state?.merged) return null;
  const problems = [
    ...(state?.closed ? [parentPrClosed()] : []),
    ...(parent.status === "archived" ? [parentArchivedUnmerged()] : []),
  ];
  return problems.length ? problems.join(t("common.semicolon")) : null;
}

/** Pull requests of parents that are already finished and not yet known to be merged. */
export function parentPulls(parents: ParentRef[], child?: MergeChildRef): string[] {
  const pulls: string[] = [];
  for (const parent of parents) {
    if (!dependencyMet(parent.status) || !waitsForParentPr(child) || mergeCardDependency(child, parent)) continue;
    const contract = readContract(parent.contract_json);
    const pr = contractPullRequest(contract);
    if (pr && !cachedMergeState(pr)?.merged) pulls.push(pr);
  }
  return pulls;
}

/**
 * Used when someone asks to start a waiting card: ask gh once more about each finished
 * parent's PR, ignoring the 10 minute cache. A PR in error backoff is not asked; the cached
 * answer is used and the error is reported. Returns null when nothing blocks the card any more,
 * otherwise a reason that names the PR and what gh just said.
 */
export async function refreshStartBlockReason(parents: ParentRef[], child: MergeChildRef, now = Date.now()): Promise<string | null> {
  const reasons: string[] = [];
  for (const parent of parents) {
    const pr = !dependencyMet(parent.status) || !waitsForParentPr(child) || mergeCardDependency(child, parent) ? null : contractPullRequest(readContract(parent.contract_json));
    if (pr && !cachedMergeState(pr)?.merged) {
      const state = await prMergeState(pr, { cacheMs: 0 });
      if (!state.merged) {
        const number = parsePrUrl(pr)?.number;
        const seen = state.error ? t("parents.refresh.failed", { error: state.error }) : t("parents.refresh.checked", { state: state.closed ? "CLOSED" : "OPEN" });
        const problem = parentMergeProblem(parent, child);
        reasons.push(
          t("parents.block.refreshed", {
            card: cardMark(parent.id),
            number: number ? ` #${number}` : "",
            problem: problem ? `${t("common.colon")}${problem}` : "",
            seen,
          }),
        );
        continue;
      }
    }
    const reason = parentBlockReason(parent, now, child);
    if (reason) reasons.push(reason);
  }
  return reasons.length > 0 ? [...new Set(reasons)].join(t("common.semicolon")) : null;
}
