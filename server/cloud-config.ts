import { z } from "zod";

export const CLOUD_PROJECT = "paseo-clear-chat";
const seconds = z.number().int().min(1).max(86_400);
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
const installsWith = (args: string[], runtime: string): boolean => args[0] === runtime &&
  (runtime === "npm" ? ["ci", "install"] : ["install"]).includes(args[1]);
export const cloudRunnerSchema = z.object({
  enabled: z.boolean().default(false),
  runtime: z.enum(["npm", "bun"]).default("npm"),
  runtimeVersion: z.string().regex(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/).max(32).optional(),
  mode: z.enum(["per-card", "persistent"]).default("per-card"),
  directories: z.array(z.union([directory, z.object({ path: directory, installCommand: command.optional() }).strict()]))
    .min(1).max(32).default(["."]),
  installCommand: command.optional(),
  testCommand: command.optional(),
  environment: z.record(environmentKey, environmentValue).default({}),
  snapshot: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/).default("tpl-agent"),
  maxParallel: z.number().int().min(1).max(5).default(2),
  retryIntervalSec: seconds.default(75),
  maxCreateAttempts: z.number().int().min(1).max(100).default(8),
  machineTimeoutSec: seconds.default(5400),
  taskTimeoutSec: seconds.default(2400),
  templateRefreshedAt: z.iso.datetime({ offset: true }).optional(),
  templateMaxAgeDays: z.number().min(1).max(7).default(7),
  templateWarnAgeDays: z.number().min(0).max(7).default(6),
  mirrorRoot: z.string().refine(value => value.startsWith("/"), "mirrorRoot must be absolute").optional(),
}).strict().refine(value => value.taskTimeoutSec < value.machineTimeoutSec, "task timeout must be shorter than machine lifetime")
  .refine(value => value.templateWarnAgeDays < value.templateMaxAgeDays, "template warning must precede expiry")
  .transform(value => ({ ...value,
    installCommand: value.installCommand ?? (value.runtime === "npm" ? ["npm", "ci", "--no-audit", "--no-fund"] : ["bun", "install", "--frozen-lockfile"]),
    testCommand: value.testCommand ?? [value.runtime, "test"],
  })).refine(value => installsWith(value.installCommand, value.runtime) && value.testCommand[0] === value.runtime &&
    value.directories.every(item => typeof item === "string" || !item.installCommand || installsWith(item.installCommand, value.runtime)) &&
    (value.testCommand[1] === "test" || (value.testCommand[1] === "run" && value.testCommand.length >= 3)), "commands must use the configured runtime and install/test subcommands");
export type CloudRunnerConfig = z.infer<typeof cloudRunnerSchema>;

export function parseCloudRunner(project: string, value: unknown): CloudRunnerConfig {
  const config = cloudRunnerSchema.parse(value);
  if (config.enabled && project !== CLOUD_PROJECT) throw new Error(`Cloud execution is limited to ${CLOUD_PROJECT}`);
  return config;
}
