import { blockedKindLabel, isExternalWaitText, isQuotaWaitReason, scheduledWaitLabel } from "./blocked";
import { cardDecisions, type DecisionView } from "./decisions";
import { t, type MessageKey } from "./i18n";
import { isConflictBadge, isLandPendingBadge, LEADER_LABEL, messageInAnyLanguage, statusLabel } from "./labels";
import type { BoardTab } from "./panel-prefs";

/** What the board views read from a card. A card from the board RPC fits. */
export interface ViewTask {
  id: number;
  code: string;
  project: string;
  title: string;
  status: string;
  badge: string;
  column: string;
  reviewRound: number;
  blockedKind: string | null;
  scheduledUntil?: string | null;
  blockedReason: string | null;
  nextStep: string | null;
  returnNote: string | null;
  tempNote: string | null;
  stallNote: string | null;
  mcpNote: string | null;
  unattended: boolean;
  awaitingMerge: boolean;
  related: string;
  leaderUnresponsive?: boolean;
  leaderHold?: boolean;
}

const BOARD_TAB_LABEL_KEYS: Readonly<Record<BoardTab, MessageKey>> = {
  overview: "boardView.tab.overview",
  attention: "boardView.tab.attention",
  decisions: "boardView.tab.decisions",
  projects: "boardView.tab.projects",
  settings: "boardView.tab.settings",
};

export function boardTabLabel(tab: BoardTab): string {
  return t(BOARD_TAB_LABEL_KEYS[tab]);
}

/** "Holds up N": the server adds it to a card's related line, the card hint repeats it. */
export function dragNote(count: number): string {
  return t("boardView.drag", { count });
}

const COUNT_MARK = "__count__";

/** Matches the drag note in any language; spaces are optional, as in the older Chinese-only pattern. */
function dragPattern(): RegExp {
  const forms = messageInAnyLanguage("boardView.drag", { count: COUNT_MARK }).map((text) =>
    text
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      .replace(COUNT_MARK, "(\\d+)")
      .replace(/ +/g, "\\s*"),
  );
  return new RegExp(forms.join("|"));
}

/** How many cards this one holds up, read from the related line. 0 when absent. */
export function dragCount(related: string): number {
  const match = dragPattern().exec(related);
  const digits = match?.slice(1).find((group) => group !== undefined);
  return digits ? Number(digits) : 0;
}

function headLine(text: string | null): string {
  return (text ?? "").split("\n", 1)[0]?.trim() ?? "";
}

export function isQuotaWait(task: Pick<ViewTask, "nextStep">): boolean {
  return isQuotaWaitReason(headLine(task.nextStep));
}

export function isExternalWaitCard(task: Pick<ViewTask, "nextStep">): boolean {
  return isExternalWaitText(headLine(task.nextStep));
}

/** Parent PR problems that only a person can settle. The parent finished, but its PR will not merge by itself. */
export function parentPrClosed(): string {
  return t("boardView.parentPr.closed");
}

export function parentArchivedUnmerged(): string {
  return t("boardView.parentPr.archivedUnmerged");
}

/** The parent PR problem named in a waiting card's next step (in any language), or null for an ordinary wait. */
export function parentPrProblemOf(text: string | null): string | null {
  const head = headLine(text);
  const problems = [...messageInAnyLanguage("boardView.parentPr.closed"), ...messageInAnyLanguage("boardView.parentPr.archivedUnmerged")];
  return problems.some((item) => head.includes(item)) ? head : null;
}

function isLandConflict(task: Pick<ViewTask, "badge">): boolean {
  return isLandPendingBadge(task.badge) && isConflictBadge(task.badge);
}

export function isLandPending(task: Pick<ViewTask, "badge">): boolean {
  return isLandPendingBadge(task.badge);
}

