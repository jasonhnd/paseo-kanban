// Explicit legacy transport fixtures. Production admission is exercised separately with persisted policy.
import { useLegacyRouting, legacyRoutingConfig } from "./legacy-routing";
import { runTick as production } from "../../server/schedule";
import { readCompatibilityDispatchMatrix } from "../../server/matrix";
import { readCompatibilityPoolSnapshot } from "../../server/pools";
export const runTick: typeof production = options => {
  useLegacyRouting();
  return production({
    ...options,
    ...(options.config ? { config: legacyRoutingConfig(options.config) } : {}),
    pools: options.pools ?? readCompatibilityPoolSnapshot(options.now?.getTime()),
    matrix: options.matrix ?? readCompatibilityDispatchMatrix(options.now?.getTime()),
  });
};
