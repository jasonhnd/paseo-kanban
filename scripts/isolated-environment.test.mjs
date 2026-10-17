import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { executable, isolatedEnvironment, testHostConfig } from "./isolated-environment.mjs";

test("test environments reject inherited identities, provider routes, Python and personal state roots", () => {
  const root = mkdtempSync(join(tmpdir(), "isolated-env-"));
  try {
    const env = isolatedEnvironment(root, { sourceEnv: {
      PATH: process.env.PATH, HOME: "/personal", PASEO_HOME: "/personal/paseo", PASEO_URL: "http://personal",
      PASEO_AGENT_ID: "personal-agent", KANBAN_DATA_DIR: "/personal/data", ROLES_STATE_DIR: "/personal/roles",
      GH_TOKEN: "artificial", NODE_OPTIONS: "--require personal", FLEET_PRIVATE_DENYLIST: "/personal/list",
    } });
    for (const key of ["HOME", "PASEO_HOME", "KANBAN_DATA_DIR", "TMPDIR", "FLEET_PRIVATE_DENYLIST"]) assert.ok(env[key].startsWith(root + "/"), key);
    for (const key of ["PASEO_URL", "PASEO_AGENT_ID", "GH_TOKEN", "NODE_OPTIONS", "ROLES_STATE_DIR", "AFC_DATA_DIR", "AFC_LEGACY_DATA_DIR"]) assert.equal(env[key], undefined, key);
    for (const name of ["python", "python3", "paseo", "claude", "codex", "grok", "gh"]) assert.throws(() => executable(name, env.PATH), /unavailable/);
    assert.equal(executable("node", env.PATH), join(root, "tools/node"));
    assert.equal(executable("lsof", env.PATH), join(root, "tools/lsof"));
    assert.equal(env.PASEO_VOICE_MODE_ENABLED, "0");
    assert.equal(env.PASEO_DICTATION_ENABLED, "0");
    assert.equal(env.npm_config_cache, join(homedir(), ".kanban-cache", "npm"));
    assert.equal(env.npm_config_cache.startsWith(root + "/"), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("speech stays off unless a host asks, and the npm cache override stays outside the card", () => {
  const root = mkdtempSync(join(tmpdir(), "isolated-env-"));
  try {
    const sourceEnv = {
      PATH: process.env.PATH, HOME: "/personal",
      PASEO_VOICE_MODE_ENABLED: "1", PASEO_DICTATION_ENABLED: "1",
      KANBAN_SHARED_NPM_CACHE: join(root, "not-the-default"),
    };
    const forced = isolatedEnvironment(root, { sourceEnv });
    assert.equal(forced.PASEO_VOICE_MODE_ENABLED, "0");
    assert.equal(forced.PASEO_DICTATION_ENABLED, "0");
    assert.equal(forced.npm_config_cache, join(root, "not-the-default"));
    const voiced = isolatedEnvironment(join(root, "voiced"), { voice: true, sourceEnv: { PATH: process.env.PATH } });
    assert.equal(voiced.PASEO_VOICE_MODE_ENABLED, "1");
    assert.equal(voiced.PASEO_DICTATION_ENABLED, "1");
    const host = testHostConfig({ daemon: { listen: "127.0.0.1:9" } });
    assert.equal(host.features.voiceMode.enabled, false);
    assert.equal(host.features.dictation.enabled, false);
    assert.equal(host.daemon.listen, "127.0.0.1:9");
    const opened = testHostConfig({ features: { voiceMode: { enabled: true }, dictation: { enabled: true } } });
    assert.equal(opened.features.voiceMode.enabled, true);
    assert.equal(opened.features.dictation.enabled, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
