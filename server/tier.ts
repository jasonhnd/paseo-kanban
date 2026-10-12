/// <reference types="node" />
import { t } from "../shared/i18n";
import { isEffort, type Effort } from "./effort";
import { KanbanError } from "./errors";

export const TIERS = ["L1", "L2", "L3", "L4"] as const;
export type Tier = (typeof TIERS)[number];

export function isTier(value: string): value is Tier {
  return (TIERS as readonly string[]).includes(value);
}

/**
 * Empty means the card does not store a tier.
 * Anything else that is not L1–L4 is rejected with an error.
 */
export function parseTier(value: unknown): Tier | null {
  if (value == null) return null;
  if (typeof value !== "string") throw new KanbanError("invalid", t("tier.invalidType"));
  const text = value.trim();
  if (!text) return null;
  if (!isTier(text)) throw new KanbanError("invalid", t("tier.invalidValue", { value: text }));
  return text;
}

/** One step down. `low` cannot go lower. */
export function downgradeEffort(effort: Effort): Effort | null {
  const order: Effort[] = ["low", "medium", "high", "xhigh", "max"];
  const index = order.indexOf(effort);
  if (index <= 0) return null;
  return order[index - 1] ?? null;
}

/**
 * The tier a start actually uses.
 * A stored tier wins. Otherwise a high-risk tag is L4.
 * Otherwise the matrix default, or L2 when there is no usable matrix.
 */
export function resolveTier(stored: string | null | undefined, tags: readonly string[], defaultTier: Tier | null): Tier {
  if (stored && isTier(stored)) return stored;
  if (tags.includes("high-risk")) return "L4";
  return defaultTier ?? "L2";
}

export function isEffortValue(value: string | null | undefined): value is Effort {
  return Boolean(value && isEffort(value));
}
