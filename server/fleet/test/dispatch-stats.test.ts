// Synthetic fixtures only. Provider formats: openai/codex protocol.rs (TokenUsage),
// xai-org/grok-build usage_file.rs (SessionUsageFile), and Paseo 0.11 agent-storage.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import { assignUsage, buildDispatchBundle, summarizeEfforts, type DispatchProfile } from "../../../shared/fleet/dispatch";
import { effortCostLine } from "../../../shared/fleet/quota-page";
import { t } from "../../../shared/fleet/i18n";

const fixtureRoot = mkdtempSync(join(tmpdir(), "dispatch-stats-demo-"));
const paseoDir = join(fixtureRoot, "paseo");
const dataDir = join(fixtureRoot, "data");
const fleetDir = join(dataDir, "fleet");
const codexDir = join(fixtureRoot, "codex-demo");
const saved = { ...process.env };
const hourMs = 3_600_000;
const now = Math.floor(Date.now() / hourMs) * hourMs;
const runStart = now - 24 * hourMs;
const at = (ms: number) => new Date(ms).toISOString();
const profiles: DispatchProfile[] = [
  { name: "Demo Claude", provider: "claude", family: "anthropic", pool: "claude-max", model: "claude-demo" },
  { name: "Demo Codex", provider: "codex", family: "openai", pool: "codex-pro", model: "codex-demo" },
  { name: "Demo Grok", provider: "grok", family: "xai", pool: "supergrok", model: "grok-demo" },
];
const base = { version: 1, defaultTier: "L2", downgradeWhenTight: [], roles: { executor: { L2: [] } } };
const put = (path: string, value: unknown) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
};
const jsonl = (path: string, rows: unknown[]) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, rows.map((row) => JSON.stringify(row)).join("\n"));
};
let dispatch: typeof import("../dispatch");

before(async () => {
  Object.assign(process.env, {
    HOME: fixtureRoot, PASEO_HOME: paseoDir, KANBAN_PASEO_CONFIG: join(paseoDir, "config.json"),
    KANBAN_DATA_DIR: dataDir, KANBAN_HOME: join(fixtureRoot, "plugin"),
    CODEX_HOME: codexDir, AFC_LANGUAGE: "en",
  });
  delete process.env.AFC_TRANSCRIPT_HOME;
  put(join(paseoDir, "config.json"), {
    features: { voiceMode: { enabled: false }, dictation: { enabled: false } }, daemon: { agentProfiles: profiles },
  });
  put(join(fixtureRoot, "plugin/shared/fleet/default-dispatch.example.json"), base);
  put(join(fleetDir, "plans.json"), { prices: Object.fromEntries(profiles.map((p) => [p.model, {
    input: 1, output: 1, cacheRead: 1, cacheWrite: 1,
  }])) });
  const dbPath = join(dataDir, "kanban.db");
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE runs (id TEXT, profile_name TEXT, effort TEXT, started_at TEXT, ended_at TEXT, agent_id TEXT)");
  const insert = db.prepare("INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?)");
  for (const profile of profiles) {
    for (let i = 0; i < 4; i++) {
      const agentId = `agent-${profile.provider}-${i}`;
      const sessionId = `${profile.provider}-session-${i}`;
      insert.run(agentId, profile.name, "medium", at(runStart), at(runStart + hourMs), agentId);
      // Both root-level and project-level records are supported by Paseo's storage reader.
      put(join(paseoDir, "agents", ...(i === 1 ? [] : ["demo"]), `${agentId}.json`), {
        id: agentId, title: profile.name,
        ...(i === 2 ? { runtimeInfo: { sessionId } } : { persistence: { sessionId } }),
      });
      if (i === 3) continue; // A run without usage must still count, but must not dilute averages.
      if (profile.provider === "claude") {
        jsonl(join(fixtureRoot, ".claude/projects/demo", `${sessionId}.jsonl`), [{
          type: "assistant", timestamp: at(runStart), message: { id: agentId, model: profile.model,
            usage: { input_tokens: 900, output_tokens: 100 } },
        }]);
      } else if (profile.provider === "codex") {
        const path = join(codexDir, i === 2 ? "archived_sessions" : "sessions/2026/10/01", `rollout-demo-${sessionId}.jsonl`);
        const usage = { input_tokens: 900, cached_input_tokens: 100, output_tokens: 100, reasoning_output_tokens: 20, total_tokens: 1000 };
        jsonl(path, [
          { type: "session_meta", payload: { id: sessionId } },
          { type: "turn_context", payload: { model: profile.model } },
          { type: "event_msg", timestamp: at(runStart), payload: { type: "token_count", info: { total_token_usage: usage, last_token_usage: usage } } },
          { type: "event_msg", timestamp: at(runStart), payload: { type: "token_count", info: { total_token_usage: usage } } },
        ]);
      } else {
        const usage = { inputTokens: 900, cachedReadTokens: 100, outputTokens: 100, reasoningTokens: 20, totalTokens: 1000, modelCalls: 1 };
        const sessionDir = join(fixtureRoot, ".grok/sessions/demo", sessionId);
        if (i < 2) {
          put(join(sessionDir, "usage.json"), { sessionId, updatedAt: at(runStart + hourMs), session: { ...usage, inputTokens: 90_000, outputTokens: 10_000 },
            turns: [{ turnNumber: 1, endedAt: at(runStart + 1000), ...usage, modelUsage: { [profile.model!]: usage } }] });
        }
        // Legacy update files can coexist with usage.json; never add both sources for one session.
        jsonl(join(sessionDir, "updates.jsonl"), [{ timestamp: at(runStart + 1000),
          params: { update: { sessionUpdate: "turn_completed", stop_reason: "end_turn", usage: { modelUsage: { [profile.model!]: usage } } } },
        }]);
      }
    }
  }
  db.close();
  const envelope = { schema: "fleet-quota/v1", producer: "paseo-kanban", producerVersion: "0.0.0-demo", generatedAt: at(now), ttlSeconds: 1800 };
  put(join(dataDir, "exports/kanban.json"), { ...envelope, dataDir, cli: null, features: ["board-summary"] });
  put(join(dataDir, "exports/board-summary.json"), { ...envelope, projects: [], cards: [], dbPath });
  // No reset timestamps: stable quota observations still suffice for a cost estimate.
  put(join(fleetDir, "quota-history.json"), { samples: [
    { at: at(runStart - hourMs), pools: Object.fromEntries(profiles.map((p) => [p.pool, { usedPct: 10, resetsAt: null }])) },
    { at: at(runStart + 2 * hourMs), pools: Object.fromEntries(profiles.map((p) => [p.pool, { usedPct: 18, resetsAt: null }])) },
  ] });
  dispatch = await import("../dispatch");
  await (await import("../scan")).ensureScan(0);
});
after(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
  rmSync(fixtureRoot, { recursive: true, force: true });
});

