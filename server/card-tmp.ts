/// <reference types="node" />
import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const TMP_GENERATION_FILE = ".kanban-tmp-generation";

/** Missing markers are legacy directories. Unreadable or unsafe markers fail closed. */
export function cardTmpGeneration(dir: string): string | null {
  let fd: number;
  try {
    fd = openSync(join(dir, TMP_GENERATION_FILE), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || info.size > 128) throw new Error("invalid tmp generation marker");
    return readFileSync(fd, "utf8");
  } finally { closeSync(fd); }
}

/** Where per-card temp directories live. Tests point this at a temp dir with KANBAN_TMP_ROOT. */
export function cardTmpRoot(): string {
  return process.env.KANBAN_TMP_ROOT?.trim() || "/tmp";
}

/**
 * Env that sends an agent's temp files into /tmp/<card code>/, the one directory the /tmp cleanup
 * collects 24 hours after the card ends. Cards without a display code get nothing: `#12` is not a safe
 * directory name. A directory that cannot be made must not stop the agent from starting.
 */
export function cardTmpEnv(code: string): Record<string, string> {
  if (!/^[A-Za-z0-9]+_\d+$/.test(code)) return {};
  const dir = join(cardTmpRoot(), code);
  try {
    mkdirSync(dir, { recursive: true });
    if (!lstatSync(dir).isDirectory()) throw new Error("card tmp path is not a real directory");
    const marker = join(dir, TMP_GENERATION_FILE);
    const existing = lstatSync(marker, { throwIfNoEntry: false });
    if (existing && !existing.isFile()) throw new Error("unsafe tmp generation marker");
    const generation = randomUUID();
    const pending = `${marker}.${generation}`;
    writeFileSync(pending, generation, { flag: "wx", mode: 0o600 });
    try { renameSync(pending, marker); } finally {
      // Atomic replacement also avoids truncating an existing hard link or exposing a partial marker.
      try { unlinkSync(pending); } catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
    }
  } catch (err) {
    console.error("[paseo-kanban] card tmp dir", dir, err instanceof Error ? err.message : err);
    return {};
  }
  return { TMPDIR: `${dir}/`, KANBAN_TMP: dir };
}
