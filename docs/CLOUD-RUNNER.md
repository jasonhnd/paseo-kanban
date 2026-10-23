# Disposable cloud execution (unreleased)

Cloud execution requires the project switch `cloudRunner.enabled`, a `cloud`
card tag, an executor card and a supported Codex or Grok profile. It defaults off.
Untagged cards, disabled projects and other roles retain the local workflow.
A tagged card on an enabled project refuses unsupported profiles, including
Claude. Local mirror selection is explicit; a repository name or missing
`origin` never opts a project into cloud execution.

Two source modes are available:

| `source` | Admission and delivery |
| --- | --- |
| `publicGithub` (default when omitted) | Projects in top-level `cloud.allowedProjects` only: prove anonymous GitHub access before creation, clone the configured base, return a bundle, validate it in a host bare mirror, push a generated task branch and create a draft PR. GitHub write access stays on the host. Private or unverifiable repositories are refused. |
| `localMirror` | Explicitly enabled `paseo-kanban` only: export an anonymous tree snapshot from the registered local repository, transfer bundles through InstaBox exec, replay the result onto a managed local card branch, then use independent review and local lead acceptance. The host does not run GitHub discovery, `ls-remote`, `push` or `gh` on this path. |

The local policy is the frozen `LOCAL_MIRROR_PROJECTS = ["paseo-kanban"]` in
`server/cloud-config.ts`; project settings cannot expand it. Immediately before
export and upload, the registered project directory must be an existing
canonical Git top-level directory. Its realpath must equal the selected root;
symlink aliases, nested directories and a card-supplied replacement root fail
closed. The card must have a `local-only` contract without remote publication.
Executor profiles may be executor candidates, with `candidateFor: "executor"`;
reviewer candidates remain ineligible. Codex requires the OpenAI family and a
`gpt-*` model, and Grok the xAI family and a `grok-*` model.

Each generation gets a separate machine from the configured template (default
`tpl-agent`). Only the template's existing provider login is used. The board
never reads or copies host login files. Installs, the agent and tests run on the
machine; deletion must be confirmed before review handoff.

Cloud Codex commands do not set `service_tier` or request fast/priority mode.
Profile admission requires standard speed for every provider, including explicit
profile selection. Disable fast/priority options in the profile before dispatch;
the board refuses such profiles instead of stripping their launch settings.

## Configuration

This example does not change a production switch:

```json
{
  "cloud": { "allowedProjects": [], "maxMachines": 3, "deleteTimeoutSec": 180, "deletePollIntervalSec": 5 },
  "projects": {
    "paseo-clear-chat": {
      "code": "DEMO",
      "defaultWorkspace": "dir",
      "baseBranch": "main",
      "cloudRunner": {
        "enabled": false,
        "source": "publicGithub",
        "runtime": "npm",
        "nodeVersion": "24.20.0",
        "mode": "per-card",
        "directories": ["."],
        "installCommand": ["npm", "ci", "--no-audit", "--no-fund"],
        "testCommand": ["npm", "test"],
        "environment": {
          "BLOB_BASE_URL": "https://example.invalid/blobs",
          "SEO_LIVE_BASE": ""
        },
        "snapshot": "tpl-agent",
        "maxParallel": 2,
        "retryIntervalSec": 75,
        "maxCreateAttempts": 8,
        "machineTimeoutSec": 5400,
        "taskTimeoutSec": 2400,
        "templateMaxAgeDays": 7,
        "templateWarnAgeDays": 6
      }
    }
  }
}
```

Public admission requires all of `cloud.allowedProjects` membership, the project
switch, the cloud tag, executor role, a supported profile and an anonymously
readable public GitHub repository. The project key and repository name may differ.
The example keeps the list empty and the switch off. Add an intended project key
to the list only when opting that project in; listing a private repository never
makes it eligible.

An enabled public project outside the list remains valid configuration. Only its
cloud cards are held, with a refusal reason on each card and one delivered warning
per project to the leader. Failed warning delivery retries on later admission
checks; the warning mark survives reloads and clears when the project is admitted.
Other projects and untagged cards keep their normal dispatch path. An unlisted
project alone does not trigger cloud inventory. Local mirror admission continues
to use the static policy independently of this list.

Top-level `cloud` settings apply to every project and both source modes:

