/// <reference types="node" />
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { boardTabPath, panelPrefsPath, readBoardTab, readPanelPrefs, saveBoardTab, savePanelPrefs } from "../server/panel-prefs";

const keys = ["KANBAN_DATA_DIR", "AFC_DATA_DIR", "AFC_LEGACY_DATA_DIR", "ROLES_STATE_DIR", "KANBAN_PASEO_CONFIG"] as const;
let saved: Record<string, string | undefined>;
let root: string;
let cockpit: string;

beforeEach(() => {
  saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  root = mkdtempSync(join(tmpdir(), "prefs-location-"));
  cockpit = join(root, "cockpit");
  process.env.KANBAN_DATA_DIR = join(root, "board");
  delete process.env.AFC_DATA_DIR;
  process.env.KANBAN_PASEO_CONFIG = join(root, "no-config.json");
  delete process.env.AFC_LEGACY_DATA_DIR;
  delete process.env.ROLES_STATE_DIR;
});

afterEach(() => {
  for (const key of keys) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

function legacyFiles(dir = cockpit): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "panel-prefs.json"), JSON.stringify({ fontStep: "lg", colorMode: "dark", extra: true }));
  writeFileSync(join(dir, "kanban-board-tab.json"), JSON.stringify({ boardTab: "projects" }));
}

function snapshot(dir: string): Record<string, string> {
  return Object.fromEntries(readdirSync(dir).sort().map(name => [name, readFileSync(join(dir, name), "utf8")]));
}

describe("board-owned preference locations", () => {
  it("saves and reads preferences with no cockpit installed and never creates its directory", async () => {
    assert.equal(dirname(panelPrefsPath()), process.env.KANBAN_DATA_DIR);
    assert.equal(dirname(boardTabPath()), process.env.KANBAN_DATA_DIR);
    assert.equal(await readBoardTab(), "overview");
    assert.deepEqual(await readPanelPrefs(), { fontStep: "md" });
    await savePanelPrefs({ fontStep: "sm" });
    await saveBoardTab("attention");
    assert.deepEqual(await readPanelPrefs(), { fontStep: "sm" });
    assert.equal(await readBoardTab(), "attention");
    assert.equal(existsSync(cockpit), false);
  });

  it("does not import old Fleet preferences; user bytes remain intact", async () => {
    legacyFiles();
    const before = snapshot(cockpit);
    assert.deepEqual(await readPanelPrefs(), { fontStep: "md" });
    assert.equal(await readBoardTab(), "overview");
    assert.equal(existsSync(panelPrefsPath()), false);
    assert.equal(existsSync(boardTabPath()), false);
    await savePanelPrefs({ fontStep: "sm" });
    await saveBoardTab("settings");
    assert.deepEqual(snapshot(cockpit), before);
    legacyFiles();
    assert.deepEqual(await readPanelPrefs(), { fontStep: "sm" });
    assert.equal(await readBoardTab(), "settings");
    assert.deepEqual(readdirSync(dirname(boardTabPath())).sort(), ["kanban-board-tab.json", "panel-prefs.json"]);
  });

  it("retired overrides refuse a first save without touching either directory", async () => {
    const roles = join(root, "roles");
    process.env.ROLES_STATE_DIR = roles;
    legacyFiles(roles);
    const before = snapshot(roles);
    await assert.rejects(savePanelPrefs({ fontStep: "sm" }), /ROLES_STATE_DIR/);
    await assert.rejects(saveBoardTab("decisions"), /ROLES_STATE_DIR/);
    assert.equal(existsSync(join(process.env.KANBAN_DATA_DIR!, "panel-prefs.json")), false);
    assert.deepEqual(snapshot(roles), before);
    assert.equal(existsSync(cockpit), false);
  });

  it("does not discover an old sibling file beside a registered cockpit plugin", async () => {
    const legacy = join(root, "installation");
    legacyFiles(legacy);
    writeFileSync(process.env.KANBAN_PASEO_CONFIG!, JSON.stringify({ plugins: { "agent-fleet-cockpit": { path: join(legacy, "plugin") } } }));
    const before = snapshot(legacy);
    assert.equal(await readBoardTab(), "overview");
    assert.equal(existsSync(boardTabPath()), false);
    assert.deepEqual(snapshot(legacy), before);
  });

  it("preserves existing local files, even broken ones, without copying legacy files over them", async () => {
    legacyFiles();
    mkdirSync(dirname(boardTabPath()), { recursive: true });
    writeFileSync(boardTabPath(), "{");
    writeFileSync(panelPrefsPath(), "{}");
    assert.equal(await readBoardTab(), "overview");
    assert.deepEqual(await readPanelPrefs(), { fontStep: "md" });
    assert.equal(readFileSync(boardTabPath(), "utf8"), "{");
    assert.equal(readFileSync(panelPrefsPath(), "utf8"), "{}");
  });

  it("allows concurrent first reads without replacing files or leaving sidecars", async () => {
    legacyFiles();
    assert.deepEqual(await Promise.all(Array.from({ length: 8 }, () => readBoardTab())), Array(8).fill("overview"));
    assert.equal(existsSync(boardTabPath()), false);
  });
});
