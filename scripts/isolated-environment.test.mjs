import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { executable, isolatedEnvironment } from "./isolated-environment.mjs";

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
  } finally { rmSync(root, { recursive: true, force: true }); }
});
