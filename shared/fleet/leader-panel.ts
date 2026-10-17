import { z } from "zod";
import { ageMs } from "./decisions";
import { parseDecisionCard } from "./decision-card";
import { t, tAll } from "./i18n";
import { weekStatsSchema } from "./leader-week";
import { withoutPaused } from "./paused";
import { isUnownedDecision, type UnownedDecision } from "./unowned-decisions";

export const ACCEPTANCE_YELLOW_MS = 30 * 60_000;
export const ACCEPTANCE_RED_MS = 2 * 3600_000;
export const SELF_WORK_MS = 15 * 60_000;
export const LEADER_REPLY_LIMIT = 2000;

export const leaderCardSchema = z.object({
  id: z.number(), code: z.string(), project: z.string(), title: z.string(),
  status: z.string(), since: z.string().nullable(), reason: z.string(),
  blockedKind: z.string().nullable(), waitingParents: z.boolean(),
  /** Kanban tag "leader-unresponsive"; absent on snapshots from before the tag existed. */
  unresponsive: z.boolean().optional(), repeatWakes: z.number().optional(),
});
export type LeaderCard = z.infer<typeof leaderCardSchema>;
export const leaderActionSchema = z.object({
  at: z.string(), name: z.string(), detailType: z.string(), command: z.string(), summary: z.string(),
});
export type LeaderAction = z.infer<typeof leaderActionSchema>;
export const leaderDetailSchema = z.object({
  project: z.string(), agentId: z.string(), lastReplyAt: z.string().nullable(),
  /** Latest assistant reply to the user. Absent on older snapshots. Null when none was seen. */
  lastUserReplyAt: z.string().nullable().optional(),
  question: z.object({ text: z.string(), at: z.string() }).nullable(),
  busySince: z.string().nullable(), selfWorking: z.boolean(), selfWorkReason: z.string().nullable(),
  actions: z.array(leaderActionSchema), cards: z.array(leaderCardSchema),
  activityWarning: z.string().nullable(), cardsWarning: z.string().nullable(),
  /** wake_acceptance_repeat events in the last 24 hours for this project. */
  repeatWakes24h: z.number().optional(),
  /** 7-day self-work tally; null = cannot be counted, undefined = first scan still running. */
  weekStats: weekStatsSchema.nullable().optional(),
});
export type LeaderDetail = z.infer<typeof leaderDetailSchema>;
export interface LeaderReply {
  text: string; at: string;
  /** The input this reply answered. Absent = unknown, treated as the user. */
  prompt?: string;
}
export interface RegisteredDecision {
  id: string; project: string; status: string; title: string; detail: string; createdAt: string;
}

const EXCERPT_LINES = 4;
const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
/** Option letters may be followed by ASCII marks or by the full-width marks of the catalog's other languages. */
function optionLine(letter: string): RegExp {
  const marks = [...new Set([".:)", ...tAll("leader.question.optionMarks")].join(""))].map(escapeRegex).join("");
  return new RegExp(`^\\s*(?:[-*]\\s*)?\\**${letter}\\**\\s*[${marks}]\\s*\\S`);
}

/** The AFC panel's prefix for a message the user typed to a <leader>. */
export function userMessagePrefix(): string {
  return t("leader.reply.userPrefix");
}

/** Forwarded notices and card wake-ups come from other agents; the user-message prefix is the user typing in the AFC panel. */
export function isAgentInput(prompt: string | undefined): boolean {
  const text = prompt?.trim();
  if (!text) return false;
  if (tAll("leader.input.userMarker").some((marker) => text.startsWith(marker))) return false;
  return tAll("leader.input.noticeOpen").some((open) => text.startsWith(open)) || /^[A-Z]{2,6}_\d{4}\b/.test(text);
}

/** True when a line carries a recommendation, in any language. */
function isAdviceLine(line: string): boolean {
  const lower = line.toLowerCase();
  return tAll("leader.question.recommend").some((word) => lower.includes(word.toLowerCase()));
}

/** The paragraph holding lettered options A and B plus a recommendation (in it or in the next paragraph), from its lead-in line, at most 4 lines. */
export function questionExcerpt(text: string): string | null {
  return questionCandidates(text)[0]?.excerpt ?? null;
}