| Field | Default and bounds |
| --- | --- |
| `allowedProjects` | `[]`, array of project keys eligible for `publicGithub` admission. Does not extend `LOCAL_MIRROR_PROJECTS`. |
| `maxMachines` | `3`, integer 1–5. Maximum running cloud card generations across the board; other projects do not count against a project's `maxParallel`. Reserve room for every non-board account machine, including paused/stopped ones. |
| `deleteTimeoutSec` | `180`, integer 1–600. Independent total budget for synchronous `rm` and inventory confirmation, including startup orphan cleanup. |
| `deletePollIntervalSec` | `5`, integer 1–60. Delay between inconclusive inventory checks, capped by the remaining deletion budget. |

The CLI's `rm` waits for its operation by default (`--no-wait` disables that
wait). The runner sends one `rm` with the deletion budget, then checks
`ls --json` until a successful, valid, untruncated inventory no longer lists
the machine. A deleting machine still counts as present. Failed, malformed or
truncated lists cannot prove deletion. Cleanup has a fresh signal after task
cancellation; timeout retains the receipt, refuses review, holds cloud dispatch
and notifies the leader. Startup orphan cleanup uses the same confirmation.

For `publicGithub`, the existing project `baseBranch` controls the anonymous
clone, task ancestry and draft PR base. It may be `preview` or another valid branch. Only a generated
`kanban/cloud-...` task branch is pushed; the base is never pushed or merged.
Public branch names use an opaque identifier instead of an internal card code.

| Field | Behavior |
| --- | --- |
| `enabled` | Defaults off. The leader must also mark each eligible executor card with `tags: ["cloud"]`; source-specific project admission still applies. |
| `source` | `publicGithub` when omitted; `localMirror` requires explicit selection and its static allowlist/root checks. Selecting a source alone leaves execution off. |
| `maxSourceBytes`, `maxResultBytes` | Local mirror bundle limits, each default `10485760` (10 MiB), positive safe integers. Source size is checked before machine creation; result size before downloading blocks and again before import. These count raw bundle bytes, before base64 encoding. |
| `runtime` | `npm` and `bun` are supported. Before installing in each directory, npm requires `package-lock.json`; Bun requires `bun.lock` or `bun.lockb`. A missing lock stops execution. |
| `nodeVersion`, `bunVersion` | Optional exact `major.minor.patch` pins, checked separately against `node --version` and `bun --version` before package installation. Node must already exist in the template. Missing or mismatched versions fail the task with a reason and delete the machine. |
| `runtimeVersion` | Legacy alias for `nodeVersion`, for either runtime. An explicit `nodeVersion` takes precedence. |
| `bunSha256` | Optional map from exact Bun version to architecture digests, e.g. `{ "1.4.2": { "x64": "<64 lowercase hex characters>", "aarch64": "<64 lowercase hex characters>" } }`. Required for the selected version when `installBun` is true. Missing architecture digests fail installation. |
| `installBun` | Defaults false. When true, requires `bunVersion` and a matching `bunSha256` entry and installs that exact version only if Bun is missing or mismatched; installation failure or a wrong resulting version fails the task and deletes the machine. |
| `mode` | `per-card` is implemented. `persistent` is reserved and explicitly refused as unimplemented. |
| `directories` | Ordered package directories, default `["."]`. Entries may be strings or objects such as `{"path":"web","installCommand":["npm","ci","--ignore-scripts"]}`; omitted directory install commands inherit `installCommand`. Each object also accepts `optional` (default false), `testCommand` (inherits the project default), and `skipTest` (default false; install only). A missing optional directory skips installation and tests and records `skipped (optional, missing)` in verification; an existing optional directory still requires its runtime lockfile. Missing required directories fail. Directory commands use the configured runtime and the same subcommand validation as project commands. Install each in order, run the agent at the root, then test each in order. Any failure stops execution. Empty lists, absolute paths, traversal and symlink escapes are refused. |
| `installCommand`, `testCommand` | Argument arrays using the selected runtime and install/test subcommands, never shell strings. `npm run <script>` is supported. Bun defaults are `bun install --frozen-lockfile` and `bun test`. |
| `environment` | Non-secret uppercase environment keys with string values, including empty strings. Values are exported literally for installation, the agent and tests. Suspected credentials, names containing `TOKEN`/`SECRET`/`KEY`/`PASSWORD`, and credential/launch/card-scratch overrides are refused. `TMPDIR` and `KANBAN_TMP` always come from the board. |
| `maxParallel` | Per-project running cloud limit, default two, range one through five. Checked independently of the board-wide `cloud.maxMachines` and normal global, role and pool limits. |
| `reconcileRetrySec` | Inventory/startup reconciliation backoff in seconds, default `[120,300,600,900]`; 1–16 positive integer entries, each at most 900 seconds. The first 120-second delay spans the default 60-second scheduler period and ordinary timer drift; keep custom first delays longer than the scheduler period too. The last entry repeats. Shared board inventory uses the shortest enabled project delay. While waiting, ticks skip the CLI and cloud cards remain held until reconciliation succeeds. The first failure and recovery each notify the leader through AFC once; failure diagnostics redact credentials, URLs and home paths. Delay state resets on plugin restart; delivered failure notices persist across restart. |
| `retryIntervalSec`, `maxCreateAttempts` | Retry delay and bounded capacity attempt budget. Increase the attempt limit to release an exhausted hold. |
| `machineTimeoutSec`, `taskTimeoutSec` | Default `5400` / `2400` seconds (each 1–86400); task deadline must be shorter than machine lifetime. The host deadline covers export, creation, upload, agent/tests, download and import together. Cancellation and timeout abort active work; cleanup uses fresh signals and its own bounded calls. Creation always requests `--on-timeout kill`. |
| `templateRefreshedAt` | Optional ISO template refresh timestamp. Grok warns at `templateWarnAgeDays` and refuses at `templateMaxAgeDays` (at most seven days). Runtime login errors are recognized even without this field. |
| `mirrorRoot` | Public mode only: optional absolute host directory, default `mirrors/` under the board data directory (`KANBAN_DATA_DIR` when set). One bare, blobless mirror per project. Independent of any local workspace; existing explicit overrides keep their location. |

