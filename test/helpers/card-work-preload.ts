// Every test worker (and its fake launchers/CLI children) owns an explicit card root.
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { after } from "node:test";

const root = mkdtempSync(join(tmpdir(), "kanban-card-roots-"));
process.env.KANBAN_TMP_ROOT = root;
// Loose fixture directories must not inherit the invoking checkout as their Git root.
process.env.GIT_CEILING_DIRECTORIES = [...new Set([
  ...(process.env.GIT_CEILING_DIRECTORIES ?? "").split(delimiter).filter(Boolean),
  tmpdir(), dirname(homedir()),
])].join(delimiter);
after(() => rmSync(root, { recursive: true, force: true }));
