import type { CloudRunnerConfig } from "./cloud-config";

type CloudDirectoryOptions = Partial<Exclude<CloudRunnerConfig["directories"][number], string>>;

type CloudDirectory = CloudRunnerConfig["directories"][number] & { testCommand?: string[]; skipTest?: boolean };

/** Render only configured commands and repository-relative directory names for user-facing cloud receipts. */
export function cloudValidationSteps(config: Pick<CloudRunnerConfig, "runtime" | "installCommand" | "testCommand" | "directories">): string[] {
  return config.directories.flatMap(item => {
    const directory = item as CloudDirectory;
    const path = typeof item === "string" ? item : item.path;
    const install = typeof item === "string" ? config.installCommand : item.installCommand ?? config.installCommand;
    const test = directory.testCommand ?? config.testCommand;
    return [`${path}: ${install.join(" ")}${directory.skipTest ? "" : ` and ${test.join(" ")}`}`];
  });
}

export function cloudValidationDescription(config: Pick<CloudRunnerConfig, "runtime" | "installCommand" | "testCommand" | "directories">): string {
  return config.directories.map(item => {
    const directory = item as CloudDirectory;
    const path = typeof item === "string" ? item : item.path;
    const install = typeof item === "string" ? config.installCommand : item.installCommand ?? config.installCommand;
    return `${install.join(" ")}${directory.skipTest ? "" : ` and ${(directory.testCommand ?? config.testCommand).join(" ")}`} in ${path}`;
  }).join("; ");
}

export function cloudDraftPrBody(config: Pick<CloudRunnerConfig, "runtime" | "installCommand" | "testCommand" | "directories">, provider: "codex" | "grok" = "codex", stdout?: string): string {
  const validation = (stdout === undefined ? cloudValidationSteps(config).map(step => `${step} passed`) : cloudDirectoryVerification(config, stdout)).join("; ");
  return `Implemented and tested in a disposable ${provider} sandbox.\n\nValidation: ${validation}. Anonymous bundle scanned on the host. Independent review is required.\n`;
}

export const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
export function encodedCloudCommand(script: string): string { return `echo ${Buffer.from(script).toString("base64")} | base64 -d | bash -l`; }

/** Each exec is a new shell; repeat the card environment before every remote command. */
export function cloudScratchScript(code: string): string {
  if (!/^[A-Z0-9]+_\d+$/.test(code)) throw new Error("Cloud card code is invalid");
  return `set -euo pipefail
export KANBAN_TMP="$HOME/work/.kanban-work/${code}"
export TMPDIR="$KANBAN_TMP"
mkdir -p "$KANBAN_TMP"
`;
}

