/// <reference types="node" />
import { join } from "node:path";
import { poolWillRunOut, type RankingPool } from "../../shared/fleet/pool-ranking";
import { readSupervisorTable } from "../../shared/fleet/decisions";
import { t } from "../../shared/fleet/i18n";
import { readRemovedProjects } from "./removed";
import { KANBAN_CONFIG } from "./reset-coupons-types";
import { readJson, STATE_DIR, writeJson, type Json } from "./util";

export const POOL_EXHAUSTION_NOTICES = join(STATE_DIR, "pool-exhaustion-notices.json");
type Notify = (agentId: string, text: string) => Promise<void>;
let notifyRef: Notify | null = null;
export function setPoolExhaustionNotify(notify: Notify | null): void { notifyRef = notify; }
type Notices = Record<string, { reset: string; sent: string[] }>;
let queue: Promise<unknown> = Promise.resolve();

/** One notice per pool/reset/leader, including across refreshes and restarts; retry only failed recipients. */
export function notifyPoolExhaustion(pools: Record<string, RankingPool>, leaders: readonly string[], notify: Notify,
  path = POOL_EXHAUSTION_NOTICES, now = Date.now()): Promise<void> {
  const next = queue.catch(() => {}).then(async () => {
    const state = await readJson<Notices>(path, {});
    for (const [pool, row] of Object.entries(pools)) {
      if (!row.dispatchable || !poolWillRunOut(row, now)) continue;
      const reset = new Date(Date.parse(row.resetsAt!)).toISOString();
      const notice = state[pool]?.reset === reset ? state[pool] : state[pool] = { reset, sent: [] };
      for (const leader of new Set(leaders)) {
        if (notice.sent.includes(leader)) continue;
        try { await notify(leader, t("quota.ranking.notice", { pool, reset })); }
        catch (error) { console.error("[afc] pool exhaustion: notify failed", String(error).slice(0, 160)); continue; }
        notice.sent.push(leader);
        await writeJson(path, state);
      }
    }
  });
  queue = next;
  return next;
}

/** Heartbeat only, using the same registered project leaders as unknown-quota warnings. */
export async function deliverPoolExhaustionNotices(pools: Record<string, RankingPool>, now = Date.now()): Promise<void> {
  if (!notifyRef) return;
  const config = await readJson<Json>(KANBAN_CONFIG, {});
  const removed = readRemovedProjects();
  const leaders = Object.entries(readSupervisorTable(config) ?? {}).filter(([project]) => !removed.has(project))
    .map(([, id]) => id).filter(id => id.length >= 8);
  await notifyPoolExhaustion(pools, leaders, notifyRef, POOL_EXHAUSTION_NOTICES, now);
}