/** One short hint for the compact card: the single most important thing about it. */
export function cardHint(task: ViewTask): { tone: "danger" | "warning" | "muted"; text: string } | null {
  if (task.status === "blocked" && task.blockedKind === "scheduled" && task.scheduledUntil) {
    return { tone: "warning", text: scheduledWaitLabel(task.scheduledUntil) };
  }
  if (task.status === "blocked") {
    const reason = task.blockedReason || headLine(task.nextStep);
    return { tone: "danger", text: t("cardParts.alert.blocked", { reason: reason || t("boardView.reasonMissing") }) };
  }
  if (task.leaderHold) return { tone: "danger", text: holdHeadline(task.reviewRound) };
  if (isLandConflict(task)) {
    return { tone: "danger", text: task.tempNote ? t("labels.caption.landConflict", { summary: task.tempNote }) : t("labels.caption.landConflictBare") };
  }
  const head = headLine(task.nextStep);
  if (isQuotaWait(task) || isExternalWaitCard(task)) return { tone: "warning", text: head };
  if (task.leaderUnresponsive) return { tone: "danger", text: t("boardView.hint.leaderSilent", { leader: LEADER_LABEL }) };
  if (task.unattended) return { tone: "warning", text: t("cardParts.alert.unattended") };
  if (task.returnNote) return { tone: "warning", text: task.returnNote.split("\n", 1)[0] ?? task.returnNote };
  if (task.stallNote) return { tone: "warning", text: task.stallNote };
  if (task.mcpNote) return { tone: "warning", text: task.mcpNote };
  if (isLandPending(task)) return { tone: "warning", text: task.tempNote || t("boardView.hint.notLanded") };
  if (task.awaitingMerge) return { tone: "warning", text: t("cardDrawer.pr.awaiting") };
  if (head) return { tone: "muted", text: t("blocked.nextStep", { step: head }) };
  const drag = dragCount(task.related);
  if (drag > 0) return { tone: "muted", text: dragNote(drag) };
  return null;
}

export interface AttentionItem<T extends ViewTask = ViewTask> {
  task: T;
  /** Smaller is more urgent. */
  rank: number;
  /** Why it is here, in a few words. */
  reason: string;
  decisions: number;
  /** True when it is only waiting on something outside: listed in the folded waiting-for-merge group, not counted on the badge. */
  quiet: boolean;
}

/** Why a card needs a person, or null when it does not. */
export function attentionOf<T extends ViewTask>(task: T, decisions: readonly DecisionView[]): AttentionItem<T> | null {
  const matched = task.status === "archived" ? [] : cardDecisions(task.code, decisions);
  const base = { task, decisions: matched.length, quiet: false };
  if (task.status === "blocked" && task.blockedKind === "scheduled" && task.scheduledUntil && Date.parse(task.scheduledUntil) > Date.now()) return null;
  if (task.status === "blocked") {
    return { ...base, rank: 0, reason: `${t("labels.status.blocked")}${task.blockedKind ? ` · ${blockedKindLabel(task.blockedKind)}` : ""}` };
  }
  if (task.leaderUnresponsive) return { ...base, rank: 1, reason: t("boardView.attention.leaderNoResponse", { leader: LEADER_LABEL }) };
  if (task.status === "waiting" && parentPrProblemOf(task.nextStep)) return { ...base, rank: 2, reason: t("boardView.attention.parentPr") };
  if (isLandConflict(task)) return { ...base, rank: 2, reason: t("labels.caption.landConflictBare") };
  if (task.status === "acceptance") return { ...base, rank: 3, reason: t("boardView.attention.acceptance", { leader: LEADER_LABEL }) };
  if (task.leaderHold) return { ...base, rank: 4, reason: t("boardView.attention.hold", { round: task.reviewRound }) };
  if (matched.length > 0) return { ...base, rank: matched.some((item) => item.blocking) ? 4 : 5, reason: t("boardView.attention.decision") };
  if (isLandPending(task)) return { ...base, rank: 6, reason: t("labels.badge.landPending"), quiet: true };
  if (task.status === "done" && task.awaitingMerge) return { ...base, rank: 6, reason: t("cardDrawer.pr.awaiting"), quiet: true };
  if (task.unattended) return { ...base, rank: 6, reason: t("cardParts.alert.unattended") };
  return null;
}

