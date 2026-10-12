import { recordFixtureDelivery } from "./helpers/delivery";
import { publishAnonymousPolicy } from "./helpers/anonymous-policy";
import { policySnapshotPath } from "../server/application/policy-snapshot";
/// <reference types="node" />
import { zhCN, zhCNPart, localePattern, complexDocsProfileName, highRiskProfileName } from "./helpers/locale";
import { UI_ACTOR } from "../shared/actors";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { setWakeSender } from "../server/bus";
import { kanbanHelp, runKanban } from "../server/cli";
import { checkDispatchMatrixText } from "../server/compat";
import { DEFAULT_CONCURRENCY, saveConfig, type KanbanConfig } from "../server/config";
import { closeDb, getDb } from "../server/db";
import { type AgentLauncher } from "../server/dispatch";
import { startTask } from "./helpers/compat-dispatch";
import { KanbanError } from "../server/errors";
import { matrixFailMessage, readCompatibilityDispatchMatrix as loadDispatchMatrix, parseDispatchMatrix, type DispatchMatrix, type MatrixItem } from "../server/matrix";
import { openEntry, type PoolEntry, type PoolSnapshot } from "../server/pools";
import { DEMO_PROFILE_RULES as DEFAULT_PROFILE_RULES } from "./helpers/dispatch-policy";
import type { Profile } from "../server/profiles";
import { routeProfile, type RouteInput } from "../server/routing";
import { boardExtras } from "../server/schedule";
import { runTick } from "./helpers/compat-schedule";
import { addTaskTags, createTask, getDetail, getTask, setTaskTier } from "../server/store";
import { handleTool } from "../server/tools";
import { issueToken } from "../server/tokens";
import { resetAgentAliveCheck, resetBoardWakeForTests, setAgentAliveCheck } from "../server/wake";
import { cardTierLabel } from "../shared/labels";

const tmp = tmpdir();
mkdirSync(tmp, { recursive: true });
const dir = mkdtempSync(join(tmp, "matrix-"));
process.env.KANBAN_DATA_DIR = dir;
process.env.KANBAN_POOL_STATUS = join(dir, "no-such-pools.json");
const work = join(dir, "work");
mkdirSync(work, { recursive: true });

const grok: Profile = {
  id: "g",
  name: zhCN("labels.role.executor"),
  role: "executor",
  family: "xai",
  provider: "grok",
  model: "grok-4.7",
  pool: "supergrok",
  thinkingOptionId: "high",
};
const cursorLocal: Profile = {
  id: "cl",
  name: "Executor · Cursor Local (candidate)",
  role: "candidate",
  candidateFor: "executor",
  family: "xai",
  provider: "cursor",
  model: "grok-4.7",
  pool: "cursor",
  thinkingOptionId: "high",
};
const opus: Profile = {
  id: "o",
  name: complexDocsProfileName,
  role: "candidate",
  candidateFor: "executor",
  family: "anthropic",
  provider: "claude",
  model: "claude-opus-5-5",
  pool: "claude-max",
  thinkingOptionId: "high",
};
const chore: Profile = {
  id: "b",
  name: zhCN("labels.role.batch"),
  role: "candidate",
  candidateFor: "executor",
  family: "anthropic",
  provider: "claude",
  model: "haiku",
  pool: "claude-max",
  thinkingOptionId: "low",
};
const review: Profile = {
  id: "r",
  name: zhCN("labels.role.reviewer"),
  role: "reviewer",
  family: "anthropic",
  provider: "claude",
  model: "claude-sonnet-5",
  pool: "claude-max",
  thinkingOptionId: "high",
};
const fable: Profile = {
  id: "fb",
  name: highRiskProfileName,
  role: "candidate",
  candidateFor: "reviewer",
  family: "anthropic",
  provider: "claude",
  model: "claude-fable-5-1",
  pool: "claude-fable",
  thinkingOptionId: "xhigh",
};
const xaiReview: Profile = {
  id: "xr",
  name: "Reviewer A",
  role: "candidate",
  candidateFor: "reviewer",
  family: "xai",
  provider: "grok",
  model: "grok-4.7",
  pool: "cursor",
  thinkingOptionId: "high",
};
const cursorReview: Profile = {
  id: "cr",
  name: "Reviewer · GrokSample textCursorSample text",
  role: "candidate",
  candidateFor: "reviewer",
  family: "xai",
  provider: "cursor",
  model: "grok-4.7",
  pool: "cursor",
  thinkingOptionId: "high",
};
const reader: Profile = {
  id: "read",
  name: zhCN("labels.role.reader"),
  role: "reader",
  family: "anthropic",
  provider: "claude",
  model: "claude-sonnet-5",
  pool: "claude-max",
  thinkingOptionId: "high",
};
const otherReader: Profile = {
  id: "read2",
  name: "Reader · Backup",
  role: "candidate",
  candidateFor: "reader",
  family: "xai",
  provider: "grok",
  model: "grok-4.7",
  pool: "supergrok",
  thinkingOptionId: "low",
};

function item(profile: string, effort: MatrixItem["effort"], paused = false): MatrixItem {
  return { profile, effort, paused };
}

function matrix(patch: Partial<DispatchMatrix> = {}): DispatchMatrix {
  return {
    version: 1,
    generatedAt: "2026-09-28T00:00:00.000Z",
    defaultTier: "L2",
    downgradeWhenTight: ["L1", "L2"],
    executor: {
      L1: [item("Executor · Cursor Local (candidate)", "low"), item(zhCN("labels.role.executor"), "low"), item(zhCN("labels.role.batch"), null)],
      L2: [item("Executor · Cursor Local (candidate)", "medium"), item(zhCN("labels.role.executor"), "medium")],
      L3: [item("Executor · Cursor Local (candidate)", "high"), item(zhCN("labels.role.executor"), "high"), item(complexDocsProfileName, "high")],
      L4: [item("Executor · Cursor Local (candidate)", "xhigh"), item(complexDocsProfileName, "xhigh"), item(zhCN("labels.role.executor"), "xhigh")],
    },
    reviewerFamilies: {
      xai: {
        L1: [item(zhCN("labels.role.reviewer"), "low")],
        L2: [item(zhCN("labels.role.reviewer"), "medium")],
        L3: [item(zhCN("labels.role.reviewer"), "high")],
        L4: [item(highRiskProfileName, "xhigh"), item(zhCN("labels.role.reviewer"), "high")],
      },
      anthropic: {
        L1: [item("Reviewer A", "low")],
        L2: [item("Reviewer A", "medium")],
        L3: [item("Reviewer A", "high")],
        L4: [item("Reviewer A", "xhigh")],
      },
    },
    star: {
      reader: [item(zhCN("labels.role.reader"), "medium")],
      decision: [item(zhCN("labels.role.decision"), "xhigh")],
      batch: [item(zhCN("labels.role.batch"), null)],
    },
    ...patch,
  };
}

