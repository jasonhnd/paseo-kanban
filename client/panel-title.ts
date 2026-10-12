import type { PluginClientContext, PluginWorkspacePanelContribution } from "@getpaseo/plugin/client";
import { getLanguage, isLanguage, type Language } from "../shared/i18n";

// The workspace panel's title is fixed when it is registered, before the board's language setting can be
// read. So the client remembers the language it last read, registers with that, and registers the panel
// again (same id, new title) once kanban.config.read answers with a different language.

const STORAGE_KEY = "paseo-kanban.language";

interface Registration {
  client: PluginClientContext;
  build: () => PluginWorkspacePanelContribution;
  cleanup: () => void;
  language: Language;
}

let registration: Registration | null = null;

function storage(): { getItem(key: string): string | null; setItem(key: string, value: string): void } | null {
  try {
    const candidate = (globalThis as { localStorage?: unknown }).localStorage as
      | { getItem(key: string): string | null; setItem(key: string, value: string): void }
      | undefined;
    return candidate && typeof candidate.getItem === "function" ? candidate : null;
  } catch {
    return null; // storage disabled
  }
}

/** The language the board's setting resolved to last time on this client, where the client can store it. */
export function rememberedLanguage(): Language | null {
  try {
    const value = storage()?.getItem(STORAGE_KEY);
    return isLanguage(value) ? value : null;
  } catch {
    return null;
  }
}

function remember(language: Language): void {
  try {
    storage()?.setItem(STORAGE_KEY, language);
  } catch {
    // not storable here; the next load guesses again
  }
}

/** Register the workspace panel; `build` makes the contribution in the current language. */
export function registerBoardPanel(client: PluginClientContext, build: () => PluginWorkspacePanelContribution): void {
  registration?.cleanup();
  registration = { client, build, cleanup: client.addWorkspacePanel(build()), language: getLanguage() };
}

/** The board's setting has been read: remember it and re-register the panel when its title is in another language. */
export function adoptPanelLanguage(language: Language): void {
  remember(language);
  if (!registration || registration.language === language) return;
  registration.cleanup();
  registration = { ...registration, cleanup: registration.client.addWorkspacePanel(registration.build()), language };
}

/** Forget the registration (the plugin unloaded). */
export function resetBoardPanel(): void {
  registration?.cleanup();
  registration = null;
}
