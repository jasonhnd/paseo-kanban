import { isLanguage, setLanguage, type Language } from "../../shared/fleet/i18n";
import { readWebStorage, writeWebStorage } from "../web";

export const SETTINGS_LANGUAGE_KEY = "agent-fleet-cockpit.language";
/** Use the last resolved configuration language when registering a host title. */
export function rememberedLanguage(): Language | null {
  const value = readWebStorage(SETTINGS_LANGUAGE_KEY);
  return isLanguage(value) ? value : null;
}
/** Body labels update now; the host title uses this language on its next registration. */
export function adoptSettingsLanguage(language: Language): void {
  setLanguage(language);
  writeWebStorage(SETTINGS_LANGUAGE_KEY, language);
}
