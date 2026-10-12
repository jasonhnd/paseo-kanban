# Installing and updating a Git tag

Paseo 0.11 supports explicit Git sources and selectors:

```sh
paseo plugin install github:jasonhnd/paseo-kanban --ref vX.Y.Z
paseo plugin update paseo-kanban --ref vX.Y.Z

# A local Git repository uses the same managed-clone path.
paseo plugin install "file://$PLUGIN_REPOSITORY" --ref vX.Y.Z
paseo plugin ls paseo-kanban --json
paseo plugin logs paseo-kanban --json
```

Use a published tag that exists in the selected repository. These commands
copy the selected revision into the daemon's managed plugin directory. A plain
directory installation instead references the existing checkout. The selector
does not pin later ordinary updates: supply `--ref` on each tag-based update.

Persistent state is separate from the managed checkout. Server and commands
use `KANBAN_DATA_DIR`, or `PASEO_HOME/plugin-data/paseo-kanban`, with Fleet state
in its `fleet/` child. Compatibility metadata never redirects this root. Retired
storage overrides produce configuration diagnostics. Updating a Git source does
not transfer old data; see [data ownership](DATA.md) and the optional
[user-run manual transfer](MANUAL-MIGRATION.md).

Node 22.13 or newer and npm must be available on the daemon's `PATH`. The
manifest's `build` commands run before compilation on install and update.
`preparation` is not a manifest field in Paseo 0.11.2. See the official
[manifest and preparation reference](https://paseo.sh/docs/plugins/reference#cli-reference).

`server/prepare.mjs` installs dependencies with lifecycle scripts disabled and
development inputs explicitly included, even under `NODE_ENV=production`.
Git checkouts use `npm ci` and the committed lockfile. The host compiler checks
type imports as well as runtime imports, so it needs `@getpaseo/client`,
protocol declarations and Node types. Merely changing imports to `import type`
does not make those packages unnecessary. Zod and the pinned external command
SDKs are production dependencies; compiler and CLI build tools remain
development dependencies.

For a Git checkout, preparation then calls the existing standalone CLI builder.
The eight generated bundles run with Node alone. npm packages omit the repository
scripts and already contain those bundles; their preparation uses `npm install`
when no package-local lockfile exists and checks the prepacked commands without
calling a missing builder. Every preparation failure refuses the candidate.
Paseo retains the previous installation when an update fails.

The daemon-wide plugin switch and the individual plugin must both be enabled
for status `running`. Configure profiles in Paseo before dispatching cards.
An isolated empty-board test can explicitly use `daemon.agentProfiles: []`.
Read the managed directory from `plugin ls`, then run its
`bin/paseo-kanban.mjs --help` and `bin/paseo-kanban.mjs list --json`.

For disposable verification, select a separate daemon with `--home`, write its
`daemon.listen` to an unused loopback port before starting it, disable its relay
and providers, and point `PASEO_URL`, `KANBAN_DATA_DIR` and `TMPDIR` at that environment, with retired storage overrides unset. Create test tags only in a
temporary clone. Stop the selected daemon before removing its temporary data.
