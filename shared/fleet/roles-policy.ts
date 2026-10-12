import { providerBanned } from "./provider-policy";
// Model policy and configurable provider exclusions for the Roles page.
// The client filters its lists with these; the server checks again; bin/roles checks a third time.
import { t } from "./i18n";
import { CURSOR_PROVIDER, PROVIDER_COMPANIES } from "./quota-adapters";


/** Stable display order for known companies; other configured providers follow it. */
export const COMPANIES = ["Anthropic", "OpenAI", "xAI"] as const;
/** Shown on Cursor rows and given as the reason a swap to cursor/* is refused. bin/roles uses the same key. */
export function cursorNotUsed(): string {
  return t("roles.policy.cursorNotUsed");
}
export type Company = string;

export interface PickableModel {
  provider: string;
  id: string;
  label?: string;
  thinking: readonly string[];
}


/** Company that makes the model. Through Cursor the model id says which one; unknown ids are Cursor's own. */
export function companyName(provider: string, model: string, family?: string | null): string {
  if (provider === "claude") return "Anthropic";
  if (provider === "codex") return "OpenAI";
  if (provider === "grok") return "xAI";
  const id = model.toLowerCase();
  if (id.includes("claude")) return "Anthropic";
  if (id.includes("gpt")) return "OpenAI";
  if (id.includes("grok")) return "xAI";
  if (family === "anthropic") return "Anthropic";
  if (family === "openai") return "OpenAI";
  if (family === "xai") return "xAI";
  if (provider === CURSOR_PROVIDER) return "Cursor";
  const company = family || PROVIDER_COMPANIES[provider] || provider;
  return company ? company[0].toUpperCase() + company.slice(1) : t("roles.policy.unknownProvider");
}

/** Label for a model chip: how it is reached when that is not the company's own provider. */
export function routeSuffix(provider: string): string {
  return provider === CURSOR_PROVIDER ? t("roles.policy.viaCursor") : "";
}

/** A reason this provider/model/thinking combination is never allowed, or null. */
export function swapRefusal(provider: string, model: string, thinking: string | null | undefined, bannedProviders: readonly string[] = []): string | null {
  if (providerBanned({ provider, model, company: companyName(provider, model) }, bannedProviders)) return t("roles.policy.refuseBannedProvider", { provider });
  if (!provider.trim()) return t("roles.policy.refuseProvider", { provider: provider || t("roles.policy.unknownProvider") });
  return null;
}

/** Models the picker may show, filtered only by configured provider exclusions. */
export function pickableModels<T extends PickableModel>(models: readonly T[], bannedProviders: readonly string[] = []): T[] {
  const out: T[] = [];
  for (const model of models) {
    if (swapRefusal(model.provider, model.id, null, bannedProviders)) continue;
    out.push({ ...model, thinking: [...model.thinking] });
  }
  return out;
}

/** Companies that still have at least one pickable model, in COMPANIES order. */
export function pickableCompanies(models: readonly PickableModel[], bannedProviders: readonly string[] = []): Company[] {
  const have = new Set(pickableModels(models, bannedProviders).map((model) => companyName(model.provider, model.id)));
  return [...COMPANIES.filter((company) => have.has(company)), ...[...have].filter((company) => !(COMPANIES as readonly string[]).includes(company))];
}
