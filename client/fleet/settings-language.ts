import { isLanguage, setLanguage, type Language } from "../../shared/fleet/i18n";

export const SETTINGS_LANGUAGE_KEY = "agent-fleet-cockpit.language";
type Storage = { getItem(key: string): string | null; setItem(key: string, value: string): void };
function storage(): Storage | null {
  try {
    const candidate = (globalThis as { localStorage?: Storage }).localStorage;
    return candidate && typeof candidate.getItem === "function" ? candidate : null;
  } catch { return null; }
}
/** Use the last resolved configuration language when registering a host title. */
export function rememberedLanguage(): Language | null {
  try {
    const value = storage()?.getItem(SETTINGS_LANGUAGE_KEY);
    return isLanguage(value) ? value : null;
  } catch { return null; }
}
/** Body labels update now; the host title uses this language on its next registration. */
export function adoptSettingsLanguage(language: Language): void {
  setLanguage(language);
  try { storage()?.setItem(SETTINGS_LANGUAGE_KEY, language); }
  catch { /* Storage may be unavailable; body labels still update. */ }
}
