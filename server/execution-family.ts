/** Stable execution facts take precedence over editable profile/run family labels. */
export interface ExecutionFacts {
  provider?: string | null;
  model?: string | null;
  family?: string | null;
}

/** Shared with Google admission: provider/model aliases cannot be hidden by a family label. */
export function hasGoogleFacts(facts: ExecutionFacts): boolean {
  return /antigravity|gemini|google|vertex|(?:^|[-_/])agy(?:$|[-_/])/i.test(facts.provider ?? "")
    || /gemini/i.test(facts.model ?? "");
}

export function executionFamily(facts: ExecutionFacts): string | null {
  const provider = (facts.provider ?? "").trim().toLowerCase().split("/")[0];
  const model = (facts.model ?? "").trim().toLowerCase();
  // Google facts are never relabelled as a different family. Admission/safety remains in fleet routing.
  if (hasGoogleFacts(facts)) return "google";
  const byProvider = provider === "codex" || provider === "openai" ? "openai"
    : provider === "claude" || provider === "anthropic" ? "anthropic"
    : provider === "grok" || provider === "xai" ? "xai" : null;
  const byModel = /^(?:gpt|codex)(?:[-.]|$)/.test(model) ? "openai"
    : /^claude(?:[-.]|$)/.test(model) ? "anthropic"
    : /^grok(?:[-.]|$)/.test(model) ? "xai" : null;
  if (byProvider && byModel && byProvider !== byModel) return null;
  return byProvider ?? byModel ?? (facts.family?.trim().toLowerCase() || null);
}
