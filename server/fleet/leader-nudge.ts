/// <reference types="node" />
// Nudge a <leader> once when it asked the user something in chat and never registered it.
// State is on disk so a plugin restart neither resets the 10-minute clock nor re-sends.
import { join } from "node:path";
import type { LeaderDetail } from "../../shared/fleet/leader-panel";
import { withoutPaused } from "../../shared/fleet/paused";
import { NUDGE_AFTER_MS, nudgePrompt } from "../../shared/fleet/leader-week";
import { BIN, logSwallowed, readJson, run, STATE_DIR, writeJson, sendToAgent } from "./util";

export const NUDGE_STATE = join(STATE_DIR, "afc-leader-nudge.json");
const RETRY_AFTER_MS = 5 * 60_000;
const KEEP_SENT_MS = 14 * 86_400_000;

export interface NudgeState { firstSeen: Record<string, string>; sent: Record<string, string>; tried: Record<string, string> }
export interface NudgeDeps {
  load(): Promise<NudgeState>;
  save(state: NudgeState): Promise<void>;
  send(agentId: string, prompt: string): Promise<void>;
}
export const EMPTY_NUDGE_STATE: NudgeState = { firstSeen: {}, sent: {}, tried: {} };
const nudgeKey = (d: LeaderDetail) => `${d.project.toLowerCase()}|${d.question!.at}`;
const age = (iso: string | undefined, now: number) => iso ? now - Date.parse(iso) : Infinity;

let running = false;
/** Returns the keys nudged in this pass. Never throws; a failed send is retried after 5 minutes. */
export async function runLeaderNudges(details: readonly LeaderDetail[], now: number, deps: NudgeDeps, paused: readonly { project: string }[] = []): Promise<string[]> {
  if (running) return [];
  running = true;
  try {
    const state = await deps.load().catch((error) => {
      logSwallowed("leader nudge load", error);
      return EMPTY_NUDGE_STATE;
    });
    // A paused project's <leader> is never nudged; its clock is dropped like an answered question.
    const live = withoutPaused(details, paused).filter((d) => d.question);
    const liveKeys = new Set(live.map(nudgeKey));
    // A question that is gone (answered, registered, superseded) no longer needs its clock.
    // A failed timeline read (activityWarning) says nothing about the question, so its clock is kept.
    const unreadable = new Set(details.filter((d) => d.activityWarning).map((d) => d.project.toLowerCase()));
    const keep = (k: string) => liveKeys.has(k) || unreadable.has(k.slice(0, k.lastIndexOf("|")));
    const firstSeen = Object.fromEntries(Object.entries(state.firstSeen).filter(([k]) => keep(k)));
    const sent = Object.fromEntries(Object.entries(state.sent).filter(([, at]) => age(at, now) < KEEP_SENT_MS));
    const tried = Object.fromEntries(Object.entries(state.tried).filter(([k]) => keep(k)));
    const done: string[] = [];
    for (const d of live) {
      const key = nudgeKey(d);
      if (sent[key]) continue;
      firstSeen[key] ??= new Date(now).toISOString();
      if (age(firstSeen[key], now) < NUDGE_AFTER_MS || age(tried[key], now) < RETRY_AFTER_MS) continue;
      tried[key] = new Date(now).toISOString();
      try {
        await deps.send(d.agentId, nudgePrompt(d.question!.text));
        sent[key] = new Date(now).toISOString();
        done.push(key);
      } catch (error) {
        logSwallowed("leader nudge send (retry later)", error);
      }
    }
    await deps.save({ firstSeen, sent, tried }).catch((error) => logSwallowed("leader nudge save", error));
    return done;
  } finally { running = false; }
}

export function productionNudgeDeps(): NudgeDeps {
  return {
    load: async () => ({ ...EMPTY_NUDGE_STATE, ...(await readJson<Partial<NudgeState>>(NUDGE_STATE, {})) }),
    save: (state) => writeJson(NUDGE_STATE, state),
    send: async (agentId, prompt) => { await sendToAgent(agentId, prompt); },
  };
}