Public GitHub projects do not need `workspacePath`. Set `projects.<project>.repo` to
`owner/name` or a GitHub HTTPS/SSH repository URL. The legacy `repository` alias is
also accepted; `repo` takes precedence. Config reads normalize the identity to
`owner/name`, reject invalid identities, and retain it through config, workspace,
project-code (`setProjectCode` or CLI `project --code`) and settings saves,
including a combined CLI workspace/code edit. Without a local workspace, failed/cancelled runs restore the
absent workspace; successful runs provide the mirror for independent review.
Rework retains that original absence. Local mirror mode still requires and uses
its registered repository root. Existing implicit sibling `_mirrors` directories
are not migrated; set `mirrorRoot` explicitly to keep using one.

The cloud task explicitly exports `BUN_INSTALL="$HOME/.bun"` and prepends
`$BUN_INSTALL/bin` to `PATH` for installation, the agent and tests. Optional Bun
installation downloads `bun-linux-x64.zip` or `bun-linux-aarch64.zip` from
`https://github.com/oven-sh/bun/releases/download/bun-v<bunVersion>/`, selected
by `uname -m` (`x86_64`, `aarch64` or `arm64`). It checks the archive with
`sha256sum` against `bunSha256[bunVersion][architecture]` before extracting
only the Bun executable into `$HOME/.bun/bin`, then checks `bun --version`.
No remote installer script runs. The template needs curl, bash, sha256sum and
unzip. Unsupported architectures, absent digests, download/checksum/extraction
failures and a wrong resulting version fail the task and delete the machine.
For a template already pinned to the project's Bun version, leave
`installBun: false`.

