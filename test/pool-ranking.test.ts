import assert from "node:assert/strict";
import { test } from "node:test";
import { rankPools, poolAllowedTiers, type RankingPool } from "../shared/fleet/pool-ranking";

const now = Date.parse("2030-06-01T12:00:00Z");
const day = 86_400_000;
const iso = (days: number) => new Date(now + days * day).toISOString();
const row = (extra: Partial<RankingPool> = {}): RankingPool => ({ dispatchable: true, state: "known",
  usedPct: 10, resetsAt: iso(6), forecastConfidence: "high", projectedPct: 40, runsOutAt: null, ...extra });
const rank = (pools: Record<string, RankingPool>, tier = "L4", extra = {}) => rankPools({ pools, now, tier, role: "executor", ...extra });

// Reproduce the design's observed usage without embedding production clocks or account data.
const realCase = () => ({ "codex-pro": row({ usedPct: 9, projectedPct: 350, runsOutAt: iso(1) }),
  "x-ultra": row({ reservePct: 0, usedPct: 16, resetsAt: iso(2), projectedPct: 30 }),
  "claude-max": row({ usedPct: 3 }), cursor: row({ usedPct: 0, resetsAt: iso(1) }) });

test("near-reset Grok leads; forecast exhaustion keeps Codex for L3/L4; Claude is fallback", () => {
  const pools = realCase();
  assert.deepEqual(rank(pools).map(r => r.pool), ["x-ultra", "codex-pro"]);
  assert.deepEqual(poolAllowedTiers(pools["codex-pro"], now), ["L3", "L4"]);
  assert.deepEqual(rank(pools, "L2").map(r => r.pool), ["x-ultra"]);
  assert.match(rank(pools)[0].reason, /84|64/);
  assert.ok(rank(pools)[0].score > rank(pools)[1].score);
});

test("reserve is enforced even for difficult work; custom reserves and reset urgency affect scores", () => {
  assert.deepEqual(rank({ "codex-pro": row({ usedPct: 80 }) }), []);
  assert.equal(rank({ "codex-pro": row({ usedPct: 80, reservePct: 10 }) }).length, 1);
  assert.deepEqual(rank({ demo: row({ usedPct: 40, reservePct: 60 }) }), []);
  assert.deepEqual(rank({ later: row({ usedPct: 0, resetsAt: iso(6) }), soon: row({ usedPct: 40, resetsAt: iso(1) }) }).map(r => r.pool), ["soon", "later"]);
  for (const reservePct of [NaN, -1, 101]) assert.equal(rank({ "codex-pro": row({ usedPct: 80, reservePct }) }).length, 0);
});

test("unknown quota uses G1d tiers and pool-wide capacity, never scores as a full pool", () => {
  const unknown = row({ reservePct: 0, state: "unknown", usedPct: 0, activeRuns: 0 });
  assert.deepEqual(rank({ "x-ultra": unknown }), []);
  assert.deepEqual(rank({ "x-ultra": unknown }, "L1")[0].allowedTiers, ["L1", "L2"]);
  assert.equal(rank({ "x-ultra": { ...unknown, activeRuns: 1 } }, "L1").length, 0);
  assert.equal(rank({ "x-ultra": { ...unknown, unknownQuota: { maxConcurrent: 2, tiers: ["L2"], maxAgeMs: 1000 }, activeRuns: 1 } }, "L2").length, 1);
  assert.deepEqual(rank({ "x-ultra": row({ quotaStateExpiresAt: new Date(now).toISOString() }) }), []);
  assert.equal(rank({ "x-ultra": unknown }, "L1")[0].score, 0);
  assert.equal(rank({ "x-ultra": row({ usedPct: null }) }, "L1")[0].score, 0);
});

test("legacy pool pins canonicalize without admitting Cursor channels or bypassing hard/role limits", () => {
  const pools = { ...realCase(), renamed: row({ providers: ["cursor"] }), closed: row({ dispatchable: false }),
    reviewOnly: row({ onlyRoles: ["reviewer"] }) };
  const dispatchPriority = { order: ["cursor", "renamed", "closed", "reviewOnly", "claude-max", "codex-pro", "x-ultra"], until: iso(1) };
  assert.deepEqual(rank(pools, "L4", { dispatchPriority }).map(r => r.pool), ["x-ultra", "codex-pro"]);
  assert.deepEqual(rank(pools, "L2", { dispatchPriority }).map(r => r.pool), ["x-ultra"]);
  assert.equal(rank({ "claude-max": row(), "x-ultra": row({ dispatchable: false }) })[0].pool, "claude-max");
  assert.equal(rank({ alias: row({ adapter: "claude-cli" }), "x-ultra": row({ reservePct: 0 }) }).some(r => r.pool === "alias"), false);
});

test("explicit user pin overrides scores only within safe candidates; expiry restores auto order", () => {
  const pools = realCase();
  assert.equal(rank(pools, "L4", { dispatchPriority: { order: ["codex-pro", "x-ultra"], until: iso(1) } })[0].pool, "codex-pro");
  assert.equal(rank(pools, "L4", { dispatchPriority: { order: ["codex-pro", "x-ultra"], until: new Date(now).toISOString() } })[0].pool, "x-ultra");
});

