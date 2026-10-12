import { z } from "zod";
import { t } from "./i18n";

/** A project the user paused with `roles pause`. Stored in paused-projects.json in the data directory. */
export const pausedProjectSchema = z.object({ project: z.string(), since: z.string(), note: z.string() });
export type PausedProject = z.infer<typeof pausedProjectSchema>;

export function parsePausedProjects(raw: unknown): PausedProject[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((row): PausedProject[] => {
    const r = row && typeof row === "object" ? row as Record<string, unknown> : {};
    return typeof r.project === "string" && r.project.trim()
      ? [{ project: r.project.trim(), since: typeof r.since === "string" ? r.since : "", note: typeof r.note === "string" ? r.note : "" }]
      : [];
  });
}
export function pausedKeys(paused: readonly { project: string }[] | undefined): ReadonlySet<string> {
  return new Set((paused ?? []).map((p) => p.project.trim().toLowerCase()));
}
export function isPausedProject(project: string, paused: readonly { project: string }[] | undefined): boolean {
  return pausedKeys(paused).has(project.trim().toLowerCase());
}
export function withoutPaused<T extends { project: string }>(items: readonly T[], paused: readonly { project: string }[] | undefined): T[] {
  const keys = pausedKeys(paused);
  return keys.size === 0 ? [...items] : items.filter((i) => !keys.has(i.project.trim().toLowerCase()));
}
/** "since 10-02", or an empty string when the start time cannot be read. */
export function pausedSinceLabel(since: string): string {
  const m = /^\d{4}-(\d{2})-(\d{2})/.exec(since);
  return m ? t("home.paused.since", { date: `${m[1]}-${m[2]}` }) : "";
}
export function pausedLabel(p: PausedProject): string {
  const since = pausedSinceLabel(p.since);
  return t("home.paused.label", { project: p.project }) + (since ? t("home.paused.sinceSuffix", { since }) : "");
}

export interface ProjectStatusCount { project: string; status: string; count: number }
/** Column counts with paused projects' cards taken out. */
export function countsWithoutPaused<T extends { status: string; count: number }>(
  counts: readonly T[], byProject: readonly ProjectStatusCount[], paused: readonly { project: string }[] | undefined,
): T[] {
  const keys = pausedKeys(paused);
  if (keys.size === 0) return [...counts];
  const removed = new Map<string, number>();
  for (const row of byProject) if (keys.has(row.project.trim().toLowerCase())) removed.set(row.status, (removed.get(row.status) ?? 0) + row.count);
  return counts.map((c) => ({ ...c, count: Math.max(0, c.count - (removed.get(c.status) ?? 0)) }));
}
