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
  // Compatibility publication only caps an unauthorized max; quality defaults now
  // come from the same table used by G2, rather than a second tier/depth ladder.
  const candidates = qualifiedCandidates({ role: input.review ? "reviewer" : input.role,
    tier: input.tier && QUALIFICATION_TIERS.has(input.tier) ? input.tier : "L2", cardType: input.role, reworkCount: 0 });
  return candidates.find(row => row.provider === input.provider && row.model === input.model)?.effort
    ?? candidates.find(row => row.model === "gpt-6.1-sol")?.effort ?? "high";
}

/** Quality admission for quota routing. The matrix still owns live profile identity/order. */
export const QUALIFIED_EFFORTS = ["low", "medium", "high", "xhigh"] as const;
export type QualifiedEffort = typeof QUALIFIED_EFFORTS[number] | "max";
export type QualifiedTier = "L1" | "L2" | "L3" | "L4";
export type QualifiedRole = "executor" | "reviewer" | "reader" | "decision" | "batch"
  | "ops_vercel" | "ops_cloudflare" | "ops_github" | "ops_notion" | "ops";
export interface QualificationRule {
  provider: string;
  model: string;
  efforts: Array<typeof QUALIFIED_EFFORTS[number]>;
  /** Permission to honor a card's max request, never a default depth. */
  allowExplicitMax?: boolean;
}
export type QualificationTable = Partial<Record<QualifiedRole, Partial<Record<QualifiedTier, QualificationRule[]>>>>;
export interface QualifiedCandidate { provider: string; model: string; effort: QualifiedEffort }
export interface QualificationInput {
  role: string;
  tier: string;
  cardType: string;
  reworkCount: number;
  explicitEffort?: string | null;
}
export interface QualificationOverrides { global?: QualificationTable; project?: QualificationTable }

const rule = (provider: string, model: string, efforts: QualificationRule["efforts"], allowExplicitMax = false): QualificationRule =>
  ({ provider, model, efforts, ...(allowExplicitMax ? { allowExplicitMax: true } : {}) });
const solRule = (efforts: QualificationRule["efforts"]) => rule("codex", "gpt-6.1-sol", efforts, true);
const lunaRule = (efforts: QualificationRule["efforts"]) => rule("codex", "gpt-6-luna", efforts);
const grokRule = (efforts: QualificationRule["efforts"]) => rule("grok", "grok-4.7", efforts);
// Model ids are exact. Installations with different ids replace the affected cells.
const sonnetRule = (efforts: QualificationRule["efforts"]) => rule("claude", "claude-sonnet-5-5", efforts);
const opusRule = (efforts: QualificationRule["efforts"]) => rule("claude", "claude-opus-5-5", efforts);
const fableRule = (efforts: QualificationRule["efforts"]) => rule("claude", "claude-fable-5-1", efforts);
const lightRules = () => [lunaRule(["low", "medium", "high"]), grokRule(["low", "medium", "high"]), solRule(["medium", "high", "xhigh"]), sonnetRule(["low", "medium", "high"])];
const highRules = () => [solRule(["high", "xhigh"]), grokRule(["high", "xhigh"]), opusRule(["high", "xhigh"])];
const lowReview = (start: "low" | "medium") => [lunaRule(["high"]), grokRule(start === "low" ? ["low", "medium", "high"] : ["medium", "high"]),
  solRule(["high", "xhigh"]), rule("codex", "gpt-6-sol", ["high", "xhigh"]), sonnetRule(["medium", "high"])];
const highReview = () => [...highRules(), lunaRule(["high"]), rule("codex", "gpt-6-sol", ["high", "xhigh"])];
const opsRules = () => [lunaRule(["low"]), grokRule(["low"])];
const dedicatedOpsTiers = () => Object.fromEntries(["L1", "L2", "L3", "L4"].map(tier => [tier, [sonnetRule(["low"])]]));
const readerLowRules = () => lightRules().map(row => row.provider === "claude" ? { ...row, model: "claude-sonnet-5-5[1m]" } : row);
const readerHighRules = () => [...highRules(), rule("claude", "claude-sonnet-5-5[1m]", ["high"])];

