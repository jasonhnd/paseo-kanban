/// <reference types="node" />
import type { DoctorRedView } from "../shared/rpc";
import { readLastDoctorReport } from "./doctor";

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function redView(item: unknown, project: string | undefined): DoctorRedView | null {
  if (!item || typeof item !== "object") return null;
  const f = item as Record<string, unknown>;
  if (f.severity !== "red") return null;
  const id = str(f.id);
  const symptom = str(f.symptom);
  if (id === null || symptom === null) return null;
  const itemProject = str(f.project);
  if (project && itemProject !== null && itemProject !== project) return null;
  return {
    id,
    project: itemProject,
    card: str(f.card),
    taskId: typeof f.taskId === "number" ? f.taskId : null,
    object: str(f.object) ?? "",
    symptom,
    suggestion: str(f.suggestion) ?? "",
  };
}

/** Red findings from the last saved doctor report, for the board's "to handle" tab. Reads only; never runs a check. Any bad data yields fewer or no rows, never an error. */
export function doctorReds(project?: string): DoctorRedView[] {
  try {
    const report = readLastDoctorReport();
    if (!report) return [];
    const out: DoctorRedView[] = [];
    for (const item of report.findings) {
      const view = redView(item, project);
      if (view) out.push(view);
    }
    return out;
  } catch (err) {
    console.error("[paseo-kanban] doctor reds", err instanceof Error ? err.message : err);
    return [];
  }
}
