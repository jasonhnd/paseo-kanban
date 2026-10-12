/// <reference types="node" />
// Sending coupon notices to leaders. A stamp is written only after every recipient got the message.
import { readJson, writeJson, type Json } from "./util";
import { KANBAN_CONFIG, RESET_COUPON_STATE, type ResetCouponState } from "./reset-coupons-types";
import { lock, readState } from "./reset-coupons-state";
import { readOpsProject } from "./adapters/config";
import { readSupervisorTable, supervisorIdFor } from "../../shared/fleet/decisions";

export interface Send {
  who: "afc" | "all";
  text: string;
  /** Marked sent only after every recipient gets this message. */
  keys?: string[];
  legacy?: "use" | "announce";
}

export interface PendingNotify {
  use: boolean;
  announceKey: string | null;
  keys: string[];
}

export interface DeliverResult {
  use: boolean;
  announce: boolean;
  keys: string[];
}

type Notify = (agentId: string, text: string) => Promise<void>;

const DELIVER_ERROR_GAP_MS = 30 * 60_000;

let notifyRef: Notify = async () => {};
let lastDeliverErrorAt = 0;

/** Sends that have not finished. Stamps and notice keys land only after the send succeeds. */
export const inflight = {
  /** True while a use-reminder send has not finished. */
  use: false,
  /** Double-week key whose announce is in flight. Null when none is waiting on a send. */
  announce: null as string | null,
  /** Notice keys whose send has not finished. A failed send is removed so the next round retries. */
  keys: new Set<string>(),
};

export function setNotify(notify: Notify): void {
  notifyRef = notify;
}

async function leaders(): Promise<{ afc: string | null; all: string[] }> {
  const raw = await readJson<Json>(KANBAN_CONFIG, {});
  const supervisors = readSupervisorTable(raw);
  const all = Object.values(supervisors ?? {}).filter(id => id.length >= 8);
  const afc = supervisorIdFor(readOpsProject(), supervisors);
  return { afc: afc && afc.length >= 8 ? afc : null, all: [...new Set(all)] };
}

function deliverError(message: string): void {
  const now = Date.now();
  if (now - lastDeliverErrorAt < DELIVER_ERROR_GAP_MS) return;
  lastDeliverErrorAt = now;
  console.error(message);
}

/** True only when every recipient for that send was notified. A miss leaves the stamp unset so the next round retries. */
export async function deliver(sends: Send[], notify: Notify): Promise<DeliverResult> {
  const ok: DeliverResult = { use: !sends.some((send) => send.legacy === "use"), announce: !sends.some((send) => send.legacy === "announce"), keys: [] };
  if (sends.length === 0) return ok;
  const who = await leaders();
  for (const send of sends) {
    const ids = send.who === "afc" ? (who.afc ? [who.afc] : []) : who.all;
    if (ids.length === 0) {
      deliverError("[afc] reset coupons: kanban.config.json has no <leader> to notify");
      continue;
    }
    let sent = true;
    for (const id of ids) {
      try {
        await notify(id, send.text);
      } catch (error) {
        sent = false;
        deliverError(`[afc] reset coupons: notify failed ${String(error).slice(0, 160)}`);
      }
    }
    if (!sent) continue;
    if (send.legacy === "use") ok.use = true;
    if (send.legacy === "announce") ok.announce = true;
    if (send.keys) ok.keys.push(...send.keys);
  }
  return ok;
}

export function releasePending(pending: PendingNotify): void {
  if (pending.use) inflight.use = false;
  if (pending.announceKey) inflight.announce = null;
  for (const key of pending.keys) inflight.keys.delete(key);
}

export async function saveCouponState(state: ResetCouponState, sends: Send[], pending: PendingNotify, now: number): Promise<void> {
  try {
    await writeJson(RESET_COUPON_STATE, state);
  } catch (error) {
    releasePending(pending);
    throw error;
  }
  queueDeliver(sends, pending, now);
}

/** Stamp the notices that went out. Runs under the state lock. */
async function stampDelivered(pending: PendingNotify, ok: DeliverResult, now: number): Promise<void> {
  if ((pending.use && ok.use) || (pending.announceKey && ok.announce) || ok.keys.length > 0) {
    const state = await readState();
    if (pending.use && ok.use) state.lastUseNotifyAt = new Date(now).toISOString();
    if (pending.announceKey && ok.announce) state.announcedWeekStart = pending.announceKey;
    if (ok.keys.length > 0) {
      const done = new Set(ok.keys);
      state.sentNoticeKeys = [...new Set([...(state.sentNoticeKeys ?? []), ...ok.keys])];
      state.pendingNotices = (state.pendingNotices ?? []).filter((notice) => !done.has(notice.key) && !(notice.mark ?? []).some((key) => done.has(key)));
    }
    await writeJson(RESET_COUPON_STATE, state);
  }
  releasePending(pending);
}

/** Send outside the state lock. Write lastUseNotifyAt / announcedWeekStart only after the send succeeds. */
export function queueDeliver(sends: Send[], pending: PendingNotify, now: number): void {
  if (sends.length === 0) {
    releasePending(pending);
    return;
  }
  void (async () => {
    let ok: DeliverResult = { use: false, announce: false, keys: [] };
    try {
      ok = await deliver(sends, notifyRef);
    } catch (error) {
      deliverError(`[afc] reset coupons: notify failed ${String(error).slice(0, 160)}`);
    }
    await lock(() => stampDelivered(pending, ok, now));
  })();
}