/** Shipped quality floor; Claude rows are fallback candidates for the pool-selection step. */
export const DEFAULT_QUALIFICATION: QualificationTable = {
  executor: {
    L1: lightRules(),
    L2: [solRule(["medium", "high", "xhigh"]), grokRule(["medium", "high"]), sonnetRule(["medium", "high"])],
    L3: [solRule(["high", "xhigh"]), grokRule(["high", "xhigh"]), sonnetRule(["high"]), opusRule(["high", "xhigh"])],
    L4: [solRule(["high", "xhigh"])],
  },
  reviewer: { L1: lowReview("low"), L2: lowReview("medium"), L3: [...highReview(), sonnetRule(["high"])], L4: [...highReview(), fableRule(["high"])] },
  reader: { L1: readerLowRules(), L2: readerLowRules(), L3: readerHighRules(), L4: readerHighRules() },
  decision: {
    L1: [solRule(["medium", "high", "xhigh"]), grokRule(["medium", "high"]), opusRule(["medium", "high", "xhigh"]), fableRule(["high"])],
    L2: [solRule(["medium", "high", "xhigh"]), grokRule(["medium", "high"]), opusRule(["medium", "high", "xhigh"]), fableRule(["high"])],
    L3: [...highRules(), fableRule(["high"])], L4: [...highRules(), fableRule(["high"])],
  },
  batch: { L1: lightRules(), L2: [lunaRule(["medium", "high"]), grokRule(["medium", "high"]), solRule(["medium", "high", "xhigh"]), sonnetRule(["medium", "high"])], L3: [...highRules(), sonnetRule(["high"])], L4: [...highRules(), sonnetRule(["high"])] },
  ops: { L1: opsRules(), L2: opsRules(), L3: opsRules(), L4: opsRules() },
  ops_vercel: dedicatedOpsTiers(),
  ops_cloudflare: dedicatedOpsTiers(),
  ops_github: dedicatedOpsTiers(),
  ops_notion: dedicatedOpsTiers(),
};
for (const tiers of Object.values(DEFAULT_QUALIFICATION)) {
  for (const rows of Object.values(tiers)) {
    for (const row of rows) { Object.freeze(row.efforts); Object.freeze(row); }
    Object.freeze(rows);
  }
  Object.freeze(tiers);
}
Object.freeze(DEFAULT_QUALIFICATION);
const QUALIFICATION_ROLES = new Set<string>(["executor", "reviewer", "reader", "decision", "batch", "ops_vercel", "ops_cloudflare", "ops_github", "ops_notion", "ops"]);
const QUALIFICATION_TIERS = new Set(["L1", "L2", "L3", "L4"]);

/** Fail closed rather than silently widening admission on a malformed configured cell. */
export function parseQualification(value: unknown): QualificationTable {
  const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
  if (!object(value)) throw new Error("qualification: expected a role table");
  const result: QualificationTable = {};
  for (const [role, tiers] of Object.entries(value)) {
    if (!QUALIFICATION_ROLES.has(role) || !object(tiers)) throw new Error(`qualification: invalid role ${role}`);
    const parsed: Partial<Record<QualifiedTier, QualificationRule[]>> = {};
    for (const [tier, rows] of Object.entries(tiers)) {
      if (!QUALIFICATION_TIERS.has(tier) || !Array.isArray(rows)) throw new Error(`qualification: invalid cell ${role}/${tier}`);
      parsed[tier as QualifiedTier] = rows.map(row => {
        if (!object(row) || Object.keys(row).some(key => !["provider", "model", "efforts", "allowExplicitMax"].includes(key))
          || typeof row.provider !== "string" || !row.provider.trim() || typeof row.model !== "string" || !row.model.trim()
          || !Array.isArray(row.efforts) || row.efforts.length === 0 || !row.efforts.every(effort => (QUALIFIED_EFFORTS as readonly unknown[]).includes(effort))
          || (row.allowExplicitMax !== undefined && typeof row.allowExplicitMax !== "boolean")) throw new Error(`qualification: invalid rule ${role}/${tier}`);
        return { provider: row.provider.trim().toLowerCase(), model: row.model.trim().toLowerCase(),
          efforts: [...new Set(row.efforts)] as QualificationRule["efforts"], ...(row.allowExplicitMax !== undefined ? { allowExplicitMax: row.allowExplicitMax } : {}) };
      });
    }
    result[role as QualifiedRole] = parsed;
  }
  return result;
}

