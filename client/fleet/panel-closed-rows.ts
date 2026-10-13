import { useEffect, useState } from "react";
import type { BoardSnapshot } from "../../shared/fleet/board";
import type { ReplyMessage } from "./decision-actions";

export interface PanelClosedRow<Row> {
  row: Row;
  closed: boolean;
  confirmed: boolean;
  decisions: BoardSnapshot["decisions"];
  generatedAt: string;
}

/** Keep Undo in this mount, but release restored rows once the snapshot owns them again. */
export function usePanelClosedRows<Row>(data: Pick<BoardSnapshot, "decisions" | "generatedAt">) {
  const [held, setHeld] = useState<ReadonlyMap<string, PanelClosedRow<Row>>>(new Map());
  useEffect(() => {
    const open = new Set(data.decisions.filter((row) => row.kind === "decide").map((row) => row.id));
    setHeld((prev) => {
      let next: Map<string, PanelClosedRow<Row>> | undefined;
      for (const [id, entry] of prev) {
        if (entry.decisions === data.decisions && entry.generatedAt === data.generatedAt) continue;
        if (open.has(id) && (!entry.closed || entry.confirmed)) {
          // Undo here, or a reopen elsewhere: an old cached row must not
          // resurrect a blocker when another region subsequently closes it.
          (next ??= new Map(prev)).delete(id);
        } else if (entry.closed && !open.has(id) && !entry.confirmed) {
          // Until the close is read back, a stale in-flight open snapshot
          // must not cancel the successful local close or its Undo control.
          (next ??= new Map(prev)).set(id, { ...entry, confirmed: true });
        }
      }
      return next ?? prev;
    });
  }, [data.decisions, data.generatedAt]);
  const note = (id: string, row: Row, message: ReplyMessage) => {
    if (!message.ok || (!message.panelClosed && !message.panelRestored)) return;
    setHeld((prev) => new Map(prev).set(id, {
      row, closed: message.panelClosed === true, confirmed: false,
      decisions: data.decisions, generatedAt: data.generatedAt,
    }));
  };
  return { held, note };
}
