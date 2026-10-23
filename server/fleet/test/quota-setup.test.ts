import { setLanguage as setHostLanguage } from "../../../shared/i18n";
import { strict as assert } from "node:assert";
import { after, afterEach, before, test } from "node:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { UsagePlan } from "../../../shared/fleet/usage";
import { plansSchema } from "../../../shared/fleet/settings";
import { language, setLanguage, tIn } from "../../../shared/fleet/i18n";
import { showManualEditor } from "../../../shared/fleet/quota-plans-view";
import { buildCompanies } from "../../../shared/fleet/quota-companies";
import { companyCatalog, isMonthlyWindow, isWeeklyWindow, mainWindowOf, sessionWindowOf } from "../../../shared/fleet/quota-adapters";
const dir = join(mkdtempSync(join(tmpdir(), "quota-setup-")), "fleet");
process.env.KANBAN_DATA_DIR = join(dir, "..");
process.env.AFC_TRANSCRIPT_HOME = dir;

process.env.PASEO_HOME = join(dir, "host");
process.env.KANBAN_PASEO_CONFIG = join(process.env.PASEO_HOME!, "config.json");

process.env.KANBAN_HOME = fileURLToPath(new URL("../../../", import.meta.url));
let initializeSettings: typeof import("../settings").initializeSettings;
let readSettings: typeof import("../settings").readSettings;
let writeSettings: typeof import("../settings").writeSettings;
let windowsFor: typeof import("../adapters/windows").windowsFor;
let poolStatus: typeof import("../pools-status").poolStatus;
let writePoolStatus: typeof import("../pools-status").writePoolStatus;
let assemble: typeof import("../usage").assemble;
let buildUsage: typeof import("../usage").buildUsage;
let updatePlan: typeof import("../usage").updatePlan;
let clearCache: typeof import("../util").clearCache;
before(async () => {
  setHostLanguage("en");
  ({ initializeSettings, readSettings, writeSettings } = await import("../settings"));
  ({ windowsFor } = await import("../adapters/windows"));
  ({ poolStatus, writePoolStatus } = await import("../pools-status"));
  ({ assemble, buildUsage, updatePlan } = await import("../usage"));
  ({ clearCache } = await import("../util"));
  initializeSettings(dir, fileURLToPath(new URL("../../../examples/", import.meta.url)));
});
after(async () => { await rm(dir, { recursive: true, force: true }); });
// Each scenario has its own sampler state; clearing an RPC cache must not bypass the hourly slot.
afterEach(() => rm(join(dir, "quota-sampling.json"), { force: true }));
const now = Date.now();
const cycle = { kind: "unknown" as const };
const base = { id: "demo-pool", name: "Demo", adapter: "manual" as const, providers: ["demo-provider"], priceUsdMonthly: null, dispatch: true, quotaCycle: cycle, quotaProtection: "pause" as const, stopPct: 80 };
const copied = { usedPct: 12, at: new Date(now).toISOString(), ttlSeconds: 3600, source: "demo dashboard" };
function usagePlan(windows: UsagePlan["windows"], changes = {}): UsagePlan {
  return { ...base, note: "", coverage: "", windows, api30dUsd: 0, roi30d: null, ...changes };
}
const context = { windowsBy: new Map(), balances: new Map(), cursorReading: null, sumUsd: () => 0, now };
test("legacy over-limit provider readings remain exhausted without a configured cycle", () => {
  const legacy = { ...base, adapter: "codex-cli", usageProvider: "demo-legacy", quotaCycle: undefined, quotaProtection: undefined };
  const windows = windowsFor(legacy, "codex-cli", { ...context, windowsBy: new Map([[legacy.usageProvider, [{ label: "Weekly", usedPct: 101, resetsAt: new Date(now + 86400000).toISOString() }]]]) });
  assert.equal(windows[0].usedPct, 101);
  assert.equal(poolStatus([usagePlan(windows, legacy)], { now })[base.id].dispatchable, false);
});
test("configured calendar titles use both language catalogs", () => {
  const previous = language();
  try {
    for (const locale of ["en", "zh-CN"] as const) {
      setLanguage(locale);
      const cycles = [
        { kind: "day" as const, timeZone: "UTC", hour: 0, minute: 0 },
        { kind: "week" as const, timeZone: "UTC", weekday: 1, hour: 0, minute: 0 },
        { kind: "month" as const, timeZone: "UTC", day: 1, hour: 0, minute: 0 },
      ];
      const labels = cycles.map(quotaCycle => windowsFor({ ...base, quotaCycle }, "manual", context)[0].label);
      assert.deepEqual(labels, ["quota.setup.dayWindow", "quota.setup.weekWindow", "quota.setup.monthWindow"].map(key => tIn(locale, key as Parameters<typeof tIn>[1])));
      if (locale === "zh-CN") assert.ok(labels.every(label => !["Daily", "Weekly", "Monthly"].includes(label)));
    }
  } finally { setLanguage(previous); }
});
test("a genuine zero Cursor reading uses the provider reset in a legacy monthly plan", () => {
  const resetsAt = new Date(now + 86400000).toISOString();
  const reading = { ok: true, autoPct: 0, resetsAt, source: "official" } as never;
  const window = windowsFor({ ...base, quotaCycle: undefined, cycleDay: 1 }, "cursor-api", { ...context, cursorReading: reading })[0];
  assert.equal(window.usedPct, 0);
  assert.equal(window.resetsAt, resetsAt);
});
test("monthly and daily configured cycles never pace or rename a provider weekly percentage", () => {
  const at = Date.parse("2028-01-01T00:05:00Z");
  const resetsAt = "2028-01-04T00:00:00Z";
  const windowsBy = new Map([["demo-source", [{ id: "weekly", label: "Weekly", usedPct: 30, resetsAt }]]]);
  for (const quotaCycle of [
    { kind: "month" as const, timeZone: "UTC", day: 1, hour: 0, minute: 0 },
    { kind: "day" as const, timeZone: "UTC", hour: 0, minute: 0 },
  ]) {
    const cfg = { ...base, adapter: "codex-cli", usageProvider: "demo-source", quotaCycle };
    const windows = windowsFor(cfg, "codex-cli", { ...context, windowsBy, now: at });
    assert.equal(windows[0].cycleKind, "week");
    assert.equal(windows[0].label, tIn(language(), "quota.setup.weekWindow"));
    assert.equal(windows[0].usedPct, 30);
    assert.equal(windows[0].resetsAt, resetsAt);
    assert.equal(windows[0].startsAt, "2027-12-28T00:00:00.000Z");
    assert.equal(windows[0].elapsedPct, null);
    const status = poolStatus([usagePlan(windows, cfg)], { now: at })[base.id];
    assert.equal(status.dispatchable, true); assert.equal(status.pacePct, null);
    assert.notEqual(status.paceState, "ahead");
  }
});
test("matching live cycles use provider bounds; manual fallback uses configured calendar bounds", () => {
  const at = Date.parse("2028-01-01T00:05:00Z");
  const quotaCycle = { kind: "week" as const, timeZone: "UTC", weekday: 6, hour: 0, minute: 0 };
  const cfg = { ...base, adapter: "codex-cli", usageProvider: "demo-source", quotaCycle, manualOverride: { usedPct: 0, at: new Date(at).toISOString() } };
  const live = windowsFor(cfg, "codex-cli", { ...context, now: at, windowsBy: new Map([[cfg.usageProvider, [{ id: "weekly", label: "Weekly", usedPct: 30, resetsAt: "2028-01-04T00:00:00Z" }]]]) });
  assert.equal(live[0].paceEligible, true);
  assert.ok(live[0].elapsedPct! > 57 && live[0].elapsedPct! < 58);
  assert.equal(poolStatus([usagePlan(live, cfg)], { now: at })[base.id].dispatchable, true);
  const fallback = windowsFor(cfg, "codex-cli", { ...context, now: at, quotaError: "Demo failure" });
  assert.equal(fallback[0].source, "manual");
  assert.equal(fallback[0].startsAt, "2028-01-01T00:00:00.000Z");
  assert.equal(fallback[0].resetsAt, "2028-01-08T00:00:00.000Z");
});
test("shorter live provider windows use the user's stop threshold, without legacy reserve rules", () => {
  const cfg = { ...base, adapter: "claude-cli", usageProvider: "demo-source", quotaCycle: { kind: "unknown" as const } };
  for (const usedPct of [75, 80, 101]) {
    const windows = windowsFor(cfg, "claude-cli", { ...context, windowsBy: new Map([[cfg.usageProvider, [
      { id: "weekly", label: "Weekly", usedPct: 30, resetsAt: new Date(now + 86400000).toISOString() },
      { id: "five_hour", label: "Session", usedPct, resetsAt: new Date(now + 3600000).toISOString() },
    ]]]) });
    const status = poolStatus([usagePlan(windows, cfg)], { now })[base.id];
    assert.equal(status.dispatchable, usedPct < 80);
    if (usedPct >= 80) assert.match(status.reason, /Session/);
  }
});
test("unknown provider periods and mismatched durations do not invent a progress window", () => {
  const cfg = { ...base, adapter: "codex-cli", usageProvider: "demo-source", quotaCycle: { kind: "duration" as const, seconds: 86400, startsAt: new Date(now - 1000).toISOString() } };
  for (const label of ["Rolling", "2-hour"]) {
    const windows = windowsFor(cfg, "codex-cli", { ...context, windowsBy: new Map([[cfg.usageProvider, [{ label, usedPct: 30, resetsAt: new Date(now + 3600000).toISOString() }]]]) });
    assert.equal(windows[0].paceEligible, false);
    assert.equal(windows[0].elapsedPct, null);
    assert.equal(poolStatus([usagePlan(windows, cfg)], { now })[base.id].dispatchable, true);
  }
});
test("configured Grok weekly Session readings retain their provider pace hold", () => {
  const quotaCycle = { kind: "week" as const, timeZone: "UTC", weekday: 1, hour: 0, minute: 0 };
  const cfg = { ...base, adapter: "grok-cli", usageProvider: "demo-grok", quotaCycle };
  const resetsAt = new Date(now + 6 * 86400000).toISOString();
  const windows = windowsFor(cfg, "grok-cli", { ...context, providerCollectedAt: new Date(now).toISOString(), windowsBy: new Map([[cfg.usageProvider, [{ label: "Session", usedPct: 40, resetsAt }]]]) });
  assert.equal(windows[0].cycleKind, "week");
  assert.equal(windows[0].startsAt, new Date(now - 86400000).toISOString());
  assert.equal(windows[0].label, tIn(language(), "quota.setup.weekWindow"));
  assert.equal(windows[0].paceEligible, true);
  const status = poolStatus([usagePlan(windows, cfg)], { now })[base.id];
  assert.equal(status.paceState, "ahead");
  assert.equal(status.dispatchable, false);
});
test("a high weekly Codex Session cannot be hidden by the first short Session", () => {
  const quotaCycle = { kind: "week" as const, timeZone: "UTC", weekday: 1, hour: 0, minute: 0 };
  const cfg = { ...base, adapter: "codex-cli", usageProvider: "demo-codex", quotaCycle };
  const windows = windowsFor(cfg, "codex-cli", { ...context, providerCollectedAt: new Date(now).toISOString(), windowsBy: new Map([[cfg.usageProvider, [
    { label: "Session", usedPct: 10, resetsAt: new Date(now + 2 * 3600000).toISOString() },
    { label: "Session", usedPct: 90, resetsAt: new Date(now + 6 * 86400000).toISOString() },
  ]]]) });
  assert.equal(windows[0].cycleKind, "week"); assert.equal(windows[0].usedPct, 90);
  assert.equal(windows[1].cycleKind, "duration"); assert.equal(windows[1].usedPct, 10);
  assert.equal(Date.parse(windows[1].resetsAt!) - Date.parse(windows[1].startsAt!), 5 * 3600000);
  const status = poolStatus([usagePlan(windows, cfg)], { now })[base.id];
  assert.equal(status.usedPct, 90); assert.equal(status.dispatchable, false);
});
test("Claude five-hour Sessions never inherit weekly inference from a distant reset", () => {
  const cfg = { ...base, adapter: "claude-cli", usageProvider: "demo-claude", quotaCycle: { kind: "week" as const, timeZone: "UTC", weekday: 1, hour: 0, minute: 0 } };
  const windows = windowsFor(cfg, "claude-cli", { ...context, windowsBy: new Map([[cfg.usageProvider, [{ id: "five_hour", label: "Session", usedPct: 40, resetsAt: new Date(now + 6 * 86400000).toISOString() }]]]) });
  assert.equal(windows[0].cycleKind, "duration");
  assert.equal(windows[0].label, "Session");
  assert.equal(Date.parse(windows[0].resetsAt!) - Date.parse(windows[0].startsAt!), 5 * 3600000);
  assert.equal(windows[0].paceEligible, false);
});
test("daily and monthly cycles paired with normalized weekly Sessions stay without a progress line", () => {
  for (const quotaCycle of [
    { kind: "day" as const, timeZone: "UTC", hour: 0, minute: 0 },
    { kind: "month" as const, timeZone: "UTC", day: 1, hour: 0, minute: 0 },
  ]) {
    const cfg = { ...base, adapter: "grok-cli", usageProvider: "demo-grok", quotaCycle };
    const windows = windowsFor(cfg, "grok-cli", { ...context, providerCollectedAt: new Date(now).toISOString(), windowsBy: new Map([[cfg.usageProvider, [{ label: "Session", usedPct: 40, resetsAt: new Date(now + 6 * 86400000).toISOString() }]]]) });
    assert.equal(windows[0].cycleKind, "week"); assert.equal(windows[0].elapsedPct, null);
    const status = poolStatus([usagePlan(windows, cfg)], { now })[base.id];
    assert.equal(status.pacePct, null); assert.equal(status.dispatchable, true);
  }
});
test("localized monthly readings retain their editor and company-card identity", async () => {
  const { companyCursor } = await import("../usage-view");
  const previous = language();
  try {
    setLanguage("zh-CN");
    const cfg = { ...base, adapter: "cursor-api", quotaCycle: { kind: "month" as const, timeZone: "UTC", day: 1, hour: 0, minute: 0 }, manualOverride: copied };
    const windows = windowsFor(cfg, "cursor-api", context);
    assert.notEqual(windows[0].label, "Monthly");
    assert.equal(windows[0].cycleKind, "month");
    assert.equal(windows[0].usedPct, 12);
    assert.equal(showManualEditor(windows[0], cfg), true);
    const company = companyCursor([usagePlan(windows, cfg)], null, null);
    assert.equal(company?.manualUsedPct, 12);
    assert.equal(company?.manualAt, copied.at);
    assert.equal(company?.resetsAt, windows[0].resetsAt);
    assert.equal(showManualEditor({ label: "Monthly", cycleKind: "week" }, { adapter: "cursor-api" }), false);
  } finally { setLanguage(previous); }
});
test("localized Claude weekly and session readings reach the company card with stable identity", async () => {
  const { companyWindows } = await import("../usage-view");
  const previous = language();
  try {
    for (const locale of ["en", "zh-CN"] as const) {
      setLanguage(locale);
      const cfg = { ...base, adapter: "claude-cli", usageProvider: "demo-claude", quotaCycle: { kind: "week" as const, timeZone: "UTC", weekday: 1, hour: 0, minute: 0 } };
      const weeklyReset = new Date(now + 6 * 86400000).toISOString();
      const sessionReset = new Date(now + 2 * 3600000).toISOString();
      const windows = windowsFor(cfg, "claude-cli", { ...context, windowsBy: new Map([[cfg.usageProvider, [
        { id: "five_hour", label: "Session", usedPct: 10, resetsAt: sessionReset },
        { id: "seven_day_fable", label: "Weekly · Fable", usedPct: 20, resetsAt: weeklyReset },
        { id: "seven_day", label: "Weekly", usedPct: 40, resetsAt: weeklyReset },
      ]]]) });
      assert.equal(windows[0].label, tIn(locale, "quota.setup.weekWindow"));
      const plans = [usagePlan(windows, cfg)];
      const projected = companyWindows(plans, new Date(now).toISOString());
      assert.equal(projected[0].id, "seven_day");
      assert.equal(projected[0].cycleKind, "week");
      assert.equal(projected[0].primary, true);
      const card = buildCompanies({ companies: companyCatalog(plans), windows: projected, pools: poolStatus(plans, { now }), profiles: [], cursor: null })[0];
      assert.equal(card.windows.find(w => w.id === "claude-week")?.usedPct, 40);
      assert.equal(card.windows.find(w => w.id === "claude-week")?.resetsAt, weeklyReset);
      assert.equal(card.windows.find(w => w.id === "claude-week")?.source, "provider");
      assert.equal(card.windows.find(w => w.id === "claude-session")?.usedPct, 10);
      assert.equal(card.windows.find(w => w.id === "claude-session")?.resetsAt, sessionReset);
      assert.equal(card.remainingPct, 60);
      assert.equal(card.headline, tIn(locale, "quota.line.remaining", { pct: 60 }));
    }
  } finally { setLanguage(previous); }
});
test("cycle lookups prefer stable identity and retain legacy label compatibility", async () => {
  const duration = { id: "five_hour", label: "Weekly", cycleKind: "duration" as const };
  const weekly = { id: "seven_day", label: "Translated quota", cycleKind: "week" as const };
  const fable = { label: "Weekly · Fable", cycleKind: "week" as const };
  assert.equal(mainWindowOf("claude-cli", [duration, fable, weekly]), weekly);
  assert.equal(sessionWindowOf("claude-cli", [weekly, duration]), duration);
  assert.equal(isWeeklyWindow({ label: "Monthly", id: "seven_day" }), true);
  assert.equal(isMonthlyWindow({ label: "Weekly", id: "monthly" }), true);
  assert.equal(isWeeklyWindow({ label: "Weekly", cycleKind: "unknown" }), false);
  assert.equal(isWeeklyWindow({ label: "Weekly", id: "five_hour" }), false);
  assert.equal(isWeeklyWindow({ label: "Weekly" }), true);
  assert.equal(isMonthlyWindow({ label: "Monthly" }), true);
  const { providerWeekly } = await import("../grok-usage");
  assert.equal(providerWeekly([
    { ...duration, usedPct: 10 },
    { ...weekly, usedPct: 40 },
  ])?.usedPct, 40);
});
test("fresh installs contain zero plans and never replace legacy data", async () => {
  assert.deepEqual((await readSettings("plans", dir)).document, { schemaVersion: 2, plans: [], dispatchPriority: null });
  const old = join(dir, "legacy");
  initializeSettings(old, fileURLToPath(new URL("../../../examples/", import.meta.url)));
  const bytes = '{"plans":[{"id":"old-demo","name":"Existing","cycleDay":31,"extension":true}]}';
  await writeFile(join(old, "plans.json"), bytes);
  initializeSettings(old, fileURLToPath(new URL("../../../examples/", import.meta.url)));
  assert.equal(readFileSync(join(old, "plans.json"), "utf8"), bytes);
});
test("zero, single and dual pools save and export; empty/manual configurations never call usage providers", async () => {
  let probes = 0;
  const host = { providers: { listUsage: async () => { probes++; throw Error("Unexpected provider probe"); } } } as never;
  for (const count of [0, 1, 2, 0, 1]) {
    const before = await readSettings("plans", dir);
    const plans = Array.from({ length: count }, (_, index) => ({ ...base, id: `demo-${index}`, manualOverride: copied }));
    const saved = await writeSettings({ file: "plans", revision: before.revision, document: { schemaVersion: 2, plans, dispatchPriority: null } }, dir);
    assert.equal(saved.status, "saved");
    clearCache();
    const board = await buildUsage(host, "7d");
    assert.equal(board.plans.length, count);
    const exported = JSON.parse(readFileSync(join(dir, "..", "exports/fleet/pool-status.json"), "utf8"));
    assert.equal(exported.quotaConfigured, true);
    assert.equal(Object.keys(exported.pools).length, count);
    for (const row of Object.values(exported.pools) as any[]) { assert.equal(row.usedPct, 12); assert.equal(row.dispatchable, true); assert.equal(row.quotaProtection, "pause"); }
  }
  assert.equal(probes, 0);
});
test("failed automatic reads use saved manual overrides, expire safely and recover without editing the adapter", async () => {
  const cfg = { ...base, adapter: "codex-cli" as const, usageProvider: "demo-account", manualOverride: copied };
  const failure = windowsFor(cfg, cfg.adapter, { ...context, quotaError: "demo failure" });
  assert.equal(failure[0].usedPct, 12);
  assert.equal(failure[0].source, "manual");
  assert.equal(failure[0].readError, "demo failure");
  assert.equal(poolStatus([usagePlan(failure, { adapter: cfg.adapter })], { now })[base.id].dispatchable, true);
  const stale = windowsFor(cfg, cfg.adapter, { ...context, now: now + 3600001 });
  const stopped = poolStatus([usagePlan(stale, { adapter: cfg.adapter })], { now: now + 3600001 })[base.id];
  assert.equal(stale[0].readingState, "stale"); assert.equal(stale[0].staleUsedPct, 12);
  assert.equal(stopped.usedPct, null); assert.equal(stopped.dispatchable, false);
  const live = windowsFor(cfg, cfg.adapter, { ...context, windowsBy: new Map([[cfg.usageProvider, [{ label: "Weekly", usedPct: 0, resetsAt: new Date(now + 86400000).toISOString() }]]]) });
  assert.equal(live[0].usedPct, 0); assert.equal(live[0].readingState, "live");
  assert.equal(live[0].elapsedPct, null); assert.equal(cfg.manualOverride.usedPct, 12);
  await writePoolStatus([usagePlan(stale, { adapter: cfg.adapter })], null, now + 3600001);
  assert.equal(JSON.parse(readFileSync(join(dir, "..", "exports/fleet/pool-status.json"), "utf8")).pools[base.id].usedPct, null);
});
test("automatic failure does not prevent exports or stop another pool", async () => {
  const before = await readSettings("plans", dir);
  await writeSettings({ file: "plans", revision: before.revision, document: { schemaVersion: 2, plans: [
    { ...base, id: "demo-auto", adapter: "codex-cli", usageProvider: "demo-auto", manualOverride: null, couponCliRead: false },
    { ...base, id: "demo-manual", manualOverride: copied },
  ] } }, dir);
  clearCache();
  const board = await buildUsage({ providers: { listUsage: async () => { throw Error("Demo unavailable"); } } } as never, "7d");
  assert.equal(board.pools?.["demo-auto"].usedPct, null);
  assert.equal(board.pools?.["demo-auto"].dispatchable, false);
  assert.equal(board.pools?.["demo-manual"].dispatchable, true);
});
test("same-provider accounts require distinct usage ids; unknowns and invalid percentages are never zero", async () => {
  const before = await readSettings("plans", dir);
  await writeSettings({ file: "plans", revision: before.revision, document: { schemaVersion: 2, plans: [0, 1].map(index => ({ ...base, id: `demo-account-${index}`, adapter: "codex-cli", usageProvider: "demo-shared", couponCliRead: false })) } }, dir);
  clearCache();
  const result = await assemble({ providers: { listUsage: async () => ({ providers: [{ providerId: "demo-shared", windows: [{ label: "Weekly", usedPct: 1, resetsAt: new Date(now + 86400000).toISOString() }] }] }) } } as never, "7d");
  for (const plan of result.board.plans) { assert.equal(plan.windows[0].usedPct, null); assert.match(plan.windows[0].readError ?? "", /multiple pools/); }
  for (const usedPct of [null, NaN, Infinity, 101]) {
    const windows = windowsFor({ ...base, usageProvider: "demo" }, "codex-cli", { ...context, windowsBy: new Map([["demo", [{ label: "Weekly", usedPct }]]]) });
    assert.equal(windows[0].usedPct, null);
    assert.equal(poolStatus([usagePlan(windows)], { now })[base.id].dispatchable, false);
    assert.equal(poolStatus([usagePlan(windows, { quotaProtection: "none" })], { now })[base.id].dispatchable, true);
  }
});
test("new schemas reject unknown priority references and cycle edits invalidate old fallback copies", async () => {
  assert.equal(plansSchema.safeParse({ schemaVersion: 2, plans: [base], dispatchPriority: { order: ["missing"], until: "2099-01-01T00:00:00Z" } }).success, false);
  const before = await readSettings("plans", dir);
  const saved = await writeSettings({ file: "plans", revision: before.revision, document: { schemaVersion: 2, plans: [{ ...base, manualOverride: copied }] } }, dir);
  const plan = (saved.snapshot.document.plans as any[])[0];
  assert.ok(plan.manualOverride.cycleKey);
  const changed = { ...plan, quotaCycle: { kind: "day", timeZone: "UTC", hour: 0, minute: 0 } };
  const edited = await writeSettings({ file: "plans", revision: saved.snapshot.revision, document: { schemaVersion: 2, plans: [changed] } }, dir);
  const persisted = (edited.snapshot.document.plans as any[])[0];
  assert.equal(windowsFor(persisted, "manual", context)[0].readingState, "stale");
});
test("quick edits share validated fallback persistence and clearing never restores an older legacy copy", async () => {
  const before = await readSettings("plans", dir);
  await writeSettings({ file: "plans", revision: before.revision, document: { schemaVersion: 2, plans: [{ ...base, manual: copied, manualOverride: copied }] } }, dir);
  assert.equal((await updatePlan({ id: base.id, manualUsedPct: 23 })).ok, true);
  const changed = (await readSettings("plans", dir)).document.plans as any[];
  assert.equal(changed[0].manualOverride.usedPct, 23);
  assert.equal(changed[0].manual.usedPct, 12);
  assert.ok(changed[0].manualOverride.cycleKey);
  await assert.rejects(() => updatePlan({ id: base.id, manualUsedPct: 101 }));
  assert.equal((await updatePlan({ id: base.id, manualUsedPct: null })).ok, true);
  const cleared = (await readSettings("plans", dir)).document.plans as any[];
  assert.equal(windowsFor({ ...cleared[0], quotaCycle: undefined }, "manual", context)[0].usedPct, null);
});
test("separate same-provider usage ids retain independent automatic percentages", async () => {
  const before = await readSettings("plans", dir);
  await writeSettings({ file: "plans", revision: before.revision, document: { schemaVersion: 2, plans: [0, 1].map(index => ({ ...base, id: `demo-distinct-${index}`, adapter: "codex-cli", usageProvider: `demo-source-${index}` })) } }, dir);
  clearCache();
  const result = await assemble({ providers: { listUsage: async () => ({ providers: [12, 77].map((usedPct, index) => ({ providerId: `demo-source-${index}`, windows: [{ label: "Weekly", usedPct }] })) }) } } as never, "7d");
  assert.deepEqual(result.board.plans.map(plan => plan.windows[0].usedPct), [12, 77]);
});
test("empty and newly configured pools do not launch coupon provider probes", async () => {
  const { confirmResetCoupons } = await import("../reset-coupons");
  const { couponPlansOf } = await import("../reset-coupons-state");
  let probes = 0;
  const host = { providers: { listUsage: async () => { probes++; throw Error("Unexpected coupon probe"); } } } as never;
  for (const plans of [[], [{ ...base, adapter: "codex-cli", providers: ["codex"] }]]) {
    assert.equal(couponPlansOf({ plans }).cliRead.chatgpt ?? false, false);
    const before = await readSettings("plans", dir);
    await writeSettings({ file: "plans", revision: before.revision, document: { schemaVersion: 2, plans } }, dir);
    await confirmResetCoupons(host, { force: true });
  }
  assert.equal(probes, 0);
  assert.equal(couponPlansOf({ plans: [{ id: "demo-legacy", adapter: "codex-cli", providers: ["codex"] }] }).cliRead.chatgpt, true);
});
