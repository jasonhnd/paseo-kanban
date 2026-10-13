/// <reference types="node" />
import { listAgentRecords } from "./agent-index";
import { t } from "../shared/i18n";
import { getDb } from "./db";
import { agentsDir, readAgentRecord } from "./open";
import { samePath } from "./placement";
import { appendEvent, getTask, type TaskRow } from "./store";

/**
 * How long startTask waits for agents.create before it looks for the agent the
 * daemon may already have written. A dropped websocket (close 1006) can leave
 * the daemon's create finished and the caller's promise unsettled.
 */
const DEFAULT_CREATE_RECOVER_MS = 15_000;

export function createRecoverAfterMs(): number {
  const raw = process.env.KANBAN_CREATE_RECOVER_MS;
  if (raw != null && raw.trim() !== "") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return DEFAULT_CREATE_RECOVER_MS;
}

/**
 * Clock slack between this process and the daemon that stamps createdAt. A
 * record created this long before the claim still counts as this start's.
 */
export const CREATE_CLOCK_SKEW_MS = 5_000;

/** Written right after a start claims the card, before agents.create. */
export const AGENT_CREATING = "agent_creating";

/** What a start already decided before create. A recovered binding reuses it. */
export interface CreatingRecord {
  role: string;
  profile: string;
  family: string | null;
  provider: string;
  model: string | null;
  autoAccept: number;
  effort: string | null;
}

export interface CreatingClaim extends CreatingRecord {
  at: string;
}

/** The newest pre-create record for this card and role, or null for a card started before it existed. */
export function latestCreating(taskId: number, role: string): CreatingClaim | null {
  const row = getDb()
    .prepare("SELECT at, data_json FROM events WHERE task_id = ? AND kind = ? AND json_extract(data_json, '$.role') = ? ORDER BY id DESC LIMIT 1")
    .get(taskId, AGENT_CREATING, role) as { at: string; data_json: string } | undefined;
  if (!row) return null;
  let data: Partial<CreatingRecord>;
  try {
    data = JSON.parse(row.data_json) as Partial<CreatingRecord>;
  } catch {
    return null;
  }
  if (typeof data.profile !== "string") return null;
  return {
    at: row.at,
    role,
    profile: data.profile,
    family: typeof data.family === "string" && data.family ? data.family : null,
    provider: typeof data.provider === "string" ? data.provider : "",
    model: typeof data.model === "string" ? data.model : null,
    autoAccept: data.autoAccept === 1 ? 1 : 0,
    effort: typeof data.effort === "string" ? data.effort : null,
  };
}

function createdSince(createdAt: string | null, since: string | null): boolean {
  if (!since) return true;
  const floor = Date.parse(since);
  if (!Number.isFinite(floor)) return true;
  const created = createdAt ? Date.parse(createdAt) : Number.NaN;
  // A record without a creation time cannot prove it belongs to this start.
  if (!Number.isFinite(created)) return false;
  return created >= floor - CREATE_CLOCK_SKEW_MS;
}

export interface LostAgent {
  id: string;
  cwd: string;
  workspaceId: string | null;
  provider: string;
  model: string | null;
  createdAt: string | null;
}

/**
 * Unit tests that do not point KANBAN_AGENTS_DIR at a fixture must not scan
 * the real ~/.paseo/agents directory. Production always scans.
 */
function scanEnabled(): boolean {
  if (process.env.KANBAN_AGENTS_DIR) return true;
  return !process.env.NODE_TEST_CONTEXT;
}

/**
 * Live kanban agents labeled for this card. `unreadable` means the agents
 * root could not be listed, so a missing id is not proof the agent was never
 * opened. A single bad file is skipped. `since` is the claim time of this
 * start: an older live agent (one an earlier start never recorded) is not
 * this start's create result.
 */
export function findLostCardAgents(taskId: number, role: string, cwd: string | null, since: string | null = null): LostAgent[] | "unreadable" {
  if (!scanEnabled()) return [];
  const records = listAgentRecords(agentsDir());
  if (records == null) return "unreadable";
  const found: LostAgent[] = [];
  for (const { id } of records) {
    const read = readAgentRecord(id);
    if (read.state !== "ok") continue;
    const file = read.file;
    if (file.archivedAt) continue;
    if (file.lastStatus === "closed" || file.lastStatus === "error") continue;
    const kanban = file.labels.kanban;
    if (kanban !== "1" && kanban !== "true") continue;
    if (file.labels.kanban_task !== String(taskId)) continue;
    const labelRole = file.labels.role;
    if (labelRole && labelRole !== role) continue;
    if (cwd && file.cwd && !samePath(file.cwd, cwd)) continue;
    if (!createdSince(file.createdAt, since)) continue;
    found.push({
      id: file.id,
      cwd: file.cwd,
      workspaceId: file.workspaceId,
      provider: file.provider,
      model: file.model,
      createdAt: file.createdAt,
    });
  }
  found.sort((left, right) => left.id.localeCompare(right.id));
  return found;
}

