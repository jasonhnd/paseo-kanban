/// <reference types="node" />
// Anonymous ops-role counterexample. Profiles, pools and cards are synthetic.
// Nothing here reads a production matrix, a real profile file, or a live provider.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { AgentPermissionRequest } from "@getpaseo/protocol/agent-types";
import { setLanguage } from "../shared/i18n";
import { CONTRACT_SCHEMA, PLUGIN_IDS } from "../shared/contract/schema";
import { saveConfig, type KanbanConfig } from "../server/config";
import { closeDb, getDb } from "../server/db";
import type { AgentLauncher } from "../server/dispatch";
import { parseDispatchMatrix, type DispatchMatrix } from "../server/matrix";
import { decidePermission } from "../server/permissions";
import { readCompatibilityPoolSnapshot as readPoolSnapshot, type PoolSnapshot } from "../server/pools";
import type { Profile } from "../server/profiles";
import { routeProfile, type RouteDecision, type RouteInput } from "../server/routing";
import { runTick } from "./helpers/compat-schedule";
import { createTask, getTask } from "../server/store";

setLanguage("en");

const dir = mkdtempSync(join(tmpdir(), "ops-matrix-demo-"));
process.env.KANBAN_DATA_DIR = dir;


process.env.KANBAN_AGENTS_DIR = join(dir, "agents");
process.env.KANBAN_WORKTREES_ROOT = join(dir, "worktrees");
process.env.PASEO_HOME = join(dir, "paseo");
process.env.KANBAN_PASEO_CONFIG = join(dir, "paseo", "config.json");
process.env.AFC_TRANSCRIPT_HOME = join(dir, "transcripts");
delete process.env.KANBAN_DISPATCH_MATRIX;
delete process.env.KANBAN_POOL_STATUS;
for (const path of [
  dir,
  join(process.env.KANBAN_DATA_DIR!, "fleet"),
  process.env.KANBAN_AGENTS_DIR,
  process.env.KANBAN_WORKTREES_ROOT,
  process.env.PASEO_HOME,
  process.env.AFC_TRANSCRIPT_HOME,
]) {
  mkdirSync(path, { recursive: true });
}
writeFileSync(process.env.KANBAN_PASEO_CONFIG, '{"providers":{},"profiles":[],"relay":{"enabled":false}}\n');

const OPS = [
  ["ops_vercel", "Demo Vercel"],
  ["ops_cloudflare", "Demo Cloudflare"],
  ["ops_github", "Demo GitHub"],
  ["ops_notion", "Demo Notion"],
] as const;

/** Reported matrix shape, with made-up profile objects. Not an AFC export. */
function anonymousMatrix(opsBodies: Record<string, unknown> = {}): Record<string, unknown> {
  const ops = Object.fromEntries(OPS.map(([role, name]) => [role, { "*": [{ profile: name, effort: "medium" }] }]));
  return {
    version: 1,
    defaultTier: "L2",
    generatedAt: "2030-01-01T00:00:00.000Z",
    downgradeWhenTight: ["L1", "L2"],
    roles: {
      executor: { L3: [{ profile: "Demo Executor", effort: "high" }] },
      reviewer: { byExecutorFamily: { xai: { L3: [{ profile: "Demo Reviewer", effort: "high" }] } } },
      reader: { "*": [{ profile: "Demo Reader", effort: "medium" }] },
      decision: { "*": [{ profile: "Demo Decision", effort: "xhigh" }] },
      batch: { "*": [{ profile: "Demo Batch", effort: "low" }] },
      ...ops,
      ...opsBodies,
      custodian: { "*": [{ profile: "Demo Ignored", effort: "medium" }] },
    },
  };
}

function demoProfile(name: string, role: string, patch: Partial<Profile> = {}): Profile {
  return {
    id: `demo-${role}-${name}`,
    name,
    role,
    family: "anthropic",
    provider: "claude",
    model: "claude-sonnet-5",
    pool: "demo-claude",
    // Profile default is high. A correct L3 ops pick must keep the matrix medium.
    thinkingOptionId: "high",
    ...patch,
  };
}

