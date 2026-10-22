# Disposable cloud execution (unreleased)

Cloud execution requires both a project setting and the card tag `cloud`. It is
limited to public `paseo-clear-chat` executor cards using Codex or Grok. Untagged
cards, disabled projects and other roles retain the local workflow. A tagged
card on an enabled project refuses unsupported profiles, including Claude.
Private or unverifiable repositories are blocked before machine creation.

The host proves anonymous repository access before creating a machine from
`tpl-agent`. Each card generation gets a separate machine. Only the template's
existing provider login is used. The board never reads or copies login files,
and GitHub write access stays on the host.

Commands travel as base64-encoded scripts. The machine clones below its HOME,
runs configured installs, executes the selected provider, runs configured tests, and returns a
Git bundle. The host fetches it into a bare, blobless mirror, validates identities
and privacy, pushes only a generated task branch, and creates a draft PR. The
machine is deleted before the ordinary independent-review handoff.

Cloud Codex commands do not set `service_tier` or request fast/priority mode.
Profile admission requires standard speed for every provider, including explicit
profile selection. Disable fast/priority options in the profile before dispatch;
the board refuses such profiles instead of stripping their launch settings.

## Configuration

This example does not change a production switch:

```json
{
  "projects": {
    "paseo-clear-chat": {
      "code": "DEMO",
      "defaultWorkspace": "dir",
      "baseBranch": "main",
      "cloudRunner": {
        "enabled": false,
        "runtime": "npm",
        "runtimeVersion": "24.20.0",
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

The existing project `baseBranch` controls the anonymous clone, task ancestry and
draft PR base. It may be `preview` or another valid branch. Only a generated
`kanban/cloud-...` task branch is pushed; the base is never pushed or merged.
Public branch names use an opaque identifier instead of an internal card code.

| Field | Behavior |
| --- | --- |
| `enabled` | Defaults off; enabling another project is refused. The leader must also mark each eligible executor card with `tags: ["cloud"]`. |
| `runtime` | `npm` is implemented. `bun` is parsed and validated, but execution is explicitly refused as unimplemented. |
| `runtimeVersion` | Optional exact `major.minor.patch` version. For `npm` this is the Node version: the template must already provide it, and a mismatch stops before installing packages and deletes the machine. Bun versions such as `1.4.2` are parsed; Bun installation/execution remains unimplemented. No runtime is installed or switched automatically. |
| `mode` | `per-card` is implemented. `persistent` is reserved and explicitly refused as unimplemented. |
| `directories` | Ordered package directories, default `["."]`. Entries may be strings or objects such as `{"path":"web","installCommand":["npm","ci","--ignore-scripts"]}`; omitted directory commands inherit `installCommand`. Install each in order, run the agent at the root, then test each in order. Any failure stops execution. Empty lists, absolute paths, traversal and symlink escapes are refused. |
| `installCommand`, `testCommand` | Argument arrays using the selected runtime and install/test subcommands, never shell strings. `npm run <script>` is supported. Reserved Bun defaults are `bun install --frozen-lockfile` and `bun test`. |
| `environment` | Non-secret uppercase environment keys with string values, including empty strings. Values are exported literally for installation, the agent and tests. Suspected credentials, names containing `TOKEN`/`SECRET`/`KEY`/`PASSWORD`, and credential/launch/card-scratch overrides are refused. `TMPDIR` and `KANBAN_TMP` always come from the board. |
| `maxParallel` | Default two, range one through five, subject to normal global, role and pool limits. |
| `retryIntervalSec`, `maxCreateAttempts` | Retry delay and bounded capacity attempt budget. Increase the attempt limit to release an exhausted hold. |
| `machineTimeoutSec`, `taskTimeoutSec` | Machine lifetime and total task deadline in seconds; the deadline must be shorter. Creation always requests `--on-timeout kill`. |
| `templateRefreshedAt` | Optional ISO template refresh timestamp. Grok warns at `templateWarnAgeDays` and refuses at `templateMaxAgeDays` (at most seven days). Runtime login errors are recognized even without this field. |
| `mirrorRoot` | Optional absolute host directory, default `_mirrors` beside the configured project directory. One bare, blobless mirror per repository. |

Every remote exec creates `$HOME/work/.kanban-work/<card code>` and exports
`TMPDIR` and `KANBAN_TMP` to that same path. Installation, the agent and tests
inherit it. Logs, the prompt and the bundle stay there too. Host bundles and PR
bodies use the card's managed scratch directory. No credential file or private
denylist is sent to the machine.

The host scans patches, paths and commit metadata for home paths, its username,
internal ticket codes (including short PCC identifiers), CJK, credentials and personal email. It reuses the
repository gate's private-denylist parser and anonymous-identity rule. A missing
private denylist fails closed. Publication text is always English.

## State and recovery

- Success: `ready -> running -> in_review`, with the draft PR and commit in the
  handoff. Review and lead acceptance retain their existing responsibilities.
- First review rejection: the next scheduler tick can start a new cloud
  generation without waiting for a local agent replacement or the prior
  success cooldown. Capacity and quota gates still apply. The second rejection
  retains the existing leader hold.
- `no_capacity`: return to `ready` with a retry deadline and release all running
  slots. The configured attempt limit leaves a queue hold for the leader; it
  never increments the startup failure counter.
- Expired Grok login: block as `capability`, explain that the template needs a
  fresh login, and notify the leader. Warn before dispatch when template age is
  close to its configured maximum.
- Privacy or identity findings: block as `needs_human`; never push the bundle.
- Failed execution or timeout: delete the machine and block as `capability`.
- Cancellation or plugin shutdown: abort the job and delete its machine.
  Startup reconciliation removes only machines under this board's stable
  prefix, preserves runs owned by another live host process, and fences stale
  generations before admitting another cloud run. A persisted PR receipt goes
  to review after cleanup rather than opening another PR. Unconfirmed deletion
  leaves a durable cleanup record, holds admission and notifies the leader as
  `needs_human`; the lifetime kill is the final backstop.

Machine creation always uses a lifetime timeout with `--on-timeout kill`.
Normal global, role and pool admission limits also apply; the cloud limit
defaults to two. Temporary host files use the card's managed scratch directory.

This feature is staged for a later release candidate. Enabling production or
performing a real provider run requires a separate operational task.
Before that trial, refresh and validate the template login, ensure the template
has no GitHub write login, confirm host CLI authentication and the private
denylist, configure the project, and mark the selected card. This change does
not install or publish a release. Local review inspects a disposable copy at the
delivered commit; rework uses a new machine and refreshes that inspection copy.