function snapshot(pools: Record<string, Partial<PoolEntry>> = {}): PoolSnapshot {
  const entry = (pool: string | null): PoolEntry => {
    if (!pool || !pools[pool]) return openEntry();
    const raw = pools[pool] ?? {};
    return {
      dispatchable: raw.dispatchable !== false,
      deprioritize: raw.deprioritize === true,
      prefer: raw.prefer === true,
      resetsAt: raw.resetsAt ?? null,
      reason: raw.reason ?? null,
      onlyRoles: raw.onlyRoles && raw.onlyRoles.length > 0 ? raw.onlyRoles : null,
    };
  };
  return {
    state: "fresh",
    message: zhCN("pools.freshMessage"),
    generatedAt: null,
    dispatchable: (pool) => entry(pool).dispatchable,
    entry,
  };
}

function route(patch: Partial<RouteInput> = {}) {
  return routeProfile({
    profiles: [grok, cursorLocal, opus, chore, review, fable, xaiReview, cursorReview, reader, otherReader],
    role: "executor",
    review: false,
    byPool: {},
    poolLimits: {},
    snapshot: snapshot(),
    rules: DEFAULT_PROFILE_RULES,
    project: "matrix",
    tags: [],
    ...patch,
  });
}

function must(decision: ReturnType<typeof routeProfile>) {
  if (!decision.ok) throw new Error(decision.reason);
  return decision;
}

after(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe("card tier", () => {
  it("stores --tier, rejects a bad value, and shows the difficulty", async () => {
    // TEST_0188: a card needs a configured project.
    await runKanban(["project", "--project", "tier", "--code", "TIER"], {});
    const created = (await runKanban(
      ["create", "--project", "tier", "--title", "Has tier", "--role", "executor", "--workspace", work, "--tier", "L3", "--json"],
      {},
    )) as { id: number; tier: string | null };
    assert.equal(created.tier, "L3");
    const detail = getDetail(created.id);
    assert.equal(detail.task.tier, "L3");
    assert.equal(detail.task.tierLabel, "L3");
    assert.equal(cardTierLabel(detail.task.tierLabel), (zhCNPart("labels.card.tier", 0, 3) + "L3"));
    await assert.rejects(
      () => runKanban(["create", "--project", "tier", "--title", "Invalid", "--role", "executor", "--workspace", work, "--tier", "L9"], {}),
      (err: unknown) => err instanceof KanbanError && err.message.includes((zhCNPart("tier.invalidValue", 18, 22) + "L9」")),
    );
    const token = issueToken("supervisor", null, null);
    const viaTool = (await handleTool(
      "kanban_create",
      { project: "tier", title: "demo fixture", role: "executor", workspace: work, tier: "L1" },
      token,
    )) as { id: number; tier: string | null };
    assert.equal(viaTool.tier, "L1");
    await assert.rejects(
      () => handleTool("kanban_create", { project: "tier", title: "Invalid tool", role: "executor", workspace: work, tier: "hard" }, token),
      (err: unknown) => err instanceof KanbanError && new RegExp(localePattern(zhCNPart("tier.invalidType", 0, 5))).test(err.message),
    );
    assert.match(kanbanHelp(), /--tier L1\|L2\|L3\|L4/);
  });

  it("uses defaultTier when unset, and L4 when the card is high-risk", () => {
    const plain = createTask({ project: "tier", title: "Unset", role: "executor", workspacePath: work });
    assert.equal(plain.tier, null);
    assert.equal(getDetail(plain.id).task.tierLabel, "L2");
    const risky = createTask({ project: "tier", title: "High risk", role: "executor", workspacePath: work, tags: ["high-risk"] });
    assert.equal(risky.tier, null);
    assert.equal(getDetail(risky.id).task.tierLabel, "L4");
    const file = join(dir, "default-l1.json");
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        defaultTier: "L1",
        downgradeWhenTight: ["L1", "L2"],
        roles: { executor: { L1: [{ profile: zhCN("labels.role.executor"), effort: "low" }] } },
      }),
    );
    const previous = process.env.KANBAN_DISPATCH_MATRIX;
    const previousConfig = process.env.KANBAN_PASEO_CONFIG;
    process.env.KANBAN_PASEO_CONFIG = join(dir, "tier-policy-config.json");
    writeFileSync(process.env.KANBAN_PASEO_CONFIG, JSON.stringify({ daemon: { agentProfiles: [] } }));
    process.env.KANBAN_DISPATCH_MATRIX = file;
    try {
      publishAnonymousPolicy({ defaultTier: "L1", roles: { executor: { L1: [{ profile: grok.name, effort: "low" }] } } }, {});
      const custom = createTask({ project: "tier", title: "Follow file", role: "executor", workspacePath: work });
      assert.equal(getDetail(custom.id).task.tier, null);
      assert.equal(getDetail(custom.id).task.tierLabel, "L1");
    } finally {
      rmSync(policySnapshotPath(), { force: true });
      if (previousConfig === undefined) delete process.env.KANBAN_PASEO_CONFIG;
      else process.env.KANBAN_PASEO_CONFIG = previousConfig;
      if (previous === undefined) delete process.env.KANBAN_DISPATCH_MATRIX;
      else process.env.KANBAN_DISPATCH_MATRIX = previous;
    }
  });

  it("treats an explicit L4 as high-risk and lets the detail change the tier", () => {
    const created = createTask({ project: "tier", title: "demo fixture", role: "executor", workspacePath: work, tier: "L4" });
    assert.equal(created.tier, "L4");
    assert.deepEqual(getDetail(created.id).task.tags, ["high-risk"]);
    const changed = setTaskTier(created.id, "L2", UI_ACTOR);
    assert.equal(changed.tier, "L2");
    const event = getDb().prepare("SELECT kind, data_json FROM events WHERE task_id = ? AND kind = 'tier_changed'").get(created.id) as {
      kind: string;
      data_json: string;
    };
    assert.match(event.data_json, /L4 → L2/);
    assert.equal(getDetail(created.id).task.tierLabel, "L2");
    const cleared = setTaskTier(created.id, null, UI_ACTOR);
    assert.equal(cleared.tier, null);
  });

  it("adds a tag on an existing card, supervisor only, and records tagged", async () => {
    const card = createTask({ project: "tier", title: "Tags added", role: "reviewer", workspacePath: work });
    await assert.rejects(
      () => runKanban(["tag", String(card.id), "--tag", "high-risk"], { KANBAN_TOKEN: issueToken("executor", card.id, "worker") }),
      (err: unknown) => err instanceof KanbanError && new RegExp(localePattern(zhCNPart("cli.onlyLeader.tag", 0, 14))).test(err.message),
    );
    const updated = (await runKanban(["tag", String(card.id), "--tag", "high-risk", "--json"], {})) as { id: number; tags: string | null };
    assert.equal(updated.id, card.id);
    assert.deepEqual(JSON.parse(updated.tags ?? "[]"), ["high-risk"]);
    const event = getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'tagged'").get(card.id) as { data_json: string };
    assert.match(event.data_json, /high-risk/);
    addTaskTags(card.id, ["high-risk", "complex-docs"], "supervisor");
    assert.deepEqual(getDetail(card.id).task.tags, ["high-risk", "complex-docs"]);
    assert.match(kanbanHelp(), new RegExp("tag <" + localePattern(zhCNPart("taskCreate.error.noTag", 22, 31))));
  });

  it("prefers Fable for an L4 review when there is no matrix", () => {
    const plain = must(route({ role: "reviewer", review: true, executorFamily: "xai", executorModel: "grok-4.7", profiles: [grok, review, fable] }));
    assert.equal(plain.profile.name, review.name);
    const critical = must(route({ role: "reviewer", review: true, executorFamily: "xai", executorModel: "grok-4.7", tier: "L4", profiles: [grok, review, fable] }));
    assert.equal(critical.profile.name, fable.name);
    assert.match(critical.reason, new RegExp("high-risk|" + localePattern(zhCNPart("routing.sum.ruleNote", 0, 4))));
  });
});

