import { z } from "zod";
import { t } from "../shared/i18n";
import { KanbanError } from "./errors";

export const MAX_SCHEDULED_WAIT_MS = 7 * 24 * 60 * 60_000;

/** Require an explicit ISO offset (Z is UTC), then store one canonical instant. */
export function scheduledUntil(kind: string, until: unknown, now = Date.now()): string | null {
  if (kind !== "scheduled") {
    if (until !== undefined) throw new KanbanError("invalid", t("scheduled.error.onlyScheduled"));
    return null;
  }
  const parsed = z.iso.datetime({ offset: true }).safeParse(until);
  const ms = parsed.success ? Date.parse(parsed.data) : NaN;
  if (!Number.isFinite(ms)) throw new KanbanError("invalid", t("scheduled.error.format"));
  if (ms <= now) throw new KanbanError("invalid", t("scheduled.error.future"));
  if (ms - now > MAX_SCHEDULED_WAIT_MS) throw new KanbanError("invalid", t("scheduled.error.limit"));
  return new Date(ms).toISOString();
}
