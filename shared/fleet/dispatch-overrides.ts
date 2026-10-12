import { z } from "zod";
import type { DispatchMatrix, DispatchProfile, MatrixEntry } from "./dispatch";
import { PROFILE_SLOTS, resolveProfileToken } from "./dispatch-slots";

export const DISPATCH_TIERS = ["L1", "L2", "L3", "L4"] as const;
export const DISPATCH_ROLES = ["executor", "reviewer", "reader", "decision", "batch", "ops_vercel", "ops_cloudflare", "ops_github", "ops_notion"] as const;
const roleSchema = z.enum(DISPATCH_ROLES);
const tierSchema = z.enum(DISPATCH_TIERS);
/** The published dispatch contract accepts these depths, regardless of provider catalog extensions. */
const MATRIX_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
export const dispatchOverrideSchema = z.object({
  effort: z.string().trim().min(1).max(80).nullable().optional(),
  order: z.number().int().min(1).max(1000).optional(),
}).strict().refine(row => row.effort !== undefined || row.order !== undefined, "Empty dispatch override");
export const dispatchOverridesSchema = z.partialRecord(roleSchema, z.partialRecord(tierSchema,
  z.record(z.string().regex(/^[a-z][a-z0-9.-]*$/), dispatchOverrideSchema)));
export type DispatchOverrides = z.infer<typeof dispatchOverridesSchema>;
export type ThinkingCatalog = Readonly<Record<string, readonly string[]>>;
export type DispatchWarning = (message: string) => void;

const object = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const entries = (value: unknown): value is MatrixEntry[] => Array.isArray(value) && value.every(row => object(row) && typeof row.profile === "string");
export function isGptProfile(profile: DispatchProfile): boolean {
  return profile.provider === "codex" || profile.family === "openai" || /gpt/i.test(profile.model ?? "");
}

/** Validate entries independently: one stale or malformed setting never discards other overrides. */
export function validDispatchOverrides(raw: unknown, profiles: readonly DispatchProfile[], catalog: ThinkingCatalog, warn: DispatchWarning): DispatchOverrides {
  const result: DispatchOverrides = {};
  if (raw === undefined) return result;
  const roles = object(raw);
  if (!roles) { warn("Ignoring dispatch overrides: expected an object"); return result; }
  for (const [role, value] of Object.entries(roles)) {
    const parsedRole = roleSchema.safeParse(role);
    const tiers = object(value);
    if (!parsedRole.success || !tiers) { warn(`Ignoring dispatch override role ${role}`); continue; }
    for (const [tier, value] of Object.entries(tiers)) {
      const parsedTier = tierSchema.safeParse(tier);
      const slots = object(value);
      if (!parsedTier.success || !slots) { warn(`Ignoring dispatch override tier ${role}/${tier}`); continue; }
      for (const [slot, value] of Object.entries(slots)) {
        const parsed = dispatchOverrideSchema.safeParse(value);
        const profile = Object.hasOwn(PROFILE_SLOTS, slot) ? resolveProfileToken(slot, profiles) : null;
        if (!parsed.success || !profile) { warn(`Ignoring dispatch override ${role}/${tier}/${slot}: invalid entry or unresolved slot`); continue; }
        const row = { ...parsed.data };
        if ((row.effort === null && isGptProfile(profile) && profile.thinkingOptionId?.toLowerCase() === "ultra") ||
          (typeof row.effort === "string" && (!MATRIX_EFFORTS.has(row.effort) || (isGptProfile(profile) && row.effort.toLowerCase() === "ultra") || !catalog[profile.name]?.includes(row.effort)))) {
          warn(`Ignoring dispatch effort ${role}/${tier}/${slot}: unsupported thinking option`);
          delete row.effort;
        }
        if (row.effort === undefined && row.order === undefined) continue;
        const roleRows = result[parsedRole.data] ??= {};
        const tierRows = roleRows[parsedTier.data] ??= {};
        tierRows[slot] = row;
      }
    }
  }
  return result;
}

