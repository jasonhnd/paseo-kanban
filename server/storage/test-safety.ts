/// <reference types="node" />
// Shared by test launchers and runtime writers. No production behavior changes without the marker.
import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

type Env = Readonly<Record<string, string | undefined>>;
let accountHome: string | undefined;
const realAccountHome = () => accountHome ??= userInfo().homedir; // Unlike os.homedir(), this does not follow a poisoned HOME.

function canonical(value: string, seen = new Set<string>()): string {
  const absolute = resolve(value);
  if (seen.has(absolute)) throw new Error(`test isolation: symlink loop at ${absolute}`);
  seen.add(absolute);
  try {
    if (lstatSync(absolute).isSymbolicLink()) return canonical(resolve(dirname(absolute), readlinkSync(absolute)), seen);
    return realpathSync(absolute);
  } catch (error) {
    if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  }
  const parent = dirname(absolute);
  return parent === absolute ? absolute : join(canonical(parent, seen), basename(absolute));
}
function inside(path: string, parent: string): boolean {
  const rel = relative(parent, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}
function protectedHomes(env: Env): string[] {
  // The launcher retains the invoking home's identity, including simulated homes in regressions.
  const extra: unknown = JSON.parse(env.KANBAN_TEST_PROTECTED_HOMES || "[]");
  if (!Array.isArray(extra) || extra.some(home => typeof home !== "string" || !isAbsolute(home))) {
    throw new Error("test isolation: invalid protected home list");
  }
  return [...new Set([realAccountHome(), ...extra as string[]])];
}
let protectedRoots: { key: string; lexical: string[]; canonical: string[] } | undefined;
export function assertTestSafePath(path: string, env: Env = process.env): void {
  if (env.KANBAN_TEST_RUN !== "1") return;
  const homes = protectedHomes(env);
  const key = JSON.stringify(homes);
  if (protectedRoots?.key !== key) {
    const lexical = homes.flatMap(home => [".paseo/plugin-data", ".paseo/config.json", ".config/fleet-roles", ".config/paseo-kanban", ".config/paseo-fleet", ".local/share/paseo-kanban"].map(suffix => resolve(home, suffix)));
    // Snapshot the personal roots, as the existing DB guard does. Never cache a target's authorization:
    // every access resolves the target again, including replaced directories and dangling symlinks.
    protectedRoots = { key, lexical, canonical: lexical.map(value => canonical(value)) };
  }
  const requested = resolve(path);
  const target = canonical(path);
  if (protectedRoots.lexical.some(root => inside(requested, root)) || protectedRoots.canonical.some(root => inside(target, root))) {
    throw new Error(`test isolation: Tests may not touch personal state: ${path}; set KANBAN_DATA_DIR and host paths to a temporary directory.`);
  }
}

const STATE_PATHS = ["HOME", "PASEO_HOME", "KANBAN_DATA_DIR", "KANBAN_PASEO_CONFIG", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "TMPDIR", "KANBAN_TMP", "KANBAN_TMP_ROOT", "KANBAN_WORKTREES_ROOT", "KANBAN_PROJECTS_ROOT", "ROLES_KANBAN_CONFIG", "KANBAN_POOL_STATUS", "KANBAN_DISPATCH_MATRIX"] as const;
/** Preflight before any test phase starts. With root, also require every override in that run's tree. */
export function assertTestEnvironment(env: Env, root?: string): void {
  if (env.KANBAN_TEST_RUN !== "1") return;
  const homes = protectedHomes(env).map(home => canonical(home));
  for (const key of STATE_PATHS) {
    const path = env[key];
    if (path) {
      if ((key === "HOME" && homes.includes(canonical(path)))
          || (key === "PASEO_HOME" && homes.some(home => canonical(path) === canonical(join(home, ".paseo"))))) {
        throw new Error(`test isolation: leaked ${key}: ${path}`);
      }
      assertTestSafePath(path, env);
    }
    if (root && (!path || !inside(canonical(path), canonical(root)) || (!["TMPDIR", "KANBAN_TMP"].includes(key) && canonical(path) === canonical(root)))) {
      throw new Error(`test isolation: ${key} must be inside the private test root`);
    }
  }
  if (root && (env.KANBAN_TOKEN !== undefined || env.PASEO_AGENT_ID !== undefined)) {
    throw new Error("test isolation: inherited KANBAN_TOKEN/PASEO_AGENT_ID must be cleared");
  }
}
