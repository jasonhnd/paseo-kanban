import { t } from "../shared/i18n";

export const FINISH_TOOLS = ["kanban_complete", "kanban_approve", "kanban_request_changes", "kanban_block", "kanban_accept"] as const;

export function timelineFinished(timeline: readonly unknown[]): boolean {
  return timeline.some((item) => {
    if (!item || typeof item !== "object") return false;
    const record = item as { type?: string; name?: string };
    return record.type === "tool_call" && FINISH_TOOLS.some((name) => (record.name ?? "").includes(name));
  });
}

export type TurnPlan =
  | { action: "skip"; reason: string }
  | { action: "failed"; message: string; code?: string }
  | { action: "canceled" }
  | { action: "completed"; finished: boolean };

function turnKind(outcome: unknown): "completed" | "failed" | "canceled" | "other" | "unreadable" {
  if (!outcome || typeof outcome !== "object" || !("kind" in outcome)) return "unreadable";
  const kind = (outcome as { kind?: unknown }).kind;
  if (kind === "completed" || kind === "failed" || kind === "canceled") return kind;
  if (typeof kind === "string") return "other";
  return "unreadable";
}

/**
 * Decide what a turn-ended event should do.
 * Unreadable outcome or timeline skips this round instead of throwing.
 */
export function planTurn(outcome: unknown, timeline: unknown): TurnPlan {
  const kind = turnKind(outcome);
  if (kind === "unreadable" || kind === "other") return { action: "skip", reason: t("nudge.skip.badOutcome") };
  if (kind === "canceled") return { action: "canceled" };
  if (kind === "failed") {
    const error = (outcome as { error?: unknown }).error;
    const record = error && typeof error === "object" ? (error as { message?: unknown; code?: unknown }) : null;
    const message = record && typeof record.message === "string" && record.message ? record.message : t("nudge.failed.noMessage");
    const code = record && typeof record.code === "string" ? record.code : undefined;
    return { action: "failed", message, ...(code ? { code } : {}) };
  }
  if (!Array.isArray(timeline)) return { action: "skip", reason: t("nudge.skip.badTimeline") };
  return { action: "completed", finished: timelineFinished(timeline) };
}

/**
 * A counted nudge is still inside the minimum gap. The next quiet turn must not count yet.
 * No earlier nudge, or a clock that cannot be read, means this turn may count.
 */
export function withinNudgeInterval(lastNudgeAt: string | null, nowMs: number, intervalMs: number): boolean {
  if (!(intervalMs > 0) || !Number.isFinite(nowMs) || !lastNudgeAt) return false;
  const parsed = Date.parse(lastNudgeAt);
  if (!Number.isFinite(parsed)) return false;
  return nowMs - parsed < intervalMs;
}

function unwrapTimelineItem(entry: unknown): unknown {
  if (entry && typeof entry === "object" && "item" in entry) {
    const item = (entry as { item?: unknown }).item;
    if (item && typeof item === "object") return item;
  }
  return entry;
}

/** Handoff summaries stay on the card. Longer assistant text is cut, with a visible mark. */
export const HANDOFF_TEXT_LIMIT = 4000;

/** Newest assistant_message text. User lines, errors, and tool calls are not a handoff. */
export function lastAssistantText(timeline: unknown): string | null {
  if (!Array.isArray(timeline)) return null;
  for (let i = timeline.length - 1; i >= 0; i -= 1) {
    const item = unwrapTimelineItem(timeline[i]);
    if (!item || typeof item !== "object") continue;
    const record = item as { type?: unknown; text?: unknown; message?: unknown };
    if (record.type !== "assistant_message") continue;
    const text = typeof record.text === "string" ? record.text : typeof record.message === "string" ? record.message : "";
    if (text.trim()) return text.trim();
  }
  return null;
}

export function truncateHandoff(text: string, limit = HANDOFF_TEXT_LIMIT): string {
  const trimmed = text.trim();
  if (trimmed.length <= limit) return trimmed;
  return t("nudge.truncated", { text: trimmed.slice(0, limit) });
}

/**
 * Heuristic only. Paseo has no structured "still waiting" flag on a notification.
 * Wording that no longer matches these phrases is treated as an idle turn.
 */
function backgroundStillRunning(message: string): boolean {
  const text = message.toLowerCase();
  // Also the Chinese word for "subtask".
  if (!/background agent|sub-?agent|\u5b50\u4efb\u52a1/.test(text)) return false;
  if (/didn't finish|did not finish|didn't complete|did not complete|failed/.test(text)) return false;
  // Also the Chinese words for "still" (two spellings).
  return /still running|in progress|waiting|\u4ecd\u5728|\u8fd8\u5728/.test(text);
}