export interface AttentionGroup<T extends ViewTask = ViewTask> {
  project: string;
  items: Array<AttentionItem<T>>;
}

/** Waiting-for-merge cards, folded away from the urgent list. */
export function quietAttention<T extends ViewTask>(tasks: readonly T[], decisions: readonly DecisionView[]): Array<AttentionItem<T>> {
  return tasks
    .flatMap((task) => attentionOf(task, decisions) ?? [])
    .filter((item) => item.quiet)
    .sort((a, b) => a.task.id - b.task.id);
}

/** Urgent cards that need a person, grouped by project. The most urgent project and card come first. */
export function attentionGroups<T extends ViewTask>(tasks: readonly T[], decisions: readonly DecisionView[]): Array<AttentionGroup<T>> {
  const groups = new Map<string, Array<AttentionItem<T>>>();
  for (const task of tasks) {
    const item = attentionOf(task, decisions);
    if (!item || item.quiet) continue;
    groups.set(task.project, [...(groups.get(task.project) ?? []), item]);
  }
  const ordered = [...groups].map(([project, items]) => ({
    project,
    items: [...items].sort((a, b) => a.rank - b.rank || a.task.id - b.task.id),
  }));
  return ordered.sort((a, b) => a.items[0]!.rank - b.items[0]!.rank || b.items.length - a.items.length || a.project.localeCompare(b.project));
}

export interface SystemAlert {
  tone: "danger" | "warning";
  text: string;
}

/** Board-level problems. Red ones count on the attention tab badge. */
export function systemAlerts(board: {
  schedulerReady: boolean;
  schedulerIdle: string | null;
  matrixMessage: string | null;
  missingCwdMessage: string | null;
  tempWorkspaceMessage: string | null;
  restartMessage: string | null;
  pool: { state: string; message: string };
}): SystemAlert[] {
  const alerts: SystemAlert[] = [];
  if (!board.schedulerReady) alerts.push({ tone: "danger", text: t("boardView.alert.schedulerNotReady") });
  if (board.schedulerIdle) alerts.push({ tone: "danger", text: board.schedulerIdle });
  if (board.missingCwdMessage) alerts.push({ tone: "danger", text: board.missingCwdMessage });
  if (board.tempWorkspaceMessage) alerts.push({ tone: "danger", text: board.tempWorkspaceMessage });
  if (board.matrixMessage) alerts.push({ tone: "warning", text: board.matrixMessage });
  if (board.restartMessage) alerts.push({ tone: "warning", text: board.restartMessage });
  if (board.pool.state !== "fresh") alerts.push({ tone: "warning", text: board.pool.message });
  return alerts;
}

export interface TabBadge {
  count: number;
  danger: boolean;
}

export function boardTabBadges(input: {
  tasks: readonly ViewTask[];
  decisions: readonly DecisionView[];
  projects: number;
  alerts: readonly SystemAlert[];
  /** Red doctor findings; each one counts. */
  doctorReds?: number;
}): Record<BoardTab, TabBadge> {
  const groups = attentionGroups(input.tasks, input.decisions);
  const items = groups.flatMap((group) => group.items);
  const redAlerts = input.alerts.filter((alert) => alert.tone === "danger").length + (input.doctorReds ?? 0);
  return {
    overview: { count: input.tasks.filter((task) => task.column === "todo" || task.column === "doing").length, danger: false },
    attention: { count: items.length + redAlerts, danger: redAlerts > 0 || items.some((item) => item.rank <= 2) },
    decisions: { count: input.decisions.length, danger: input.decisions.some((item) => item.blocking) },
    projects: { count: input.projects, danger: false },
    settings: { count: 0, danger: false },
  };
}

export interface HandlingGuide {
  /** One line: the situation. */
  headline: string;
  /** Plain steps, one per line. */
  steps: string[];
  /** Commands that can be copied as they are. */
  commands: string[];
  /** True when a person must act; false when waiting is the whole job. */
  needsPerson: boolean;
}

