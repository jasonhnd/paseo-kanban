// Quota source adapters (shared/quota-adapters.ts): adapter inference, the pool catalog, names and company keys.
// Demo plans only.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
  adapterOf,
  baseAdapterOf,
  CLAUDE_CLI,
  CODEX_CLI,
  companyCatalog,
  companyKeyOf,
  cardOrder,
  CURSOR_API,
  CURSOR_PROVIDER,
  GROK_CLI,
  isLeaderPool,
  leaderPool,
  mainWindowOf,
  MANUAL,
  MUSE_MSP,
  OPENCODE_GO_API,
  paceSiblings,
  poolCatalog,
  poolEntry,
  poolIdsOf,
  poolName,
  poolNames,
  poolOfWindow,
  providerOf,
  resetShiftingCoupons,
  sessionWindowOf,
  subWindowFor,
  unreadPolicy,
} from "../../../shared/fleet/quota-adapters";

import { windowsFor, type WindowContext } from "../adapters/windows";
import { t, language, setLanguage } from "../../../shared/fleet/i18n";
import { buildCompanies } from "../../../shared/fleet/quota-companies";
import type { UsagePlan } from "../../../shared/fleet/usage";
import { poolStatus } from "../pools";
import { ProviderUsageWindowSchema, type ProviderUsageWindow } from "@getpaseo/protocol/messages";
import { windowLabel } from "../../../shared/fleet/quota-plans-view";

const demo = [
  { id: "team-claude", name: "Team Claude", usageProvider: "claude", providers: ["claude"] },
  { id: "team-codex", name: "Team Codex", usageProvider: "codex", providers: ["codex"] },
  { id: "team-grok", name: "Team Grok", usageProvider: "grok", providers: ["grok"] },
  { id: "team-cursor", name: "Team Cursor", providers: [CURSOR_PROVIDER], cycleDay: 3 },
  { id: "dashboard", name: "Dashboard Plan", providers: ["other"], cycleDay: 9 },
];

describe("adapter of a plan", () => {
  test("an explicit adapter wins", () => {
    assert.equal(baseAdapterOf({ id: "x", adapter: GROK_CLI, usageProvider: "claude" }), GROK_CLI);
  });
  test("an unknown adapter value falls back to inference", () => {
    assert.equal(baseAdapterOf({ id: "x", adapter: "nope", usageProvider: "codex" }), CODEX_CLI);
  });
  test("inferred from usageProvider, then providers, else manual", () => {
    assert.deepEqual(demo.map((plan) => baseAdapterOf(plan)), [CLAUDE_CLI, CODEX_CLI, GROK_CLI, CURSOR_API, MANUAL]);
  });
  test("the provider is the adapter id before its transport", () => {
    assert.equal(providerOf("acme-cli"), "acme");
    assert.equal(`${CURSOR_PROVIDER}-api`, CURSOR_API);
  });
  test("malformed providers or usageProvider are skipped, not thrown on", () => {
    const odd = { id: "odd", usageProvider: 7, providers: { claude: true } } as unknown as Parameters<typeof baseAdapterOf>[0];
    assert.equal(baseAdapterOf(odd), MANUAL);
    assert.deepEqual(companyCatalog([odd]).map((row) => [row.key, row.adapter, row.providers]), [["odd", MANUAL, []]]);
    assert.deepEqual(poolCatalog([odd]).map((pool) => pool.id), ["odd"]);
  });
  test("a switched-off optional adapter is read by hand", () => {
    const plan = demo[3];
    assert.equal(adapterOf(plan), CURSOR_API, "no switches: the plan's own adapter");
    assert.equal(adapterOf(plan, { [CURSOR_API]: false }), MANUAL);
    assert.equal(adapterOf(plan, { [CURSOR_API]: true }), CURSOR_API);
    assert.equal(adapterOf(demo[0], { [CURSOR_API]: false }), CLAUDE_CLI, "built-in adapters are never switched off");
  });
});

