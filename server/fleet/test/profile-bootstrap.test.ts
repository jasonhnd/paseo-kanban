import assert from "node:assert/strict";
import { test } from "node:test";
import { discoverRoles, previewRoles } from "../profile-bootstrap";
import { buildRolePreview, type Discovery, type RoleChoice } from "../../../shared/fleet/profile-bootstrap";
import { profilesFromConfig, profilesFromRpcConfig } from "../../../shared/fleet/dispatch";
import { tIn } from "../../../shared/fleet/i18n";

const choice: RoleChoice = { provider: "demo-primary", model: "demo-model", family: "openai", confirmedFamily: true };
const discovery: Discovery = { status: "ready", providers: [
  { provider: "demo-primary", state: "discoverable", enabled: true, modes: [{ id: "demo-mode", label: "Demo mode" }], models: [{ id: "demo-model", label: "Demo model", thinking: [{ id: "demo-depth", label: "Demo depth" }] }] },
  { provider: "demo-review", state: "discoverable", enabled: true, modes: [], models: [{ id: "demo-review-model", label: "Demo review model", thinking: [] }] },
] };
function host(entries = discovery.providers.map(row => ({ ...row, status: "ready", models: row.models.map(model => ({ ...model, provider: row.provider, thinkingOptions: model.thinking })) }))) {
  return {
    get config(): never { throw new Error("Broad config must never be accessed"); },
    get agents(): never { throw new Error("Agents must never be created"); },
    providers: {
      waitForReady: async () => ({ entries }),
      listAvailable: async () => ({ providers: entries.map(row => ({ provider: row.provider, available: true })) }),
    },
  } as unknown as Parameters<typeof discoverRoles>[0];
}

test("zero, single, and two families preview without host writes or authentication claims", async () => {
  assert.deepEqual(await discoverRoles(host([])), { status: "ready", providers: [] });
  const one = await previewRoles(host(), { executor: choice, language: "en" });
  assert.equal(one.profiles.length, 5);
  assert.equal(one.review, "manual");
  assert.ok(one.profiles.every(row => !('pool' in row) && !('featureValues' in row)));
  const two = buildRolePreview(discovery, choice, { ...choice, provider: "demo-review", model: "demo-review-model", family: "anthropic" }, "en");
  assert.equal(two.profiles.length, 6);
  assert.equal(two.review, "independent");
  assert.equal(two.profiles.find(row => row.role === "reviewer")?.family, "anthropic");
  assert.equal(two.profiles.find(row => row.role === "supervisor")?.role, "supervisor");
  assert.deepEqual(buildRolePreview(discovery, choice, undefined, "en"), one);
  assert.match(buildRolePreview(discovery, choice, undefined, "zh-CN").profiles[0].notes, /\u534f\u8c03/);
});

test("disabled, unavailable, hidden models, unconfirmed families and stale options are rejected", async () => {
  for (const change of [{ model: "demo-removed" }, { family: "unknown" }, { family: " " }, { confirmedFamily: false }, { modeId: "demo-invalid" }, { thinkingOptionId: "demo-invalid" }]) {
    assert.equal(buildRolePreview(discovery, { ...choice, ...change } as RoleChoice, undefined, "en").status, "invalid");
  }
  assert.equal(buildRolePreview(discovery, choice, { ...choice, family: " OPENAI " }, "en").status, "invalid");
  assert.equal(buildRolePreview(discovery, { ...choice, modeId: "demo-mode", thinkingOptionId: "demo-depth" }, undefined, "en").profiles[0].thinkingOptionId, "demo-depth");
  const raw = [{ provider: "demo-primary", enabled: false, status: "ready", models: [{ provider: "demo-primary", id: "demo-model", label: "Demo model" }] }];
  assert.equal((await discoverRoles(host(raw as never))).providers[0].state, "unavailable");
  assert.equal((await previewRoles(host(raw as never), { executor: choice, language: "en" })).status, "invalid");
  raw[0].enabled = true;
  (raw[0].models[0] as Record<string, unknown>).isSelectable = false;
  assert.equal((await discoverRoles(host(raw as never))).providers[0].models.length, 0);
});

test("same family different actual models preview independent review; same model across routes cannot", () => {
  const reviewer = { ...choice, provider: "demo-review", model: "demo-review-model" };
  assert.equal(buildRolePreview(discovery, choice, reviewer, "en").review, "independent");
  const withSameModel: Discovery = structuredClone(discovery);
  withSameModel.providers[1].models.push({ id: choice.model, label: "Demo duplicate route", thinking: [{ id: "other-depth", label: "Other" }] });
  const same = buildRolePreview(withSameModel, choice, { ...reviewer, model: choice.model, family: "anthropic", thinkingOptionId: "other-depth" }, "en");
  assert.equal(same.status, "invalid");
  assert.equal(same.issue, "model");
});

