/// <reference types="node" />
import { DEMO_FAMILIES } from "./helpers/dispatch-policy";
import { zhCN, zhCNPart, localePattern } from "./helpers/locale";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { loadConfig, saveConfig } from "../server/config";
import { closeDb } from "../server/db";
import type { DispatchMatrix, MatrixItem } from "../server/matrix";
import { readCompatibilityPoolSnapshot as readPoolSnapshot, staleStopPct, STALE_DEFAULT_STOP_PCT, STALE_MS } from "../server/pools";
import type { Profile } from "../server/profiles";
import { routeProfile, type RouteInput } from "../server/routing";

const envKeys = ["KANBAN_DATA_DIR", "KANBAN_POOL_STATUS"] as const;
const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
const root = mkdtempSync(join(tmpdir(), "kanban-stale-pools-"));
let file: string;

const claude: Profile = {
  id: "c", name: "Executor · Claude", role: "executor", family: "anthropic", provider: "claude", model: "claude-opus-5-5", pool: "claude-max",
};
const grok: Profile = {
  id: "g", name: "Executor · Grok", role: "candidate", candidateFor: "executor", family: "xai", provider: "grok", model: "grok-4.7", pool: "supergrok",
};
const gpt: Profile = {
  id: "x", name: "Executor · GPT", role: "candidate", candidateFor: "executor", family: "openai", provider: "codex", model: "demo-v2-astra", pool: "codex-pro",
};
const grokReview: Profile = { ...grok, id: "gr", name: "Reviewer · Grok", role: "reviewer", candidateFor: undefined };
const claudeReview: Profile = { ...claude, id: "cr", name: "Reviewer · Claude", role: "candidate", candidateFor: "reviewer" };
const fableReview: Profile = { ...claudeReview, id: "fr", name: ((zhCN("labels.role.reviewer") + " ") + "· Fable"), model: "claude-fable-5-1", pool: "claude-fable" };
const profiles = [claude, grok, gpt, grokReview, claudeReview, fableReview];

function item(profile: string): MatrixItem {
  return { profile, effort: "medium", paused: false };
}

const order = [item(claude.name), item(grok.name), item(gpt.name)];
const matrix: DispatchMatrix = {
  version: 1,
  generatedAt: "2026-10-07T17:03:00.000Z",
  defaultTier: "L2",
  downgradeWhenTight: [],
  executor: { L1: order, L2: order, L3: order, L4: order },
  reviewerFamilies: {
    anthropic: { L1: [item(grokReview.name)], L2: [item(grokReview.name)], L3: [item(grokReview.name)], L4: [item(grokReview.name)] },
    xai: {
      L1: [item(claudeReview.name), item(fableReview.name)],
      L2: [item(claudeReview.name), item(fableReview.name)],
      L3: [item(claudeReview.name), item(fableReview.name)],
      L4: [item(claudeReview.name), item(fableReview.name)],
    },
    openai: { L1: [item(grokReview.name)], L2: [item(grokReview.name)], L3: [item(grokReview.name)], L4: [item(grokReview.name)] },
  },
  star: {},
};

/** Write the EX file and set its mtime `ageMs` in the past. */
function writePools(pools: Record<string, unknown>, ageMs: number): void {
  writeFileSync(file, JSON.stringify({ generatedAt: "2026-10-07T17:03:00.000Z", pools }));
  const when = (Date.now() - ageMs) / 1000;
  utimesSync(file, when, when);
}

const STALE_AGE = STALE_MS + 10 * 60 * 1000;

function route(patch: Partial<RouteInput> = {}) {
  return routeProfile({
    profiles,
    role: "executor",
    review: false,
    byPool: {},
    poolLimits: {},
    snapshot: readPoolSnapshot(),
    matrix,
    tier: "L2",
    ...patch,
  });
}

function picked(decision: ReturnType<typeof routeProfile>): string {
  if (!decision.ok) throw new Error(decision.reason);
  return decision.profile.name;
}

/** A simulated stale per-pool pause and preference, read hours later. */
const incident = {
  "claude-max": { dispatchable: false, usedPct: 42, reason: "5 hour window usage 70%, pause" },
  supergrok: { dispatchable: true, prefer: true, usedPct: 10 },
};

beforeEach(() => {
  closeDb();
  const dir = mkdtempSync(join(root, "case-"));
  file = join(dir, "pool-status.json");
  process.env.KANBAN_DATA_DIR = dir;
  process.env.KANBAN_POOL_STATUS = file;
  saveConfig({ ...loadConfig(), autoStart: {}, supervisors: {}, staleStopPct: { "claude-max": 75 }, families: DEMO_FAMILIES });
});