describe("dispatch matrix selection", () => {
  const base = matrix();

  it("picks the first dispatchable profile for the tier, with prefer first and deprioritize last", () => {
    const closed = must(
      route({
        matrix: { ...base, executor: { ...base.executor, L3: [item(zhCN("labels.role.executor"), "high"), item("Executor · Cursor Local (candidate)", "high")] } },
        tier: "L3",
        snapshot: snapshot({ supergrok: { dispatchable: false, reason: "Ahead" }, cursor: {} }),
      }),
    );
    assert.equal(closed.profile.name, cursorLocal.name);
    assert.match(closed.reason, /L3/);
    assert.match(closed.reason, new RegExp("high" + localePattern(zhCNPart("missingCwd.none", 0, 1)) + zhCN("routing.effortSource.matrix") + localePattern(zhCNPart("missingCwd.none", 3, 4))));
    assert.match(closed.reason, new RegExp(localePattern(zhCNPart("routing.sum.skipped", 0, 2))));
    assert.match(closed.reason, new RegExp(localePattern(zhCNPart("routing.poolClosed", 7, 10))));

    const preferred = must(
      route({
        matrix: base,
        tier: "L2",
        snapshot: snapshot({ supergrok: { prefer: true }, cursor: {} }),
      }),
    );
    assert.equal(preferred.profile.name, grok.name);

    const later = must(
      route({
        matrix: base,
        tier: "L2",
        snapshot: snapshot({ cursor: { deprioritize: true }, supergrok: {} }),
      }),
    );
    assert.equal(later.profile.name, grok.name);

    const demoted = must(
      route({
        matrix: {
          ...base,
          executor: { ...base.executor, L2: [item(zhCN("labels.role.executor"), "medium"), item("Executor · Cursor Local (candidate)", "medium")] },
        },
        tier: "L2",
        snapshot: snapshot({ supergrok: { deprioritize: true }, cursor: {} }),
      }),
    );
    assert.equal(demoted.profile.name, cursorLocal.name);
  });

  // TEST_0287: EX sorts each list by the user's pool order while matrix.priority is in force.
  describe("matrix priority", () => {
    const NOW = Date.parse("2026-10-08T00:00:00.000Z");
    const order = { order: ["cursor", "claude-max", "supergrok"], until: "2026-10-10T04:26:56Z", untilMs: Date.parse("2026-10-10T04:26:56Z") };
    const expired = { ...order, until: "2026-10-07T00:00:00Z", untilMs: Date.parse("2026-10-07T00:00:00Z") };
    const list = [item("Executor · Cursor Local (candidate)", "medium"), item(complexDocsProfileName, "medium"), item(zhCN("labels.role.executor"), "medium")];
    const withPriority = (priority: DispatchMatrix["priority"]) => ({ ...base, executor: { ...base.executor, L2: list }, priority });
    const claudePrefer = snapshot({ cursor: {}, "claude-max": { prefer: true }, supergrok: {} });

    it("keeps the matrix order while priority is in force, even when a later pool is prefer", () => {
      assert.equal(must(route({ matrix: withPriority(order), tier: "L2", snapshot: claudePrefer, now: NOW })).profile.name, cursorLocal.name);
    });

    it("moves prefer first again once priority has expired", () => {
      assert.equal(must(route({ matrix: withPriority(expired), tier: "L2", snapshot: claudePrefer, now: NOW })).profile.name, opus.name);
    });

    it("moves prefer first when the matrix has no priority", () => {
      assert.equal(must(route({ matrix: withPriority(null), tier: "L2", snapshot: claudePrefer, now: NOW })).profile.name, opus.name);
      assert.equal(must(route({ matrix: withPriority(undefined), tier: "L2", snapshot: claudePrefer, now: NOW })).profile.name, opus.name);
    });

    it("still puts deprioritize and a just-rate-limited pool last while priority is in force", () => {
      const demoted = snapshot({ cursor: { deprioritize: true }, "claude-max": {}, supergrok: {} });
      assert.equal(must(route({ matrix: withPriority(order), tier: "L2", snapshot: demoted, now: NOW })).profile.name, opus.name);
      const avoided = must(route({ matrix: withPriority(order), tier: "L2", snapshot: claudePrefer, avoidPools: ["cursor"], now: NOW }));
      assert.equal(avoided.profile.name, opus.name);
    });

    it("A, B picks A and B, A picks B when both can go and priority is in force", () => {
      const ab = { ...base, priority: order, executor: { ...base.executor, L2: [item("Executor · Cursor Local (candidate)", "medium"), item(zhCN("labels.role.executor"), "medium")] } };
      const ba = { ...base, priority: order, executor: { ...base.executor, L2: [item(zhCN("labels.role.executor"), "medium"), item("Executor · Cursor Local (candidate)", "medium")] } };
      const flags = snapshot({ supergrok: { prefer: true }, cursor: { prefer: true } });
      assert.equal(must(route({ matrix: ab, tier: "L2", snapshot: flags, now: NOW })).profile.name, cursorLocal.name);
      assert.equal(must(route({ matrix: ba, tier: "L2", snapshot: flags, now: NOW })).profile.name, grok.name);
    });
  });

  it("queues when nobody in the list can go, and does not pick a profile outside the list", () => {
    const held = route({
      matrix: { ...base, executor: { ...base.executor, L3: [item(zhCN("labels.role.executor"), "high"), item("Executor · Cursor Local (candidate)", "high")] } },
      tier: "L3",
      snapshot: snapshot({ supergrok: { dispatchable: false }, cursor: { dispatchable: false } }),
    });
    assert.equal(held.ok, false);
    if (!held.ok) {
      assert.equal(held.kind, "quota");
      assert.match(held.reason, new RegExp(localePattern(zhCNPart("routing.poolClosed", 7, 10))));
      assert.doesNotMatch(held.reason, new RegExp(localePattern(zhCNPart("routing.effortSource.downgrade", 3, 6))));
      assert.doesNotMatch(held.reason, new RegExp(zhCN("labels.role.batch")));
    }
  });

  it("lowers effort one step for L1 and L2 when nothing can go, and does not for L3 or L4", () => {
    const supports = (profile: Profile, effort: string) => effort === "low" || profile.name === zhCN("labels.role.batch");
    const tight = must(
      route({
        matrix: base,
        tier: "L2",
        supportsEffort: supports,
      }),
    );
    assert.equal(tight.profile.name, cursorLocal.name);
    assert.equal(tight.effort, "low");
    assert.equal(tight.effortSource, "downgrade");
    assert.match(tight.reason, new RegExp("low" + localePattern(zhCNPart("missingCwd.none", 0, 1)) + zhCN("routing.effortSource.downgrade") + localePattern(zhCNPart("missingCwd.none", 3, 4))));

    const blocked = route({
      matrix: base,
      tier: "L2",
      snapshot: snapshot({ supergrok: { dispatchable: false }, cursor: { dispatchable: false }, "claude-max": { dispatchable: false } }),
    });
    assert.equal(blocked.ok, false);
    if (!blocked.ok) assert.match(blocked.reason, new RegExp(zhCN("routing.downgradedStill")));

    const stays = route({
      matrix: base,
      tier: "L4",
      supportsEffort: () => false,
    });
    assert.equal(stays.ok, false);
    if (!stays.ok) {
      assert.match(stays.reason, new RegExp(localePattern(zhCNPart("routing.noEffortSupport", 0, 5))));
      assert.doesNotMatch(stays.reason, new RegExp(localePattern(zhCNPart("routing.effortSource.downgrade", 3, 6))));
    }
  });

  it("reviews by the executor family and still refuses the same family", () => {
    const picked = must(
      route({
        matrix: {
          ...base,
          reviewerFamilies: {
            xai: { L3: [item("Reviewer A", "high"), item(zhCN("labels.role.reviewer"), "high")] },
          },
        },
        role: "reviewer",
        review: true,
        tier: "L3",
        executorFamily: "xai", executorModel: "grok-4.7",
      }),
    );
    assert.equal(picked.profile.name, review.name);
    assert.match(picked.reason, new RegExp(localePattern(zhCNPart("routing.sum.skipped", 0, 2))));
    assert.match(picked.reason, new RegExp((zhCNPart("routing.sameFamily", 4, 7) + "xai|Reviewer A")));

    const onlySame = route({
      matrix: { ...base, reviewerFamilies: { xai: { L2: [item("Reviewer A", "medium")] } } },
      role: "reviewer",
      review: true,
      tier: "L2",
      executorFamily: "xai", executorModel: "grok-4.7",
    });
    assert.equal(onlySame.ok, false);
    if (!onlySame.ok) {
      assert.equal(onlySame.action, "block");
      assert.equal(onlySame.kind, "needs_human");
    }
  });

  it("uses card effort, then the matrix, then the profile default", () => {
    const byCard = must(route({ matrix: base, tier: "L3", cardEffort: "low" }));
    assert.equal(byCard.effort, "low");
    assert.equal(byCard.effortSource, "card");
    assert.match(byCard.reason, new RegExp("low" + localePattern(zhCNPart("effort.noteCard", 11, 17))));

    const byMatrix = must(route({ matrix: base, tier: "L2" }));
    assert.equal(byMatrix.effort, "medium");
    assert.equal(byMatrix.effortSource, "matrix");

    const byProfile = must(
      route({
        matrix: { ...base, executor: { ...base.executor, L1: [item(zhCN("labels.role.executor"), null)] } },
        tier: "L1",
        snapshot: snapshot({ cursor: { dispatchable: false } }),
      }),
    );
    assert.equal(byProfile.profile.name, grok.name);
    assert.equal(byProfile.effort, "high");
    assert.equal(byProfile.effortSource, "profile");
    assert.match(byProfile.reason, new RegExp("high" + localePattern(zhCNPart("effort.noteProfile", 11, 17))));
  });

  it("keeps an explicit profile and takes that profile's matrix depth", () => {
    const pinned = must(
      route({
        matrix: base,
        tier: "L3",
        profileOverride: zhCN("labels.role.executor"),
        snapshot: snapshot({ cursor: { prefer: true } }),
      }),
    );
    assert.equal(pinned.profile.name, grok.name);
    assert.equal(pinned.effort, "high");
    assert.match(pinned.reason, new RegExp(localePattern(zhCNPart("routing.pinnedShort", 5, 9))));
    assert.match(pinned.reason, new RegExp(zhCN("routing.effortSource.matrix")));
  });

  it("ignores profile rules while the matrix exists, and applies them when it does not", () => {
    const listed = must(
      route({
        matrix: { ...base, executor: { L2: [item(complexDocsProfileName, "high"), item(zhCN("labels.role.executor"), "medium")] } },
        tier: "L2",
        tags: [],
      }),
    );
    assert.equal(listed.profile.name, opus.name);

    const ruled = must(route({ tags: [], profiles: [grok, opus, review, xaiReview] }));
    assert.equal(ruled.profile.name, grok.name);
    assert.match(ruled.reason, new RegExp("complex-docs|" + localePattern(zhCNPart("routing.sum.ruleNote", 0, 4)) + "|" + localePattern(zhCNPart("routing.sum.skipped", 0, 2))));
  });

  it("reads reader depth from the star list and does not leave the list", () => {
    const picked = must(route({ matrix: base, role: "reader", review: false, tier: "L4" }));
    assert.equal(picked.profile.name, reader.name);
    assert.equal(picked.effort, "medium");
    assert.equal(picked.effortSource, "matrix");
  });

  it("starts a Claude reader when every xai reviewer is paused, and still holds a Claude executor", () => {
    const pausedXai = matrix({
      executor: { L3: [item(complexDocsProfileName, "high")] },
      reviewerFamilies: {
        xai: { L3: [item(zhCN("labels.role.reviewer"), "high")] },
        anthropic: { L3: [item("Reviewer A", "high", true)] },
      },
    });
    const reading = must(route({ matrix: pausedXai, role: "reader", review: false, tier: "L3" }));
    assert.equal(reading.profile.name, reader.name);
    assert.equal(reading.profile.family, "anthropic");

    const executing = route({ matrix: pausedXai, role: "executor", review: false, tier: "L3" });
    assert.equal(executing.ok, false);
    if (!executing.ok) {
      assert.equal(executing.action, "hold");
      assert.match(executing.reason, new RegExp(zhCN("routing.noReviewer")));
      assert.match(executing.reason, new RegExp(localePattern(zhCNPart("routing.matrixPaused", 4, 6))));
    }
  });

  it("falls back for a standalone review with no usable family, and skips a conflicting family", () => {
    const fallen = must(
      route({
        matrix: { ...base, reviewerFamilies: {} },
        role: "reviewer",
        review: true,
        profiles: [review, fable],
      }),
    );
    assert.match(fallen.reason, new RegExp(localePattern(zhCNPart("compat.matrix.missing", 6, 10))));
    assert.equal(fallen.profile.name, review.name);

    const conflicted = must(
      route({
        matrix: {
          ...base,
          reviewerFamilies: {
            xai: { L2: [item("Reviewer A", "low")] },
            anthropic: { L2: [item("Reviewer A", "xhigh")] },
          },
        },
        role: "reviewer",
        review: true,
        tier: "L2",
        profileOverride: "Reviewer A",
      }),
    );
    assert.equal(conflicted.profile.name, xaiReview.name);
    assert.equal(conflicted.effort, "low");
    assert.match(conflicted.reason, new RegExp(localePattern(zhCNPart("routing.pinnedShort", 5, 9))));
  });
});

