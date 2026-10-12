import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { describe, test } from "node:test";
import { exportPath, exportsDir, paseoHome, pluginDataDir } from "../paths";
import { PLUGIN_IDS } from "../../../shared/contract/schema";

const HOME = "/home/demo";

describe("paths", () => {
  test("defaults to ~/.paseo/plugin-data/<id>", () => {
    assert.equal(paseoHome({}, HOME), join(HOME, ".paseo"));
    assert.equal(pluginDataDir(PLUGIN_IDS.cockpit, {}, HOME), join(HOME, ".paseo/plugin-data/paseo-kanban/fleet"));
    assert.equal(pluginDataDir(PLUGIN_IDS.kanban, {}, HOME), join(HOME, ".paseo/plugin-data/paseo-kanban"));
  });

  test("PASEO_HOME moves both plugins", () => {
    const env = { PASEO_HOME: "/srv/paseo-demo" };
    assert.equal(exportsDir(PLUGIN_IDS.cockpit, env, HOME), "/srv/paseo-demo/plugin-data/paseo-kanban/exports/fleet");
    assert.equal(exportsDir(PLUGIN_IDS.kanban, env, HOME), "/srv/paseo-demo/plugin-data/paseo-kanban/exports");
  });

  test("AFC_DATA_DIR is rejected before either storage namespace is selected", () => {
    const env = { PASEO_HOME: "/srv/paseo-demo", AFC_DATA_DIR: "/data/afc-demo" };
    assert.throws(() => pluginDataDir(PLUGIN_IDS.cockpit, env, HOME), /AFC_DATA_DIR/);
    assert.throws(() => pluginDataDir(PLUGIN_IDS.kanban, env, HOME), /AFC_DATA_DIR/);
  });

  test("KANBAN_DATA_DIR selects both namespaces", () => {
    const env = { KANBAN_DATA_DIR: "/data/kanban-demo" };
    assert.equal(pluginDataDir(PLUGIN_IDS.kanban, env, HOME), "/data/kanban-demo");
    assert.equal(pluginDataDir(PLUGIN_IDS.cockpit, env, HOME), "/data/kanban-demo/fleet");
  });

  test("blank overrides are ignored, ~ and relative paths are expanded", () => {
    assert.equal(paseoHome({ PASEO_HOME: "  " }, HOME), join(HOME, ".paseo"));
    assert.equal(pluginDataDir(PLUGIN_IDS.cockpit, { KANBAN_DATA_DIR: "~/afc" }, HOME), join(HOME, "afc", "fleet"));
    assert.equal(paseoHome({ PASEO_HOME: "~" }, HOME), HOME);
    assert.equal(pluginDataDir(PLUGIN_IDS.kanban, { KANBAN_DATA_DIR: "rel/kanban" }, HOME), resolve("rel/kanban"));
  });

  test("each export lives under its producer", () => {
    const env = { KANBAN_DATA_DIR: "/data/kanban-demo" };
    assert.equal(exportPath("poolStatus", env, HOME), "/data/kanban-demo/exports/fleet/pool-status.json");
    assert.equal(exportPath("dispatchMatrix", env, HOME), "/data/kanban-demo/exports/fleet/dispatch-matrix.json");
    assert.equal(exportPath("cockpit", env, HOME), "/data/kanban-demo/exports/fleet/cockpit.json");
    assert.equal(exportPath("decisionsOpen", env, HOME), "/data/kanban-demo/exports/fleet/decisions-open.json");
    assert.equal(exportPath("kanban", env, HOME), "/data/kanban-demo/exports/kanban.json");
    assert.equal(exportPath("boardSummary", env, HOME), "/data/kanban-demo/exports/board-summary.json");
  });

  test("defaults use the real home directory when none is passed", () => {
    assert.ok(paseoHome({}).endsWith(".paseo"));
  });
});
