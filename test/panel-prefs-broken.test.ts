/// <reference types="node" />
import { zhCNPart, localePattern } from "./helpers/locale";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { updatePanelPrefs } from "../server/panel-prefs";

const dirs: string[] = [];

function useDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "kanban-panel-prefs-broken-"));
  dirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("broken panel prefs", () => {
  it("reports the failure and keeps a backup when updatePanelPrefs is given a broken file", async () => {
    const dir = useDir();
    const path = join(dir, "panel-prefs.json");
    const broken = "{";
    writeFileSync(path, broken);
    let message = "";
    try {
      await updatePanelPrefs({ fontStep: "lg" }, path);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    const backups = readdirSync(dir).filter((name) => name.endsWith(".bak"));
    const backupBody = backups[0] ? readFileSync(join(dir, backups[0]), "utf8") : "";
    assert.deepEqual(
      {
        reported: new RegExp(localePattern(zhCNPart("panelPrefs.brokenNoBackup", 0, 11))).test(message) && new RegExp(localePattern(zhCNPart("compactEvents.dryRun.noBackups", 6, 8))).test(message),
        backup: backupBody === broken,
        original: readFileSync(path, "utf8") === broken,
      },
      { reported: true, backup: true, original: true },
    );
  });
});
