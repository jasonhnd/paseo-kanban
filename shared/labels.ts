import { t, translate, LANGUAGES, type MessageKey, type MessageVars } from "./i18n";
import { UI_ACTOR } from "./actors";

export const ROLES = ["executor", "reviewer", "reader", "decision", "batch", "supervisor"] as const;
export type Role = (typeof ROLES)[number];

/** Shown to people. The angle brackets are characters, not a tag. The role key stays `supervisor`. */
export const LEADER_LABEL = "<leader>";

/** Catalog keys of the role names. The leader is LEADER_LABEL in every language. */
const ROLE_LABEL_KEYS: Readonly<Record<string, MessageKey>> = {
  executor: "labels.role.executor",
  reviewer: "labels.role.reviewer",
  reader: "labels.role.reader",
  decision: "labels.role.decision",
  batch: "labels.role.batch",
};

export const STATUSES = [
  "draft",
  "triage",
  "waiting",
  "ready",
  "running",
  "in_review",
  "reviewing",
  "rework",
  "acceptance",
  "blocked",
  "done",
  "archived",
] as const;
export type Status = (typeof STATUSES)[number];

/** Catalog keys of the internal status names. Used on badges and in event text. Not board column titles. */
const STATUS_LABEL_KEYS: Readonly<Record<string, MessageKey>> = {
  triage: "labels.status.triage",
  draft: "labels.status.draft",
  waiting: "labels.status.waiting",
  ready: "labels.status.ready",
  running: "labels.status.running",
  in_review: "labels.status.inReview",
  reviewing: "labels.status.reviewing",
  rework: "labels.status.rework",
  acceptance: "labels.status.acceptance",
  blocked: "labels.status.blocked",
  done: "labels.status.done",
  archived: "labels.status.archived",
};

/** Statuses that have not started work. A blocked card whose blocked_from is one of these stays in To Do. */
export const TODO_STATUSES: readonly Status[] = ["triage", "draft", "waiting", "ready"];

/** Statuses after work has started. A blocked card whose blocked_from is one of these stays in Doing. */
export const DOING_STATUSES: readonly Status[] = ["running", "in_review", "reviewing", "rework", "acceptance"];

export type BoardColumnId = "todo" | "doing" | "done" | "archive";

/**
 * Display groups. Internal status values stay as they are; the board only groups them.
 * Archive is folded under the three columns, not laid out beside them.
 */
export const COLUMNS: Array<{ id: BoardColumnId; label: string; statuses: readonly Status[] }> = [
  { id: "todo", label: "To Do", statuses: TODO_STATUSES },
  { id: "doing", label: "Doing", statuses: DOING_STATUSES },
  { id: "done", label: "Done", statuses: ["done"] },
  { id: "archive", label: "Archive", statuses: ["archived"] },
];

/** The three columns on the board. Archive is the folded list below them. */
export const BOARD_COLUMNS = COLUMNS.filter((column) => column.id !== "archive");

/** Archived cards per history page. */
export const HISTORY_PAGE = 20;

export function roleLabel(role: string): string {
  if (role === "supervisor") return LEADER_LABEL;
  const key = ROLE_LABEL_KEYS[role];
  return key ? t(key) : role;
}

export function statusLabel(status: string): string {
  const key = STATUS_LABEL_KEYS[status];
  return key ? t(key) : status;
}

/**
 * A message in every shipped language, without duplicates. Code that matches text the board or server
 * wrote (badges, captions, hold reasons, briefs) accepts all of them: rows written in Chinese before i18n,
 * or by a process running another language, still match.
 */
export function messageInAnyLanguage(key: MessageKey, vars?: MessageVars): string[] {
  return [...new Set(LANGUAGES.map((language) => translate(language, key, vars)))];
}

/** True when `text` starts with the message `key` (filled with `vars`) in any shipped language. */
export function startsWithMessage(text: string, key: MessageKey, vars?: MessageVars): boolean {
  return messageInAnyLanguage(key, vars).some((prefix) => text.startsWith(prefix));
}

const REASON_SUMMARY_MAX = 80;

/** First line of a review reason, shortened so the board and a wake can show it. */
export function reasonSummary(reason: string): string {
  const line = reason.trim().split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (line.length <= REASON_SUMMARY_MAX) return line;
  return `${line.slice(0, REASON_SUMMARY_MAX)}…`;
}

