import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DispatchProfile } from "../../shared/fleet/dispatch";
import type { ThinkingCatalog } from "../../shared/fleet/dispatch-overrides";
import { AFC_CONFIG_FILE } from "./adapters/config";
import { BIN, PASEO_DIR, STATE_DIR, run } from "./util";

export const dispatchOverrideWarning = (message: string): void => console.warn(`[afc] dispatch overrides: ${message}`);
export async function readDispatchOverrides(dir = STATE_DIR): Promise<unknown> {
  try {
    const document = JSON.parse(await readFile(join(dir, AFC_CONFIG_FILE), "utf8"));
    return document?.dispatchOverrides;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") dispatchOverrideWarning("Ignoring unreadable override configuration");
    return undefined;
  }
}

type Runner = (provider: string) => Promise<unknown>;
const modelCatalog: Runner = async provider => JSON.parse(await run(BIN.paseo,
  ["provider", "models", provider, "--thinking", "--json", "--home", PASEO_DIR], 10_000));

/** Read only the public model catalog. Unknown capabilities cannot authorize an effort override. */
export async function readThinkingCatalog(profiles: readonly DispatchProfile[], runner: Runner = modelCatalog): Promise<ThinkingCatalog> {
  const result: Record<string, string[]> = {};
  await Promise.all([...new Set(profiles.flatMap(profile => profile.provider ? [profile.provider] : []))].map(async provider => {
    try {
      const raw = await runner(provider);
      if (!Array.isArray(raw)) return;
      for (const profile of profiles.filter(profile => profile.provider === provider)) {
        const model = raw.find(row => row && row.id === profile.model);
        if (Array.isArray(model?.thinkingOptionIds) && model.thinkingOptionIds.every((id: unknown) => typeof id === "string")) {
          result[profile.name] = model.thinkingOptionIds;
        }
      }
    } catch { dispatchOverrideWarning(`Thinking options unavailable for provider ${provider}`); }
  }));
  return result;
}

export async function loadDispatchSettings(profiles: readonly DispatchProfile[], dir = STATE_DIR) {
  const dispatchOverrides = await readDispatchOverrides(dir);
  const thinkingCatalog = dispatchOverrides && typeof dispatchOverrides === "object" && Object.keys(dispatchOverrides).length
    ? await readThinkingCatalog(profiles) : {};
  return { dispatchOverrides, thinkingCatalog, onOverrideWarning: dispatchOverrideWarning };
}
