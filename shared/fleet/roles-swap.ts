// Steps of the swap form on the Roles page, kept free of React so tests can cover them.
import { t } from "./i18n";
import { companyName, pickableCompanies, pickableModels, type PickableModel } from "./roles-policy";
import type { RoleCardView, RoleRowView } from "./roles-page";
import { actualModel } from "./review-model";

export interface SwapChoice {
  company: string | null;
  provider: string | null;
  modelId: string | null;
  thinking: string | null;
}

export const EMPTY_CHOICE: SwapChoice = { company: null, provider: null, modelId: null, thinking: null };

export function specText(provider: string, model: string, thinking: string | null): string {
  return thinking ? t("roles.swap.specThinking", { provider, model, thinking }) : t("roles.swap.spec", { provider, model });
}

export function currentSpec(row: Pick<RoleRowView, "provider" | "model" | "thinking">): string {
  return specText(row.provider, row.model, row.thinking);
}

/** Starting point when the swap form opens: the row's own company, so only the model has to change. */
export function initialChoice(row: Pick<RoleRowView, "company">, models: readonly PickableModel[]): SwapChoice {
  return pickableCompanies(models).includes(row.company as never) ? pickCompany(row.company) : EMPTY_CHOICE;
}

export function modelsOf<T extends PickableModel>(models: readonly T[], company: string | null): T[] {
  return pickableModels(models).filter((model) => companyName(model.provider, model.id) === company);
}

export function chosenModel<T extends PickableModel>(models: readonly T[], choice: SwapChoice): T | null {
  return modelsOf(models, choice.company).find((model) => model.provider === choice.provider && model.id === choice.modelId) ?? null;
}

export function pickCompany(company: string): SwapChoice {
  return { company, provider: null, modelId: null, thinking: null };
}

/** A new model keeps the old thinking level when the new model offers it. */
export function pickModel(choice: SwapChoice, model: PickableModel): SwapChoice {
  const keep = choice.thinking && model.thinking.some((level) => level === choice.thinking) ? choice.thinking : null;
  return { company: companyName(model.provider, model.id), provider: model.provider, modelId: model.id, thinking: keep };
}

/** Ready to confirm: a model is picked, and a thinking level too when the model offers some. */
export function choiceReady(model: PickableModel | null, choice: SwapChoice): boolean {
  if (!model) return false;
  const levels = pickableModels([model])[0]?.thinking ?? [];
  return levels.length === 0 || (choice.thinking !== null && levels.includes(choice.thinking));
}

export function sameAsCurrent(row: Pick<RoleRowView, "provider" | "model" | "thinking">, choice: SwapChoice): boolean {
  return row.provider === choice.provider && row.model === choice.modelId && (row.thinking ?? null) === choice.thinking;
}

export function confirmText(rowName: string, row: Pick<RoleRowView, "provider" | "model" | "thinking">, choice: SwapChoice): string {
  return t("roles.swap.confirm", { name: rowName, from: currentSpec(row), to: specText(choice.provider ?? "", choice.modelId ?? "", choice.thinking) });
}

export function diffLines(result: { before: string | null; after: string | null }): string[] {
  return [result.before ? t("roles.swap.before", { spec: result.before }) : "", result.after ? t("roles.swap.after", { spec: result.after }) : ""].filter(Boolean);
}

const OPPOSITE_ROLE: Record<string, string> = { executor: "reviewer", reviewer: "executor" };

/**
 * Warnings shown before confirming: after the swap, would this profile (main or candidate) share a model with any
 * profile of the opposite role (executor vs reviewer), candidates included? Maker and checker must differ.
 */
export function modelConflicts(cards: readonly RoleCardView[], roleKey: string, profile: string, newModel: string): string[] {
  const opposite = OPPOSITE_ROLE[roleKey];
  if (!opposite) return [];
  const mine = cards.find((card) => card.key === roleKey)?.rows.find((row) => row.profile === profile);
  if (!mine) return [];
  const model = actualModel(newModel);
  if (!model) return [t("roles.swap.modelMissing")];
  const others = cards.find((card) => card.key === opposite)?.rows ?? [];
  return others
    .filter((row) => actualModel(row.model) === model)
    .map((row) => t("roles.swap.modelConflict", {
      name: mine.name,
      model,
      opposite: t(opposite === "reviewer" ? "roles.swap.reviewer" : "roles.swap.executor"),
      other: row.name,
    }));
}

/** Display name from the cached model list (insights), or the raw id while the list is not there yet. */
export function modelLabel(models: ReadonlyArray<{ provider: string; id: string; label: string }> | undefined, provider: string, id: string): string {
  return models?.find((model) => model.provider === provider && model.id === id)?.label || id;
}
