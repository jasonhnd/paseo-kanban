# Paseo Kanban

A [Paseo](https://github.com/getpaseo/paseo) plugin that combines a cross-project coding-agent board with Fleet roles, quota, decisions and settings. Executors finish cards, a reviewer with a different actual model checks the work, and the project leader accepts it.

[Simplified Chinese](docs/zh-CN/README.md)

> **Experimental Git source.** The public source is on `integration/single-plugin-reviewed`. A versioned release, npm publication and official registry listing are not declared here. Clean-host installation, real app/phone behavior and a real provider first-card cycle still need independent evidence. No stability or response-time commitment is made.

There is one plugin id, `paseo-kanban`, and one standard sidebar entry. The board and Fleet share the `board` screen, `/plugin/paseo-kanban/board` deep link and workspace project filtering. The package metadata is `@jasonhnd/paseo-kanban` version `0.1.0`; metadata alone is not a published npm package or Git tag.

## Requirements

- Paseo **daemon and app** in `>=0.11.0 <0.12.0`, with global plugins and this plugin enabled. **0.11.2** is the command/compiler baseline for this work; the declared range does not certify every patch or client.
- Node **>=22.13.0** with working `node:sqlite`, plus Git and npm on the **daemon host's PATH**. Source acquisition and preparation run there, including when the CLI targets a remote host.
- User-installed, user-authenticated local providers. Automatic executor/reviewer flow needs **two confirmed, nonempty, different actual models**. Discovery is not proof of login or usable quota.
- macOS has local source/CLI/compiler evidence. Linux and WSL2 still need separate real workflow validation; native Windows is not supported for the initial release. See [compatibility](docs/COMPATIBILITY.md).

Paseo plugins are **trusted, unsandboxed code**. Server and preparation code can use the daemon user's files, processes, credentials and network; client code runs in the app. This plugin persists board/Fleet state, operates configured workspaces and agents, and can run Git, Node and configured provider commands. Enabled usage adapters may contact services or invoke local tools. Read [access and data boundaries](docs/DATA.md) before enabling it.

## Install from GitHub

Check the CLI, daemon and app versions, and the daemon's Node environment first. `paseo --version` reports the CLI version, not proof of the app/daemon versions.

```sh
paseo --version
node --version
paseo plugin install github:jasonhnd/paseo-kanban --ref integration/single-plugin-reviewed
paseo plugin ls paseo-kanban --json
```

This uses the official Paseo CLI's GitHub acquisition path. The branch is a real public ref; its tip can change. For repeatable installation, use a reviewed **full commit SHA** from the [release record](docs/RELEASE.md) as `--ref`. These instructions do not mean the plugin has passed the official registry's review. Do not substitute the bare registry id `jasonhnd/paseo-kanban`, an npm source or an invented tag.

1. In the intended host's **Settings -> Plugins**, turn on **Enable plugins** and the individual `paseo-kanban` switch. The global switch starts other individually enabled plugins too. You can enable this plugin with `paseo plugin enable paseo-kanban --json` once the global switch is on.
2. Repeat `paseo plugin ls paseo-kanban --json`; require `running` without a load error. Open **Paseo Kanban** from that host's sidebar. Board, Fleet and Settings should share that entry. Check the actual page; `running` alone does not prove client mounting. A compact viewport does not prove a physical phone.
3. Use the CLI's default daemon only if it is the intended one. For a different daemon, put `--host "$PASEO_TARGET"` before every `plugin` command. [Git installation](docs/GIT-INSTALL.md) explains host selection, version confirmation and developer directory installs.

Installation performs locked dependency preparation and generates the command bundles. End users do not need a development checkout or a separate `npm run build`. An existing plugin with the same id makes `install` fail; use [update](#update-disable-or-remove) for a Git source, or the [source-switch runbook](docs/RELEASE.md#directory-to-git-switch-runbook) for a directory source.

## Configure and finish a first card

1. Choose English or Simplified Chinese in the combined Settings page. Fleet role setup **previews** available profiles; manually configure suitable profiles in Paseo while preserving existing entries. Set roles, pools and explicit actual models for leader, executor and reviewer. Different models in one family are allowed; the same model after trim/lower normalization is refused even across providers, modes or effort. Missing model evidence holds review. Preview does not save profiles or verify login; complete provider login yourself.
2. Configure your own pool sources and policy. Fleet supplies an immutable `paseo-policy/v1` revision to Kanban admission. Missing/invalid policy or unknown protected quota keeps dispatch closed; an unknown reading is not zero. Old `fleet-quota/v1` files and `afc`/`roles` are compatibility interfaces below the same root. Do not register a separate old Fleet plugin.
3. New installs use `KANBAN_DATA_DIR`, or `PASEO_HOME/plugin-data/paseo-kanban` (Paseo home defaults to `~/.paseo`). Unset nonempty retired storage overrides. Existing data is not automatically imported. Read [data ownership](docs/DATA.md) and [manual transfer](docs/MANUAL-MIGRATION.md) before reusing old state.
4. Create a disposable Git repository/workspace named `demo` with an initial commit. In project settings, set its workspace, short code and protected branches. In the project's leader panel, choose a leader profile/workspace/language, preview and start the leader. Confirm protocol delivery. An ordinary conversation using the same profile does not perform this setup.
5. In that leader session, call `kanban_supervise` for project `demo`, or run:

   ```sh
   node "$BOARD_INSTALL/bin/paseo-kanban.mjs" supervise --project demo
   ```

   Set `BOARD_INSTALL` to the current installed path reported by `paseo plugin ls paseo-kanban --json`. Use the same Paseo home/data root as the plugin. The session uses its own injected identity; do not paste tokens. Confirm registration in the panel; hand over an existing live leader instead of replacing it.
6. Ask the leader: "Create an L1 card to add hello.md containing exactly Hello and a newline in the demo repository. Verify the file and content. Commit, review and accept locally; do not push or publish." Require an executor commit and handoff, review by a different actual model, leader acceptance, a finished card, correct file, clean Git status and managed agent/workspace cleanup. This is a validation walkthrough, not a report that the cycle has passed.

Use [workflow](docs/WORKFLOW.md) and [troubleshooting](docs/COMPATIBILITY.md) if dispatch is held. Never share authentication files, raw board databases, backups or unredacted doctor output in an issue.

## Update, disable or remove

Back up state and record the current full revision, source, installed path and enabled state first. Preview and apply an **explicit ref each time**:

```sh
paseo plugin update paseo-kanban --check --ref integration/single-plugin-reviewed --json
paseo plugin update paseo-kanban --ref integration/single-plugin-reviewed --json
paseo plugin ls paseo-kanban --json
```

`--check` previews without installing. `--ref` selects this operation only; a later update without it follows the remote's default HEAD. A full reviewed SHA provides an exact target. Check the installed revision/path and actual UI after the update, and refresh `BOARD_INSTALL` because managed paths can change. Do not edit or build inside a managed checkout. See [release and recovery](docs/RELEASE.md) for backup, exact-SHA rollback and the pending verification checklist.

```sh
paseo plugin disable paseo-kanban --json
paseo plugin enable paseo-kanban --json
paseo plugin remove paseo-kanban --json
```

Disabling stops this plugin; enabling also needs the global switch. Removal deletes a managed Git checkout and may remove host plugin settings, while a directory source checkout is kept. The external data root is separate; removal is not a data reset. Reinstall with the same id/home/root and restore settings deliberately. **Code rollback does not restore data**; restoring a consistent backup is a separate operation that can lose writes made after that backup. A failed managed update retains the prior installation; verify its revision/status. A failed `plugin reload` does not automatically restore the previous bundle.

## Documentation

[Git installation](docs/GIT-INSTALL.md) · [Workflow](docs/WORKFLOW.md) · [Data and privacy](docs/DATA.md) · [Compatibility](docs/COMPATIBILITY.md) · [Release/update](docs/RELEASE.md) · [Security](SECURITY.md) · [Changelog](CHANGELOG.md)

## Developer directory setup

This section is for editing source. It is separate from the GitHub user install above. Start with a clean clone of the public integration branch, install locked dependencies and build before using source launchers:

```sh
git clone --branch integration/single-plugin-reviewed --single-branch https://github.com/jasonhnd/paseo-kanban.git
cd paseo-kanban
npm ci
npm run typecheck
npm run build
```

Only on an isolated development daemon, install a directory with `paseo plugin install "$PLUGIN_CHECKOUT"`, where `PLUGIN_CHECKOUT` is the absolute clone path. Directory sources reference that checkout, are skipped by ordinary Git updates, and use `paseo plugin reload paseo-kanban` after source edits and typechecking. Reload does not require a daemon restart. Do not run these lifecycle commands on an existing installation without a source-switch plan.

Git preparation runs `server/prepare.mjs` through the manifest's `build`. Local `npm pack`/prepack and whitelist checks validate distribution bytes; they do not publish to npm. The eight generated Node bundles are ignored by Git. See [Git preparation](docs/GIT-INSTALL.md#git-preparation-and-local-development) and [command launchers](docs/COMMAND-LAUNCHERS.md); the package's Node floor above governs this integrated version.

The optional [Codex shell wrapper](docs/CODEX-WRAPPER.md) needs separate configuration/platform checks. [Write provenance](docs/WRITE-PROVENANCE.md) audits authenticated identity, not provider turn provenance. [Toolchain validation](docs/TOOLCHAIN-VALIDATION.md) records local evidence, separate from real app/provider acceptance. [Antigravity authorization](docs/ANTIGRAVITY-AUTHORIZATION.md) documents that adapter's dispatch boundary.

## Privacy gates

Keep personal state out of this repository and distribution artifacts. These contributor checks apply to the Git source and locally packed artifacts; npm is not a release channel for this batch. Three gates enforce it from the first commit:

1. **pre-commit** (`.githooks/pre-commit`): `scripts/check-private.mjs` scans the staged files against the generic rules in `scripts/private-scan.rules.json` (home paths, e-mail addresses, ids, board card numbers, keys and tokens, CJK text outside the zh-CN files (`locales/zh-CN.json` or `locales/zh-CN/`, optionally under `shared/`; `server/protocol/zh-CN/`; `docs/zh-CN/`), real data files) **and** your private denylist; `scripts/check-identity.mjs` refuses any author or committer that is not the placeholder or a GitHub noreply address; `gitleaks` runs when installed.
2. **`npm run verify`**, run by **pre-push** (`.githooks/pre-push`): thirteen local gates covering types, script/plugin tests, CLI and actual Paseo compilation, source/history privacy, identities, secrets, single-source contract/gate invariants and actual package bytes. Pre-push scans each outgoing ref's complete reachable history and annotated tags, then exports and verifies its exact commit with locked dependencies. It refuses publication when any check fails. Hosted CI is not required or enabled by this integration.
3. **npm `files` whitelist** in `package.json`, checked by `scripts/check-package-files.mjs` against the extracted bytes from a real `npm pack` artifact.

### Contributor setup

```sh
npm ci                                       # install locked development dependencies
npm run hooks                                # git config core.hooksPath .githooks
git config user.name "paseo-fleet contributors"
git config user.email "<id>+<user>@users.noreply.github.com"   # or noreply@example.invalid
mkdir -p ~/.config/paseo-fleet
cp scripts/private-denylist.example.txt ~/.config/paseo-fleet/private-denylist.txt   # then add your own terms
brew install gitleaks                        # or any other install; npm run verify needs it
```

The private denylist lists everything that identifies you (login name, real name, project and folder names). It stays outside every repository; a local commit is refused while it is missing. Use `FLEET_PRIVATE_DENYLIST=<path>` to keep it elsewhere.

### Checks

```sh
npm run verify        # required local gates including builds, plugin tests and gitleaks
sh .githooks/pre-push </dev/null   # the push gate itself, without pushing anything
npm run build:check   # strict actual compiler; set PASEO_SERVER_DIR to the public host package if needed
npm run typecheck     # tsc on the plugin
npm test              # shared gate-script tests; verify also runs plugin tests
npm run test:plugin   # tsx, locale preload and separate regression/performance phases
npm run build         # generate standalone Node command bundles; also runs before npm pack
npm run scan          # check-private.mjs --all: whole tree, generic rules + private denylist
npm run identity      # check-identity.mjs --history: every commit's author and committer
npm run pack:check    # check-package-files.mjs: what npm would publish
npm run contract:check
npm run shared:check  # one package/lock/plugin identity and the complete effective local gates
```

Command bundles are generated with esbuild at build/prepack time. The generated commands run with Node alone; tsx and all other tools are development dependencies. Run `npm run build` before invoking a command from a source checkout. The package whitelist includes only command launchers and generated bundles under `bin/`, never the test or coverage runners. Imported suites retain their existing locale preload, private temporary directories, signal handling and required performance tests; those tests start only after regression workers exit.

The canonical contract manifest is checked together with real compatibility, immutable policy and review-model fixtures. Gate-command negative tests reject a changed package check, missing gate, duplicate plugin or mismatched lock. Legacy cross-repository comparison utilities are retained as tested tools; release verification uses the integrated single source.

When the private denylist flags a word that is not personal in context (a short term), change the wording in the code; do not weaken the list.


## License

[MIT](LICENSE)