describe("pool catalog", () => {
  const catalog = poolCatalog(demo);
  test("ordered by adapter rank, sub pools right after their plan", () => {
    assert.deepEqual(catalog.map((pool) => pool.id), ["team-claude", "claude-fable", "team-grok", "team-cursor", "team-codex", "dashboard"]);
  });
  test("plans.json order breaks ties between plans of one adapter", () => {
    const two = poolCatalog([{ id: "b", usageProvider: "grok" }, { id: "a", usageProvider: "grok" }]);
    assert.deepEqual(two.map((pool) => pool.id), ["b", "a"]);
  });
  test("the Claude Fable week is a sub pool of the Claude plan", () => {
    const fable = poolEntry(catalog, "claude-fable");
    assert.equal(fable?.parent, "team-claude");
    assert.equal(fable?.sub, "fable");
    assert.equal(fable?.adapter, CLAUDE_CLI);
  });
  test("periods: the reported window, a week, or a month", () => {
    const period = Object.fromEntries(catalog.map((pool) => [pool.id, pool.period]));
    assert.deepEqual(period, { "team-claude": "window", "claude-fable": "window", "team-grok": "week", "team-cursor": "month", "team-codex": "week", dashboard: "month" });
    assert.equal(poolCatalog([{ id: "m", providers: ["x"] }])[0]?.period, "week", "a manual plan without a billing day");
  });
  test("neverPrefer: adapter default, plan override", () => {
    assert.deepEqual(catalog.filter((pool) => pool.neverPrefer).map((pool) => pool.id), ["team-claude", "claude-fable", "team-codex"]);
    const override = poolCatalog([{ id: "c", usageProvider: "codex", neverPrefer: false }, { id: "g", usageProvider: "grok", neverPrefer: true }]);
    assert.deepEqual(override.map((pool) => [pool.id, pool.neverPrefer]), [["g", true], ["c", false]]);
  });
  test("leader pool, unread rules, adapter lookups", () => {
    assert.equal(leaderPool(catalog)?.id, "team-claude");
    assert.equal(isLeaderPool(poolEntry(catalog, "claude-fable")!), false);
    assert.equal(unreadPolicy(poolEntry(catalog, "team-claude")!), "reset");
    assert.equal(unreadPolicy(poolEntry(catalog, "team-codex")!), "stop");
    assert.equal(unreadPolicy(poolEntry(catalog, "claude-fable")!), null);
    assert.deepEqual(poolIdsOf(catalog, CURSOR_API), ["team-cursor"]);
    assert.deepEqual(poolIdsOf(poolCatalog(demo, { [CURSOR_API]: false }), CURSOR_API), [], "switched off: no cursor-api pool");
  });
  test("siblings: every other main pool, sub pools have none", () => {
    const siblings = paceSiblings(catalog);
    assert.deepEqual(siblings["team-codex"], ["team-claude", "team-grok", "team-cursor", "dashboard"]);
    assert.equal(siblings["claude-fable"], undefined);
  });
  test("names by context, falling back to the id", () => {
    assert.equal(poolName(catalog, "team-claude", "short"), "Claude");
    assert.ok(poolName(catalog, "team-claude", "label").startsWith("Claude "));
    assert.equal(poolName(catalog, "claude-fable", "short"), "Claude Fable");
    assert.equal(poolName(catalog, "team-codex", "label"), "team-codex");
    assert.equal(poolName(catalog, "dashboard", "short"), "dashboard");
    assert.deepEqual(Object.keys(poolNames(catalog, "via")), ["team-claude", "claude-fable", "team-grok", "team-cursor"]);
  });
});

describe("windows", () => {
  const windows = [{ label: "Session" }, { label: "Weekly" }, { label: "Weekly · Fable" }];
  test("main, session and sub windows of Claude", () => {
    assert.equal(mainWindowOf(CLAUDE_CLI, windows)?.label, "Weekly");
    assert.equal(sessionWindowOf(CLAUDE_CLI, windows)?.label, "Session");
    assert.equal(subWindowFor(CLAUDE_CLI, "fable", windows)?.label, "Weekly · Fable");
    assert.equal(mainWindowOf(CLAUDE_CLI, [{ label: "Session" }]), undefined, "Claude has no first-window fallback");
  });
  test("other adapters fall back to the first window", () => {
    assert.equal(mainWindowOf(CURSOR_API, [{ label: "Monthly" }])?.label, "Monthly");
    assert.equal(sessionWindowOf(GROK_CLI, windows), undefined);
  });
  test("the pool a window feeds", () => {
    assert.equal(poolOfWindow(demo[0], CLAUDE_CLI, "Weekly · Fable"), "claude-fable");
    assert.equal(poolOfWindow(demo[0], CLAUDE_CLI, "Weekly"), "team-claude");
    assert.equal(poolOfWindow(demo[2], GROK_CLI, "Fable week"), "team-grok", "only Claude has model windows");
  });
});