export interface GuideContext {
  parents: ReadonlyArray<{ code: string; title: string; status: string }>;
  decisionCount?: number;
}

function acceptNote(): string {
  return t("boardView.note.accept");
}

function reversibleNote(): string {
  return t("boardView.note.reversible");
}

function mergeNote(): string {
  return t("boardView.note.merge");
}

/** `placeholder` is the text inside the quotes; it defaults to "<what to change>". */
function reworkCommand(code: string, placeholder: string = t("boardView.cmd.reworkReason")): string {
  return `bin/kanban rework ${code} --reason "${placeholder}"`;
}

function holdHeadline(round: number): string {
  return t("boardView.hold.headline", { round, leader: LEADER_LABEL });
}

function blockedGuide(task: ViewTask, ctx: GuideContext): HandlingGuide {
  const kind = task.blockedKind ? blockedKindLabel(task.blockedKind) : "";
  const reason = task.blockedReason || headLine(task.nextStep) || t("boardView.reasonMissing");
  const steps = [`${t("boardView.blocked.where", { reason })}${kind ? t("common.paren", { text: kind }) : ""}`];
  if (task.blockedKind === "needs_human") steps.push(t("boardView.blocked.whoHuman", { leader: LEADER_LABEL, note: reversibleNote() }));
  else if (task.blockedKind === "dependency") steps.push(t("boardView.blocked.dependency"));
  else if (task.blockedKind === "quota" || task.blockedKind === "rate_limit") steps.push(t("boardView.blocked.quota"));
  else if (task.blockedKind === "transient") steps.push(t("boardView.blocked.transient"));
  else if (task.blockedKind === "scheduled") steps.push(t("boardView.blocked.scheduled"));
  else steps.push(t("boardView.blocked.whoDefault", { leader: LEADER_LABEL }));
  if (ctx.parents.length > 0) {
    const list = ctx.parents.map((item) => `${item.code}${t("common.paren", { text: statusLabel(item.status) })}`).join(t("common.listSep"));
    steps.push(t("boardView.blocked.parents", { list }));
  }
  return {
    headline: task.blockedKind === "scheduled" && task.scheduledUntil ? scheduledWaitLabel(task.scheduledUntil) : t("boardView.blocked.headline"),
    steps,
    commands: [
      `bin/kanban unblock ${task.code}`,
      reworkCommand(task.code),
      `bin/kanban pass ${task.code} --note "${t("boardView.cmd.rulingReason")}"`,
      `bin/kanban archive ${task.code}`,
    ],
    needsPerson: !(task.blockedKind === "scheduled" && task.scheduledUntil && Date.parse(task.scheduledUntil) > Date.now()),
  };
}

function acceptanceGuide(task: ViewTask, ctx: GuideContext): HandlingGuide {
  const steps = [acceptNote(), reversibleNote()];
  if (task.leaderUnresponsive) steps.unshift(t("boardView.accept.leaderSilent", { leader: LEADER_LABEL }));
  if (isExternalWaitCard(task)) steps.push(t("boardView.accept.external", { wait: headLine(task.nextStep) }));
  if ((ctx.decisionCount ?? 0) > 0) steps.push(t("boardView.accept.decisions", { count: ctx.decisionCount ?? 0 }));
  return {
    headline: t("boardView.accept.headline", { leader: LEADER_LABEL }),
    steps,
    commands: [`bin/kanban accept ${task.code}`, reworkCommand(task.code)],
    needsPerson: true,
  };
}

function holdGuide(task: ViewTask): HandlingGuide {
  const steps = [
    t("boardView.hold.stopped", { round: task.reviewRound, leader: LEADER_LABEL }),
    t("boardView.hold.threeWays"),
    t("boardView.hold.options"),
  ];
  return {
    headline: holdHeadline(task.reviewRound),
    steps,
    commands: [reworkCommand(task.code, t("boardView.cmd.ruling")), `bin/kanban pass ${task.code} --note "${t("boardView.cmd.reason")}"`],
    needsPerson: true,
  };
}

