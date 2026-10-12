/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  parsePanelPrefs,
  type FontStep,
  type PanelPrefs,
} from "../../shared/fleet/panel-prefs";
import { logSwallowed, STATE_DIR, writeJson } from "./util";
import type { PanelTab } from "../../shared/fleet/panel-tabs";

/**
 * Next to the other AFC state files. The plugin server is bundled, so a path
 * beside the source file is not available at runtime. This file is outside the repo.
 */
export const PANEL_PREFS_PATH = join(STATE_DIR, "panel-prefs.json");

async function readRawPrefs(path: string): Promise<Record<string, unknown>> {
  try {
    const raw: unknown = JSON.parse(await readFile(path, "utf8"));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") logSwallowed("panel-prefs read", error);
    return {};
  }
}

export async function readPanelPrefs(path = PANEL_PREFS_PATH): Promise<PanelPrefs> {
  return parsePanelPrefs(await readRawPrefs(path));
}

const writes = new Map<string, Promise<PanelPrefs>>();

/** Serialize patches, preserving unknown fields except the retired color mode. */
export async function updatePanelPrefs(
  patch: { fontStep?: FontStep; tab?: PanelTab },
  path = PANEL_PREFS_PATH,
): Promise<PanelPrefs> {
  const pending = (writes.get(path) ?? Promise.resolve()).catch(() => { /* the earlier writer already reported its own failure to its caller */ }).then(async () => {
    const raw = await readRawPrefs(path);
    const current = parsePanelPrefs(raw);
    const next: PanelPrefs = {
      fontStep: patch.fontStep ?? current.fontStep,
      tab: patch.tab ?? current.tab,
    };
    const { colorMode: _retired, ...otherFields } = raw;
    await writeJson(path, { ...otherFields, ...next });
    return next;
  });
  writes.set(path, pending);
  try {
    return await pending;
  } finally {
    if (writes.get(path) === pending) writes.delete(path);
  }
}
