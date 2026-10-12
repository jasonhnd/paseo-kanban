import assert from "node:assert/strict";
import { test } from "node:test";
import { profilesFromRpcConfig, profilesFromText, selectProfile } from "../server/profiles";
import { translate } from "../shared/i18n";
import en from "../shared/locales/en.json";
import zhCN from "../shared/locales/zh-CN.json";

test("RPC profile projection retains extensions without touching unrelated keys", () => {
  const agentProfiles = [{ id: "demo-executor", name: "Demo executor", role: "executor", provider: "demo-provider", model: "demo-model", family: "demo-family", pool: "demo-pool", featureValues: { demo: true }, future: { preserved: true } }];
  const rpc = { agentProfiles, get env(): never { throw new Error("Environment accessed"); }, get providers(): never { throw new Error("Credentials accessed"); } };
  assert.deepEqual(profilesFromRpcConfig(rpc), profilesFromText(JSON.stringify({ daemon: { agentProfiles } })));
  assert.throws(() => profilesFromRpcConfig({}));
  assert.deepEqual(profilesFromRpcConfig({ agentProfiles: [] }), []);
});

test("preview text describes both proposals and the L4 limit in both languages", () => {
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zhCN).sort());
  assert.match(translate("en", "reviewPreview.optionA"), /human review/);
  assert.match(translate("en", "reviewPreview.optionB"), /not enabled/);
  assert.match(translate("en", "reviewPreview.l4"), /cannot automatically approve/);
  assert.match(translate("zh-CN", "reviewPreview.optionB"), /\u5c1a\u672a\u542f\u7528/);
});

test("preview does not enable same-family review routing", () => {
  const profile = { id: "demo-reviewer", name: "Demo reviewer", provider: "demo-provider", model: "demo-model", role: "reviewer", family: "demo-family" };
  assert.equal(selectProfile([profile], { role: "reviewer", review: true, executorFamily: "demo-family", executorProfile: "demo-executor" }).ok, false);
});