/** Keep the full question for matching, even when the panel excerpt is shortened. */
function questionCandidates(text: string): Array<{ text: string; excerpt: string }> {
  const questions: Array<{ text: string; excerpt: string }> = [];
  const optionA = optionLine("A"), optionB = optionLine("B");
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim()));
  for (const [i, lines] of paragraphs.entries()) {
    const a = lines.findIndex((l) => optionA.test(l));
    if (a < 0 || !lines.some((l) => optionB.test(l))) continue;
    const advice = [...lines, ...(paragraphs[i + 1] ?? [])].find(isAdviceLine);
    if (!advice) continue;
    const picked = lines.slice(Math.max(0, a - 1)).slice(0, EXCERPT_LINES);
    if (!picked.includes(advice)) {
      if (picked.length < EXCERPT_LINES) picked.push(advice);
      else picked[EXCERPT_LINES - 1] = advice;
    }
    const heading = a === 0 && i > 0 && !paragraphs[i - 1].some((l) => optionA.test(l) || optionB.test(l))
      ? paragraphs[i - 1].slice(-1) : [];
    questions.push({ text: [...heading, ...lines, ...(lines.includes(advice) ? [] : [advice])].join("\n"), excerpt: picked.join("\n") });
  }
  return questions;
}

const normalized = (text: string) => text.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu)?.join("") ?? "";
/** Word pairs for spaced languages, character pairs for Han text; punctuation/markdown are immaterial. */
function phraseUnits(text: string): string[] {
  return text.normalize("NFKC").toLowerCase().replace(/\p{Script=Han}/gu, " $& ").match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** Generic answers are not decision identity, even when padded to look long. */
const GENERIC_OPTION_PHRASES = new Set(
  [
    "yes",
    "no",
    "now",
    "later",
    "skip",
    "go ahead",
    "do it now",
    "leave it as is",
    "follow the plan",
    "proceed with the current plan",
    "wait until a later date",
    "deploy the staging build",
    "keep the current release",
    "\u73b0\u5728\u505a",
    "\u6682\u7f13",
    "\u5148\u4e0d\u505a",
    "\u7167\u505a",
    "\u4e0d\u505a",
    "\u540c\u610f",
    "\u4e0d\u540c\u610f",
    "\u662f",
    "\u5426",
    "\u597d",
    "\u4e0d",
    "\u73b0\u5728",
    "\u7a0d\u540e",
    "\u4ee5\u540e",
    "\u5148",
    "\u518d",
    "\u505a",
    "\u6267\u884c",
    "\u7b49\u5f85",
    "\u7ee7\u7eed",
    "\u8df3\u8fc7",
    "\u7acb\u5373",
    "\u7acb\u523b",
    "\u6309\u8ba1\u5212",
    "\u4fdd\u6301\u73b0\u72b6",
    "\u90e8\u7f72\u6d4b\u8bd5\u6784\u5efa",
    "\u4fdd\u6301\u5f53\u524d\u7248\u672c",
    "\u7136\u540e",
    "\u6216\u8005",
    "\u4ee5\u53ca",
    "\u7684",
    "\u4e86",
    "\u5728",
    "\u5c06",
    "\u628a",
    "\u5230",
    "\u548c",
    "\u5e76",
    "\u65b0",
    "\u65e7",
    "\u5f53\u524d",
    "\u73b0\u6709"
  ].map(normalized),
);
const GENERIC_OPTION_WORDS = new Set(
  "a an the and or but if then else as at by for from in into of on onto to with without after before until while that this these those it its we our you your they their is are was were be been being will would shall should can could may might must do does did done not no yes now later skip agree disagree continue wait proceed defer postpone go ahead follow keep current existing new old plan approved deploy staging build release please just already only also same again today tomorrow date don doesn didn isn aren wasn weren haven hasn hadn won wouldn shouldn couldn mustn needn daren shan re ve ll let all any some each every both other enough there here such he she his her him them me my mine ours yours theirs".split(" "),
);
const GENERIC_HAN_WORDS = [
  "\u73b0\u5728\u505a",
  "\u6682\u7f13",
  "\u5148\u4e0d\u505a",
  "\u7167\u505a",
  "\u4e0d\u505a",
  "\u540c\u610f",
  "\u4e0d\u540c\u610f",
  "\u662f",
  "\u5426",
  "\u597d",
  "\u4e0d",
  "\u73b0\u5728",
  "\u7a0d\u540e",
  "\u4ee5\u540e",
  "\u5148",
  "\u518d",
  "\u505a",
  "\u6267\u884c",
  "\u7b49\u5f85",
  "\u7ee7\u7eed",
  "\u8df3\u8fc7",
  "\u7acb\u5373",
  "\u7acb\u523b",
  "\u6309\u8ba1\u5212",
  "\u4fdd\u6301\u73b0\u72b6",
  "\u90e8\u7f72\u6d4b\u8bd5\u6784\u5efa",
  "\u4fdd\u6301\u5f53\u524d\u7248\u672c",
  "\u7136\u540e",
  "\u6216\u8005",
  "\u4ee5\u53ca",
  "\u7684",
  "\u4e86",
  "\u5728",
  "\u5c06",
  "\u628a",
  "\u5230",
  "\u548c",
  "\u5e76",
  "\u65b0",
  "\u65e7",
  "\u5f53\u524d",
  "\u73b0\u6709"
].sort((a, b) => b.length - a.length);

/** Count information after removing generic words; retain the original body for matching semantics. */
function distinctiveOption(text: string): boolean {
  if (GENERIC_OPTION_PHRASES.has(normalized(text))) return false;
  let content = text.normalize("NFKC").toLowerCase();
  for (const word of GENERIC_HAN_WORDS) content = content.replaceAll(word, " ");
  const units = phraseUnits(content);
  const han = units.filter((unit) => /\p{Script=Han}/u.test(unit)).length;
  const english = new Set(units.filter((unit) => /^[a-z]{2,}$/.test(unit) && !GENERIC_OPTION_WORDS.has(unit)));
  return han >= 6 || english.size >= 3;
}

const optionBody = (text: string) => phraseUnits(text).join(" ");

function matchesDecision(question: string, decision: RegisteredDecision): boolean {
  const asked = parseDecisionCard("", question, Infinity), stored = parseDecisionCard(decision.title, decision.detail, Infinity);
  // The leader's first route is independently sufficient, even with generic options.
  const title = phraseUnits(decision.title).join(" ");
  const context = ` ${phraseUnits(asked.context).join(" ")} `;
  if (title && context.includes(` ${title} `)) return true;

  // Otherwise require two distinct informative bodies and the same explicit recommendation.
  // Compare whole normalized bodies, preserving negation and subject words; ids and reasons
  // alone are not additional routes. Deduplication prevents one body from counting as A and B.
  if (!stored.recommended || stored.recommended !== asked.recommended) return false;
  const bodies = new Set(stored.options.filter((option) => distinctiveOption(option.text)).map((option) => optionBody(option.text)));
  const matches = new Set(asked.options.filter((option) => distinctiveOption(option.text))
    .map((option) => optionBody(option.text)).filter((body) => bodies.has(body)));
  return matches.size >= 2;
}

/** An open decision created this recently counts as already registered, even when the reply paraphrases it. */
export const RECENT_OPEN_DECISION_WINDOW_MS = 60 * 60_000;

function recentWindowMs(windowMs: number | undefined): number {
  return typeof windowMs === "number" && Number.isFinite(windowMs) && windowMs >= 0
    ? windowMs
    : RECENT_OPEN_DECISION_WINDOW_MS;
}

/** True when this project has an open decision created no earlier than `windowMs` before the reply. */
function hasRecentOpenDecision(
  project: string, replyAt: number, decisions: readonly RegisteredDecision[], windowMs: number,
): boolean {
  return decisions.some((decision) => {
    if (decision.status !== "open" || decision.project.toLowerCase() !== project.toLowerCase()) return false;
    const created = Date.parse(decision.createdAt);
    if (!Number.isFinite(created)) return false;
    const age = replyAt - created;
    return age >= 0 && age <= windowMs;
  });
}

/**
 * Match each question against this project's current open decisions.
 * An open decision created within the recent window suppresses the reminder, including a paraphrase.
 * Outside that window, the full normalized title or two distinctive option bodies with the same
 * recommendation letter still confirm a retelling. A question that matches neither, and has no open
 * decision inside the window, is reported.
 */
export function unregisteredQuestion(
  project: string, latest: LeaderReply | null, decisions: readonly RegisteredDecision[],
  windowMs?: number,
): LeaderReply | null {
  if (!latest?.text.trim() || !Number.isFinite(Date.parse(latest.at)) || isAgentInput(latest.prompt)) return null;
  const text = latest.text.replace(/```[\s\S]*?```/g, "").replace(/^\s*>.*$/gm, "");
  const replyAt = Date.parse(latest.at);
  if (hasRecentOpenDecision(project, replyAt, decisions, recentWindowMs(windowMs))) return null;
  const open = decisions.filter((d) => d.status === "open" && d.project.toLowerCase() === project.toLowerCase());
  const question = questionCandidates(text).find((q) => !open.some((d) => matchesDecision(q.text, d)));
  return question ? { text: question.excerpt, at: latest.at } : null;
}

export function isWorkAction(action: LeaderAction): boolean {
  if (/^(edit|write)$/i.test(action.detailType) || /^(?:Edit|Write|apply_patch|functions\.apply_patch)$/i.test(action.name)) return true;
  // Match commands, not tool output or a plan describing a command.
  const commands = action.command.split(/(?:&&|\|\||;|\n)/).map(c=>c.trim().replace(/^\(\s*/, ""));
  return commands.some(command => /^(?:git\s+commit\b|gh\s+pr\s+merge\b|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|typecheck|compat|build)\b|(?:pytest|vitest|jest)\b)/i.test(command)
    || /^(?:(?:node|python3?|bash|sh|tsx)\s+)?(?:[./\w-]*\/)?(?:[\w-]*merge[\w-]*queue[\w.-]*|[\w-]*queue[\w-]*merge[\w.-]*)\.(?:sh|py|[cm]?js|ts)\b/i.test(command)
    || mergeQueueScript().test(command));
}

/** A merge-queue script named in another language (the catalog's `leader.work.mergeQueueScript`). */
function mergeQueueScript(): RegExp {
  const names = tAll("leader.work.mergeQueueScript").map(escapeRegex).join("|");
  return new RegExp(`^(?:(?:node|python3?|bash|sh|tsx)\\s+)?(?:[./\\w-]*\\/)?(?:${names})\\.(?:sh|py|[cm]?js|ts)\\b`, "i");
}

export function selfWorkSignal(input: { busy: boolean; busySince: string | null; actionSince?: string | null; actions: readonly LeaderAction[]; now: number }) {
  if (!input.busy) return { selfWorking: false, reason: null, actions: [] as LeaderAction[] };
  const actionSince = input.actionSince === undefined ? input.busySince : input.actionSince;
  const current = input.actions.filter((a) => {
    const age = ageMs(a.at, input.now);
    return age !== null && age >= 0
      && (!actionSince || Date.parse(a.at) >= Date.parse(actionSince));
  }).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const recent = current.filter(a=>(ageMs(a.at,input.now) ?? Infinity) <= SELF_WORK_MS);
  const work = recent.some(isWorkAction);
  const age = ageMs(input.busySince, input.now);
  const long = age !== null && age > SELF_WORK_MS;
  return {
    selfWorking: work || long,
    reason: work ? t("leader.selfWork.recentWork") : long ? t("leader.selfWork.longBusy") : null,
    actions: current.slice(0, 3),
  };
}

export type LeaderCardGroup = "acceptance" | "blocked" | "rework" | "parents";
export function leaderCardGroups(): Array<{ key: LeaderCardGroup; label: string }> {
  return [
    { key: "acceptance", label: t("leader.group.acceptance") }, { key: "blocked", label: t("leader.group.blocked") },
    { key: "rework", label: t("leader.group.rework") }, { key: "parents", label: t("leader.group.parents") },
  ];
}
export function groupLeaderCards(cards: readonly LeaderCard[]): Record<LeaderCardGroup, LeaderCard[]> {
  const groups: Record<LeaderCardGroup, LeaderCard[]> = { acceptance: [], blocked: [], rework: [], parents: [] };
  for (const card of cards) {
    if (card.status === "acceptance") groups.acceptance.push(card);
    else if (card.waitingParents || (card.status === "blocked" && card.blockedKind === "dependency")) groups.parents.push(card);
    else if (card.status === "blocked") groups.blocked.push(card);
    else if (card.status === "rework") groups.rework.push(card);
  }
  const stuck = (c: LeaderCard) => c.status === "acceptance" && c.unresponsive ? 0 : 1;
  for (const group of Object.values(groups)) group.sort((a, b) => stuck(a) - stuck(b) || (Date.parse(a.since ?? "") || Infinity) - (Date.parse(b.since ?? "") || Infinity) || a.id - b.id);
  return groups;
}
export function acceptanceTone(card: Pick<LeaderCard, "status" | "since">, now: number): "red" | "yellow" | "normal" {
  const age = ageMs(card.since, now);
  if (card.status !== "acceptance" || age === null) return "normal";
  return age > ACCEPTANCE_RED_MS ? "red" : age > ACCEPTANCE_YELLOW_MS ? "yellow" : "normal";
}
export function elapsedLabel(at: string | null, now: number): string {
  const age = ageMs(at, now);
  if (age === null) return t("leader.elapsed.unreadable");
  const minutes = Math.max(0, Math.floor(age / 60_000));
  if (minutes < 1) return t("leader.elapsed.underMinute");
  if (minutes < 60) return t("leader.elapsed.minutes", { minutes });
  if (minutes < 1440) return t("leader.elapsed.hoursMinutes", { hours: Math.floor(minutes / 60), minutes: minutes % 60 });
  return t("leader.elapsed.daysHours", { days: Math.floor(minutes / 1440), hours: Math.floor(minutes % 1440 / 60) });
}
export interface PanelDecision { project: string; kind: string; source: string; blocking: boolean }
export function projectDecisions<T extends PanelDecision>(decisions: readonly T[], project: string): T[] {
  return decisions.filter((d) => d.kind === "decide" && d.source !== "Kanban" && d.project.toLowerCase() === project.toLowerCase())
    .sort((a, b) => Number(b.blocking) - Number(a.blocking));
}
export function unresponsiveCards(detail: Pick<LeaderDetail, "cards"> | undefined): LeaderCard[] {
  return detail?.cards.filter((c) => c.status === "acceptance" && c.unresponsive) ?? [];
}
/** What is waiting on this <leader> or on the user; the compact card's tags and the idle-last sort both read it. */
export interface LeaderCounts {
  waiting: number; blocking: boolean; question: boolean; acceptance: number; blocked: number; unresponsive: number; selfWorking: boolean;
}
export function leaderCounts(project: string, detail: LeaderDetail | undefined, decisions: readonly (PanelDecision & Partial<UnownedDecision>)[]): LeaderCounts {
  // A project that has a card here has a <leader>; an entry marked "no leader" belongs to the unregistered list instead.
  const registered = projectDecisions(decisions, project).filter((d) => !isUnownedDecision(d as PanelDecision & UnownedDecision));
  const groups = groupLeaderCards(detail?.cards ?? []);
  return {
    waiting: registered.length + (detail?.question ? 1 : 0),
    blocking: registered.some((d) => d.blocking),
    question: Boolean(detail?.question),
    acceptance: groups.acceptance.length,
    blocked: groups.blocked.length,
    unresponsive: unresponsiveCards(detail).length,
    selfWorking: Boolean(detail?.selfWorking),
  };
}
export function hasPendingWork(counts: LeaderCounts): boolean {
  return counts.waiting > 0 || counts.acceptance > 0 || counts.blocked > 0 || counts.unresponsive > 0 || counts.selfWorking;
}
/** 0 blocking decision … 4 blocked card, 5 anything else pending, 6 nothing pending (sorted last). */
export function leaderRank(project: string, detail: LeaderDetail | undefined, decisions: readonly PanelDecision[], now: number): number {
  if (projectDecisions(decisions, project).some((d) => d.blocking)) return 0;
  if (unresponsiveCards(detail).length > 0) return 1;
  if (detail?.cards.some((c) => acceptanceTone(c, now) === "red")) return 2;
  if (detail?.question) return 3;
  if (detail?.cards.some((c) => c.status === "blocked")) return 4;
  return hasPendingWork(leaderCounts(project, detail, decisions)) ? 5 : 6;
}
export function sortLeaderRows<T extends { project: string; code: string }>(rows: readonly T[], details: readonly LeaderDetail[], decisions: readonly PanelDecision[], now: number): T[] {
  const byProject = new Map(details.map((d) => [d.project, d]));
  return [...rows].sort((a, b) => leaderRank(a.project, byProject.get(a.project), decisions, now) - leaderRank(b.project, byProject.get(b.project), decisions, now) || a.code.localeCompare(b.code));
}
/** A proxied project (its session belongs to another project) with no unfinished card and no open decision: finished, counts for nothing. */
export function isEndedProxy(row: { project: string; proxyOf?: string }, details: readonly LeaderDetail[], decisions: readonly PanelDecision[]): boolean {
  return Boolean(row.proxyOf) && !details.some((d) => d.project === row.project && d.cards.length > 0) && projectDecisions(decisions, row.project).length === 0;
}
/** Paused projects and finished proxied projects count for nothing: no waiting leader, no card, no question, no self-work. */
export function leaderSummary(allRows: readonly { project: string; proxyOf?: string }[], allDetails: readonly LeaderDetail[], allDecisions: readonly PanelDecision[], paused: readonly { project: string }[] = []) {
  const ended = new Set(allRows.filter((r) => isEndedProxy(r, allDetails, allDecisions)).map((r) => r.project));
  const live = <T extends { project: string }>(items: readonly T[]) => items.filter((i) => !ended.has(i.project));
  const rows = live(withoutPaused(allRows, paused)), details = live(withoutPaused(allDetails, paused)), decisions = withoutPaused(allDecisions, paused);
  const projects = new Set(rows.map((r) => r.project.toLowerCase()));
  const registered = decisions.filter((d) => d.kind === "decide" && d.source !== "Kanban");
  const questions = details.filter((d) => d.question);
  const waiting = new Set([...registered.map((d) => d.project.toLowerCase()), ...questions.map((d) => d.project.toLowerCase())]);
  const cards = new Map(details.flatMap((d) => d.cards).map((c) => [c.id, c]));
  return {
    waitingLeaders: [...waiting].filter((p) => projects.has(p)).length,
    waitingItems: registered.length + questions.length,
    unresponsiveLeaders: details.filter((d) => projects.has(d.project.toLowerCase()) && unresponsiveCards(d).length > 0).length,
    acceptance: [...cards.values()].filter((c) => c.status === "acceptance").length,
    // Same grouping as the card list: waiting-on-parent cards are not "stuck".
    blocked: groupLeaderCards([...cards.values()]).blocked.length,
  };
}
export function validateLeaderReply(input: { project: string; text: string }): string | null {
  if (!input.project.trim() || input.project.length > 200) return t("leader.reply.badProject");
  if (!input.text.trim()) return t("leader.reply.empty");
  if (input.text.length > LEADER_REPLY_LIMIT) return t("leader.reply.tooLong", { limit: LEADER_REPLY_LIMIT });
  return null;
}
export function repeatWakeLabel(card: Pick<LeaderCard, "repeatWakes">): string {
  return t("leader.repeatWakes", { count: card.repeatWakes ?? 0 });
}
export function acceptanceReminder(cards: readonly LeaderCard[]): string {
  const codes = cards.filter((c) => c.status === "acceptance").map((c) => c.code);
  return t("leader.prompt.acceptanceReminder", { codes: codes.join(t("shift.list.separator")) });
}
export function statusRequest(): string {
  return t("leader.prompt.statusRequest");
}
export function delegationReminder(): string {
  return t("leader.prompt.delegationReminder");
}
