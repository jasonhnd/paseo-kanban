/** Local protection/publication heartbeat. Never a provider sampling cadence. */
export const POOL_TICK_MS = 60_000;
export const POOL_REFRESH_MS = POOL_TICK_MS;
export { QUOTA_SAMPLE_MS, QUOTA_DISPLAY_TTL_MS } from "../../shared/fleet/quota-time";
export const USAGE_TIMEOUT_MS = 30_000;
/** Preserve the existing seven-minute safety expiry independently of the hourly sampler. */
export const LIVE_READING_TTL_MS = 7 * 60_000;
