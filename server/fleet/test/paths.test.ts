// Data directory transition rule and plugin lookups (server/paths.ts). Every directory is a fresh temp dir.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { defaultPlugins } from "../upgrade-check";
import {
  afcBinDir,
  checkoutName,
  chooseDataDir,
  chooseKanbanDataDir,
  cursorTokenPaths,
  dataDirChoice,
  describeDataDir,
  parseDataDirLog,
  installedPluginDirs,
  kanbanProjectName,
  legacyStateDir,
  pluginInstallDir,
  rolesBin,
} from "../paths";

const roots: string[] = [];
function freshHome(): string {
  const home = mkdtempSync(join(tmpdir(), "afc-paths-test-"));
  roots.push(home);
  return home;
}
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function put(path: string, body = "{}"): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body);
}

const newDir = (home: string) => join(home, ".paseo", "plugin-data", "paseo-kanban", "fleet");

describe("data directory transition", () => {
  test("legacy files are not read or selected", () => {
    const home = freshHome();
    put(join(legacyStateDir(home), "decisions.json"), "[]");
    const choice = chooseDataDir({}, home);
    assert.equal(choice.source, "data-dir");
    assert.equal(choice.dir, newDir(home));
    assert.equal(choice.dataDir, newDir(home));
    assert.doesNotMatch(describeDataDir(choice), /not migrated/);
  });

  test("only the new directory has data: use it", () => {
    const home = freshHome();
    put(join(newDir(home), "plans.json"));
    const choice = chooseDataDir({}, home);
    assert.equal(choice.source, "data-dir");
    assert.equal(choice.dir, newDir(home));
  });

  test("both have data: the new directory wins", () => {
    const home = freshHome();
    put(join(legacyStateDir(home), "decisions.json"), "[]");
    put(join(legacyStateDir(home), "plans.json"));
    put(join(newDir(home), "decisions.json"), "[]");
    const choice = chooseDataDir({}, home);
    assert.equal(choice.source, "data-dir");
    assert.equal(choice.dir, newDir(home));
  });

  test("neither has data (fresh install): the new directory", () => {
    const home = freshHome();
    mkdirSync(legacyStateDir(home), { recursive: true });
    assert.equal(chooseDataDir({}, home).dir, newDir(home));
  });

  test("retired AFC_DATA_DIR is rejected even with legacy files", () => {
    const home = freshHome();
    put(join(legacyStateDir(home), "plans.json"));
    assert.throws(() => chooseDataDir({ AFC_DATA_DIR: join(home, "elsewhere") }, home), /AFC_DATA_DIR/);
  });

  test("PASEO_HOME moves the new directory; the legacy remains untouched", () => {
    const home = freshHome();
    const paseo = join(home, "paseo-dev");
    assert.equal(chooseDataDir({ PASEO_HOME: paseo }, home).dir, join(paseo, "plugin-data", "paseo-kanban", "fleet"));
    put(join(legacyStateDir(home), "decisions.json"), "[]");
    assert.equal(chooseDataDir({ PASEO_HOME: paseo }, home).source, "data-dir");
  });

  test("decided once per process: later files do not move it", () => {
    const home = freshHome();
    put(join(legacyStateDir(home), "decisions.json"), "[]");
    const first = dataDirChoice({}, home);
    put(join(newDir(home), "plans.json"));
    assert.equal(dataDirChoice({}, home), first);
    assert.equal(chooseDataDir({}, home).source, "data-dir");
  });

  test("the Cursor login file moves to secrets/ and keeps the legacy state/ path to read", () => {
    const home = freshHome();
    const paths = cursorTokenPaths({ KANBAN_DATA_DIR: join(home, "d") }, home);
    assert.equal(paths.current, join(home, "d", "fleet", "secrets", "cursor-token.json"));
    assert.equal(paths.legacy, join(home, "d", "fleet", "state", "cursor-token.json"));
  });
});