For a new version, obtain each required archive from the official
[GitHub release](https://github.com/oven-sh/bun/releases), verify its provenance
and compare its SHA-256 with the release's published digest through a trusted
channel. Add the reviewed lowercase 64-character archive digests under that
exact version in `bunSha256`, then update `bunVersion` together. Do not derive
the expected digest from the cloud download itself. There is no implicit
fallback for versions or architectures absent from this configured digest map.

Every remote exec creates `$HOME/work/.kanban-work/<card code>` and exports
`TMPDIR` and `KANBAN_TMP` to that same path. Installation, the agent and tests
inherit it. Logs, the prompt and the bundle stay there too. Host bundles and PR
bodies use the card's managed scratch directory. No credential file or private
denylist is sent to the machine.

### Local mirror configuration and snapshot mapping

This separate, disabled example shows the local mode's required production
fields. Set `workspacePath` to the project's registered canonical checkout;
`baseBranch` must exist there. Keep the switch off until the operational trial.
Other execution settings from the table above apply to both modes.

```json
{
  "projects": {
    "paseo-kanban": {
      "code": "DEMO",
      "defaultWorkspace": "dir",
      "workspacePath": "/srv/projects/paseo-kanban",
      "baseBranch": "main",
      "cloudRunner": {
        "enabled": false,
        "source": "localMirror",
        "snapshot": "tpl-agent",
        "maxSourceBytes": 10485760,
        "maxResultBytes": 10485760,
        "maxParallel": 1,
        "taskTimeoutSec": 2400,
        "machineTimeoutSec": 5400
      }
    }
  }
}
```

The host pins real base commit **A**, then exports only its tree into a new,
anonymous, parentless commit **S**, with `tree(S) = tree(A)`. The ordinary,
self-contained source bundle clones into an empty repository. Original history,
author/message metadata, other refs, Git configuration and untracked or
uncommitted files stay on the host. A depth-one shallow bundle is unsuitable
for this protocol.

The machine returns exactly one anonymous child **C** of S in a result bundle.
The host checks the advertised ref, parent, metadata, tree, complete object
closure and file inventory in isolation. It replays S→C onto real A, producing
**L** on this card's owned, writable local branch. Thus `parent(L) = A` and
`tree(L) = tree(C)`. Independent review inspects L, and landing checks that the
branch still matches the recorded L under the repository lock. Completion
leaves the base branch untouched; lead acceptance uses the existing local
fast-forward/rebase workflow. Conflicts return the card for rework. C belongs
to the anonymous snapshot history and is never landed directly.

The local receipt binds project/root, `sourceBase` (A), `snapshotCommit` (S),
`tree`, `cloudHead` (C), `localHead` (L), `runId` and `generation`. It requires
no PR URL. Recovery can finish the journaled import or recover L from its
host-stamped receipt without another cloud run. Rework snapshots the previous
L and continues the same owned branch. Separate cards pin their own A even
when the base advances during another card's upload; capacity retries pin and
scan again.

### Privacy and transport boundaries

Before any local mirror machine is created, `scanOutbound` checks the exact
pinned tree: every path (including directories), file mode and blob, including
unchanged files, binaries and extensions ignored by contributor scans. A secret
in an unchanged source file still blocks dispatch. It also scans the actual
brief, review feedback, environment keys/values and transmitted execution
settings (install/test arguments, directories, runtime, provider/model/effort
and template). Rules include the complete host denylist, local paths, internal
ticket identifiers, credentials and personal email. Source locale paths retain
their existing language allowance; uncertain matches and missing rules,
objects or denylist fail closed. Decoded source blob scans have a 128 MiB
aggregate memory limit in addition to the compressed bundle limit.

Exact reviewed source occurrences are bound to path, full line, matched span
and rule; changes invalidate approval. They do not exempt the brief, feedback
or environment. After download the host scans returned patches and paths,
including the real replay L, using the existing stricter output privacy rules
(including CJK rejection), plus anonymous cloud identity checks. Diagnostics
contain categories rather than matching private bytes. The denylist and host
credentials stay on the host. The provider receives the approved source and
prompt; base64 is transport encoding. Machine names and scratch paths still
contain the card code, so snapshot anonymity does not anonymize all scheduling
metadata.

Local bundles travel in numbered base64 blocks through the existing
`instabox exec` channel, without stdin or a file-upload API. Wire blocks cap at
32 KiB and each complete command at 61440 bytes. Both directions verify block
sequence/length/hash and final byte count/SHA-256, then rename atomically.
Retries are bounded; corruption, truncation, size overflow or cancellation
stops the run and cleans staging files. The local task script also refuses
encoded commands above 61440 bytes. Upload/download share the total task
deadline; transfer time depends on block round trips and network conditions,
with no separate throughput guarantee. Machine deletion uses fresh cleanup
signals even after the task deadline expires.

The generated local script clones from the bundle and instructs the agent to
avoid GitHub. It disables ordinary HTTPS/SSH Git transports after clone and
sets a forbidden push URL. This repository policy is not a network sandbox:
other protocols, process networking and command-line Git overrides require a
separate stronger isolation policy. The host's local mirror workflow itself
performs no GitHub operation.

## State and recovery

- Success: `ready -> running -> in_review`, with a draft PR/public receipt or
  local L/local receipt in the handoff. Review and lead acceptance retain their
  existing responsibilities.
- First review rejection: the next scheduler tick can start a new cloud
  generation without waiting for a local agent replacement or the prior
  success cooldown. Capacity and quota gates still apply. The second rejection
  retains the existing leader hold.
- Creation-stage `no_capacity` or `quota_exceeded`: return to `ready` with a retry deadline and
  release all running slots. An execution-stage message does not enter this queue. The configured attempt limit leaves a queue hold for the leader; it
  never increments the startup failure counter.
- Expired Grok login: block as `capability`, explain that the template needs a
  fresh login, and notify the leader. Warn before dispatch when template age is
  close to its configured maximum.
- Privacy or identity findings: stop delivery; outbound/local privacy findings
  block as `needs_human`. No rejected result is published or landed.
- Failed execution or timeout: delete the machine and block as `capability`.
- Cancellation or plugin shutdown: abort the job and delete its machine.
  Startup reconciliation removes only machines under this board's stable
  prefix, preserves runs owned by another live host process, and fences stale
  generations before admitting another cloud run. A persisted public or local
  receipt goes to review after cleanup rather than repeating execution, replay
  or PR creation. Unconfirmed deletion leaves a durable cleanup record, holds
  admission and notifies the leader as
  `needs_human`; the lifetime kill is the final backstop.

Machine creation always uses a lifetime timeout with `--on-timeout kill`.
Normal global, role and pool admission limits also apply; the cloud limit
is three across the board and two per project. Temporary host files use the
card's managed scratch directory.

## Known limitations

- InstaBox's documented creation options provide no network isolation or
  outbound restriction setting. Cloud processes can make anonymous outbound
  requests, including to GitHub, even without GitHub write credentials. The
  host's `localMirror` orchestration makes zero GitHub calls; this property
  does not isolate the cloud process network.
- The documented default account limit is five machines, including paused and
  stopped machines. Subtract resident/non-board machines before setting
  `cloud.maxMachines`: two resident machines leave three card machines. The
  board does not discover spare account capacity automatically, and separate
  board instances sharing an account need a coordinated budget.
- Exec is limited to 32 simultaneous calls per account and ten minutes per
  command. A larger `taskTimeoutSec` does not extend the provider's per-command
  cap; long agent/test commands can still fail at that cap.
- Machine names and cloud temporary directories contain the card code. The
  anonymous source snapshot does not conceal those identifiers.

Sources: [InstaBox limits](https://instabox.sh/docs/limits),
[SDK options and error codes](https://instabox.sh/docs/sdk),
[CLI reference](https://instabox.sh/docs/cli). Check actual account limits before
an operational trial; provider limits can change.

## Local verification and operational trial

Development verification uses real disposable Git repositories and fake cloud,
provider and GitHub commands. Run `npm ci`, `npm run hooks`, then, with
`KANBAN_TOKEN` and `PASEO_AGENT_ID` unset, run `npm run typecheck`,
`npm run build` and the complete `npm run verify`. Point `TMPDIR` and
`KANBAN_TMP`, `HOME`, `PASEO_HOME` and `KANBAN_DATA_DIR` at separate directories
under the current card's managed scratch. Preserve results before
cleanup. The cloud suites cover public-default compatibility, local opt-in,
privacy and source mapping, malicious results, transfer faults, concurrent
bases, receipt recovery, review/landing conflicts and deletion on failures,
cancellation, timeout and shutdown. Local checks precede independent review
and lead acceptance; they do not exercise a real account or template.

This feature is staged for a later release candidate. A person must complete
a separate operational task before a real trial:

1. Set the production project registry's canonical `workspacePath` and existing
   `baseBranch`; explicitly choose `cloudRunner.source: "localMirror"` only for
   the allowlisted project. Confirm the local-only card contract, supported
   standard-speed executor profile and intended `cloud` tag.
2. Verify host InstaBox CLI authentication and private denylist availability.
   Refresh and test the provider login in the configured `snapshot`; set its
   accurate `templateRefreshedAt`. Confirm template Node/Git/timeout tools and
   the configured runtime version/install/test commands, and remove GitHub
   write logins from the template. Host login files are never copied.
3. Check account usage, including every paused/stopped and non-board machine,
   and deletion/timeout behavior. Set top-level `cloud.maxMachines` to the
   remaining allowance and each project's `maxParallel` within board/pool limits.
   Defaults are application limits, not proof of provider capacity.
   Review source/result byte limits and task/machine deadlines for the trial.
4. Enable the project only after those checks. The actual tree, brief, feedback
   and environment must pass the fresh outbound scan. Inspect the returned L,
   local receipt and confirmed deletion, then use ordinary independent review
   and local lead acceptance. Missing/disabled cloud configuration leaves even
   a `cloud`-tagged local project on the normal local executor path.

These documentation and offline checks do not change production settings,
install a release, or authorize a live provider run.
