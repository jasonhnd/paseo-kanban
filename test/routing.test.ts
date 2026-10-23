/// <reference types="node" />
import { zhCN, zhCNPart, localePattern, complexDocsProfileName, highRiskProfileName } from "./helpers/locale";
import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig } from "../server/config";
import { closeDb } from "../server/db";
import { DEMO_FAMILIES, DEMO_BANNED } from "./helpers/dispatch-policy";
import type { DispatchMatrix } from "../server/matrix";
import type { PoolSnapshot } from "../server/pools";
import type { Profile } from "../server/profiles";
import { DEMO_PROFILE_RULES as DEFAULT_PROFILE_RULES } from "./helpers/dispatch-policy";
import { cursorReadonlyReason, routeProfile, type RouteInput } from "../server/routing";

const policyDir = mkdtempSync(join(tmpdir(), "routing-policy-"));
process.env.KANBAN_DATA_DIR = policyDir;
beforeEach(() => saveConfig({ ...loadConfig(), autoStart: {}, supervisors: {}, families: DEMO_FAMILIES, bannedProviders: DEMO_BANNED }));
after(() => { closeDb(); rmSync(policyDir, { recursive: true, force: true }); });

const executor: Profile = {
  id: "ex",
  name: zhCN("labels.role.executor"),
  role: "executor",
  family: "xai",
  provider: "grok",
  model: "grok-4.7",
  pool: "supergrok",
};
const alternate: Profile = {
  id: "cur",
  name: "Executor · Alternate",
  role: "candidate",
  candidateFor: "executor",
  family: "xai",
  provider: "alternate",
  model: "grok-4.7",
  pool: "alternate",
};
const opus: Profile = {
  id: "opus",
  name: complexDocsProfileName,
  role: "candidate",
  candidateFor: "executor",
  family: "anthropic",
  provider: "claude",
  model: "claude-opus-5-5",
  pool: "claude-max",
};
const claudeExec: Profile = {
  id: "cex",
  name: "Executor · Claude",
  role: "executor",
  family: "anthropic",
  provider: "claude",
  model: "sonnet",
  pool: "claude-max",
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
const xaiReview: Profile = {
  id: "xrv",
  name: "Reviewer · Grok",
  role: "candidate",
  candidateFor: "reviewer",
  family: "xai",
  provider: "grok",
  model: "grok-4.7",
  pool: "supergrok",
};
const codex: Profile = {
  id: "cx",
  name: "Reviewer · Codex",
  role: "candidate",
  candidateFor: "reviewer",
  family: "openai",
  provider: "codex",
  model: "demo-v2",
  pool: "codex-pro",
};

type PoolRow = {
  dispatchable?: boolean;
  deprioritize?: boolean;
  prefer?: boolean;
  resetsAt?: string;
  reason?: string;
  onlyRoles?: string[] | null;
};

function snapshot(pools: Record<string, PoolRow>, state: PoolSnapshot["state"] = "fresh", message = "test"): PoolSnapshot {
  return {
    state,
    message,
    generatedAt: null,
    dispatchable: (pool) => pools[pool ?? ""]?.dispatchable !== false,
    hasPool: (pool) => Boolean(pool && Object.prototype.hasOwnProperty.call(pools, pool)),
    entry: (pool) => {
      const row = pool ? pools[pool] : undefined;
      if (!row) return { dispatchable: true, deprioritize: false, prefer: false, resetsAt: null, reason: null, onlyRoles: null };
      return {
        dispatchable: row.dispatchable !== false,
        deprioritize: row.deprioritize === true,
        prefer: row.prefer === true,
        resetsAt: row.resetsAt ?? null,
        reason: row.reason ?? null,
        onlyRoles: row.onlyRoles && row.onlyRoles.length > 0 ? row.onlyRoles : null,
      };
    },
  };
}

const open = snapshot({
  alternate: { dispatchable: true },
  supergrok: { dispatchable: true },
  "claude-max": { dispatchable: true },
  "codex-pro": { dispatchable: true },
});

describe("routeProfile", () => {
  for (const selection of ["roster", "override", "matrix", "matrix override"]) {
    it(`refuses priority profiles through ${selection} with a clear reason`, () => {
      const chosen = { ...executor, featureValues: { service_tier: "priority" } };
      const matrix: DispatchMatrix = {
        version: 1, generatedAt: null, defaultTier: "L2", downgradeWhenTight: [],
        executor: { L2: [{ profile: chosen.name, effort: null, paused: false }] },
        reviewerFamilies: { xai: { L2: [{ profile: reviewer.name, effort: null, paused: false }] } }, star: {},
      };
      const input: Partial<RouteInput> = {
        profiles: [chosen, reviewer],
        ...(selection.includes("override") ? { profileOverride: chosen.id } : {}),
        ...(selection.includes("matrix") ? { matrix } : {}),
      };
      const blocked = route(input);
      assert.equal(blocked.ok, false);
      if (!blocked.ok) assert.ok(blocked.reason.includes(zhCN("routing.fastNotAllowed")));
      assert.equal(route({ ...input, profiles: [executor, reviewer] }).ok, true);
    });
  }

  it("does not reserve a priority reviewer for a standard executor", () => {
    const blocked = route({ profiles: [executor, { ...reviewer, featureValues: { fast: true } }] });
    assert.equal(blocked.ok, false);
    if (!blocked.ok) assert.ok(blocked.reason.includes(zhCN("routing.fastNotAllowed")));
  });

  it("skips the executor actual model across family labels and keeps a different model", () => {
    const pick = routeProfile({
      profiles: [{ ...reviewer, id: "same", name: "Reviewer · Same model", family: "anthropic", model: " GROK-4.7 " }, reviewer],
      role: "reviewer",
      review: true,
      executorFamily: "xai", executorModel: "grok-4.7",
      executorProfile: zhCN("labels.role.executor"),
      byPool: {},
      poolLimits: {},
      snapshot: open,
    });
    assert.equal(pick.ok, true);
    if (pick.ok) assert.equal(pick.profile.family, "anthropic");
  });

  it("resolves an empty executor family from the recorded executor profile", () => {
    const pick = routeProfile({
      profiles: [claudeExec, reviewer, xaiReview],
      role: "reviewer",
      review: true,
      reviewsExecutor: true,
      executorFamily: null,
      executorProfile: claudeExec.name,
      byPool: {},
      poolLimits: {},
      snapshot: open,
    });
    assert.equal(pick.ok, true);
    if (pick.ok) assert.equal(pick.profile.name, xaiReview.name);
  });

  it("does not dispatch a review when the executor family cannot be resolved", () => {
    for (const executorProfile of [null, (zhCNPart("cleanup.reason.gone", 0, 2) + "Demo text")]) {
      const pick = routeProfile({
        profiles: [reviewer, xaiReview],
        role: "reviewer",
        review: true,
        reviewsExecutor: true,
        executorFamily: null,
        executorProfile,
        byPool: {},
        poolLimits: {},
        snapshot: open,
      });
      assert.equal(pick.ok, false);
      if (!pick.ok) {
        assert.equal(pick.action, "block");
        assert.equal(pick.kind, "needs_human");
        assert.match(pick.reason, new RegExp(zhCN("routing.reviewModelUnavailable")));
      }
    }
  });

  it("keeps a standalone review card without an executor family dispatchable", () => {
    const pick = routeProfile({
      profiles: [reviewer],
      role: "reviewer",
      review: true,
      executorFamily: null,
      executorProfile: null,
      byPool: {},
      poolLimits: {},
      snapshot: open,
    });
    assert.equal(pick.ok, true);
  });

  it("will not start an executor when that would leave no reviewer from another family", () => {
    const pick = routeProfile({
      profiles: [claudeExec, alternate, reviewer],
      role: "executor",
      review: false,
      byPool: {},
      poolLimits: {},
      snapshot: open,
    });
    assert.equal(pick.ok, true);
    if (pick.ok) {
      assert.equal(pick.profile.name, "Executor · Alternate");
      assert.equal(pick.profile.family, "xai");
    }
  });

  it("drops a pool that is not dispatchable and ranks a deprioritized pool later", () => {
    const closed = snapshot({
      supergrok: { dispatchable: false, reason: "Nearly exhausted" },
      alternate: { dispatchable: true, deprioritize: true },
      "claude-max": { dispatchable: true },
    });
    const pick = routeProfile({
      profiles: [executor, alternate, reviewer],
      role: "executor",
      review: false,
      byPool: {},
      poolLimits: {},
      snapshot: closed,
    });
    assert.equal(pick.ok, true);
    if (pick.ok) assert.equal(pick.profile.pool, "alternate");

    const both = snapshot({
      supergrok: { dispatchable: true, deprioritize: true },
      alternate: { dispatchable: true },
      "claude-max": { dispatchable: true },
    });
    const later = routeProfile({
      profiles: [executor, alternate, reviewer],
      role: "executor",
      review: false,
      byPool: {},
      poolLimits: {},
      snapshot: both,
    });
    assert.equal(later.ok, true);
    if (later.ok) assert.equal(later.profile.pool, "alternate");
  });

  it("reviews a Claude execution with the xai family", () => {
    const pick = routeProfile({
      profiles: [reviewer, xaiReview, codex],
      role: "reviewer",
      review: true,
      executorFamily: "anthropic", executorModel: "sonnet",
      executorProfile: "Executor · Claude",
      byPool: {},
      poolLimits: {},
      snapshot: open,
    });
    assert.equal(pick.ok, true);
    if (pick.ok) {
      assert.equal(pick.profile.family, "xai");
      assert.equal(pick.profile.name, xaiReview.name);
    }
    const opusCard = routeProfile({
      profiles: [reviewer, xaiReview, codex],
      role: "reviewer",
      review: true,
      executorFamily: "anthropic", executorModel: "sonnet",
      executorProfile: opus.name,
      byPool: {},
      poolLimits: {},
      snapshot: open,
    });
    assert.equal(opusCard.ok, true);
    if (opusCard.ok) assert.equal(opusCard.profile.family, "xai");
  });

  it("does not dispatch Codex", () => {
    const pick = routeProfile({
      profiles: [codex],
      role: "reviewer",
      review: true,
      executorFamily: "anthropic", executorModel: "sonnet",
      executorProfile: zhCN("labels.role.executor"),
      byPool: {},
      poolLimits: {},
      snapshot: open,
    });
    assert.equal(pick.ok, false);
    if (!pick.ok) assert.match(pick.reason, new RegExp(zhCN("routing.modelNotAllowed")));
  });

  it("blocks needs_human when every reviewer is the same family", () => {
    const none = routeProfile({
      profiles: [reviewer],
      role: "reviewer",
      review: true,
      executorFamily: "anthropic", executorModel: "sonnet",
      executorProfile: "Executor · Claude",
      byPool: {},
      poolLimits: {},
      snapshot: open,
    });
    assert.equal(none.ok, false);
    if (!none.ok) {
      assert.equal(none.action, "block");
      assert.equal(none.kind, "needs_human");
      assert.equal(none.quotaWait, undefined);
      assert.match(none.reason, new RegExp(zhCN("routing.reviewModelUnavailable")));
    }
  });

  it("queues instead of needs_human when another family is only out of quota", () => {
    const paused = snapshot({
      "claude-max": { dispatchable: true },
      supergrok: { dispatchable: false, reason: "Ahead of budget" },
    });
    const none = routeProfile({
      profiles: [reviewer, xaiReview],
      role: "reviewer",
      review: true,
      executorFamily: "anthropic", executorModel: "sonnet",
      executorProfile: "Executor · Claude",
      byPool: {},
      poolLimits: {},
      snapshot: paused,
    });
    assert.equal(none.ok, false);
    if (!none.ok) {
      assert.equal(none.action, "hold");
      assert.equal(none.quotaWait, true);
      assert.notEqual(none.kind, "needs_human");
      assert.match(none.reason, new RegExp("Ahead of budget"));
    }
  });

  it("waits on quota when no compliant reviewer can take an executor card", () => {
    const pick = routeProfile({
      profiles: [claudeExec, reviewer],
      role: "executor",
      review: false,
      byPool: {},
      poolLimits: {},
      snapshot: open,
    });
    assert.equal(pick.ok, false);
    if (!pick.ok) {
      assert.equal(pick.action, "hold");
      assert.equal(pick.kind, "quota");
      assert.match(pick.reason, new RegExp(zhCN("routing.noReviewer")));
    }
  });
});

const grokExec: Profile = { id: "g", name: zhCN("labels.role.executor"), role: "executor", family: "xai", provider: "grok", model: "grok-4.7", pool: "supergrok" };
const cursorLocal: Profile = {
  id: "cl",
  name: "Executor · Alternate Local (candidate)",
  role: "candidate",
  candidateFor: "executor",
  family: "xai",
  provider: "alternate",
  model: "grok-4.7",
  pool: "alternate",
};
const claudeReview: Profile = { id: "r", name: zhCN("labels.role.reviewer"), role: "reviewer", family: "anthropic", provider: "claude", model: "sonnet", pool: "claude-max" };
const fable: Profile = {
  id: "fb",
  name: highRiskProfileName,
  role: "candidate",
  candidateFor: "reviewer",
  family: "anthropic",
  provider: "claude",
  model: "claude-fable-5-1",
  pool: "claude-fable",
};
function route(patch: Partial<RouteInput>): ReturnType<typeof routeProfile> {
  return routeProfile({
    profiles: [],
    role: "executor",
    review: false,
    byPool: {},
    poolLimits: {},
    snapshot: open,
    rules: DEFAULT_PROFILE_RULES,
    project: "demo_board",
    tags: [],
    ...patch,
  });
}

function picked(decision: ReturnType<typeof routeProfile>): string {
  assert.equal(decision.ok, true, decision.ok ? "" : decision.reason);
  return decision.ok ? decision.profile.name : "";
}

describe("routeProfile prefer", () => {
  const executors = [grokExec, cursorLocal, claudeReview];

  it("keeps the current order when no pool has a prefer field", () => {
    assert.equal(picked(route({ profiles: executors, snapshot: snapshot({ supergrok: {}, alternate: {} }) })), zhCN("labels.role.executor"));
  });

  it("puts a prefer pool first for the same role and says why", () => {
    const decision = route({ profiles: executors, snapshot: snapshot({ supergrok: {}, alternate: { prefer: true } }) });
    assert.equal(picked(decision), cursorLocal.name);
    if (decision.ok) assert.match(decision.reason, new RegExp(zhCN("routing.sum.preferPool", {"pool":"alternate"})));
  });

  it("uses the pool that resets first when both prefer", () => {
    const soonCursor = snapshot({
      supergrok: { prefer: true, resetsAt: "2026-10-03T00:00:00.000Z" },
      alternate: { prefer: true, resetsAt: "2026-09-29T00:00:00.000Z" },
    });
    assert.equal(picked(route({ profiles: executors, snapshot: soonCursor })), cursorLocal.name);
    const soonGrok = snapshot({
      supergrok: { prefer: true, resetsAt: "2026-09-28T00:00:00.000Z" },
      alternate: { prefer: true, resetsAt: "2026-09-29T00:00:00.000Z" },
    });
    assert.equal(picked(route({ profiles: executors, snapshot: soonGrok })), zhCN("labels.role.executor"));
  });

  it("lets deprioritize and dispatchable false win over prefer", () => {
    const depri = snapshot({ supergrok: { prefer: true, deprioritize: true }, alternate: {} });
    assert.equal(picked(route({ profiles: executors, snapshot: depri })), cursorLocal.name);
    const closed = snapshot({ supergrok: { prefer: true, dispatchable: false }, alternate: {} });
    assert.equal(picked(route({ profiles: executors, snapshot: closed })), cursorLocal.name);
    const avoided = route({ profiles: executors, snapshot: snapshot({ supergrok: { prefer: true }, alternate: {} }), avoidPools: ["supergrok"] });
    assert.equal(picked(avoided), cursorLocal.name);
  });
});

describe("routeProfile scope rules", () => {
  const closedGrok = snapshot({ supergrok: { dispatchable: false }, alternate: { dispatchable: false } });

  it("does not give an untagged executor card to Opus", () => {
    const decision = route({ profiles: [grokExec, opus, claudeReview, xaiReview], snapshot: closedGrok });
    assert.equal(decision.ok, false);
    if (!decision.ok) {
      assert.match(decision.reason, new RegExp(localePattern(zhCNPart("profileRules.onlyTagged", 0, 5)) + "complex-docs " + localePattern(zhCNPart("profileRules.onlyTagged", 12, 16))));
      assert.equal(decision.kind, "quota");
      assert.equal(decision.action, "hold");
    }
    const open2 = route({ profiles: [grokExec, opus, claudeReview, xaiReview] });
    assert.equal(picked(open2), zhCN("labels.role.executor"));
  });

  it("gives a complex-docs card to Opus, ahead of the official executor", () => {
    const decision = route({ profiles: [grokExec, opus, claudeReview, xaiReview], tags: ["complex-docs"] });
    assert.equal(picked(decision), opus.name);
    if (decision.ok) assert.match(decision.reason, new RegExp(zhCN("routing.sum.rulePreferred", {"why":(zhCNPart("profileRules.preferredTag", 0, 4) + "complex-docs " + zhCNPart("cardParts.event.tagged", 1, 3))})));
  });

  it("reviews a high-risk card with Fable", () => {
    const decision = route({
      profiles: [claudeReview, fable],
      role: "reviewer",
      review: true,
      executorFamily: "xai", executorModel: "grok-4.7",
      executorProfile: zhCN("labels.role.executor"),
      tags: ["high-risk"],
    });
    assert.equal(picked(decision), fable.name);
  });

  it("skips Fable for an ordinary review unless claude-fable is marked prefer", () => {
    const base = { profiles: [claudeReview, fable], role: "reviewer", review: true, executorFamily: "xai", executorModel: "grok-4.7", executorProfile: zhCN("labels.role.executor") };
    const plain = route(base);
    assert.equal(picked(plain), zhCN("labels.role.reviewer"));
    if (plain.ok) assert.match(plain.reason, new RegExp(localePattern(zhCNPart("profileRules.onlyTagged", 0, 5)) + "high-risk " + localePattern(zhCNPart("profileRules.onlyTagged", 12, 16))));
    const wasting = route({ ...base, snapshot: snapshot({ "claude-fable": { prefer: true } }) });
    assert.equal(picked(wasting), fable.name);
    if (wasting.ok) assert.match(wasting.reason, new RegExp(zhCN("routing.sum.preferPool", {"pool":"claude-fable"})));
  });

  it("allows same-family different-model Fable review when its pool is preferred", () => {
    const decision = route({
      profiles: [claudeReview, fable, xaiReview],
      role: "reviewer",
      review: true,
      executorFamily: "anthropic", executorModel: "sonnet",
      executorProfile: "Executor · Claude",
      snapshot: snapshot({ "claude-fable": { prefer: true } }),
      tags: ["high-risk"],
    });
    assert.equal(decision.ok, true);
    if (decision.ok) {
      assert.equal(decision.profile.name, fable.name);
      assert.equal(decision.profile.family, "anthropic");
    }
  });

  it("ignores the rules for an explicit --profile", () => {
    const opusPinned = route({ profiles: [grokExec, opus, claudeReview, xaiReview], profileOverride: opus.name });
    assert.equal(picked(opusPinned), opus.name);
  });

  it("waits on quota instead of needs_human when only rules stop every profile", () => {
    const decision = route({ profiles: [opus, claudeReview, xaiReview] });
    assert.equal(decision.ok, false);
    if (!decision.ok) {
      assert.equal(decision.kind, "quota");
      assert.equal(decision.action, "hold");
      assert.match(decision.reason, new RegExp(localePattern(zhCNPart("routing.ruleWaitHead", 0, 8))));
      assert.match(decision.reason, /complex-docs/);
    }
  });

  it("drops a rule that the config sets to replace the built-in one", () => {
    const decision = route({ profiles: [opus, claudeReview, xaiReview], rules: { ...DEFAULT_PROFILE_RULES, [complexDocsProfileName]: {} } });
    assert.equal(picked(decision), opus.name);
  });
});

function gptProfile(patch: Partial<Profile> & Pick<Profile, "id" | "name" | "role">): Profile {
  return {
    family: "openai",
    provider: "codex",
    model: "demo-v2.1-sol",
    pool: "codex-pro",
    modeId: "full-access",
    thinkingOptionId: "high",
    featureValues: { fast_mode: false, plan_mode: false },
    ...patch,
  };
}

function gptMatrix(patch: Partial<DispatchMatrix>): DispatchMatrix {
  return {
    version: 1,
    generatedAt: null,
    defaultTier: "L2",
    downgradeWhenTight: ["L1", "L2"],
    executor: {},
    reviewerFamilies: {},
    star: {},
    ...patch,
  };
}

describe("routeProfile configured model", () => {
  const gptExec = gptProfile({ id: "g6", name: "Executor · configured model.1-Sol", role: "executor" });
  const gptAstra = gptProfile({ id: "astra", name: "Executor · configured model-Astra", role: "executor", model: "demo-v2-astra" });
  const gpt5 = gptProfile({ id: "g5", name: "Executor · older model", role: "executor", model: "demo-v1.4" });
  const gptFast = gptProfile({
    id: "gfast",
    name: "Executor · configured model.1-SolSample textfastSample text",
    role: "executor",
    featureValues: { fast_mode: true, plan_mode: false },
  });
  const gptUltra = gptProfile({ id: "gultra", name: "Executor · configured model.1-SolSample textultraSample text", role: "executor", thinkingOptionId: "ultra" });
  const gptMax = gptProfile({ id: "gmax", name: "Executor · configured model.1-SolSample textmaxSample text", role: "executor", thinkingOptionId: "max" });
  const gptReview = gptProfile({ id: "grev", name: "Reviewer · configured model.1-Sol", role: "reviewer" });
  const gptReader = gptProfile({ id: "gread", name: "Reader · configured model.1-Sol", role: "reader" });
  const gptDecision = gptProfile({ id: "gdec", name: "Decision · configured model.1-Sol", role: "decision" });
  const withReviewer = [claudeReview];

  it("dispatches demo-v2.1-sol and demo-v2-astra when codex-pro is in a fresh snapshot", () => {
    const main = route({ profiles: [gptExec, ...withReviewer] });
    assert.equal(picked(main), gptExec.name);
    if (main.ok) assert.equal(main.profile.model, "demo-v2.1-sol");
    const astra = route({ profiles: [gptAstra, ...withReviewer] });
    assert.equal(picked(astra), gptAstra.name);
    if (astra.ok) assert.equal(astra.profile.model, "demo-v2-astra");
  });

  it("refuses demo-v1.x, fast_mode, and ultra, and allows max", () => {
    const series = route({ profiles: [gpt5, ...withReviewer] });
    assert.equal(series.ok, false);
    if (!series.ok) {
      assert.equal(series.action, "block");
      assert.equal(series.kind, "needs_human");
      assert.match(series.reason, new RegExp(zhCN("routing.modelNotAllowed")));
    }
    const pinned = route({ profiles: [gpt5, grokExec, ...withReviewer], profileOverride: gpt5.name });
    assert.equal(pinned.ok, false);
    if (!pinned.ok) {
      assert.match(pinned.reason, new RegExp(localePattern(zhCNPart("routing.pinnedShort", 5, 9))));
      assert.match(pinned.reason, new RegExp(zhCN("routing.modelNotAllowed")));
    }
    const fast = route({ profiles: [gptFast, ...withReviewer] });
    assert.equal(fast.ok, false);
    if (!fast.ok) assert.match(fast.reason, new RegExp(zhCN("routing.fastNotAllowed")));
    const ultra = route({ profiles: [gptUltra, ...withReviewer] });
    assert.equal(ultra.ok, false);
    if (!ultra.ok) assert.match(ultra.reason, new RegExp(zhCN("routing.depthNotAllowed")));
    assert.equal(picked(route({ profiles: [gptMax, ...withReviewer] })), gptMax.name);
  });

  it("uses the depth that actually starts, and does not downgrade out of ultra", () => {
    const byCard = route({ profiles: [gptUltra, ...withReviewer], cardEffort: "max" });
    assert.equal(picked(byCard), gptUltra.name);
    const byMatrix = route({
      profiles: [gptUltra, ...withReviewer],
      tier: "L2",
      matrix: gptMatrix({
        executor: { L2: [{ profile: gptUltra.name, effort: "max", paused: false }] },
        reviewerFamilies: { openai: { L2: [{ profile: claudeReview.name, effort: "high", paused: false }] } },
      }),
    });
    assert.equal(picked(byMatrix), gptUltra.name);
    if (byMatrix.ok) assert.equal(byMatrix.effort, "medium");
    const stuck = route({
      profiles: [gptUltra, ...withReviewer],
      tier: "L2",
      matrix: gptMatrix({
        downgradeWhenTight: ["L1", "L2"],
        executor: { L2: [{ profile: gptUltra.name, effort: null, paused: false }] },
        reviewerFamilies: { openai: { L2: [{ profile: claudeReview.name, effort: "high", paused: false }] } },
      }),
    });
    assert.equal(stuck.ok, false);
    if (!stuck.ok) {
      assert.match(stuck.reason, new RegExp(zhCN("routing.depthNotAllowed")));
      assert.doesNotMatch(stuck.reason, new RegExp(localePattern(zhCNPart("routing.effortSource.downgrade", 3, 6))));
    }
  });

  it("queues instead of dispatching when codex-pro is missing or the snapshot is stale", () => {
    const missing = snapshot({ "claude-max": { dispatchable: true }, supergrok: { dispatchable: true }, alternate: { dispatchable: true } });
    const only = route({ profiles: [gptExec, ...withReviewer], snapshot: missing });
    assert.equal(only.ok, false);
    if (!only.ok) {
      assert.equal(only.action, "hold");
      assert.equal(only.kind, "quota");
      assert.match(only.reason, new RegExp(zhCN("routing.poolUnseenReason")));
    }
    const beside = route({ profiles: [gptExec, grokExec, ...withReviewer], snapshot: missing });
    assert.equal(picked(beside), grokExec.name);
    if (beside.ok) assert.match(beside.reason, new RegExp(zhCN("routing.poolUnseenReason")));
    const stale = snapshot(
      { "codex-pro": { dispatchable: true }, "claude-max": { dispatchable: true } },
      "stale",
      ((zhCN("doctor.quota.stale") + " ") + "31 " + zhCNPart("pools.staleMessage", 17, 27)),
    );
    const expired = route({ profiles: [gptExec, ...withReviewer], snapshot: stale });
    assert.equal(expired.ok, false);
    if (!expired.ok) {
      assert.equal(expired.action, "hold");
      assert.match(expired.reason, new RegExp(zhCN("routing.poolUnseenReason")));
    }
    const other = route({ profiles: [grokExec, ...withReviewer], snapshot: stale });
    assert.equal(picked(other), grokExec.name);
  });

  it("queues an exhausted pool when the GPT pool is also unseen", () => {
    const missing = snapshot({
      alternate: { dispatchable: false, reason: "Weekly quota exhausted" },
      "claude-max": { dispatchable: true },
    });
    const profiles = [gptExec, cursorLocal, claudeReview];
    const decision = route({ profiles, snapshot: missing });
    assert.equal(decision.ok, false);
    if (!decision.ok) {
      assert.equal(decision.action, "hold");
      assert.equal(decision.kind, "quota");
      assert.equal(decision.quotaWait, true);
      assert.ok(decision.reason.includes(zhCN("routing.poolClosedWhy", { pool: "alternate", reason: "Weekly quota exhausted" })));
      assert.match(decision.reason, new RegExp(zhCN("routing.poolUnseenReason")));
    }
    const viaMatrix = route({
      profiles,
      snapshot: missing,
      tier: "L3",
      matrix: gptMatrix({
        executor: {
          L3: [
            { profile: gptExec.name, effort: "high", paused: false },
            { profile: cursorLocal.name, effort: "high", paused: false },
          ],
        },
        reviewerFamilies: { xai: { L3: [{ profile: claudeReview.name, effort: "high", paused: false }] } },
      }),
    });
    assert.equal(viaMatrix.ok, false);
    if (!viaMatrix.ok) {
      assert.equal(viaMatrix.action, "hold");
      assert.equal(viaMatrix.quotaWait, true);
      assert.ok(decision.reason.includes(zhCN("routing.poolClosedWhy", { pool: "alternate", reason: "Weekly quota exhausted" })));
      assert.match(viaMatrix.reason, new RegExp(zhCN("routing.poolUnseenReason")));
    }
  });

  it("keeps openai as its own family for review", () => {
    const afterGpt = route({
      profiles: [gptReview, claudeReview],
      role: "reviewer",
      review: true,
      executorFamily: "openai", executorModel: gptReview.model,
      executorProfile: gptExec.name,
    });
    assert.equal(picked(afterGpt), claudeReview.name);
    if (afterGpt.ok) assert.notEqual(afterGpt.profile.family, "openai");
    const onlyGpt = route({
      profiles: [gptReview],
      role: "reviewer",
      review: true,
      executorFamily: "openai", executorModel: gptReview.model,
      executorProfile: gptExec.name,
    });
    assert.equal(onlyGpt.ok, false);
    if (!onlyGpt.ok) assert.match(onlyGpt.reason, new RegExp(zhCN("routing.reviewModelUnavailable")));
    const afterClaude = route({
      profiles: [gptReview],
      role: "reviewer",
      review: true,
      executorFamily: "anthropic", executorModel: "sonnet",
      executorProfile: "Executor · Claude",
    });
    assert.equal(picked(afterClaude), gptReview.name);
    if (afterClaude.ok) assert.equal(afterClaude.profile.family, "openai");
    const afterGrok = route({
      profiles: [gptReview, claudeReview],
      role: "reviewer",
      review: true,
      executorFamily: "xai", executorModel: "grok-4.7",
      executorProfile: zhCN("labels.role.executor"),
    });
    assert.equal(afterGrok.ok, true);
    if (afterGrok.ok) assert.ok(afterGrok.profile.family === "anthropic" || afterGrok.profile.family === "openai");
  });

  it("dispatches a full-access GPT reader and decision profile", () => {
    const reading = route({ profiles: [gptReader], role: "reader", review: false });
    assert.equal(picked(reading), gptReader.name);
    const deciding = route({ profiles: [gptDecision], role: "decision", review: false });
    assert.equal(picked(deciding), gptDecision.name);
  });
});

describe("routeProfile Excluded model ban", () => {
  const excludedProviderReview: Profile = {
    id: "ag",
    name: "Reviewer · Old A",
    role: "candidate",
    candidateFor: "reviewer",
    family: "example-banned-family",
    provider: "example-banned-provider",
    model: "flash",
    pool: "alternate",
  };
  const googlePoolReview: Profile = {
    id: "gp",
    name: "Reviewer · Old B",
    role: "candidate",
    candidateFor: "reviewer",
    family: "example-banned-family",
    provider: "claude",
    model: "sonnet",
    pool: "example-banned-pool",
  };
  const excludedProviderExec: Profile = {
    id: "agx",
    name: "Executor · Sample text",
    role: "candidate",
    candidateFor: "executor",
    family: "example-banned-family",
    provider: "example-banned-provider",
    model: "flash",
    pool: "alternate",
  };

  it("never selects an example-banned-provider or example-banned-pool profile", () => {
    const review = route({
      profiles: [excludedProviderReview, googlePoolReview, claudeReview],
      role: "reviewer",
      review: true,
      executorFamily: "xai", executorModel: "grok-4.7",
      executorProfile: zhCN("labels.role.executor"),
    });
    assert.equal(picked(review), zhCN("labels.role.reviewer"));
    if (review.ok) assert.match(review.reason, new RegExp(zhCN("routing.profileBannedReason")));

    const exec = route({ profiles: [excludedProviderExec, grokExec, claudeReview] });
    assert.equal(picked(exec), zhCN("labels.role.executor"));
    if (exec.ok) assert.match(exec.reason, new RegExp(zhCN("routing.profileBannedReason")));

    const only = route({
      profiles: [excludedProviderReview, googlePoolReview],
      role: "reviewer",
      review: true,
      executorFamily: "xai", executorModel: "grok-4.7",
      executorProfile: zhCN("labels.role.executor"),
    });
    assert.equal(only.ok, false);
    if (!only.ok) assert.match(only.reason, new RegExp(zhCN("routing.profileBannedReason")));
  });

  it("refuses an explicit example-banned-provider or example-banned-pool profile", () => {
    for (const profile of [excludedProviderReview, googlePoolReview]) {
      const decision = route({
        profiles: [profile, claudeReview],
        role: "reviewer",
        review: true,
        executorFamily: "xai", executorModel: "grok-4.7",
        profileOverride: profile.name,
      });
      assert.equal(decision.ok, false);
      if (!decision.ok) {
        assert.equal(decision.action, "block");
        assert.match(decision.reason, new RegExp(localePattern(zhCNPart("routing.pinnedShort", 5, 9))));
        assert.match(decision.reason, new RegExp(zhCN("routing.profileBannedReason")));
      }
    }
  });

  it("rejects a google family, a example-banned-model model, and a Excluded model name on auto pick and --profile", () => {
    const googleFamily: Profile = {
      id: "gf",
      name: "Reviewer · Google family",
      role: "candidate",
      candidateFor: "reviewer",
      family: "example-banned-family",
      provider: "claude",
      model: "sonnet",
      pool: "claude-max",
    };
    const excludedModel: Profile = {
      id: "gm",
      name: "Reviewer · Another model family",
      role: "candidate",
      candidateFor: "reviewer",
      family: "xai",
      provider: "alternate",
      model: "example-banned-model-3.8-flash",
      pool: "alternate",
    };
    const excludedName: Profile = {
      id: "gn",
      name: "Reviewer · Example-banned-model Alias",
      role: "candidate",
      candidateFor: "reviewer",
      family: "xai",
      provider: "alternate",
      model: "grok-4.7",
      pool: "alternate",
    };
    for (const profile of [googleFamily, excludedModel, excludedName]) {
      const auto = route({
        profiles: [profile, xaiReview],
        role: "reviewer",
        review: true,
        executorFamily: "anthropic", executorModel: "sonnet",
        executorProfile: "Executor · Claude",
      });
      assert.equal(picked(auto), xaiReview.name);
      if (auto.ok) {
        assert.ok(auto.reason.includes(profile.name));
        assert.match(auto.reason, new RegExp(localePattern(zhCN("routing.profileBannedReason"))));
      }

      const pinned = route({
        profiles: [profile, xaiReview],
        role: "reviewer",
        review: true,
        executorFamily: "anthropic", executorModel: "sonnet",
        executorProfile: "Executor · Claude",
        profileOverride: profile.name,
      });
      assert.equal(pinned.ok, false);
      if (!pinned.ok) {
        assert.equal(pinned.action, "block");
        assert.match(pinned.reason, new RegExp(localePattern(zhCNPart("routing.pinnedShort", 5, 9))));
        assert.match(pinned.reason, new RegExp(zhCN("routing.profileBannedReason")));
      }
    }
  });
});

describe("routeProfile Cursor read-only roles", () => {
  const cursorReview: Profile = {
    id: "crv",
    name: "Reviewer · GrokSample textCursorSample text",
    role: "candidate",
    candidateFor: "reviewer",
    family: "xai",
    provider: "cursor",
    model: "grok-4.7",
    modeId: "agent",
    pool: "cursor",
  };
  const cursorReader: Profile = {
    id: "crd",
    name: "Reader · Cursor",
    role: "reader",
    family: "xai",
    provider: "cursor",
    model: "grok-4.7",
    modeId: "agent",
    pool: "cursor",
  };
  const claudeReader: Profile = {
    id: "clr",
    name: zhCN("labels.role.reader"),
    role: "reader",
    family: "anthropic",
    provider: "claude",
    model: "sonnet",
    modeId: "default",
    pool: "claude-max",
  };

  it("will not assign a Cursor profile to review, read, or decide", () => {
    const review = route({
      profiles: [cursorReview, claudeReview],
      role: "reviewer",
      review: true,
      executorFamily: "xai", executorModel: "grok-4.7",
      executorProfile: "Executor · Cursor",
    });
    assert.equal(picked(review), zhCN("labels.role.reviewer"));
    if (review.ok) {
      assert.equal(review.profile.provider, "claude");
      assert.equal(review.profile.modeId, undefined);
      assert.match(review.reason, new RegExp("Cursor " + localePattern(zhCNPart("routing.cursorReadonly", 7, 15))));
    }

    const only = route({
      profiles: [cursorReview],
      role: "reviewer",
      review: true,
      executorFamily: "anthropic", executorModel: "sonnet",
    });
    assert.equal(only.ok, false);
    if (!only.ok) {
      assert.equal(only.action, "block");
      assert.equal(only.kind, "needs_human");
      assert.match(only.reason, new RegExp(cursorReadonlyReason().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }

    const reading = route({ profiles: [cursorReader, claudeReader, xaiReview], role: "reader", review: false });
    assert.equal(picked(reading), zhCN("labels.role.reader"));
    if (reading.ok) assert.equal(reading.profile.modeId, "default");

    const deciding = route({
      profiles: [{ ...cursorReader, id: "cdc", name: "Decision · Cursor", role: "decision" }],
      role: "decision",
      review: false,
    });
    assert.equal(deciding.ok, false);
    if (!deciding.ok) assert.match(deciding.reason, new RegExp("Cursor " + localePattern(zhCNPart("routing.cursorReadonly", 7, 15))));
  });

  it("refuses explicit Cursor read-only profiles and reserved Cursor executors", () => {
    const pinned = route({
      profiles: [cursorReview, claudeReview],
      role: "reviewer",
      review: true,
      executorFamily: "anthropic", executorModel: "sonnet",
      profileOverride: cursorReview.name,
    });
    assert.equal(pinned.ok, false);
    if (!pinned.ok) {
      assert.equal(pinned.kind, "needs_human");
      assert.match(pinned.reason, new RegExp((zhCNPart("routing.pinnedOk", 0, 5) + "Reviewer · GrokSample textCursorSample text」" + zhCNPart("routing.pinnedShort", 5, 9))));
      assert.match(pinned.reason, new RegExp("Cursor " + localePattern(zhCNPart("routing.cursorReadonly", 7, 15))));
    }

    const executing = route({ profiles: [{ ...cursorLocal, provider: "cursor", name: "Executor · Cursor", modeId: "agent" }, claudeReview] });
    assert.equal(executing.ok, false);
    if (!executing.ok) {
      assert.equal(executing.action, "block");
      assert.equal(executing.kind, "needs_human");
      assert.ok(executing.reason.includes(zhCN("routing.cursorReserved")));
    }
  });

  it("does not count a Cursor reviewer as someone who can review an executor", () => {
    const held = route({ profiles: [claudeExec, claudeReview, cursorReview] });
    assert.equal(held.ok, false);
    if (!held.ok) {
      assert.equal(held.action, "hold");
      assert.match(held.reason, new RegExp(zhCN("routing.noReviewer")));
      assert.match(held.reason, new RegExp("Cursor " + localePattern(zhCNPart("routing.cursorReadonly", 7, 15))));
    }
  });
});

describe("routeProfile onlyRoles", () => {
  const claudeDecision: Profile = {
    id: "dc",
    name: "Decision · Claude",
    role: "decision",
    family: "anthropic",
    provider: "claude",
    model: "opus",
    pool: "claude-max",
  };
  const claudeDecisionCandidate: Profile = {
    id: "dcc",
    name: "Decision · Claude Sample text",
    role: "candidate",
    candidateFor: "decision",
    family: "anthropic",
    provider: "claude",
    model: "opus",
    pool: "claude-max",
  };
  const readerClaude: Profile = {
    id: "rd",
    name: "Reader · Claude",
    role: "reader",
    family: "anthropic",
    provider: "claude",
    model: "sonnet",
    pool: "claude-max",
  };
  const limited = snapshot({
    "claude-max": { dispatchable: true, onlyRoles: ["reviewer"] },
    alternate: { dispatchable: true },
    supergrok: { dispatchable: true },
  });
  const openClaude = snapshot({
    "claude-max": { dispatchable: true },
    alternate: { dispatchable: true },
    supergrok: { dispatchable: true },
  });

  it("refuses a pinned decision profile when the pool is only for reviewers", () => {
    const decision = route({
      profiles: [claudeDecision, claudeReview],
      role: "decision",
      profileOverride: claudeDecision.name,
      snapshot: limited,
    });
    assert.equal(decision.ok, false);
    if (!decision.ok) {
      assert.equal(decision.action, "hold");
      assert.equal(decision.kind, "quota");
      assert.equal(decision.quotaWait, true);
      assert.match(decision.reason, new RegExp((zhCNPart("routing.pinnedOk", 0, 5) + "Decision · Claude」" + zhCNPart("routing.pinnedShort", 5, 9))));
      assert.match(decision.reason, new RegExp(zhCN("pools.onlyFor", {"pool":"claude-max","roles":zhCN("labels.role.reviewer")})));
    }
  });

  it("still pins that decision profile when the snapshot has no onlyRoles", () => {
    assert.equal(
      picked(route({ profiles: [claudeDecision], role: "decision", profileOverride: claudeDecision.name, snapshot: openClaude })),
      claudeDecision.name,
    );
  });

  it("refuses a candidate decision profile by candidateFor", () => {
    const decision = route({
      profiles: [claudeDecisionCandidate],
      role: "decision",
      profileOverride: claudeDecisionCandidate.name,
      snapshot: limited,
    });
    assert.equal(decision.ok, false);
    if (!decision.ok) assert.match(decision.reason, new RegExp(zhCN("pools.onlyFor", {"pool":"claude-max","roles":zhCN("labels.role.reviewer")})));
  });

  it("still assigns a review on a reviewer-only pool", () => {
    const decision = route({
      profiles: [claudeReview, xaiReview],
      role: "reviewer",
      review: true,
      executorFamily: "xai", executorModel: "grok-4.7",
      executorProfile: zhCN("labels.role.executor"),
      snapshot: limited,
    });
    assert.equal(picked(decision), claudeReview.name);
  });

  it("still starts an executor when the other-family reviewer is a candidate on that pool", () => {
    const candidate: Profile = { ...claudeReview, id: "crc", name: "Reviewer · Sample text", role: "candidate", candidateFor: "reviewer" };
    assert.equal(picked(route({ profiles: [cursorLocal, candidate], snapshot: limited })), cursorLocal.name);
  });

  it("does not treat a reviewer as available when the pool excludes reviewer", () => {
    const held = route({
      profiles: [cursorLocal, claudeReview],
      snapshot: snapshot({
        "claude-max": { dispatchable: true, onlyRoles: ["executor"] },
        alternate: { dispatchable: true },
        supergrok: { dispatchable: true },
      }),
    });
    assert.equal(held.ok, false);
    if (!held.ok) assert.match(held.reason, new RegExp(zhCN("pools.onlyFor", {"pool":"claude-max","roles":zhCN("labels.role.executor")})));
  });

  it("skips a reader on a reviewer-only pool", () => {
    const other: Profile = { ...readerClaude, id: "rd2", name: "Reader · Grok", family: "xai", provider: "grok", pool: "supergrok" };
    const decision = route({ profiles: [readerClaude, other], role: "reader", snapshot: limited });
    assert.equal(picked(decision), other.name);
    if (decision.ok) assert.match(decision.reason, new RegExp(("Reader · Claude" + zhCN("common.colon") + "claude-max " + zhCNPart("pools.onlyFor", 7, 9) + zhCN("labels.role.reviewer") + zhCNPart("labels.assigner.user", 0, 1))));
  });
});

describe("routeProfile stale snapshot", () => {
  it("routes on the last snapshot and says it is stale", () => {
    const stale = snapshot({ supergrok: { dispatchable: false }, alternate: {} }, "stale", ((zhCN("doctor.quota.stale") + " ") + "40 " + zhCNPart("pools.staleMessage", 17, 27)));
    const decision = route({ profiles: [grokExec, cursorLocal, claudeReview], snapshot: stale });
    assert.equal(picked(decision), cursorLocal.name);
    if (decision.ok) assert.match(decision.reason, new RegExp((zhCN("doctor.quota.stale") + " ") + "40 " + localePattern(zhCNPart("ui.duration.underMinute", 5, 7))));
  });
});
