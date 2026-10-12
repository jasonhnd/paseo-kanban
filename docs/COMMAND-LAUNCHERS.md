# Standalone commands

The board ships two Node launchers. `bin/paseo-kanban.mjs` is the package bin. `bin/check-missing-cwd` reports cards whose working directory is missing. Both spawn `process.execPath` with an argument array, so a path that contains spaces does not need a shell. `SIGINT` and `SIGTERM` are forwarded to that child.

For the conditional shell launcher [`bin/codex-kanban-launch`](../bin/codex-kanban-launch), see [the Codex wrapper guide](CODEX-WRAPPER.md) for installation and provider configuration.

`npm run build` writes the bundles next to the launchers:

- `bin/cli.bundle.mjs`
- `bin/local-decisions.bundle.mjs`
- `bin/migrate.bundle.mjs`
- `bin/check-missing-cwd.bundle.mjs`

`npm run build` is `node scripts/build-cli.mjs`. Packing runs that build first (`prepack`). The bundles are generated files and are not stored in Git. The package whitelist includes the launchers and `bin/*.bundle.mjs`, so an unpacked install contains them. Running a launcher before the build prints the build instruction and does not start a TypeScript loader.

The command floor is the package `engines` field, Node `>=22.5`, including `node:sqlite`. An unpacked command does not need Python, a package manager, tsx, or development dependencies. Help text is read from `server/protocol` in the same install, which the package already includes. Installing the plugin does not put the launcher on `PATH`; invoke it with Node:

```sh
node "$BOARD_INSTALL/bin/paseo-kanban.mjs" --help
node "$BOARD_INSTALL/bin/paseo-kanban.mjs" decide --help
node "$BOARD_INSTALL/bin/paseo-kanban.mjs" migrate --help
node "$BOARD_INSTALL/bin/check-missing-cwd" --help
```

Fleet command files that end in `.mjs` are started with the current Node executable. Other commands are executed directly after they are found on `PATH`, `~/.local/bin`, or the directory that contains `process.execPath`. The compatibility check uses the `HOME` of the environment it was given, so an isolated home does not pick up another home's `paseo`.
