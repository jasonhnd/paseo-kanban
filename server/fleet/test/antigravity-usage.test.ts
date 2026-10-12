// Antigravity CLI display versus the Paseo ACP pool. Synthetic tables only.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, describe, test } from "node:test";
import { t } from "../../../shared/fleet/i18n";
import { buildCompanies } from "../../../shared/fleet/quota-companies";
import {
  ANTIGRAVITY_ACP_WINDOW,
  ANTIGRAVITY_CLI,
  ANTIGRAVITY_FIVE_HOUR_WINDOW,
  ANTIGRAVITY_WEEK_WINDOW,
  CURSOR_API,
  type AdapterSwitches,
  adapterOf,
  baseAdapterOf,
  companyCatalog,
  poolCatalog,
} from "../../../shared/fleet/quota-adapters";
import type { UsagePlan, UsageWindow } from "../../../shared/fleet/usage";
import { windowsFor, type WindowContext, type WindowPlan } from "../adapters/windows";
import { poolStatus } from "../pools-status";
import { companyWindows } from "../usage-view";
import { LIVE_READING_TTL_MS, QUOTA_DISPLAY_TTL_MS, QUOTA_SAMPLE_MS } from "../quota-timing";
import {
  AGY_USAGE_COMMAND,
  antigravityDisplayWindows,
  antigravityPlanWindows,
  antigravityUsageRequested,
  parseAntigravityUsage,
  readAntigravityUsage,
  readingFromRun,
  samePoolProven,
  type AntigravityReading,
  type AntigravitySample,
  type ChannelObservation,
  type UsageRunner,
} from "../quota/antigravity-usage";

const NOW = Date.parse("2028-06-01T00:00:00Z");
const WEEK = "2028-06-08T00:00:00Z";
const FIVE = "2028-06-01T05:00:00Z";
const TABLE = [
  `Gemini Models\tWeekly Limit Remaining\t80%\t${WEEK}`,
  `Gemini Models\tFive Hour Limit Remaining\t100%\t${FIVE}`,
  "Claude and GPT models\tWeekly Limit Remaining\t40%\t2028-06-08T01:00:00Z",
  "Claude and GPT models\tFive Hour Limit Remaining\t25%\t2028-06-01T06:00:00Z",
].join("\n");
const PLENTIFUL = [
  `Gemini Models\tWeekly Limit Remaining\t100%\t${WEEK}`,
  `Gemini Models\tFive Hour Limit Remaining\t100%\t${FIVE}`,
  `Claude and GPT models\tWeekly Limit Remaining\t97%\t${WEEK}`,
  `Claude and GPT models\tFive Hour Limit Remaining\t50%\t${FIVE}`,
].join("\n");

const scratch = await mkdtemp(join(tmpdir(), "agy-sampling-"));
const statePath = join(scratch, "schedule.json");
afterEach(() => rm(statePath, { force: true }));
after(() => rm(scratch, { recursive: true, force: true }));

function runOf(stdout: string, extra: Partial<{ stderr: string; code: number | null; timedOut: boolean; missing: boolean }> = {}) {
  return { stdout, stderr: extra.stderr ?? "", code: extra.code === undefined ? 0 : extra.code, timedOut: extra.timedOut === true, missing: extra.missing === true };
}

function observation(channel: ChannelObservation["channel"], version: string | null, tier: string | null, quotaSource: string | null, observedAt: string | null = "2028-06-01T00:00:00Z"): ChannelObservation {
  return { channel, version, tier, quotaSource, observedAt };
}

function reading(stdout: string): AntigravityReading {
  return readingFromRun(runOf(stdout), NOW);
}

function sample(bucket: AntigravitySample["bucket"], window: AntigravitySample["window"], usedPct: number): AntigravitySample {
  return { bucket, window, remainingPct: 100 - usedPct, usedPct, resetsAt: window === "week" ? WEEK : FIVE };
}

function proven(samples: AntigravitySample[], readAt = NOW): AntigravityReading {
  const at = new Date(readAt).toISOString();
  return {
    readAt: at,
    error: null,
    stale: false,
    samples,
    cli: observation("agy-cli", "9.9.9", "synthetic-tier", "shared-pool-key", at),
    acp: observation("paseo-acp", "9.9.9", "synthetic-tier", "shared-pool-key", at),
  };
}