/** Board line for a request_changes event: "Review sent back: <reason summary>". */
export function reviewRejectCaption(reason: string): string {
  const summary = reasonSummary(reason);
  return summary ? t("labels.caption.reviewReject", { summary }) : t("labels.caption.reviewRejectBare");
}

/** One line for the card detail: directory or worktree, plus branch and base when it has them. */
export function workspaceLine(input: {
  kind: string | null;
  path: string | null;
  base: string | null;
  branch: string | null;
  lane?: string | null;
}): string | null {
  if (input.kind === "lane") {
    const bits = [t("labels.workspace.lane")];
    if (input.lane) bits.push(input.lane);
    if (input.branch) bits.push(t("labels.workspace.branch", { branch: input.branch }));
    if (input.base) bits.push(t("labels.workspace.base", { base: input.base }));
    const head = t("labels.workspace.head", { bits: bits.join(" · ") });
    return input.path ? `${head} · ${input.path}` : head;
  }
  if (input.kind === "worktree") {
    const bits = ["worktree"];
    if (input.branch) bits.push(t("labels.workspace.branch", { branch: input.branch }));
    if (input.base) bits.push(t("labels.workspace.base", { base: input.base }));
    const head = t("labels.workspace.head", { bits: bits.join(" · ") });
    return input.path ? `${head} · ${input.path}` : head;
  }
  if (input.kind === "dir" || input.path) return input.path ? t("labels.workspace.dirPath", { path: input.path }) : t("labels.workspace.dir");
  if (input.kind === "none") return t("labels.workspace.none");
  return null;
}

/** Shown on the card detail when the card forces a reasoning depth. */
export function cardEffortLabel(effort: string): string {
  return t("labels.card.effort", { effort });
}

/** Shown on the card and in the detail. `tier` is the difficulty that will be used. */
export function cardTierLabel(tier: string): string {
  return t("labels.card.tier", { tier });
}

const DOING = new Set<string>(DOING_STATUSES);

/** Which display column a card belongs in. Blocked cards follow blocked_from; anything not yet started stays in To Do. */
export function boardColumnFor(status: string, blockedFrom: string | null): BoardColumnId {
  if (status === "archived") return "archive";
  if (status === "done") return "done";
  if (status === "blocked") return blockedFrom && DOING.has(blockedFrom) ? "doing" : "todo";
  if (DOING.has(status)) return "doing";
  return "todo";
}

/** True when this card has not been started, including a block that happened before start. */
export function notStarted(status: string, blockedFrom: string | null): boolean {
  return boardColumnFor(status, blockedFrom) === "todo";
}

/** Badge tone. A done card awaiting landing stays warning, or danger when landing conflicted. */
export function cardFaceTone(input: {
  status: string;
  badge: string;
  blockedKind?: string | null;
  scheduledUntil?: string | null;
  returnNote: string | null;
  unattended: boolean;
  awaitingMerge: boolean;
  acceptanceMissing: boolean;
}): "danger" | "warning" | "success" {
  if (input.status === "blocked" && input.blockedKind === "scheduled" && input.scheduledUntil && Date.parse(input.scheduledUntil) > Date.now()) return "warning";
  if (input.status === "blocked" || isConflictBadge(input.badge)) return "danger";
  if (isLandPendingBadge(input.badge)) return "warning";
  if (
    input.returnNote ||
    input.unattended ||
    input.awaitingMerge ||
    input.acceptanceMissing ||
    input.status === "rework" ||
    input.status === "acceptance"
  ) {
    return "warning";
  }
  return "success";
}

export interface IdentityBit {
  key: "role" | "current" | "executor" | "started";
  label: string;
  value: string;
  /** Current and former executor stay tappable when an agent id is known. */
  press: boolean;
}

