/// <reference types="node" />
import type { DatabaseSync } from "node:sqlite";
import { deriveProjectCode } from "../shared/card-code";
import { ConfigFileError, createConfigIfFresh, loadConfig, loadConfigOrMemory, projectCode, type KanbanConfig } from "./config";

/**
 * Runs on every database open. A fresh installation (no config file, no config copy, no card) gets its
 * first config here, with no projects yet. Nothing else is ever written (DEMO_0001): an existing file is
 * not given codes, and a file that went missing on a board that has had one is not recreated, because a
 * regenerated code renumbers every old card. A file that is broken, or missing on such a board, gets one log line.
 */
export function syncProjectCodes(db: DatabaseSync): void {
  try {
    createConfigIfFresh(() => ({ projects: {} }), db);
  } catch (err) {
    if (!(err instanceof ConfigFileError)) throw err;
    console.error(`[paseo-kanban] ${err.message}`);
  }
}

/** The code a project is shown with when the config stores none: the first letters of the name. */
export function derivedProjectCode(project: string): string {
  return deriveProjectCode(project.trim());
}

/**
 * Short code used only to print a card number: the stored code, else the derived one, which is shown but
 * never written back (DEMO_0001). Null, so the card shows as `#id`, when the derived code is another
 * project's stored code: `show DEMO_0001` must not reach the wrong card.
 * Null too when the file is missing or broken and there is no copy in memory: with no stored codes to
 * check against, a derived code could be any project's.
 * Does not write the config and does not throw when the file is missing or cannot be read.
 */
export function displayProjectCode(project: string, config?: KanbanConfig): string | null {
  const name = project.trim();
  const settings = config ?? loadConfigOrMemory();
  if (!settings) return null;
  const stored = projectCode(name, settings);
  if (stored) return stored;
  const derived = derivedProjectCode(name);
  return Object.values(settings.projects ?? {}).some((row) => row.code === derived) ? null : derived;
}

/**
 * Code for a new card's number, as displayProjectCode shows it. Never generated into or written to the
 * config (DEMO_0001); set one with `bin/kanban project --project <project> --code <short code>`. The card's sequence
 * number does not depend on it.
 * A config file that is broken, or missing on a board that has had one, is reported to the caller.
 */
export function ensureProjectCode(project: string): string | null {
  return displayProjectCode(project, loadConfig());
}

/** Projects among `names` (projects with cards) that the config gives no code, with what their cards show. */
export function projectsWithoutCode(names: Iterable<string>, config: KanbanConfig): Array<{ project: string; shown: string | null }> {
  const missing = new Map<string, string | null>();
  for (const raw of names) {
    const name = raw.trim();
    if (name && !missing.has(name) && !projectCode(name, config)) missing.set(name, displayProjectCode(name, config));
  }
  return [...missing].map(([project, shown]) => ({ project, shown })).sort((a, b) => a.project.localeCompare(b.project));
}
