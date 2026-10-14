// These anonymous unit fixtures intentionally test the retained legacy transport semantics.
// Direct single-file runs must isolate fake card preparation too, without relying on a suite runner.
import "./card-work-preload";
import { startTask as production } from "../../server/dispatch";
import { readCompatibilityDispatchMatrix } from "../../server/matrix";
import { readCompatibilityPoolSnapshot } from "../../server/pools";
export const startTask: typeof production = (id, launcher, actor, options) => production(id, launcher, actor, {
  readMatrix: readCompatibilityDispatchMatrix,
  readSnapshot: readCompatibilityPoolSnapshot,
  ...options,
});
