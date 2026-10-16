import { getLanguage, t, type MessageKey } from "./i18n";
import { startsWithMessage } from "./labels";

export const BLOCKED_KINDS = ["dependency", "needs_human", "capability", "quota", "rate_limit", "transient", "scheduled"] as const;
export type BlockedKind = (typeof BLOCKED_KINDS)[number];

const BLOCKED_KIND_LABEL_KEYS: Readonly<Record<BlockedKind, MessageKey>> = {
  dependency: "blocked.kind.dependency",
  needs_human: "blocked.kind.needsHuman",
  capability: "blocked.kind.capability",
  quota: "blocked.kind.quota",
  rate_limit: "blocked.kind.rateLimit",
  transient: "blocked.kind.transient",
  scheduled: "blocked.kind.scheduled",
};

export function isBlockedKind(kind: string): kind is BlockedKind {
  return (BLOCKED_KINDS as readonly string[]).includes(kind);
}

export function blockedKindLabel(kind: string | null | undefined): string {
  if (kind && isBlockedKind(kind)) return t(BLOCKED_KIND_LABEL_KEYS[kind]);
  return kind ? kind : "";
}

/**
 * Shown on a card that is waiting for a pool, not blocked: "Waiting for quota: <pool> / <reason>".
 * The text is stored as the card's hold reason, so the check accepts the prefix in every language
 * (rows written in Chinese before i18n included).
 */
export function isQuotaWaitReason(reason: string | null | undefined): boolean {
  return Boolean(reason && startsWithMessage(reason, "blocked.prefix.quota"));
}

/**
 * "Waiting for quota: <pool> / <reason>". Several pools are joined by the caller.
 * A reason that already has the prefix is kept, so a later tick does not nest it.
 */
export function quotaWaitLabel(pool: string | null | undefined, reason: string): string {
  const detail = reason.trim();
  if (isQuotaWaitReason(detail)) return detail;
  const name = pool?.trim() || t("blocked.quota.noPool");
  return t("blocked.quota.label", { prefix: t("blocked.prefix.quota"), pool: name, detail });
}

/** Next step of a card whose executor completed and named what it waits for: "Waiting on external: <what>". */
export function externalWaitLabel(wait: string): string {
  return t("blocked.external.label", { prefix: t("blocked.prefix.external"), wait });
}

/** True for an external-wait next step in any language (stored text from before i18n included). */
export function isExternalWaitText(text: string | null | undefined): boolean {
  return Boolean(text && startsWithMessage(text, "blocked.prefix.external"));
}

/** Board alert for a hold. Quota and external waits stay as written; other holds get "Next step: ". */
export function cardQueueAlert(status: string, nextStep: string | null): string | null {
  if (!nextStep || status === "blocked") return null;
  const head = nextStep.split("\n")[0] ?? nextStep;
  if (isQuotaWaitReason(head) || isExternalWaitText(head)) return nextStep;
  return t("blocked.nextStep", { step: nextStep });
}

/** Render in the viewer's local timezone, retaining the timezone name to avoid ambiguity. */
export function scheduledWaitLabel(until: string): string {
  const date = new Date(until);
  const local = Number.isFinite(date.getTime())
    ? date.toLocaleString(getLanguage(), { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", timeZoneName: "short" })
    : until;
  return t("scheduled.label", { until: local });
}