/** Rejection text for the round-2 hold, one block per round in time order. A lone rejection is not titled round 2. */
export function holdRoundBlocks(
  rounds: ReadonlyArray<{ at: string; kind?: string; reason: string; findings: string }>,
): Array<{ title: string; reason: string; findings: string }> {
  return rounds.map((round, index) => {
    const label =
      rounds.length === 1
        ? t("boardView.round.single")
        : round.kind === "rejected"
          ? t("boardView.round.leaderReject", { round: index + 1 })
          : t("boardView.round.reject", { round: index + 1 });
    const when = round.at ? ` · ${round.at.slice(0, 16).replace("T", " ")}` : "";
    return { title: `${label}${when}`, reason: round.reason || t("boardView.round.noReason"), findings: round.findings };
  });
}

function waitingGuide(task: ViewTask, ctx: GuideContext): HandlingGuide {
  const problem = parentPrProblemOf(task.nextStep);
  if (problem) {
    return {
      headline: problem,
      steps: [
        t("boardView.waiting.prStuck"),
        t("boardView.waiting.commentOnly", { leader: LEADER_LABEL }),
      ],
      commands: [`bin/kanban show ${task.code}`, `bin/kanban unlink ${task.code} --parent ${t("boardView.cmd.parentCode")}`, `bin/kanban archive ${task.code}`],
      needsPerson: true,
    };
  }
  const pending = ctx.parents.filter((item) => item.status !== "done" && item.status !== "archived");
  const steps =
    pending.length > 0
      ? [
          ...pending.map((item) => t("boardView.waiting.parent", { code: item.code, title: item.title, status: statusLabel(item.status) })),
          t("boardView.waiting.autoStart"),
        ]
      : [
          t("boardView.waiting.parentsDone"),
          t("boardView.waiting.prPoll", { leader: LEADER_LABEL, code: task.code }),
        ];
  return {
    headline: t("labels.badge.waitingParentsBare"),
    steps,
    commands: pending.length > 0 ? [`bin/kanban show ${task.code}`] : [`bin/kanban show ${task.code}`, `bin/kanban start ${task.code}`],
    needsPerson: false,
  };
}

function quotaGuide(task: ViewTask): HandlingGuide {
  return {
    headline: t("boardView.quota.headline"),
    steps: [headLine(task.nextStep), t("boardView.quota.step")],
    commands: [`bin/kanban show ${task.code}`],
    needsPerson: false,
  };
}

function externalGuide(task: ViewTask): HandlingGuide {
  return {
    headline: t("boardView.external.headline"),
    steps: [headLine(task.nextStep), t("boardView.external.step")],
    commands: [`bin/kanban show ${task.code}`],
    needsPerson: false,
  };
}

function doneGuide(task: ViewTask): HandlingGuide {
  if (isLandPending(task) && isLandConflict(task)) {
    return {
      headline: t("boardView.done.conflictHeadline"),
      steps: [
        t("boardView.done.conflictWhere", { code: task.code }),
        t("boardView.done.conflictChoice"),
        t("boardView.done.conflictWorkspace"),
      ],
      commands: [
        reworkCommand(task.code, t("boardView.cmd.resolveConflict")),
        `bin/kanban create --project ${task.project} --title "${t("boardView.done.conflictTitle", { code: task.code })}" --role batch --workspace ${t("boardView.cmd.repoDir")} --brief "${t("boardView.done.conflictBrief", { code: task.code })}"`,
      ],
      needsPerson: true,
    };
  }
  if (isLandPending(task)) {
    return {
      headline: t("boardView.done.landHeadline"),
      steps: [
        t("boardView.done.landStep"),
        mergeNote(),
      ],
      commands: [
        `bin/kanban comment ${task.code} "${t("boardView.cmd.okToMerge")}"`,
        `bin/kanban create --project ${task.project} --title "${t("boardView.done.mergeTitle", { code: task.code })}" --role batch --workspace ${t("boardView.cmd.repoDir")} --brief "${t("boardView.done.mergeBrief", { code: task.code })}"`,
      ],
      needsPerson: false,
    };
  }
  if (task.awaitingMerge) {
    return {
      headline: t("boardView.done.prHeadline"),
      steps: [mergeNote(), t("boardView.done.prStep")],
      commands: [
        `bin/kanban comment ${task.code} "${t("boardView.cmd.okToMerge")}"`,
        `bin/kanban create --project ${task.project} --title "${t("boardView.done.prTitle", { code: task.code })}" --role batch --workspace ${t("boardView.cmd.repoDir")} --brief "${t("boardView.done.prBrief")}"`,
      ],
      needsPerson: true,
    };
  }
  return { headline: t("boardView.done.headline"), steps: [t("boardView.done.step")], commands: [`bin/kanban archive ${task.code}`], needsPerson: false };
}