function detailType(detail: unknown): string | null {
  if (!detail || typeof detail !== "object" || !("type" in detail)) return null;
  const type = (detail as { type?: unknown }).type;
  return typeof type === "string" ? type : null;
}

/**
 * A sub-agent tool is still open when its latest status on this timeline is `running`.
 * Completed, failed, canceled, or missing status does not count. Ordinary tool calls never count.
 */
function subAgentStillRunning(timeline: unknown[]): boolean {
  const statusByCall = new Map<string, string>();
  let anon = 0;
  for (const entry of timeline) {
    const item = unwrapTimelineItem(entry);
    if (!item || typeof item !== "object") continue;
    const record = item as { type?: unknown; callId?: unknown; status?: unknown; detail?: unknown };
    if (record.type !== "tool_call" || detailType(record.detail) !== "sub_agent") continue;
    const id = typeof record.callId === "string" && record.callId ? record.callId : `anon-${anon}`;
    anon += 1;
    statusByCall.set(id, typeof record.status === "string" ? record.status : "");
  }
  for (const status of statusByCall.values()) {
    if (status === "running") return true;
  }
  return false;
}

/**
 * Not a miss only when a sub-agent is still running, or a notification heuristically says so.
 * A finished Read or Bash call is a miss: the agent worked and still did not call a finish tool.
 */
export function timelineShowsWork(timeline: unknown): boolean {
  if (!Array.isArray(timeline)) return false;
  if (subAgentStillRunning(timeline)) return true;
  for (const entry of timeline) {
    const item = unwrapTimelineItem(entry);
    if (!item || typeof item !== "object") continue;
    const record = item as { type?: unknown; message?: unknown };
    if (record.type === "notification" && typeof record.message === "string" && backgroundStillRunning(record.message)) return true;
  }
  return false;
}

/**
 * 1st and 2nd miss: remind. 3rd miss: block as needs_human. A finish call resets the counter.
 * `progress` means this agent wrote a progress comment since the last nudge, and that streak
 * is still inside progressGraceMs. That turn is not a miss.
 */
export function judgeNudge(count: number, finished: boolean, progress = false): { count: number; action: "none" | "remind" | "block" } {
  if (finished) return { count: 0, action: "none" };
  if (progress) return { count, action: "none" };
  const next = count + 1;
  if (next >= 3) return { count: next, action: "block" };
  return { count: next, action: "remind" };
}

/**
 * A progress comment since the last nudge covers this turn until the streak exceeds graceMs.
 * The streak starts at the earliest comment after `lastNudgeAt` (or the earliest comment, if
 * this agent has not been nudged yet). No usable comment means the old rule.
 * `now - start > graceMs` means the grace is over.
 */
export function progressCoversTurn(
  commentAts: readonly string[],
  lastNudgeAt: string | null,
  nowMs: number,
  graceMs: number,
): boolean {
  if (!(graceMs > 0) || !Number.isFinite(nowMs)) return false;
  let after = Number.NEGATIVE_INFINITY;
  if (lastNudgeAt) {
    const parsed = Date.parse(lastNudgeAt);
    if (!Number.isFinite(parsed)) return false;
    after = parsed;
  }
  let earliest = Infinity;
  for (const at of commentAts) {
    const ms = Date.parse(at);
    if (!Number.isFinite(ms) || ms <= after || ms > nowMs) continue;
    if (ms < earliest) earliest = ms;
  }
  if (!Number.isFinite(earliest)) return false;
  return nowMs - earliest <= graceMs;
}

function parsedMs(value: string | null): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The agent was just opened. A turn ending in this window is not "this round finished".
 * No lastUserMessageAt means the first user turn has not started; that only stays quiet
 * while the run itself is still inside the window. A user message counts as the opening
 * turn only when it lands within one window of the run start.
 */
export function inOpeningGrace(
  startedAt: string | null,
  lastUserMessageAt: string | null,
  nowMs: number,
  graceMs: number,
): boolean {
  if (!(graceMs > 0)) return false;
  const started = parsedMs(startedAt);
  const user = parsedMs(lastUserMessageAt);
  if (user == null) {
    if (started == null) return false;
    return nowMs - started < graceMs;
  }
  if (started != null && Math.abs(user - started) >= graceMs) return false;
  const began = started == null ? user : Math.max(started, user);
  return nowMs - began < graceMs;
}

/** A string on the agent, null when the field is present but empty, undefined when the field is absent. */
export function lastUserMessageAtOf(agent: unknown): string | null | undefined {
  if (!agent || typeof agent !== "object" || !("lastUserMessageAt" in agent)) return undefined;
  const value = (agent as { lastUserMessageAt?: unknown }).lastUserMessageAt;
  return typeof value === "string" && value ? value : null;
}
