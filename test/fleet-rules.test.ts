/// <reference types="node" />
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_BANNED, DEFAULT_FAMILIES, familyRuleFor, isBannedProfile, parseBanned, parseFamilies } from "../server/fleet-rules";
import { familyDispatchBlock, fastNotAllowed, modelNotAllowed } from "../server/routing";
import { staleEntry, staleStopPct, type PoolSnapshot } from "../server/pools";
import type { Profile } from "../server/profiles";

const fresh: PoolSnapshot = {
  state: "fresh",
  message: "",
  generatedAt: null,
  dispatchable: () => true,
  entry: () => ({ dispatchable: true, deprioritize: false, prefer: false, resetsAt: null, reason: null, usedPct: null, onlyRoles: null }),
  hasPool: () => true,
};

function profile(fields: Partial<Profile>): Profile {
  return { id: "p", name: "Example", provider: "example", model: "example-1", ...fields } as Profile;
}

describe("family rules from kanban.config.json", () => {
  it("ships no provider bans or family limits when fields are missing", () => {
    assert.deepEqual(parseFamilies(undefined), DEFAULT_FAMILIES);
    assert.deepEqual(parseBanned(undefined), DEFAULT_BANNED);
    assert.deepEqual(DEFAULT_FAMILIES, {});
    for (const value of Object.values(DEFAULT_BANNED)) assert.deepEqual(value, []);
    assert.equal(isBannedProfile(profile({ provider: "antigravity", family: "google", model: "gemini" }), parseBanned(undefined)), false);
    assert.equal(familyDispatchBlock(profile({ provider: "codex", family: "openai", model: "gpt-5", featureValues: { fast_mode: true } }), "ultra", fresh, parseFamilies(undefined)), null);
  });

  it("replaces the built-in rules when the field is present", () => {
    const families = parseFamilies({ acme: { providers: ["acme-cli"], modelPrefixes: ["acme-2"], noFast: true } });
    assert.deepEqual(Object.keys(families), ["acme"]);
    assert.equal(families.acme.noUltra, false);
    assert.deepEqual(parseFamilies({}), {}, "an empty object turns every family rule off");
  });

  it("finds a rule by family, then by provider", () => {
    const families = parseFamilies({ acme: { providers: ["acme-cli"] } });
    assert.ok(familyRuleFor(profile({ family: "acme" }), families));
    assert.ok(familyRuleFor(profile({ provider: "acme-cli" }), families));
    assert.equal(familyRuleFor(profile({ provider: "other" }), families), null);
  });

  it("applies a configured family's model and fast limits", () => {
    const families = parseFamilies({ acme: { providers: ["acme-cli"], modelPrefixes: ["acme-2"], noFast: true } });
    assert.equal(familyDispatchBlock(profile({ provider: "acme-cli", model: "acme-1" }), null, fresh, families), modelNotAllowed());
    assert.equal(familyDispatchBlock(profile({ provider: "acme-cli", model: "acme-2-pro", featureValues: { fast_mode: true } }), null, fresh, families), fastNotAllowed());
    assert.equal(familyDispatchBlock(profile({ provider: "acme-cli", model: "acme-2-pro" }), "ultra", fresh, families), null);
    assert.equal(familyDispatchBlock(profile({ provider: "codex", model: "gpt-5" }), null, fresh, families), null, "only explicitly configured family rules apply");
  });
});

describe("banned profiles from kanban.config.json", () => {
  it("matches provider, family, pool, and name or model text", () => {
    const banned = parseBanned({ providers: ["acme-cli"], families: ["acme"], pools: ["acme-pool"], models: ["Turbo"] });
    assert.equal(isBannedProfile(profile({ provider: "acme-cli" }), banned), true);
    assert.equal(isBannedProfile(profile({ family: "acme" }), banned), true);
    assert.equal(isBannedProfile(profile({ pool: "acme-pool" }), banned), true);
    assert.equal(isBannedProfile(profile({ name: "Example turbo" }), banned), true);
    assert.equal(isBannedProfile(profile({ model: "x-turbo-1" }), banned), true);
    assert.equal(isBannedProfile(profile({}), banned), false);
    assert.equal(isBannedProfile(profile({ provider: "antigravity" }), parseBanned({})), false, "an empty object bans nothing");
  });
});

describe("stale stop lines from kanban.config.json", () => {
  it("uses the configured line, then 97", () => {
    const stops = { "pool-a": 60 };
    assert.equal(staleStopPct("pool-a", stops), 60);
    assert.equal(staleStopPct("pool-b", stops), 97);
    const entry = fresh.entry("pool-a");
    assert.equal(staleEntry("pool-a", { ...entry, usedPct: 61 }, stops).dispatchable, false);
    assert.equal(staleEntry("pool-b", { ...entry, usedPct: 61 }, stops).dispatchable, true);
  });
});