describe("matrix file", () => {
  it("reads priority, and treats a missing or malformed priority as none", () => {
    const body = { version: 1, defaultTier: "L2", downgradeWhenTight: [], roles: {} };
    const read = parseDispatchMatrix({ ...body, priority: { order: ["codex-pro", "claude-max", "supergrok"], until: "2026-10-10T04:26:56Z" } });
    assert.deepEqual(read.priority?.order, ["codex-pro", "claude-max", "supergrok"]);
    assert.equal(read.priority?.untilMs, Date.parse("2026-10-10T04:26:56Z"));
    assert.equal(parseDispatchMatrix(body).priority, null);
    for (const bad of [[], "x", { order: "codex-pro", until: "2026-10-10T00:00:00Z" }, { order: ["a", 3], until: "2026-10-10T00:00:00Z" }, { order: ["a"], until: (zhCNPart("compat.board.notObject", 0, 2) + zhCNPart("missingCwd.report.checkedAt", 2, 4)) }, { order: ["a"] }]) {
      assert.equal(parseDispatchMatrix({ ...body, priority: bad }).priority, null);
    }
  });

  it("ignores unknown role keys and paused flags, and rejects a bad shape", () => {
    const parsed = parseDispatchMatrix({
      version: 1,
      defaultTier: "L2",
      generatedAt: "2026-09-28T00:00:00.000Z",
      downgradeWhenTight: ["L1", "L2"],
      roles: {
        executor: { L3: [{ profile: complexDocsProfileName, effort: "high", paused: true }] },
        reviewer: { byExecutorFamily: { xai: { L2: [{ profile: zhCN("labels.role.reviewer"), effort: "medium" }] } } },
        reader: { "*": [{ profile: zhCN("labels.role.reader"), effort: "medium" }] },
        custodian: { "*": [{ profile: "Demo Ignored", effort: "medium" }] },
      },
    });
    assert.equal(parsed.executor.L3?.[0]?.paused, true);
    assert.equal(parsed.star.reader?.[0]?.profile, zhCN("labels.role.reader"));
    assert.equal(Object.hasOwn(parsed.star, "custodian"), false);
    assert.equal(checkDispatchMatrixText(JSON.stringify({ version: 1, defaultTier: "L2", downgradeWhenTight: ["L1"], roles: { ops_notion: { "*": [] } } })).status, "pass");
    assert.throws(() => parseDispatchMatrix({ version: 1, defaultTier: "L2", roles: {} }), /downgradeWhenTight/);
    assert.equal(checkDispatchMatrixText("{").status, "fail");
  });

  it("keeps legacy fallback explicit while the board warns about absent immutable policy", () => {
    assert.equal(loadDispatchMatrix(Date.now(), join(dir, "missing.json")).state, "missing");
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{");
    const invalid = loadDispatchMatrix(Date.now(), bad);
    assert.equal(invalid.state, "invalid");
    if (invalid.state === "invalid") assert.equal(invalid.message, matrixFailMessage());
    const previous = process.env.KANBAN_DISPATCH_MATRIX;
    process.env.KANBAN_DISPATCH_MATRIX = bad;
    try {
      assert.equal(boardExtras().matrixMessage, matrixFailMessage());
    } finally {
      if (previous === undefined) delete process.env.KANBAN_DISPATCH_MATRIX;
      else process.env.KANBAN_DISPATCH_MATRIX = previous;
    }
    const previousMatrix = process.env.KANBAN_DISPATCH_MATRIX;
    process.env.KANBAN_DISPATCH_MATRIX = join(dir, "missing.json");
    try { assert.equal(boardExtras().matrixMessage, matrixFailMessage()); } finally { process.env.KANBAN_DISPATCH_MATRIX = previousMatrix; }
    const old = must(route({ matrix: null, tags: [], profiles: [grok, opus, review] }));
    assert.equal(old.profile.name, grok.name);
  });

  it("wakes the Kanban supervisor once after the file has been wrong for 6 hours", async () => {
    const sent: Array<{ id: string; text: string }> = [];
    setWakeSender((id, text) => sent.push({ id, text }));
    setAgentAliveCheck(() => true);
    resetBoardWakeForTests();
    const config: KanbanConfig = {
      autoStart: {},
      supervisorAgentId: "kanban-sup",
      supervisors: {},
      concurrency: DEFAULT_CONCURRENCY,
    };
    saveConfig(config);
    const broken = {
      state: "invalid" as const,
      message: matrixFailMessage(),
      detail: "demo fixture",
      ageMs: 7 * 60 * 60 * 1000,
      updatedAt: "2026-09-27T00:00:00.000Z",
      path: join(dir, "bad.json"),
    };
    await runTick({ profiles: [grok, review], launcher: { async create() { return { id: "nope" }; }, async send() {} }, config, matrix: broken });
    await runTick({ profiles: [grok, review], launcher: { async create() { return { id: "nope" }; }, async send() {} }, config, matrix: broken });
    const wakes = sent.filter((item) => new RegExp(zhCN("wake.board.matrixInvalid")).test(item.text));
    assert.equal(wakes.length, 1);
    sent.length = 0;
    resetBoardWakeForTests();
    await runTick({
      profiles: [grok, review],
      launcher: { async create() { return { id: "nope" }; }, async send() {} },
      config,
      matrix: { ...broken, ageMs: 5 * 60 * 60 * 1000, updatedAt: "2026-09-28T00:00:00.000Z" },
    });
    assert.equal(sent.length, 0);
    resetAgentAliveCheck();
  });
});

describe("dispatch matrix onlyRoles", () => {
  const decision: Profile = {
    id: "dc",
    name: zhCN("labels.role.decision"),
    role: "decision",
    family: "anthropic",
    provider: "claude",
    model: "opus",
    pool: "claude-max",
    thinkingOptionId: "xhigh",
  };
  const limited = snapshot({
    "claude-max": { dispatchable: true, onlyRoles: ["reviewer"] },
    cursor: {},
    supergrok: {},
  });

  it("skips a non-reviewer on a reviewer-only pool and still picks the reviewer", () => {
    const held = route({ role: "decision", profiles: [decision, review, grok], matrix: matrix(), snapshot: limited });
    assert.equal(held.ok, false);
    if (!held.ok) {
      assert.match(held.reason, new RegExp(zhCN("pools.onlyFor", {"pool":"claude-max","roles":zhCN("labels.role.reviewer")})));
      assert.doesNotMatch(held.reason, new RegExp(localePattern(zhCNPart("routing.sum.chosen", 0, 2))));
    }
    const reviewPick = must(
      route({
        role: "reviewer",
        review: true,
        executorFamily: "xai", executorModel: "grok-4.7",
        profiles: [decision, review, grok],
        matrix: matrix(),
        snapshot: limited,
      }),
    );
    assert.equal(reviewPick.profile.name, review.name);

    const executor = must(
      route({
        tier: "L3",
        matrix: matrix({ executor: { L3: [item(complexDocsProfileName, "high"), item("Executor · Cursor Local (candidate)", "high")] } }),
        snapshot: limited,
        profiles: [grok, cursorLocal, opus, review],
      }),
    );
    assert.equal(executor.profile.name, cursorLocal.name);
    assert.match(executor.reason, new RegExp(localePattern(complexDocsProfileName) + ".*" + localePattern(zhCN("pools.onlyFor", { pool: "claude-max", roles: zhCN("labels.role.reviewer") }))));
  });

  it("refuses a pinned decision profile, and accepts the same pin when onlyRoles is absent", () => {
    const pinned = route({
      role: "decision",
      profileOverride: decision.name,
      profiles: [decision, review],
      matrix: matrix(),
      snapshot: limited,
    });
    assert.equal(pinned.ok, false);
    if (!pinned.ok) assert.match(pinned.reason, new RegExp(zhCN("pools.onlyFor", {"pool":"claude-max","roles":zhCN("labels.role.reviewer")})));

    const open = must(
      route({
        role: "decision",
        profileOverride: decision.name,
        profiles: [decision],
        matrix: matrix(),
        snapshot: snapshot({ "claude-max": { dispatchable: true } }),
      }),
    );
    assert.equal(open.profile.name, decision.name);
  });
});

describe("matrix start", () => {
  it("records the tier, profile, depth source and skips on the started event", async () => {
    const seen: string[] = [];
    const launcher: AgentLauncher = {
      async create(options) {
        seen.push(options.config.thinkingOptionId ?? "");
        return { id: "matrix-agent" };
      },
      async send() {},
      async listModels() {
        return { models: [{ id: "grok-4.7", thinkingOptions: [{ id: "low" }, { id: "medium" }, { id: "high" }, { id: "xhigh" }] }] };
      },
    };
    const config: KanbanConfig = {
      autoStart: { "matrix-start": true },
      supervisorAgentId: null,
      supervisors: {},
      concurrency: { global: 20, pools: { cursor: 20, supergrok: 20, "claude-max": 20 }, roles: { executor: 20, reviewer: 20 } },
    };
    saveConfig(config);
    const room = join(dir, "matrix-start-room");
    mkdirSync(room, { recursive: true });
    const task = createTask({ project: "matrix-start", title: "Follow matrix", role: "executor", workspacePath: room, tier: "L3" });
    const result = await runTick({
      profiles: [grok, cursorLocal, review],
      launcher,
      config,
      pools: snapshot({ supergrok: { dispatchable: false, reason: "Ahead" }, cursor: {} }),
      matrix: {
        state: "ok",
        matrix: matrix({ executor: { L3: [item(zhCN("labels.role.executor"), "high"), item("Executor · Cursor Local (candidate)", "high")] } }),
        path: join(dir, "memory.json"),
      },
    });
    const fresh = getTask(task.id);
    assert.ok(result.started.includes(task.id), `${fresh.status} ${fresh.hold_reason ?? ""} ${fresh.blocked_reason ?? ""}`);
    assert.equal(getTask(task.id).executor_profile, cursorLocal.name);
    assert.equal(seen[0], "high");
    const row = getDb().prepare("SELECT effort, thinking_option_id FROM runs WHERE task_id = ?").get(task.id) as {
      effort: string | null;
      thinking_option_id: string | null;
    };
    assert.equal(row.effort, "high");
    assert.equal(row.thinking_option_id, "high");
    const started = getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'started'").get(task.id) as { data_json: string };
    assert.match(started.data_json, /L3/);
    assert.match(started.data_json, new RegExp("Executor · Cursor Local \\(candidate\\)"));
    assert.match(started.data_json, new RegExp("high" + localePattern(zhCNPart("missingCwd.none", 0, 1)) + zhCN("routing.effortSource.matrix") + localePattern(zhCNPart("missingCwd.none", 3, 4))));
    assert.match(started.data_json, new RegExp(localePattern(zhCNPart("routing.sum.skipped", 0, 2))));
    assert.match(started.data_json, new RegExp(localePattern(zhCNPart("routing.poolClosed", 7, 10))));

    const lowDir = join(dir, "work-low");
    mkdirSync(lowDir, { recursive: true });
    const forced = createTask({ project: "matrix-start", title: "demo fixture", role: "executor", workspacePath: lowDir, tier: "L3", effort: "low" });
    const file = join(dir, "start-matrix.json");
    writeFileSync(file, JSON.stringify({ version: 1, defaultTier: "L2", downgradeWhenTight: ["L1", "L2"], roles: { executor: { L3: [{ profile: "Executor · Cursor Local (candidate)", effort: "high" }] }, reviewer: { byExecutorFamily: { xai: { L3: [{ profile: zhCN("labels.role.reviewer"), effort: "high" }] } } } } }));
    const previous = process.env.KANBAN_DISPATCH_MATRIX;
    process.env.KANBAN_DISPATCH_MATRIX = file;
    try {
      const again = await startTask(forced.id, launcher, "scheduler", { profiles: [grok, cursorLocal, review] });
      assert.match(again.message, new RegExp(zhCN("cardDrawer.settings.start")));
      const low = getDb().prepare("SELECT effort FROM runs WHERE task_id = ?").get(forced.id) as { effort: string | null };
      assert.equal(low.effort, "low");
      const reason = getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'started'").get(forced.id) as { data_json: string };
      assert.match(reason.data_json, new RegExp("low" + localePattern(zhCNPart("effort.noteCard", 11, 17))));
      const quota = JSON.parse(reason.data_json) as { quota: { generatedAt: null; state: null; dispatchable: null; usedPct: null; onlyRoles: null; matrixGeneratedAt: null } };
      assert.equal(quota.quota.generatedAt, null);
      assert.equal(quota.quota.state, null);
      assert.equal(quota.quota.dispatchable, null);
      assert.equal(quota.quota.usedPct, null);
      assert.equal(quota.quota.onlyRoles, null);
      assert.equal(quota.quota.matrixGeneratedAt, null);
    } finally {
      if (previous === undefined) delete process.env.KANBAN_DISPATCH_MATRIX;
      else process.env.KANBAN_DISPATCH_MATRIX = previous;
    }
  });
});

describe("high-risk review roster", () => {
  const fableOnly = matrix({
    reviewerFamilies: {
      xai: {
        L3: [item(zhCN("labels.role.reviewer"), "high")],
        L4: [item(highRiskProfileName, "xhigh")],
      },
      anthropic: {
        L3: [item("Reviewer A", "high")],
        L4: [item("Reviewer A", "xhigh")],
      },
    },
  });

  it("reviews an L3 high-risk card from the L4 roster after the executor would hand it over", () => {
    const picked = must(
      route({
        matrix: fableOnly,
        role: "reviewer",
        review: true,
        tier: "L3",
        tags: ["high-risk"],
        executorFamily: "xai", executorModel: "grok-4.7",
        executorProfile: zhCN("labels.role.executor"),
      }),
    );
    assert.equal(picked.profile.name, fable.name);
    assert.equal(picked.effort, "xhigh");
    assert.match(picked.reason, new RegExp("L4" + zhCN("common.comma")));
    assert.match(picked.reason, new RegExp(zhCN("routing.highRiskNote")));
  });

  it("keeps an ordinary L3 review on the ordinary reviewer", () => {
    const picked = must(
      route({
        matrix: fableOnly,
        role: "reviewer",
        review: true,
        tier: "L3",
        tags: [],
        executorFamily: "xai", executorModel: "grok-4.7",
      }),
    );
    assert.equal(picked.profile.name, review.name);
    assert.equal(picked.effort, "high");
    assert.match(picked.reason, new RegExp("L3" + zhCN("common.comma")));
    assert.doesNotMatch(picked.reason, new RegExp("high-risk " + localePattern(zhCNPart("routing.highRiskNote", 10, 14))));
  });

  it("leaves an L4 review on the L4 roster without an extra high-risk note", () => {
    const picked = must(
      route({
        matrix: fableOnly,
        role: "reviewer",
        review: true,
        tier: "L4",
        tags: ["high-risk"],
        executorFamily: "xai", executorModel: "grok-4.7",
      }),
    );
    assert.equal(picked.profile.name, fable.name);
    assert.equal(picked.effort, "xhigh");
    assert.match(picked.reason, new RegExp("^L4" + zhCN("common.comma")));
    assert.doesNotMatch(picked.reason, new RegExp(zhCN("routing.highRiskNote")));
  });

  it("keeps execution on the stored tier when the card is high-risk", () => {
    const picked = must(route({ matrix: fableOnly, tier: "L3", tags: ["high-risk"] }));
    assert.equal(picked.profile.name, cursorLocal.name);
    assert.equal(picked.effort, "high");
    assert.match(picked.reason, new RegExp("^L3" + zhCN("common.comma")));
    assert.doesNotMatch(picked.reason, new RegExp("high-risk " + localePattern(zhCNPart("routing.highRiskNote", 10, 14))));
  });

  it("does not start an L3 high-risk executor when the L4 Fable pool cannot be reserved", () => {
    const held = route({
      matrix: matrix({
        executor: { L3: [item("Executor · Cursor Local (candidate)", "high"), item(zhCN("labels.role.executor"), "high")] },
        reviewerFamilies: fableOnly.reviewerFamilies,
      }),
      tier: "L3",
      tags: ["high-risk"],
      snapshot: snapshot({ "claude-fable": { dispatchable: false, reason: "Quota exhausted" }, "claude-max": {}, cursor: {}, supergrok: {} }),
    });
    assert.equal(held.ok, false);
    if (!held.ok) {
      assert.equal(held.action, "hold");
      assert.match(held.reason, new RegExp(zhCN("routing.highRiskNote")));
      assert.match(held.reason, new RegExp(zhCN("routing.noReviewer")));
      assert.match(held.reason, new RegExp(highRiskProfileName));
      assert.match(held.reason, new RegExp(localePattern(zhCNPart("routing.poolClosed", 7, 10))));
    }
  });

  it("starts an L3 high-risk executor on the stored tier when Fable can be reserved", () => {
    const picked = must(
      route({
        matrix: fableOnly,
        tier: "L3",
        tags: ["high-risk"],
        snapshot: snapshot({ "claude-fable": {}, "claude-max": {}, cursor: {} }),
      }),
    );
    assert.equal(picked.profile.name, cursorLocal.name);
    assert.equal(picked.effort, "high");
    assert.equal(picked.effortSource, "matrix");
    assert.match(picked.reason, new RegExp("^L3" + zhCN("common.comma")));
    assert.doesNotMatch(picked.reason, new RegExp("high-risk " + localePattern(zhCNPart("routing.highRiskNote", 10, 14))));
  });

  it("still starts an ordinary L3 executor when only the L4 Fable pool is closed", () => {
    const picked = must(
      route({
        matrix: fableOnly,
        tier: "L3",
        tags: [],
        snapshot: snapshot({ "claude-fable": { dispatchable: false, reason: "Quota exhausted" }, "claude-max": {}, cursor: {} }),
      }),
    );
    assert.equal(picked.profile.name, cursorLocal.name);
    assert.equal(picked.effort, "high");
    assert.match(picked.reason, new RegExp("^L3" + zhCN("common.comma")));
    assert.doesNotMatch(picked.reason, new RegExp("high-risk " + localePattern(zhCNPart("routing.highRiskNote", 10, 14))));
  });

  it("still starts an L3 high-risk executor when that family's L4 review list is missing", () => {
    const picked = must(
      route({
        matrix: matrix({
          reviewerFamilies: {
            xai: { L3: [item(zhCN("labels.role.reviewer"), "high")] },
          },
        }),
        tier: "L3",
        tags: ["high-risk"],
      }),
    );
    assert.equal(picked.profile.name, cursorLocal.name);
    assert.equal(picked.effort, "high");
    assert.match(picked.reason, new RegExp("^L3" + zhCN("common.comma")));
    assert.doesNotMatch(picked.reason, new RegExp(zhCN("routing.highRiskNote")));
  });

  it("queues when the L4 Fable pool cannot be dispatched, and does not drop to the L3 reviewer", () => {
    const held = route({
      matrix: fableOnly,
      role: "reviewer",
      review: true,
      tier: "L3",
      tags: ["high-risk"],
      executorFamily: "xai", executorModel: "grok-4.7",
      snapshot: snapshot({ "claude-fable": { dispatchable: false, reason: "Quota exhausted" }, "claude-max": {} }),
    });
    assert.equal(held.ok, false);
    if (!held.ok) {
      assert.equal(held.action, "hold");
      assert.match(held.reason, new RegExp("^L4" + zhCN("common.comma")));
      assert.match(held.reason, new RegExp(localePattern(zhCNPart("routing.poolClosed", 7, 10))));
      assert.match(held.reason, new RegExp(zhCN("routing.highRiskNote")));
      assert.doesNotMatch(held.reason, new RegExp(localePattern(zhCNPart("routing.sum.chosen", 0, 2))));
    }
  });

  it("falls back to the stored tier when that family's L4 review list is missing", () => {
    const picked = must(
      route({
        matrix: matrix({
          reviewerFamilies: {
            xai: { L3: [item(zhCN("labels.role.reviewer"), "high")] },
          },
        }),
        role: "reviewer",
        review: true,
        tier: "L3",
        tags: ["high-risk"],
        executorFamily: "xai", executorModel: "grok-4.7",
      }),
    );
    assert.equal(picked.profile.name, review.name);
    assert.equal(picked.effort, "high");
    assert.match(picked.reason, new RegExp("L3" + zhCN("common.comma")));
    assert.match(picked.reason, new RegExp("L4 " + localePattern(zhCNPart("routing.highRiskMissing", 15, 25)) + "L3"));
  });

  it("reviews a standalone high-risk card from the L4 roster", () => {
    const picked = must(
      route({
        matrix: fableOnly,
        role: "reviewer",
        review: true,
        tier: "L3",
        tags: ["high-risk"],
      }),
    );
    assert.equal(picked.profile.name, fable.name);
    assert.match(picked.reason, new RegExp(zhCN("routing.highRiskNote")));
  });

  it("does not rewrite the stored tier when a card is created or tagged high-risk", () => {
    const created = createTask({
      project: "tier",
      title: "High risk remains L3",
      role: "executor",
      workspacePath: work,
      tier: "L3",
      tags: ["high-risk"],
    });
    assert.equal(created.tier, "L3");
    assert.equal(getDetail(created.id).task.tier, "L3");
    assert.equal(getDetail(created.id).task.tierLabel, "L3");
    const later = createTask({ project: "tier", title: "Tag added later", role: "executor", workspacePath: work, tier: "L2" });
    const tagged = addTaskTags(later.id, ["high-risk"], "supervisor");
    assert.equal(tagged.tier, "L2");
    assert.equal(getDetail(later.id).task.tierLabel, "L2");
    assert.match(kanbanHelp(), new RegExp(localePattern(zhCNPart("profileRules.tag.highRisk", 27, 33))));
    assert.match(kanbanHelp(), new RegExp("L4 " + localePattern(zhCNPart("routing.highRiskNote", 15, 19))));
  });

  it("opens Fable when an L3 high-risk executor card is waiting for review", async () => {
    const room = join(dir, "high-risk-review");
    mkdirSync(room, { recursive: true });
    const task = createTask({
      project: "high-risk-review",
      title: "Review after completion",
      role: "executor",
      workspacePath: room,
      tier: "L3",
      tags: ["high-risk"],
    });
    getDb()
      .prepare(
        ("UPDATE tasks SET status = 'in_review', executor_family = 'xai', executor_profile = '" + zhCN("labels.role.executor") + "', executor_agent_id = 'exec-done' WHERE id = ?"),
      )
      .run(task.id);
    recordFixtureDelivery(task.id, "grok-4.7");
    const config: KanbanConfig = {
      autoStart: { "high-risk-review": true },
      supervisorAgentId: null,
      supervisors: {},
      concurrency: { global: 20, pools: { cursor: 20, supergrok: 20, "claude-max": 20, "claude-fable": 20 }, roles: { executor: 20, reviewer: 20 } },
    };
    saveConfig(config);
    const result = await runTick({
      profiles: [grok, cursorLocal, review, fable, xaiReview],
      launcher: {
        async create() {
          return { id: "fable-reviewer" };
        },
        async send() {},
        async listModels() {
          return { models: [{ id: "claude-fable-5-1", thinkingOptions: [{ id: "xhigh" }] }, { id: "claude-sonnet-5", thinkingOptions: [{ id: "high" }] }] };
        },
      },
      config,
      pools: snapshot(),
      matrix: { state: "ok", matrix: fableOnly, path: join(dir, "high-risk-matrix.json") },
    });
    assert.ok(result.started.includes(task.id), getTask(task.id).hold_reason ?? getTask(task.id).blocked_reason ?? getTask(task.id).status);
    assert.equal(getTask(task.id).tier, "L3");
    assert.equal(getTask(task.id).status, "reviewing");
    const started = getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'started'").get(task.id) as { data_json: string };
    assert.match(started.data_json, new RegExp(highRiskProfileName));
    assert.match(started.data_json, new RegExp(zhCN("routing.highRiskNote")));
  });

  function reserveConfig(project: string): KanbanConfig {
    return {
      autoStart: { [project]: true },
      supervisorAgentId: null,
      supervisors: {},
      concurrency: {
        global: 20,
        pools: { cursor: 20, supergrok: 20, "claude-max": 20, "claude-fable": 20 },
        roles: { executor: 20, reviewer: 20 },
      },
    };
  }

  it("does not start an L3 high-risk executor and records why Fable cannot be reserved", async () => {
    const project = "high-risk-reserve-closed";
    const room = join(dir, project);
    mkdirSync(room, { recursive: true });
    const task = createTask({
      project,
      title: "Fable unavailable for reservation",
      role: "executor",
      workspacePath: room,
      tier: "L3",
      tags: ["high-risk"],
    });
    const config = reserveConfig(project);
    saveConfig(config);
    const result = await runTick({
      profiles: [grok, cursorLocal, review, fable, xaiReview],
      launcher: {
        async create() {
          return { id: "should-not-start" };
        },
        async send() {},
        async listModels() {
          return { models: [] };
        },
      },
      config,
      pools: snapshot({ "claude-fable": { dispatchable: false, reason: "Quota exhausted" }, "claude-max": {}, cursor: {}, supergrok: {} }),
      matrix: { state: "ok", matrix: fableOnly, path: join(dir, "reserve-closed.json") },
    });
    assert.equal(result.started.includes(task.id), false);
    const waiting = getTask(task.id);
    assert.equal(waiting.status, "ready");
    assert.equal(waiting.tier, "L3");
    assert.match(waiting.hold_reason ?? "", new RegExp(zhCN("routing.highRiskNote")));
    assert.match(waiting.hold_reason ?? "", new RegExp(zhCN("routing.noReviewer")));
    assert.match(waiting.hold_reason ?? "", new RegExp(highRiskProfileName));
    assert.match(waiting.hold_reason ?? "", new RegExp(localePattern(zhCNPart("routing.poolClosed", 7, 10))));
  });

  it("starts an L3 high-risk executor when Fable can be reserved, still at L3", async () => {
    const project = "high-risk-reserve-open";
    const room = join(dir, project);
    mkdirSync(room, { recursive: true });
    const task = createTask({
      project,
      title: "Fable reservation available",
      role: "executor",
      workspacePath: room,
      tier: "L3",
      tags: ["high-risk"],
    });
    const config = reserveConfig(project);
    saveConfig(config);
    const result = await runTick({
      profiles: [grok, cursorLocal, review, fable, xaiReview],
      launcher: {
        async create() {
          return { id: "cursor-executor" };
        },
        async send() {},
        async listModels() {
          return { models: [{ id: "grok-4.7", thinkingOptions: [{ id: "high" }] }] };
        },
      },
      config,
      pools: snapshot({ "claude-fable": {}, "claude-max": {}, cursor: {}, supergrok: {} }),
      matrix: { state: "ok", matrix: fableOnly, path: join(dir, "reserve-open.json") },
    });
    assert.ok(result.started.includes(task.id), getTask(task.id).hold_reason ?? getTask(task.id).status);
    assert.equal(getTask(task.id).status, "running");
    assert.equal(getTask(task.id).tier, "L3");
    const started = getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'started'").get(task.id) as { data_json: string };
    assert.match(started.data_json, /L3/);
    assert.match(started.data_json, new RegExp("high" + localePattern(zhCNPart("missingCwd.none", 0, 1)) + zhCN("routing.effortSource.matrix") + localePattern(zhCNPart("missingCwd.none", 3, 4))));
    assert.doesNotMatch(started.data_json, new RegExp(zhCN("routing.highRiskNote")));
  });
});
