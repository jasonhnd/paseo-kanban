import type { CloudRunnerConfig } from "./cloud-config";

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
  repo: string; branch: string; base: string; source: string; provider: "codex" | "grok";
  model: string; effort: string | null; prompt: string; timeoutSec: number;
  installCommand: string[]; testCommand: string[];
  directories: CloudRunnerConfig["directories"];
  runtimeVersion?: string; environment?: Record<string, string>;
}): string {
  const q = shellQuote;
  const inDirectories = (command: string[], lock: boolean): string => `{\n${input.directories.map(item => {
    const path = typeof item === "string" ? item : item.path;
    const args = lock && typeof item !== "string" ? item.installCommand ?? command : command;
    return `
  (
    export TMPDIR="$KANBAN_TMP" KANBAN_TMP
    cd "$work"/${q(path)}
    case "$(pwd -P)" in "$work"|"$work"/*) ;; *) exit 79 ;; esac
    ${lock ? "test -f package-lock.json" : ""}
    ${args.map(q).join(" ")}
  )
`; }).join("")}\n}`;
  const provider = input.provider === "codex"
    ? `codex exec --dangerously-bypass-approvals-and-sandbox --model ${q(input.model)}${input.effort ? ` -c ${q(`model_reasoning_effort="${input.effort}"`)}` : ""}`
    : `"$HOME/.grok/bin/grok" --always-approve --model ${q(input.model)}${input.effort ? ` --reasoning-effort ${q(input.effort)}` : ""} -p`;
  const prompt = `${input.prompt}\n\nWork only in this public repository. Do not push, create PRs, access credentials, or change Git identity. Use English in code, paths, branch names and commit messages. The host will run npm test, commit with an anonymous identity, scan the bundle and create a draft PR.`;
  return `set -euo pipefail
export GIT_TERMINAL_PROMPT=0
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
unset GH_TOKEN GITHUB_TOKEN GIT_ASKPASS SSH_ASKPASS SSH_AUTH_SOCK
${Object.entries(input.environment ?? {}).map(([key, value]) => `export ${key}=${q(value)}`).join("\n")}
${input.runtimeVersion ? `test "$(node --version)" = ${q(`v${input.runtimeVersion}`)}` : ""}
export GIT_AUTHOR_NAME='Anonymous cloud contributor' GIT_COMMITTER_NAME='Anonymous cloud contributor'
export GIT_AUTHOR_EMAIL=noreply@github.com GIT_COMMITTER_EMAIL=noreply@github.com
mkdir -p "$HOME/work"
work="$HOME/work/paseo-clear-chat"
git -c credential.helper= -c core.askPass= clone --single-branch --branch ${q(input.source)} ${q(`https://github.com/${input.repo}.git`)} "$work"
cd "$work"
work="$(pwd -P)"
git checkout -b ${q(input.branch)}
base=$(git rev-parse HEAD)
git config user.name "$GIT_AUTHOR_NAME"
git config user.email "$GIT_AUTHOR_EMAIL"
# Deny Git pushes even if a template accidentally contains a credential helper.
git config remote.origin.pushurl disabled://cloud-push-forbidden
git config credential.helper ''
${inDirectories(input.installCommand, true)} > "$KANBAN_TMP/npm.log" 2>&1
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
${inDirectories(input.testCommand, false)} > "$KANBAN_TMP/test.log" 2>&1
git add -A
# Flatten any agent-created commits so only the host's anonymous identity is published.
git -c core.hooksPath=/dev/null reset --soft "$base"
if git diff --cached --quiet; then echo PKB_NO_CHANGES; exit 0; fi
git -c core.hooksPath=/dev/null commit -m 'chore: complete cloud task'
git bundle create "$KANBAN_TMP/task.bundle" "$base..${input.branch}"
echo "PKB_BASE=$base"
echo "PKB_HEAD=$(git rev-parse HEAD)"
echo PKB_TEST_OK
`;
}
