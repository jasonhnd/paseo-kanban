# Fresh installation and manual transfer

New installations use `KANBAN_DATA_DIR`, or
`PASEO_HOME/plugin-data/paseo-kanban` (default `~/.paseo`). The board owns the root,
Fleet owns `fleet/`, and compatibility exports live in `exports/fleet/`.
All server and command entries resolve the same root. Nonempty `AFC_DATA_DIR`,
`ROLES_STATE_DIR` or `AFC_LEGACY_DATA_DIR` produce configuration errors rather
than activating another directory. No legacy directory is automatically selected.

1. Identify each old source yourself from its configuration. The board may use
   its old plugin's `data/` or a configured plugin-data root; Fleet may use an
   explicit old configuration or `~/.config/fleet-roles`. These are source-derived
   possibilities, not inspection of your installation.
2. Stop every old service, scheduled task and command writer. Make your own
   recoverable backups before copying anything. SQLite files require a consistent
   stopped backup, including any outstanding WAL/SHM data. Configure a new empty root.
3. The board transfer allowlist is `kanban.db`, `kanban.config.json` and
   `kanban-decisions.json`. The Fleet allowlist is `plans.json`, `afc.config.json`,
   `decisions.json`, `paused-projects.json`, `panel-prefs.json`
   and `access-map.json`. Copy only individually approved board files to the root
   and Fleet files to `fleet/`. Validate JSON against the shipped schemas.
   No recursive overlay is supported.
4. Never silently replace an existing destination or concatenate records.
   Preserve both copies and let the user resolve conflicts before enabling writers.
   Check absolute project and installation paths before reusing configuration.
5. Recompute generated state. Do not transfer quota-companies.json, policy snapshots, locks, sampling claims,
   control files, native sessions, audit histories or temporary files. Unresolved
   models and unknown protected readings keep admission closed.
6. Credentials and provider authorization must be set up separately by the user.
   Do not copy old keys, `secrets/`, `state/cursor-token.json` or `supervisor.token`.
   Enable only `paseo-kanban` and verify the selected root before starting writers.

This guide is not migration evidence. This stage validates anonymous fresh installs,
without an automatic transfer framework, production data inspection or deployment.
