// Pool ids are data: the same plans under other ids judge and display the same. Demo data only.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { adapterOf, CODEX_CLI, companyCatalog, CURSOR_API, CURSOR_PROVIDER, GROK_CLI, MANUAL, poolCatalog } from "../../../shared/fleet/quota-adapters";
import { buildCompanies } from "../../../shared/fleet/quota-companies";
import type { UsagePlan, UsageWindow } from "../../../shared/fleet/usage";
import { applyCursorLogoutHold, poolAlerts, poolStatus, type PoolStatus } from "../pools";
import { windowsFor } from "../adapters/windows";

const DAY = 86_400_000;
const NOW = Date.parse("2026-03-04T03:00:00.000Z");
const WEEK_END = new Date(NOW + 3 * DAY).toISOString();
const MONTH_END = new Date(NOW + 10 * DAY).toISOString();

function windowOf(label: string, usedPct: number | null, resetsAt: string | null, source: UsageWindow["source"] = "provider"): UsageWindow {
  return {
    label, usedPct, resetsAt, startsAt: resetsAt ? new Date(Date.parse(resetsAt) - 7 * DAY).toISOString() : null,
    elapsedPct: null, projectedPct: null, runsOutAt: null, verdict: "unknown", apiUsd: 0, fullWindowUsd: null, planUsd: null,
    source, manualAt: source === "manual" ? new Date(NOW - DAY).toISOString() : null,
  };
}

function planOf(id: string, providers: string[], windows: UsageWindow[], extra: Partial<UsagePlan> = {}): UsagePlan {
  return { id, name: `${providers[0]} plan`, priceUsdMonthly: 100, dispatch: true, note: "", providers, windows, api30dUsd: 0, roi30d: null, coverage: "", ...extra };
}

/** One plan per adapter. `ids` names them; the windows and numbers never change. */
function demoPlans(ids: { claude: string; codex: string; grok: string; cursor: string }, cursorAdapter?: string): UsagePlan[] {
  return [
    planOf(ids.claude, ["claude"], [windowOf("Session", 20, WEEK_END), windowOf("Weekly", 30, WEEK_END), windowOf("Weekly · Fable", 5, WEEK_END)]),
    planOf(ids.codex, ["codex"], [windowOf("Weekly", 85, WEEK_END)], { stopPct: 97 }),
    planOf(ids.grok, ["grok"], [windowOf("Weekly", 81, WEEK_END, "manual")]),
    planOf(ids.cursor, [CURSOR_PROVIDER], [windowOf("Monthly", 40, MONTH_END, "screen")], { cycleDay: 1, ...(cursorAdapter ? { adapter: cursorAdapter } : {}) }),
  ];
}

const alpha = { claude: "alpha-claude", codex: "alpha-codex", grok: "alpha-grok", cursor: "alpha-cursor" };
const renamed = { claude: "team-claude", codex: "team-codex", grok: "team-grok", cursor: "team-cursor" };

function renameKeys(pools: Record<string, PoolStatus>, from: typeof alpha, to: typeof alpha): Record<string, unknown> {
  const map = new Map(Object.entries(from).map(([kind, id]) => [id, to[kind as keyof typeof alpha]]));
  return Object.fromEntries(Object.entries(pools).map(([key, row]) => [map.get(key) ?? key, JSON.parse(JSON.stringify(row).replaceAll(`"${from.claude}"`, `"${to.claude}"`))]));
}

describe("poolStatus does not depend on pool ids", () => {
  // Two unrelated sets of ids exercise the same plans without assuming built-in pool names.
  const options = { now: NOW, codexCouponCount: 1, codexCouponExpiresAt: new Date(NOW + 5 * DAY).toISOString() };
  test("two sets of ids judge the same", () => {
    const a = poolStatus(demoPlans(alpha), options);
    const b = poolStatus(demoPlans(renamed), options);
    assert.deepEqual(Object.keys(b), ["team-claude", "claude-fable", "team-grok", "team-cursor", "team-codex"]);
    assert.deepEqual(renameKeys(a, alpha, renamed), JSON.parse(JSON.stringify(b)));
  });
  test("the hand-copy rule follows the adapter: a hand-copied grok week at 81% stops", () => {
    const b = poolStatus(demoPlans(renamed), options);
    assert.equal(b["team-grok"]?.dispatchable, false);
    assert.match(b["team-grok"]?.reason ?? "", /81%.*\/usage show/);
  });
  test("the Fable week's need is capped by its own main pool", () => {
    const b = poolStatus(demoPlans(renamed), options);
    // Fable: (97 − 5) ÷ 3 days ≈ 30.7 a day on its own line; the main week: (75 − 30) ÷ 3 = 15. The cap wins.
    assert.equal(b["claude-fable"]?.needPerDay, b["team-claude"]?.needPerDay);
    assert.equal(b["claude-fable"]?.needCappedBy, "team-claude");
  });
});

