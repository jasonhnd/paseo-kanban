/// <reference types="node" />
// The server's language. Decided once when the plugin loads (index.server.ts) and when the command
// line starts (server/cli.ts, server/local-decisions.ts):
//   1. KANBAN_LANGUAGE in the environment, when it names a language or "system";
//   2. otherwise `language` in kanban.config.json. A file without the field predates the setting and
//      stays in Chinese (LEGACY_LANGUAGE); a fresh installation writes "system" (FRESH_LANGUAGE);
//   3. "system" reads LC_ALL, LC_MESSAGES, then LANG; a locale that names no shipped language gives English.
import { isLanguageSetting, resolveLanguage, setLanguage, type Language, type LanguageSetting } from "../shared/i18n";
import { LEGACY_LANGUAGE, loadConfigForReport, type KanbanConfig } from "./config";

/** The operating system locales, most specific first, as POSIX orders them. */
export function systemLocales(env: NodeJS.ProcessEnv = process.env): string[] {
  return [env.LC_ALL, env.LC_MESSAGES, env.LANG].filter((value): value is string => typeof value === "string" && value.trim() !== "");
}

/** The setting in force: the environment override, else the config file's. */
export function languageSetting(config: Pick<KanbanConfig, "language">, env: NodeJS.ProcessEnv = process.env): LanguageSetting {
  const override = env.KANBAN_LANGUAGE?.trim();
  return isLanguageSetting(override) ? override : (config.language ?? LEGACY_LANGUAGE);
}

/** The language a setting resolves to on this machine. */
export function serverLanguage(config: Pick<KanbanConfig, "language">, env: NodeJS.ProcessEnv = process.env): Language {
  return resolveLanguage(languageSetting(config, env), systemLocales(env));
}

/**
 * Read the config (never throwing because of it: a broken file is reported elsewhere) and make its
 * language the process language. Returns the language chosen.
 */
export function applyServerLanguage(env: NodeJS.ProcessEnv = process.env, config: Pick<KanbanConfig, "language"> = loadConfigForReport()): Language {
  const language = serverLanguage(config, env);
  setLanguage(language);
  return language;
}
