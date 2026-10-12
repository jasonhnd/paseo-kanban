/// <reference types="node" />
// Overview reminders derived from the quota snapshot: a stale file, a failed usage read, or a block that is spent.
import { cursorLoggedOut, isCursorScreenOffNotice, cursorLoginAlarmText, cursorReconnectAlarmText } from "../../shared/fleet/quota-companies";
import { msgLoginLost } from "./cursor-usage";
import { t, tAll, type MessageKey } from "../../shared/fleet/i18n";
import { tokyoLabel } from "./pools-pace";

/** The snapshot is written every 5 minutes; older than this, the overview raises an alarm. */
export const POOL_STALE_MINUTES = 15;

/** Overview alarm when a usage read was attempted and failed, or AFC's Cursor login can no longer refresh. */
export function cursorReadAlarm(read: { ok?: unknown; manualAt?: unknown; loggedOut?: unknown; error?: unknown; linkBroken?: unknown; alarm?: unknown; screenRead?: unknown } | null | undefined): string | null {
  if (!read) return null;
  const at = typeof read.manualAt === "string" ? tokyoLabel(read.manualAt) : "";
  const when = at && at !== t("pools.pace.reset") ? at : t("pools.alerts.noCopyTime");
  if (read.linkBroken === true || errorHas(read.error, "cursor.api.reconnect")) {
    return cursorReconnectAlarmText();
  }
  if (typeof read.alarm === "string" && read.alarm) return read.alarm;
  if (read.ok !== false) return null;
  return failedReadAlarm(read, when);
}

function failedReadAlarm(read: { loggedOut?: unknown; error?: unknown; screenRead?: unknown }, when: string): string | null {
  if (errorHas(read.error, "cursor.api.network")) return t("pools.alerts.cursorOfficialNetwork", { when });
  if (errorHas(read.error, "cursor.api.format")) return t("pools.alerts.cursorOfficialFormat", { when });
  if (cursorLoggedOut(read)) return cursorLoginAlarmText(when);
  const error = typeof read.error === "string" ? read.error : "";
  if (read.screenRead === false && (error === "" || isCursorScreenOffNotice(error))) return null;
  return t("pools.alerts.cursorReadFailed", { when });
}

/**
 * The text contains the sentence the producer wrote for `source`, in any language (a stored reading may predate a
 * language switch). Templates are cut at their first placeholder, so a filled-in sentence still matches.
 */
function errorHas(error: unknown, source: MessageKey): boolean {
  if (typeof error !== "string") return false;
  const heads = tAll(source).map((text) => text.split(/\{\w+\}/)[0].trim()).filter(Boolean);
  return heads.some((head) => error.includes(head));
}

/** Overview alarm text when the snapshot has not been rewritten for POOL_STALE_MINUTES; null when fresh. */
export function poolSnapshotStale(generatedAt: string | null | undefined, now: number): string | null {
  const at = generatedAt ? Date.parse(generatedAt) : Number.NaN;
  if (Number.isNaN(at)) return t("pools.alerts.snapshotMissing");
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < POOL_STALE_MINUTES) return null;
  return t("pools.alerts.snapshotStale", { minutes });
}

export interface PoolAlert {
  level: "red" | "yellow";
  kind: string;
  text: string;
}

interface AlertFile {
  generatedAt?: unknown;
  pools?: Record<string, { usedPct?: unknown }>;
  cursorRead?: { ok?: unknown; manualAt?: unknown };
  supergrokRead?: { alarm?: unknown; loginLost?: unknown; loginAlarm?: unknown };
}

/**
 * Overview alarms from pool-status.json: the snapshot stopped updating, Cursor's models block is used up,
 * or the automatic `/usage` read failed and dispatch fell back to the hand-copied percentage.
 * `cursorPools`: pool ids read by the cursor-api adapter (shared/quota-adapters.ts poolIdsOf).
 */
export function poolAlerts(file: AlertFile | null, now: number, cursorPools: readonly string[] = []): PoolAlert[] {
  const stale = poolSnapshotStale(typeof file?.generatedAt === "string" ? file.generatedAt : null, now);
  const failed = cursorReadAlarm(file?.cursorRead);
  return [
    ...(stale ? [{ level: "yellow" as const, kind: t("pools.alerts.kind.snapshotStale"), text: stale }] : []),
    ...(failed ? [cursorAlert(failed)] : []),
    ...grokAlerts(file?.supergrokRead),
    ...cursorPools.flatMap((id) => spentCursorAlert(file?.pools?.[id])),
  ];
}

type CursorAlertKind = "disconnected" | "filePermission" | "notWrittenBack" | "loginUnreadable" | "notWritten" | "loggedOut" | "networkFailure" | "formatChanged";

/** Alert kind (`pools.alerts.kind.<kind>`) by the sentence that raised it. Order matters: first hit wins. */
const CURSOR_ALERT_SOURCES: ReadonlyArray<readonly [kind: CursorAlertKind, source: MessageKey]> = [
  ["disconnected", "quota.companies.cursorReconnect"],
  ["filePermission", "cursor.token.mode"],
  ["notWrittenBack", "cursor.token.save"],
  ["loginUnreadable", "cursor.token.unreadable"],
  ["notWritten", "cursor.token.write"],
  ["loggedOut", "quota.companies.cursorLoginAlarm"],
  ["networkFailure", "pools.alerts.cursorOfficialNetwork"],
  ["formatChanged", "pools.alerts.cursorOfficialFormat"],
];

function cursorAlert(failed: string): PoolAlert {
  if (failed.includes(msgLoginLost())) return { level: "red", kind: t("pools.alerts.kind.cursorLoginLost"), text: failed };
  const hit = CURSOR_ALERT_SOURCES.find(([, source]) => errorHas(failed, source))?.[0];
  return { level: "yellow", kind: hit ? t(`pools.alerts.kind.${hit}`) : t("pools.alerts.kind.cursorReadFailed"), text: failed };
}

function grokAlerts(grok: AlertFile["supergrokRead"]): PoolAlert[] {
  const lost = grok?.loginLost === true ? [grokLoginAlert(grok)] : [];
  const alarm = typeof grok?.alarm === "string" && grok.alarm
    ? [{ level: "yellow" as const, kind: t("pools.alerts.kind.grokUnread"), text: grok.alarm }]
    : [];
  return [...lost, ...alarm];
}

function grokLoginAlert(grok: { loginAlarm?: unknown }): PoolAlert {
  const text = typeof grok.loginAlarm === "string" && grok.loginAlarm
    ? grok.loginAlarm
    : t("pools.alerts.grokLoginLost");
  return { level: "red", kind: t("pools.alerts.kind.grokLoginLost"), text };
}

function spentCursorAlert(cursor: { usedPct?: unknown } | undefined): PoolAlert[] {
  if (!cursor || typeof cursor.usedPct !== "number" || cursor.usedPct < 100) return [];
  return [{
    level: "red",
    kind: t("pools.alerts.kind.overPlan"),
    text: t("pools.alerts.cursorSpent", { pct: Math.round(cursor.usedPct) }),
  }];
}
