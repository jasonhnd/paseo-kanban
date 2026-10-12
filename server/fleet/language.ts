/// <reference types="node" />
// The server's language, decided once at start: AFC_LANGUAGE, else `language` in afc.config.json
// ("system", "en" or "zh-CN"). An explicit en or zh-CN wins. Missing or invalid means system
// (LC_ALL, LC_MESSAGES, LANG, then the runtime locale; C and POSIX are not languages).
// Direct file edits take a plugin reload; settings RPC saves update the process language immediately.
// One small synchronous file read at start; the settings request path uses asynchronous reads.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isLanguageSetting, type Language, type LanguageSetting, languageOverride, resolveLanguage, setLanguage } from "../../shared/fleet/i18n";
import { AFC_CONFIG_FILE } from "./adapters/config";
import { STATE_DIR } from "./util";

/** Pure: the `language` field of a parsed afc.config.json; `system` when missing or not a known setting. */
export function languageSetting(raw: unknown): LanguageSetting {
  const value = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as { language?: unknown }).language : undefined;
  return isLanguageSetting(value) ? value : "system";
}

function readSetting(dir: string): LanguageSetting {
  try {
    return languageSetting(JSON.parse(readFileSync(join(dir, AFC_CONFIG_FILE), "utf8")));
  } catch {
    return "system";
  }
}

/** Decide the language for this process and make t() use it. Returns the language. */
export function initLanguage(dir: string = STATE_DIR, env: NodeJS.ProcessEnv = process.env): Language {
  const lang = languageOverride(env) ?? resolveLanguage(readSetting(dir), env);
  setLanguage(lang);
  return lang;
}
