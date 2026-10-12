import { DispatchMatrix, PoolStatus, envelopeFor, type PoolState } from "../../server/contract";
import { policyDigest, publishPolicySnapshot } from "../../server/application/policy-snapshot";

/** Explicit anonymous policy setup for real default consumers; no legacy admission fallback. */
export function publishAnonymousPolicy(matrix: Record<string, unknown>, pools: Record<string, Partial<PoolState>>, at = Date.now()) {
  const date = new Date(at);
  const digest = policyDigest();
  return publishPolicySnapshot({
    policyDigest: digest,
    pools: PoolStatus.parse({ ...envelopeFor("poolStatus", "0", date), quotaConfigured: true, priority: null,
      pools: Object.fromEntries(Object.entries(pools).map(([name, value]) => [name, {
        dispatchable: true, prefer: false, deprioritize: false, usedPct: 10, resetsAt: null,
        onlyRoles: null, reason: null, quotaProtection: "none", ...value,
      }])) }),
    matrix: DispatchMatrix.parse({ ...envelopeFor("dispatchMatrix", "0", date), version: 1,
      defaultTier: "L2", downgradeWhenTight: ["L1", "L2"], ...matrix, generatedAt: date.toISOString() }),
  }, digest);
}
