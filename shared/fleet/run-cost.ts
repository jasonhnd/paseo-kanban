import { canonicalPoolId } from "./x-ultra";
/** Durable observations. Null means unavailable, never an invented zero. */
export interface RunCost {
  cardCode: string;
  runId: number;
  role: string;
  tier: string;
  cardType: string;
  pool: string | null;
  provider: string | null;
  model: string | null;
  effort: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  tokensCached: number | null;
  quotaPctBefore: number | null;
  quotaPctAfter: number | null;
  quotaPctDelta: number | null;
  wallMs: number;
  turns: number | null;
  source: "measured" | "partial" | "unknown";
  finishedAt: string;
  notes: string[];
  quotaObservedBefore: string | null;
  quotaObservedAfter: string | null;
}
export interface CostQuery { model: string; effort: string | null; cardType: string; role?: string; tier?: string; pool?: string }
export interface CostEstimate {
  avgQuotaPct: number | null;
  /** Input includes cached input, as in the run-budget collector. */
  avgTokens: number | null;
  samples: number;
  quotaSamples: number;
  tokenSamples: number;
}
const number = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
const same = (a: unknown, b: unknown) => typeof a === "string" && typeof b === "string"
  ? a.trim().toLowerCase() === b.trim().toLowerCase() : a === b;

/** Accept old/absent files without interpreting profile-only historical stats as measurements. */
export function estimateRunCost(records: readonly unknown[], query: CostQuery): CostEstimate {
  let tokens = 0, quota = 0, samples = 0, tokenSamples = 0, quotaSamples = 0;
  const seen = new Set<number>();
  for (const raw of records) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Partial<RunCost>;
    if (!number(row.runId) || seen.has(row.runId) || !["measured", "partial", "unknown"].includes(row.source ?? "")
      || !same(row.model, query.model) || !same(row.effort, query.effort) || row.cardType !== query.cardType
      || query.pool !== undefined && canonicalPoolId(row.pool) !== canonicalPoolId(query.pool)
      || query.role !== undefined && row.role !== query.role || query.tier !== undefined && row.tier !== query.tier) continue;
    seen.add(row.runId); samples++;
    if (number(row.tokensIn) && number(row.tokensOut)) { tokens += row.tokensIn + row.tokensOut; tokenSamples++; }
    if (number(row.quotaPctDelta)) { quota += row.quotaPctDelta; quotaSamples++; }
  }
  return { avgQuotaPct: quotaSamples ? quota / quotaSamples : null, avgTokens: tokenSamples ? tokens / tokenSamples : null,
    samples, quotaSamples, tokenSamples };
}

/** Primary dimensions for G2; optional role/tier filters are computed from records. */
export function summarizeRunCosts(records: readonly RunCost[]): Array<CostQuery & CostEstimate> {
  const groups = new Map<string, CostQuery>();
  for (const row of records) {
    if (!row.model) continue;
    const query = { model: row.model.trim().toLowerCase(), effort: row.effort?.trim().toLowerCase() ?? null, cardType: row.cardType };
    groups.set(JSON.stringify(query), query);
  }
  return [...groups.values()].map(query => ({ ...query, ...estimateRunCost(records, query) }));
}
