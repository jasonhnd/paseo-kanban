import { tAll, type MessageKey } from "./i18n";

export const LEVEL_RANK = { red: 0, yellow: 1, info: 2 } as const;

/** Alert kinds pinned above the rest: Cursor logged out, Claude coupon expiring, ChatGPT coupon. Same keys as the producers. */
export const PINNED_ALERT_KINDS: readonly MessageKey[] = ["pools.alerts.kind.loggedOut", "coupons.alerts.claudeExpiringKind", "coupons.alerts.codexKind"];

export function rankAlerts<T extends { level: keyof typeof LEVEL_RANK }>(alerts: readonly T[]): T[] {
  return alerts
    .map((alert, index) => ({ alert, index }))
    .sort((a, b) => LEVEL_RANK[a.alert.level] - LEVEL_RANK[b.alert.level] || a.index - b.index)
    .map((row) => row.alert);
}

export function splitAlerts<T extends { level: string; kind: string }>(ranked: readonly T[]): { reds: T[]; login: T[]; rest: T[] } {
  const pinned = new Set<string>(PINNED_ALERT_KINDS.flatMap((key) => tAll(key)));
  return {
    reds: ranked.filter((alert) => alert.level === "red"),
    login: ranked.filter((alert) => alert.level !== "red" && pinned.has(alert.kind)),
    rest: ranked.filter((alert) => alert.level !== "red" && !pinned.has(alert.kind)),
  };
}