const context = (antigravityReading: AntigravityReading | null): WindowContext => ({
  windowsBy: new Map(),
  balances: new Map(),
  cursorReading: null,
  antigravityReading,
  sumUsd: () => 0,
  now: NOW,
});

function plan(bucket: "gemini" | "claude-gpt" | undefined, id = "gemini-pool"): WindowPlan {
  return {
    id,
    providers: ["antigravity"],
    priceUsdMonthly: null,
    quotaCycle: { kind: "unknown" },
    manualOverride: { usedPct: 0, at: new Date(NOW).toISOString(), source: "hand", ttlSeconds: 86400 },
    ...(bucket ? { antigravityBucket: bucket } : {}),
  };
}

function usage(windows: UsageWindow[], changes: Partial<UsagePlan> = {}): UsagePlan {
  return {
    id: "gemini-pool",
    name: "Gemini",
    adapter: ANTIGRAVITY_CLI,
    providers: ["antigravity"],
    priceUsdMonthly: null,
    dispatch: true,
    quotaProtection: "pause",
    note: "",
    coverage: "",
    windows,
    api30dUsd: 0,
    roi30d: null,
    ...changes,
  };
}

function claudeWindow(usedPct: number): UsageWindow {
  return {
    label: "Weekly", id: "seven_day", usedPct, resetsAt: WEEK, startsAt: "2028-06-01T00:00:00Z",
    elapsedPct: 10, projectedPct: 10, runsOutAt: null, verdict: "on-track", apiUsd: 0, fullWindowUsd: null, planUsd: null,
    source: "provider", manualAt: null, cycleKind: "week",
  };
}

describe("parseAntigravityUsage", () => {
  test("keeps both buckets and converts remaining percent to used percent", () => {
    const rows = parseAntigravityUsage(TABLE);
    assert.deepEqual(rows.map((row) => [row.bucket, row.window, row.usedPct, row.resetsAt]), [
      ["gemini", "week", 20, "2028-06-08T00:00:00.000Z"],
      ["gemini", "five-hour", 0, "2028-06-01T05:00:00.000Z"],
      ["claude-gpt", "week", 60, "2028-06-08T01:00:00.000Z"],
      ["claude-gpt", "five-hour", 75, "2028-06-01T06:00:00.000Z"],
    ]);
    assert.equal("startsAt" in rows[0], false);
  });

  test("accepts two or more spaces between columns", () => {
    const rows = parseAntigravityUsage("Gemini Models  Weekly Limit Remaining  50%  2028-06-08T00:00:00Z");
    assert.deepEqual(rows.map((row) => [row.bucket, row.window, row.usedPct]), [["gemini", "week", 50]]);
  });

  test("drops bad percents, unknown rows and unparseable resets", () => {
    const text = [
      TABLE,
      "Gemini Models\tWeekly Limit Remaining\t150%\t2028-06-08T00:00:00Z",
      "Gemini Models\tWeekly Limit Remaining\tnope\t2028-06-08T00:00:00Z",
      "Gemini Models\tWeekly Limit Remaining\t100\t2028-06-08T00:00:00Z",
      "Gemini Models\tWeekly Limit Remaining\t-1%\t2028-06-08T00:00:00Z",
      "Gemini Models\tWeekly Limit Remaining\t97 percent\t2028-06-08T00:00:00Z",
      "Other Models\tWeekly Limit Remaining\t10%\t2028-06-08T00:00:00Z",
      "Gemini Models\tSession Limit Remaining\t10%\t2028-06-08T00:00:00Z",
      "Gemini Models\tWeekly Limit Remaining\t10%\ttomorrow",
      "Gemini Models\tFive Hour Limit Remaining\t10%",
    ].join("\n");
    const rows = parseAntigravityUsage(text);
    assert.equal(rows.length, 5);
    assert.equal(rows.filter((row) => row.bucket === "gemini" && row.window === "five-hour" && row.resetsAt === null).length, 1);
    assert.ok(rows.every((row) => row.usedPct !== 0 || row.remainingPct === 100));
  });

  test("does not keep an address that arrived in the command text", () => {
    const parsed = readingFromRun(runOf(`someone@example.com\n${TABLE}`, { stderr: "other@example.com" }), NOW);
    assert.equal(JSON.stringify(parsed).includes("@"), false);
    assert.equal(parsed.samples.length, 4);
    assert.equal(parsed.cli?.tier, null);
    assert.equal(parsed.acp, null);
  });
});

