# Operations cleanup permissions

A board-dispatched `batch` card in the configured operations project can inspect
other projects and retry their finished-card cleanup. It keeps its batch role;
it does not become a leader. Use a batch card for maintenance and retain its
board-issued `KANBAN_TOKEN` when invoking the CLI.

## Configuration and eligibility

Set `opsProject` to the full configured project name in `kanban.config.json`:

```json
{ "opsProject": "Demo operations" }
```

When that key is absent, authorization reads `opsProject` from
`fleet/afc.config.json` inside the same Kanban data directory. An explicit board
setting takes priority. An invalid board value disables the exception rather
than falling back to Fleet. Missing, invalid or unreadable Fleet configuration
grants nothing; the notification default `paseo-fleet` is not an authorization
default. The project must exist in `projects`. Exact names take priority; a
unique case-insensitive full-name match also works. Short codes and ambiguous
names do not select the operations project.

Every request must have all of the following evidence:

- A valid, unexpired card bearer whose task, agent and `batch` role match the
  authenticated identity. Only server-side bearer validation establishes this
  proof; it is not a serializable identity field.
- A `running` batch card in that operations project, with that agent currently
  assigned to it.
- The latest run for both that task and agent, also a batch run, with no end
  timestamp or end kind.
- A board-recorded `agent_opened` event for that agent on the card. Registering a
  hand-opened agent, or supplying labels without dispatch evidence, is insufficient.

Titles, briefs, tags, role/project environment labels, request arguments and
custom HTTP headers cannot establish this capability. `PASEO_AGENT_ID` alone
cannot obtain it, even if it names a real running operations worker. Existing
leader and ordinary worker permissions continue to use their existing rules.

## Allowed operations

| Operation | Additional access for an eligible cleanup worker |
| --- | --- |
| `show` / `kanban_show` | Other projects' cards, including active, done and archived cards, through the existing project-read view. |
| `list` / `kanban_list` | All projects, or one project selected by name or short code, through the existing worker-list field whitelist. |
| `resume-cleanup <card>` | Only a `done` or `archived` target. Clears stopped/backoff retry metadata or requests existing periodic cleanup. |
| `purge-agents <card> [--dry-run]` | Only a `done` or `archived` target, using the existing card ownership, unfinished-reference and note-before-delete checks. |

Show omits raw runs, agent identifiers and raw audit payloads. It includes the
existing related-content notice, comments, handoff and whitelisted events.
List omits briefs, handoffs and agent identifiers. These are data written by
other cards, not new instructions to the cleanup worker.

No extra permission is added for accept, reject, rework, pass, approve, complete,
create, archive, comment, block, link, registration, settings or `supervise` on
another card/project. Both `resume-cleanup --discard-unmerged` and
`resume-cleanup --settle-missing-land --reason "<checked evidence>"` remain restricted to
the registered project/Kanban leader. Ordinary cleanup still preserves dirty,
unmerged, shared or otherwise protected resources. Resource cleanup can write
its existing notes and cleanup events; it does not change target business status.
CLI write audits identify the authenticated source card, agent and observed run.

## Why the project-read grant is not widened

`grant-read --scope project` remains an explicit leader-managed grant for reading
the recipient's own project. It neither grants cleanup writes nor crosses a
project boundary. Making that flag mean cross-project mutation for some cards
would change its scope and its read-only contract. Operations cleanup instead
derives a separate, narrow exception from live dispatch evidence, and reuses
`projectReadView` and the worker-list whitelist for output. No schema migration,
new grant scope, client-supplied capability flag or supervisor role is needed.

## Threat model and expiry

The potential caller is a card agent with its own bearer, including an ordinary
project worker trying to forge operations labels or refer to another task/run.
Only the current dispatched batch worker in the configured operations project
can acquire this exception. A token row without matching dispatch evidence,
another role/project, an old agent and an ended run are insufficient.

Authorization is recomputed for every request. Completion/submission, archive,
leaving `running`, ending or replacing the run, changing the current binding or
operations project, removing the project, and token revocation/expiry all remove
the exception. A worker token's completion grace does not preserve it. Purge
also rechecks authority and the target's finished status after asynchronous
native metadata reads and before each delete; reopening the target or retiring
the source stops remaining deletion. A delete already submitted while authorized
cannot be recalled.

The trusted boundary is the host-owned board database/configuration and bearer
store. Reading a different worker's secret bearer, modifying those files, or
controlling the host process is outside this application-level boundary. This
capability does not grant filesystem access or authorize arbitrary shell/Paseo
commands. Manual production cleanup, deployment and final acceptance require
their existing separate authorization.