describe("companies", () => {
  test("vendor account for Claude and ChatGPT, else the plan id", () => {
    assert.deepEqual(demo.map((plan) => companyKeyOf(plan)), ["claude", "chatgpt", "team-grok", "team-cursor", "dashboard"]);
  });
  test("catalog in plans.json order, cards in the quota page order", () => {
    const companies = companyCatalog(demo);
    assert.deepEqual(companies.map((row) => row.key), ["claude", "chatgpt", "team-grok", "team-cursor", "dashboard"]);
    assert.deepEqual(cardOrder(companies).map((row) => row.key), ["claude", "team-cursor", "team-grok", "chatgpt", "dashboard"]);
    assert.deepEqual(companies[0]?.subPools, { fable: "claude-fable" });
    assert.equal(companies[4]?.cardName, "Dashboard Plan", "manual plans use the plan name");
  });
  test("a switched-off cursor-api plan becomes a manual company", () => {
    const off = companyCatalog(demo, { [CURSOR_API]: false });
    assert.equal(off[3]?.adapter, MANUAL);
    assert.equal(off[3]?.key, "team-cursor", "the key does not change with the switch");
  });
  test("coupons that move the reset: the Codex plan", () => {
    assert.deepEqual(resetShiftingCoupons(demo), { "team-codex": "chatgpt" });
  });
});

// Serialized demo listUsage payload: no network or login files are used.
const listUsageFixture = JSON.parse(`{
  "providers": [
    { "providerId": "muse", "windows": [
      { "id": "7200s", "label": "2-hour", "usedPct": 99, "resetsAt": "2026-04-08T12:00:00.000Z" },
      { "id": "weekly", "label": "Weekly", "remainingPct": 75, "resetsAt": "2026-04-12T12:00:00.000Z" }
    ] },
    { "providerId": "opencode-go", "windows": [
      { "id": "rolling", "label": "Rolling", "usedPct": 99, "resetsAt": "2026-04-08T12:00:00.000Z" },
      { "id": "weekly", "label": "Weekly", "usedPct": 30, "resetsAt": "2026-04-12T12:00:00.000Z" },
      { "id": "monthly", "label": "Monthly", "usedPct": 98, "resetsAt": "2026-05-01T12:00:00.000Z" }
    ] }
  ]
}`) as { providers: { providerId: string; windows: ProviderUsageWindow[] }[] };
const fixtureContext: WindowContext = {
  now: Date.parse("2026-04-08T11:30:00.000Z"),
  windowsBy: new Map(listUsageFixture.providers.map((p) => [p.providerId, p.windows])),
  balances: new Map(), cursorReading: null, sumUsd: () => 0,
};
function demoWindowPlan(provider: string) {
  return { id: `demo-${provider}`, usageProvider: provider, providers: [provider], priceUsdMonthly: null };
}

