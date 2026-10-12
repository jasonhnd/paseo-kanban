/// <reference types="node" />
import { readdir, lstat } from "node:fs/promises";
import { join } from "node:path";
import { SAFE_NATIVE_ID } from "./native-agent-index";

/** Sessions whose project directory name looks like a /tmp (or /private/tmp) cwd and whose cwd exists nowhere on disk. Metadata only.
 * A deleted sibling such as /tmp-work encodes the same as /tmp/work and cannot be told apart without reading the session, so that
 * (deleted, same-name) case is treated as residue; any still-existing cwd, in /tmp or not, is kept. */
export interface TmpResidueSession { sessionId: string; project: string; cwd: string; mtimeMs: number }
export const TMP_RESIDUE_MIN_AGE_MS = 24 * 60 * 60_000;
const TMP_ROOTS = ["/tmp", "/private/tmp"] as const;
const encodeCwd = (path: string) => path.replace(/[^a-zA-Z0-9]/g, "-");

export const isTmpProjectName = (project: string, roots: readonly string[] = TMP_ROOTS): boolean => roots.some(root => project.startsWith(`${encodeCwd(root)}-`));
/** The encoding replaces every non-alphanumeric with '-', so '/'-for-'-' is a path that encodes back to the same name. */
export const syntheticTmpCwd = (project: string): string => project.replace(/-/g, "/");

/** The encoding maps '/', '-', '_', '.' ... all to '-', so "-tmp-work-x" could be /tmp/work/x or /tmp-work/x. Walk the whole tree from `base`
 * (default "/"), following only entries whose encoded path is a prefix of the project name; any exact match means *a* cwd that encodes to
 * this directory still exists, wherever it is, so keep it. A directory that cannot be listed counts as existing (fail closed). */
export async function tmpCwdStillExists(project: string, base = "/"): Promise<boolean> {
  const search = async (dir: string): Promise<boolean> => {
    let entries: string[];
    try { entries = await readdir(dir); } catch (err) { return !["ENOENT", "ENOTDIR"].includes((err as NodeJS.ErrnoException).code ?? ""); }
    for (const name of entries) {
      const path = join(dir, name); const encoded = encodeCwd(path);
      if (encoded === project) return true;
      if (!project.startsWith(`${encoded}-`)) continue;
      if (await search(path)) return true;
    }
    return false;
  };
  return search(base);
}

/** All residue sessions older than the minimum age, in stable order. `claudeDirs` is the set of project directory names under ~/.claude/projects. */
export async function findTmpResidueSessions(projectsDir: string, claudeDirs: Iterable<string>, now: Date, roots: readonly string[] = TMP_ROOTS, base = "/"): Promise<TmpResidueSession[]> {
  const found: TmpResidueSession[] = [];
  for (const project of [...claudeDirs].filter(project => isTmpProjectName(project, roots)).sort()) {
    if (await tmpCwdStillExists(project, base)) continue;
    let names: string[];
    try { names = await readdir(join(projectsDir, project)); } catch { continue; }
    for (const name of names.filter(item => item.endsWith(".jsonl")).sort()) {
      const sessionId = name.slice(0, -6);
      if (!SAFE_NATIVE_ID.test(sessionId)) continue;
      const stat = await lstat(join(projectsDir, project, name)).catch(() => null);
      if (!stat?.isFile() || +now - stat.mtimeMs <= TMP_RESIDUE_MIN_AGE_MS) continue;
      found.push({ sessionId, project, cwd: syntheticTmpCwd(project), mtimeMs: stat.mtimeMs });
    }
  }
  return found;
}
