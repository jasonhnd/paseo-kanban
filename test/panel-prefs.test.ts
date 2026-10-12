/// <reference types="node" />
import { zhCNPart, localePattern } from "./helpers/locale";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { DEFAULT_PANEL_PREFS, fontSizes, parsePanelPrefs } from "../shared/panel-prefs";
import { PanelPrefsError, panelPrefsSidecar, readPanelPrefs, savePanelPrefs, updatePanelPrefs } from "../server/panel-prefs";

const dirs: string[] = [];

function useDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "kanban-panel-prefs-"));
  dirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("panel prefs file", () => {
  it("drops the retired color mode while keeping other unknown fields on save", async () => {
    const path = join(useDir(), "panel-prefs.json");
    writeFileSync(
      path,
      JSON.stringify({ fontStep: "lg", colorMode: "dark", extra: { a: 1 }, note: "keep" }, null, 2),
    );
    const saved = await updatePanelPrefs({ fontStep: "sm" }, path);
    assert.deepEqual(saved, { fontStep: "sm" });
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    assert.equal(raw.fontStep, "sm");
    assert.equal(raw.colorMode, undefined);
    assert.deepEqual(raw.extra, { a: 1 });
    assert.equal(raw.note, "keep");
    assert.equal(readdirSync(join(path, "..")).some((name) => name.endsWith(".tmp")), false);
    const first = panelPrefsSidecar(path, "tmp", 4242);
    const second = panelPrefsSidecar(path, "tmp", 4242);
    assert.match(first, /\.4242\.\d+\.tmp$/);
    assert.notEqual(first, second);
    assert.match(panelPrefsSidecar(path, "bak", process.pid), new RegExp(`\\.${process.pid}\\.\\d+\\.bak$`));
  });

  it("tells the caller and keeps a backup when the prefs file is broken", async () => {
    const dir = useDir();
    const path = join(dir, "panel-prefs.json");
    const broken = "{";
    writeFileSync(path, broken);
    await assert.rejects(updatePanelPrefs({ fontStep: "lg" }, path), (err: unknown) => {
      assert.ok(err instanceof PanelPrefsError);
      assert.match(err.message, new RegExp(localePattern(zhCNPart("panelPrefs.brokenNoBackup", 0, 11))));
      assert.match(err.message, new RegExp(localePattern(zhCNPart("compactEvents.dryRun.noBackups", 6, 8))));
      return true;
    });
    assert.equal(readFileSync(path, "utf8"), broken);
    const backups = readdirSync(dir).filter((name) => name.includes(`.${process.pid}.`) && name.endsWith(".bak"));
    assert.equal(backups.length, 1);
    assert.equal(readFileSync(join(dir, backups[0] ?? ""), "utf8"), broken);
    const saved = await savePanelPrefs({ fontStep: "lg" }, path);
    assert.deepEqual({ fontStep: saved.fontStep }, DEFAULT_PANEL_PREFS);
    assert.match(saved.notice ?? "", new RegExp(localePattern(zhCNPart("panelPrefs.brokenNoBackup", 0, 6))));
    assert.equal(readFileSync(path, "utf8"), broken);
    assert.equal(readdirSync(dir).filter((name) => name.endsWith(".bak")).length, 2);
  });

  it("does not replace a broken file and reads it as defaults", async () => {
    const dir = useDir();
    const path = join(dir, "panel-prefs.json");
    writeFileSync(path, "[]");
    const arrayBytes = readFileSync(path);
    await assert.rejects(updatePanelPrefs({ fontStep: "lg" }, path), PanelPrefsError);
    assert.deepEqual(readFileSync(path), arrayBytes);

    writeFileSync(path, "null");
    const nullBytes = readFileSync(path);
    assert.deepEqual(await readPanelPrefs(path), DEFAULT_PANEL_PREFS);
    assert.deepEqual(readFileSync(path), nullBytes);
  });

  it("uses defaults when the file is missing and creates it only on write", async () => {
    const dir = useDir();
    const missing = join(dir, "missing.json");
    assert.equal(existsSync(missing), false);
    assert.deepEqual(await readPanelPrefs(missing), { fontStep: "md" });
    assert.equal(existsSync(missing), false);

    const created = join(dir, "nested", "panel-prefs.json");
    const next = await updatePanelPrefs({ fontStep: "md" }, created);
    assert.deepEqual(next, { fontStep: "md" });
    assert.deepEqual(JSON.parse(readFileSync(created, "utf8")), { fontStep: "md" });
  });

  it("treats a field outside the three choices as the default without rewriting on read", () => {
    const raw = { fontStep: "huge", colorMode: "blue", extra: true };
    assert.deepEqual(parsePanelPrefs(raw), DEFAULT_PANEL_PREFS);
    assert.deepEqual(parsePanelPrefs(null), DEFAULT_PANEL_PREFS);
    assert.equal(raw.fontStep, "huge");
  });
});

describe("font scale", () => {
  it("matches the EX desktop and phone tables", () => {
    assert.equal(fontSizes("sm", false).body, 16);
    assert.equal(fontSizes("md", false).body, 18);
    assert.equal(fontSizes("lg", false).title, 40);
    assert.equal(fontSizes("sm", true).small, 13);
    assert.equal(fontSizes("md", true).h2, 20);
    assert.equal(fontSizes("lg", true).small, 16);
    assert.equal(fontSizes("lg", true).body, 20);
  });
});
