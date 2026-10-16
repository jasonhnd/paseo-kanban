import { wakeSummary } from "./wake-summary";
import { acceptanceEntry, loadAcceptanceReviewWaits, syncAcceptanceReviewWait } from "./acceptance-review-wait";
import { t } from "../shared/i18n";
import { leaderActionNote } from "./protocol";
import { isAgentAlive } from "./alive";
import { deliverWake, hasWakeSender } from "./bus";
import { cardMarkOf } from "./card-ref";
import { loadConfig, projectSupervisor, type KanbanConfig } from "./config";
import { getDb } from "./db";
import { readOpenDecisions, waitingOnDecision } from "./decisions";
import { isProjectDormant } from "./paused";
import { clearLeaderUnresponsive, LEADER_UNRESPONSIVE_TAG } from "./leader-activity";
import { agentCwdMissing, noteWakeSkipped } from "./missing-cwd";
import { parseTags } from "./profile-rules";
import { appendEvent, getTask, type TaskRow } from "./store";
import { errorMessage, withTimeout } from "./guard";

const HALF_HOUR = 30 * 60_000;
const TWO_HOURS = 2 * 60 * 60_000;

/** The newest event by id from the supervisor or this project's leader, in any card of the project. */
function latestLeaderAction(project: string, leader: string | null): string | null {
  const db = getDb();
  let best: { id: number; at: string } | undefined;
  for (const actor of leader ? ["supervisor", leader] : ["supervisor"]) {
    const row = db.prepare(`SELECT e.id AS id, e.at AS at FROM events e JOIN tasks t ON t.id = e.task_id
      WHERE e.actor = ? AND t.project = ? ORDER BY e.id DESC LIMIT 1`).get(actor, project) as { id: number; at: string } | undefined;
    if (row && (!best || row.id > best.id)) best = row;
  }
  return best?.at ?? null;
}

const BACKOFF_FIRST_MS = 5 * 60_000;
const BACKOFF_MAX_MS = HALF_HOUR;
/** Per project: how many wakes in a row were refused and when the next try is allowed. Lost on reload, which only allows one early retry. */
const refused = new Map<string, { failures: number; retryAfterMs: number }>();

export function resetAcceptanceBackoffForTests(): void {
  refused.clear();
}

function noteRefused(project: string, nowMs: number): void {
  const failures = (refused.get(project)?.failures ?? 0) + 1;
  refused.set(project, { failures, retryAfterMs: nowMs + Math.min(BACKOFF_FIRST_MS * 2 ** (failures - 1), BACKOFF_MAX_MS) });
}

