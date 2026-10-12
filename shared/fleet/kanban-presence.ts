// Whether the board parts of the panel show at all. Kanban that is not installed is not an error to report.
export type KanbanPresence = "absent" | "stale" | "fresh";

export function kanbanInstalled(kanban: { presence: KanbanPresence }): boolean {
  return kanban.presence !== "absent";
}
