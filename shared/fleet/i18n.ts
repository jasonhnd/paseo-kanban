// Interface text in two languages. English (shared/locales/en.json) is the source; shared/locales/zh-CN.json is the second
// language and has exactly the same keys (server/test/i18n.test.ts checks it).
//
// Keys are flat (`board.refresh`); values may hold `{name}` placeholders filled from `vars`.
// The language is one module-level value per process: the server sets it once at start from afc.config.json
// (server/language.ts), the panel sets it from the panel-prefs reply. Until then it follows the system locale.
// Never call t() at module top level: the language may not be decided yet when the module loads.
import { currentLanguage, selectLanguage, languageWasChosen, namespaceText } from "../common/i18n";
import en from "../locales/en/fleet.json";
import zhCN from "../locales/zh-CN/fleet.json";

export const LANGUAGES = ["en", "zh-CN"] as const;
export type Language = (typeof LANGUAGES)[number];
/** What afc.config.json may say: a language, or `system` to follow the operating system. */
export const LANGUAGE_SETTINGS = ["system", ...LANGUAGES] as const;
export type LanguageSetting = (typeof LANGUAGE_SETTINGS)[number];
export const DEFAULT_LANGUAGE: Language = "en";
/** Overrides the configured language for one process (tests, one-off CLI runs). */
export const LANGUAGE_ENV = "AFC_LANGUAGE";

export type MessageKey = keyof typeof en;
export type MessageVars = Readonly<Record<string, string | number>>;

const CATALOGS: Record<Language, Readonly<Record<string, string>>> = { en, "zh-CN": zhCN };


export function isLanguage(value: unknown): value is Language {
  return typeof value === "string" && (LANGUAGES as readonly string[]).includes(value);
}

export function isLanguageSetting(value: unknown): value is LanguageSetting {
  return value === "system" || isLanguage(value);
}

/** A locale tag such as `zh_CN.UTF-8`, `zh-Hans-CN` or `en-US` to a supported language; null when unknown. */
export function languageFromLocale(locale: string | null | undefined): Language | null {
  const tag = (locale ?? "").trim().toLowerCase().replace(/_/g, "-");
  if (!tag || tag === "c" || tag.startsWith("c.") || tag === "posix") return null;
  if (tag.startsWith("zh")) return "zh-CN";
  if (tag.startsWith("en")) return "en";
  return null;
}

type Env = Readonly<Record<string, string | undefined>>;

/** Environment of this process, or empty in the panel (no `process` there). No node: import. */
function processEnv(): Env {
  const proc = (globalThis as { process?: { env?: Env } }).process;
  return proc?.env ?? {};
}

/** The operating system's language: LC_ALL, LC_MESSAGES, LANG, then the JS runtime's locale; else English. */
export function systemLanguage(env: Env = processEnv(), runtimeLocale: () => string | undefined = intlLocale): Language {
  for (const name of ["LC_ALL", "LC_MESSAGES", "LANG"]) {
    const value = env[name];
    if (!value) continue;
    const lang = languageFromLocale(value);
    if (lang) return lang;
  }
  return languageFromLocale(runtimeLocale()) ?? DEFAULT_LANGUAGE;
}

function intlLocale(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    return undefined;
  }
}

/**
 * A setting to a concrete language. An explicit `en` or `zh-CN` wins.
 * `system`, a missing setting, or any other value follows the operating system
 * (`LC_ALL`, `LC_MESSAGES`, `LANG`, then the runtime locale). `C` and `POSIX` are not languages.
 */
export function resolveLanguage(setting: unknown, env: Env = processEnv()): Language {
  return isLanguage(setting) ? setting : systemLanguage(env);
}

/** The process override (AFC_LANGUAGE), when it names a supported language. */
export function languageOverride(env: Env = processEnv()): Language | null {
  const value = env[LANGUAGE_ENV]?.trim();
  return isLanguage(value) ? value : null;
}

export function setLanguage(lang: Language): void {
  selectLanguage(lang);
}

/** The language t() uses now. Before anyone sets it: AFC_LANGUAGE, else the system language. */
export function language(): Language {
  if (!languageWasChosen()) selectLanguage(languageOverride() ?? systemLanguage());
  return currentLanguage();
}

function fill(template: string, vars: MessageVars | undefined): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => (name in vars ? String(vars[name]) : whole));
}

/** Text for `key` in a given language; English when that language lacks it; the key itself when nobody has it. */
export function tIn(lang: Language, key: MessageKey, vars?: MessageVars): string {
  const template = namespaceText("fleet", lang, key);
  return fill(template, vars);
}

/** Text for `key` in the current language. */
export function t(key: MessageKey, vars?: MessageVars): string {
  return tIn(language(), key, vars);
}

/**
 * The same text in every language, for reading data an older or other-language install wrote
 * (for example a note prefix): match any of them. Distinct values only.
 */
export function tAll(key: MessageKey, vars?: MessageVars): string[] {
  return [...new Set(LANGUAGES.map((lang) => tIn(lang, key, vars)))];
}

/** Every key of a catalog, for the parity test. */
export function catalogKeys(lang: Language): string[] {
  return Object.keys(CATALOGS[lang]);
}