/** Only public task data and validated non-secret execution settings cross this boundary. */
export function cloudTaskScript(input: {
  repo: string; branch: string; base: string; source: string; localSnapshot?: string; provider: "codex" | "grok";
  model: string; effort: string | null; prompt: string; timeoutSec: number;
  installCommand: string[]; testCommand: string[];
  directories: CloudRunnerConfig["directories"];
  runtime?: CloudRunnerConfig["runtime"]; nodeVersion?: string; bunVersion?: string; installBun?: boolean; bunSha256?: CloudRunnerConfig["bunSha256"];
  runtimeVersion?: string; environment?: Record<string, string>;
}): string {
  const q = shellQuote;
  const runtime = input.runtime ?? input.installCommand[0];
  const nodeVersion = input.nodeVersion ?? input.runtimeVersion;
  if (input.installBun && !input.bunVersion) throw new Error("installBun requires an exact bunVersion");
  const bunDigests = input.bunSha256?.[input.bunVersion ?? ""];
  if (input.installBun && (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(input.bunVersion!) ||
    !bunDigests || !Object.values(bunDigests).some(value => value && /^[a-f0-9]{64}$/.test(value)) ||
    Object.values(bunDigests).some(value => value !== undefined && !/^[a-f0-9]{64}$/.test(value)))) {
    throw new Error("installBun requires bunSha256 for the exact bunVersion");
  }
  const versionCheck = (name: string, version: string, prefix = "") => `if [ "$(${name} --version 2>/dev/null || true)" != ${q(prefix + version)} ]; then
  echo ${q(`PKB_RUNTIME_FAILURE=${name} version mismatch or missing; expected ${version}`)}
  exit 80
fi`;
  const inDirectories = (command: string[], lock: boolean): string => `{\n${input.directories.map((item, index) => {
    const path = typeof item === "string" ? item : item.path;
    const options: CloudDirectoryOptions = typeof item === "string" ? {} : item;
    const args = (lock ? options.installCommand : options.testCommand) ?? command;
    return `
  (
    export TMPDIR="$KANBAN_TMP" KANBAN_TMP
    ${options.optional ? `if [ ! -e "$work"/${q(path)} ] && [ ! -L "$work"/${q(path)} ]; then
      echo ${q(`PKB_DIRECTORY_SKIPPED=${lock ? "install" : "test"}:${index}`)} >&3
      exit 0
    fi` : ""}
    cd "$work"/${q(path)}
    case "$(pwd -P)" in "$work"|"$work"/*) ;; *) exit 79 ;; esac
    ${lock ? (runtime === "bun" ? "test -f bun.lock || test -f bun.lockb" : "test -f package-lock.json") : ""}
    ${!lock && options.skipTest ? ": # skipTest: install only" : args.map(q).join(" ")}
  )
`; }).join("")}\n}`;
  const provider = input.provider === "codex"
    ? `codex exec --dangerously-bypass-approvals-and-sandbox --model ${q(input.model)}${input.effort ? ` -c ${q(`model_reasoning_effort="${input.effort}"`)}` : ""}`
    : `"$HOME/.grok/bin/grok" --always-approve --model ${q(input.model)}${input.effort ? ` --reasoning-effort ${q(input.effort)}` : ""} -p`;
  const local = input.localSnapshot;
  const repositoryName = input.repo.split("/").at(-1) ?? "";
  const checkoutDirectory = !local && /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(repositoryName) ? repositoryName : "repository";
  if (local && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(local)) throw new Error("Invalid local snapshot");
  const prompt = local
    ? `${input.prompt}\n\nWork only in this repository snapshot. Do not access credentials, contact GitHub, push, or change Git identity. Use English in code, paths and commit messages. The host will test and return one anonymous change for independent local review.`
    : `${input.prompt}\n\nWork only in this public repository. Do not push, create PRs, access credentials, or change Git identity. Use English in code, paths, branch names and commit messages. The host will run ${cloudValidationDescription({ runtime: input.runtime ?? "npm", installCommand: input.installCommand, testCommand: input.testCommand, directories: input.directories })}, commit with an anonymous identity, scan the bundle and create a draft PR.`;
  return `set -euo pipefail
export GIT_TERMINAL_PROMPT=0
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
unset GH_TOKEN GITHUB_TOKEN GIT_ASKPASS SSH_ASKPASS SSH_AUTH_SOCK
${Object.entries(input.environment ?? {}).map(([key, value]) => `export ${key}=${q(value)}`).join("\n")}
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
${nodeVersion ? versionCheck("node", nodeVersion, "v") : ""}
${input.installBun ? `if [ "$(bun --version 2>/dev/null || true)" != ${q(input.bunVersion!)} ]; then
  if ! (
    set -euo pipefail
    case "$(uname -m)" in
      x86_64) bun_arch=x64; bun_sha256=${q(bunDigests?.x64 ?? "")} ;;
      aarch64|arm64) bun_arch=aarch64; bun_sha256=${q(bunDigests?.aarch64 ?? "")} ;;
      *) exit 81 ;;
    esac
    test -n "$bun_sha256" || exit 81
    bun_stage="$KANBAN_TMP/bun-release"
    rm -rf "$bun_stage" || exit 81
    mkdir -p "$bun_stage" || exit 81
    trap 'rm -rf "$bun_stage"' EXIT
    curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --output "$bun_stage/bun.zip" ${q(`https://github.com/oven-sh/bun/releases/download/bun-v${input.bunVersion}/bun-linux-`)}"$bun_arch.zip" || exit 81
    bun_actual_sha256="$(sha256sum "$bun_stage/bun.zip")" || exit 81
    test "\${bun_actual_sha256%% *}" = "$bun_sha256" || exit 81
    unzip -q "$bun_stage/bun.zip" "bun-linux-$bun_arch/bun" -d "$bun_stage" || exit 81
    mkdir -p "$BUN_INSTALL/bin" || exit 81
    chmod 755 "$bun_stage/bun-linux-$bun_arch/bun" || exit 81
    mv "$bun_stage/bun-linux-$bun_arch/bun" "$BUN_INSTALL/bin/bun" || exit 81
  ); then
    echo 'PKB_RUNTIME_FAILURE=bun installation failed'
    exit 81
  fi
  hash -r
fi` : ""}
${input.bunVersion ? versionCheck("bun", input.bunVersion) : ""}
export GIT_AUTHOR_NAME='Anonymous cloud contributor' GIT_COMMITTER_NAME='Anonymous cloud contributor'
export GIT_AUTHOR_EMAIL=noreply@github.com GIT_COMMITTER_EMAIL=noreply@github.com
mkdir -p "$HOME/work"
work="$HOME/work"/${q(checkoutDirectory)}
${local ? `git -c protocol.allow=never -c protocol.file.allow=always -c core.hooksPath=/dev/null clone --template= --single-branch --branch source "$KANBAN_TMP/source.bundle" "$work"` : `git -c credential.helper= -c core.askPass= clone --single-branch --branch ${q(input.source)} ${q(`https://github.com/${input.repo}.git`)} "$work"`}
cd "$work"
work="$(pwd -P)"
git checkout -b ${q(input.branch)}
base=$(git rev-parse HEAD)
${local ? `test "$base" = ${q(local)}` : ""}
git config user.name "$GIT_AUTHOR_NAME"
git config user.email "$GIT_AUTHOR_EMAIL"
# Deny Git pushes even if a template accidentally contains a credential helper.
git config remote.origin.pushurl disabled://cloud-push-forbidden
git config credential.helper ''
${local ? `# The local bundle has already been cloned; deny subsequent network Git transports.
git config protocol.https.allow never
git config protocol.ssh.allow never` : ""}
${inDirectories(input.installCommand, true)} 3>&1 > "$KANBAN_TMP/npm.log" 2>&1
echo ${Buffer.from(prompt).toString("base64")} | base64 -d > "$KANBAN_TMP/prompt.md"
export TMPDIR="$KANBAN_TMP" KANBAN_TMP
set +e
timeout ${input.timeoutSec}s ${provider} "$(cat "$KANBAN_TMP/prompt.md")" </dev/null > "$KANBAN_TMP/agent.log" 2>&1
agent_status=$?
set -e
${input.provider === "grok" ? `if grep -Eqi 'not (logged|signed) in|not authenticated|unauthenticated|authentication (expired|required|failed)|(login|session|token|credential).{0,80}(expired|invalid)|(please|run).{0,40}grok login' "$KANBAN_TMP/agent.log"; then echo PKB_GROK_LOGIN_EXPIRED; exit 78; fi` : ""}
if [ "$agent_status" -ne 0 ]; then
  echo "PKB_AGENT_FAILURE=$agent_status"
  tail -c 16000 "$KANBAN_TMP/agent.log"
  exit "$agent_status"
fi
${inDirectories(input.testCommand, false)} 3>&1 > "$KANBAN_TMP/test.log" 2>&1
git add -A
# Flatten any agent-created commits so only the host's anonymous identity is published.
git -c core.hooksPath=/dev/null reset --soft "$base"
if git diff --cached --quiet; then echo PKB_NO_CHANGES; exit 0; fi
${local ? `# Construct exactly one anonymous child, regardless of commits or config written by the agent.
export GIT_AUTHOR_NAME='Anonymous cloud contributor' GIT_COMMITTER_NAME='Anonymous cloud contributor'
export GIT_AUTHOR_EMAIL=noreply@github.com GIT_COMMITTER_EMAIL=noreply@github.com
export GIT_AUTHOR_DATE=2000-01-01T00:00:00Z GIT_COMMITTER_DATE=2000-01-01T00:00:00Z
head=$(git -c core.hooksPath=/dev/null commit-tree "$(git write-tree)" -p "$base" -m 'Complete cloud task')
git update-ref refs/heads/result "$head"
git bundle create "$KANBAN_TMP/task.bundle" "$base..refs/heads/result"
echo "PKB_BASE=$base"
echo "PKB_HEAD=$head"
echo "PKB_TREE=$(git rev-parse \"$head^{tree}\")"
echo PKB_TEST_OK` : `git -c core.hooksPath=/dev/null commit -m 'chore: complete cloud task'
git bundle create "$KANBAN_TMP/task.bundle" "$base..${input.branch}"
echo "PKB_BASE=$base"
echo "PKB_HEAD=$(git rev-parse HEAD)"
echo PKB_TEST_OK`}
`;
}

/** Use stage receipts so absent optional packages are never reported as passed. */
export function cloudDirectoryVerification(config: Pick<CloudRunnerConfig, "directories" | "installCommand" | "testCommand">, stdout: string): string[] {
  const skipped = new Set(stdout.split(/\r?\n/).filter(line => /^PKB_DIRECTORY_SKIPPED=(install|test):\d+$/.test(line)));
  return config.directories.flatMap((item, index) => {
    const path = typeof item === "string" ? item : item.path;
    const options: CloudDirectoryOptions = typeof item === "string" ? {} : item;
    const installMissing = options.optional && skipped.has(`PKB_DIRECTORY_SKIPPED=install:${index}`);
    const testMissing = options.optional && skipped.has(`PKB_DIRECTORY_SKIPPED=test:${index}`);
    if (installMissing && testMissing) return [`${path}: skipped (optional, missing)`];
    return [
      `${path}: ${installMissing ? "install: skipped (optional, missing)" : `${(options.installCommand ?? config.installCommand).join(" ")}: passed on cloud machine`}`,
      `${path}: ${testMissing ? "test: skipped (optional, missing)" : options.skipTest ? "skipped test (skipTest)" : `${(options.testCommand ?? config.testCommand).join(" ")}: passed on cloud machine`}`,
    ];
  });
}
