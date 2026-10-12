import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { antigravityCountdown, antigravityLeft, antigravityRowStale } from "../../../shared/fleet/antigravity-display";
import { setLanguage, t } from "../../../shared/fleet/i18n";
import { companyCatalog } from "../../../shared/fleet/quota-adapters";
import { buildCompanies } from "../../../shared/fleet/quota-companies";
import { antigravityDisplayWindows, readingFromRun } from "../quota/antigravity-usage";
import { QUOTA_DISPLAY_TTL_MS } from "../quota-timing";
import { companyWindows } from "../usage-view";
import type { UsagePlan } from "../../../shared/fleet/usage";

const now = Date.parse("2028-06-01T00:00:00Z");
const table = [
  "Gemini Models\tWeekly Limit Remaining\t0%\t2028-06-08T00:00:00Z",
  "Claude and GPT models\tFive Hour Limit Remaining\t95%\t2028-06-01T05:00:00Z",
  "Gemini Models\tFive Hour Limit Remaining\t100%\t2028-06-01T05:00:00Z",
  "Claude and GPT models\tWeekly Limit Remaining\t97%\t2028-06-08T00:00:00Z",
].join("\n");
const reading = (code: number | null = 0) => readingFromRun({ stdout: table, stderr: "", code, timedOut: false }, now);
function card(display = antigravityDisplayWindows(reading(), now)) {
  const plan: UsagePlan = { id: "demo", name: "Old Gemini label", adapter: "antigravity-cli", windows: [], antigravityDisplay: display,
    priceUsdMonthly: null, dispatch: false, note: "", providers: ["antigravity"], api30dUsd: 0, roi30d: null, coverage: "" };
  return buildCompanies({ companies: companyCatalog([plan]), windows: companyWindows([plan], new Date(now + 1000).toISOString()),
    pools: { demo: { dispatchable: false } }, profiles: [], cursor: null })[0];
}
afterEach(() => setLanguage("en"));

test("one card presents both buckets in fixed order, with remaining boundary values and original sample time", () => {
  setLanguage("en");
  const result = card();
  assert.equal(result.name, "Antigravity");
  assert.equal(antigravityRowStale(result.windows[0], now), false);
  assert.equal(antigravityRowStale(result.windows[0], now + QUOTA_DISPLAY_TTL_MS), true);
  assert.deepEqual(result.windows.map(row => row.name), ["Gemini · 5 hour", "Gemini · Weekly", "Claude · 5 hour", "Claude · Weekly"]);
  assert.deepEqual(result.windows.map(row => row.usedPct), [0, 100, 5, 3]);
  assert.deepEqual(result.windows.map(row => row.remainingPct), [100, 0, 95, 97]);
  assert.ok(result.windows.every(row => row.readAt === new Date(now).toISOString() && !row.showPace && row.stopPct === null));
  assert.ok(result.windows.every(row => row.dispatchText === t("quota.antigravity.displayPaused")));
  assert.ok(result.windows.every(row => !row.id.includes("acp-dispatch")));
});

test("failed or absent reads keep all four slots unknown without fabricated reset or sample timestamps", () => {
  for (const value of [null, reading(2), reading(null)]) {
    const result = card(antigravityDisplayWindows(value, now));
    assert.equal(result.windows.length, 4);
    assert.ok(result.windows.every(row => row.usedPct === null && row.remainingPct === null && row.resetsAt === null && row.readAt === null));
    assert.ok(result.windows.every(row => row.readingState === "unknown"));
    assert.ok(result.windows.every(row => row.sourceText === t("quota.antigravity.displayUnknown")));
  }
  const partial = reading(); partial.samples = partial.samples.slice(0, 1);
  assert.equal(card(antigravityDisplayWindows(partial, now)).windows.filter(row => row.remainingPct !== null).length, 1);
});

test("expired samples retain their value and real sampling time, including a passed reset", () => {
  const result = card(antigravityDisplayWindows(reading(), now + QUOTA_DISPLAY_TTL_MS + 1));
  assert.equal(result.stale, true);
  assert.ok(result.windows.every(row => row.readingState === "stale" && row.tone === "yellow" && row.readAt === new Date(now).toISOString()));
  assert.deepEqual(result.windows.map(row => row.remainingPct), [100, 0, 95, 97]);
  const recent = reading(); recent.samples[0].resetsAt = new Date(now - 1).toISOString();
  assert.equal(antigravityDisplayWindows(recent, now).find(row => row.id === "gemini-cli-week")?.readingState, "stale");
});

test("countdowns use reset timestamps and language; unknown never formats as zero or full quota", () => {
  setLanguage("en");
  assert.equal(antigravityCountdown(new Date(now + 90 * 60_000).toISOString(), now), "1h 30m");
  assert.equal(antigravityCountdown(new Date(now + 25 * 60 * 60_000).toISOString(), now), "1d 1h 0m");
  assert.equal(antigravityCountdown(new Date(now + 1).toISOString(), now), "1m");
  assert.equal(antigravityCountdown(new Date(now).toISOString(), now), "Reset due");
  assert.equal(antigravityCountdown(null, now), "Reset unknown");
  assert.equal(antigravityCountdown("bad", now), "Reset unknown");
  assert.equal(antigravityLeft(null), "Left unknown");
  assert.equal(antigravityLeft(0), "Left 0%");
  assert.equal(antigravityLeft(100), "Left 100%");
  setLanguage("zh-CN");
  assert.equal(antigravityLeft(95), t("quota.antigravity.left", { pct: 95 }));
  assert.equal(card().windows[2].name, t("quota.antigravity.claudeFiveHour"));
});

test("multiple protected Antigravity plans still produce one CLI display card", () => {
  const plans = [{ id: "gemini", adapter: "antigravity-cli", providers: ["antigravity"] },
    { id: "shared", adapter: "antigravity-cli", providers: ["antigravity"] },
    { id: "hand", adapter: "manual", providers: [] }];
  const results = buildCompanies({ companies: companyCatalog(plans), windows: [], pools: {}, profiles: [], cursor: null });
  assert.equal(results.filter(result => result.adapter === "antigravity-cli").length, 1);
  assert.equal(results.filter(result => result.adapter === "manual").length, 1);
});

test("display fields cannot replace another provider's company windows", () => {
  const window = antigravityDisplayWindows(reading(), now)[0];
  const plan: UsagePlan = { id: "hand", name: "Hand copy", adapter: "manual", windows: [{ ...window, usedPct: 80, source: "manual" }],
    antigravityDisplay: [window], priceUsdMonthly: null, dispatch: false, note: "", providers: [], api30dUsd: 0, roi30d: null, coverage: "" };
  assert.equal(companyWindows([plan], new Date(now).toISOString())[0].usedPct, 80);
  assert.equal(companyWindows([plan], new Date(now).toISOString())[0].source, "manual");
});
