/** Card types are explicit when tagged; only untyped cards use conservative title/brief hints. */
const OPS_TAGS = new Set(["ops", "operations", "deploy", "deployment", "wait", "data-move", "data-migration", "release", "release-rehearsal", "maintenance"]);
export interface ExecutionContext { role: string; review?: boolean; tags?: readonly string[]; title?: string; brief?: string }
export function operationalExecution(input: ExecutionContext): boolean {
  if (input.review || !["executor", "batch"].includes(input.role)) return false;
  const tags = (input.tags ?? []).map(tag => tag.trim().toLowerCase());
  if (tags.some(tag => OPS_TAGS.has(tag))) return true;
  if (tags.some(tag => ["code", "hard-code"].includes(tag))) return false;
  const title = input.title?.trim() ?? "";
  return /^(?:(?:preview|pre|production|staging):\s*)?(?:deploy(?:ment)?|wait|move data|data (?:move|migration)|release rehearsal|operations|maintenance)\b/i.test(title)
    || /^(?:\u90e8\u7f72|\u53d1\u5e03\u6f14\u7ec3|\u7b49\u5f85|\u642c\u6570\u636e|\u6570\u636e\u8fc1\u79fb|\u8fd0\u7ef4)/.test(title)
    || /^(?:task type|type):\s*(?:ops|deploy|wait|data-move|release-rehearsal)\b/im.test(input.brief ?? "");
}

/** Exact Luna or a configured Grok route; another GPT model cannot masquerade as Luna. */
export function lightExecutionProfile(profile: { provider?: string; model?: string | null }): boolean {
  return (profile.provider === "codex" && profile.model?.trim().toLowerCase() === "gpt-6-luna")
    || (profile.provider === "grok" || profile.provider === "cursor") && /^grok-/i.test(profile.model ?? "");
}

/** Operations run low; max is an explicit per-card request, never a matrix/profile default. */
export function gptExecutionEffort(input: ExecutionContext & {
  provider?: string; family?: string | null; model?: string | null;
  effort: string | null; tier?: string | null; explicit?: boolean;
}): string | null {
  if (operationalExecution(input)) return "low";
  const requested = !input.review && ["executor", "batch"].includes(input.role) && input.tags?.includes("needs-max");
  if (requested && !input.explicit) return "max";
  if (input.explicit) return input.effort;
  if (input.effort !== "max") return input.effort;
  if (input.review || input.role === "reviewer") return "high";
  if (input.role === "executor") return input.tier === "L1" || input.tier === "L2" ? "medium" : input.tier === "L3" ? "high" : "xhigh";
  return input.role === "batch" ? "medium" : "high";
}
