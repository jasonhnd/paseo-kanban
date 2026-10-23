import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { userInfo } from "node:os";
import { assertTestEnvironment } from "../../server/storage/test-safety.ts";

/** Replace every host/state override; never inherit credentials or a personal config/cache. */
export function privateTestEnvironment(root, source = process.env) {
  const env = {
    ...source, KANBAN_TEST_RUN: "1", KANBAN_TEST_TMP: root,
    KANBAN_TEST_PROTECTED_HOMES: source.KANBAN_TEST_PROTECTED_HOMES || JSON.stringify([userInfo().homedir, source.HOME].filter(Boolean)),
    HOME: join(root, "home"), PASEO_HOME: join(root, "paseo"),
    TMPDIR: root, TMP: root, TEMP: root, KANBAN_TMP: root, KANBAN_TMP_ROOT: join(root, "cards"),
    KANBAN_DATA_DIR: join(root, "unified"), KANBAN_PASEO_CONFIG: join(root, "paseo/config.json"),
    XDG_CONFIG_HOME: join(root, "home/config"), XDG_CACHE_HOME: join(root, "cache"),
    npm_config_cache: join(root, "cache/npm"),
    KANBAN_WORKTREES_ROOT: join(root, "worktrees"), KANBAN_PROJECTS_ROOT: join(root, "projects"),
    KANBAN_AGENTIC_ROOT: join(root, "projects"), AFC_TRANSCRIPT_HOME: join(root, "home"),
    ROLES_KANBAN_CONFIG: join(root, "unified/kanban.config.json"),
    ROLES_STATE_DIR: "", AFC_DATA_DIR: "", AFC_LEGACY_DATA_DIR: "",
    KANBAN_POOL_STATUS: join(root, "absent-pools.json"), KANBAN_DISPATCH_MATRIX: join(root, "absent-matrix.json"),
    CODEX_HOME: join(root, "home/.codex"), CLAUDE_CONFIG_DIR: join(root, "home/.claude"), GROK_HOME: join(root, "home/.grok"),
    PASEO_VOICE_MODE_ENABLED: "0", PASEO_DICTATION_ENABLED: "0",
  };
  for (const key of ["KANBAN_HOME", "AFC_HOME", "KANBAN_PROJECT_ROOT", "KANBAN_AGENTS_DIR", "AFC_SANDBOX_ROSTER_DIR", "AFC_COUPON_FAKE_FILE"]) delete env[key];
  delete env.KANBAN_TOKEN;
  delete env.PASEO_AGENT_ID;
  assertTestEnvironment(env, root);
  for (const path of [env.HOME, env.PASEO_HOME, env.KANBAN_DATA_DIR, env.XDG_CONFIG_HOME, env.XDG_CACHE_HOME, env.KANBAN_TMP, env.KANBAN_TMP_ROOT, env.KANBAN_WORKTREES_ROOT, env.KANBAN_PROJECTS_ROOT]) mkdirSync(path, { recursive: true });
  return env;
}
