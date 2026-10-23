// Hidden plans are a config list. The public default shows every plan, including a gemini demo.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { hiddenPlanTerms, textHidden } from "../../../shared/fleet/hidden-plans";
import type { UsagePlan, UsageWindow } from "../../../shared/fleet/usage";
import { readHiddenPlans } from "../adapters/config";
import { poolStatus } from "../pools-status";

const NOW = Date.parse("2026-10-08T00:00:00.000Z");

function windowOf(): UsageWindow {
  return {
    label: "Monthly", usedPct: 10, resetsAt: "2026-11-01T00:00:00.000Z", startsAt: null,
    elapsedPct: null, projectedPct: null, runsOutAt: null, verdict: "unknown", apiUsd: 0, fullWindowUsd: null, planUsd: null,
    source: "manual", manualAt: "2026-10-01T00:00:00.000Z",
  };
}

function planOf(id: string, providers: string[], name = `${id} plan`): UsagePlan {
  return {
    id, name, priceUsdMonthly: 0, dispatch: false, note: "", providers, windows: [windowOf()],
    api30dUsd: 0, roi30d: null, coverage: "", adapter: "manual",
  };
}

test("hiddenPlanTerms keeps trimmed unique strings and ignores anything else", () => {
  assert.deepEqual(hiddenPlanTerms(null), []);
  assert.deepEqual(hiddenPlanTerms({}), []);
  assert.deepEqual(hiddenPlanTerms({ hiddenPlans: "gemini" }), []);
  assert.deepEqual(hiddenPlanTerms({ hiddenPlans: [" Gemini ", "google", "gemini", 1, ""] }), ["gemini", "google"]);
  assert.equal(textHidden("Demo Gemini plan", ["gemini"]), true);
  assert.equal(textHidden("Demo Claude plan", []), false);
});

test("the example config hides nothing", () => {
  const example = JSON.parse(readFileSync(new URL("../../../examples/afc.config.example.json", import.meta.url), "utf8")) as unknown;
  assert.deepEqual(hiddenPlanTerms(example), []);
});

test("readHiddenPlans is empty until the data directory lists terms", () => {
  const dir = mkdtempSync(join(tmpdir(), "hidden-plans-"));
  assert.deepEqual(readHiddenPlans(dir), []);
  writeFileSync(join(dir, "afc.config.json"), JSON.stringify({ language: "system", hiddenPlans: ["gemini", "google"] }));
  assert.deepEqual(readHiddenPlans(dir), ["gemini", "google"]);
});

test("a gemini plan is a pool by default and disappears only when providers are banned", () => {
  const gemini = planOf("gemini", ["gemini"], "Gemini demo");
  const claude = planOf("claude", ["claude"], "Claude demo");
  const open = poolStatus([gemini, claude], { now: NOW });
  assert.equal(typeof open.gemini, "object");
  assert.equal(typeof open.claude, "object");
  const hidden = poolStatus([gemini, claude], { now: NOW, bannedProviders: ["gemini", "google"] });
  assert.equal(hidden.gemini, undefined);
  assert.equal(typeof hidden.claude, "object");
  const byProvider = poolStatus([planOf("search", ["google"], "Search demo")], { now: NOW, bannedProviders: ["google"] });
  assert.equal(byProvider.search, undefined);
  const bare = { ...planOf("supergrok", [], "SuperGrok"), providers: undefined } as unknown as UsagePlan;
  const barePool = poolStatus([bare], { now: NOW }).supergrok;
  assert.equal(typeof barePool, "object");
  assert.deepEqual(barePool.providers, []);
});
