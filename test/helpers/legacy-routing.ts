// Compatibility fixtures intentionally exercise the pre-quota matrix/roster behavior.
// Fresh routing and its default-on setting are covered by quota-routing*.test.ts.
import { assertTestEnvironment } from "../../server/storage/test-safety";
// Direct imports need a private environment. Marked children already share their
// caller's isolated board, so validate it without replacing its database directory.
assertTestEnvironment(process.env);
if (process.env.KANBAN_TEST_RUN !== "1") await import("./card-work-preload");
import { loadConfig, saveConfig, type KanbanConfig } from "../../server/config";
export function legacyRoutingConfig(config: KanbanConfig): KanbanConfig {
  return { ...config, quotaRouting: { enabled: false } };
}
export function useLegacyRouting(): void {
  const config = loadConfig();
  if (config.quotaRouting?.enabled !== false) saveConfig(legacyRoutingConfig(config));
}
