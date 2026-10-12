/// <reference types="node" />
import { readFileSync } from "node:fs";
import { paseoConfigPath } from "./paths";

/**
 * Profile name to model id, read from Paseo's agent profiles. Kept apart from profiles.ts because
 * that module pulls in routing, which would make the board's card builder import itself in a loop.
 * A file that cannot be read gives an empty map: the card then shows the run's own model or the profile name.
 */
export function profileModels(path = paseoConfigPath()): Map<string, string> {
  const models = new Map<string, string>();
  try {
    const list = (JSON.parse(readFileSync(path, "utf8")) as { daemon?: { agentProfiles?: unknown } } | null)?.daemon?.agentProfiles;
    if (!Array.isArray(list)) return models;
    for (const item of list as Array<{ name?: unknown; model?: unknown }>) {
      if (typeof item?.name === "string" && typeof item.model === "string" && item.model) models.set(item.name, item.model);
    }
  } catch {
    // Unreadable or malformed: fall back to the run's model and the profile name.
  }
  return models;
}