test("expired cycles stay unknown until fresh evidence; fresh reset removes the forecast brake", () => {
  const spent = row({ projectedPct: 350, runsOutAt: iso(-1), resetsAt: iso(-0.01) });
  assert.deepEqual(poolAllowedTiers(spent, now), ["L1", "L2"]);
  const fresh = row({ usedPct: 0, forecastConfidence: "none", projectedPct: null, runsOutAt: null, resetsAt: iso(7) });
  assert.deepEqual(poolAllowedTiers(fresh, now), ["L1", "L2", "L3", "L4"]);
  assert.equal(rank({ "codex-pro": fresh }, "L1").length, 1);
  assert.deepEqual(poolAllowedTiers(row({ forecastConfidence: "none", projectedPct: 350, runsOutAt: iso(1) }), now), ["L1", "L2", "L3", "L4"]);
  assert.deepEqual(poolAllowedTiers(row({ projectedPct: 100 }), now), ["L1", "L2", "L3", "L4"]);
  assert.deepEqual(poolAllowedTiers(row({ projectedPct: 101 }), now), ["L3", "L4"]);
});

test("missing reset gets no urgency, ties are deterministic and input stays immutable", () => {
  const pools = { z: row(), a: row(), noReset: row({ resetsAt: null }) };
  const before = structuredClone(pools);
  assert.deepEqual(rank(pools).map(r => r.pool), ["a", "z", "noReset"]);
  assert.deepEqual(pools, before);
  assert.deepEqual(rank(pools, "unknown-tier"), []);
});

test("sub pools cannot bypass parent reserves, roles, capacity or forecast tiers", () => {
  const sub = row({ parent: "main" });
  assert.equal(rank({ main: row({ usedPct: 80, reservePct: 20 }), sub }).length, 0);
  assert.deepEqual(rank({ main: row({ projectedPct: 300 }), sub }, "L1"), []);
  const ranked = rank({ main: row({ projectedPct: 300 }), sub });
  assert.deepEqual(ranked.find(r => r.pool === "sub")!.allowedTiers, ["L3", "L4"]);
  assert.deepEqual(rank({ sub }), []);
  assert.deepEqual(rank({ main: row({ onlyRoles: ["reviewer"] }), sub }), []);
});

test("catalog metadata supports renamed pools and configured reserve values", async () => {
  const { withPoolRankingMetadata } = await import("../shared/fleet/pool-ranking");
  const pools = { demo: row({ usedPct: 80 }), renamed: row(), "claude-fable": row() };
  const plans = [{ id: "demo", providers: ["codex"], reservePct: 10 }, { id: "renamed", providers: ["cursor"] },
    { id: "backup", adapter: "claude-cli", reservePct: 35 }];
  const enriched = withPoolRankingMetadata(pools, plans, { demo: 2 });
  assert.equal(enriched.demo.reservePct, 10);
  assert.equal(enriched.demo.activeRuns, 2);
  assert.equal(enriched["claude-fable"].parent, "backup");
  assert.deepEqual(rank(enriched).map(r => r.pool), ["demo"]);
});

test("parent evidence can be retained without selecting an ineligible model pool", () => {
  const pools = { main: row({ eligible: false }), sub: row({ parent: "main" }) };
  assert.deepEqual(rank(pools).map(r => r.pool), ["sub"]);
  assert.deepEqual(rank({ ...pools, main: row({ eligible: false, usedPct: 100 }) }), []);
  assert.deepEqual(rank({ main: row({ eligible: false }), "claude-max": row() }).map(r => r.pool), ["claude-max"]);
});

test("Claude sub pools have no default reserve but still obey the main pool and their hard stop", () => {
  const pools = { "claude-max": row({ usedPct: 40 }), "claude-fable": row({ usedPct: 80, parent: "claude-max" }) };
  assert.deepEqual(new Set(rank(pools).map(r => r.pool)), new Set(["claude-max", "claude-fable"]));
  assert.deepEqual(rank({ ...pools, "claude-max": row({ usedPct: 80 }) }), []);
  assert.deepEqual(rank({ ...pools, "claude-fable": { ...pools["claude-fable"], usedPct: 97, dispatchable: false } }).map(r => r.pool), ["claude-max"]);
});

test("caller reserves retain Claude double-week, burn-week and reviewer exception capacity", () => {
  for (const reservePct of [10, 0]) {
    assert.equal(rank({ "claude-max": row({ usedPct: 80, reservePct }) })[0].pool, "claude-max");
  }
  const pools = { "claude-max": row({ usedPct: 78, reservePct: 2, onlyRoles: ["reviewer"] }) };
  assert.equal(rank(pools, "L4", { role: "reviewer" })[0].pool, "claude-max");
  assert.deepEqual(rank(pools), []);
});

test("metadata preserves computed per-pool reserves and applies plan reserves only to main pools", async () => {
  const { withPoolRankingMetadata } = await import("../shared/fleet/pool-ranking");
  const pools = { "claude-max": row({ usedPct: 80, reservePct: 10 }), "claude-fable": row({ usedPct: 80, reservePct: 0 }) };
  const plan = { id: "claude-max", providers: ["claude"] };
  const before = structuredClone(pools);
  for (const config of [plan, { ...plan, reservePct: 25 }]) {
    const enriched = withPoolRankingMetadata(pools, [config]);
    assert.equal(enriched["claude-max"].reservePct, 10);
    assert.equal(enriched["claude-fable"].reservePct, 0);
    assert.deepEqual(new Set(rank(enriched).map(r => r.pool)), new Set(["claude-max", "claude-fable"]));
  }
  assert.deepEqual(pools, before);
  const unconfigured = { "claude-max": row({ usedPct: 40 }), "claude-fable": row({ usedPct: 80 }) };
  const enriched = withPoolRankingMetadata(unconfigured, [{ ...plan, reservePct: 35 }]);
  assert.equal(enriched["claude-max"].reservePct, 35);
  assert.equal(enriched["claude-fable"].reservePct, undefined);
  assert.equal(rank(enriched).some(r => r.pool === "claude-fable"), true);
});
