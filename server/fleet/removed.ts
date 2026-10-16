/// <reference types="node" />
import { supervisorSlots, type SupervisorConfig, type SupervisorSlot } from "../../shared/fleet/supervisor-shift";
import { removedProjects } from "../paseo-projects";
import { kanbanProjectName } from "./paths";

/**
 * Board projects whose directory is no longer a Paseo project. The cockpit hides them and sends no
 * reminders for them. A failure here must never hide a project, so it reads as "none removed".
 */
export function readRemovedProjects(): ReadonlySet<string> {
  try {
    return removedProjects();
  } catch (error) {
    console.error("[paseo-kanban] removed projects", error instanceof Error ? error.message : String(error));
    return new Set();
  }
}

/** Leader slots of the projects still in Paseo. The leader panel and usage report list only these. */
export function visibleSupervisorSlots(config: SupervisorConfig): SupervisorSlot[] {
  const removed = readRemovedProjects();
  return supervisorSlots(config, kanbanProjectName()).filter((slot) => !removed.has(slot.project));
}