after(() => {
  closeDb();
  for (const key of envKeys) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }
  rmSync(root, { recursive: true, force: true });
});

describe("stale pool snapshot", () => {
  it("keeps the stop lines as named constants", () => {
    assert.equal(staleStopPct("unconfigured-pool"), 97);
    assert.equal(STALE_DEFAULT_STOP_PCT, 97);
  });

  it("drops an old claude-max pause at 42% and follows the matrix order", () => {
    writePools(incident, STALE_AGE);
    const snapshot = readPoolSnapshot();
    assert.equal(snapshot.state, "stale");
    assert.equal(snapshot.dispatchable("claude-max"), true);
    assert.equal(snapshot.entry("supergrok").prefer, false);
    assert.equal(snapshot.entry("claude-max").reason, null);
    const decision = route({ snapshot });
    assert.equal(picked(decision), claude.name);
    if (decision.ok) assert.match(decision.reason, new RegExp((zhCN("doctor.quota.stale") + " ") + "40 " + localePattern(zhCNPart("pools.staleMessage", 17, 25))));
  });

  it("drops deprioritize too, so the first matrix entry still goes first", () => {
    writePools({ "claude-max": { dispatchable: true, deprioritize: true, usedPct: 10 }, supergrok: { prefer: true, usedPct: 10 } }, STALE_AGE);
    assert.equal(picked(route()), claude.name);
  });

  it("still stops claude-max at 80% and says why", () => {
    writePools({ ...incident, "claude-max": { dispatchable: true, usedPct: 80 } }, STALE_AGE);
    const snapshot = readPoolSnapshot();
    assert.equal(snapshot.dispatchable("claude-max"), false);
    assert.match(snapshot.entry("claude-max").reason ?? "", new RegExp(localePattern(zhCNPart("pools.staleStopped", 7, 12)) + "80% " + localePattern(zhCNPart("pools.staleStopped", 20, 26)) + "75%"));
    const decision = route({ snapshot });
    assert.equal(picked(decision), grok.name);
    if (decision.ok) assert.match(decision.reason, new RegExp(("Executor · Claude" + zhCN("common.colon") + "claude-max " + zhCNPart("routing.poolClosed", 7, 10))));
  });

  it("stops claude-max at exactly 75% and other pools at 97%", () => {
    writePools({ "claude-max": { usedPct: 75 }, supergrok: { usedPct: 97 }, "codex-pro": { usedPct: 96 } }, STALE_AGE);
    const snapshot = readPoolSnapshot();
    assert.equal(snapshot.dispatchable("claude-max"), false);
    assert.equal(snapshot.dispatchable("supergrok"), false);
    assert.equal(snapshot.dispatchable("codex-pro"), true);
  });

  it("treats a pool with no reading as open", () => {
    writePools({ "claude-max": { dispatchable: false } }, STALE_AGE);
    assert.equal(readPoolSnapshot().dispatchable("claude-max"), true);
    assert.equal(picked(route()), claude.name);
  });

  it("dispatches GPT when the stale snapshot has codex-pro below 97%", () => {
    writePools({ "codex-pro": { dispatchable: false, usedPct: 5 } }, STALE_AGE);
    const decision = route({ profiles: [gpt, grokReview] });
    assert.equal(picked(decision), gpt.name);
  });

  it("does not dispatch GPT at the 97% stop line", () => {
    writePools({ "codex-pro": { dispatchable: true, usedPct: 97 } }, STALE_AGE);
    const decision = route({ profiles: [gpt, grokReview] });
    assert.equal(decision.ok, false);
    if (!decision.ok) {
      assert.equal(decision.action, "hold");
      assert.match(decision.reason, new RegExp(zhCN("routing.poolClosed", {"pool":"codex-pro"}) + ".*" + localePattern(zhCNPart("pools.staleStopped", 22, 26)) + "97%"));
      assert.match(decision.reason, new RegExp((zhCN("doctor.quota.stale") + " ") + "40 " + localePattern(zhCNPart("pools.staleMessage", 17, 25))));
    }
  });

  it("keeps GPT out when the stale snapshot has no codex-pro", () => {
    writePools(incident, STALE_AGE);
    const only = route({ profiles: [gpt, grokReview] });
    assert.equal(only.ok, false);
    if (!only.ok) {
      assert.equal(only.action, "hold");
      assert.match(only.reason, new RegExp(zhCN("routing.poolUnseenReason")));
      assert.match(only.reason, new RegExp((zhCN("doctor.quota.stale") + " ") + "40 " + localePattern(zhCNPart("pools.staleMessage", 17, 25))));
    }
  });

  it("keeps GPT out when the stale codex-pro entry has no reading", () => {
    writePools({ "codex-pro": { dispatchable: true } }, STALE_AGE);
    const only = route({ profiles: [gpt, grokReview] });
    assert.equal(only.ok, false);
    if (!only.ok) assert.match(only.reason, new RegExp(zhCN("routing.poolUnseenReason")));
  });

  it("goes back to the EX flags once the snapshot is fresh", () => {
    writePools({ ...incident, "codex-pro": { dispatchable: true, deprioritize: true, usedPct: 5 } }, 60 * 1000);
    const snapshot = readPoolSnapshot();
    assert.equal(snapshot.state, "fresh");
    assert.equal(snapshot.message, zhCN("pools.freshMessage"));
    assert.equal(snapshot.dispatchable("claude-max"), false);
    assert.equal(snapshot.entry("claude-max").reason, "5 hour window usage 70%, pause");
    assert.equal(snapshot.entry("supergrok").prefer, true);
    assert.equal(snapshot.entry("codex-pro").deprioritize, true);
    const decision = route({ snapshot });
    assert.equal(picked(decision), grok.name);
    if (decision.ok) assert.doesNotMatch(decision.reason, new RegExp(zhCN("doctor.object.quota")));
  });

  describe("matrix pauses", () => {
    const pausedOrder = [{ ...item(claude.name), paused: true }, item(grok.name), item(gpt.name)];
    const pausedMatrix: DispatchMatrix = {
      ...matrix,
      executor: { L1: pausedOrder, L2: pausedOrder, L3: pausedOrder, L4: pausedOrder },
      reviewerFamilies: {
        ...matrix.reviewerFamilies,
        xai: {
          L1: [{ ...item(claudeReview.name), paused: true }, item(fableReview.name)],
          L2: [{ ...item(claudeReview.name), paused: true }, item(fableReview.name)],
          L3: [{ ...item(claudeReview.name), paused: true }, item(fableReview.name)],
          L4: [{ ...item(claudeReview.name), paused: true }, item(fableReview.name)],
        },
      },
    };

    it("ignores a matrix pause on a stale snapshot when claude-max read 42%", () => {
      writePools(incident, STALE_AGE);
      const decision = route({ matrix: pausedMatrix });
      assert.equal(picked(decision), claude.name);
      if (decision.ok) {
        assert.match(decision.reason, new RegExp(zhCN("pools.staleMessage", {"minutes":"40"})));
        assert.doesNotMatch(decision.reason, new RegExp(zhCN("routing.matrixPaused")));
      }
    });

    it("lets a stale reviewer roster ignore its pause too", () => {
      writePools(incident, STALE_AGE);
      const decision = route({
        matrix: pausedMatrix,
        role: "reviewer",
        review: true,
        executorFamily: "xai", executorModel: "grok-4.7",
      });
      assert.equal(picked(decision), claudeReview.name);
    });

    it("still stops a paused claude-max at 80% on a stale snapshot", () => {
      writePools({ ...incident, "claude-max": { dispatchable: true, usedPct: 80 } }, STALE_AGE);
      const decision = route({ matrix: pausedMatrix });
      assert.equal(picked(decision), grok.name);
      if (decision.ok) assert.match(decision.reason, new RegExp(("Executor · Claude" + zhCN("common.colon") + "claude-max " + zhCNPart("routing.poolClosed", 7, 10))));
      const only = route({ matrix: pausedMatrix, profiles: [claude, grokReview] });
      assert.equal(only.ok, false);
    });

    it("keeps the matrix pause on a fresh snapshot", () => {
      writePools({ "claude-max": { dispatchable: true, usedPct: 10 }, supergrok: { usedPct: 10 } }, 60 * 1000);
      const decision = route({ matrix: pausedMatrix });
      assert.equal(picked(decision), grok.name);
      if (decision.ok) assert.match(decision.reason, new RegExp(("Executor · Claude" + zhCN("common.colon") + zhCN("routing.matrixPaused"))));
      const only = route({ matrix: pausedMatrix, profiles: [claude, grokReview] });
      assert.equal(only.ok, false);
      if (!only.ok) assert.match(only.reason, new RegExp(zhCN("routing.matrixPaused")));
    });
  });

  it("still lets the local disabledPools switch stop a pool", () => {
    const config = loadConfig();
    config.disabledPools = ["claude-max"];
    saveConfig(config);
    writePools(incident, STALE_AGE);
    const snapshot = readPoolSnapshot();
    assert.equal(snapshot.dispatchable("claude-max"), false);
    assert.equal(snapshot.entry("claude-max").reason, zhCN("pools.disabledByConfig", {"pool":"claude-max"}));
    assert.equal(picked(route({ snapshot })), grok.name);
  });
});
