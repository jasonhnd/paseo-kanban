/// <reference types="node" />
import type { PaseoApi } from "./paseo-api";
import { isAgentInput, selfWorkSignal, unregisteredQuestion, type LeaderAction, type LeaderDetail, type LeaderReply, type RegisteredDecision } from "../../shared/fleet/leader-panel";
import { t } from "../../shared/fleet/i18n";
import { isBusyStatusText, type SupervisorRow } from "../../shared/fleet/supervisor-shift";
import { claudeProjectDirName, weekStatsOver } from "../../shared/fleet/leader-week";
import { readLeaderCards } from "./kanban";
import { noteLeaderForArchive } from "./leader-activity-archive";
import { CLAUDE_PROJECTS, weekStatsFor } from "./leader-week";
import { join } from "node:path";
import { cached } from "./util";

export const LEADER_TIMELINE_LIMIT = 60;
export const LEADER_TIMELINE_TIMEOUT_MS = 1500;
interface Activity { latest: LeaderReply | null; latestUserAt: string | null; lastUserReplyAt: string | null; actions: LeaderAction[] }
const busyStarts = new Map<string, string>();
const pending = new Map<string, Promise<Activity>>();

function object(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
}
/** Whitelist message/tool fields; never display tool output, reasoning or raw metadata. */
export function parseLeaderActivity(entries: readonly unknown[]): Activity {
  const sorted = entries.map(object).filter((e) => typeof e.timestamp === "string" && Number.isFinite(Date.parse(e.timestamp)))
    .sort((a, b) => Number(a.seqStart ?? 0) - Number(b.seqStart ?? 0));
  let latest: LeaderReply | null = null;
  let latestUserAt: string | null = null;
  let lastUserReplyAt: string | null = null;
  let lastUserText: string | undefined;
  const actions: LeaderAction[] = [];
  for (const entry of sorted) {
    const item = object(entry.item), at = String(entry.timestamp);
    if (item.type === "assistant_message" && typeof item.text === "string" && item.text.trim()) {
      latest = {text:item.text,at,prompt:lastUserText};
      // A missing prompt is treated as the user. Notices from other agents are not.
      if (!isAgentInput(lastUserText)) lastUserReplyAt = at;
    }
    if (item.type === "user_message") { latestUserAt = at; lastUserText = typeof item.text === "string" ? item.text.slice(0, 200) : undefined; }
    if (item.type !== "tool_call" || typeof item.name !== "string") continue;
    const detail = object(item.detail);
    const input = object(detail.input);
    const command = typeof detail.command === "string" ? detail.command : typeof input.command === "string" ? input.command : typeof input.cmd === "string" ? input.cmd : "";
    const file = typeof detail.filePath === "string" ? detail.filePath : "";
    actions.push({ at, name:item.name, detailType:String(detail.type ?? ""), command:command.slice(0, 4000), summary:`${item.name}${command || file ? ` · ${(command || file).replace(/\s+/g, " ").slice(0, 160)}` : ""}` });
  }
  return { latest, latestUserAt, lastUserReplyAt, actions:actions.slice(-20) };
}

/** Tracks observed continuous running, never session age. Idle or a new registered id resets it. */
export function observeBusy(id: string, busy: boolean, now: number, starts = busyStarts): string | null {
  if (!busy) { starts.delete(id); return null; }
  if (!starts.has(id)) starts.set(id, new Date(now).toISOString());
  return starts.get(id)!;
}
async function activity(paseo: PaseoApi, id: string): Promise<Activity> {
  return cached(`leader-activity:${id}`, 10_000, async () => {
    let request = pending.get(id);
    if (!request) {
      request = paseo.agents.ref(id).timeline.refetch({direction:"tail",limit:LEADER_TIMELINE_LIMIT})
        .then((page) => { if (page.error) throw new Error(page.error); return parseLeaderActivity(page.entries); });
      pending.set(id, request);
      const clear = () => { if (pending.get(id) === request) pending.delete(id); };
      request.then(clear, clear);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([request, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(t("leader.server.activityTimeout"))), LEADER_TIMELINE_TIMEOUT_MS); })]);
    } finally { if (timer) clearTimeout(timer); }
  });
}
export async function readLeaderDetails(paseo: PaseoApi, rows: readonly SupervisorRow[], decisions: readonly RegisteredDecision[], now: number, sessions: ReadonlyMap<string, { cwd: string; provider: string }> = new Map()): Promise<LeaderDetail[]> {
  const cards = readLeaderCards();
  const ids = new Set(rows.map((r) => r.agentId));
  for (const id of busyStarts.keys()) if (!ids.has(id)) busyStarts.delete(id);
  // All projects share the same read deadline; no serial CLI processes on the refresh path.
  return Promise.all(rows.map(async (row) => {
    const busy = isBusyStatusText(row.statusText);
    const busySince = observeBusy(row.agentId, busy, now);
    let view: Activity = { latest:null,latestUserAt:null,lastUserReplyAt:null,actions:[] };
    let activityWarning: string | null = null;
    try { view = await activity(paseo, row.agentId); }
    catch (error) { activityWarning = t("leader.server.activityWarning", { error: String(error).slice(0, 120) }); }
    const session = sessions.get(row.agentId);
    // Non-Claude leaders keep no jsonl we can read: null means "cannot be counted".
    const sessionDir = session?.provider === "claude" && session.cwd ? join(CLAUDE_PROJECTS, claudeProjectDirName(session.cwd)) : null;
    const weekStats = sessionDir ? weekStatsFor(sessionDir, now) : null;
    // Only the project that owns the session is archived; a proxied project shares the same directory and would double the counts.
    if (sessionDir && !row.proxyOf) noteLeaderForArchive(sessionDir, { project: row.project, code: row.code }, now);
    const base = selfWorkSignal({busy,busySince,actionSince:view.latestUserAt,actions:view.actions,now});
    // busySince restarts from zero with the plugin, so a busy leader that did more than it dispatched this week is flagged too.
    const overWeek = busy && !base.selfWorking && weekStatsOver(weekStats);
    const signal = overWeek ? { ...base, selfWorking:true, reason:t("leader.selfWork.overWeek") } : base;
    const unanswered = view.latest && (!view.latestUserAt || Date.parse(view.latestUserAt) <= Date.parse(view.latest.at));
    return {
      project:row.project,agentId:row.agentId,lastReplyAt:view.latest?.at ?? null,
      lastUserReplyAt: activityWarning ? null : view.lastUserReplyAt,
      question:unregisteredQuestion(row.project,unanswered ? view.latest : null,decisions),busySince,
      selfWorking:signal.selfWorking,selfWorkReason:signal.reason,actions:signal.actions,
      cards:cards.cards.filter((c) => c.project.toLowerCase() === row.project.toLowerCase()),
      activityWarning,cardsWarning:cards.warning,weekStats,repeatWakes24h:cards.wakes24h[row.project.toLowerCase()] ?? 0,
    };
  }));
}