describe("command result", () => {
  test("the quota command is only agy -p /usage", () => {
    assert.deepEqual(AGY_USAGE_COMMAND, { bin: "agy", args: ["-p", "/usage"] });
  });

  test("a missing binary, a timeout and bad output do not become zero", () => {
    assert.equal(readingFromRun(runOf(TABLE, { missing: true }), NOW).error, "missing-cli");
    assert.deepEqual(readingFromRun(runOf(TABLE, { timedOut: true }), NOW).samples, []);
    assert.equal(readingFromRun(runOf(TABLE, { timedOut: true }), NOW).error, "timeout");
    assert.equal(readingFromRun(runOf(""), NOW).error, "bad-output");
    assert.equal(readingFromRun(runOf("Pool\tWindow\tRemaining\tReset"), NOW).error, "bad-output");
    assert.equal(readingFromRun(runOf("Please sign in to continue", { code: 1 }), NOW).error, "not-logged-in");
    assert.equal(readingFromRun(runOf("", { code: 2 }), NOW).error, "failed");
    assert.equal(readingFromRun(runOf(TABLE, { code: 2 }), NOW).error, "failed");
    for (const item of [readingFromRun(runOf(TABLE, { missing: true }), NOW), readingFromRun(runOf(""), NOW)]) {
      assert.equal(item.samples.length, 0);
      assert.ok(item.samples.every((row) => row.usedPct !== 0));
    }
  });

  test("only code zero accepts valid stdout; failure, signal and timeout discard even complete or partial tables", () => {
    const ok = readingFromRun(runOf(TABLE), NOW);
    assert.equal(ok.error, null);
    assert.equal(ok.samples.length, 4);
    for (const stdout of [TABLE, TABLE.split("\n")[0], ""]) {
      for (const outcome of [{ code: 2 }, { code: null }, { code: 0, timedOut: true }]) {
        const result = readingFromRun(runOf(stdout, outcome), NOW);
        assert.notEqual(result.error, null);
        assert.deepEqual(result.samples, []);
        assert.equal(result.acp, null);
      }
    }
    const partial = readingFromRun(runOf(TABLE.split("\n")[0]), NOW);
    assert.equal(partial.error, null);
    assert.equal(partial.samples.length, 1);
  });

  test("parallel calls share one run, a fixed slot skips even force and a clock rollback", async () => {
    let calls = 0;
    const runner: UsageRunner = async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return runOf(TABLE);
    };
    const [first, second] = await Promise.all([
      readAntigravityUsage({ statePath, now: NOW, runner }),
      readAntigravityUsage({ statePath, now: NOW, runner }),
    ]);
    assert.equal(calls, 1);
    assert.equal(first, second);
    assert.equal((await readAntigravityUsage({ statePath, now: NOW + 1000, runner })).samples.length, 4);
    assert.equal(calls, 1);
    await readAntigravityUsage({ statePath, now: NOW + QUOTA_SAMPLE_MS, runner });
    assert.equal(calls, 2);
    await readAntigravityUsage({ statePath, now: NOW + 1000, runner, force: true });
    assert.equal(calls, 2);
  });

  test("a runner that throws becomes a failed reading and does not escape", async () => {
    const parsed = await readAntigravityUsage({ statePath, now: NOW, force: true, runner: async () => { throw new Error("boom"); } });
    assert.equal(parsed.error, "failed");
    assert.equal(parsed.acp, null);
  });
});

