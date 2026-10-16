# Data, access and backups

## Paths and ownership

Server and all command entries resolve one canonical data root independently of the source checkout:

| Location | Owner and behavior |
| --- | --- |
| `KANBAN_DATA_DIR` | Explicit canonical root. Use a stable absolute path and the same value for the daemon and CLI. |
| `PASEO_HOME/plugin-data/paseo-kanban` | Default fresh root; Paseo home defaults to `~/.paseo`. |
| Root `kanban.db`, `kanban.config.json`, `kanban-decisions.json` | Durable board state, project configuration and board decisions. |
| Root `paseo-projects.json` | The last Paseo project list the board read successfully (see below). Rebuilt by the next successful read; deleting it only makes the board treat every project as present until then. |
| `fleet/` | Fleet configuration, policy, decisions, panel preferences, collectors and readings. |
| `fleet/policy-snapshot.json` | Immutable policy revision checked against current control inputs by live and standalone readers. |
| `exports/` and `exports/fleet/` | Board exports and Fleet compatibility projections below the same root. |
| Locks, backups, audit/log files, supervisor credentials and `fleet/secrets/` | Private operational state; never publish or share wholesale. |
| Paseo host plugin settings and enabled state | Host-owned, outside this plugin's data-root backup; record separately. |
| App/browser preferences | Some client language preferences are local to a client; verify them separately after a source change. |

`server/storage/root.ts` resolves the root. Nonempty `AFC_DATA_DIR`, `ROLES_STATE_DIR` or `AFC_LEGACY_DATA_DIR` is a configuration error, even with a new root set. No old installation directory, declared export directory or sibling plugin is discovered as an active storage root. Keep a custom root outside any managed checkout; managed update/removal can discard that checkout. A relative override may depend on the process working directory, so it is unsuitable for a source switch.

A Git revision changes code location, not this external root. Keep runtime id `paseo-kanban`, `PASEO_HOME` and `KANBAN_DATA_DIR` unchanged when changing sources. Refresh installed CLI paths; do not bind `KANBAN_HOME` to an old managed directory. This is a storage contract, not proof that a production conversion has been performed. Old data is not automatically transferred.

## Which projects exist: Paseo decides

Paseo's project list (`paseo project ls`) is the only list of projects. The board keeps its own project settings, leader table and `fleet/paused-projects.json`, but a board project is shown, woken and dispatched only while its directory is a Paseo project.

- **Matching is by directory, never by name.** Directories are compared after dropping a `dir:` prefix and trailing slashes and resolving symbolic links, so a project that is called something else in Paseo still matches. A project's directory is `projects.<name>.workspacePath` in `kanban.config.json`; without it, the directories of its newest cards (and the recorded root of their temporary workspaces). A project with no known directory is never treated as removed.
- **A project that left Paseo** disappears from the leader panel, the paused area, the home overview, the by-project tab and the board. It gets no leader reminder, wake or nudge, and `create`, `register`, `start` and starting a leader for it are refused with a message saying so. Its cards and history stay: `kanban show` reads a card and `kanban list --include-removed` lists them. Doctor reports no red or yellow for it, only one info line naming the projects it skipped. Adding the directory back to Paseo brings the project back unchanged.
- **If Paseo cannot be read** (daemon down, timeout, unexpected answer, or an empty list) the board keeps using the last list it read, stored in `paseo-projects.json`. Before the first successful read nothing is filtered, as before. The running plugin reads the list through its Paseo client when it binds to Paseo and every 30 seconds; the command line reads `paseo project ls --json` when its stored copy is more than two minutes old, and `kanban start` reads it through its own client.
- **`paused-projects.json` holds only projects that are in Paseo and paused for a while.** A project that left Paseo is handled as above even if it is still listed there, and is not shown as paused.

## Files, processes and network

Paseo plugins are trusted and **unsandboxed**. Their server and preparation code runs with the daemon user's access to files, processes, credentials and network; client contributions run in the app. The following describes behavior, not an enforced permission sandbox:

| Trigger | Access or execution |
| --- | --- |
| Git install/update | Paseo fetches the selected source from GitHub/Git; this plugin's preparation invokes npm using the lockfile and daemon host's configured registry, then Node to build commands. |
| Project/card operation | Reads/writes board/Fleet state, configured project files and Git workspaces; asks Paseo to create, send prompts to, stop and archive configured agents and manage workspaces. Local Git/Node/provider subprocesses may run. Card briefs/task context go to the selected provider through agents. |
| Quota collection | Reads configured pool/policy inputs, asks Paseo for provider usage, and may invoke configured usage tools. Provider tools can contact their own services under the user's provider login. Discovery or a usage reading does not prove a successful card request. |
| Optional Cursor adapter | Uses the plugin's own user-authorized Cursor login for usage/login/refresh requests to `cursor.com` and `api2.cursor.sh`. Sends authentication plus endpoint-specific login/usage request fields; caches its own state. A configured local usage-screen fallback and login watch may run. |
| Optional macOS keychain probe | Uses the local `security` tool for presence/status queries, without requesting secret values; records probe state and may notify configured leaders. |
| Optional Antigravity reader | Invokes local `agy -p "/usage"` for display readings. It does not read other tools' credentials or call a private backend, and does not prove the CLI and Paseo ACP share a quota pool. |

