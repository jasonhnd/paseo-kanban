/** Pure view model for one decision card: question, context, options, recommendation, order, filters. No I/O. */
import { anyWord, catalogChars, fullWidth, lazy, punct, templatePattern } from "./decision-parse";
import { ageMs, hangingDays, isNoLeaderOwner, noLeaderLabel } from "./decisions";
import { t } from "./i18n";

export interface CardOption {
  letter: string;
  /** Text for the button: full option, without the "(recommended)" tag. */
  text: string;
  /** Same text with the "(recommended)" tag kept. Used for the note the server stores. */
  rawText: string;
}

export interface ParsedDecisionCard {
  /** Text before the first option, with a leading "Now:" removed. */
  context: string;
  options: CardOption[];
  recommended: string | null;
  reason: string;
}

const OPTION_MAX = 400;
const REASON_MAX = 200;
const SUMMARY_MAX = 36;
const CONTEXT_FOLD_CHARS = 80;
const CONTEXT_FOLD_LINES = 3;

/*
 * Decision text is written by agents, in Chinese or English. Words come from the catalogs in every language
 * (decision-parse), punctuation in ASCII and full-width form. Built once, on first use.
 */
const REC_WORD = lazy(() => anyWord("decisions.parse.recommend"));
const REC_RE = lazy(() => new RegExp(
  `(?:^|[\\s${punct(";,/")}。.、])${REC_WORD()}\\s*${anyWord("decisions.parse.recommendPick")}?\\s*[${punct(":")}]?\\s*([A-Da-d])(?![A-Za-z0-9])[ \\t\\u3000]*[${punct(",:;)")}。.、 \\t\\u3000]*`,
  "i",
));
const REC_TAG_RE = lazy(() => new RegExp(`[${punct("(")}]\\s*${REC_WORD()}\\s*[${punct(")")}]`, "i"));
const EDGE = lazy(() => new Set([..."/;、。.,:·…—-!?", ...fullWidth("/;.,:!?")]));
const CLOSE_PARENS = lazy(() => `)${fullWidth(")")}`);
/** After an option letter: `A.`, `A:`, `A)`, `A、`, or a slash that does not lead into another letter. */
const MARK_TAIL = lazy(() => `(?:[${punct(".:)")}。、]|[${punct("/")}](?![A-Da-d][\\s${punct(".:)/")}、]))`);
/** An option starts a line (a list bullet is fine): `A:`, `A.`, `A)`, `A、`, or a letter then a space. */
const LINE_MARK_RE = lazy(() => new RegExp(
  `^([ \\t]*(?:[-*${catalogChars("decisions.parse.bullets")}]\\s*)?[${punct("(")}]?)([A-Da-d])(?:${MARK_TAIL()}|(?=[ \\t\\u3000]+\\S))`,
  "gm",
));
/** Inline options in one line: `A drop / B defer`. `A/do` is an option; `A/B test` (a slash into another letter) is text. */
const INLINE_MARK_RE = lazy(() => new RegExp(
  `(?:^|[\\s${punct(";/:,(")}、])([A-Da-d])(?:${MARK_TAIL()}|(?=[ \\t\\u3000]))`,
  "g",
));
const CONTEXT_LEAD_RE = lazy(() => new RegExp(`^\\s*${anyWord("decisions.parse.contextLead")}\\s*[${punct(":")}]\\s*`, "i"));
const REASON_LEAD_RE = lazy(() => new RegExp(`^\\s*${anyWord("decisions.parse.reasonLead")}\\s*[${punct(":")}]?\\s*`, "i"));
const OPTIONS_TAIL_RE = lazy(() => new RegExp(`\\s*${anyWord("decisions.parse.optionsTail")}\\s*[${punct(":")}]?\\s*$`, "i"));
const CLAUSE_END_RE = lazy(() => new RegExp(`[。${punct(";")}\\n]`));

