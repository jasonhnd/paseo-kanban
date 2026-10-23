/// <reference types="node" />
import { deliverPoolExhaustionNotices } from "./pool-exhaustion";
import type { RankingPool } from "../../shared/fleet/pool-ranking";
// Keeps pool-status.json fresh for Paseo Kanban even when nobody has AFC open (docs/KANBAN-CONTRACT.md §1).
// Plugin code only gets a Paseo handle inside RPC handlers and hooks, and a plugin reload or daemon restart
// drops it. Until 09-27 the timer then skipped every run without a word and the snapshot stood still.
// Now the timer falls back to its own connection to the local daemon and logs every failure.
import type { PaseoApi } from "./paseo-api";
import { createPaseoClient } from "./paseo-client.bundle.mjs";
import { deliverUnknownQuotaNotices } from "./unknown-quota";
import { stat } from "node:fs/promises";
import { CONFIG, type Json, readJson } from "./util";
import { POOL_STATUS } from "./pools";
import { PLANS, refreshPoolStatus } from "./usage";
import { POOL_REFRESH_MS, POOL_TICK_MS } from "./quota-timing";
export { POOL_REFRESH_MS } from "./quota-timing";

/** How often the timer looks; a changed plans.json is picked up within this. */
const TICK_MS = POOL_TICK_MS;
const DEFAULT_LISTEN = "127.0.0.1:6767";
const CONNECT_TIMEOUT_MS = 10_000;

/**
 * Whether the snapshot should be rewritten now: never written, older than POOL_REFRESH_MS,
 * or plans.json changed after it was written. Writes by the quota page count too.
 */
export function poolRefreshDue(now: number, snapshotAt: number | null, plansChangedAt: number | null): boolean {
  if (snapshotAt === null) return true;
  if (now - snapshotAt >= POOL_REFRESH_MS) return true;
  return plansChangedAt !== null && plansChangedAt > snapshotAt;
}

async function mtime(path: string): Promise<number | null> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return null;
  }
}

async function snapshotTime(): Promise<number | null> {
  const at = (await readJson<Json>(POOL_STATUS, {})).generatedAt;
  const t = typeof at === "string" ? Date.parse(at) : Number.NaN;
  return Number.isNaN(t) ? null : t;
}

async function daemonUrl(): Promise<string> {
  const listen = (await readJson<Json>(CONFIG, {}))?.daemon?.listen;
  return `ws://${typeof listen === "string" && listen.includes(":") ? listen : DEFAULT_LISTEN}/ws`;
}

/** One-off connection to the local daemon, the same way tmp/pool-refresh.mts does it by hand. Closed afterwards. */
export async function withOwnDaemonClient<T>(clientId: string, work: (paseo: PaseoApi) => Promise<T>): Promise<T> {
  const client = createPaseoClient({ url: await daemonUrl(), clientId, connectTimeoutMs: CONNECT_TIMEOUT_MS, reconnect: { enabled: false } });
  try {
    await client.connect();
    return await work(client);
  } finally {
    await client.close().catch(() => {});
  }
}

async function refreshWithOwnClient(): Promise<void> {
  await withOwnDaemonClient("afc-pool-refresh", refreshPoolStatus);
}

let requestKick: (() => void) | null = null;

/** Rewrite pool-status now. No-op until startPoolRefresh is running. */
export function requestPoolRefreshNow(): void {
  requestKick?.();
}

export function startPoolRefresh(handle: () => PaseoApi | null, options: { allowOwnClient?: boolean } = {}): () => void {
  let running = false;
  let queued = false;
  let closed = false;
  let lastPath: "handle" | "own" | null = null;
  const note = (path: "handle" | "own") => {
    if (path !== lastPath) console.log(`[afc] pool refresh: ${path === "handle" ? "refreshing with the Paseo handle from the plugin" : "no Paseo handle available, refreshing over our own connection to the local daemon"}`);
    lastPath = path;
  };
  const tick = async (force = false) => {
    if (closed) return;
    if (running) {
      if (force) queued = true;
      return;
    }
    running = true;
    try {
      const [snapAt, plansAt] = await Promise.all([snapshotTime(), mtime(PLANS)]);
      if (!force && !poolRefreshDue(Date.now(), snapAt, plansAt)) return;
      const paseo = handle();
      if (paseo) {
        try {
          await refreshPoolStatus(paseo);
          note("handle");
          return;
        } catch (e) {
          console.error("[afc] pool refresh: refresh with the plugin handle failed, falling back to our own daemon connection:", String(e).slice(0, 200));
        }
      }
      if (options.allowOwnClient === false) throw new Error("Unified host handle is unavailable; policy remains fail-closed");
      await refreshWithOwnClient();
      note("own");
    } catch (e) {
      console.error("[afc] pool refresh: refresh failed, the quota snapshot was not updated this round:", String(e).slice(0, 300));
    } finally {
      try {
        const file = await readJson<{ pools?: Record<string, RankingPool> }>(POOL_STATUS, {});
        await deliverUnknownQuotaNotices(file.pools ?? {});
        await deliverPoolExhaustionNotices(file.pools ?? {});
      } catch (error) { console.error("[afc] unknown quota:", String(error).slice(0, 160)); }
      running = false;
      if (!closed && queued) {
        queued = false;
        void tick(true);
      }
    }
  };
  requestKick = () => {
    void tick(true);
  };
  const first = setTimeout(() => void tick(), 5_000);
  const timer = setInterval(() => void tick(), TICK_MS);
  return () => {
    closed = true;
    requestKick = null;
    clearTimeout(first);
    clearInterval(timer);
  };
}