describe("same pool", () => {
  test("requires both channels to agree, and rejects a product name", () => {
    const cli = observation("agy-cli", "9.9.9", "synthetic-tier", "shared-pool-key");
    const acp = observation("paseo-acp", "9.9.9", "synthetic-tier", "shared-pool-key");
    assert.equal(samePoolProven(cli, acp), true);
    assert.equal(samePoolProven(cli, null), false);
    assert.equal(samePoolProven(observation("agy-cli", "1.3.3", "Google AI Pro", "shared-pool-key"), observation("paseo-acp", "1.3.0", "Google AI Pro", "shared-pool-key")), false);
    assert.equal(samePoolProven(observation("agy-cli", "1.3.0", "Google AI Pro", "shared-pool-key"), observation("paseo-acp", "1.3.0", "free-tier", "shared-pool-key")), false);
    assert.equal(samePoolProven(observation("agy-cli", "9.9.9", null, "shared-pool-key"), acp), false);
    assert.equal(samePoolProven(observation("agy-cli", "9.9.9", "synthetic-tier", "antigravity"), observation("paseo-acp", "9.9.9", "synthetic-tier", "antigravity")), false);
    assert.equal(samePoolProven({ ...cli, observedAt: null }, acp), false);
  });

  test("a production-shaped reading is not the ACP pool, even when the CLI table is full", () => {
    const parsed = reading(PLENTIFUL);
    assert.equal(samePoolProven(parsed.cli, parsed.acp), false);
    assert.equal(parsed.cli?.version, null);
    assert.equal(parsed.cli?.tier, null);
    assert.equal(parsed.cli?.quotaSource, null);
    const windows = windowsFor(plan("gemini"), ANTIGRAVITY_CLI, context(parsed));
    const acp = windows.find((row) => row.id === ANTIGRAVITY_ACP_WINDOW);
    assert.equal(acp?.usedPct, null);
    assert.equal(acp?.readingState, "unknown");
    assert.equal(acp?.startsAt, null);
    assert.equal(windows.find((row) => row.id === ANTIGRAVITY_WEEK_WINDOW)?.usedPct, 0);
    const status = poolStatus([usage(windows)], { now: NOW })["gemini-pool"];
    assert.equal(status.dispatchable, false);
    assert.equal(status.reason, t("quota.setup.unknownHold"));
  });

  test("a matching observation can drive the weekly percent, without inventing a five-hour start", () => {
    const windows = antigravityPlanWindows(
      { id: "gemini-pool", antigravityBucket: "gemini" },
      proven([sample("gemini", "week", 10), sample("gemini", "five-hour", 100)]),
      NOW,
    );
    const acp = windows.find((row) => row.id === ANTIGRAVITY_ACP_WINDOW);
    const five = windows.find((row) => row.id === ANTIGRAVITY_FIVE_HOUR_WINDOW);
    assert.equal(acp?.usedPct, 10);
    assert.equal(acp?.source, "provider");
    assert.equal(acp?.readingState, "live");
    assert.equal(acp?.startsAt, null);
    assert.equal(acp?.paceEligible, false);
    assert.equal(five?.usedPct, 100);
    assert.equal(five?.source, "screen");
    assert.equal(five?.readingState, "live");
    assert.equal(five?.sampledAt, new Date(NOW).toISOString());
    assert.equal(five?.startsAt, null);
    assert.equal(poolStatus([usage(windows)], { now: NOW })["gemini-pool"].dispatchable, true);
  });

  test("an old matched reading is stale, and an old unmatched reading stays unknown", () => {
    const old = NOW - LIVE_READING_TTL_MS - 1000;
    const stale = antigravityPlanWindows({ id: "gemini-pool", antigravityBucket: "gemini" }, proven([sample("gemini", "week", 10)], old), NOW);
    assert.equal(stale[0]?.readingState, "stale");
    assert.equal(stale[0]?.usedPct, null);
    const agedWeek = stale.find((row) => row.id === ANTIGRAVITY_WEEK_WINDOW);
    assert.equal(agedWeek?.usedPct, 10);
    assert.equal(agedWeek?.readingState, "stale");
    assert.equal(agedWeek?.sampledAt, new Date(old).toISOString());
    assert.equal(agedWeek?.staleUsedPct, 10);
    assert.equal(poolStatus([usage(stale)], { now: NOW })["gemini-pool"].reason, t("quota.setup.staleHold"));
    const aged = reading(PLENTIFUL);
    aged.readAt = new Date(old).toISOString();
    aged.stale = false;
    const unknown = windowsFor(plan("gemini"), ANTIGRAVITY_CLI, context(aged));
    assert.equal(unknown[0]?.readingState, "unknown");
    assert.equal(unknown[0]?.usedPct, null);
  });

  test("a hand-copied zero does not clear the ACP hold", () => {
    const windows = windowsFor(plan("gemini"), ANTIGRAVITY_CLI, context(reading(PLENTIFUL)));
    assert.equal(windows[0]?.usedPct, null);
    assert.notEqual(windows[0]?.source, "manual");
    assert.equal(poolStatus([usage(windows)], { now: NOW })["gemini-pool"].dispatchable, false);
  });

  test("a closed or missing reader keeps the unknown ACP hold and does not launch agy", async () => {
    const source = { id: "gemini-pool", adapter: ANTIGRAVITY_CLI, usageProvider: "antigravity", providers: ["antigravity"] };
    const hand = { usedPct: 0, at: new Date(NOW).toISOString(), source: "manual", ttlSeconds: 86400 };
    const cfg: WindowPlan = {
      id: source.id,
      providers: ["antigravity"],
      priceUsdMonthly: null,
      quotaCycle: { kind: "unknown" },
      manualOverride: hand,
      antigravityBucket: "gemini",
    };
    let launches = 0;
    const runner: UsageRunner = async () => {
      launches += 1;
      return runOf(PLENTIFUL);
    };
    const readIfRequested = async (switches: Partial<AdapterSwitches>) => {
      if (antigravityUsageRequested([source], switches)) await readAntigravityUsage({ statePath, now: NOW, force: true, runner });
    };
    for (const switches of [{ [ANTIGRAVITY_CLI]: false }, {}]) {
      await readIfRequested(switches);
      const adapter = adapterOf(source, switches);
      assert.equal(adapter, ANTIGRAVITY_CLI);
      const windows = windowsFor(cfg, adapter, context(null));
      const acp = windows[0];
      assert.equal(acp?.id, ANTIGRAVITY_ACP_WINDOW);
      assert.equal(acp?.source, "none");
      assert.equal(acp?.usedPct, null);
      assert.equal(acp?.readingState, "unknown");
      assert.equal(windows.some((row) => row.source === "manual"), false);
      assert.equal(windows.some((row) => row.id === ANTIGRAVITY_WEEK_WINDOW), false);
      const status = poolStatus([usage(windows, { adapter, dispatch: true, quotaProtection: "pause" })], { now: NOW })["gemini-pool"];
      assert.equal(status.usedPct, null);
      assert.equal(status.dispatchable, false);
      assert.equal(status.reason, t("quota.setup.unknownHold"));
    }
    assert.equal(launches, 0);
    assert.equal(antigravityUsageRequested([source], { [ANTIGRAVITY_CLI]: true }), true);
    assert.equal(adapterOf({ id: "cursor-pool", adapter: CURSOR_API, providers: ["cursor"] }, { [CURSOR_API]: false }), "manual");
    const manualWindows = windowsFor({ ...cfg, id: "hand-pool" }, "manual", context(null));
    assert.equal(manualWindows[0]?.source, "manual");
    assert.equal(manualWindows[0]?.usedPct, 0);
    const manualStatus = poolStatus([usage(manualWindows, { id: "hand-pool", adapter: "manual", dispatch: true, quotaProtection: "pause" })], { now: NOW })["hand-pool"];
    assert.equal(manualStatus.dispatchable, true);
    assert.equal(manualStatus.usedPct, 0);
  });

  test("an expired display sample stays visible and is not a live ACP percent", () => {
    const old = NOW - QUOTA_DISPLAY_TTL_MS - 1000;
    const aged = readingFromRun(runOf([
      "Gemini Models\tWeekly Limit Remaining\t90%\t2028-06-08T00:00:00Z",
      "Gemini Models\tFive Hour Limit Remaining\t50%\t2028-06-01T05:00:00Z",
    ].join("\n")), old);
    const windows = windowsFor(plan("gemini", "example-antigravity-gemini"), ANTIGRAVITY_CLI, context(aged));
    const week = windows.find((row) => row.id === ANTIGRAVITY_WEEK_WINDOW);
    const five = windows.find((row) => row.id === ANTIGRAVITY_FIVE_HOUR_WINDOW);
    assert.equal(windows[0]?.readingState, "unknown");
    assert.equal(windows[0]?.usedPct, null);
    assert.equal(week?.usedPct, 10);
    assert.equal(week?.readingState, "stale");
    assert.equal(week?.sampledAt, aged.readAt);
    assert.equal(five?.usedPct, 50);
    assert.equal(five?.readingState, "stale");
    assert.equal(five?.sampledAt, aged.readAt);
    const source = { id: "example-antigravity-gemini", name: "Example Antigravity Gemini", adapter: ANTIGRAVITY_CLI, providers: ["antigravity"] };
    const plans = [usage(windows, { id: source.id, name: source.name, antigravityDisplay: antigravityDisplayWindows(aged, NOW) })];
    const shown = companyWindows(plans, new Date(NOW).toISOString());
    assert.equal(shown.find((row) => row.id === `gemini-${ANTIGRAVITY_WEEK_WINDOW}`)?.readAt, aged.readAt);
    assert.notEqual(shown.find((row) => row.id === `gemini-${ANTIGRAVITY_WEEK_WINDOW}`)?.readAt, new Date(NOW).toISOString());
    const card = buildCompanies({
      companies: companyCatalog([source], { [ANTIGRAVITY_CLI]: true }),
      windows: shown,
      pools: poolStatus(plans, { now: NOW }),
      profiles: [],
      cursor: null,
    })[0];
    const local = new Date(Date.parse(aged.readAt) + 9 * 60 * 60 * 1000);
    const pad = (n: number) => String(n).padStart(2, "0");
    const when = `${local.getUTCMonth() + 1}/${local.getUTCDate()} ${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`;
    const cli = card?.windows.find((row) => row.id.endsWith(`gemini-${ANTIGRAVITY_WEEK_WINDOW}`));
    const cliFive = card?.windows.find((row) => row.id.endsWith(`gemini-${ANTIGRAVITY_FIVE_HOUR_WINDOW}`));
    assert.equal(card?.headline, t("quota.antigravity.displayPaused"));
    assert.equal(cli?.readAt, aged.readAt);
    assert.equal(cli?.usedPct, 10);
    assert.equal(cli?.tone, "yellow");
    assert.equal(cli?.sourceText, t("quota.antigravity.cliStale", { when }));
    assert.equal(cliFive?.tone, "yellow");
    assert.equal(cliFive?.readAt, aged.readAt);
    assert.equal(poolStatus(plans, { now: NOW })[source.id].dispatchable, false);
  });

  test("a missing bucket shows only the unknown ACP row", () => {
    const windows = windowsFor(plan(undefined), ANTIGRAVITY_CLI, context(reading(TABLE)));
    assert.deepEqual(windows.map((row) => row.id), [ANTIGRAVITY_ACP_WINDOW]);
    assert.equal(windows[0]?.usedPct, null);
  });

  test("gemini and claude-gpt rows stay apart from each other and from claude-cli", () => {
    const parsed = reading(TABLE);
    const gemini = windowsFor(plan("gemini", "gemini-pool"), ANTIGRAVITY_CLI, context(parsed));
    const gpt = windowsFor(plan("claude-gpt", "gpt-pool"), ANTIGRAVITY_CLI, context(parsed));
    assert.deepEqual(gemini.filter((row) => row.id !== ANTIGRAVITY_ACP_WINDOW).map((row) => row.usedPct), [20, 0]);
    assert.deepEqual(gpt.filter((row) => row.id !== ANTIGRAVITY_ACP_WINDOW).map((row) => row.usedPct), [60, 75]);
    const claude = usage([claudeWindow(10)], {
      id: "claude-main", name: "Claude", adapter: "claude-cli", providers: ["claude"],
      quotaProtection: undefined, quotaCycle: undefined, dispatch: true,
    });
    const plans = [claude, usage(gemini, { id: "gemini-pool" }), usage(gpt, { id: "gpt-pool", name: "Claude and GPT" })];
    const catalog = poolCatalog(plans);
    assert.deepEqual(catalog.filter((row) => row.parent === null).map((row) => row.id), ["claude-main", "gemini-pool", "gpt-pool"]);
    assert.equal(catalog.find((row) => row.id === "claude-fable")?.parent, "claude-main");
    assert.equal(catalog.find((row) => row.id === "gemini-pool")?.parent, null);
    assert.equal(catalog.find((row) => row.id === "gpt-pool")?.parent, null);
    const status = poolStatus(plans, { now: NOW, catalog });
    assert.equal(status["claude-main"].dispatchable, true);
    assert.equal(status["claude-main"].usedPct, 10);
    assert.equal(status["gemini-pool"].dispatchable, false);
    assert.equal(status["gpt-pool"].dispatchable, false);
    const changed = windowsFor(plan("gemini", "gemini-pool"), ANTIGRAVITY_CLI, context(reading(PLENTIFUL)));
    const again = poolStatus([claude, usage(changed, { id: "gemini-pool" }), usage(gpt, { id: "gpt-pool" })], { now: NOW });
    assert.equal(again["claude-main"].usedPct, 10);
    assert.deepEqual(plans[2]?.providers, ["antigravity"]);
    assert.equal(plans[2]?.adapter, ANTIGRAVITY_CLI);
    assert.equal(baseAdapterOf({ id: "direct-gemini", usageProvider: "gemini", providers: ["gemini"] }), "manual");
  });

  test("the company card keeps the ACP figure unknown while showing the CLI source", () => {
    const windows = windowsFor(plan("gemini", "example-antigravity-gemini"), ANTIGRAVITY_CLI, context(reading(PLENTIFUL)));
    const source = { id: "example-antigravity-gemini", name: "Example Antigravity Gemini", adapter: ANTIGRAVITY_CLI, providers: ["antigravity"] };
    const companies = companyCatalog([source], { [ANTIGRAVITY_CLI]: true });
    const pools = poolStatus([usage(windows, { id: source.id, name: source.name })], { now: NOW });
    const card = buildCompanies({
      companies,
      windows: antigravityDisplayWindows(reading(PLENTIFUL), NOW).map((row) => ({
        planId: source.id,
        label: row.label,
        id: row.id,
        cycleKind: row.cycleKind,
        primary: row.primary,
        usedPct: row.usedPct,
        resetsAt: row.resetsAt,
        source: row.source === "provider" || row.source === "none" || row.source === "manual" ? row.source : "screen",
        readAt: new Date(NOW).toISOString(),
        readError: row.readError,
        readingState: row.readingState,
      })),
      pools,
      profiles: [],
      cursor: null,
    })[0];
    assert.equal(card?.headline, t("quota.antigravity.displayPaused"));
    assert.equal(card?.remainingPct, null);
    assert.notEqual(card?.windows[0]?.dispatchText, t("quota.companies.dispatchable"));
    const cli = card?.windows.find((row) => row.id.endsWith(`gemini-${ANTIGRAVITY_WEEK_WINDOW}`));
    assert.equal(cli?.remainingPct, 100);
    assert.ok(cli?.sourceText.startsWith("agy CLI /usage"));
    assert.equal(card?.windows.length, 4);
    assert.equal(card?.name, "Antigravity");
    assert.equal(card?.windows.some(row => row.id.includes(ANTIGRAVITY_ACP_WINDOW)), false);
  });

  test("quota protection none is an explicit bypass", () => {
    const windows = windowsFor(plan("gemini"), ANTIGRAVITY_CLI, context(reading(PLENTIFUL)));
    const status = poolStatus([usage(windows, { quotaProtection: "none" })], { now: NOW })["gemini-pool"];
    assert.equal(status.dispatchable, true);
    assert.equal(status.reason, t("quota.setup.unprotected"));
  });
});
