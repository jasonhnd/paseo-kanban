/** Option letters and one-line phrases for a homepage decision. Both come from the same parser as the card buttons. */
import { parseDecisionCard } from "./decision-card";

export { normalizeChoiceText } from "./decision-card";

const EXCERPT_MAX = 80;

/** Letters A–D that the card shows as options. Empty when the text never writes them — no A/B/C fallback. */
export function decisionChoices(title: string, detail: string): string[] {
  return parseDecisionCard(title, detail).options.map((option) => option.letter);
}

/** The option text for one letter, as stored in the decision note. Same cut-off as the button text. */
export function choiceExcerpt(title: string, detail: string, letter: string): string {
  if (!/^[A-D]$/.test(letter)) return "";
  const option = parseDecisionCard(title, detail).options.find((row) => row.letter === letter);
  return option ? option.rawText.slice(0, EXCERPT_MAX) : "";
}
