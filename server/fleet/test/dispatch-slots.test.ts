// Shipped matrix tokens are stable ids. A readable config publishes the live profile name.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { applyDispatchMatrix, profilesFromConfig, type DispatchMatrix, type DispatchProfile } from "../../../shared/fleet/dispatch";
import { dispatchSlotLabel, resolveProfileToken } from "../../../shared/fleet/dispatch-slots";
import { setLanguage, tIn } from "../../../shared/fleet/i18n";
import { orderLines } from "../../../shared/fleet/roles-page";

const shipped = JSON.parse(readFileSync(new URL("../../../shared/fleet/default-dispatch.example.json", import.meta.url), "utf8")) as DispatchMatrix;

function profile(partial: Partial<DispatchProfile> & Pick<DispatchProfile, "name">): DispatchProfile {
  return { provider: "", notes: "", ...partial };
}

test("the shipped matrix stores ascii slot ids", () => {
  assert.equal(/[^\u0000-\u007F]/.test(JSON.stringify(shipped)), false);
  assert.equal(JSON.stringify(shipped).includes("executor.gpt-6.1-sol"), true);
});

test("a slot resolves to one profile, a name matches itself, and dispatchId wins", () => {
  const profiles = [
    profile({ name: "Main executor", role: "executor", provider: "codex", model: "gpt-6.1-sol" }),
    profile({ name: "Sonnet stand-in", role: "candidate", candidateFor: "executor", provider: "claude", model: "claude-opus-5-5" }),
    profile({ name: "Opus stand-in", role: "candidate", candidateFor: "executor", provider: "claude", model: "claude-opus-5-5" }),
    profile({ name: "Cursor reviewer", role: "candidate", candidateFor: "reviewer", provider: "cursor", model: "grok-4" }),
    profile({ name: "SuperGrok reviewer", role: "candidate", candidateFor: "reviewer", provider: "grok", model: "grok-4" }),
    profile({ name: "Marked opus", role: "candidate", candidateFor: "executor", provider: "claude", model: "claude-sonnet-5", dispatchId: "executor.opus" }),
  ];
  assert.equal(resolveProfileToken("executor", profiles)?.name, "Main executor");
  assert.equal(resolveProfileToken("executor.sonnet", profiles)?.name, "Sonnet stand-in");
  assert.equal(resolveProfileToken("executor.opus", profiles)?.name, "Marked opus");
  assert.equal(resolveProfileToken("reviewer.grok", profiles)?.name, "SuperGrok reviewer");
  assert.equal(resolveProfileToken("reviewer.grok", [profile({ name: "Reviewer · Grok (SuperGrok)", role: "candidate", candidateFor: "reviewer" })])?.name, "Reviewer · Grok (SuperGrok)");
  assert.equal(resolveProfileToken("Demo executor", [profile({ name: "Demo executor", role: "executor" })])?.name, "Demo executor");
  assert.equal(resolveProfileToken("missing.slot", profiles), null);
});

test("applyDispatchMatrix publishes live names and drops an unmatched slot", () => {
  const profiles = [profile({ name: "Main executor", role: "executor", provider: "codex", model: "gpt-6.1-sol" })];
  const mini = {
    version: 1, defaultTier: "L2", downgradeWhenTight: [],
    roles: { executor: { L1: [
      { profile: "executor", effort: "low" },
      { profile: "executor.sonnet", effort: "low" },
      { profile: "Main executor", effort: "medium" },
    ] } },
  } as DispatchMatrix;
  const matrix = applyDispatchMatrix(mini, {
    knownNames: new Set(profiles.map((row) => row.name)),
    profiles,
    pools: null,
    generatedAt: "2026-10-08T00:00:00.000Z",
  });
  const list = (matrix.roles.executor as { L1: Array<{ profile: string }> }).L1;
  assert.deepEqual(list.map((entry) => entry.profile), ["Main executor", "Main executor"]);
});

test("an unreadable config drops the shipped slot ids", () => {
  const matrix = applyDispatchMatrix(shipped, { knownNames: null, profiles: [], pools: null, generatedAt: "2026-10-08T00:00:00.000Z" });
  assert.equal(JSON.stringify(matrix).includes("executor.sonnet"), false);
  assert.equal(JSON.stringify(matrix).includes("ops.notion"), false);
});

test("slot labels come from the catalog in both languages", () => {
  setLanguage("en");
  assert.equal(dispatchSlotLabel("executor.sonnet"), tIn("en", "dispatch.slot.executorSonnet"));
  setLanguage("zh-CN");
  assert.equal(dispatchSlotLabel("executor"), tIn("zh-CN", "dispatch.role.executor"));
  const lines = orderLines("executor", {
    version: 1, defaultTier: "L2", downgradeWhenTight: [],
    roles: { executor: { L1: [{ profile: "executor.gpt-6.1-sol", effort: "low" }] } },
  }, 1);
  assert.equal(lines[0]?.includes("executor.gpt-6.1-sol"), false);
  assert.equal(lines[0]?.includes("GPT-6.1-Sol"), true);
  assert.equal(dispatchSlotLabel("Demo executor"), null);
  setLanguage("en");
});

test("profilesFromConfig keeps an explicit dispatchId", () => {
  const parsed = profilesFromConfig({ daemon: { agentProfiles: [
    { name: "Demo executor", role: "executor", provider: "codex", model: "gpt-6.1-sol", dispatchId: "executor" },
  ] } });
  assert.equal(parsed?.[0]?.dispatchId, "executor");
  assert.equal(parsed?.[0]?.name, "Demo executor");
});
