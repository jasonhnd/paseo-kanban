/// <reference types="node" />
import { join } from "node:path";
import { parsePausedProjects, type PausedProject } from "../../shared/fleet/paused";
import { readJson, STATE_DIR } from "./util";

export const PAUSED_PROJECTS = join(STATE_DIR, "paused-projects.json");

/** Never throws: an unreadable file means nothing is paused. */
export async function readPausedProjects(path = PAUSED_PROJECTS): Promise<PausedProject[]> {
  return parsePausedProjects(await readJson<unknown>(path, []).catch(() => []));
}
