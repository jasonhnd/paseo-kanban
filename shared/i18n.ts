// Translation for every user- and agent-facing string. English is the source language (shared/locales/en.json);
// shared/locales/zh-CN.json is the second language. Keys are flat (`board.column.ready`) and values may
// carry `{name}` placeholders. Logs stay in English and never go through t().
//
// The language is process-wide state. The server sets it once at startup from kanban.config.json
// (server/language.ts), the client from the `kanban.config.read` RPC (client/i18n.ts). Nothing may
// call t() while a module loads: the language is not known yet at that point.
import { currentLanguage, selectLanguage, languageWasChosen, namespaceText } from "./common/i18n";
import en from "./locales/en.json";
import zhCN from "./locales/zh-CN.json";

export const LANGUAGES = ["en", "zh-CN"] as const;
export type Language = (typeof LANGUAGES)[number];
/** What the config file may say. "system" follows the operating system's locale. */
export type LanguageSetting = Language | "system";

export const DEFAULT_LANGUAGE: Language = "en";

export type MessageKey = keyof typeof en;
export type MessageVars = Readonly<Record<string, string | number>>;

const CATALOGS: Readonly<Record<Language, Readonly<Record<string, string>>>> = { en, "zh-CN": zhCN };

let lookups = 0;

export function isLanguage(value: unknown): value is Language {
  return typeof value === "string" && (LANGUAGES as readonly string[]).includes(value);
}

export function isLanguageSetting(value: unknown): value is LanguageSetting {
  return value === "system" || isLanguage(value);
}

export function setLanguage(language: Language): void {
  selectLanguage(language);
}

/** True once something has set the language in this process; false while the default is still in force. */
export function languageChosen(): boolean {
  return languageWasChosen();
}

export function getLanguage(): Language {
  return currentLanguage();
}

/**
 * The language a locale name asks for: "zh_CN.UTF-8", "zh-Hans-CN" and "zh" give zh-CN, "en_US" gives en.
 * Null for anything else (C, POSIX, empty, or a language this plugin does not ship).
 */
export function localeLanguage(locale: string | null | undefined): Language | null {
  const name = (locale ?? "").trim().toLowerCase();
  if (/^zh([_.@-]|$)/.test(name)) return "zh-CN";
  if (/^en([_.@-]|$)/.test(name)) return "en";
  return null;
}

/** The locale the JavaScript runtime reports, or undefined where Intl is not available. */
export function runtimeLocale(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    return undefined;
  }
}

/**
 * The language to use for a setting. An explicit language wins; "system" takes the first locale that
 * names a shipped language (default: the runtime's Intl locale); anything else falls back to English.
 */
export function resolveLanguage(setting: unknown, systemLocales: ReadonlyArray<string | null | undefined> = [runtimeLocale()]): Language {
  if (isLanguage(setting)) return setting;
  if (setting === "system") {
    for (const locale of systemLocales) {
      const language = localeLanguage(locale);
      if (language) return language;
    }
  }
  return DEFAULT_LANGUAGE;
}

/** Replace `{name}` with vars.name. Placeholders without a value are left as they are. */
export function interpolate(template: string, vars?: MessageVars): string {
  if (!vars) return template;
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (whole, name: string) => (name in vars ? String(vars[name]) : whole));
}

/** The message in an explicit language. Falls back to English, then to the key itself. */
export function translate(language: Language, key: MessageKey, vars?: MessageVars): string {
  lookups += 1;
  const template = namespaceText("board", language, key);
  return interpolate(template, vars);
}

/** The message in the current language. */
export function t(key: MessageKey, vars?: MessageVars): string {
  return translate(currentLanguage(), key, vars);
}

/**
 * A language's name as that language writes it ("English", the Chinese name for zh-CN). Each catalog names
 * itself in `language.selfName`, so the English catalog never holds another script.
 */
export function languageName(language: Language): string {
  return translate(language, "language.selfName");
}

/** Every key of a catalog. Tests compare the two languages with this. */
export function catalogKeys(language: Language): string[] {
  return Object.keys(CATALOGS[language]);
}

/** How many messages were looked up in this process. A test uses it to prove no module calls t() while loading. */
export function lookupCount(): number {
  return lookups;
}
