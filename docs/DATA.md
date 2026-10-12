# Single-plugin data and readers

## Paths and ownership

| Location | Owner and behavior |
| --- | --- |
| `KANBAN_DATA_DIR` | Explicit canonical root for every server and CLI entry. |
| `PASEO_HOME/plugin-data/paseo-kanban` | Default fresh root; Paseo home defaults to `~/.paseo`. |
| Root `kanban.db`, `kanban.config.json`, `kanban-decisions.json` | Kanban durable state. |
| `fleet/` | Fleet policy, decisions, panel preferences, collectors and generated readings. |
| `fleet/policy-snapshot.json` | Immutable policy revision, validated against current control inputs by live and standalone readers. |
| `exports/` and `exports/fleet/` | Board exports and Fleet compatibility projections, both below the new root. |
| Locks, backups, audit files, supervisor credentials and `fleet/secrets/` | Private operational state; never publish or share wholesale. |

`server/storage/root.ts` resolves this root. Nonempty `AFC_DATA_DIR`, `ROLES_STATE_DIR` or `AFC_LEGACY_DATA_DIR` is a configuration error, including when a new root is also set. No old installation directory, declared export directory or sibling plugin is discovered as an active storage root.

## Readers and writers

| Domain | Boundary |
| --- | --- |
| Kanban | Owns board dispatch and configured workspace/agent operations. |
| Fleet service | One start/dispose owner for collectors, policy publications and maintenance loops; uses Kanban's host binding. |
| Admission | Uses the injected immutable policy; standalone commands read the persisted revision. Digests, timestamps, TTL and model gates are validated rather than inferred from process memory. |
| Compatibility | Legacy JSON readers and `afc`/`roles` resolve files below the new root. Export metadata cannot expand role-state read roots. |
| Decisions | Fleet full/open lists and the board's local list preserve ownership and refuse ambiguous duplicate ids. |
| Platform features | Keychain/screen functionality is explicitly unavailable on Linux; anonymous tests never execute live platform probes. |

Sampling cadence (one hour), display expiry (62 minutes) and quota protection (7 minutes) are separate boundaries. A missing source time is not replaced by publication time. The known lack of a global failure stream remains a limitation.

## Manual transfer, backup and testing

Follow [the manual transfer guide](MANUAL-MIGRATION.md) to identify an old source, stop writers, take your own recoverable backup, copy only approved individual files, resolve conflicts and configure credentials yourself. This integration does not migrate data automatically and provides no production migration proof. Generated readings, policy snapshots and control state must be recomputed.

Use only anonymous temporary homes, a new `KANBAN_DATA_DIR`, an explicit local listener and a private `TMPDIR` in tests. Unset retired storage overrides. Do not connect to a personal daemon or read credentials/production state. Stop test processes before cleanup. The explicit actual-host test requires a separately installed public host package via `PASEO_SERVER_DIR` and registers only its own anonymous processes.

Keep state, audit rows, backups, logs and credentials private. Code downgrade does not undo data writes. See [security](../SECURITY.md), [compatibility](COMPATIBILITY.md) and [release](RELEASE.md).
