import { displayProfileName } from "./dispatch";
import { t } from "./i18n";
import { fmtUsd, fmtWhen } from "./quota-plans-view";
import type { Period, Tokens } from "./usage";

/** Period chip labels. Getters, so each read is in the current language. */
export const PERIOD_LABEL: Readonly<Record<Period, string>> = {
  get today() { return t("quota.page.period.today"); },
  get "7d"() { return t("quota.page.period.7d"); },
  get "30d"() { return t("quota.page.period.30d"); },
};

const WAITING_MS = 3_000;
const SCANNING_MS = 5_000;
const SETTLED_MS = 60_000;

export function usageRefetchMs(data: { cursorLink?: { state: string }; scanning: boolean; scannedAt: string | null } | undefined): number {
  if (data?.cursorLink?.state === "waiting") return WAITING_MS;
  if (!data || data.scanning || !data.scannedAt) return SCANNING_MS;
  return SETTLED_MS;
}

export function periodSpendLabel(period: Period): string {
  return t("quota.page.periodSpend", { period: PERIOD_LABEL[period] });
}

export function tokenLine(tokens: Tokens, fmt: (n: number) => string): string {
  const parts = [
    t("quota.page.tokens.input", { n: fmt(tokens.input) }),
    t("quota.page.tokens.cacheRead", { n: fmt(tokens.cacheRead) }),
    t("quota.page.tokens.cacheWrite", { n: fmt(tokens.cacheWrite) }),
    t("quota.page.tokens.output", { n: fmt(tokens.output) }),
    t("quota.page.tokens.calls", { n: fmt(tokens.calls) }),
  ];
  return parts.join(" · ");
}

export function planFeeSentence(planUsd: number, apiUsd: number): string {
  const ratio = planUsd > 0 ? apiUsd / planUsd : null;
  const extra = ratio !== null ? t("quota.page.planFeeRatio", { ratio: ratio.toFixed(1) }) : "";
  return t("quota.page.planFee", { usd: fmtUsd(planUsd), extra });
}

export function axisMax(values: readonly number[]): number {
  return Math.max(1, ...values);
}

export function sharePct(value: number, max: number): number {
  return (value / max) * 100;
}

export function quotaPageCompanies<T extends { couponLine?: string; couponPlan?: string | null }>(
  companies: readonly T[],
  reason: (line: string) => string,
): T[] {
  return companies.map((company) => ({
    ...company,
    couponLine: company.couponLine ? reason(company.couponLine) : company.couponLine,
    couponPlan: company.couponPlan ? reason(company.couponPlan) : company.couponPlan,
  }));
}

export function tierDispatchLine(row: { tier: string; profile: string | null; poolLabel: string | null; cards: number | null }): string {
  if (!row.profile) return t("quota.page.tierNoProfile", { tier: row.tier });
  const who = `${displayProfileName(row.profile)} · ${row.poolLabel ?? ""}`;
  const cards = row.cards === null ? t("quota.plans.notEnoughData") : t("quota.page.aboutCards", { cards: row.cards.toFixed(1) });
  return `${row.tier} · ${who} · ${cards}`;
}

export function effortCostLine(
  row: { profile: string; effort: string; runs: number; usageSamples?: number; avgTokens: number | null; avgUsd: number | null },
  fmt: (n: number) => string,
): string {
  const avg = row.usageSamples === 0 ? t("quota.page.noUsageData")
    : row.avgTokens === null ? t("quota.plans.notEnoughData")
      : t("quota.page.avgCost", { tokens: fmt(row.avgTokens), usd: fmtUsd(row.avgUsd) });
  const missing = row.usageSamples !== undefined && row.usageSamples > 0 && row.usageSamples < row.runs
    ? ` · ${t("quota.page.missingUsage", { runs: row.runs - row.usageSamples })}` : "";
  return t("quota.page.effortCost", { profile: displayProfileName(row.profile), effort: row.effort, runs: row.runs, avg }) + missing;
}

export function modelMeta(plan: string, tokens: string, unpriced: boolean): string {
  return `${plan} · ${tokens}${unpriced ? t("quota.page.unpriced") : ""}`;
}

export function pricesFootnote(pricesAt: string | null): string {
  const when = pricesAt ? t("quota.page.pricesUpdated", { when: fmtWhen(pricesAt) }) : "";
  return t("quota.page.pricesFootnote", { when });
}
