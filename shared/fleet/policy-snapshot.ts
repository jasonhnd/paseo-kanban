import { z } from "zod";
import { PoolStatus, DispatchMatrix } from "../contract/schema";

/** One coherent policy revision; compatibility exports remain separate projections. */
export const PolicySnapshot = z.object({
  schema: z.literal("paseo-policy/v1"),
  revision: z.number().int().positive(),
  policyDigest: z.string().regex(/^[0-9a-f]{64}$/),
  pools: PoolStatus,
  matrix: DispatchMatrix,
}).refine(value => value.pools.generatedAt === value.matrix.generatedAt, "Policy timestamps differ");
export type PolicySnapshot = z.infer<typeof PolicySnapshot>;