describe("cursor-api switched off", () => {
  test("the plan is judged as a hand copy and no logout hold applies", () => {
    const plans = demoPlans(renamed);
    const catalog = poolCatalog(plans, { [CURSOR_API]: false });
    assert.equal(catalog.find((pool) => pool.id === "team-cursor")?.adapter, MANUAL);
    const pools = poolStatus(plans, { now: NOW, catalog });
    assert.equal(pools["team-cursor"]?.dispatchable, true);
    const loggedOut = { login: "out", checkedAt: NOW - 60_000 };
    assert.deepEqual(applyCursorLogoutHold(pools, loggedOut, NOW, []), pools, "no cursor-api pool, nothing to hold");
    const held = applyCursorLogoutHold(pools, loggedOut, NOW, ["team-cursor"]);
    assert.equal(held["team-cursor"]?.dispatchable, false);
  });
  test("the quota page builds a plain card for it, without the Cursor footer", () => {
    const plans = demoPlans(renamed).map((plan) => ({ ...plan, adapter: plan.id === "team-cursor" ? MANUAL : undefined }));
    const pools = poolStatus(plans, { now: NOW });
    const windows = plans.flatMap((plan) => plan.windows.map((w) => ({ planId: plan.id, label: w.label, usedPct: w.usedPct, resetsAt: w.resetsAt, source: w.source === "official" ? "screen" as const : w.source, readAt: null })));
    const cards = buildCompanies({ companies: companyCatalog(plans), windows, pools, profiles: [], cursor: null });
    assert.deepEqual(cards.map((card) => card.id), ["claude", "team-grok", "chatgpt", "team-cursor"]);
    const manual = cards.find((card) => card.id === "team-cursor");
    assert.equal(manual?.adapter, MANUAL);
    assert.equal(manual?.windows.length, 1);
    assert.equal(manual?.windows[0]?.usedPct, 40);
    assert.ok(!cards.some((card) => card.adapter === CURSOR_API));
  });
  test("alerts only look at the pools they are given", () => {
    const file = { generatedAt: new Date(NOW).toISOString(), pools: { "team-cursor": { usedPct: 120 } } };
    assert.equal(poolAlerts(file, NOW, []).length, 0);
    assert.equal(poolAlerts(file, NOW, ["team-cursor"]).length, 1);
  });
});

