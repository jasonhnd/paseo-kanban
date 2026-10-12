export { complexDocsProfileName, highRiskProfileName } from "./dispatch-policy";
import { translate, type MessageKey, type MessageVars } from "../../shared/i18n";

/** Explicit Chinese expectations do not depend on the process language. */
export const zhCN = (key: MessageKey, vars?: MessageVars): string => translate("zh-CN", key, vars);

/** Partial-message assertions retain the same scope as their original text match. */
export const zhCNPart = (key: MessageKey, start: number, end?: number): string => zhCN(key).slice(start, end);

/** Catalog text is literal when combined with a test's regular-expression syntax. */
export const localePattern = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