/** One batch per project; delivered reminders are persisted per acceptance round across restarts. */
async function scanAcceptanceOnce(options: { now?: Date; config?: KanbanConfig; decisionsPath?: string } = {}): Promise<void> {
  const now = options.now ?? new Date();
  const ms = now.getTime();
  const at = now.toISOString();
  const config = options.config ?? loadConfig();
  const decisions = readOpenDecisions(options.decisionsPath);
  const db = getDb();
  const all = db.prepare("SELECT * FROM tasks WHERE status = 'acceptance' OR tags LIKE ? ORDER BY id")
    .all(`%${LEADER_UNRESPONSIVE_TAG}%`) as unknown as TaskRow[];
  const groups = new Map<string, TaskRow[]>();
  for (const task of all) {
    // A paused project's acceptance is not chased; its marks stay as they are until it resumes.
    if (isProjectDormant(task.project)) continue;
    const waiting = waitingOnDecision(task, decisions);
    // An unreadable decision file says nothing about whether the user is being waited on: leave marks as they are.
    if (decisions.uncertain && task.status === "acceptance") continue;
    if (task.status !== "acceptance" || waiting) {
      clearLeaderUnresponsive(task.project, waiting ? "user_decision" : "left_acceptance", at, {}, task.id);
      continue;
    }
    const group = groups.get(task.project) ?? [];
    group.push(task);
    groups.set(task.project, group);
  }
  let waits = loadAcceptanceReviewWaits();
  for (const [project, tasks] of groups) {
    const actionable = tasks.filter(snapshot => {
      const task = getTask(snapshot.id);
      if (task.status !== "acceptance") return false;
      const wait = waits.get(task.id);
      syncAcceptanceReviewWait(task, wait, acceptanceEntry(task), at);
      return !wait;
    });
    if (!actionable.length) continue;
    const leader = projectSupervisor(project, config);
    const lastActionAt = latestLeaderAction(project, leader);
    const idle = lastActionAt == null ? Infinity : ms - Date.parse(lastActionAt);
    if (idle <= HALF_HOUR) {
      clearLeaderUnresponsive(project, "leader_action", at, { lastActionAt });
      continue;
    }
    const due: Array<{ task: TaskRow; entry: { id: number; at: string }; count: number }> = [];
    for (const snapshot of actionable) {
      const task = getTask(snapshot.id);
      if (task.status !== "acceptance") continue;
      const entry = acceptanceEntry(task);
      const episode = syncAcceptanceReviewWait(task, undefined, entry, at);
      const age = ms - Math.max(Date.parse(entry.at), Date.parse(episode.at));
      // The snapshot is older than the awaits of earlier projects; write onto the tags as they are now.
      const current = db.prepare("SELECT status, tags FROM tasks WHERE id = ?").get(task.id) as { status: string; tags: string | null } | undefined;
      const currentTags = parseTags(current?.tags ?? null);
      if (current?.status === "acceptance" && age > TWO_HOURS && !currentTags.includes(LEADER_UNRESPONSIVE_TAG)) {
        db.prepare("UPDATE tasks SET tags = ? WHERE id = ?")
          .run(JSON.stringify([...currentTags, LEADER_UNRESPONSIVE_TAG]), task.id);
        appendEvent(task.id, "leader_unresponsive", null, null, "scheduler", {
          project, agentId: leader, acceptanceEventId: entry.id, acceptanceAt: entry.at, lastActionAt,
          acceptanceMinutes: age / 60_000,
        }, at);
      }
      if (age <= HALF_HOUR || !Number.isFinite(age)) continue;
      // Count only successful extra deliveries in this acceptance round, never initial
      // notifications/failures. The event-id boundary also covers legacy reminders
      // without acceptanceEventId; entry.id = 0 preserves imported-card history.
      const reminders = db.prepare(`SELECT at, data_json FROM events WHERE task_id = ?
        AND kind = 'wake_acceptance_repeat' AND id > ? ORDER BY id`).all(task.id, episode.id) as Array<{ at: string; data_json: string }>;
      const count = reminders.length;
      const last = reminders.at(-1);
      if (count >= 2 || (last && ms - Date.parse(last.at) < HALF_HOUR)) continue;
      due.push({ task, entry, count });
    }
    if (!due.length || !leader || !isAgentAlive(leader) || !hasWakeSender()) continue;
    if (ms < (refused.get(project)?.retryAfterMs ?? Number.NEGATIVE_INFINITY)) continue;
    const missing = agentCwdMissing(leader);
    if (missing) {
      noteWakeSkipped(due[0].task.id, leader, missing, "acceptance_repeat");
      continue;
    }
    const text = [
      t("acceptanceWatch.wake.text", { project }),
      leaderActionNote(),
      ...due.map(({ task }) => `${cardMarkOf(task)} ${task.title}`),
    ].join("\n");
    let delivered = false;
    try {
      delivered = await withTimeout(() => deliverWake(leader, text), t("acceptanceWatch.call.wake"));
    } catch (err) {
      console.error("[paseo-kanban] acceptance wake", errorMessage(err));
    }
    waits = loadAcceptanceReviewWaits();
    if (!delivered) {
      noteRefused(project, ms);
      continue;
    }
    refused.delete(project);
    for (const { task, entry, count } of due) {
      const current = getTask(task.id);
      if (current.status !== "acceptance" || acceptanceEntry(current).id !== entry.id) {
        if (current.status !== "acceptance") clearLeaderUnresponsive(project, "left_acceptance", at, {}, task.id);
        continue;
      }
      if (waits.has(task.id)) {
        syncAcceptanceReviewWait(current, waits.get(task.id), entry, at);
        continue;
      }
      appendEvent(task.id, "wake_acceptance_repeat", null, null, "scheduler", {
        project, agentId: leader, fallback: false, repeat: count + 1, acceptanceEventId: entry.id,
        acceptanceAt: entry.at, lastActionAt, cards: due.map(({ task }) => cardMarkOf(task)), taskId: task.id, text: wakeSummary(text),
      }, at);
      // A leader may act while delivery is pending. Do not restore a cleared marker.
      if (getTask(task.id).status !== "acceptance")
        clearLeaderUnresponsive(project, "left_acceptance", at, {}, task.id);
    }
  }
}

// The scheduler may be kicked while a send is pending. A second in-process scan
// must not consume a second repeat; committed delivery events survive restarts.
let scanning = false;
export async function scanAcceptance(options: Parameters<typeof scanAcceptanceOnce>[0] = {}): Promise<void> {
  if (scanning) return;
  scanning = true;
  try { await scanAcceptanceOnce(options); } finally { scanning = false; }
}
