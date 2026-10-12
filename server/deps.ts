/** A prerequisite that is done, archived, or a triage parent does not block the child. */
export function dependencyMet(status: string): boolean {
  return status === "done" || status === "archived" || status === "triage";
}

/** A child counts as finished for its triage parent once its own work has reached acceptance. */
export function childFinished(status: string): boolean {
  return status === "done" || status === "acceptance" || status === "archived";
}
