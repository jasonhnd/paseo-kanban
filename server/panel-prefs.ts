/// <reference types="node" />
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { t } from "../shared/i18n";
import { dirname, join } from "node:path";
import { dataDir } from "./paths";
import {
  DEFAULT_BOARD_TAB,
  isBoardTab,
  type BoardTab,
  DEFAULT_PANEL_PREFS,
  parsePanelPrefs,
  type FontStep,
  type PanelPrefs,
} from "../shared/panel-prefs";

const PANEL_PREFS_FILE = "panel-prefs.json";

/** Preferences owned by the board always stay in its data directory. */
export function panelPrefsPath(): string {
  return join(dataDir(), PANEL_PREFS_FILE);
}

export class PanelPrefsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PanelPrefsError";
  }
}

let prefsWriteSeq = 0;

/** Temp and backup names include the pid so two processes do not write the same sidecar. */
export function panelPrefsSidecar(path: string, suffix: "tmp" | "bak", pid = process.pid): string {
  return `${path}.${pid}.${++prefsWriteSeq}.${suffix}`;
}

type RawPrefs =
  | { kind: "missing" }
  | { kind: "bad" }
  | { kind: "ok"; value: Record<string, unknown> };

async function loadRaw(path: string): Promise<RawPrefs> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { kind: "missing" };
    return { kind: "bad" };
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { kind: "bad" };
    return { kind: "ok", value: parsed as Record<string, unknown> };
  } catch {
    return { kind: "bad" };
  }
}

async function writeJsonAtomic(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = panelPrefsSidecar(path, "tmp");
  try {
    await writeFile(tmp, JSON.stringify(data, null, 2));
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

/** Missing or unreadable files return defaults and are left untouched. */
export async function readPanelPrefs(path?: string): Promise<PanelPrefs> {
  if (path === undefined) {
    path = panelPrefsPath();
  }
  const raw = await loadRaw(path);
  if (raw.kind !== "ok") return { ...DEFAULT_PANEL_PREFS };
  return parsePanelPrefs(raw.value);
}

async function backupBroken(path: string): Promise<never> {
  let backup = "";
  try {
    backup = panelPrefsSidecar(path, "bak");
    await copyFile(path, backup);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    throw new PanelPrefsError(t("panelPrefs.brokenNoBackup", { why }));
  }
  throw new PanelPrefsError(t("panelPrefs.brokenBackedUp", { backup }));
}

/**
 * Patches fontStep and keeps every other field already in the file.
 * A missing file is created. A broken file is left in place; a copy is kept beside it.
 */
export async function updatePanelPrefs(
  patch: { fontStep?: FontStep },
  path?: string,
): Promise<PanelPrefs> {
  if (path === undefined) {
    path = panelPrefsPath();
  }
  const raw = await loadRaw(path);
  if (raw.kind === "bad") return backupBroken(path);
  const obj = raw.kind === "ok" ? raw.value : {};
  const current = parsePanelPrefs(obj);
  const next: PanelPrefs = {
    fontStep: patch.fontStep ?? current.fontStep,
  };
  const { colorMode: _retired, ...otherFields } = obj;
  await writeJsonAtomic(path, { ...otherFields, ...next });
  return next;
}

export interface PanelPrefsResult extends PanelPrefs {
  notice: string | null;
}

/** Read result for the panel. A broken file still yields defaults and does not announce itself. */
export async function loadPanelPrefs(path?: string): Promise<PanelPrefsResult> {
  return { ...(await readPanelPrefs(path)), notice: null };
}

/** Save result for the panel. A broken file is not replaced; `notice` is the one sentence to show. */
export async function savePanelPrefs(
  patch: { fontStep?: FontStep },
  path?: string,
): Promise<PanelPrefsResult> {
  try {
    return { ...(await updatePanelPrefs(patch, path)), notice: null };
  } catch (err) {
    if (err instanceof PanelPrefsError) return { ...DEFAULT_PANEL_PREFS, notice: err.message };
    throw err;
  }
}

/** The board's last tab is stored separately from its font preferences. */
export function boardTabPath(): string {
  return join(dataDir(), "kanban-board-tab.json");
}


/** The tab the board last showed. Unknown or missing values mean the default tab. */
export async function readBoardTab(path?: string): Promise<BoardTab> {
  if (path === undefined) {
    path = boardTabPath();
  }
  const raw = await loadRaw(path);
  if (raw.kind !== "ok") return DEFAULT_BOARD_TAB;
  return isBoardTab(raw.value.boardTab) ? raw.value.boardTab : DEFAULT_BOARD_TAB;
}

/** Writes only `boardTab`, atomically. A broken file is replaced: it holds nothing else. */
export async function saveBoardTab(tab: BoardTab, path?: string): Promise<BoardTab> {
  if (path === undefined) {
    path = boardTabPath();
  }
  await writeJsonAtomic(path, { boardTab: tab });
  return tab;
}