describe("windows by adapter", () => {
  // The window readers use the clock, so these dates are relative to now.
  const T = Date.now();
  const ctx = {
    windowsBy: new Map([["grok", [{ label: "Session", usedPct: 12, resetsAt: new Date(T + 6 * DAY).toISOString() }]]]),
    balances: new Map(),
    cursorReading: null,
    sumUsd: () => 0,
  };
  test("grok-cli: a week-long Session is shown as Weekly", () => {
    const rows = windowsFor({ id: "g", priceUsdMonthly: 30, usageProvider: "grok", providers: ["grok"] }, GROK_CLI, ctx);
    assert.deepEqual(rows.map((w) => [w.label, w.usedPct, w.source]), [["Weekly", 12, "provider"]]);
  });
  test("manual: the hand copy of this billing cycle, or nothing", () => {
    const at = new Date(T - 60_000).toISOString();
    const rows = windowsFor({ id: "m", priceUsdMonthly: 10, providers: ["x"], cycleDay: new Date(T).getDate(), manual: { usedPct: 33, at } }, MANUAL, ctx);
    assert.deepEqual(rows.map((w) => [w.label, w.usedPct, w.source]), [["Monthly", 33, "manual"]]);
    const none = windowsFor({ id: "m", priceUsdMonthly: 10, providers: ["x"] }, MANUAL, ctx);
    assert.deepEqual(none.map((w) => [w.usedPct, w.resetsAt, w.source]), [[null, null, "none"]]);
  });
  test("cursor-api: a live Auto percent replaces the hand copy", () => {
    const reading = { ok: true, autoPct: 55, resetsAt: new Date(T + 10 * DAY).toISOString(), source: "official" } as unknown as NonNullable<Parameters<typeof windowsFor>[2]["cursorReading"]>;
    const cfg = { id: "c", priceUsdMonthly: 0, providers: [CURSOR_PROVIDER], cycleDay: new Date(T).getDate(), manual: { usedPct: 10, at: new Date(T - 60_000).toISOString() } };
    const live = windowsFor(cfg, CURSOR_API, { ...ctx, cursorReading: reading });
    assert.deepEqual(live.map((w) => [w.usedPct, w.source]), [[55, "official"]]);
    const off = windowsFor(cfg, MANUAL, { ...ctx, cursorReading: reading });
    assert.deepEqual(off.map((w) => [w.usedPct, w.source]), [[10, "manual"]], "manual ignores any Cursor reading");
  });
  test("manual never reads provider windows, even with usageProvider set (its 80% hand-copy line holds)", () => {
    const at = new Date(T - 60_000).toISOString();
    const reported = { ...ctx, windowsBy: new Map([["acme", [{ label: "Weekly", usedPct: 10, resetsAt: new Date(T + 3 * DAY).toISOString() }]]]) };
    const cfg = { id: "m", priceUsdMonthly: 10, usageProvider: "acme", providers: ["acme"], cycleDay: new Date(T).getDate(), manual: { usedPct: 85, at } };
    const rows = windowsFor(cfg, MANUAL, reported);
    assert.deepEqual(rows.map((w) => [w.label, w.usedPct, w.source]), [["Monthly", 85, "manual"]]);
    const plan = planOf("m", ["acme"], rows, { adapter: MANUAL, cycleDay: cfg.cycleDay, pacePause: false });
    const row = poolStatus([plan], { now: T }).m;
    assert.equal(row?.usedPct, 85);
    assert.equal(row?.dispatchable, false);
    assert.equal(row?.prefer, false);
  });
  test("cursor-api switched off reads like manual: the provider's Monthly window is ignored", () => {
    const at = new Date(T - 60_000).toISOString();
    const reported = { ...ctx, windowsBy: new Map([[CURSOR_PROVIDER, [{ label: "Monthly", usedPct: 10, resetsAt: new Date(T + 20 * DAY).toISOString() }]]]) };
    const cfg = { id: "c", adapter: CURSOR_API, priceUsdMonthly: 0, usageProvider: CURSOR_PROVIDER, providers: [CURSOR_PROVIDER], cycleDay: new Date(T).getDate(), manual: { usedPct: 85, at } };
    const off = adapterOf(cfg, { [CURSOR_API]: false });
    assert.equal(off, MANUAL);
    const rows = windowsFor(cfg, off, reported);
    assert.deepEqual(rows.map((w) => [w.usedPct, w.source]), [[85, "manual"]]);
    const plan = planOf("c", [CURSOR_PROVIDER], rows, { adapter: off, cycleDay: cfg.cycleDay, pacePause: false });
    const pools = poolStatus([plan], { now: T, catalog: poolCatalog([plan], { [CURSOR_API]: false }) });
    assert.equal(pools.c?.usedPct, 85);
    assert.equal(pools.c?.dispatchable, false);
    const on = windowsFor(cfg, CURSOR_API, reported);
    assert.deepEqual(on.map((w) => [w.usedPct, w.source]), [[10, "provider"], [85, "manual"]], "switched on: provider window first, as before");
  });
  test("codex-cli and the rest: no usage provider window, no rows from another provider", () => {
    const rows = windowsFor({ id: "x", priceUsdMonthly: null, usageProvider: "codex", providers: ["codex"] }, CODEX_CLI, ctx);
    assert.deepEqual(rows.map((w) => [w.usedPct, w.source]), [[null, "none"]]);
  });
});
