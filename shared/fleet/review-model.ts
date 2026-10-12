/** Compare actual model fields only; routing, company and inference settings do not identify a model. */
export function actualModel(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : null;
}

export function differentReviewModels(executor: unknown, reviewer: unknown): boolean {
  const maker = actualModel(executor);
  const checker = actualModel(reviewer);
  return maker !== null && checker !== null && maker !== checker;
}
