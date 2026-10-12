import { z } from "zod";
import { t } from "./i18n";

export const WEEK_STATS_TTL_MS = 10 * 60_000;
export const WEEK_MS = 7 * 86_400_000;
export const NUDGE_AFTER_MS = 10 * 60_000;

/**
 * `commit` counts every git commit; `docCommit` is the part that only touched docs (see isDocCommit), so code commits are
 * commit - docCommit. `edit` counts Edit/Write calls. The last two default to 0 for snapshots from before they existed.
 */
export const weekStatsSchema = z.object({
  dispatch: z.number(), merge: z.number(), commit: z.number(), test: z.number(),
  docCommit: z.number().default(0), edit: z.number().default(0),
});
export type WeekStats = z.infer<typeof weekStatsSchema>;
export const EMPTY_WEEK_STATS: WeekStats = { dispatch: 0, merge: 0, commit: 0, test: 0, docCommit: 0, edit: 0 };

/** Code-only (non-doc) commits. */
export const codeCommits = (stats: Pick<WeekStats, "commit" | "docCommit">): number => Math.max(0, stats.commit - (stats.docCommit ?? 0));
/** 7 days: this many code commits with at most this many dispatched cards means the leader is writing code itself. */
export const CODE_COMMIT_ALARM = 10;
export const DISPATCH_ALARM_MAX = 2;
export function writingCodeNote(): string {
  return t("leader.week.writingCode");
}
export function isWritingCode(stats: WeekStats | null | undefined): boolean {
  return Boolean(stats) && codeCommits(stats!) >= CODE_COMMIT_ALARM && stats!.dispatch <= DISPATCH_ALARM_MAX;
}

/** Optional wrappers in front of a real command: timeout 600 npm run compat, time npx tsc, nohup bash x.sh. */
const PREFIX = String.raw`(?:(?:timeout\s+\d+\s+|time\s+|nohup\s+|npx\s+)*)`;
const TEST_COMMAND = new RegExp(String.raw`^${PREFIX}(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|typecheck|compat|build|lint)\b|(?:pytest|vitest|jest|playwright|tsc)\b|tsx\s+(?:\S+\s+)*?\S*\.test\.[cm]?[jt]sx?\b|node\s+(?:--test\b|(?:\S+\s+)*?\S*\.test\.[cm]?[jt]sx?\b))`, "i");
const MERGE_COMMAND = new RegExp(String.raw`(?:\bgh\s+pr\s+merge\b|^${PREFIX}(?:(?:node|python3?|bash|sh|tsx)\s+)?(?:[./\w-]*\/)?(?:[\w-]*merge[\w-]*queue[\w.-]*|[\w-]*queue[\w-]*merge[\w.-]*)\.(?:sh|py|[cm]?js|ts)\b)`, "i");
const COMMIT_COMMAND = /\bgit\s+commit\b/i;
const DOC_PATH = /(?:^|\/)docs\/|\.md$|(?:^|\/)STATUS[\w.-]*$/i;
const EDIT_TOOLS = /^(?:Edit|Write|MultiEdit|NotebookEdit)$/;
const DISPATCH_COMMAND = /^(?:[./~\w-]*\/)?(?:bin\/)?kanban\s+(?:create|start)\b/i;

/** Split a shell command on && || ; and newlines that are outside quotes. An unmatched quote is just a character. */
function splitSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < command.length && command[j] !== ch) j += ch === '"' && command[j] === "\\" ? 2 : 1;
      if (j < command.length) { current += command.slice(i, j + 1); i = j; continue; }
    }
    if (ch === ";" || ch === "\n") { segments.push(current); current = ""; continue; }
    if ((ch === "&" || ch === "|") && command[i + 1] === ch) { segments.push(current); current = ""; i += 1; continue; }
    current += ch;
  }
  segments.push(current);
  return segments.map((raw) => raw.trim().replace(/^\(\s*/, ""));
}
/** Whitespace-separated words of one segment with their quotes removed. */
function shellWords(segment: string): string[] {
  return [...segment.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
}
const blankQuotes = (segment: string): string => segment.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""');

/** The first line of the commit message in this segment (-m "msg"), or from a heredoc in the whole command. Null when none. */
function commitMessage(segment: string, command: string): string | null {
  const inline = /(?:\s-\w*m|\s--message)[=\s]*(?:"([^"\n]*)|'([^'\n]*))/.exec(segment);
  const text = inline ? (inline[1] ?? inline[2]) : null;
  if (text && !text.startsWith("$(")) return text.trim();
  const heredoc = /\bgit\s+commit\b[^\n]*?(?:\s-\w*m|\s--message)[=\s]*"\$\(cat\s+<<-?\s*['"]?\w+['"]?\s*\n\s*([^\n]*)/.exec(command);
  return heredoc ? heredoc[1].trim() : null;
}
/** Paths named by the add segments since the last commit. Null when it adds everything (".", -A, -u) or adds nothing. */
function addedPaths(adds: readonly string[]): string[] | null {
  const paths: string[] = [];
  for (const add of adds) {
    for (const arg of shellWords(add).slice(2)) {
      if (arg === "-A" || arg === "--all" || arg === "." || arg === "-u") return null;
      if (!arg.startsWith("-")) paths.push(arg);
    }
  }
  return paths.length > 0 ? paths : null;
}
/**
 * A commit is a doc commit when the add paths since the previous commit in the same command are all docs
 * (*.md, docs/, STATUS), or, when no path is visible, its message type is `docs`. Anything else counts as code.
 */
