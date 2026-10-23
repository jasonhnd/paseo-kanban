import assert from "node:assert/strict";
import { test } from "node:test";
import { routeProfile, familyDispatchBlock, type RouteInput } from "../server/routing";
import { openEntry, type PoolSnapshot } from "../server/pools";
import type { Profile } from "../server/profiles";
import { parseDispatchMatrix } from "../server/matrix";
import { setLanguage } from "../shared/i18n";

setLanguage("en");
const snapshot: PoolSnapshot = { state: "fresh", message: "Demo", generatedAt: null,
  entry: () => openEntry(), dispatchable: () => true, hasPool: () => true };
const paid: Profile = { id: "paid", name: "Demo paid", role: "reader", provider: "cursor", model: "claude-opus-demo", pool: "x-ultra" };
const reviewer: Profile = { id: "review", name: "Demo review", role: "reviewer", provider: "demo", model: "demo-review" };
const input = (profile = paid): RouteInput => ({ profiles: [profile, reviewer], role: "reader", review: false,
  byPool: {}, poolLimits: {}, snapshot, tier: "L2" });
const matrix = (profile: Profile, role = "reader") => parseDispatchMatrix({ version: 1, defaultTier: "L2", downgradeWhenTight: [],
  roles: { [role]: { L2: [{ profile: profile.name, effort: "low" }] }, reviewer: { L2: [{ profile: reviewer.name, effort: "low" }] } } });
function rejected(result: ReturnType<typeof routeProfile>) {
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /third.party.*(paid|bill|usage)|paid.*third.party/i);
}
for (const model of ["claude-opus-demo", "gpt-demo", "gemini-demo", "unknown", "", "grokish", "composer-third-party", "cursor/gpt-demo", "cursor/claude-demo"]) {
  test(`Cursor ${model || "missing model"} is refused by roster, explicit profile and matrix`, () => {
    const profile = { ...paid, model };
    rejected(routeProfile(input(profile)));
    rejected(routeProfile({ ...input(profile), profileOverride: profile.id }));
    rejected(routeProfile({ ...input(profile), matrix: matrix(profile) }));
  });
}
test("Cursor channel evidence cannot be hidden by a provider, family or pool relabel", () => {
  for (const profile of [
    { ...paid, provider: "acp", command: ["cursor-agent", "acp"] },
    { ...paid, provider: "demo", config: { channel: "cursor" } },
    { ...paid, provider: "cursor/demo", pool: "demo", family: "xai" },
  ]) assert.match(familyDispatchBlock(profile, "low", snapshot, {})!, /third.party/i);
});
test("paused matrix items without a task retain permanent Cursor refusal reasons", () => {
  for (const model of ["claude-opus-demo", "unknown", "grok-demo", "composer-2"]) {
    const profile = { ...paid, model };
    const paused = matrix(profile)!;
    paused.starTiers!.reader!.L2![0].paused = true;
    const result = routeProfile({ ...input(profile), matrix: paused });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.reason, model === "grok-demo" || model === "composer-2" ? /Cursor channel is reserved/i : /paid Additional Usage/i);
      assert.equal(result.action, "block");
      assert.equal(result.kind, "needs_human");
      assert.notEqual(result.quotaWait, true);
    }
  }
});
test("review reservations reject paid Cursor models and existing Cursor read-only rule still applies", () => {
  const executor = { ...reviewer, id: "exec", name: "Demo exec", role: "executor", model: "demo-exec" };
  const reserve = { ...paid, role: "reviewer" };
  rejected(routeProfile({ ...input(executor), profiles: [executor, reserve], role: "executor" }));
  for (const model of ["grok-demo", "composer-2", "cursor/composer-2"]) {
    assert.equal(familyDispatchBlock({ ...paid, model }, "low", snapshot, {}), null);
    assert.equal(routeProfile(input({ ...paid, model })).ok, false);
  }
});
