// Dependency injection is internal to these legacy fixtures; no CLI flag enables compatibility admission.
import { runKanban as production } from "../../server/cli";
import { readCompatibilityDispatchMatrix } from "../../server/matrix";
import { readCompatibilityPoolSnapshot } from "../../server/pools";
export const runKanban: typeof production = (args, env, hooks) => production(args, env, {
  ...hooks,
  startReaders: { readMatrix: readCompatibilityDispatchMatrix, readSnapshot: readCompatibilityPoolSnapshot, ...hooks?.startReaders },
});
