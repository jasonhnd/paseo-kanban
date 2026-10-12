import boardEn from "../locales/en.json";
import boardZh from "../locales/zh-CN.json";
import fleetEn from "../locales/en/fleet.json";
import fleetZh from "../locales/zh-CN/fleet.json";

export type Language = "en" | "zh-CN";
let selected: Language = "en";
let chosen = false;
const listeners = new Set<() => void>();
export const currentLanguage = () => selected;
export const languageWasChosen = () => chosen;
export function selectLanguage(value: Language): void {
  chosen = true;
  if (selected === value) return;
  selected = value;
  for (const listener of listeners) listener();
}
export function subscribeLanguage(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
const prefix = (namespace: string, messages: Record<string, string>) => Object.fromEntries(Object.entries(messages).map(([key,value]) => [`${namespace}.${key}`, value]));
const catalogs = {
  en: { ...prefix("board", boardEn), ...prefix("fleet", fleetEn) },
  "zh-CN": { ...prefix("board", boardZh), ...prefix("fleet", fleetZh) },
};
export function namespaceText(namespace: "board" | "fleet", language: Language, key: string): string {
  const name = `${namespace}.${key}`;
  return catalogs[language][name] ?? catalogs.en[name] ?? key;
}
