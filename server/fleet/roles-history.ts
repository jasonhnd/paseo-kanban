/// <reference types="node" />
// Runtime file behind the Roles page history. Not in git, like the other *-state files.
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { appendHistory, type HistoryEntry, parseHistory } from "../../shared/fleet/roles-history";
import { readJson, STATE_DIR, writeJson } from "./util";

export const ROLES_HISTORY = join(STATE_DIR, "roles-history.json");

export interface HistoryStore {
  read: () => Promise<HistoryEntry[]>;
  append: (entry: HistoryEntry) => Promise<void>;
}

/** One write at a time, so two quick swaps never lose each other's entry. */
export function fileHistoryStore(path = ROLES_HISTORY): HistoryStore {
  let queue: Promise<unknown> = Promise.resolve();
  const read = async () => parseHistory(await readJson<unknown>(path, null));
  const append = (entry: HistoryEntry) => {
    const next = queue.then(async () => writeJson(path, { entries: appendHistory(await read(), entry) }));
    queue = next.catch(() => undefined);
    return next;
  };
  return { read, append };
}

export const newHistoryId = (): string => randomUUID();
