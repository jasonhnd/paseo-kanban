/// <reference types="node" />
import { chmodSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/** Owner-only access for one file the board wrote. Failures are ignored: a missing file or a foreign owner must not break a write. */
export function tightenFile(path: string): void {
  try {
    if (lstatSync(path).isFile()) chmodSync(path, FILE_MODE);
  } catch {
    // gone or not ours: nothing to tighten
  }
}

/**
 * The data directory holds the database, tokens, backups, doctor reports and perf files,
 * all private to the owner. Safe to run on every open: it only ever removes group/other access.
 */
export function tightenDataDir(dir: string): void {
  try {
    chmodSync(dir, DIR_MODE);
    for (const entry of readdirSync(dir)) tightenFile(join(dir, entry));
  } catch {
    // unreadable directory: the caller's own open will report the real problem
  }
}