test("pool run totals use profile.pool and the same window as profile totals, independently of quota samples", () => {
  const rows = [...profiles, { name: "Demo alternate", provider: "claude", family: "anthropic", pool: "codex-pro" }];
  const effortRuns = rows.flatMap((p) => Array.from({ length: 4 }, () => ({ profile: p.name, effort: "medium", tokens: 10, usd: 1 })));
  const { stats } = buildDispatchBundle({ base, profiles: rows, pools: {}, generatedAt: at(now), effortRuns,
    poolDeltas: profiles.map((p) => ({ pool: p.pool!, deltaPct: p.provider === "grok" ? null : 6, runs: p.provider === "grok" ? 0 : 3 })), claude: null });
  assert.deepEqual(stats.byPool.map(({ pool, runs, perRunPct }) => ({ pool, runs, perRunPct })), [
    { pool: "claude-max", runs: 4, perRunPct: 2 }, { pool: "codex-pro", runs: 8, perRunPct: 2 }, { pool: "supergrok", runs: 4, perRunPct: null },
  ]);
});

test("unmatched usage stays missing; unpriced usage keeps tokens but has unknown dollars", () => {
  const runs = ["reported", "missing"].map((id) => ({ id, profile: "Demo Codex", effort: "medium", start: runStart, end: runStart + hourMs, sessionIds: [id] }));
  const assigned = assignUsage(runs, [{ sessionId: "reported", hour: runStart, tokens: 1000, usd: null }]);
  assert.equal(assigned.has("missing"), false);
  assert.deepEqual(assigned.get("reported"), { tokens: 1000, usd: null });
});

