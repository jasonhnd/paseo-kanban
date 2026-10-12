/// <reference types="node" />
import { zhCN, zhCNPart, localePattern, complexDocsProfileName } from "./helpers/locale";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DispatchMatrix } from "../server/matrix";
import type { PoolSnapshot } from "../server/pools";
import type { Profile } from "../server/profiles";
import { routeProfile } from "../server/routing";
import { cardQueueAlert, quotaWaitLabel } from "../shared/blocked";

const executor: Profile = {
  id: "ex",
  name: zhCN("labels.role.executor"),
  role: "executor",
  family: "xai",
  provider: "cursor",
  model: "grok-4.7",
  pool: "cursor",
};
const other: Profile = {
  id: "sg",
  name: "Executor · Super",
  role: "candidate",
  candidateFor: "executor",
  family: "xai",
  provider: "grok",
  model: "grok-4.7",
  pool: "supergrok",
};
const reviewer: Profile = {
  id: "rv",
  name: zhCN("labels.role.reviewer"),
  role: "reviewer",
  family: "anthropic",
  provider: "claude",
  model: "sonnet",
  pool: "claude-max",
};

function snapshot(pools: Record<string, { dispatchable?: boolean; reason?: string; onlyRoles?: string[] }>): PoolSnapshot {
  return {
    state: "fresh",
    message: "test",
    generatedAt: "2026-10-01T00:00:00.000Z",
    dispatchable: (pool) => pools[pool ?? ""]?.dispatchable !== false,
    hasPool: (pool) => Boolean(pool && Object.prototype.hasOwnProperty.call(pools, pool)),
    entry: (pool) => {
      const row = pool ? pools[pool] : undefined;
      return {
        dispatchable: row?.dispatchable !== false,
        deprioritize: false,
        prefer: false,
        resetsAt: null,
        reason: row?.reason ?? null,
        usedPct: null,
        onlyRoles: row?.onlyRoles ?? null,
      };
    },
  };
}

function route(profiles: Profile[], pools: PoolSnapshot, patch: { role?: string; review?: boolean; matrix?: DispatchMatrix; profileOverride?: string } = {}) {
  return routeProfile({
    profiles,
    role: patch.role ?? "executor",
    review: patch.review ?? false,
    byPool: {},
    poolLimits: {},
    snapshot: pools,
    matrix: patch.matrix,
    profileOverride: patch.profileOverride,
  });
}

