import { canonicalPoolId } from "../shared/fleet/x-ultra";
/// <reference types="node" />
import { currentOccupancy } from "./routing";
import type { Profile } from "./profiles";

/** Selection and the final guard share creating/run/braking occupancy and exclude this claim. */
export function unknownPoolOccupancy(pool: string, profiles: readonly Profile[], taskId: number): number {
  return currentOccupancy(profiles, taskId).byPool[canonicalPoolId(pool)!] ?? 0;
}
