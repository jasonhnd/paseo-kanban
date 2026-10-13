import type { PluginClientContext, PluginCommandCenterItemContribution, PluginWorkspacePanelContribution } from "@getpaseo/plugin/client";
import { getLanguage, isLanguage, type Language } from "../shared/i18n";
import { readWebStorage, writeWebStorage } from "./web";

// The workspace panel's title is fixed when it is registered, before the board's language setting can be
// read. So the client remembers the language it last read, registers with that, and registers the panel
// again (same id, new title) once kanban.config.read answers with a different language.

const STORAGE_KEY = "paseo-kanban.language";

interface Registration {
  cleanup: () => void;
  language: Language;
  add: () => () => void;
}

let registration: Registration | null = null;

/** The language the board's setting resolved to last time on this client, where the client can store it. */
export function rememberedLanguage(): Language | null {
  const value = readWebStorage(STORAGE_KEY);
  return isLanguage(value) ? value : null;
}

function remember(language: Language): void {
  writeWebStorage(STORAGE_KEY, language);
}

/** Register the workspace panel; `build` makes the contribution in the current language. */
export function registerBoardPanel(client: PluginClientContext, buildPanel: () => PluginWorkspacePanelContribution, buildCommand?: () => PluginCommandCenterItemContribution): void {
  registration?.cleanup();
  const add = () => {
    const removePanel = client.addWorkspacePanel(buildPanel());
    const removeCommand = buildCommand ? client.addCommandCenterItem(buildCommand()) : undefined;
    return () => { removePanel(); removeCommand?.(); };
  };
  // Both titles are fixed host registrations, so update and unload them together.
  registration = { cleanup: add(), language: getLanguage(), add };
}

/** The board's setting has been read: remember it and re-register the panel when its title is in another language. */
export function adoptPanelLanguage(language: Language): void {
  remember(language);
  if (!registration || registration.language === language) return;
  registration.cleanup();
  registration = { ...registration, cleanup: registration.add(), language };
}

/** Forget the registration (the plugin unloaded). */
export function resetBoardPanel(): void {
  registration?.cleanup();
  registration = null;
}
