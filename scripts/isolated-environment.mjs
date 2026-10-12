import { accessSync, constants, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";

// POSIX tools used by real Git/shell/filesystem fixture tests, not provider executables.
export const TEST_TOOLS = ["npm", "git", "env", "sh", "dirname", "cat", "uniq", "find", "file", "true", "du", "tar"];

export function executable(name, path = process.env.PATH ?? "") {
  for (const directory of path.split(delimiter).filter(Boolean)) {
    const candidate = join(directory, name);
    try { accessSync(candidate, constants.X_OK); return candidate; } catch { /* try the next declared directory */ }
  }
  throw new Error(`required fixture tool is unavailable: ${name}`);
}

export function isolatedEnvironment(directory, { release = false, sourceEnv = process.env } = {}) {
  const tools = join(directory, "tools"); mkdirSync(tools, { recursive: true });
  symlinkSync(process.execPath, join(tools, "node"));
  for (const name of [...TEST_TOOLS, ...(release ? ["gitleaks"] : [])]) symlinkSync(executable(name, sourceEnv.PATH), join(tools, name));
  const dirs = ["home", "paseo", "data", "fleet", "roles", "legacy", "cache", "tmp", "worktrees", "projects"];
  for (const name of dirs) mkdirSync(join(directory, name), { recursive: true });
  const list = join(directory, "anonymous-denylist.txt");
  writeFileSync(list, "AnonymousPrivateProject\n");
  const env = {
    PATH: tools, HOME: join(directory, "home"), PASEO_HOME: join(directory, "paseo"),
    KANBAN_DATA_DIR: join(directory, "data"),
    KANBAN_PASEO_CONFIG: join(directory, "paseo/config.json"),
    KANBAN_TMP_ROOT: join(directory, "tmp"), KANBAN_TMP: directory, TMPDIR: join(directory, "tmp"),
    KANBAN_WORKTREES_ROOT: join(directory, "worktrees"),
    XDG_CACHE_HOME: join(directory, "cache"), XDG_CONFIG_HOME: join(directory, "home/config"),
    npm_config_cache: join(directory, "cache/npm"), LANG: "C.UTF-8", LC_ALL: "C.UTF-8",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(directory, "home/no-global"),
    GIT_AUTHOR_NAME: "paseo-fleet contributors", GIT_COMMITTER_NAME: "paseo-fleet contributors",
    GIT_AUTHOR_EMAIL: "noreply@example.invalid", GIT_COMMITTER_EMAIL: "noreply@example.invalid",
    FLEET_PRIVATE_DENYLIST: list,
  };
  // These are explicit read-only build/contract inputs, never runtime identities or provider routes.
  for (const key of ["PASEO_PLUGIN_COMPILER", "PASEO_SERVER_DIR", "FLEET_CONTRACT_SOURCE", "PASEO_FLEET_SIBLING"]) {
    if (sourceEnv[key]?.trim()) env[key] = sourceEnv[key];
  }
  if (release && sourceEnv.FLEET_PRIVATE_DENYLIST?.trim()) env.FLEET_PRIVATE_DENYLIST = sourceEnv.FLEET_PRIVATE_DENYLIST;
  return env;
}