describe("quota wait label", () => {
  it("formats headline and does not nest the prefix", () => {
    assert.equal(quotaWaitLabel("cursor", "Ahead of budget"), (zhCN("blocked.prefix.quota") + "cursor" + zhCN("nativeSessions.sweep.reasonSep") + "Ahead of budget"));
    assert.equal(quotaWaitLabel("cursor、supergrok", zhCN("routing.noProfile")), (zhCN("blocked.prefix.quota") + "cursor、supergrok" + zhCN("nativeSessions.sweep.reasonSep") + zhCN("routing.noProfile")));
    assert.equal(quotaWaitLabel(null, ("5 " + zhCNPart("doctor.hours", 8, 10) + zhCNPart("waitingMetrics.badWindow", 2, 4))), (zhCN("blocked.prefix.quota") + zhCN("blocked.quota.noPool") + zhCN("nativeSessions.sweep.reasonSep") + "5 " + zhCNPart("doctor.hours", 8, 10) + zhCNPart("waitingMetrics.badWindow", 2, 4)));
    assert.equal(quotaWaitLabel("cursor", (zhCN("blocked.prefix.quota") + "cursor" + zhCN("nativeSessions.sweep.reasonSep") + "Ahead of budget")), (zhCN("blocked.prefix.quota") + "cursor" + zhCN("nativeSessions.sweep.reasonSep") + "Ahead of budget"));
  });

  it("shows the quota reason on a queued card and keeps other holds as a next step", () => {
    assert.equal(cardQueueAlert("ready", (zhCN("blocked.prefix.quota") + "cursor" + zhCN("nativeSessions.sweep.reasonSep") + "Pool paused")), (zhCN("blocked.prefix.quota") + "cursor" + zhCN("nativeSessions.sweep.reasonSep") + "Pool paused"));
    assert.equal(cardQueueAlert("rework", (zhCN("blocked.prefix.quota") + "claude-max" + zhCN("nativeSessions.sweep.reasonSep") + "5 " + zhCNPart("doctor.hours", 8, 10) + zhCNPart("waitingMetrics.badWindow", 2, 4) + zhCNPart("pools.staleStopped", 20, 22) + " 70%")), (zhCN("blocked.prefix.quota") + "claude-max" + zhCN("nativeSessions.sweep.reasonSep") + "5 " + zhCNPart("doctor.hours", 8, 10) + zhCNPart("waitingMetrics.badWindow", 2, 4) + zhCNPart("pools.staleStopped", 20, 22) + " 70%"));
    assert.equal(cardQueueAlert("ready", zhCN("reworkReassign.waitingAutoStart", {"reason":"Executor concurrency full"})), zhCN("blocked.nextStep", {"step":zhCN("reworkReassign.waitingAutoStart", {reason:"Executor concurrency full"})}));
    assert.equal(cardQueueAlert("blocked", (zhCN("blocked.prefix.quota") + "cursor" + zhCN("nativeSessions.sweep.reasonSep") + "Pool paused")), null);
    assert.equal(cardQueueAlert("in_review", (zhCN("blocked.prefix.external") + "CI")), (zhCN("blocked.prefix.external") + "CI"));
    assert.equal(cardQueueAlert("acceptance", (zhCN("blocked.prefix.external") + "CI\n" + zhCNPart("nativeSessions.kept.leader", 9, 11) + zhCNPart("transientRetry.timeout.send", 4, 6))), (zhCN("blocked.prefix.external") + "CI\n" + zhCNPart("nativeSessions.kept.leader", 9, 11) + zhCNPart("transientRetry.timeout.send", 4, 6)));
    assert.equal(cardQueueAlert("reviewing", (zhCNPart("identityLines.openExecutor", 2, 5) + zhCNPart("transientRetry.timeout.send", 4, 6))), zhCN("blocked.nextStep", {"step":(zhCNPart("identityLines.openExecutor", 2, 5) + zhCNPart("transientRetry.timeout.send", 4, 6))}));
  });
});

