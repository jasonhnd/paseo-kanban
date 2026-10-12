/// <reference types="node" />
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";

/** Locate a command on PATH without assuming a package manager's prefix. */
export function findCommand(name: string, env: NodeJS.ProcessEnv = process.env, home = homedir()): string | null {
  for (const dir of [...(env.PATH ?? "").split(delimiter).filter(Boolean), join(home, ".local", "bin"), dirname(process.execPath)]) {
    const candidate = join(dir, name);
    try { accessSync(candidate, constants.X_OK); if (statSync(candidate).isFile()) return candidate; } catch { /* Try the next directory. */ }
  }
  return null;
}

/** Node command files can run from an unpacked package without executable bits. */
export function commandInvocation(command: string, args: readonly string[]) {
  return /\.(?:mjs|js)$/.test(command) ? { command: process.execPath, args: [command, ...args] } : { command, args: [...args] };
}
