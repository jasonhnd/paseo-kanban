// History of model swaps made from the Roles page, and the undo rules.
// Pure functions plus the undo RPC. The server keeps the entries in a runtime state file.
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { t } from "./i18n";
import { specText } from "./roles-swap";

/** Entries kept in the state file; older ones are dropped. `roles set` keeps its own backups and changes.log. */
export const HISTORY_LIMIT = 200;
/** Entries shown under one role card. */
export const HISTORY_SHOWN = 10;

const specSchema = z.object({ provider: z.string(), model: z.string(), thinking: z.string().nullable() });

export const historyEntrySchema = z.object({
  id: z.string(),
  at: z.string(),
  profile: z.string(),
  from: specSchema,
  to: specSchema,
  /** Set when this change was the undo of another entry. */
  undoOf: z.string().nullable(),
});

export const historyViewSchema = historyEntrySchema.extend({
  /** When a later undo reverted this entry. */
  undoneAt: z.string().nullable(),
  /** Why Undo is not offered; null means it is. */
  undoBlock: z.string().nullable(),
});

export type ModelSpec = z.infer<typeof specSchema>;
export type HistoryEntry = z.infer<typeof historyEntrySchema>;
export type HistoryView = z.infer<typeof historyViewSchema>;

export const rolesUndoRpc = defineRpc({
  name: "board.roles-undo",
  input: z.object({ id: z.string().trim().min(1).max(80) }),
  output: z.object({ ok: z.boolean(), message: z.string(), before: z.string().nullable(), after: z.string().nullable() }),
});

/** Valid entries only; anything else in the file is skipped, not trusted. */
export function parseHistory(raw: unknown): HistoryEntry[] {
  const list = Array.isArray((raw as { entries?: unknown } | null)?.entries) ? (raw as { entries: unknown[] }).entries : [];
  return list.flatMap((item) => {
    const parsed = historyEntrySchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

/** New list with `entry` appended, oldest dropped past the limit. */
export function appendHistory(entries: readonly HistoryEntry[], entry: HistoryEntry, limit = HISTORY_LIMIT): HistoryEntry[] {
  return [...entries, entry].slice(-limit);
}

export function sameSpec(a: ModelSpec, b: ModelSpec): boolean {
  return a.provider === b.provider && a.model === b.model && (a.thinking ?? null) === (b.thinking ?? null);
}

export function modelSpecText(spec: ModelSpec): string {
  return specText(spec.provider, spec.model, spec.thinking);
}

/** Why an entry cannot be undone now, or null. `current` is the profile's spec in config, null when it is gone. */
export function undoBlock(entry: HistoryEntry, undone: boolean, current: ModelSpec | null): string | null {
  if (undone) return t("roles.history.undone");
  if (!current) return t("roles.history.profileGone");
  if (!sameSpec(current, entry.to)) return t("roles.history.changedSinceNow", { spec: modelSpecText(current) });
  if (entry.from.thinking === null && entry.to.thinking !== null) return t("roles.history.noThinkingBefore");
  return null;
}

/** Newest first, with undo state worked out against the current config. */
export function historyViews(entries: readonly HistoryEntry[], current: (profile: string) => ModelSpec | null): HistoryView[] {
  const undoneAt = new Map(entries.flatMap((entry) => (entry.undoOf ? [[entry.undoOf, entry.at] as const] : [])));
  const latest = new Map(entries.map((entry) => [entry.profile, entry.id] as const));
  return [...entries].reverse().map((entry) => {
    const undone = undoneAt.get(entry.id) ?? null;
    const block = latest.get(entry.profile) === entry.id || undone ? undoBlock(entry, Boolean(undone), current(entry.profile)) : t("roles.history.changedSince");
    return { ...entry, undoneAt: undone, undoBlock: block };
  });
}

/** History rows for the profiles of one role card, newest first, at most `limit`. */
export function historyForProfiles(views: readonly HistoryView[], profiles: readonly string[], limit = HISTORY_SHOWN): HistoryView[] {
  const names = new Set(profiles);
  return views.filter((view) => names.has(view.profile)).slice(0, limit);
}

/** `old → new` in one line. */
export function changeText(entry: Pick<HistoryEntry, "from" | "to">): string {
  return `${modelSpecText(entry.from)} → ${modelSpecText(entry.to)}`;
}