function noteOnce(taskId: number, kind: string, data: Record<string, unknown>, at: string): void {
  const latest = getDb()
    .prepare("SELECT kind FROM events WHERE task_id = ? AND kind IN (?, 'agent_opened', 'reclaimed', 'started') ORDER BY id DESC LIMIT 1")
    .get(taskId, kind) as { kind: string } | undefined;
  if (latest?.kind === kind) return;
  appendEvent(taskId, kind, null, null, "scheduler", data, at);
}

function adopt(task: TaskRow, agent: LostAgent, role: string, claim: CreatingClaim | null, now: Date): boolean {
  const ts = now.toISOString();
  const db = getDb();
  // Without a pre-create record (a card started before it existed) keep what the card already has.
  const profile = claim?.profile ?? null;
  const family = claim?.family ?? null;
  const bound = role === "reviewer"
    ? db.prepare(`UPDATE tasks SET agent_id = ?, updated_at = ?, hold_reason = NULL, nudge_count = 0,
        blocked_kind = NULL, blocked_reason = NULL, blocked_from = NULL, blocked_at = NULL, cooldown_until = NULL
        WHERE id = ? AND status = ? AND agent_id IS NULL`).run(agent.id, ts, task.id, task.status)
    : db
        .prepare(
          `UPDATE tasks SET agent_id = ?, executor_agent_id = ?,
             executor_profile = COALESCE(?, executor_profile), executor_family = COALESCE(?, executor_family), updated_at = ?,
             hold_reason = NULL, nudge_count = 0, blocked_kind = NULL, blocked_reason = NULL,
             blocked_from = NULL, blocked_at = NULL, cooldown_until = NULL
           WHERE id = ? AND status = ? AND agent_id IS NULL`,
        )
        .run(agent.id, agent.id, profile, family, ts, task.id, task.status);
  if (bound.changes !== 1) return Boolean(getTask(task.id).agent_id);
  db.prepare("UPDATE tokens SET agent_id = ? WHERE task_id = ? AND role = ? AND agent_id IS NULL").run(agent.id, task.id, role);
  const openRun = db.prepare("SELECT id FROM runs WHERE task_id = ? AND agent_id = ? AND ended_at IS NULL").get(task.id, agent.id);
  if (!openRun) {
    db.prepare(
      `INSERT INTO runs (task_id, agent_id, role, profile_name, provider, model, family, auto_accept, thinking_option_id, effort, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      task.id, agent.id, role, profile, agent.provider || claim?.provider || null, agent.model ?? claim?.model ?? null, family,
      claim?.autoAccept ?? 0, claim?.effort ?? null, claim?.effort ?? null, ts,
    );
  }
  appendEvent(task.id, "agent_opened", null, null, "scheduler", {
    agentId: agent.id,
    recovered: "lost_create_response",
    cwd: agent.cwd || null,
    profile,
  }, ts);
  return true;
}

/**
 * A running card whose agent id was never written. Bind the one live record
 * for this card, or leave it running when the directory cannot be read or
 * more than one record matches. `absent` means reclaim may proceed.
 */
export function recoverLostCreate(taskId: number, now: Date): "adopted" | "ambiguous" | "unreadable" | "absent" {
  const task = getTask(taskId);
  if ((task.status !== "running" && task.status !== "reviewing") || task.agent_id) return "absent";
  const role = task.status === "reviewing" ? "reviewer" : task.role;
  const claim = latestCreating(taskId, role);
  const found = findLostCardAgents(taskId, role, task.workspace_path, claim?.at ?? null);
  const at = now.toISOString();
  if (found === "unreadable") {
    noteOnce(taskId, "agent_recover_unreadable", { reason: t("lostAgent.unreadable") }, at);
    return "unreadable";
  }
  if (found.length > 1) {
    noteOnce(taskId, "agent_recover_ambiguous", { agentIds: found.map((agent) => agent.id) }, at);
    return "ambiguous";
  }
  if (found.length === 0) return "absent";
  return adopt(task, found[0]!, role, claim, now) ? "adopted" : "absent";
}
