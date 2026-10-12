import { loadConfig, projectSupervisor, type KanbanConfig } from "./config";
import { getDb } from "./db";
import { findAgentFile } from "./open";

/** One line of the by-project tab. Counts ignore archived cards and the project filter. */
export interface ProjectRow {
  project: string;
  running: number;
  acceptance: number;
  blocked: number;
  waiting: number;
  done: number;
  leaderAgentId: string | null;
  leaderTitle: string | null;
  /** Newest event on this project's cards written by the registered leader. Null if none. */
  lastLeaderActionAt: string | null;
}

const RUNNING = new Set(["running", "in_review", "reviewing", "rework"]);
const WAITING = new Set(["triage", "draft", "waiting", "ready"]);

function emptyRow(project: string): ProjectRow {
  return { project, running: 0, acceptance: 0, blocked: 0, waiting: 0, done: 0, leaderAgentId: null, leaderTitle: null, lastLeaderActionAt: null };
}

/** Newest event per [project, actor] for the supervisor actor and the given leaders, in one pass over those events. */
function lastActionsByProject(leaders: string[]): Map<string, Map<string, string>> {
  const marks = leaders.map(() => "?").join(", ");
  const rows = getDb()
    .prepare(
      `SELECT t.project AS project, e.actor AS actor, MAX(e.at) AS at FROM events e JOIN tasks t ON t.id = e.task_id
       WHERE e.actor IN ('supervisor', ''${leaders.length > 0 ? `, ${marks}` : ""}) GROUP BY t.project, e.actor`,
    )
    .all(...leaders) as unknown as Array<{ project: string; actor: string; at: string }>;
  const out = new Map<string, Map<string, string>>();
  for (const row of rows) {
    const byActor = out.get(row.project) ?? new Map<string, string>();
    byActor.set(row.actor, row.at);
    out.set(row.project, byActor);
  }
  return out;
}

function lastLeaderAction(byActor: Map<string, string> | undefined, leader: string | null): string | null {
  const times = ["supervisor", leader ?? ""].map((actor) => byActor?.get(actor) ?? null).filter((at): at is string => at !== null);
  return times.length > 0 ? times.reduce((a, b) => (a > b ? a : b)) : null;
}

export function projectRows(config: KanbanConfig = loadConfig()): ProjectRow[] {
  const counts = getDb()
    .prepare(`SELECT project, status, COUNT(*) AS n FROM tasks WHERE status <> 'archived' GROUP BY project, status`)
    .all() as unknown as Array<{ project: string; status: string; n: number }>;
  const rows = new Map<string, ProjectRow>();
  for (const { project, status, n } of counts) {
    const row = rows.get(project) ?? emptyRow(project);
    if (RUNNING.has(status)) row.running += n;
    else if (WAITING.has(status)) row.waiting += n;
    else if (status === "acceptance") row.acceptance += n;
    else if (status === "blocked") row.blocked += n;
    else if (status === "done") row.done += n;
    rows.set(project, row);
  }
  for (const project of Object.keys(config.supervisors)) if (!rows.has(project)) rows.set(project, emptyRow(project));
  const leaders = [...rows.keys()].map((project) => projectSupervisor(project, config)).filter((leader): leader is string => leader !== null);
  const actions = lastActionsByProject([...new Set(leaders)]);
  return [...rows.values()]
    .map((row) => {
      const leader = projectSupervisor(row.project, config);
      const file = leader ? findAgentFile(leader) : null;
      return {
        ...row,
        leaderAgentId: leader,
        leaderTitle: leader ? file?.title.trim() || leader.slice(0, 8) : null,
        lastLeaderActionAt: lastLeaderAction(actions.get(row.project), leader),
      };
    })
    .sort((a, b) => a.project.localeCompare(b.project));
}
