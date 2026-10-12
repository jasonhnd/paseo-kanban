import { groupOpenDecisions, hangingLabel, maybeStale, type OpenDecision } from "./decisions";
import { t } from "./i18n";
import { partitionHomeDecisions, type HomeDecision } from "./home-status";
import { partitionUnownedDecisions, type UnownedDecision } from "./unowned-decisions";

export function hintDecide(): string {
  return t("decisions.view.hintDecide");
}

export function hintUnread(): string {
  return t("decisions.view.hintUnread");
}

type Listed = OpenDecision & HomeDecision & UnownedDecision;

export function toggleSet<T>(prev: ReadonlySet<T>, value: T): Set<T> {
  const next = new Set(prev);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

export function addSet<T>(prev: ReadonlySet<T>, value: T): Set<T> {
  const next = new Set(prev);
  next.add(value);
  return next;
}

export function upsertNotice<T extends { id: string }>(prev: readonly T[], row: T): T[] {
  return [...prev.filter((item) => item.id !== row.id), row];
}

export function decisionBuckets<T extends Listed>(decisions: readonly T[], now: number, deferred: ReadonlySet<string>) {
  const ownership = partitionUnownedDecisions(decisions);
  const parts = partitionHomeDecisions(ownership.owned);
  const blocking = parts.blocking.filter((item) => !deferred.has(item.id));
  const held = parts.blocking.filter((item) => deferred.has(item.id));
  const relaxed = groupOpenDecisions([...parts.relaxed, ...held], now);
  return { ownership, parts, blocking, held, relaxed };
}

export function decisionsLookEmpty(blocking: number, relaxed: number, unread: number, unowned: number, notices: number): boolean {
  return blocking + relaxed + unread + unowned === 0 && notices === 0;
}

export function showRelaxed(relaxed: number, held: number): boolean {
  return relaxed + held > 0;
}

export function decisionMeta(
  row: { project: string; blocking: boolean; source: string; createdAt: string },
  deferred: boolean,
  now: number,
): string {
  const tags = [
    row.blocking && !deferred ? t("decisions.meta.blocking") : null,
    deferred ? t("decisions.meta.deferred") : null,
    maybeStale(row, now) ? t("decisions.meta.maybeStale") : null,
  ].filter((tag): tag is string => tag !== null);
  return [row.project, ...tags, hangingLabel(row.createdAt, now), row.source].join(" · ");
}

export function decisionMetaTone(
  row: { blocking: boolean; createdAt: string },
  deferred: boolean,
  now: number,
): "red" | "yellow" | "muted" {
  if (row.blocking && !deferred) return "red";
  if (maybeStale(row, now)) return "yellow";
  return "muted";
}

export function shelveConfirm(project: string, count: number): string {
  return t("decisions.view.shelveConfirm", { project, count });
}

export function unregisteredDecisions<T extends { project: string }>(
  decisions: readonly T[],
  projectNames: readonly string[],
  isUnowned: (item: T) => boolean,
): T[] {
  const projects = new Set(projectNames.map((name) => name.toLowerCase()));
  return decisions.filter((item) => isUnowned(item) || !projects.has(item.project.toLowerCase()));
}

export function showReplyRow(allowText: boolean, canDefer: boolean): boolean {
  return allowText || canDefer;
}

export function replyError(error: unknown): { ok: false; text: string } {
  return { ok: false, text: String(error).slice(0, 200) };
}
