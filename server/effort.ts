/// <reference types="node" />
import { t } from "../shared/i18n";
import { KanbanError } from "./errors";

/** Depth names a card may force. Same ids Paseo puts on a model's thinkingOptions. */
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

export function isEffort(value: string): value is Effort {
  return (EFFORTS as readonly string[]).includes(value);
}

/**
 * Empty means the card does not force a depth.
 * Anything else that is not a known depth is rejected with an error.
 */
export function parseEffort(value: unknown): Effort | null {
  if (value == null) return null;
  if (typeof value !== "string") {
    throw new KanbanError("invalid", t("effort.invalidType"));
  }
  const text = value.trim();
  if (!text) return null;
  if (!isEffort(text)) {
    throw new KanbanError("invalid", t("effort.invalidValue", { value: text }));
  }
  return text;
}

export interface ThinkingModel {
  id: string;
  aliases?: string[];
  thinkingOptions?: Array<{ id: string }>;
}

/** True when this provider model lists `effort` as a thinking option id. */
export function modelSupportsEffort(models: ThinkingModel[] | undefined, modelId: string | undefined, effort: string): boolean {
  if (!modelId || !models) return false;
  const model = models.find((item) => item.id === modelId || (item.aliases ?? []).includes(modelId));
  const options = model?.thinkingOptions;
  if (!options || options.length === 0) return false;
  return options.some((option) => option.id === effort);
}

export function unsupportedEffortReason(profileName: string, effort: string): string {
  return t("effort.unsupported", { profile: profileName, effort });
}

/**
 * Recognize legacy quota blocks written before capability checks used holds.
 * Matches the old Chinese rows ("<profile> \u4e0d\u652f\u6301\u6df1\u5ea6 <effort>") and the English "<profile> does not support effort <effort>".
 */
export function parseUnsupportedEffort(reason: string | null): { profile: string; effort: Effort } | null {
  if (!reason) return null;
  const match = /^(.+) (?:\u4e0d\u652f\u6301\u6df1\u5ea6|does not support effort) (low|medium|high|xhigh|max)$/.exec(reason);
  if (!match?.[1] || !match[2] || !isEffort(match[2])) return null;
  return { profile: match[1], effort: match[2] };
}

/**
 * Depth to force for this start. Null means keep the profile's own thinkingOptionId.
 *
 * Only the card's own role is overridden: an executor card opens its executor at this
 * depth, a standalone review card opens its reviewer, a reader card opens its reader.
 * The review opened after an executor delivers is not the card's own role, so it is
 * unaffected and keeps the reviewer profile's depth. Rework never asks: it resumes
 * the original agent and the depth stays whatever that agent was opened with.
 */
export function effortForOwnRole(task: { effort: string | null; role: string }, review: boolean): Effort | null {
  if (!task.effort || !isEffort(task.effort)) return null;
  if (review && task.role !== "reviewer") return null;
  return task.effort;
}

export function effortReason(reason: string, effort: string | null, source: "card" | "profile" | null): string {
  if (!effort || !source) return reason;
  const note = source === "card" ? t("effort.noteCard", { effort }) : t("effort.noteProfile", { effort });
  return reason ? t("effort.withNote", { reason, note }) : note;
}

export type EffortConfirmation = "supported" | "unsupported" | "unavailable";
export function effortCatalogHold(): string {
  return t("effort.catalogHold");
}
export const EFFORT_CATALOG_TTL_MS = 5 * 60 * 1000;
const CATALOG_TIMEOUT_MS = 5000;
const catalogs = new Map<string, { models: ThinkingModel[]; at: number }>();

export function resetEffortCatalogForTests(): void {
  catalogs.clear();
}

function validCatalog(models: unknown): models is ThinkingModel[] {
  return Array.isArray(models) && models.every((model) =>
    model && typeof model.id === "string" &&
    (model.aliases === undefined || (Array.isArray(model.aliases) && model.aliases.every((alias: unknown) => typeof alias === "string"))) &&
    (model.thinkingOptions === undefined || (Array.isArray(model.thinkingOptions) && model.thinkingOptions.every((option: { id?: unknown } | null) => option && typeof option.id === "string"))));
}

/** Only a successful catalog can confirm rejection. Read failures use a recent
 * provider cache, or return unavailable so callers hold without counting a failure.
 * Cache age is measured from success and is never extended by a failed read.
 */
export async function confirmEffort(
  listModels: ((provider: string) => Promise<{ models?: ThinkingModel[]; error?: string | null }>) | undefined,
  profile: { provider: string; model?: string },
  effort: string,
  options: { now?: () => number; timeoutMs?: number } = {},
): Promise<EffortConfirmation> {
  const now = options.now ?? Date.now;
  let models: ThinkingModel[] | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (!listModels) throw new Error("model list API is not available");
    const listed = await Promise.race([
      listModels(profile.provider),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("model list read timed out")), options.timeoutMs ?? CATALOG_TIMEOUT_MS);
      }),
    ]);
    if (listed?.error) throw new Error(listed.error);
    if (!validCatalog(listed?.models)) throw new Error("model list is missing or malformed");
    models = listed.models;
    catalogs.set(profile.provider, { models: structuredClone(models), at: now() });
  } catch (err) {
    console.error("[paseo-kanban] effort catalog", err instanceof Error ? err.message : err);
    const cached = catalogs.get(profile.provider);
    const age = cached ? now() - cached.at : Infinity;
    if (cached && age >= 0 && age < EFFORT_CATALOG_TTL_MS) models = cached.models;
    else catalogs.delete(profile.provider);
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (!models) return "unavailable";
  return modelSupportsEffort(models, profile.model, effort) ? "supported" : "unsupported";
}
