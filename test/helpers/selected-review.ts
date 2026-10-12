import type { Profile } from "../../server/profiles";
import type { RouteInput } from "../../server/routing";

/** Placement fixtures inject a selected reviewer without exercising host pool capacity.
 * startTask still resolves and enforces the real target run/family at its handler boundary.
 */
export function selectedReviewRoute(profiles: Profile[]): RouteInput {
  return {
    profiles, role: "reviewer", review: true, byPool: {}, poolLimits: {},
    snapshot: {
      state: "fresh", generatedAt: null, message: "anonymous placement fixture",
      dispatchable: () => true, hasPool: () => true,
      entry: () => ({ dispatchable: true, deprioritize: false, prefer: false, resetsAt: null, reason: null, onlyRoles: null }),
    },
  };
}
