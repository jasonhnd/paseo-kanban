/// <reference types="node" />
import { type Env } from "../contract";
import { pluginRoot } from "../paths";
import { homedir } from "node:os";

/** Fleet is part of the Kanban installation, never a separately discovered package. */
export function runtimePluginDir(env: Env = process.env, home = homedir()): string | null {
  return pluginRoot(env);
}
export function hasManagedInstallIdentity(): boolean { return false; }
