/// <reference types="node" />
// Remind a <leader>, at most once per day per item, when an open decision is older than 24 hours.
// Speech comes from the leader panel already loaded for this refresh. A failed send retries after 5 minutes.
import { join } from "node:path";
import {
  type CheckItem,
  type CheckSource,
  type CheckStateShape,
  type SpeechDetail,
  checkDigest,
  checkLine,
  planCheckReminders,
  speechForProject,
} from "../../shared/fleet/decision-check";
import { logSwallowed, readJson, sendToAgent, STATE_DIR, writeJson } from "./util";

export const CHECK_STATE = join(STATE_DIR, "decisions-check-state.json");
const KEEP_REMINDED_MS = 14 * 24 * 60 * 60 * 1000;
const KEEP_TRIED_MS = 24 * 60 * 60 * 1000;

export type CheckState = CheckStateShape;
export const EMPTY_CHECK_STATE: CheckState = { reminded: {}, tried: {} };

export interface CheckDeps {
  load(): Promise<CheckState>;
  save(state: CheckState): Promise<void>;
  send(agentId: string, prompt: string): Promise<void>;
  log?(tag: string, error: unknown): void;
}

export interface OpenCheckRequest {
  items: readonly CheckSource[];
  details: readonly SpeechDetail[];
  supervisors: Record<string, string> | null;
  paused: readonly { project: string }[];
  now: number;
}

function prune(map: Record<string, string> | undefined, now: number, maxAge: number): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, at] of Object.entries(map ?? {})) {
    const age = now - Date.parse(at);
    if (Number.isFinite(age) && age >= 0 && age < maxAge) out[id] = at;
  }
  return out;
}

function withSpeech(items: readonly CheckSource[], details: readonly SpeechDetail[]): CheckItem[] {
  return items.map((item) => ({ ...item, speech: speechForProject(item.project, details) }));
}

let running = false;

/** One notice per leader. Never throws. A missing owner is recorded and skipped. */
export async function runOpenDecisionChecks(request: OpenCheckRequest, deps: CheckDeps): Promise<{ sent: string[]; noOwner: string[] }> {
  if (running) return { sent: [], noOwner: [] };
  running = true;
  try {
    const loaded = await deps.load().catch((error) => {
      (deps.log ?? logSwallowed)("decision check load", error);
      return EMPTY_CHECK_STATE;
    });
    const state: CheckState = {
      reminded: prune(loaded.reminded, request.now, KEEP_REMINDED_MS),
      tried: prune(loaded.tried, request.now, KEEP_TRIED_MS),
    };
    const plan = planCheckReminders(withSpeech(request.items, request.details), state, request.now, request.supervisors, request.paused);
    if (plan.noOwner.length > 0) (deps.log ?? logSwallowed)("decision check no owner", plan.noOwner.join(","));
    const groups = new Map<string, typeof plan.rows>();
    for (const row of plan.rows) {
      const list = groups.get(row.agentId) ?? [];
      list.push(row);
      groups.set(row.agentId, list);
    }
    const sent: string[] = [];
    const stamp = new Date(request.now).toISOString();
    for (const [agentId, rows] of groups) {
      try {
        await deps.send(agentId, checkDigest(rows.map(checkLine)));
        for (const row of rows) {
          state.reminded[row.id] = stamp;
          delete state.tried[row.id];
          sent.push(row.id);
        }
      } catch (error) {
        for (const row of rows) state.tried[row.id] = stamp;
        (deps.log ?? logSwallowed)("decision check send", error);
      }
    }
    await deps.save(state).catch((error) => (deps.log ?? logSwallowed)("decision check save", error));
    return { sent, noOwner: plan.noOwner };
  } finally {
    running = false;
  }
}

export function sourcesFromStored(stored: readonly { id?: unknown; project?: unknown; title?: unknown; status?: unknown; createdAt?: unknown }[]): CheckSource[] {
  const out: CheckSource[] = [];
  for (const row of stored) {
    if (typeof row.id !== "string" || !row.id) continue;
    out.push({
      id: row.id,
      project: typeof row.project === "string" ? row.project : "",
      title: typeof row.title === "string" ? row.title : "",
      status: typeof row.status === "string" ? row.status : "",
      createdAt: typeof row.createdAt === "string" ? row.createdAt : "",
    });
  }
  return out;
}

export function productionCheckDeps(): CheckDeps {
  return {
    load: async () => ({ ...EMPTY_CHECK_STATE, ...(await readJson<Partial<CheckState>>(CHECK_STATE, {})) }),
    save: (state) => writeJson(CHECK_STATE, state),
    send: async (agentId, prompt) => { await sendToAgent(agentId, prompt); },
  };
}
