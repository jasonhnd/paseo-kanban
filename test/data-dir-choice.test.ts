import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { chooseDataDir, defaultPluginDataDir, describeDataDir, registeredPluginPath, PLUGIN_ID } from "../server/paths";
import { checkDataDir, DATA_DIR_FINDING_ID } from "../server/doctor-config";
import type { DoctorFinding } from "../server/doctor";

const root = mkdtempSync(join(tmpdir(), "data-dir-choice-"));
after(() => rmSync(root, { recursive: true, force: true }));

let seq = 0;
/** A fake home with a Paseo home under it and a plugin checkout beside it. */
function fixture(boards: { legacy?: boolean; fresh?: boolean }) {
  const home = join(root, `home-${++seq}`);
  const plugin = join(home, "src", "kanban-plugin");
  const env: NodeJS.ProcessEnv = {};
  const fresh = defaultPluginDataDir(env, home);
  const legacy = join(plugin, "data");
  for (const [wanted, dir] of [[boards.legacy, legacy], [boards.fresh, fresh]] as const) {
    if (!wanted) continue;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "kanban.db"), "");
  }
  return { home, plugin, env, fresh, legacy };
}

describe("data directory choice at startup", () => {
  it("ignores legacy data beside the plugin without probing it", () => {
    const f = fixture({ legacy: true });
    const choice = chooseDataDir({ env: f.env, home: f.home, pluginRoot: f.plugin, exists: existsSync });
    assert.equal(choice.dir, f.fresh);
    assert.equal(choice.source, "plugin-data");
    assert.doesNotMatch(describeDataDir(choice), /not migrated/);
  });

  it("uses plugin-data when only it has a board", () => {
    const f = fixture({ fresh: true });
    const choice = chooseDataDir({ env: f.env, home: f.home, pluginRoot: f.plugin, exists: existsSync });
    assert.equal(choice.dir, f.fresh);
    assert.equal(choice.source, "plugin-data");
    assert.equal(f.fresh, join(f.home, ".paseo", "plugin-data", "paseo-kanban"));
  });

  it("prefers plugin-data when both have a board", () => {
    const f = fixture({ legacy: true, fresh: true });
    const choice = chooseDataDir({ env: f.env, home: f.home, pluginRoot: f.plugin, exists: existsSync });
    assert.equal(choice.dir, f.fresh);
    assert.equal(choice.source, "plugin-data");
  });

  it("starts a new board in plugin-data when neither has one", () => {
    const f = fixture({});
    const choice = chooseDataDir({ env: f.env, home: f.home, pluginRoot: f.plugin, exists: existsSync });
    assert.equal(choice.dir, f.fresh);
    assert.equal(choice.source, "plugin-data");
  });

  it("KANBAN_DATA_DIR overrides both", () => {
    const f = fixture({ legacy: true, fresh: true });
    const override = join(root, "override");
    const choice = chooseDataDir({ env: { KANBAN_DATA_DIR: override }, home: f.home, pluginRoot: f.plugin, exists: existsSync });
    assert.deepEqual([choice.dir, choice.source], [override, "env"]);
  });

  it("PASEO_HOME moves the plugin-data directory", () => {
    const f = fixture({});
    const paseo = join(root, "paseo-home");
    const choice = chooseDataDir({ env: { PASEO_HOME: paseo }, home: f.home, pluginRoot: f.plugin, exists: existsSync });
    assert.equal(choice.dir, join(paseo, "plugin-data", PLUGIN_ID));
  });
});

describe("registered plugin path", () => {
  it("reads plugins[<id>].path from Paseo's config", () => {
    const config = join(root, "paseo-config.json");
    writeFileSync(config, JSON.stringify({ plugins: { [PLUGIN_ID]: { source: "directory", path: "/opt/example/kanban", enabled: true } } }));
    assert.equal(registeredPluginPath(PLUGIN_ID, { KANBAN_PASEO_CONFIG: config }), "/opt/example/kanban");
  });

  it("is null when the config is missing, broken, or does not list the plugin", () => {
    const broken = join(root, "broken-config.json");
    writeFileSync(broken, "{");
    const other = join(root, "other-config.json");
    writeFileSync(other, JSON.stringify({ plugins: { "some-other-plugin": { path: "/opt/example/other" } } }));
    assert.equal(registeredPluginPath(PLUGIN_ID, { KANBAN_PASEO_CONFIG: join(root, "missing.json") }), null);
    assert.equal(registeredPluginPath(PLUGIN_ID, { KANBAN_PASEO_CONFIG: broken }), null);
    assert.equal(registeredPluginPath(PLUGIN_ID, { KANBAN_PASEO_CONFIG: other }), null);
  });
});

describe("doctor on the data directory", () => {
  it("does not report a migration of uninspected legacy files", () => {
    const legacy = fixture({ legacy: true });
    const found: DoctorFinding[] = [];
    checkDataDir((finding) => found.push(finding), chooseDataDir({ env: legacy.env, home: legacy.home, pluginRoot: legacy.plugin, exists: existsSync }));
    assert.deepEqual(found, []);
    const migrated = fixture({ legacy: true, fresh: true });
    const none: DoctorFinding[] = [];
    checkDataDir((finding) => none.push(finding), chooseDataDir({ env: migrated.env, home: migrated.home, pluginRoot: migrated.plugin, exists: existsSync }));
    assert.deepEqual(none, []);
  });
});