export function isDocCommit(segment: string, command: string, adds: readonly string[]): boolean {
  const paths = addedPaths(adds);
  if (paths) return paths.every((p) => DOC_PATH.test(p));
  return /^docs(?:\([^)]*\))?!?:/i.test(commitMessage(segment, command) ?? "");
}

/** Count one tool call. Commands are split into segments so quoted prose never matches. */
export function classifyToolUse(name: string, command: string): Partial<WeekStats> {
  const out: { -readonly [K in keyof WeekStats]?: number } = {};
  const bump = (key: keyof WeekStats) => { out[key] = (out[key] ?? 0) + 1; };
  if (/kanban_create$/.test(name)) bump("dispatch");
  if (EDIT_TOOLS.test(name)) bump("edit");
  if (name !== "Bash") return out;
  const withoutHeredocs = command.replace(/<<-?\s*(['"]?)(\w+)\1([^\n]*)\n[\s\S]*?(?:\n\s*\2\s*(?=\n|$)|$)/g, "$3");
  let adds: string[] = [];
  for (const raw of splitSegments(withoutHeredocs)) {
    const part = blankQuotes(raw);
    if (DISPATCH_COMMAND.test(part)) bump("dispatch");
    else if (MERGE_COMMAND.test(part)) bump("merge");
    else if (COMMIT_COMMAND.test(part)) { bump("commit"); if (isDocCommit(raw, command, adds)) bump("docCommit"); adds = []; }
    else if (/^git\s+add\b/i.test(part)) adds.push(raw);
    else if (TEST_COMMAND.test(part)) bump("test");
  }
  return out;
}

export function addStats(a: WeekStats, b: Partial<WeekStats>): WeekStats {
  return {
    dispatch: a.dispatch + (b.dispatch ?? 0), merge: a.merge + (b.merge ?? 0), commit: a.commit + (b.commit ?? 0), test: a.test + (b.test ?? 0),
    docCommit: a.docCommit + (b.docCommit ?? 0), edit: a.edit + (b.edit ?? 0),
  };
}

export type WeekItem = "merge" | "commit" | "test";
export const WEEK_ITEM_KEYS: readonly WeekItem[] = ["merge", "commit", "test"];
const WEEK_ITEM_LABEL = { merge: "leader.week.merge", commit: "leader.week.commit", test: "leader.week.test" } as const;
export function weekItemLabel(key: WeekItem): string {
  return t(WEEK_ITEM_LABEL[key]);
}
/** What the panel shows for an item: for commit, code commits only (doc commits are shown apart). */
export function weekItemCount(stats: WeekStats, key: WeekItem): number {
  return key === "commit" ? codeCommits(stats) : stats[key];
}
/** An item is flagged when the leader did it more often than it dispatched cards. */
export function overDispatch(stats: WeekStats, key: WeekItem): boolean {
  return weekItemCount(stats, key) > stats.dispatch;
}
export function weekStatsOver(stats: WeekStats | null | undefined): boolean {
  return Boolean(stats) && WEEK_ITEM_KEYS.some((key) => overDispatch(stats!, key));
}

/** Same offset as dispatch.ts; not imported from there because dispatch.ts reaches this file through leader-panel. */
const TOKYO_OFFSET_MS = 9 * 3_600_000;
/** The Tokyo calendar day of a timestamp, "2026-10-05". The activity archive keeps one line per leader per such day. */
export function tokyoDayKey(ms: number): string {
  return new Date(ms + TOKYO_OFFSET_MS).toISOString().slice(0, 10);
}

/** Claude Code stores sessions in a directory named after the cwd with non-alphanumerics replaced by dashes. */
export function claudeProjectDirName(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

export function nudgePrompt(excerpt: string): string {
  const head = excerpt.replace(/\s+/g, " ").trim().slice(0, 80);
  return t("leader.week.nudge", { head });
}