describe("Paseo provider quota fixtures", () => {
  test("provider inference keeps the full hyphenated OpenCode Go id", () => {
    const provider: "opencode-go" = providerOf(OPENCODE_GO_API);
    assert.equal(provider, "opencode-go");
    assert.equal(baseAdapterOf(demoWindowPlan("muse")), MUSE_MSP);
    assert.equal(baseAdapterOf(demoWindowPlan(provider)), OPENCODE_GO_API);
    assert.equal(baseAdapterOf(demoWindowPlan("opencode")), MANUAL);
    assert.deepEqual(poolCatalog([demoWindowPlan("muse"), demoWindowPlan(provider)]).map((p) => p.period), ["week", "week"]);
  });
  test("Muse preserves session duration and selects its seven-day week", () => {
    const rows = windowsFor(demoWindowPlan("muse"), MUSE_MSP, fixtureContext);
    assert.deepEqual(rows.map((w) => [w.label, w.usedPct, w.source]), [["2-hour", 99, "provider"], ["Weekly", 25, "provider"]]);
    assert.equal(Date.parse(rows[0].resetsAt!) - Date.parse(rows[0].startsAt!), 120 * 60_000);
    assert.equal(Date.parse(rows[1].resetsAt!) - Date.parse(rows[1].startsAt!), 7 * 86_400_000);
    assert.equal(mainWindowOf(MUSE_MSP, rows)?.usedPct, 25);
    assert.equal(sessionWindowOf(MUSE_MSP, rows)?.usedPct, 99);
    assert.equal(mainWindowOf(MUSE_MSP, rows.slice(0, 1)), undefined);
  });
  test("Muse without a source is hidden and can be changed to manual", () => {
    const cfg = demoWindowPlan("muse");
    const rows = windowsFor(cfg, MUSE_MSP, { ...fixtureContext, windowsBy: new Map() });
    assert.deepEqual(rows.map((w) => [w.label, w.usedPct, w.source]), [[t("screen.window.quotaHidden"), null, "none"]]);
    assert.equal(adapterOf({ ...cfg, adapter: MANUAL }), MANUAL);
    assert.equal(windowsFor(cfg, MANUAL, fixtureContext)[0].source, "none", "manual ignores provider readings");
  });
  test("OpenCode Go retains all three windows but selects only weekly for dispatch", () => {
    const rows = windowsFor(demoWindowPlan("opencode-go"), OPENCODE_GO_API, fixtureContext);
    assert.deepEqual(rows.map((w) => [w.label, w.usedPct, w.source]), [["Rolling", 99, "provider"], ["Weekly", 30, "provider"], ["Monthly", 98, "provider"]]);
    assert.equal(rows[0].startsAt, null);
    assert.equal(rows[0].elapsedPct, null);
    assert.equal(rows[0].projectedPct, null);
    assert.equal(Date.parse(rows[1].resetsAt!) - Date.parse(rows[1].startsAt!), 7 * 86_400_000);
    assert.equal(mainWindowOf(OPENCODE_GO_API, rows)?.usedPct, 30);
    assert.equal(mainWindowOf(OPENCODE_GO_API, rows.filter((w) => w.label !== "Weekly")), undefined);
  });
  test("opencode usageProvider cannot match opencode-go windows", () => {
    const rows = windowsFor(demoWindowPlan("opencode"), OPENCODE_GO_API, fixtureContext);
    assert.deepEqual(rows.map((w) => [w.label, w.usedPct, w.source]), [[t("screen.window.quotaHidden"), null, "none"]]);
  });
});


test("provider week pools and company cards use weekly quota instead of saturated display windows", () => {
  const plans: UsagePlan[] = ["muse", "opencode-go"].map((provider) => {
    const cfg = demoWindowPlan(provider);
    return {
      ...cfg, adapter: adapterOf(cfg), name: provider, dispatch: true, pacePause: false,
      note: "", api30dUsd: 0, roi30d: null, coverage: "",
      windows: windowsFor(cfg, adapterOf(cfg), fixtureContext),
    };
  });
  const pools = poolStatus(plans, { now: Date.parse("2026-04-08T12:00:00.000Z"), catalog: poolCatalog(plans) });
  assert.deepEqual(plans.map((p) => [pools[p.id].usedPct, pools[p.id].dispatchable]), [[25, true], [30, true]]);
  const cards = buildCompanies({
    companies: companyCatalog(plans), pools, profiles: [], cursor: null,
    windows: plans.flatMap((p) => p.windows.map((w) => ({
      planId: p.id, label: w.label, usedPct: w.usedPct, resetsAt: w.resetsAt, source: w.source === "official" ? "screen" as const : w.source, readAt: null,
    }))),
  });
  assert.deepEqual(cards.map((c) => [c.adapter, c.windows.length, c.windows[0].usedPct]), [[MUSE_MSP, 1, 25], [OPENCODE_GO_API, 1, 30]]);
});


test("demo listUsage windows conform to the installed Paseo protocol without stripped fields", () => {
  for (const provider of listUsageFixture.providers) {
    for (const window of provider.windows) assert.deepEqual(ProviderUsageWindowSchema.parse(window), window);
  }
});

