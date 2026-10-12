// MCP tool descriptions: shared/locales/<language>/tools.json. These are the agents' operating manual,
// so the English text is written for agents, not translated word by word; both files carry the same
// rules, prohibitions, parameter formats and examples.
import enTools from "../shared/locales/en/tools.json";
import zhTools from "../shared/locales/zh-CN/tools.json";
import { getLanguage, type Language } from "../shared/i18n";

export type ToolTextKey = keyof typeof enTools;

const TOOL_TEXT: Readonly<Record<Language, Readonly<Record<string, string>>>> = { en: enTools, "zh-CN": zhTools };

/** One description in the current (or given) language; English when the language lacks it. */
export function toolText(key: ToolTextKey, language: Language = getLanguage()): string {
  return TOOL_TEXT[language][key] ?? enTools[key];
}

export function toolTextKeys(language: Language): string[] {
  return Object.keys(TOOL_TEXT[language]);
}
