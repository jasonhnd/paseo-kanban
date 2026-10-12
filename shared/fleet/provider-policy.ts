// Provider exclusions are opt-in; an empty config allows every provider.
import { hiddenPlanTerms, textHidden } from "./hidden-plans";
import { PROVIDER_COMPANIES } from "./quota-adapters";

/** Normalized provider or company terms from afc.config.json. */
export function bannedProviderTerms(raw: unknown): string[] {
  const list = raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as { bannedProviders?: unknown }).bannedProviders : undefined;
  return hiddenPlanTerms({ hiddenPlans: list });
}

export interface ProviderSubject {
  name?: unknown;
  id?: unknown;
  label?: unknown;
  provider?: unknown;
  usageProvider?: unknown;
  providers?: unknown;
  model?: unknown;
  pool?: unknown;
  family?: unknown;
  company?: unknown;
}

/** Case-insensitive substring matching for profiles, plans, models and historical labels. */
export function providerBanned(subject: ProviderSubject | string, terms: readonly string[] = []): boolean {
  if (terms.length === 0) return false;
  if (typeof subject === "string") return matches(subject, terms);
  const fields = [subject.name, subject.id, subject.label, subject.provider, subject.usageProvider,
    subject.model, subject.pool, subject.family, subject.company,
    ...(Array.isArray(subject.providers) ? subject.providers : [])];
  return matches(fields.filter((value): value is string => typeof value === "string").join(" "), terms);
}

function matches(text: string, terms: readonly string[]): boolean {
  const hay = text.toLowerCase();
  const companies = Object.entries(PROVIDER_COMPANIES)
    .filter(([provider]) => hay.includes(provider)).map(([, company]) => company).join(" ");
  return textHidden(`${text} ${companies}`, terms);
}
