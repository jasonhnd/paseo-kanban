import type { Language } from "../shared/i18n";
import { HOME } from "./paths";
import { protocolText } from "./protocol-text";
import { stableLauncherPath } from "./stable-bin";

/** The stable board command, with the home directory shortened to `~` to keep the line compact. */
export function displayCliPath(path = stableLauncherPath()): string {
  return path === HOME || path.startsWith(`${HOME}/`) ? `~${path.slice(HOME.length)}` : path;
}

let cliPathOnce: { key: string; path: string } | null = null;

/**
 * One sentence for nudges, the MCP-stale note, and the injected work rules.
 * The work rules have to stay under twice their previous length, so this line is compact.
 * It must not tell the agent that KANBAN_TOKEN is required.
 * The command path is resolved once per data directory, the first time that directory is needed.
 */
export function cliFallback(language?: Language): string {
  const key = stableLauncherPath();
  if (!cliPathOnce || cliPathOnce.key !== key) cliPathOnce = { key, path: displayCliPath(key) };
  return protocolText("cli-fallback", { cli: cliPathOnce.path }, language);
}

export function mcpStaleNote(): string {
  return protocolText("mcp-stale-note", { cliFallback: cliFallback() });
}
