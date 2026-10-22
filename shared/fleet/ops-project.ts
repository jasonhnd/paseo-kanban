import { z } from "zod";

/** Backward-compatible project for AFC's own notifications and new decisions. */
export const DEFAULT_OPS_PROJECT = "paseo-fleet";
export const opsProjectSchema = z.string().regex(/^[^\u0000-\u001f\u007f]+$/, "Project names must not contain control characters").trim().min(1);

/** Invalid or absent configuration never redirects AFC's operational notices. */
export function opsProject(config: unknown): string {
  return configuredOpsProject(config) ?? DEFAULT_OPS_PROJECT;
}

/** Authorization must use an explicit valid project, never the notification fallback. */
export function configuredOpsProject(config: unknown): string | null {
  const value = config && typeof config === "object" && !Array.isArray(config) ? (config as { opsProject?: unknown }).opsProject : undefined;
  const parsed = opsProjectSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
