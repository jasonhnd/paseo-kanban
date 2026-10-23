/// <reference types="node" />
import { join } from "node:path";
import { quotaUnknown, unknownQuotaPolicy, unknownQuotaReason, type QuotaState } from "../../shared/fleet/unknown-quota";
import { readSupervisorTable } from "../../shared/fleet/decisions";
import { t } from "../../shared/fleet/i18n";
import { readRemovedProjects } from "./removed";
import { KANBAN_CONFIG } from "./reset-coupons-types";
import { readJson, STATE_DIR, writeJson, type Json } from "./util";

export const UNKNOWN_QUOTA_NOTICES = join(STATE_DIR, "unknown-quota-notices.json");
type Notify = (agentId: string, text: string) => Promise<void>;
let notifyRef: Notify | null = null;
export function setUnknownQuotaNotify(notify: Notify | null): void { notifyRef = notify; }
interface Notice { sent: string[] }
type Notices = Record<string, Notice>;
let queue: Promise<unknown> = Promise.resolve();

/** Serialize refreshes; persist each successful recipient so failures/restarts retry only unsent leaders. */
export function notifyUnknownQuota(pools: Record<string, QuotaState>, leaders: readonly string[], notify: Notify,
  path = UNKNOWN_QUOTA_NOTICES, now = Date.now()): Promise<void> {
  const next = queue.catch(() => {}).then(async () => {
    const state = await readJson<Notices>(path, {});
    for (const [pool, row] of Object.entries(pools)) {
      if (!quotaUnknown(row, now)) {
        // Only explicit recovery ends an episode; absent compatibility evidence cannot re-arm it.
        if (row.state === "known" && state[pool]) { delete state[pool]; await writeJson(path, state); }
        continue;
      }
      const notice = state[pool] ??= { sent: [] };
      for (const leader of new Set(leaders)) {
        if (notice.sent.includes(leader)) continue;
        try { await notify(leader, t("quota.unknown.notice", { pool, reason: unknownQuotaReason(unknownQuotaPolicy(row.unknownQuota)) })); }
        catch (error) { console.error("[afc] unknown quota: notify failed", String(error).slice(0, 160)); continue; }
        notice.sent.push(leader);
        await writeJson(path, state);
      }
    }
  });
  queue = next;
  return next;
}

/** Called from the heartbeat, including failed refreshes; panel reads never send messages. */
export async function deliverUnknownQuotaNotices(pools: Record<string, QuotaState>, now = Date.now()): Promise<void> {
  if (!notifyRef) return;
  const config = await readJson<Json>(KANBAN_CONFIG, {});
  const removed = readRemovedProjects();
  const leaders = Object.entries(readSupervisorTable(config) ?? {}).filter(([project]) => !removed.has(project))
    .map(([, id]) => id).filter(id => id.length >= 8);
  await notifyUnknownQuota(pools, leaders, notifyRef, UNKNOWN_QUOTA_NOTICES, now);
}