describe("installed plugins", () => {
  function homeWithPlugins(): { home: string; cockpit: string; kanban: string; other: string } {
    const home = freshHome();
    const cockpitCheckout = join(home, "src", "cockpit-repo");
    const cockpit = join(cockpitCheckout, "agent-fleet-cockpit");
    const kanban = join(home, "src", "kanban-repo");
    const otherCheckout = join(home, "src", "other-repo");
    const other = join(otherCheckout, "other-plugin");
    for (const dir of [join(cockpitCheckout, ".git"), cockpit, join(kanban, ".git"), join(otherCheckout, ".git"), other]) mkdirSync(dir, { recursive: true });
    put(join(home, ".paseo", "config.json"), JSON.stringify({
      plugins: {
        "agent-fleet-cockpit": { source: "directory", path: cockpit, enabled: true },
        "paseo-kanban": { source: "directory", path: kanban, enabled: true },
        "other-plugin": { source: "directory", path: other, enabled: true },
        broken: { source: "npm" },
      },
    }));
    return { home, cockpit, kanban, other };
  }

  test("install directories come from Paseo's config.json", () => {
    const { home, cockpit, kanban } = homeWithPlugins();
    assert.equal(pluginInstallDir("agent-fleet-cockpit", {}, home), cockpit);
    assert.equal(pluginInstallDir("paseo-kanban", {}, home), kanban);
    assert.equal(pluginInstallDir("missing", {}, home), null);
    assert.deepEqual(installedPluginDirs({}, home).map((row) => row.id), ["agent-fleet-cockpit", "paseo-kanban", "other-plugin"]);
  });

  test("no Paseo config: nothing is installed, roles falls back to PATH", () => {
    const home = freshHome();
    assert.equal(pluginInstallDir("paseo-kanban", {}, home), null);
    assert.equal(rolesBin({}, home, null), "roles");
  });

  test("bin/ sits beside the plugin folder in a checkout", () => {
    const { home, kanban: cockpit } = homeWithPlugins();
    assert.equal(afcBinDir({}, home, undefined, null), join(cockpit, "..", "bin"));
    assert.equal(rolesBin({}, home, null), join(cockpit, "..", "bin", "roles"));
    assert.equal(afcBinDir({ KANBAN_HOME: join(home, "pkg") }, home, undefined, null), join(home, "pkg", "..", "bin"));
  });

  test("checkout names: the nearest .git ancestor", () => {
    const { home, cockpit, kanban } = homeWithPlugins();
    assert.equal(checkoutName(cockpit), "cockpit-repo");
    assert.equal(checkoutName(kanban), "kanban-repo");
    assert.equal(kanbanProjectName({}, home), "kanban-repo");
    assert.equal(kanbanProjectName({}, freshHome()), "paseo-kanban");
  });

  test("compat checks every directory plugin, with suite labels for ours", () => {
    const { home, cockpit, kanban, other } = homeWithPlugins();
    const plugins = defaultPlugins(installedPluginDirs({}, home));
    assert.deepEqual(plugins, [
      { id: "afc", label: "AFC", dir: cockpit, cwdMatch: "cockpit-repo", project: "cockpit-repo" },
      { id: "kanban", label: "Paseo Kanban", dir: kanban, cwdMatch: "kanban-repo", project: "kanban-repo" },
      { id: "other-plugin", label: "other-plugin", dir: other, cwdMatch: "other-repo", project: "other-repo" },
    ]);
  });

  test("Kanban data: KANBAN_DATA_DIR, else plugin-data once it has a board, else <install>/data", () => {
    const { home, kanban } = homeWithPlugins();
    const pluginData = join(home, ".paseo", "plugin-data", "paseo-kanban");
    assert.equal(chooseKanbanDataDir({}, home), pluginData);
    put(join(kanban, "data", "kanban.config.json"));
    assert.equal(chooseKanbanDataDir({}, home), pluginData);
    put(join(pluginData, "kanban.db"), "");
    assert.equal(chooseKanbanDataDir({}, home), pluginData);
    assert.equal(chooseKanbanDataDir({ KANBAN_DATA_DIR: join(home, "k") }, home), join(home, "k"));
  });
});

describe("data dir log line", () => {
  test("parseDataDirLog reads back every form describeDataDir writes", () => {
    const base = { dataDir: "/demo/data", legacyDir: "/demo/legacy" };
    for (const choice of [
      { ...base, dir: "/demo/data", source: "data-dir" as const },
      { ...base, dir: "/demo/override", source: "override" as const },
      { ...base, dir: "/demo/legacy", source: "legacy" as const },
    ]) {
      assert.equal(parseDataDirLog(`[afc] ${describeDataDir(choice)}`), choice.dir, choice.source);
    }
    assert.equal(parseDataDirLog("[afc] pool refresh: something else"), null);
  });
});