/** Card footer fields. Short labels stay; the board lays them in one wrapping row. */
export function identityBits(input: {
  roleLabel: string;
  currentText: string | null;
  currentPress: boolean;
  executorText: string | null;
  executorPress: boolean;
  startedLabel: string | null;
}): IdentityBit[] {
  const bits: IdentityBit[] = [
    { key: "role", label: t("labels.identity.role"), value: input.roleLabel, press: false },
    { key: "current", label: t("labels.identity.current"), value: input.currentText?.trim() || t("labels.identity.unassigned"), press: input.currentPress },
  ];
  const executor = input.executorText?.trim();
  if (executor) bits.push({ key: "executor", label: t("labels.identity.executor"), value: executor, press: input.executorPress });
  if (input.startedLabel) bits.push({ key: "started", label: t("labels.identity.started"), value: input.startedLabel, press: false });
  return bits;
}

/** Badge while a finished card is still waiting to land. Conflict is called out so it is not read as already merged. */
export function landPendingBadge(conflict: boolean): string {
  return conflict ? t("labels.badge.landConflict") : t("labels.badge.landPending");
}

/** True for the waiting-to-land badge (with or without the conflict mark), in any language. */
export function isLandPendingBadge(badge: string): boolean {
  return startsWithMessage(badge, "labels.badge.landPending");
}

/** True when a badge carries the conflict mark, in any language. */
export function isConflictBadge(badge: string): boolean {
  return messageInAnyLanguage("labels.badge.conflictWord").some((word) => badge.includes(word));
}

/** True for the badge of a card waiting on named parents ("Waiting for parents DEMO_0001"), in any language. */
export function isWaitingParentsBadge(badge: string): boolean {
  return startsWithMessage(badge, "labels.badge.waitingParents", { marks: "" });
}

/** Small label on the card. Internal status names stay in statusLabel for events. */
export function cardBadge(input: {
  status: string;
  reviewRound: number;
  parentIds?: readonly number[];
  /** Display numbers of unfinished parents, e.g. DEMO_0001. Used instead of parentIds when set. */
  parentMarks?: readonly string[];
  supervisorReject?: boolean;
  /** Done or archived, but the branch has not landed yet. */
  landPending?: boolean;
  landConflict?: boolean;
}): string {
  switch (input.status) {
    case "waiting": {
      const marks = input.parentMarks ?? (input.parentIds ?? []).map((id) => `#${id}`);
      return marks.length > 0 ? t("labels.badge.waitingParents", { marks: marks.join(t("common.listSep")) }) : t("labels.badge.waitingParentsBare");
    }
    case "rework":
      return input.supervisorReject
        ? t("labels.badge.reworkLeader", { round: input.reviewRound, leader: LEADER_LABEL })
        : t("labels.badge.rework", { round: input.reviewRound });
    case "done":
    case "archived":
      return input.landPending ? landPendingBadge(input.landConflict === true) : statusLabel(input.status);
    default:
      return statusLabel(input.status);
  }
}

/** Board line for an accept-time land conflict: "Land conflict: <reason summary>". */
export function landConflictCaption(reason: string): string {
  const summary = reasonSummary(reason);
  return summary ? t("labels.caption.landConflict", { summary }) : t("labels.caption.landConflictBare");
}

/** Board line for a supervisor reject event: "<leader> sent back: <reason summary>". */
export function supervisorRejectCaption(reason: string): string {
  const summary = reasonSummary(reason);
  return summary ? t("labels.caption.leaderReject", { summary, leader: LEADER_LABEL }) : t("labels.caption.leaderRejectBare", { leader: LEADER_LABEL });
}

/** A stored summary that already starts with the caption (in any language) is shown as it is. */
function headlineFrom(data: string, caption: (reason: string) => string, prefixKey: MessageKey): string {
  const vars = { leader: LEADER_LABEL };
  try {
    const parsed = JSON.parse(data) as { summary?: unknown; reason?: unknown };
    if (typeof parsed.summary === "string" && startsWithMessage(parsed.summary, prefixKey, vars)) return parsed.summary;
    if (typeof parsed.reason === "string") return caption(parsed.reason);
  } catch {
    return t(prefixKey, vars);
  }
  return t(prefixKey, vars);
}

/** Headline for one event. request_changes and rejected show the caption; other kinds return null. */
export function eventHeadline(kind: string, data: string): string | null {
  if (kind === "request_changes") return headlineFrom(data, reviewRejectCaption, "labels.caption.reviewRejectBare");
  if (kind === "rejected") return headlineFrom(data, supervisorRejectCaption, "labels.caption.leaderRejectBare");
  if (kind === "land_conflict") return headlineFrom(data, landConflictCaption, "labels.caption.landConflictBare");
  return null;
}

