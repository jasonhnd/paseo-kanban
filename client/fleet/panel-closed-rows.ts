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

type SnapshotAge = "older" | "same" | "newer" | "unknown";

/** Order snapshots by their timestamps. A new object with an earlier time is still stale. */
function snapshotAge(nextAt: string, heldAt: string): SnapshotAge {
  const next = Date.parse(nextAt);
  const held = Date.parse(heldAt);
  if (!Number.isFinite(next) || !Number.isFinite(held)) return "unknown";
  if (next < held) return "older";
  if (next > held) return "newer";
  return "same";
}

/**
 * Release cached rows from snapshots that are not older than the local action.
 * A restored row is dropped when a newer snapshot no longer lists its id.
 * An unconfirmed local close keeps Undo until a snapshot of the same generation
 * or newer reads the close back; anything older is ignored.
 * A confirmed close records each newer omission as its watermark. An open
 * snapshot releases Undo only at that watermark or later, so a late open
 * cannot discard a newer omission. An invalid time does not move the watermark.
 */
export function reconcilePanelClosedRows<Row>(
  prev: ReadonlyMap<string, PanelClosedRow<Row>>,
  data: Pick<BoardSnapshot, "decisions" | "generatedAt">,
): ReadonlyMap<string, PanelClosedRow<Row>> {
  const open = new Set(data.decisions.filter((row) => row.kind === "decide").map((row) => row.id));
  let next: Map<string, PanelClosedRow<Row>> | undefined;
  for (const [id, entry] of prev) {
    if (entry.decisions === data.decisions && entry.generatedAt === data.generatedAt) continue;
    const age = snapshotAge(data.generatedAt, entry.generatedAt);
    if (age === "older") continue;
    const listed = open.has(id);
    const fresh = age === "newer" || age === "same";
    if (!entry.closed && listed) {
      (next ??= new Map(prev)).delete(id);
    } else if (!entry.closed && !listed && age === "newer") {
      (next ??= new Map(prev)).delete(id);
    } else if (entry.closed && !entry.confirmed && !listed && fresh) {
      (next ??= new Map(prev)).set(id, {
        ...entry,
        confirmed: true,
        generatedAt: data.generatedAt,
        decisions: data.decisions,
      });
    } else if (entry.closed && entry.confirmed && !listed && age === "newer") {
      (next ??= new Map(prev)).set(id, {
        ...entry,
        generatedAt: data.generatedAt,
        decisions: data.decisions,
      });
    } else if (entry.closed && entry.confirmed && listed && fresh) {
      (next ??= new Map(prev)).delete(id);
    }
  }
  return next ?? prev;
}

export function usePanelClosedRows<Row>(data: Pick<BoardSnapshot, "decisions" | "generatedAt">) {
  const [held, setHeld] = useState<ReadonlyMap<string, PanelClosedRow<Row>>>(new Map());
  useEffect(() => {
    setHeld((prev) => reconcilePanelClosedRows(prev, data));
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