describe("routeProfile quota versus permanent", () => {
  const openReview = snapshot({ cursor: { dispatchable: true }, supergrok: { dispatchable: true }, "claude-max": { dispatchable: true } });

  it("holds for a paused pool, over pace, the 5-hour window, and no dispatchable profile", () => {
    const paused = route([executor, reviewer], snapshot({ cursor: { dispatchable: false, reason: "Pool paused" }, "claude-max": { dispatchable: true } }));
    assert.equal(paused.ok, false);
    if (!paused.ok) {
      assert.equal(paused.action, "hold");
      assert.equal(paused.quotaWait, true);
      assert.match(paused.reason, new RegExp("Pool paused"));
    }
    const pace = route([executor, other, reviewer], snapshot({
      cursor: { dispatchable: false, reason: "Ahead of budget" },
      supergrok: { dispatchable: false, reason: "Usage ahead of budget" },
      "claude-max": { dispatchable: true },
    }));
    assert.equal(pace.ok, false);
    if (!pace.ok) {
      assert.equal(pace.action, "hold");
      assert.equal(pace.quotaWait, true);
      assert.equal(pace.pool, "cursor、supergrok");
    }
    const window = route([executor, reviewer], snapshot({
      cursor: { dispatchable: true, onlyRoles: ["reviewer"], reason: "5 hour window reached 70%" },
      "claude-max": { dispatchable: true },
    }));
    assert.equal(window.ok, false);
    if (!window.ok) {
      assert.equal(window.action, "hold");
      assert.equal(window.quotaWait, true);
      assert.match(window.reason, new RegExp(localePattern(zhCNPart("pools.onlyFor", 7, 9)) + zhCN("labels.role.reviewer") + localePattern(zhCNPart("labels.assigner.user", 0, 1))));
    }
  });

  it("does not treat a scope-rule wait as headline", () => {
    const opus: Profile = {
      id: "opus",
      name: complexDocsProfileName,
      role: "candidate",
      candidateFor: "executor",
      family: "anthropic",
      provider: "claude",
      model: "opus",
      pool: "claude-max",
    };
    const decision = routeProfile({
      profiles: [opus, reviewer],
      role: "executor",
      review: false,
      byPool: {},
      poolLimits: {},
      snapshot: openReview,
      project: "demo_board",
      tags: [],
      rules: {
        [complexDocsProfileName]: { tags: ["complex-docs"] },
      },
    });
    assert.equal(decision.ok, false);
    if (!decision.ok) {
      assert.equal(decision.action, "hold");
      assert.equal(decision.quotaWait, undefined);
      assert.match(decision.reason, new RegExp(localePattern(zhCNPart("routing.ruleWaitHead", 0, 8))));
    }
  });

  it("blocks needs_human only when every candidate is permanently unavailable", () => {
    const loggedOut = route([executor, reviewer], snapshot({
      cursor: { dispatchable: false, reason: "Not logged in" },
      "claude-max": { dispatchable: true },
    }));
    assert.equal(loggedOut.ok, false);
    if (!loggedOut.ok) {
      assert.equal(loggedOut.action, "block");
      assert.equal(loggedOut.kind, "needs_human");
      assert.equal(loggedOut.quotaWait, undefined);
    }
    const mixed = route([executor, other, reviewer], snapshot({
      cursor: { dispatchable: false, reason: "Not logged in" },
      supergrok: { dispatchable: false, reason: "Ahead of budget" },
      "claude-max": { dispatchable: true },
    }));
    assert.equal(mixed.ok, false);
    if (!mixed.ok) {
      assert.equal(mixed.action, "hold");
      assert.equal(mixed.quotaWait, true);
      assert.notEqual(mixed.kind, "needs_human");
    }
    const matrix: DispatchMatrix = {
      version: 1,
      generatedAt: null,
      defaultTier: "L2",
      downgradeWhenTight: ["L1", "L2"],
      executor: { L2: [{ profile: ((zhCN("labels.role.executor") + " ") + "· " + zhCNPart("compactEvents.verb.deleted", 0, 2)), effort: "high", paused: false }] },
      reviewerFamilies: { xai: { L2: [{ profile: zhCN("labels.role.reviewer"), effort: "high", paused: false }] } },
      star: {},
    };
    const missing = route([reviewer], openReview, { matrix, role: "executor" });
    assert.equal(missing.ok, false);
    if (!missing.ok) {
      assert.equal(missing.action, "block");
      assert.equal(missing.kind, "needs_human");
      assert.match(missing.reason, new RegExp(zhCN("routing.profileMissing")));
    }
    const missingAndPaused: DispatchMatrix = {
      ...matrix,
      executor: {
        L2: [
          { profile: ((zhCN("labels.role.executor") + " ") + "· " + zhCNPart("compactEvents.verb.deleted", 0, 2)), effort: "high", paused: false },
          { profile: zhCN("labels.role.executor"), effort: "high", paused: false },
        ],
      },
    };
    const recoverable = route([executor, reviewer], snapshot({
      cursor: { dispatchable: false, reason: "Pool paused" },
      "claude-max": { dispatchable: true },
    }), { matrix: missingAndPaused });
    assert.equal(recoverable.ok, false);
    if (!recoverable.ok) {
      assert.equal(recoverable.action, "hold");
      assert.equal(recoverable.quotaWait, true);
      assert.notEqual(recoverable.kind, "needs_human");
    }
  });
});
