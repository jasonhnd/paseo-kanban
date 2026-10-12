import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { KanbanError } from "./errors";
import { t } from "../shared/i18n";

/** A brief is text a person wrote; anything bigger than this is a mistaken path. */
export const BRIEF_FILE_MAX_BYTES = 1024 * 1024;
const TMP_ROOTS = ["/tmp", "/private/tmp"];

function realOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/** The git top level of cwd, or null when cwd is not inside a repository. */
function repoRoot(cwd: string): string | null {
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    return top ? realOrNull(top) : null;
  } catch {
    return null;
  }
}

function within(root: string, path: string): boolean {
  const back = relative(root, path);
  return back === "" || (!back.startsWith("..") && !isAbsolute(back));
}

/**
 * Read a --brief-file. Only the supervisor may use it, and only for a file inside
 * the git repository the command runs in (its top level, not the bare cwd) or under /tmp, so a card brief cannot be made
 * from ~/.ssh or another project's secrets. Symlinks are resolved before the check.
 */
export function readBriefFile(path: string, role: string, cwd: string = process.cwd(), temporaryRoots: readonly string[] = TMP_ROOTS): string {
  if (role !== "supervisor") throw new KanbanError("forbidden", t("briefFile.error.forbidden"));
  const real = realOrNull(resolve(cwd, path));
  if (!real) throw new KanbanError("invalid", t("briefFile.error.unreadable", { path }));
  const roots = [repoRoot(cwd), ...temporaryRoots.map(realOrNull)].filter((root): root is string => Boolean(root));
  if (!roots.some((root) => within(root, real))) {
    throw new KanbanError("invalid", t("briefFile.error.outside", { path }));
  }
  const info = statSync(real);
  if (!info.isFile() || info.size > BRIEF_FILE_MAX_BYTES) {
    throw new KanbanError("invalid", t("briefFile.error.tooLarge", { max: BRIEF_FILE_MAX_BYTES, path }));
  }
  return readFileSync(real, "utf8");
}