const opsProfiles = OPS.map(([role, name]) => demoProfile(name, role));
const normalProfiles: Profile[] = [
  demoProfile("Demo Executor", "executor", { family: "xai", provider: "grok", model: "grok-4.7", pool: "demo-grok" }),
  demoProfile("Demo Reviewer", "reviewer", { family: "anthropic", provider: "claude", model: "claude-sonnet-5", pool: "demo-claude" }),
  demoProfile("Demo Reader", "reader"),
  demoProfile("Demo Decision", "decision"),
  demoProfile("Demo Batch", "batch"),
];
const outside = demoProfile("Demo Outside Executor", "executor", { family: "xai", provider: "grok", model: "grok-4.7", pool: "demo-grok" });

function openSnapshot(pools: Record<string, { dispatchable?: boolean; reason?: string | null }> = {}): PoolSnapshot {
  const entry = (pool: string | null) => {
    const raw = pool ? pools[pool] : undefined;
    return {
      dispatchable: raw?.dispatchable !== false,
      deprioritize: false,
      prefer: false,
      resetsAt: null,
      reason: raw?.reason ?? null,
      onlyRoles: null,
    };
  };
  return {
    state: "fresh",
    message: "synthetic quota",
    generatedAt: "2030-01-01T00:00:00.000Z",
    dispatchable: (pool) => entry(pool).dispatchable,
    entry,
    hasPool: (pool) => Boolean(pool && Object.prototype.hasOwnProperty.call(pools, pool)),
  };
}

function route(patch: Partial<RouteInput> & { matrix: DispatchMatrix }): RouteDecision {
  return routeProfile({
    profiles: [...opsProfiles, ...normalProfiles, outside],
    role: "ops_vercel",
    review: false,
    byPool: {},
    poolLimits: {},
    snapshot: openSnapshot({ "demo-claude": {}, "demo-grok": {} }),
    tags: [],
    project: "ops-demo",
    ...patch,
  });
}

function must(decision: RouteDecision): Extract<RouteDecision, { ok: true }> {
  if (!decision.ok) throw new Error(decision.reason);
  return decision;
}

const config: KanbanConfig = {
  autoStart: { "ops-demo": true },
  supervisorAgentId: null,
  supervisors: {},
  concurrency: {
    global: 20,
    pools: { "demo-claude": 20, "demo-grok": 20 },
    roles: {
      executor: 20,
      reviewer: 20,
      reader: 20,
      decision: 20,
      batch: 20,
      ops_vercel: 20,
      ops_cloudflare: 20,
      ops_github: 20,
      ops_notion: 20,
    },
  },
};

