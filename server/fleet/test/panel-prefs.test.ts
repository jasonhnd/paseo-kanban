import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readPanelPrefs, updatePanelPrefs } from "../panel-prefs";
import { DEFAULT_PANEL_PREFS, panelPrefsRpc, parsePanelPrefs } from "../../../shared/fleet/panel-prefs";
import { INITIAL_PREFS_VIEW, prefsReducer, resolvePrefs } from "../../../shared/fleet/panel-prefs-state";

test("retired color modes are ignored on read and removed on font or tab saves without losing unknown fields", async () => {
  const dir = await mkdtemp(join(tmpdir(), "panel-prefs-"));
  const path = join(dir, "panel-prefs.json");
  try {
    for (const colorMode of ["dark", "light", "paseo", "invalid", { obsolete: true }]) {
      const legacy = { fontStep: "sm", tab: "overview", colorMode, other: { keep: [1, "unchanged"] } };
      await writeFile(path, JSON.stringify(legacy));
      assert.deepEqual(await readPanelPrefs(path), { fontStep: "sm", tab: "overview" });
      assert.deepEqual(JSON.parse(await readFile(path, "utf8")), legacy, "Reading must not rewrite the file");
      assert.deepEqual(await updatePanelPrefs({ fontStep: "lg" }, path), { fontStep: "lg", tab: "overview" });
      assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { fontStep: "lg", tab: "overview", other: legacy.other });
      await writeFile(path, JSON.stringify(legacy));
      await updatePanelPrefs({ tab: "leader" }, path);
      assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { fontStep: "sm", tab: "leader", other: legacy.other });
    }
    await Promise.all([updatePanelPrefs({ fontStep: "md" }, path), updatePanelPrefs({ tab: "quota" }, path)]);
    assert.deepEqual(await readPanelPrefs(path), { fontStep: "md", tab: "quota" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("RPC and local appearance state expose only font and tab preferences", () => {
  assert.deepEqual(parsePanelPrefs({ colorMode: "invalid" }), DEFAULT_PANEL_PREFS);
  assert.deepEqual(panelPrefsRpc.input.parse({ colorMode: "invalid", fontStep: "lg" }), { fontStep: "lg" });
  assert.deepEqual(panelPrefsRpc.output.parse({ ...DEFAULT_PANEL_PREFS, colorMode: "dark" }), DEFAULT_PANEL_PREFS);
  const edited = prefsReducer(INITIAL_PREFS_VIEW, { type: "set-appearance", patch: { fontStep: "lg" }, base: DEFAULT_PANEL_PREFS });
  const saved = prefsReducer(edited, { type: "saved", saved: { fontStep: "sm", colorMode: "dark" } });
  assert.deepEqual(saved.appearance, { fontStep: "sm" });
  assert.deepEqual(resolvePrefs(saved, DEFAULT_PANEL_PREFS), { fontStep: "sm", tab: "overview" });
});