test("missing usage and prices do not count toward averages or minimum samples", () => {
  const run = { profile: "Demo Codex", effort: "medium", tokens: 1000, usd: 1 };
  const missing = { ...run, tokens: null, usd: null };
  const [partial] = summarizeEfforts([run, run, run, missing]);
  assert.equal(partial.runs, 4);
  assert.equal(partial.avgTokens, 1000);
  assert.equal(partial.avgUsd, 1);
  assert.equal(partial.usageSamples, 3);
  assert.equal(partial.pricedSamples, 3);
  assert.equal(summarizeEfforts([run, missing, missing])[0].avgTokens, null);
  const [unpriced] = summarizeEfforts([run, run, { ...run, usd: null }]);
  assert.equal(unpriced.avgTokens, 1000);
  assert.equal(unpriced.avgUsd, null);
  const [zero] = summarizeEfforts(Array.from({ length: 3 }, () => ({ ...run, tokens: 0, usd: 0 })));
  assert.equal(zero.avgTokens, 0, "an observed zero is still a sample");
  const [unavailable] = summarizeEfforts([missing, missing, missing]);
  assert.equal(unavailable.avgTokens, null);
  assert.ok(effortCostLine(unavailable, String).includes(t("quota.page.noUsageData")));
  assert.ok(effortCostLine(partial, String).includes(t("quota.page.missingUsage", { runs: 1 })));
});

const published = () => {
  const pools = Object.fromEntries(profiles.map((p) => [p.pool!, { dispatchable: true, resetsAt: null }])) as never;
  return dispatch.publishDispatch(pools, now, [], null, true);
};

test("published pools count every window run and estimate costs from stable quota observations", async () => {
  const stats = await published();
  assert.equal(stats.byProfileEffort.length, 3);
  for (const profile of profiles) {
    const row = stats.byProfileEffort.find((r) => r.profile === profile.name)!;
    const pool = stats.byPool.find((r) => r.pool === profile.pool)!;
    assert.equal(pool.runs, row.runs);
    assert.equal(pool.runs, 4);
    assert.equal(pool.perRunPct, 2);
  }
});

for (const profile of profiles) test(`${profile.provider} usage matches its session with no missing-run dilution or duplicate sources`, async () => {
  const row = (await published()).byProfileEffort.find((r) => r.profile === profile.name)!;
  assert.equal(row.avgTokens, 1000);
  assert.equal(row.avgUsd, 0.001);
  assert.equal(row.usageSamples, 3);
});

test("missing quota history and reset boundaries leave per-run cost unknown without dropping run totals", async () => {
  const samples = [
    { at: at(runStart - hourMs), pools: Object.fromEntries(profiles.map((p) => [p.pool, { usedPct: 10, resetsAt: null }])) },
    { at: at(runStart + 2 * hourMs), pools: Object.fromEntries(profiles.map((p) => [p.pool, { usedPct: 18, resetsAt: null }])) },
  ];
  try {
    for (const history of [[], [samples[0]], [samples[0], {
      at: at(runStart + 1.5 * hourMs), pools: Object.fromEntries(profiles.map((p) => [p.pool, { usedPct: 2, resetsAt: null }])) }, samples[1]],
    [samples[0], { ...samples[1], pools: Object.fromEntries(profiles.map((p) => [p.pool, { usedPct: 18, resetsAt: at(now + 24 * hourMs) }])) }]]) {
      put(join(fleetDir, "quota-history.json"), { samples: history });
      for (const row of (await published()).byPool) {
        assert.equal(row.runs, 4);
        assert.equal(row.perRunPct, null);
      }
    }
  } finally {
    put(join(fleetDir, "quota-history.json"), { samples });
  }
});

test("incomplete Grok bills and undated session totals stay unavailable, even alongside legacy updates", async () => {
  const files = Array.from({ length: 3 }, (_, i) => join(fixtureRoot, ".grok/sessions/demo", `grok-session-${i}`, "usage.json"));
  const previous = files.map((path) => existsSync(path) ? readFileSync(path, "utf8") : null);
  const usage = { inputTokens: 900, outputTokens: 100, modelCalls: 1 };
  const turn = { ...usage, turnNumber: 1, endedAt: at(runStart + 1000), modelUsage: { "grok-demo": usage } };
  try {
    put(files[0], { sessionId: "grok-session-0", session: { usageIsIncomplete: true }, turns: [turn] });
    put(files[1], { sessionId: "grok-session-1", turns: [turn, { ...turn, turnNumber: 2, usageIsIncomplete: true }] });
    put(files[2], { sessionId: "grok-session-2", session: usage });
    await (await import("../scan")).ensureScan(0);
    const row = (await published()).byProfileEffort.find((r) => r.profile === "Demo Grok")!;
    assert.equal(row.runs, 4);
    assert.equal(row.usageSamples, 0);
    assert.equal(row.avgTokens, null);
    assert.equal(row.avgUsd, null);
    assert.ok(effortCostLine(row, String).includes(t("quota.page.noUsageData")));
  } finally {
    files.forEach((path, i) => {
      if (previous[i] === null) rmSync(path); else writeFileSync(path, previous[i]!);
    });
    await (await import("../scan")).ensureScan(0);
  }
});
