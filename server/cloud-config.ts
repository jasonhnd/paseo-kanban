import { z } from "zod";
import { realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { KanbanError } from "./errors";
import { execFileSync } from "node:child_process";

// The first delay spans more than the default one-minute scheduler period.
export const DEFAULT_CLOUD_RECONCILE_RETRY_SEC = [120, 300, 600, 900];
/** This policy cannot be expanded by project settings or a repository's name/origin. */
export const LOCAL_MIRROR_PROJECTS = Object.freeze(["paseo-kanban"] as const);
const byteLimit = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const seconds = z.number().int().min(1).max(86_400);
/** Account capacity is shared by every project on this board. Reserve non-board machines separately. */
export const cloudSettingsSchema = z.object({
  allowedProjects: z.array(z.string().min(1)).default([]),
  maxMachines: z.number().int().min(1).max(5).default(3),
  deleteTimeoutSec: z.number().int().min(1).max(600).default(180),
  deletePollIntervalSec: z.number().int().min(1).max(60).default(5),
}).strict();
export type CloudSettings = z.infer<typeof cloudSettingsSchema>;
const command = z.array(z.string().min(1).regex(/^[\x20-\x7e]+$/)).min(2);
const directory = z.string().regex(/^(?:\.|[A-Za-z0-9_-][A-Za-z0-9._/-]*)$/)
  .refine(value => value === "." || value.split("/").every(part => part && part !== "." && part !== ".."), "directories must stay inside the repository");
const environmentKey = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/)
  .refine(value => !/(?:TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL|AUTH)/i.test(value) &&
    !/^(?:TMPDIR|TMP|TEMP|HOME|PATH|SHELL|ENV|IFS|USER|LOGNAME|NODE_OPTIONS|NODE_PATH|PYTHONPATH|CDPATH)$/.test(value) &&
    !/^(?:KANBAN_|PASEO_|FLEET_|GIT_|GH_|GITHUB_|SSH_|CODEX_|GROK_|XDG_|BASH_|LD_|DYLD_|NPM_CONFIG_)/.test(value),
  "environment must not contain credential, launch or card scratch overrides");
const environmentValue = z.string().max(4096).regex(/^[\x20-\x7e]*$/)
  .refine(value => !/(?:TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL)|\bBearer\s|\b(?:gh[pousr]_|github_pat_|sk-|xai-)[A-Za-z0-9_-]{16,}|[a-z][a-z0-9+.-]*:\/\/[^/\s]+@/i.test(value),
    "environment values must not contain suspected credentials");
const runtimeVersion = z.string().regex(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/).max(32);
const testsWith = (args: string[], runtime: string): boolean => args[0] === runtime &&
  (args[1] === "test" || (args[1] === "run" && args.length >= 3));
const installsWith = (args: string[], runtime: string): boolean => args[0] === runtime &&
  (runtime === "npm" ? ["ci", "install"] : ["install"]).includes(args[1]);
