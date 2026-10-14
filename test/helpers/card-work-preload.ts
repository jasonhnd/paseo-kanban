// Every test worker (and its fake launchers/CLI children) owns an explicit card root.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";

const root = mkdtempSync(join(tmpdir(), "kanban-card-roots-"));
process.env.KANBAN_TMP_ROOT = root;
// Loose fixture directories must not inherit the invoking checkout as their Git root.
process.env.GIT_CEILING_DIRECTORIES = tmpdir();
after(() => rmSync(root, { recursive: true, force: true }));
