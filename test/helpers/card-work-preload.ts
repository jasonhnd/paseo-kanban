// Every test worker (and its fake launchers/CLI children) owns an explicit card root.
import { privateTestEnvironment } from "./test-environment.mjs";
import { assertTestEnvironment } from "../../server/storage/test-safety";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { after } from "node:test";

assertTestEnvironment(process.env);
const root = mkdtempSync(join(tmpdir(), "kanban-card-roots-"));
// Each worker gets its own home, config and unified state as well as card directories.
const env = privateTestEnvironment(root);
for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
Object.assign(process.env, env);
delete process.env.KANBAN_TOKEN;
delete process.env.PASEO_AGENT_ID;
// Loose fixture directories must not inherit the invoking checkout as their Git root.
process.env.GIT_CEILING_DIRECTORIES = [...new Set([
  ...(process.env.GIT_CEILING_DIRECTORIES ?? "").split(delimiter).filter(Boolean),
  tmpdir(), dirname(homedir()),
])].join(delimiter);
after(() => rmSync(root, { recursive: true, force: true }));

// Admission fixtures must not depend on the machine's current disk size or free space.
// Capacity suites can replace this injected statfs with their own small/low-disk cases.
const { setCapacityProbeForTests } = await import("../../server/capacity-guard");
setCapacityProbeForTests({ statfs: () => ({ blocks: 1024 ** 4, bavail: 100 * 1024 ** 3, bsize: 1 }) });
