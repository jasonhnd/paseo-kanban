// Optional hide list from afc.config.json. Empty means every plan is shown.
// Matching is a case-insensitive substring, so a public build hides nothing until configured.

/** Terms from `{ "hiddenPlans": ["gemini"] }`. Missing, unreadable, or non-strings become an empty list. */
export function hiddenPlanTerms(raw: unknown): string[] {
  const list = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as { hiddenPlans?: unknown }).hiddenPlans : undefined;
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const item of list) {
    if (typeof item !== "string") continue;
    const term = item.trim().toLowerCase();
    if (term && !out.includes(term)) out.push(term);
  }
  return out;
}

/** True when `text` contains any term. An empty term list hides nothing. */
export function textHidden(text: string, terms: readonly string[]): boolean {
  if (terms.length === 0) return false;
  const hay = text.toLowerCase();
  return terms.some((term) => hay.includes(term));
}
