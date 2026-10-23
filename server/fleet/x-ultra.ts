import { resolveXUltraReading, X_ULTRA } from "../../shared/fleet/x-ultra";
import { QUOTA_SAMPLE_MS } from "../../shared/fleet/quota-time";
import type { UsageWindow } from "../../shared/fleet/usage";
import type { CursorUsageReading } from "./cursor-usage";

/** Only the explicitly labelled Grok row belongs to the shared week. Never Auto/Included/API. */
export function reconcileXUltraWindow(grok: UsageWindow, cursor: CursorUsageReading | null, now: number, provider?: UsageWindow): UsageWindow {
  const cursorGrok = (cursor?.grokOk ?? cursor?.ok) && !cursor.loggedOut && !cursor.linkBroken && !cursor.awaitingSample
    ? cursor.windows.find(w => /^grok$/i.test(w.label.trim())) : undefined;
  const grokSources = [grok, ...(provider ? [provider] : [])].map(window => ({
    usedPct: window.readError || window.readingState === "stale" || window.readingState === "unknown" ? null : window.usedPct,
    resetsAt: window.resetsAt, observedAt: window.source === "manual" ? window.manualAt : window.sampledAt ?? window.collectedAt ?? null,
  }));
  const selected = resolveXUltraReading([
    ...grokSources,
    { usedPct: cursorGrok?.usedPct ?? null, resetsAt: cursorGrok?.resetsAt ?? null, observedAt: cursor?.readAt ?? null },
  ], now);
  const reset = selected.resetsAt;
  return { ...grok, id: "weekly", label: "Weekly", primary: true, cycleKind: "week", pool: X_ULTRA,
    source: "provider", manualAt: null, usedPct: selected.usedPct, resetsAt: reset,
    startsAt: reset ? new Date(Date.parse(reset) - 7 * 86_400_000).toISOString() : null,
    sampledAt: selected.observedAt, collectedAt: selected.observedAt, sourceTimeKind: selected.observedAt ? "source" : "unknown",
    readingExpiresAt: selected.observedAt ? new Date(Date.parse(selected.observedAt) + 2 * QUOTA_SAMPLE_MS).toISOString() : null,
    readError: selected.reason, readingState: selected.state === "known" ? "live" : "unknown",
    elapsedPct: null, projectedPct: null, runsOutAt: null, verdict: "unknown", fullWindowUsd: null,
    knownQuotaStop: grok.resetsAt && Date.parse(grok.resetsAt) > now ? grok.knownQuotaStop : null,
    paceEligible: selected.state === "known" };
}
