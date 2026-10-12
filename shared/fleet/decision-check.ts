/** When to remind a <leader> that an open decision may already have been answered. No file or network access. */
import { ageMs, decisionOwner } from "./decisions";
import { t } from "./i18n";
import { isPausedProject } from "./paused";

/** Open strictly longer than this before the first reminder. */
export const CHECK_AFTER_MS = 24 * 60 * 60 * 1000;

/** A failed send is tried again only after this. */
export const CHECK_RETRY_MS = 5 * 60 * 1000;

const ID_OK = /^[A-Za-z0-9._-]+$/;

/** "yes" spoke with the user after the item was opened. "no" did not. "unknown" cannot be judged. */
export type Spoke = "yes" | "no" | "unknown";

/** A timeline fact. known false means the record could not be read. */
export interface SpeechFact {
  known: boolean;
  lastUserReplyAt: string | null;
}

export interface CheckSource {
  id: string;
  project: string;
  title: string;
  status: string;
  createdAt: string;
}

export interface CheckItem extends CheckSource {
  speech: SpeechFact;
}

export interface SpeechDetail {
  project: string;
  activityWarning?: string | null;
  lastUserReplyAt?: string | null;
}

export interface CheckStateShape {
  reminded: Record<string, string>;
  tried: Record<string, string>;
}

export interface CheckPlanRow {
  id: string;
  project: string;
  title: string;
  agentId: string;
  spoke: Spoke;
}

export interface CheckPlan {
  rows: CheckPlanRow[];
  noOwner: string[];
}

/** Unreadable activity, or no panel row for the project, degrades to "age only". */
export function speechFromDetail(detail: SpeechDetail | undefined): SpeechFact {
  if (!detail || detail.activityWarning) return { known: false, lastUserReplyAt: null };
  return { known: true, lastUserReplyAt: detail.lastUserReplyAt ?? null };
}

export function speechForProject(project: string, details: readonly SpeechDetail[]): SpeechFact {
  const key = project.trim().toLowerCase();
  return speechFromDetail(details.find((row) => row.project.trim().toLowerCase() === key));
}

/**
 * A reply at the same instant as creation is not "after".
 * Missing or unreadable times degrade to unknown, which still reminds once the item is old enough.
 */
export function spokeAfterCreate(createdAt: string, speech: SpeechFact): Spoke {
  if (!speech.known || speech.lastUserReplyAt == null) return "unknown";
  const created = Date.parse(createdAt);
  const spoke = Date.parse(speech.lastUserReplyAt);
  if (!Number.isFinite(created) || !Number.isFinite(spoke)) return "unknown";
  return spoke > created ? "yes" : "no";
}

function within(iso: string | null | undefined, now: number, windowMs: number): boolean {
  if (!iso) return false;
  const age = ageMs(iso, now);
  return age !== null && age >= 0 && age < windowMs;
}

/** True when this open item should be mentioned on this pass. */
export function dueForCheck(input: {
  createdAt: string;
  now: number;
  speech: SpeechFact;
  lastSent?: string | null;
  lastTried?: string | null;
}): boolean {
  const age = ageMs(input.createdAt, input.now);
  if (age === null || age <= CHECK_AFTER_MS) return false;
  if (spokeAfterCreate(input.createdAt, input.speech) === "no") return false;
  if (within(input.lastSent, input.now, CHECK_AFTER_MS)) return false;
  if (within(input.lastTried, input.now, CHECK_RETRY_MS)) return false;
  return true;
}

export function planCheckReminders(
  items: readonly CheckItem[],
  state: CheckStateShape,
  now: number,
  supervisors: Record<string, string> | null,
  paused: readonly { project: string }[],
): CheckPlan {
  const rows: CheckPlanRow[] = [];
  const noOwner: string[] = [];
  for (const item of items) {
    if (item.status !== "open") continue;
    const id = item.id.trim();
    if (!ID_OK.test(id)) continue;
    if (isPausedProject(item.project, paused)) continue;
    if (!dueForCheck({
      createdAt: item.createdAt,
      now,
      speech: item.speech,
      lastSent: state.reminded[id],
      lastTried: state.tried[id],
    })) continue;
    const agentId = decisionOwner(item.project, supervisors).agentId;
    if (!agentId) {
      noOwner.push(id);
      continue;
    }
    rows.push({
      id,
      project: item.project,
      title: item.title,
      agentId,
      spoke: spokeAfterCreate(item.createdAt, item.speech),
    });
  }
  return { rows, noOwner };
}

/** One line. "unknown" does not claim the leader spoke. */
export function checkLine(row: Pick<CheckPlanRow, "id" | "project" | "title" | "spoke">): string {
  const key = row.spoke === "yes" ? "decisions.check.spokeLine" : "decisions.check.unknownLine";
  return t(key, { id: row.id, project: row.project, title: row.title });
}

/** One message for every due item of a single leader. */
export function checkDigest(lines: readonly string[]): string {
  if (lines.length === 0) return "";
  return [t("decisions.check.digestHead", { count: lines.length }), ...lines].join("\n");
}
