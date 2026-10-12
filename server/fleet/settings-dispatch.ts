import { dispatchSettingRows } from "../../shared/fleet/dispatch-overrides";
import type { SettingsSnapshot } from "../../shared/fleet/settings";
import { loadBaseMatrix, loadProfiles, publishFromSnapshotFile } from "./dispatch";
import { readThinkingCatalog } from "./dispatch-settings";
import { readSettings, writeSettings } from "./settings";
import { requestPoolRefreshNow } from "./pool-refresh";
import { logSwallowed } from "./util";

/** The settings projection contains only matrix defaults, profile names and supported thinking ids. */
async function withDispatchRows(snapshot: SettingsSnapshot): Promise<SettingsSnapshot> {
  const [base, profiles] = await Promise.all([loadBaseMatrix(), loadProfiles()]);
  const catalog = await readThinkingCatalog(profiles ?? []);
  return { ...snapshot, dispatchRows: dispatchSettingRows(base, profiles ?? [], catalog) };
}

export async function readSettingsWithDispatch(file: Parameters<typeof readSettings>[0]) {
  const snapshot = await readSettings(file);
  return file === "config" ? withDispatchRows(snapshot) : snapshot;
}

export async function writeSettingsWithDispatch(input: Parameters<typeof writeSettings>[0]) {
  const result = await writeSettings(input);
  if (result.status === "saved") {
    // Apply a cleared or edited override immediately without waiting for the quota timer.
    await publishFromSnapshotFile().catch(error => logSwallowed("dispatch settings publication", error));
    requestPoolRefreshNow();
  }
  return { ...result, snapshot: input.file === "config" ? await withDispatchRows(result.snapshot) : result.snapshot };
}