Fresh roots start with `cursor-api`, `keychain` and `antigravity-cli` off. Switches live in `fleet/afc.config.json`; [the example](../examples/afc.config.example.json) uses explicit `false`. Existing Cursor or keychain state markers can keep an **unset** switch on. Explicit `false` overrides that inheritance. Antigravity has no marker-based enablement and needs explicit `true` plus a matching plan. Turning these optional switches off does not disable all core provider usage collection or provider network traffic.

Keep provider login under the user's control. Do not borrow another application's authentication files or move production credentials into a test home. Plugin-owned login state, supervisor credentials, raw prompts, logs, paths and exports can be sensitive even when the public source contains no secrets.

## Readers and writers

| Domain | Boundary |
| --- | --- |
| Kanban | Owns dispatch and configured workspace/agent operations. |
| Fleet service | One start/dispose owner for collectors, policy publications and maintenance loops; uses Kanban's host binding. |
| Admission | Uses the injected immutable policy; standalone commands read its persisted revision. Digests, source times, TTL and model gates are validated. |
| Compatibility | Legacy JSON readers and `afc`/`roles` resolve files below this root; export metadata cannot expand role-state read roots. |
| Decisions | Fleet full/open lists and the board's local list preserve ownership and reject ambiguous duplicate ids. |
| Platform features | Keychain/screen functionality is unavailable on Linux; anonymous tests never execute live platform probes. |

Sampling cadence (one hour), display expiry (62 minutes) and quota protection (7 minutes) are separate. A missing source time is not replaced by publication time. The lack of a global failure stream remains a limitation.

## Backup and data restore

Before an update, downgrade, uninstall/reinstall or source switch:

1. Record the actual data root, full installed revision/source/path, runtime id, enabled state and relevant environment settings. Record counts and settings for later comparison, without publishing raw data.
2. Pause dispatch and stop **all writers**, including plugin loops, running agents/CLI writers and external scheduled helpers. Disabling the plugin alone is not proof that every writer has stopped.
3. Create a private, recoverable backup of the whole canonical root, including `fleet/`, configuration, decisions, exports and any plugin-owned secrets you need to preserve. Use a consistent SQLite backup or a properly closed database. Do not copy only a live `kanban.db` and ignore its WAL; do not combine unrelated database/WAL files. Confirm the backup is readable while writers remain stopped.
4. Save Paseo host plugin settings, language and enabled state separately. A data-root backup does not include these host-owned values or every client-local preference. Keep credentials private and handle their restoration yourself.
5. Preserve the backup outside a managed source directory, with restricted access and a recorded code/schema version. Validate recoverability using anonymous test data before depending on the procedure.

`plugin remove` deletes managed source files and may remove host settings; it does not itself reset this external data root. Reinstall using the same id/home/root and deliberately restore settings/enabled state. Check actual roots for server, board, Fleet, CLI and exports before resuming writers.

**Code rollback and data restore are separate.** Downgrading to a previous Git SHA leaves current data in place. If the old code cannot use that data/schema, do not start it against the root. A separately authorized data restore requires stopped writers and a consistent compatible backup, after preserving the current state. It returns data to the backup time and can lose later writes. Do not automatically restore a backup just because an update failed.

## Manual transfer and isolated testing

Use [manual transfer](MANUAL-MIGRATION.md) only when deliberately moving selected old data: identify the source, stop writers, take your own backup, copy approved individual files, resolve conflicts and configure credentials yourself. Generated readings, policy snapshots and control state must be recomputed. Directory-to-Git conversion does not require importing old Fleet data or moving the root; see the [source-switch runbook](RELEASE.md#directory-to-git-switch-runbook).

Tests use anonymous homes, a fresh `KANBAN_DATA_DIR`, an explicit unused loopback listener and private `TMPDIR`. Unset retired storage overrides; whitelist the child environment and disable optional adapters explicitly. Never connect to a personal daemon or read credentials/production state. Stop test processes before cleanup. `PASEO_SERVER_DIR` for compiler tests must name a separately installed public host package.

Keep state, audit rows, backups, logs and credentials private. Share only manually redacted diagnostic excerpts. See [security](../SECURITY.md), [compatibility](COMPATIBILITY.md) and [release/recovery](RELEASE.md).
