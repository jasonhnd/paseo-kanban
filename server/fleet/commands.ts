/// <reference types="node" />
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { commandPath } from "./platform";

/** Resolve a native executable without a shell or a package-manager-specific prefix. */
export function findCommand(name: string, path = commandPath()): string | null {
  const candidates = isAbsolute(name) ? [name] : path.split(delimiter).filter(Boolean).map(dir => join(dir, name));
  for (const candidate of candidates) {
    try { accessSync(candidate, constants.X_OK); if (statSync(candidate).isFile()) return candidate; } catch { /* Try the next PATH entry. */ }
  }
  return null;
}

/** Node command files do not need executable bits or an env shebang at runtime. */
export function commandInvocation(command: string, args: readonly string[]): { command: string; args: string[] } {
  return command.endsWith(".mjs") ? { command: process.execPath, args: [command, ...args] } : { command, args: [...args] };
}