after(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe("ops roles in the dispatch matrix", () => {
  it("parses each ops * list and keeps effort, order and paused", () => {
    const parsed = parseDispatchMatrix(anonymousMatrix({
      ops_vercel: {
        "*": [
          { profile: "Demo Vercel Later", effort: "medium", order: 2 },
          { profile: "Demo Vercel", effort: "medium", order: 1, paused: false },
        ],
      },
      ops_github: { "*": [{ profile: "Demo GitHub", effort: "medium", paused: true }] },
    }));
    assert.deepEqual(parsed.star.ops_vercel?.map((item) => item.profile), ["Demo Vercel Later", "Demo Vercel"]);
    assert.equal(parsed.star.ops_vercel?.[0]?.effort, "medium");
    assert.equal(parsed.star.ops_vercel?.[0]?.order, 2);
    assert.equal(parsed.star.ops_vercel?.[1]?.order, 1);
    assert.equal(parsed.star.ops_vercel?.[1]?.paused, false);
    assert.equal(parsed.star.ops_cloudflare?.[0]?.effort, "medium");
    assert.equal(parsed.star.ops_notion?.[0]?.profile, "Demo Notion");
    assert.equal(parsed.star.ops_github?.[0]?.paused, true);
    assert.equal(Object.hasOwn(parsed.star, "custodian"), false);
    assert.equal(parsed.executor.L3?.[0]?.profile, "Demo Executor");
    assert.equal(parsed.reviewerFamilies.xai?.L3?.[0]?.profile, "Demo Reviewer");
    assert.equal(parsed.star.reader?.[0]?.profile, "Demo Reader");
    assert.equal(parsed.star.decision?.[0]?.effort, "xhigh");
    assert.equal(parsed.star.batch?.[0]?.effort, "low");
  });

  it("routes L3 ops cards to the * list and does not rewrite medium into high", () => {
    const parsed = parseDispatchMatrix(anonymousMatrix({
      ops_vercel: {
        "*": [
          { profile: "Demo Vercel Later", effort: "medium", order: 2 },
          { profile: "Demo Vercel", effort: "medium", order: 1 },
        ],
      },
    }));
    const later = demoProfile("Demo Vercel Later", "ops_vercel");
    const profiles = [...opsProfiles, later, ...normalProfiles, outside];
    for (const [role, name] of OPS) {
      const picked = must(route({ matrix: parsed, role, tier: "L3", profiles }));
      assert.equal(picked.profile.name, name);
      assert.equal(picked.profile.provider, "claude");
      assert.equal(picked.profile.family, "anthropic");
      assert.equal(picked.effort, "medium");
      assert.equal(picked.effortSource, "matrix");
      assert.notEqual(picked.effort, "high");
      assert.match(picked.reason, /^L3,/);
      assert.match(picked.reason, /medium \(matrix\)/);
      assert.doesNotMatch(picked.reason, /high \(matrix\)/);
    }
    const vercel = must(route({ matrix: parsed, role: "ops_vercel", tier: "L3", profiles }));
    assert.equal(vercel.profile.name, "Demo Vercel");
  });

  it("keeps the five ordinary roles on their existing lists", () => {
    const parsed = parseDispatchMatrix(anonymousMatrix());
    const executor = must(route({ matrix: parsed, role: "executor", tier: "L3", review: false }));
    assert.equal(executor.profile.name, "Demo Executor");
    assert.equal(executor.effort, "high");
    const reviewer = must(route({
      matrix: parsed,
      role: "reviewer",
      review: true,
      tier: "L3",
      executorFamily: "xai", executorModel: "grok-4.7",
    }));
    assert.equal(reviewer.profile.name, "Demo Reviewer");
    assert.equal(reviewer.effort, "high");
    assert.equal(must(route({ matrix: parsed, role: "reader", tier: "L3" })).profile.name, "Demo Reader");
    assert.equal(must(route({ matrix: parsed, role: "decision", tier: "L4" })).effort, "xhigh");
    assert.equal(must(route({ matrix: parsed, role: "batch", tier: "L1" })).effort, "low");
  });

  it("holds missing, empty, paused and unknown roles inside the matrix", () => {
    const missing = parseDispatchMatrix(anonymousMatrix({ ops_vercel: { L3: [{ profile: "Demo Vercel", effort: "high" }] } }));
    assert.equal(missing.star.ops_vercel, undefined);
    const missingRoute = route({ matrix: missing, role: "ops_vercel", tier: "L3" });
    assert.equal(missingRoute.ok, false);
    if (!missingRoute.ok) {
      assert.equal(missingRoute.action, "hold");
      assert.match(missingRoute.reason, /no candidates for ops_vercel/);
      assert.match(missingRoute.reason, /not switching to a profile outside the matrix/);
      assert.doesNotMatch(missingRoute.reason, /Demo Executor|Demo Outside Executor/);
    }

    const empty = parseDispatchMatrix(anonymousMatrix({ ops_notion: { "*": [] } }));
    assert.deepEqual(empty.star.ops_notion, []);
    const emptyRoute = route({ matrix: empty, role: "ops_notion", tier: "L3" });
    assert.equal(emptyRoute.ok, false);
    if (!emptyRoute.ok) assert.match(emptyRoute.reason, /no candidates for ops_notion/);

    const paused = parseDispatchMatrix(anonymousMatrix({
      ops_cloudflare: { "*": [{ profile: "Demo Cloudflare", effort: "medium", paused: true }] },
    }));
    const pausedRoute = route({ matrix: paused, role: "ops_cloudflare", tier: "L3" });
    assert.equal(pausedRoute.ok, false);
    if (!pausedRoute.ok) {
      assert.equal(pausedRoute.action, "hold");
      assert.match(pausedRoute.reason, /paused in the matrix/);
      assert.doesNotMatch(pausedRoute.reason, /Demo Executor/);
    }

    const unknown = route({ matrix: parseDispatchMatrix(anonymousMatrix()), role: "custodian", tier: "L3" });
    assert.equal(unknown.ok, false);
    if (!unknown.ok) assert.match(unknown.reason, /no candidates for custodian/);

    const noMatrix = must(routeProfile({
      profiles: opsProfiles,
      role: "ops_github",
      review: false,
      byPool: {},
      poolLimits: {},
      snapshot: openSnapshot({ "demo-claude": {} }),
      matrix: null,
      tier: "L3",
    }));
    assert.equal(noMatrix.profile.name, "Demo GitHub");
  });

  it("rejects a malformed known ops object, list or item", () => {
    const base = { version: 1, defaultTier: "L2", downgradeWhenTight: ["L1"], roles: {} as Record<string, unknown> };
    const cases: Array<[unknown, RegExp]> = [
      [{ "*": "nope" }, /ops_vercel\.\* is not an array/],
      [[], /ops_cloudflare is not an object/],
      [{ "*": [{ effort: "medium" }] }, /missing a profile name/],
      [{ "*": [{ profile: "Demo GitHub", effort: "huge" }] }, /invalid effort/],
      [{ "*": [{ profile: "Demo Notion", effort: "medium", order: 0 }] }, /order must be an integer from 1 to 1000/],
    ];
    const roles = ["ops_vercel", "ops_cloudflare", "ops_github", "ops_notion", "ops_notion"] as const;
    cases.forEach(([body, pattern], index) => {
      const role = roles[index] ?? "ops_vercel";
      assert.throws(() => parseDispatchMatrix({ ...base, roles: { [role]: body } }), pattern);
    });
  });

  it("keeps every ops role inside its wildcard list under negative conditions", () => {
    const parsed = parseDispatchMatrix(anonymousMatrix());
    for (const [role, name] of OPS) {
      const otherTier = { L3: [{ profile: name, effort: "high" }] };
      const missing = parseDispatchMatrix(anonymousMatrix({ [role]: otherTier }));
      const empty = parseDispatchMatrix(anonymousMatrix({ [role]: { ...otherTier, "*": [] } }));
      const paused = parseDispatchMatrix(anonymousMatrix({ [role]: { "*": [{ profile: name, effort: "medium", paused: true }] } }));
      const cases: Array<Partial<RouteInput> & { matrix: DispatchMatrix }> = [
        { matrix: missing },
        { matrix: empty },
        { matrix: paused },
        { matrix: parsed, snapshot: { ...openSnapshot(), state: "missing" } },
        { matrix: parsed, snapshot: openSnapshot({ "demo-claude": { dispatchable: false } }) },
        { matrix: parsed, byPool: { "demo-claude": 1 }, poolLimits: { "demo-claude": 1 } },
        { matrix: parsed, profiles: opsProfiles.map(profile => profile.role === role ? { ...profile, paused: true } : profile) },
        { matrix: parsed, profiles: opsProfiles.map(profile => profile.role === role ? { ...profile, role: "personal", pausedCandidateFor: role } : profile) },
      ];
      for (const patch of cases) {
        const decision = route({ role, tier: "L3", ...patch });
        assert.equal(decision.ok, false, `${role}: ${decision.reason}`);
        if (!decision.ok) assert.equal(decision.action, "hold", `${role}: ${decision.reason}`);
      }
      const missingProfile = route({ matrix: parsed, role, tier: "L3", profiles: [...normalProfiles, outside] });
      assert.equal(missingProfile.ok, false, role);
      if (!missingProfile.ok) assert.equal(missingProfile.action, "block", role);
      for (const body of [[], { "*": "invalid" }, { "*": [{ profile: name, effort: "invalid" }] }]) {
        assert.throws(() => parseDispatchMatrix(anonymousMatrix({ [role]: body })), /is not an object|is not an array|invalid effort/, role);
      }
    }
  });

  it("preserves ordinary public tier lists while ops use only wildcard lists", () => {
    const parsed = parseDispatchMatrix(anonymousMatrix({
      reader: { "*": [{ profile: "Demo Reader", effort: "medium" }], L3: [{ profile: "Demo Reader", effort: "high" }], L4: [] },
      ops_vercel: { "*": [{ profile: "Demo Vercel", effort: "medium" }], L3: [{ profile: "Demo Outside Executor", effort: "high" }] },
    }));
    assert.equal(must(route({ matrix: parsed, role: "reader", tier: "L3" })).effort, "high");
    assert.equal(route({ matrix: parsed, role: "reader", tier: "L4" }).ok, false);
    assert.equal(must(route({ matrix: parsed, role: "ops_vercel", tier: "L3" })).effort, "medium");
    assert.equal(Object.hasOwn(parsed.starTiers ?? {}, "ops_vercel"), false);
    assert.throws(() => parseDispatchMatrix(anonymousMatrix({ reader: { L3: "invalid" } })), /reader.L3 is not an array/);
  });

  it("retains the source explicit-profile behavior for ops", () => {
    const parsed = parseDispatchMatrix(anonymousMatrix());
    for (const [role, name] of OPS) {
      const picked = must(route({
        matrix: parsed,
        role,
        tier: "L3",
        profileOverride: name,
        snapshot: { ...openSnapshot(), state: "missing" },
        profiles: opsProfiles.map(profile => profile.role === role ? { ...profile, paused: true } : profile),
      }));
      assert.equal(picked.profile.name, name);
      assert.equal(picked.effort, "medium");
    }
  });

  it("does not treat an ops card as an executor or a reviewer, and does not grant a new write", () => {
    const parsed = parseDispatchMatrix(anonymousMatrix());
    const alone = must(route({
      matrix: parsed,
      role: "ops_notion",
      tier: "L3",
      profiles: [demoProfile("Demo Notion", "ops_notion")],
    }));
    assert.equal(alone.profile.role, "ops_notion");
    assert.equal(alone.effort, "medium");

    const googleFirst = route({
      matrix: parsed,
      role: "ops_vercel",
      tier: "L3",
      profiles: [
        demoProfile("Demo Google", "ops_vercel", { family: "google", provider: "claude", model: "claude-sonnet-5" }),
        demoProfile("Demo Vercel", "ops_vercel"),
      ],
    });
    // The matrix names only Demo Vercel. A google-family profile of another name is outside that list.
    assert.equal(must(googleFirst).profile.name, "Demo Vercel");
    const onlyGoogle = route({
      matrix: parseDispatchMatrix(anonymousMatrix({
        ops_vercel: { "*": [{ profile: "Demo Google", effort: "medium" }] },
      })),
      role: "ops_vercel",
      tier: "L3",
      profiles: [demoProfile("Demo Google", "ops_vercel", { family: "google" })],
    });
    assert.equal(onlyGoogle.ok, false);

    const write = {
      id: "perm",
      provider: "claude",
      name: "edit",
      kind: "tool",
      title: "edit",
      detail: { type: "edit", filePath: "README.md", oldString: "", newString: "x" },
      actions: [{ id: "allow-once", label: "Allow once", behavior: "allow" }],
    } as unknown as AgentPermissionRequest;
    for (const [role] of OPS) {
      assert.equal(decidePermission({ kanban: true, autoAccept: false, role, request: write }).action, "deny", role);
    }
  });
});

describe("ops dispatch stays behind the existing gates", { concurrency: false }, () => {
  function launcher(allow: boolean): AgentLauncher & { opened: Array<{ provider: string; thinking: string; role: string | undefined }> } {
    const opened: Array<{ provider: string; thinking: string; role: string | undefined }> = [];
    return {
      opened,
      async create(options) {
        opened.push({
          provider: options.config.provider,
          thinking: options.config.thinkingOptionId ?? "",
          role: options.labels?.role,
        });
        if (!allow) throw new Error("mock launcher must not start a provider");
        return { id: `demo-agent-${opened.length}` };
      },
      async send() {},
      async listModels() {
        return { models: [{ id: "claude-sonnet-5", thinkingOptions: [{ id: "low" }, { id: "medium" }, { id: "high" }] }] };
      },
    };
  }

  function card(role: string, title: string) {
    const room = join(dir, `${role}-${title}`);
    mkdirSync(room, { recursive: true });
    return createTask({ project: "ops-demo", title, role, workspacePath: room, tier: "L3" });
  }

  async function tick(matrixBody: Record<string, unknown>, pools: PoolSnapshot, allowCreate: boolean, limits = config.concurrency) {
    saveConfig({ ...config, concurrency: limits });
    return {
      launcher: launcher(allowCreate),
      result: await runTick({
        profiles: [...opsProfiles, ...normalProfiles, outside],
        launcher: launcher(allowCreate),
        config: { ...config, concurrency: limits },
        pools,
        matrix: { state: "ok", matrix: parseDispatchMatrix(matrixBody), path: join(dir, "matrix.json") },
      }),
    };
  }

  it("starts each ops role from the matrix with medium, not the profile high", async () => {
    saveConfig(config);
    const seen: Array<{ provider: string; thinking: string; role: string | undefined; autoAccept: unknown }> = [];
    const mock: AgentLauncher = {
      async create(options) {
        seen.push({
          provider: options.config.provider,
          thinking: options.config.thinkingOptionId ?? "",
          role: options.labels?.role,
          autoAccept: options.config.featureValues?.auto_accept,
        });
        return { id: `ops-agent-${seen.length}` };
      },
      async send() {},
      async listModels() {
        return { models: [{ id: "claude-sonnet-5", thinkingOptions: [{ id: "low" }, { id: "medium" }, { id: "high" }] }] };
      },
    };
    const tasks = OPS.map(([role, name]) => ({ role, name, task: card(role, name) }));
    const result = await runTick({
      profiles: [...opsProfiles, ...normalProfiles],
      launcher: mock,
      config,
      pools: openSnapshot({ "demo-claude": { dispatchable: true } }),
      matrix: { state: "ok", matrix: parseDispatchMatrix(anonymousMatrix()), path: join(dir, "matrix.json") },
    });
    for (const item of tasks) {
      const fresh = getTask(item.task.id);
      assert.ok(result.started.includes(item.task.id), `${item.role} ${fresh.status} ${fresh.hold_reason ?? ""}`);
      assert.equal(fresh.status, "running");
      assert.equal(fresh.executor_profile, item.name);
      assert.equal(fresh.executor_family, "anthropic");
      const run = getDb().prepare("SELECT role, profile_name, provider, model, family, effort, thinking_option_id, auto_accept FROM runs WHERE task_id = ?").get(item.task.id) as {
        role: string;
        profile_name: string;
        provider: string;
        model: string;
        family: string;
        effort: string;
        thinking_option_id: string;
        auto_accept: number;
      };
      assert.equal(run.role, item.role);
      assert.equal(run.profile_name, item.name);
      assert.equal(run.provider, "claude");
      assert.equal(run.model, "claude-sonnet-5");
      assert.equal(run.family, "anthropic");
      assert.equal(run.effort, "medium");
      assert.equal(run.thinking_option_id, "medium");
      assert.equal(run.auto_accept, 0);
    }
    assert.deepEqual(seen.map((item) => item.thinking), ["medium", "medium", "medium", "medium"]);
    // create config joins provider and model. The run row above keeps them separate.
    assert.ok(seen.every((item) => item.provider === "claude/claude-sonnet-5" && item.autoAccept !== true));
    assert.deepEqual(seen.map((item) => item.role), OPS.map(([role]) => role));
  });

  function writePool(name: string, body: Record<string, unknown>): void {
    const folder = join(process.env.KANBAN_DATA_DIR!, "exports", "fleet");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "pool-status.json"), JSON.stringify({
      schema: CONTRACT_SCHEMA,
      producer: PLUGIN_IDS.cockpit,
      producerVersion: "0.0.0-demo",
      generatedAt: new Date().toISOString(),
      ttlSeconds: 900,
      quotaConfigured: true,
      priority: null,
      ...body,
    }));

    delete process.env.KANBAN_POOL_STATUS;
    void name;
  }

  function isolate(taskId: number): void {
    // runTick starts every queued card in this file's database. Park the earlier ones
    // so a launcher call belongs to the card this example just created.
    getDb().prepare(
      `UPDATE tasks SET status = 'blocked', blocked_kind = 'needs_human', blocked_from = status
       WHERE id != ? AND status IN ('ready', 'in_review', 'rework')`,
    ).run(taskId);
  }

  async function held(role: string, title: string, matrixBody: Record<string, unknown>, pools: PoolSnapshot, pattern: RegExp, limits = config.concurrency) {
    const task = card(role, title);
    isolate(task.id);
    const mock = launcher(false);
    saveConfig({ ...config, concurrency: limits });
    const result = await runTick({
      profiles: [...opsProfiles, ...normalProfiles, outside],
      launcher: mock,
      config: { ...config, concurrency: limits },
      pools,
      matrix: { state: "ok", matrix: parseDispatchMatrix(matrixBody), path: join(dir, "matrix.json") },
    });
    const fresh = getTask(task.id);
    assert.equal(fresh.status, "ready");
    assert.equal(result.started.includes(task.id), false);
    assert.match(fresh.hold_reason ?? "", pattern);
    assert.equal(mock.opened.length, 0);
  }

  it("waits on a missing, closed or expired quota reading", async () => {
    writePool("missing", { pools: { "other-demo": {
      dispatchable: true, deprioritize: false, prefer: false, usedPct: 10, resetsAt: null, onlyRoles: null, reason: null,
    } } });
    const missing = readPoolSnapshot();
    assert.equal(missing.entry("demo-claude").dispatchable, false);
    assert.match(missing.entry("demo-claude").reason ?? "", /not configured/);
    await held("ops_vercel", "missing-quota", anonymousMatrix(), missing, /not configured/);

    writePool("closed", { pools: { "demo-claude": {
      dispatchable: false, deprioritize: false, prefer: false, usedPct: 40, resetsAt: null, onlyRoles: null, reason: "quota exhausted",
    } } });
    const closed = readPoolSnapshot();
    assert.equal(closed.entry("demo-claude").dispatchable, false);
    await held("ops_cloudflare", "closed-pool", anonymousMatrix(), closed, /quota exhausted|not dispatchable/);

    writePool("expired", { pools: { "demo-claude": {
      quotaProtection: "pause",
      readingExpiresAt: "2020-01-01T00:00:00.000Z",
      dispatchable: true,
      deprioritize: false,
      prefer: false,
      usedPct: 10,
      resetsAt: null,
      onlyRoles: null,
      reason: null,
    } } });
    const expired = readPoolSnapshot();
    assert.equal(expired.entry("demo-claude").dispatchable, false);
    assert.match(expired.entry("demo-claude").reason ?? "", /expired/);
    await held("ops_github", "expired-reading", anonymousMatrix(), expired, /expired/);
  });

  it("waits when the pool is full or the matrix profile is paused", async () => {
    const open = openSnapshot({ "demo-claude": { dispatchable: true } });
    await held(
      "ops_notion",
      "full-pool",
      anonymousMatrix(),
      open,
      /pool concurrency is full/,
      { ...config.concurrency, pools: { ...config.concurrency.pools, "demo-claude": 0 } },
    );
    await held(
      "ops_notion",
      "paused",
      anonymousMatrix({ ops_notion: { "*": [{ profile: "Demo Notion", effort: "medium", paused: true }] } }),
      open,
      /paused in the matrix/,
    );
  });

  it("compatibility fixtures retain ordinary fallback while production policy absence closes admission", async () => {
    const folder = join(process.env.KANBAN_DATA_DIR!, "exports", "fleet");
    mkdirSync(folder, { recursive: true });
    const poolFile = join(folder, "pool-status.json");
    rmSync(poolFile, { force: true });
    delete process.env.KANBAN_POOL_STATUS;

    const absent = readPoolSnapshot();
    assert.equal(absent.state, "missing");
    assert.equal(absent.entry("demo-claude").dispatchable, true);
    await held("ops_vercel", "missing-export", anonymousMatrix(), absent, /no usable quota reading/);

    writeFileSync(poolFile, "{");
    const invalid = readPoolSnapshot();
    assert.equal(invalid.state, "missing");
    assert.equal(invalid.entry("demo-claude").dispatchable, true);
    await held("ops_cloudflare", "invalid-export", anonymousMatrix(), invalid, /no usable quota reading/);

    const parsed = parseDispatchMatrix(anonymousMatrix());
    for (const role of ["executor", "reader", "decision", "batch"] as const) {
      const picked = must(route({ matrix: parsed, role, tier: "L3", snapshot: absent }));
      assert.notEqual(picked.profile.role, "ops_vercel");
    }
    const reviewer = must(route({
      matrix: parsed,
      role: "reviewer",
      review: true,
      tier: "L3",
      executorFamily: "xai", executorModel: "grok-4.7",
      snapshot: absent,
    }));
    assert.equal(reviewer.profile.name, "Demo Reviewer");

    saveConfig(config);
    const task = card("executor", "ordinary-role-missing-export");
    let calls = 0;
    const result = await runTick({
      profiles: [...opsProfiles, ...normalProfiles],
      launcher: {
        async create() {
          calls += 1;
          return { id: "ordinary-agent" };
        },
        async send() {},
        async listModels() {
          return { models: [{ id: "grok-4.7", thinkingOptions: [{ id: "high" }] }, { id: "claude-sonnet-5", thinkingOptions: [{ id: "medium" }, { id: "high" }] }] };
        },
      },
      config,
      pools: absent,
      matrix: { state: "ok", matrix: parsed, path: join(dir, "matrix.json") },
    });
    assert.equal(getTask(task.id).status, "running");
    assert.ok(result.started.includes(task.id));
    assert.equal(calls, 1);
  });

  async function heldProfiles(role: string, title: string, profiles: Profile[], pattern: RegExp) {
    const task = card(role, title);
    isolate(task.id);
    const mock = launcher(false);
    const open = openSnapshot({ "demo-claude": { dispatchable: true } });
    const result = await runTick({
      profiles,
      launcher: mock,
      config,
      pools: open,
      matrix: { state: "ok", matrix: parseDispatchMatrix(anonymousMatrix()), path: join(dir, "matrix.json") },
    });
    const fresh = getTask(task.id);
    assert.equal(fresh.status, "ready", fresh.hold_reason ?? "");
    assert.equal(result.started.includes(task.id), false);
    assert.match(fresh.hold_reason ?? "", pattern);
    assert.equal(mock.opened.length, 0);
  }

  it("waits when the named ops profile is paused or is a paused personal candidate", async () => {
    const open = openSnapshot({ "demo-claude": { dispatchable: true } });
    const pausedRoute = route({
      matrix: parseDispatchMatrix(anonymousMatrix()),
      role: "ops_vercel",
      tier: "L3",
      snapshot: open,
      profiles: opsProfiles.map((profile) => profile.role === "ops_vercel" ? { ...profile, paused: true } : profile),
    });
    assert.equal(pausedRoute.ok, false);
    if (!pausedRoute.ok) assert.match(pausedRoute.reason, /profile is paused/);

    await heldProfiles(
      "ops_vercel",
      "paused-profile",
      opsProfiles.filter((profile) => profile.role === "ops_vercel").map((profile) => ({ ...profile, paused: true })),
      /profile is paused/,
    );
    await heldProfiles(
      "ops_github",
      "paused-personal",
      opsProfiles.filter((profile) => profile.role === "ops_github").map((profile) => ({ ...profile, role: "personal", pausedCandidateFor: "ops_github" })),
      /profile is paused/,
    );
  });
});