/** A markdown heading line, optionally ending with an ASCII or full-width (\uff1a) colon. */
const HEADING = /^(#{1,6}\s*)?(.+?)\s*[:\uff1a]?\s*$/;

/** Lines under a markdown heading, until the next heading. Null when the heading is absent. */
function sectionBody(brief: string, title: string): string[] | null {
  const lines = brief.split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const text = lines[i].trim();
    // A heading line whose captured text is `title` must contain it. Most lines do not, and the regex is the cost.
    if (!text.includes(title)) continue;
    const match = HEADING.exec(text);
    if (match && match[2] === title) {
      start = i + 1;
      break;
    }
  }
  if (start < 0) return null;
  const body: string[] = [];
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) {
      if (body.length > 0) break;
      continue;
    }
    if (line.startsWith("#") && HEADING.exec(line)?.[1]) break;
    body.push(line);
  }
  return body;
}

/** The first heading among `titles` that the brief has, in order. */
function firstSection(brief: string, titles: readonly string[]): string[] | null {
  for (const title of titles) {
    const body = sectionBody(brief, title);
    if (body) return body;
  }
  return null;
}

/** Headings of the goal section in a brief: the Chinese heading (older and Chinese briefs) or "Goal". */
const GOAL_HEADINGS = ["\u76ee\u6807", "Goal"] as const;
/** Headings of the acceptance section in a brief: the Chinese heading or "Acceptance criteria". */
const ACCEPTANCE_HEADINGS = ["\u9a8c\u6536\u6807\u51c6", "Acceptance criteria"] as const;

function plainLines(text: string): string[] {
  // The command line writes "Source: <path>" (cli.briefSource) as the first line of a brief read from a file.
  const sourcePrefixes = messageInAnyLanguage("cli.briefSource", { path: "" });
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !sourcePrefixes.some((prefix) => line.startsWith(prefix)));
}

/** What the assignee should do: the goal section, or the first lines of the brief. */
export function briefHow(brief: string): string {
  const text = brief.trim();
  if (!text) return t("labels.brief.none");
  const goal = firstSection(text, GOAL_HEADINGS);
  const lines = goal && goal.length > 0 ? goal : plainLines(text);
  const picked = lines.slice(0, 2);
  return picked.length > 0 ? picked.join("\n") : t("labels.brief.none");
}

/** What done looks like: the first acceptance item, or the first two lines of the acceptance section. */
export function briefAcceptance(brief: string): { text: string; missing: boolean } {
  const section = firstSection(brief, ACCEPTANCE_HEADINGS);
  if (!section || section.length === 0) return { text: t("labels.brief.noAcceptance"), missing: true };
  const item = section.find((line) => /^([-*]|\d+[.)])\s+/.test(line));
  if (item) return { text: item.replace(/^([-*]|\d+[.)])\s+/, ""), missing: false };
  return { text: section.slice(0, 2).join("\n"), missing: false };
}

/** Who created the card. Intake with no agent is the user. A missing title falls back to the id prefix. */
export function assignerLabel(input: { createdBy: string | null; createdByAgent: string | null; agentTitle: string | null }): string {
  if (!input.createdByAgent && input.createdBy === UI_ACTOR) return t("labels.assigner.user");
  if (input.createdByAgent) {
    const title = input.agentTitle?.trim();
    if (title) return title;
    return input.createdByAgent.slice(0, 8);
  }
  return t("labels.assigner.unknown");
}

const ASSIGNER_TITLE_MAX = 16;

/**
 * Short "who sent this" for the card face: the project leader as `KBN <leader>`, the Kanban leader,
 * the user, or the agent's title. Never an agent id.
 */
