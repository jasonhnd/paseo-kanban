# paseo-kanban

A cross-project board for coding agents: role-based cards, independent review and lead acceptance. A [Paseo](https://github.com/getpaseo/paseo) plugin.

[Simplified Chinese](docs/zh-CN/README.md)

| Package | Plugin id |
|---|---|
| `@jasonhnd/paseo-kanban` | `paseo-kanban` |

> **Experimental, unreleased.** Sources and commands are included; clean-host installation, desktop mounting and first-card validation remain release gates. No stability or response-time commitment is made.

## One plugin

Paseo Kanban includes the board, Fleet roles, quota, decisions and settings in one package, with one sidebar entry. The board screen id stays `board`, preserving `/plugin/paseo-kanban/board` links and workspace project filtering.

Fleet collectors provide an immutable `paseo-policy/v1` revision to Kanban admission. Missing or invalid policy and unknown protected quota readings hold dispatch. The old `fleet-quota/v1` files and `afc`/`roles` commands remain compatibility interfaces within the new root; they do not select an old Fleet installation. See [data ownership](docs/DATA.md), [policy and compatibility](docs/CONTRACT.md) and [manual transfer](docs/MANUAL-MIGRATION.md).

## Requirements

- Paseo daemon **and desktop app** `>=0.11.0 <0.12.0`; plugins enabled globally and individually.
- Node >=22.13.0 with working `node:sqlite`. This package floor does not certify every Node/OS combination.
- Git for code cards and workspaces; npm for source builds and plugin Git preparation on the daemon's PATH.
- At least one user-installed/authenticated local provider for investigation; **two confirmed, nonempty actual models** for the current automatic executor/reviewer card flow.
- macOS and Linux are initial release targets, subject to separate real-world validation. Native Windows is not initially supported; WSL2 must be checked separately. See the [evidence matrix](docs/COMPATIBILITY.md).

## Five-minute setup: installation to the first finished card

Five minutes describes configuration guidance when Paseo and authenticated local providers are already ready. Downloads, login, model startup and agent execution can take longer. This is an **experimental walkthrough awaiting clean-host acceptance**, not a promise that every installation works. Roles are currently preview-only/manual; review compares the two actual model names after trim/lower normalization. Different models in one family are allowed; the same model across providers, modes or effort settings is refused. Missing model evidence holds review.

1. Run `paseo --version` and `node --version`; check the app version too. Meet [Requirements](#requirements). Log in through your provider yourself.
2. After a separately approved first release, install the single plugin:

   ```sh
   paseo plugin install npm:@jasonhnd/paseo-kanban
   paseo plugin ls
   ```

   In host Settings -> Plugins, enable the global switch and the plugin. Check their status **and open the desktop panels**. To evaluate source before publication, use a checkout and the build instructions below; do not assume the npm package or release tags are already available.
3. Choose English or Simplified Chinese in the combined Settings page. Fleet role setup previews the available catalog; manually configure suitable Paseo profiles while preserving existing entries. Configure role, pool and an explicit actual model for the leader, executor and reviewer. The reviewer must use a different actual model. Preview does not save profiles or verify login. Configure your own pools and policy; unknown protected readings keep admission closed. New installations start in a fresh root, and nonempty retired Fleet storage overrides must be unset. See the manual transfer guide before reusing old state.
4. Create a disposable Git repository/workspace named `demo` with an initial commit. In Kanban project settings, configure its workspace, short code and protected branches. In the project leader panel, choose the leader profile/workspace/language, preview and start the leader. Check protocol delivery. Selecting the same profile in an ordinary conversation is insufficient.
5. In that leader session, call `kanban_supervise` for project `demo`, or run:

   ```sh
   node "$BOARD_INSTALL/bin/paseo-kanban.mjs" supervise --project demo
   ```

   `BOARD_INSTALL` is the current installed directory from `paseo plugin ls --json`. The session uses its own injected identity; do not paste tokens. Confirm registration in the panel. Hand over a live existing leader rather than replacing it.
6. Ask the leader: "Create an L1 card to add hello.md containing exactly Hello and a newline in the demo repository. Verify the file and content. Commit, review and accept locally; do not push or publish." The executor commits and completes its handoff, an independent reviewer checks it, and the lead verifies evidence and accepts it. Check that the card is finished, the file is correct, the working tree is clean and managed cleanup has completed.
7. On failure, use [Compatibility and troubleshooting](docs/COMPATIBILITY.md), plugin logs and the installed Node doctor. Missing protocol or registration blocks dispatch. A real provider first-card cycle and app/phone behavior still require independent acceptance.

Git installations use `paseo plugin install github:jasonhnd/paseo-kanban --ref vX.Y.Z` only after a published, validated tag exists. Always specify `--ref` on updates. Directory installation uses `paseo plugin install "$PLUGIN_CHECKOUT"` after the appropriate source build; a directory source does not select a Git tag. Read the [manual release/update checklist](docs/RELEASE.md) before replacing an existing source.

## Documentation

[Workflow](docs/WORKFLOW.md) · [Data and privacy](docs/DATA.md) · [Compatibility](docs/COMPATIBILITY.md) · [Release/update](docs/RELEASE.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Changelog](CHANGELOG.md)

## Installed commands and evidence

Run `npm run build` before using Node launchers in a source checkout. npm prepack includes generated bundles; Git installation runs manifest `build` via `server/prepare.mjs`. See [Git installation and updates](docs/GIT-INSTALL.md) and [command launchers](docs/COMMAND-LAUNCHERS.md).

The optional [Codex shell wrapper](docs/CODEX-WRAPPER.md) has separate configuration and platform requirements. [Write provenance](docs/WRITE-PROVENANCE.md) audits authenticated identity only; it does not establish provider thread/turn provenance. [Toolchain validation](docs/TOOLCHAIN-VALIDATION.md) records local build and regression evidence, separate from clean-host desktop acceptance. [Antigravity authorization](docs/ANTIGRAVITY-AUTHORIZATION.md) records the temporary dispatch boundary. Those local checks do not establish a live provider session.

## Privacy gates

Nothing personal may ever reach this repository or a published package. Three gates enforce it from the first commit:

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

Command bundles are generated with esbuild at build/prepack time. The published commands run with Node alone; tsx and all other tools are development dependencies. Run `npm run build` before invoking a command from a source checkout. The package whitelist includes only command launchers and generated bundles under `bin/`, never the test or coverage runners. Imported suites retain their existing locale preload, private temporary directories, signal handling and required performance tests; those tests start only after regression workers exit.

The canonical contract manifest is checked together with real compatibility, immutable policy and review-model fixtures. Gate-command negative tests reject a changed package check, missing gate, duplicate plugin or mismatched lock. Legacy cross-repository comparison utilities are retained as tested tools; release verification uses the integrated single source.

When the private denylist flags a word that is not personal in context (a short term), change the wording in the code; do not weaken the list.


## License

[MIT](LICENSE)
