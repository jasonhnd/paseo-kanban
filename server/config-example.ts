/// <reference types="node" />
// The generic config a fresh installation copies. No personal names, paths, or ids.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkoutRoot, pluginRoot } from "./paths";

/** `examples/kanban.config.example.json` next to this checkout, else next to the installed plugin. */
export function exampleConfigPath(): string {
  return join(checkoutRoot() ?? pluginRoot(), "examples", "kanban.config.example.json");
}

/** The example object, or null when the file is missing or not a JSON object. Never throws. */
export function readExampleConfig(): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(exampleConfigPath(), "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}