export function assignerShortLabel(input: {
  createdBy: string | null;
  createdByAgent: string | null;
  agentTitle: string | null;
  projectLeaderId: string | null;
  kanbanLeaderId: string | null;
  projectCode: string | null;
  project: string;
}): string {
  const agent = input.createdByAgent?.trim() || null;
  if (!agent) return input.createdBy === UI_ACTOR ? t("labels.assigner.user") : t("labels.assigner.unknown");
  if (agent === input.projectLeaderId) return `${input.projectCode || input.project} ${LEADER_LABEL}`;
  if (agent === input.kanbanLeaderId) return `Kanban ${LEADER_LABEL}`;
  const title = input.agentTitle?.trim();
  if (!title) return t("labels.assigner.otherAgent");
  return title.length <= ASSIGNER_TITLE_MAX ? title : `${title.slice(0, ASSIGNER_TITLE_MAX)}…`;
}

function titleCase(word: string): string {
  return word ? `${word[0]!.toUpperCase()}${word.slice(1)}` : word;
}

/**
 * Model id to a short display name by shape, not by a table: `claude-sonnet-5-5` is `Claude Sonnet 5.5`,
 * `gpt-6.1-sol` is `GPT-6.1-Sol`, `grok-4.7` is `Grok 4.7`. Anything else is shown as it is.
 */
export function shortModelName(raw: string | null | undefined): string | null {
  const id = (raw ?? "").trim().replace(/\[[^\]]*\]$/, "").split(/[:/]/).pop()?.trim() ?? "";
  if (!id) return null;
  const lower = id.toLowerCase();
  const claude = /^claude-([a-z]+)((?:-\d+)*)$/.exec(lower);
  if (claude) {
    const version = (claude[2] ?? "").split("-").filter((part) => part && part.length < 6).join(".");
    return `Claude ${titleCase(claude[1]!)}${version ? ` ${version}` : ""}`;
  }
  if (/^gpt-/.test(lower)) return `GPT-${lower.slice(4).split("-").map(titleCase).join("-")}`;
  const named = /^([a-z]+)-(\d[\w.]*)$/.exec(lower);
  if (named) return `${titleCase(named[1]!)} ${named[2]}`;
  return id;
}

/** Model line for the card face: the run's model, else the profile's, else the profile name; "not assigned" before any run. */
export function cardModelLabel(input: { hasRun: boolean; model: string | null; profileModel: string | null; profile: string | null }): string {
  if (!input.hasRun) return t("labels.model.unassigned");
  return shortModelName(input.model) ?? shortModelName(input.profileModel) ?? (input.profile?.trim() || t("labels.model.unrecorded"));
}

/** Project, parent cards, the card under review, and tags. Project alone when nothing else is set. */
function faceMark(item: { id: number; code?: string }): string {
  return item.code ?? `#${item.id}`;
}

export function relatedLine(input: {
  project: string;
  parents: ReadonlyArray<{ id: number; title: string; code?: string }>;
  reviewOf: { id: number; title: string; code?: string } | null;
  tags: readonly string[];
}): string {
  const bits = [input.project];
  for (const parent of input.parents) bits.push(t("labels.related.parent", { mark: faceMark(parent), title: parent.title }));
  if (input.reviewOf) bits.push(t("labels.related.reviewOf", { mark: faceMark(input.reviewOf), title: input.reviewOf.title }));
  if (input.tags.length > 0) bits.push(input.tags.join(t("common.listSep")));
  return bits.join(" · ");
}

/** Who will do the work. Before start, say it is not assigned yet. */
export function assigneeLine(input: {
  started: boolean;
  profileOverride: string | null;
  roleLabel: string;
  profile: string | null;
  model: string | null;
}): string {
  if (!input.started) return input.profileOverride ? t("labels.assignee.override", { profile: input.profileOverride }) : t("labels.assignee.auto");
  const parts = [input.roleLabel];
  if (input.profile && input.profile !== input.roleLabel) parts.push(input.profile);
  if (input.model) parts.push(input.model);
  return parts.join(" · ");
}

/** First line of a stored handoff, for a done card. */
export function handoffLine(json: string | null): string | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as { summary?: unknown };
    if (typeof parsed.summary !== "string") return null;
    const line = parsed.summary.trim().split(/\r?\n/, 1)[0]?.trim() ?? "";
    if (!line) return null;
    return line.length <= REASON_SUMMARY_MAX ? line : `${line.slice(0, REASON_SUMMARY_MAX)}…`;
  } catch {
    return null;
  }
}

/** One or two lines of the latest reject reason. */
export function returnNoteText(reason: string): string {
  const lines = reason
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 2);
  return lines.join("\n");
}