/**
 * All allowed model/depth pairs at or above this run's starting depth, smallest first.
 * A return advances one available depth per model; the last qualified depth is the cap.
 * Non-max explicit depth sets a minimum starting point; rework still advances it.
 * No pool ranking, live-profile lookup, quota checks or model-catalog assumptions here.
 */
export function qualifiedCandidates(input: QualificationInput, overrides: QualificationOverrides = {}): QualifiedCandidate[] {
  if (!QUALIFICATION_ROLES.has(input.role) || !QUALIFICATION_TIERS.has(input.tier)
    || !Number.isSafeInteger(input.reworkCount) || input.reworkCount < 0
    || (input.explicitEffort != null && ![...QUALIFIED_EFFORTS, "max"].includes(input.explicitEffort))) return [];
  const operational = operationalExecution({ role: input.role, tags: [input.cardType] });
  const lightOnly = operational || input.role === "ops";
  const dedicatedOps = input.role.startsWith("ops_");
  const lowOnly = lightOnly || dedicatedOps;
  const role = operational ? "ops" : input.role as QualifiedRole;
  const tier = input.tier as QualifiedTier;
  const tables = [overrides.project, overrides.global, DEFAULT_QUALIFICATION];
  const cell = (key: QualifiedRole) => tables.map(table => table?.[key]?.[tier]).find(rows => rows !== undefined);
  const rows = cell(role) ?? (dedicatedOps ? cell("ops") : undefined) ?? [];
  const floor = !lowOnly && ["L3", "L4"].includes(tier) ? 2 : 0;
  const result: QualifiedCandidate[] = [];
  const models = new Map<string, QualificationRule>();
  for (const row of rows) {
    const provider = row.provider.trim().toLowerCase();
    const model = row.model.trim().toLowerCase();
    if (provider === "cursor" || !provider || !model || model.includes("build-fast")
      || (lightOnly && !lightExecutionProfile({ provider, model }))) continue;
    const key = JSON.stringify([provider, model]);
    const previous = models.get(key);
    models.set(key, { provider, model, efforts: [...new Set([...(previous?.efforts ?? []), ...row.efforts])],
      allowExplicitMax: row.allowExplicitMax === true || previous?.allowExplicitMax === true });
  }
  for (const row of models.values()) {
    const { provider, model } = row;
    const efforts = QUALIFIED_EFFORTS.filter((effort, index) => row.efforts.includes(effort) && index >= floor && (!lowOnly || effort === "low"));
    if (efforts.length === 0) continue;
    let allowed: QualifiedEffort[];
    if (lowOnly) allowed = ["low"];
    else if (input.explicitEffort === "max") allowed = row.allowExplicitMax ? ["max"] : [];
    else {
      const requested = input.explicitEffort ? QUALIFIED_EFFORTS.indexOf(input.explicitEffort as typeof QUALIFIED_EFFORTS[number]) : 0;
      const starting = efforts.filter(effort => QUALIFIED_EFFORTS.indexOf(effort) >= requested);
      allowed = starting.slice(Math.min(input.reworkCount, Math.max(0, starting.length - 1)));
    }
    result.push(...allowed.map(effort => ({ provider, model, effort })));
  }
  const order = [...QUALIFIED_EFFORTS, "max"];
  return [...new Map(result.map(row => [JSON.stringify(row), row])).values()]
    .sort((a, b) => order.indexOf(a.effort) - order.indexOf(b.effort));
}