test("Muse decodes reported duration labels and ids without using reset distance", () => {
  const samples = [
    { id: "five_hour", label: "5-hour", minutes: 300 },
    { id: "7200s", label: "Current window", minutes: 120 },
    { id: "window", label: "30-minute", minutes: 30 },
    { id: "window", label: "2-day", minutes: 2880 },
  ];
  for (const sample of samples) {
    const rows = windowsFor(demoWindowPlan("muse"), MUSE_MSP, {
      ...fixtureContext, windowsBy: new Map([["muse", [{ id: sample.id, label: sample.label, usedPct: 20, resetsAt: "2026-04-08T12:00:00.000Z" }]]]),
    });
    assert.equal(Date.parse(rows[0].resetsAt!) - Date.parse(rows[0].startsAt!), sample.minutes * 60_000);
    assert.equal(sessionWindowOf(MUSE_MSP, rows)?.usedPct, 20);
    assert.equal(mainWindowOf(MUSE_MSP, rows), undefined);
  }
  const unknown = windowsFor(demoWindowPlan("muse"), MUSE_MSP, {
    ...fixtureContext, windowsBy: new Map([["muse", [{ id: "window", label: "Current window", usedPct: 20 }]]]),
  });
  assert.equal(unknown[0].startsAt, null);
  assert.equal(unknown[0].elapsedPct, null);
});


test("first-run example is empty; manual sources ignore placeholder provider zeros", () => {
  const file = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "..", "examples", "plans.example.json"), "utf8"));
  assert.deepEqual(file, { schemaVersion: 2, plans: [], dispatchPriority: null });
  const copilot = { id: "copilot", providers: ["copilot"] };
  const at = new Date().toISOString();
  const cfg = {
    id: copilot.id,
    priceUsdMonthly: null,
    usageProvider: "copilot",
    providers: copilot.providers,
    cycleDay: 1,
    manual: { usedPct: 42, at },
  };
  // Copilot's usage source reports no percent. A placeholder window may still arrive as 0% used.
  const emptyWindow = { id: "premium", label: "Premium requests", usedPct: null, remainingPct: null };
  const zeroWindow = { id: "premium", label: "Premium requests", usedPct: 0, remainingPct: 100 };
  assert.deepEqual(ProviderUsageWindowSchema.parse(emptyWindow), emptyWindow);
  assert.deepEqual(ProviderUsageWindowSchema.parse(zeroWindow), zeroWindow);
  const reported: WindowContext = {
    windowsBy: new Map([["copilot", [zeroWindow]]]),
    balances: new Map(),
    cursorReading: null,
    sumUsd: () => 0,
  };
  const rows = windowsFor(cfg, MANUAL, reported);
  assert.deepEqual(rows.map((w) => [w.label, w.usedPct, w.source]), [["Monthly", 42, "manual"]]);
  assert.notEqual(rows[0]?.usedPct, 0);

  const unread = windowsFor({ ...cfg, manual: null }, MANUAL, { ...reported, windowsBy: new Map([["copilot", [emptyWindow]]]) });
  assert.equal(unread[0]?.usedPct, null);
  assert.equal(unread[0]?.source, "none");

  const plan: UsagePlan = {
    ...cfg,
    name: "GitHub Copilot",
    adapter: MANUAL,
    dispatch: true,
    pacePause: false,
    note: "",
    api30dUsd: 0,
    roi30d: null,
    coverage: "",
    windows: rows,
  };
  const now = Date.parse(at);
  const pools = poolStatus([plan], { now, catalog: poolCatalog([plan]) });
  assert.equal(pools.copilot?.usedPct, 42);
  assert.notEqual(pools.copilot?.usedPct, 0);
  const cards = buildCompanies({
    companies: companyCatalog([plan]),
    pools,
    profiles: [],
    cursor: null,
    windows: plan.windows.map((w) => ({
      planId: plan.id,
      label: w.label,
      usedPct: w.usedPct,
      resetsAt: w.resetsAt,
      source: w.source === "official" ? "screen" as const : w.source,
      readAt: w.manualAt,
    })),
  });
  assert.equal(cards[0]?.windows[0]?.usedPct, 42);
  assert.notEqual(cards[0]?.windows[0]?.usedPct, 0);
});

test("provider window labels use both language catalogs", () => {
  const previous = language();
  const labels = ["Rolling", "Current window", "5-hour", "2-hour", "30-minute", "2-day"];
  try {
    setLanguage("en");
    assert.deepEqual(labels.map(windowLabel), labels);
    setLanguage("zh-CN");
    const translated = labels.map(windowLabel);
    assert.ok(translated.every((text, index) => text !== labels[index]));
    assert.ok(translated[2].includes("5"));
    assert.ok(translated[3].includes("2"));
    assert.ok(translated[4].includes("30"));
    assert.equal(windowLabel("Provider custom label"), "Provider custom label");
  } finally {
    setLanguage(previous);
  }
});
