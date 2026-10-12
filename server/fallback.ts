import type { Language } from "../shared/i18n";
import { HOME, kanbanCliPath } from "./paths";
import { protocolText } from "./protocol-text";

/** The installation's command line, with the home directory shortened to `~` to keep the line compact. */
export function displayCliPath(path = kanbanCliPath()): string {
  return path === HOME || path.startsWith(`${HOME}/`) ? `~${path.slice(HOME.length)}` : path;
}

let cliPathOnce: string | null = null;

/**
 * One sentence for nudges, the MCP-stale note, and the injected work rules.
 * The work rules have to stay under twice their previous length, so this line is compact.
 * It must not tell the agent that KANBAN_TOKEN is required.
 * The command path is resolved once, the first time the line is needed.
 */
export function cliFallback(language?: Language): string {
  cliPathOnce ??= displayCliPath();
  return protocolText("cli-fallback", { cli: cliPathOnce }, language);
}

export function mcpStaleNote(): string {
  return protocolText("mcp-stale-note", { cliFallback: cliFallback() });
}