/** Overrides change only existing rows; they cannot add reviewers or widen tier eligibility. */
export function mergeDispatchOverrides(base: DispatchMatrix, overrides: DispatchOverrides, warn: DispatchWarning): DispatchMatrix {
  const copy = JSON.parse(JSON.stringify(base)) as DispatchMatrix;
  for (const [role, tiers] of Object.entries(overrides)) {
    if (!Object.hasOwn(copy.roles, role)) { warn(`Ignoring dispatch override role ${role}: absent from the default matrix`); continue; }
    const used = new Set<string>();
    const apply = (list: MatrixEntry[], tier: string): MatrixEntry[] => {
      const slots = tiers?.[tier as keyof typeof tiers] ?? {};
      return list.map((entry, index) => {
        const row = slots[entry.profile];
        if (row) used.add(`${tier}/${entry.profile}`);
        return { entry: { ...entry, ...(row?.effort !== undefined ? { effort: row.effort } : {}),
          ...(row?.order !== undefined ? { order: row.order } : {}) }, index };
      }).sort((a, b) => {
        const aOrder = a.entry.order;
        const bOrder = b.entry.order;
        if (aOrder === undefined) return bOrder === undefined ? a.index - b.index : 1;
        if (bOrder === undefined) return -1;
        return aOrder - bOrder || a.index - b.index;
      }).map(row => row.entry);
    };
    const walk = (node: unknown): unknown => {
      const record = object(node);
      if (!record) return node;
      const next = { ...record };
      for (const [key, value] of Object.entries(record)) {
        next[key] = entries(value) ? apply(value, key) : walk(value);
      }
      if (entries(record["*"])) {
        for (const tier of DISPATCH_TIERS) if (tiers?.[tier] && next[tier] === undefined) {
          const list = apply(record["*"], tier);
          if (JSON.stringify(list) !== JSON.stringify(record["*"])) next[tier] = list;
        }
      }
      return next;
    };
    copy.roles[role] = walk(copy.roles[role]);
    for (const [tier, slots] of Object.entries(tiers ?? {})) for (const slot of Object.keys(slots ?? {})) {
      if (!used.has(`${tier}/${slot}`)) warn(`Ignoring dispatch override ${role}/${tier}/${slot}: slot is absent from the default role`);
    }
  }
  return copy;
}

export const dispatchSettingRowSchema = z.object({
  role: roleSchema, tier: tierSchema, slot: z.string(), profile: z.string().nullable(),
  defaults: z.array(z.object({ context: z.string(), effort: z.string().nullable(), order: z.number() })),
  supportedEfforts: z.array(z.string()), capabilityKnown: z.boolean(),
});
export type DispatchSettingRow = z.infer<typeof dispatchSettingRowSchema>;

/** Present every default slot, including missing profiles, without exposing profile notes or host configuration. */
export function dispatchSettingRows(base: DispatchMatrix, profiles: readonly DispatchProfile[], catalog: ThinkingCatalog): DispatchSettingRow[] {
  const rows = new Map<string, DispatchSettingRow>();
  for (const role of DISPATCH_ROLES) {
    const add = (list: MatrixEntry[], tier: typeof DISPATCH_TIERS[number], context: string) => list.forEach((entry, index) => {
      const key = `${role}/${tier}/${entry.profile}`;
      const profile = resolveProfileToken(entry.profile, profiles);
      const row = rows.get(key) ?? { role, tier, slot: entry.profile, profile: profile?.name ?? null, defaults: [],
        supportedEfforts: profile ? [...(catalog[profile.name] ?? [])].filter(value => MATRIX_EFFORTS.has(value) && (!isGptProfile(profile) || value.toLowerCase() !== "ultra")) : [],
        capabilityKnown: profile ? catalog[profile.name] !== undefined : false };
      row.defaults.push({ context, effort: entry.effort ?? null, order: index + 1 });
      rows.set(key, row);
    });
    const walk = (node: unknown, context = "") => {
      const record = object(node);
      if (!record) return;
      for (const [key, value] of Object.entries(record)) {
        if (entries(value)) {
          for (const tier of DISPATCH_TIERS) if (key === tier || (key === "*" && record[tier] === undefined)) add(value, tier, context);
        } else walk(value, context ? `${context}/${key}` : key);
      }
    };
    walk(base.roles[role]);
  }
  return [...rows.values()];
}