export const cloudRunnerSchema = z.object({
  enabled: z.boolean().default(false),
  source: z.enum(["publicGithub", "localMirror"]).default("publicGithub"),
  maxSourceBytes: byteLimit.default(10 * 1024 * 1024),
  maxResultBytes: byteLimit.default(10 * 1024 * 1024),
  runtime: z.enum(["npm", "bun"]).default("npm"),
  runtimeVersion: runtimeVersion.optional(),
  nodeVersion: runtimeVersion.optional(),
  bunVersion: runtimeVersion.optional(),
  bunSha256: z.record(runtimeVersion, z.object({
    x64: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    aarch64: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  }).strict().refine(value => !!value.x64 || !!value.aarch64, "at least one Bun architecture digest is required")).optional(),
  installBun: z.boolean().default(false),
  mode: z.enum(["per-card", "persistent"]).default("per-card"),
  directories: z.array(z.union([directory, z.object({ path: directory, installCommand: command.optional(), optional: z.boolean().optional(),
    testCommand: command.optional(), skipTest: z.boolean().optional() }).strict()]))
    .min(1).max(32).default(["."]),
  installCommand: command.optional(),
  testCommand: command.optional(),
  environment: z.record(environmentKey, environmentValue).default({}),
  snapshot: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/).default("tpl-agent"),
  maxParallel: z.number().int().min(1).max(5).default(2),
  retryIntervalSec: seconds.default(75),
  reconcileRetrySec: z.array(z.number().int().min(1).max(900)).min(1).max(16).default(() => [...DEFAULT_CLOUD_RECONCILE_RETRY_SEC]),
  maxCreateAttempts: z.number().int().min(1).max(100).default(8),
  machineTimeoutSec: seconds.default(5400),
  taskTimeoutSec: seconds.default(2400),
  templateRefreshedAt: z.iso.datetime({ offset: true }).optional(),
  templateMaxAgeDays: z.number().min(1).max(7).default(7),
  templateWarnAgeDays: z.number().min(0).max(7).default(6),
  mirrorRoot: z.string().refine(value => value.startsWith("/"), "mirrorRoot must be absolute").optional(),
}).strict().refine(value => !value.installBun || !!value.bunVersion, "installBun requires an exact bunVersion")
  .refine(value => !value.installBun || !!value.bunSha256?.[value.bunVersion ?? ""], "installBun requires bunSha256 for the exact bunVersion")
  .refine(value => value.taskTimeoutSec < value.machineTimeoutSec, "task timeout must be shorter than machine lifetime")
  .refine(value => value.templateWarnAgeDays < value.templateMaxAgeDays, "template warning must precede expiry")
  .transform(value => ({ ...value,
    nodeVersion: value.nodeVersion ?? value.runtimeVersion,
    installCommand: value.installCommand ?? (value.runtime === "npm" ? ["npm", "ci", "--no-audit", "--no-fund"] : ["bun", "install", "--frozen-lockfile"]),
    testCommand: value.testCommand ?? [value.runtime, "test"],
  })).refine(value => installsWith(value.installCommand, value.runtime) && testsWith(value.testCommand, value.runtime) &&
    value.directories.every(item => typeof item === "string" ||
      ((!item.installCommand || installsWith(item.installCommand, value.runtime)) &&
       (!item.testCommand || testsWith(item.testCommand, value.runtime)))), "commands must use the configured runtime and install/test subcommands");
export type CloudRunnerConfig = z.infer<typeof cloudRunnerSchema>;

export function parseCloudRunner(project: string, value: unknown): CloudRunnerConfig {
  const config = cloudRunnerSchema.parse(value);
  // Public project admission is checked at dispatch so an unlisted opt-in cannot break the board config.
  if (config.enabled && config.source === "localMirror" && !LOCAL_MIRROR_PROJECTS.some(item => item === project)) {
    throw new Error(`Cloud execution is limited to ${LOCAL_MIRROR_PROJECTS.join(", ")}`);
  }
  return config;
}

/** Recheck immediately before export. registeredRepoRoot must come from the project registry,
 * never the card's workspace or an inferred repository slug. Symlink aliases are refused on both sides. */
export function assertLocalMirrorEligibility(input: {
  project: string; repoRoot: string; registeredRepoRoot?: string;
  config: CloudRunnerConfig; role: string; tags: readonly string[];
  profile: { role?: string; candidateFor?: string; provider: string; family?: string; model?: string };
}): void {
  const refuse = () => { throw new KanbanError("cloud_local_mirror_refused", "Local mirror eligibility could not be established"); };
  const { project, repoRoot, registeredRepoRoot, config, role, tags, profile } = input;
  if (!LOCAL_MIRROR_PROJECTS.some(item => item === project) || config.source !== "localMirror" || !config.enabled ||
      role !== "executor" || !(profile.role === "executor" || (profile.role === "candidate" && profile.candidateFor === "executor")) || !tags.includes("cloud") ||
      !((profile.provider === "codex" && profile.family === "openai" && /^gpt-[a-z0-9][a-z0-9.-]*$/i.test(profile.model ?? "")) ||
        (profile.provider === "grok" && profile.family === "xai" && /^grok-[a-z0-9][a-z0-9.-]*$/i.test(profile.model ?? "")))) refuse();
  try {
    if (!registeredRepoRoot || !isAbsolute(repoRoot) || !isAbsolute(registeredRepoRoot) ||
        realpathSync(repoRoot) !== resolve(repoRoot) || realpathSync(registeredRepoRoot) !== resolve(registeredRepoRoot) ||
        realpathSync(repoRoot) !== realpathSync(registeredRepoRoot)) refuse();
    const top = execFileSync("git", ["--no-replace-objects", "-c", "protocol.allow=never", "-C", repoRoot, "rev-parse", "--show-toplevel"], {
      env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_NO_LAZY_FETCH: "1" },
      encoding: "utf8", maxBuffer: 4096, stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    if (realpathSync(top) !== realpathSync(repoRoot)) refuse();
  } catch { refuse(); }
}