/** What to do about a card right now, with commands that can be copied. */
export function handlingGuide(task: ViewTask, ctx: GuideContext = { parents: [] }): HandlingGuide {
  if (task.status === "blocked") return blockedGuide(task, ctx);
  if (task.status === "acceptance") return acceptanceGuide(task, ctx);
  if (task.leaderHold) return holdGuide(task);
  if (task.status === "done" || task.status === "archived") return doneGuide(task);
  if (isQuotaWait(task)) return quotaGuide(task);
  if (isExternalWaitCard(task)) return externalGuide(task);
  switch (task.status) {
    case "waiting":
      return waitingGuide(task, ctx);
    case "triage":
      return {
        headline: statusLabel("triage"),
        steps: [t("boardView.triage.step", { leader: LEADER_LABEL })],
        commands: [`bin/kanban show ${task.code}`],
        needsPerson: true,
      };
    case "draft":
    case "ready":
      return {
        headline: statusLabel(task.status),
        steps: [t("boardView.ready.step")],
        commands: [`bin/kanban start ${task.code}`],
        needsPerson: false,
      };
    case "rework":
      return {
        headline: t("labels.badge.rework", { round: task.reviewRound }),
        steps: [task.returnNote ? t("boardView.rework.reason", { note: task.returnNote }) : t("boardView.rework.working"), t("boardView.rework.step")],
        commands: [`bin/kanban show ${task.code}`],
        needsPerson: false,
      };
    default:
      return {
        headline: statusLabel(task.status),
        steps: [task.stallNote ? t("boardView.default.note", { note: task.stallNote }) : t("boardView.default.working")],
        commands: [`bin/kanban show ${task.code}`],
        needsPerson: false,
      };
  }
}

/** One latest-first slice of the events for the short timeline. */
export function recentEvents<T extends { id: number }>(events: readonly T[], expanded: boolean, short = 5, long = 20): T[] {
  return [...events].sort((a, b) => b.id - a.id).slice(0, expanded ? long : short);
}

/** Handoff summary pulled out of the stored handoff JSON. Empty when absent. */
export function handoffDigest(json: string | null): { summary: string; verification: string; risks: string; files: string } {
  const empty = { summary: "", verification: "", risks: "", files: "" };
  if (!json) return empty;
  try {
    const parsed = JSON.parse(json) as { summary?: unknown; handoff?: unknown };
    const inner = typeof parsed.handoff === "string" ? (JSON.parse(parsed.handoff) as unknown) : parsed.handoff;
    const body = inner && typeof inner === "object" && !Array.isArray(inner) ? (inner as Record<string, unknown>) : {};
    const text = (value: unknown): string => {
      if (typeof value === "string") return value.trim();
      if (Array.isArray(value)) return value.map((item) => String(item)).join("\n");
      return "";
    };
    return {
      summary: typeof parsed.summary === "string" ? parsed.summary.trim() : "",
      verification: text(body.verification),
      risks: text(body.risks),
      files: text(body.files),
    };
  } catch {
    return empty;
  }
}
