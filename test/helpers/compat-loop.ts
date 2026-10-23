// Loop lifecycle fixtures use the same explicit legacy admission as direct tick fixtures.
import { bindScheduler as production } from "../../server/loop";
import { readCompatibilityDispatchMatrix } from "../../server/matrix";
import { readCompatibilityPoolSnapshot } from "../../server/pools";
import { legacyRoutingConfig, useLegacyRouting } from "./legacy-routing";

export const bindScheduler: typeof production = options => production({
  ...options,
  ready() {
    const deps = options.ready();
    if (!deps) return null;
    useLegacyRouting();
    return {
      ...deps,
      ...(deps.config ? { config: legacyRoutingConfig(deps.config) } : {}),
      pools: deps.pools ?? readCompatibilityPoolSnapshot(deps.now?.getTime()),
      matrix: deps.matrix ?? readCompatibilityDispatchMatrix(deps.now?.getTime()),
    };
  },
});
