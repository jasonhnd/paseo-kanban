import { LANGUAGES, translate } from "../shared/i18n";

export const WAKE_SUMMARY_MAX = 300;

/** The Chinese "next step:" line prefix of wakes written before the catalogs existed. */
const LEGACY_NEXT_PREFIX = "\u4e0b\u4e00\u6b65\uff1a";

/** Prefixes of the wake "next step" line (wake.line.next) in every shipped language, plus the legacy one. */
function nextPrefixes(): string[] {
  return [...new Set([...LANGUAGES.map((language) => translate(language, "wake.line.next", { next: "" })), LEGACY_NEXT_PREFIX])];
}

/**
 * What a wake event keeps of the message it sent: the card line and the next step, capped.
 * The full text (handoff included) goes to the receiver only; the event log never stores it.
 */
export function wakeSummary(text: string): string {
  const lines = text.split("\n");
  const prefixes = nextPrefixes();
  const next = lines.find((line) => prefixes.some((prefix) => line.startsWith(prefix)));
  const summary = [lines[0], next].filter((line): line is string => Boolean(line)).join(" | ");
  return summary.length > WAKE_SUMMARY_MAX ? `${summary.slice(0, WAKE_SUMMARY_MAX - 1)}…` : summary;
}
