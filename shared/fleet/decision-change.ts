/** Changing an answer: the window, the letter read back from a stored note, the texts. Pure; no I/O. */
import { anyWord, lazy, templatePattern } from "./decision-parse";
import { t } from "./i18n";

export const CHANGE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** "Change" shows only while the answer is less than 24 hours old. A time that cannot be read never allows it. */
export function canChangeChoice(decidedAtMs: number | null, now: number): boolean {
  if (decidedAtMs === null || !Number.isFinite(decidedAtMs)) return false;
  const age = now - decidedAtMs;
  return age >= 0 && age <= CHANGE_WINDOW_MS;
}

const PICK_RE = lazy(() => new RegExp(`${anyWord("decisions.parse.pick")}\\s*([A-D])(?![A-Za-z0-9])`));

/** The letter a closed item was answered with ("picked A…" or "changed to B…", any language). The first one wins. */
export function letterFromNote(note: string): string | null {
  return PICK_RE().exec(note)?.[1] ?? null;
}

/** Note on the new, closed item. It names the old item so the trail can be followed. */
export function changeNote(oldId: string, from: string, to: string, excerpt: string, comment = ""): string {
  const phrase = excerpt.trim();
  const extra = comment.trim();
  const body = phrase && extra ? t("decisions.note.join", { a: phrase, b: extra }) : phrase || extra;
  const text = body ? t("decisions.note.text", { text: body }) : "";
  return `${t("decisions.note.changed", { choice: to })}${text}${t("decisions.note.wasPicked", { oldId, from })}`;
}

/** Note left on the old item, so a reader of it knows it was superseded. */
export function supersededNote(newId: string, from: string, to: string): string {
  return t("decisions.note.superseded", { from, to, newId });
}

/** What the project's <leader> is told. States plainly: from which letter to which. */
export function changePrompt(oldId: string, title: string, from: string, to: string, spoken: string): string {
  const said = spoken.trim() ? t("decisions.prompt.said", { text: spoken.trim() }) : "";
  return t("decisions.prompt.changed", { oldId, title, from, to, said });
}

export function changeSuccess(to: string, title: string): string {
  return t("decisions.change.recordedNotified", { to, title });
}

/** One answer the user gave on the panel, still inside the 24-hour change window. Read back from the stored items. */
export interface RecentChoice {
  id: string;
  project: string;
  title: string;
  detail: string;
  letter: string;
  doneAt: string;
  blocking: boolean;
  agentId: string | null;
  source: string;
  createdAt: string;
}

const LETTER = "([A-D])(?![A-Za-z0-9])";
/** A note this panel wrote when the user picked or changed a letter, in any language. */
const PANEL_NOTE = lazy(() => new RegExp(`^(?:${templatePattern("decisions.note.picked", { choice: LETTER }, "choice")}|${templatePattern("decisions.note.changed", { choice: LETTER }, "choice")})`));
/** The "(was <old id> picked X)" tail of a change note. */
const SUPERSEDES = lazy(() => new RegExp(templatePattern("decisions.note.wasPicked", { oldId: "(\\S+?)", from: "[A-D]" })));

function panelLetter(note: string): string | undefined {
  const match = PANEL_NOTE().exec(note);
  return match ? match.slice(1).find(Boolean) : undefined;
}

function supersededId(note: string): string | undefined {
  const match = SUPERSEDES().exec(note);
  return match ? match.slice(1).find(Boolean) : undefined;
}

const str = (value: unknown): string => (typeof value === "string" ? value : "");

/**
 * Closed items the user answered from this panel within the last 24 hours, newest first. An item that a later
 * change replaced is left out (the replacement carries the answer), so a reopened panel shows each answer once.
 */
export function recentChoices(items: readonly Record<string, unknown>[], now: number): RecentChoice[] {
  const answered = items.flatMap((item) => {
    const note = str(item.note);
    const letter = panelLetter(note);
    const doneAtMs = Date.parse(str(item.doneAt));
    if (item.status !== "done" || !letter || !canChangeChoice(Number.isNaN(doneAtMs) ? null : doneAtMs, now)) return [];
    return [{ item, note, letter, doneAtMs }];
  });
  const replaced = new Set(answered.map((row) => supersededId(row.note)).filter((id): id is string => Boolean(id)));
  return answered
    .filter((row) => !replaced.has(str(row.item.id)))
    .sort((a, b) => b.doneAtMs - a.doneAtMs)
    .map(({ item, letter }) => ({
      id: str(item.id),
      project: str(item.project),
      title: str(item.title),
      detail: str(item.detail),
      letter,
      doneAt: str(item.doneAt),
      blocking: item.blocking === true,
      agentId: str(item.agentId) || null,
      source: str(item.source) || t("decisions.source.default"),
      createdAt: str(item.createdAt),
    }));
}

/**
 * Where a stored answer is shown again: with its project's <leader> in the attention list, or in the
 * "no <leader> yet" area when the project has none. Paused projects show nothing, like their open items.
 */
export function splitRecentChoices<T extends { project: string }>(
  choices: readonly T[],
  registeredProjects: readonly string[],
  isPaused: (project: string) => boolean,
): { registered: T[]; unregistered: T[] } {
  const known = new Set(registeredProjects.map((name) => name.toLowerCase()));
  const shown = choices.filter((choice) => !isPaused(choice.project));
  return {
    registered: shown.filter((choice) => known.has(choice.project.toLowerCase())),
    unregistered: shown.filter((choice) => !known.has(choice.project.toLowerCase())),
  };
}