test("copied role notes retain English followed by Chinese regardless of UI language", () => {
  const reviewer = { ...choice, provider: "demo-review", model: "demo-review-model", family: "anthropic" };
  const english = buildRolePreview(discovery, choice, reviewer, "en").profiles;
  const chinese = buildRolePreview(discovery, choice, reviewer, "zh-CN").profiles;
  assert.equal(english.length, 6);
  assert.equal(english[0].name, "Leader");
  assert.equal(chinese[0].name, "\u8d1f\u8d23\u4eba");
  const roles = ["supervisor", "executor", "reviewer", "reader", "decision", "batch"] as const;
  assert.deepEqual(english.map(profile => profile.role), roles);
  for (const [index, role] of roles.entries()) {
    const profile = english[index];
    const source = tIn("en", `onboarding.notes.${role}`);
    const translation = tIn("zh-CN", `onboarding.notes.${role}`);
    assert.ok(profile.notes.startsWith(source));
    assert.ok(profile.notes.endsWith(translation));
    assert.notEqual(source, translation);
    assert.equal(profile.notes, chinese[index].notes);
  }
});

test("timeout and errors produce fixed statuses without leaking diagnostics", async () => {
  const slow = host();
  slow.providers.waitForReady = () => new Promise(() => {});
  assert.deepEqual(await discoverRoles(slow, 10), { status: "timeout", providers: [] });
  const broken = host();
  broken.providers.waitForReady = async () => { throw new Error("Demo sensitive diagnostic"); };
  assert.deepEqual(await discoverRoles(broken), { status: "unknown", providers: [] });
  const partial = host();
  partial.providers.listAvailable = async () => ({ providers: [], error: "Demo sensitive diagnostic" } as never);
  assert.deepEqual(await discoverRoles(partial), { status: "unknown", providers: [] });
});

test("preview distinguishes timed-out and unknown discovery from a removed model", async () => {
  const slow = host();
  slow.providers.waitForReady = () => new Promise(() => {});
  assert.deepEqual(await previewRoles(slow, { executor: choice, language: "en" }), {
    status: "unavailable", issue: "timeout", review: "manual", profiles: [],
  });
  const broken = host();
  broken.providers.waitForReady = async () => { throw new Error("Demo sensitive diagnostic"); };
  assert.deepEqual(await previewRoles(broken, { executor: choice, language: "en" }), {
    status: "unavailable", issue: "unknown", review: "manual", profiles: [],
  });
  const removed = await previewRoles(host(), { executor: { ...choice, model: "demo-removed" }, language: "en" });
  assert.equal(removed.issue, "capability");
});

test("whole-array replacement counterexample: preview never submits generated-only profiles", async () => {
  const existing = [{ id: "demo-existing", name: "Demo existing", provider: "demo-provider", custom: { keep: true } }];
  const stored = { agentProfiles: structuredClone(existing), other: { keep: true } };
  const replacingHost = { patch: (patch: { agentProfiles: unknown[] }) => { stored.agentProfiles = patch.agentProfiles as typeof existing; } };
  const preview = await previewRoles(host(), { executor: choice, language: "en" });
  assert.deepEqual(stored.agentProfiles, existing);
  replacingHost.patch({ agentProfiles: preview.profiles });
  assert.ok(!stored.agentProfiles.some(row => row.id === "demo-existing"));
  // Demonstrate why a future writer must re-read and retain the complete array. This is not a production writer.
  replacingHost.patch({ agentProfiles: [...existing, ...preview.profiles] });
  assert.deepEqual(stored.agentProfiles[0], existing[0]);
  assert.deepEqual(stored.other, { keep: true });
});

test("RPC and disk adapters project only profiles and preserve dispatch extensions", () => {
  const agentProfiles = [{ id: "demo-profile", name: "Demo", provider: "demo-primary", model: "demo-model", role: "executor", family: "openai", pool: "demo-pool", dispatchId: "demo-dispatch" }];
  const rpc = { agentProfiles, get providers(): never { throw new Error("Credential field accessed"); }, get env(): never { throw new Error("Environment accessed"); } };
  const result = profilesFromRpcConfig(rpc);
  assert.deepEqual(result, profilesFromConfig({ daemon: { agentProfiles } }));
  assert.equal(result?.[0].dispatchId, "demo-dispatch");
  assert.equal(profilesFromConfig(rpc), null);
  assert.equal(profilesFromRpcConfig({}), null);
});