/** Drops markdown emphasis and code ticks so `**A**: …` reads like `A: …`. */
export function normalizeChoiceText(text: string): string {
  return text.replace(/\*\*|`/g, "");
}

function trimEdges(raw: string, max: number): string {
  let text = raw.replace(/\s+/g, " ").replace(/([\u3000-\u303f\uff00-\uffef])\s+/g, "$1").replace(/\s+([\u3000-\u303f\uff00-\uffef])/g, "$1").trim();
  const edge = EDGE();
  while (text.length > 0 && (edge.has(text[0]) || CLOSE_PARENS().includes(text[0]))) text = text.slice(1).trim();
  while (text.length > 0 && edge.has(text[text.length - 1])) text = text.slice(0, -1).trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function stripContextLead(text: string): string {
  return text.replace(CONTEXT_LEAD_RE(), "");
}

function stripReasonLead(text: string): string {
  return text.replace(REASON_LEAD_RE(), "");
}

/** `cut` is where the previous option's text ends; `textStart` is where this option's text begins. */
interface Mark {
  letter: string;
  cut: number;
  textStart: number;
}

/** Only marks whose letters keep rising (A, B, C… or A, C) count; a repeated or earlier letter is just text. */
function inOrder(marks: Mark[]): Mark[] {
  const kept: Mark[] = [];
  for (const mark of marks) {
    const last = kept.length > 0 ? kept[kept.length - 1].letter : "";
    if (mark.letter > last) kept.push(mark);
  }
  return kept;
}

function lineMarks(text: string): Mark[] {
  return inOrder([...text.matchAll(LINE_MARK_RE())].map((match) => {
    const cut = match.index ?? 0;
    return { letter: match[2].toUpperCase(), cut, textStart: cut + match[0].length };
  }));
}

function inlineMarks(text: string): Mark[] {
  return inOrder([...text.matchAll(INLINE_MARK_RE())].map((match) => {
    const cut = (match.index ?? 0) + match[0].search(/[A-Da-d]/);
    return { letter: match[1].toUpperCase(), cut, textStart: (match.index ?? 0) + match[0].length };
  }));
}

/** Options at line starts win; one-line `A drop / B defer` is the fallback and needs at least two. */
function findMarks(text: string): Mark[] {
  const byLine = lineMarks(text);
  if (byLine.length >= 2) return byLine;
  const inline = inlineMarks(text);
  if (inline.length >= 2) return inline;
  return byLine;
}

interface Recommendation {
  letter: string;
  /** Text after the letter: to the end of the line when options follow, else to the end. */
  reason: string;
  start: number;
  end: number;
  optionsFollow: boolean;
}

function findRecommendation(text: string): Recommendation | null {
  const match = REC_RE().exec(text);
  if (!match) return null;
  const lead = match[0].search(new RegExp(REC_WORD(), "i"));
  const start = (match.index ?? 0) + Math.max(0, lead);
  const end = (match.index ?? 0) + match[0].length;
  const withoutRec = text.slice(0, start) + " ".repeat(end - start) + text.slice(end);
  const optionsFollow = findMarks(withoutRec).some((mark) => mark.cut >= end);
  const eol = text.indexOf("\n", end);
  const reasonEnd = optionsFollow && eol >= 0 ? eol : text.length;
  return { letter: match[1].toUpperCase(), reason: text.slice(end, reasonEnd), start, end, optionsFollow };
}

/** Text the options are cut from. The recommendation clause is blanked out (same length, so offsets hold). */
function optionBody(text: string, rec: Recommendation | null): string {
  if (!rec) return text;
  if (!rec.optionsFollow) return text.slice(0, rec.start);
  const eol = text.indexOf("\n", rec.end);
  const stop = eol < 0 ? text.length : eol;
  return text.slice(0, rec.start) + " ".repeat(stop - rec.start) + text.slice(stop);
}

function collectOptions(body: string): { options: CardOption[]; tagged: string | null; firstCut: number } {
  const marks = findMarks(body);
  const options: CardOption[] = [];
  let tagged: string | null = null;
  marks.forEach((mark, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].cut : body.length;
    const raw = body.slice(mark.textStart, end);
    if (REC_TAG_RE().test(raw)) tagged = tagged ?? mark.letter;
    const rawText = trimEdges(raw, OPTION_MAX);
    const text = trimEdges(raw.replace(new RegExp(REC_TAG_RE().source, "gi"), ""), OPTION_MAX);
    options.push({ letter: mark.letter, text, rawText });
  });
  return { options, tagged, firstCut: marks.length > 0 ? marks[0].cut : -1 };
}

/** Options may sit in the title or the detail; context is the detail up to the first option. */
export function parseDecisionCard(title: string, detail: string): ParsedDecisionCard {
  const head = normalizeChoiceText(title);
  const body = normalizeChoiceText(detail);
  const joined = `${head}\n${body}`;
  const rec = findRecommendation(joined);
  const cleaned = optionBody(joined, rec);
  const parsed = collectOptions(cleaned);
  const options = parsed.options;
  const recommended = rec && options.some((option) => option.letter === rec.letter)
    ? rec.letter
    : parsed.tagged;
  const detailStart = head.length + 1;
  const inDetail = options.length > 0 && parsed.firstCut >= detailStart;
  const context = inDetail ? cleaned.slice(detailStart, parsed.firstCut) : body;
  const reason = rec && recommended === rec.letter ? trimEdges(stripReasonLead(rec.reason), REASON_MAX) : "";
  return {
    context: stripContextLead(context).replace(OPTIONS_TAIL_RE(), "").replace(/[ \t]+\n/g, "\n").trim(),
    options,
    recommended,
    reason,
  };
}


/** One short clause of an option, for the confirm line. */
export function summarizeOption(text: string, max = SUMMARY_MAX): string {
  const clause = text.split(CLAUSE_END_RE())[0].replace(/\s+/g, " ").trim();
  return clause.length > max ? `${clause.slice(0, max - 1)}…` : clause;
}

export function confirmLine(letter: string, text: string): string {
  const summary = summarizeOption(text);
  return summary ? t("decisions.card.confirmWithText", { letter, summary }) : t("decisions.card.confirm", { letter });
}

/** Long context folds to a few lines; short context needs no toggle. */
export function contextNeedsFold(context: string): boolean {
  return context.length > CONTEXT_FOLD_CHARS || context.split("\n").length > CONTEXT_FOLD_LINES;
}

export function waitLabel(createdAt: string, now: number): string {
  const days = hangingDays(createdAt, now);
  if (days === null) return t("decisions.card.waitUnknown");
  return days <= 0 ? t("decisions.card.waitUnderDay") : t("decisions.card.waitDays", { days });
}

export interface CardRow {
  id: string;
  project: string;
  blocking: boolean;
  createdAt: string;
  owner?: string;
  leaderMissing?: boolean;
}

export { noLeaderLabel };

export function leaderLabel(row: Pick<CardRow, "owner" | "leaderMissing">): string | null {
  if (row.leaderMissing === true || isNoLeaderOwner(row.owner)) return noLeaderLabel();
  return row.owner?.trim() ? row.owner.trim() : null;
}

/** Blocking first, then longest wait, then id. Deferred rows go last in the same order. */
export function sortCardRows<T extends CardRow>(rows: readonly T[], now: number, deferred: ReadonlySet<string>): T[] {
  const rank = (row: T) => (deferred.has(row.id) ? 1 : 0);
  return [...rows].sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    if (a.blocking !== b.blocking) return a.blocking ? -1 : 1;
    const ageA = ageMs(a.createdAt, now) ?? -1;
    const ageB = ageMs(b.createdAt, now) ?? -1;
    if (ageB !== ageA) return ageB - ageA;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** "N to decide · M blocking". Deferred rows are not counted as asking for a decision. */
export function cardSummaryLine(rows: readonly CardRow[], deferred: ReadonlySet<string>): string {
  const open = rows.filter((row) => !deferred.has(row.id));
  const blocking = open.filter((row) => row.blocking).length;
  return blocking > 0
    ? t("decisions.card.summaryBlocking", { count: open.length, blocking })
    : t("decisions.card.summary", { count: open.length });
}

export interface ProjectTag {
  project: string;
  count: number;
}

/** Biggest project first. Fewer than two projects means no filter is worth showing. */
export function projectTags(rows: readonly CardRow[]): ProjectTag[] {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.project, (counts.get(row.project) ?? 0) + 1);
  const tags = [...counts.entries()].map(([project, count]) => ({ project, count }));
  tags.sort((a, b) => (b.count !== a.count ? b.count - a.count : a.project < b.project ? -1 : a.project > b.project ? 1 : 0));
  return tags.length >= 2 ? tags : [];
}

export function filterByProject<T extends CardRow>(rows: readonly T[], project: string | null): T[] {
  return project === null ? [...rows] : rows.filter((row) => row.project === project);
}

/** Selected filter that no longer matches any row falls back to "All". */
export function effectiveProjectFilter(rows: readonly CardRow[], project: string | null): string | null {
  return project !== null && rows.some((row) => row.project === project) ? project : null;
}

export interface ChosenState {
  /** The item that holds this answer. After a change it is the new item, so a card mounted again changes from the right one. */
  id?: string;
  letter: string;
  message: string;
  at: number;
}

/** "Picked A · Notified <leader> · 21:05". Falls back to the server message when nobody was notified. */
export function chosenLine(chosen: ChosenState): string {
  const time = new Date(chosen.at);
  const clock = `${String(time.getHours()).padStart(2, "0")}:${String(time.getMinutes()).padStart(2, "0")}`;
  const notified = NOTIFIED_RE().exec(chosen.message);
  const who = notified?.slice(1).find(Boolean);
  const middle = who ? t("decisions.card.notified", { who }) : chosen.message.replace(RECORDED_RE(), "").trim();
  return middle
    ? t("decisions.card.chosen", { letter: chosen.letter, middle, clock })
    : t("decisions.card.chosenShort", { letter: chosen.letter, clock });
}

/** Server replies end with "Notified <who>" in some language; the panel shows who, in its own language. */
const NOTIFIED_RE = lazy(() => new RegExp(`${templatePattern("decisions.card.notified", { who: "(.+?)" })}\\s*$`));
const RECORDED_RE = lazy(() => new RegExp(`^${anyWord("decisions.parse.recorded")}[${punct(":")}]?\\s*`));
