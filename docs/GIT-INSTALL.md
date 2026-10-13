# Git installation and updates

[README](../README.md) is the user quickstart. This guide separates managed Git installation from a developer's directory source. Command syntax is based on the public Paseo **0.11.2** CLI help and [fixed reference](https://github.com/getpaseo/paseo/blob/75953250959979b8f088bbca8dbd6ee61d0151b1/public-docs/plugins/reference.md#cli-reference). Local Git lifecycle and official web-app checks also ran on an isolated macOS host; their scope and remaining GitHub/provider/device checks are in the [replay checklist](RELEASE.md#command-replay-checklist). Help alone does not prove runtime behavior.

## Select the host and source

Install to the intended daemon. **RC `0.1.0-rc.2` is unpublished until the GitHub Release record for `v0.1.0-rc.2` exists, is a prerelease, and its target commit equals the reviewed full commit. While that record is absent, do not run the tag commands as a GitHub install.** `v0.1.0-rc.1` remains the unpublished local preparation and is not moved. With the default local home, after the Release record matches:

```sh
paseo --version
node --version
git --version
npm --version
paseo plugin install github:jasonhnd/paseo-kanban --ref v0.1.0-rc.2 --json
paseo plugin ls paseo-kanban --json
```

The current public source is `https://github.com/jasonhnd/paseo-kanban`, branch `integration/single-plugin-reviewed`, at preparation baseline `c106efb88a659931d01f40a236001823473561a8`. That pre-RC source has metadata `0.1.0` and passed the prior isolated official 0.11.2 GitHub replay. It can be installed now with `--ref c106efb88a659931d01f40a236001823473561a8`. A branch can move; the planned RC tag must never move. For an exact repeatable RC install, choose the reviewed full SHA once available remotely:

```sh
paseo plugin install github:jasonhnd/paseo-kanban --ref "$REVIEWED_COMMIT" --json
```

`REVIEWED_COMMIT` must be the full public RC commit from the release record. Do not copy a local unpublished candidate SHA into a GitHub install. The RC plan requires an immutable tag and GitHub prerelease, aligned with package/lock/CHANGELOG; it does not include npm publication. The bare `jasonhnd/paseo-kanban` identifier means the official registry, which is a separate review process; it is not this direct Git source.

For another daemon, select its endpoint explicitly for **every** operation:

```sh
paseo --host "$PASEO_TARGET" plugin install github:jasonhnd/paseo-kanban --ref v0.1.0-rc.2 --json
paseo --host "$PASEO_TARGET" plugin ls paseo-kanban --json
```

`PASEO_TARGET` is a CLI endpoint such as `tcp://host:port` (or `host:port`), not an agent identity or credential. Do not pass the SDK WebSocket URL to CLI `--host`. A nondefault local home instead uses `--home "$PASEO_TEST_HOME"`. **Choose either `--home` or `--host`, never both in one command**; 0.11.2 rejects both with `TARGET_AMBIGUOUS`. In isolated tests, keep child `HOME`/`PASEO_HOME` on the test home, use only `--host` on connection commands, and set plugin/SDK `PASEO_URL` to `ws://host:port/ws` (or the corresponding TLS URL). Acquisition, npm preparation and execution happen on that daemon host; the client device does not install dependencies. Do not infer remote Node/Git/npm availability from versions on the client machine. CLI `--version` does not certify the daemon/app version pair.

Paseo plugins are trusted, unsandboxed code. Inspect the selected source and [access description](DATA.md). The manifest declares `>=0.11.0 <0.12.0`; daemon and app must both match. Node >=22.13.0 with working `node:sqlite`, Git and npm are needed on the daemon PATH. Platform evidence and remaining experimental limits are in [COMPATIBILITY](COMPATIBILITY.md).

## Enable and confirm the installed version

Turn on **Settings -> Plugins -> Enable plugins** on the intended host, and enable `paseo-kanban` individually. Turning on the global switch also activates other individually enabled plugins.

```sh
paseo plugin enable paseo-kanban --json
paseo plugin ls paseo-kanban --json
paseo plugin logs paseo-kanban --json
```

Require `running` without a load error. Record the returned source kind, full installed revision, enabled state and actual path. Confirm the managed package/lock version is `0.1.0-rc.2` and the installed full revision matches the RC release record; version metadata alone cannot distinguish source commits. Official 0.11.2's Git identity is the revision, not a manifest version field. Do not guess the managed cache path. Open the real sidebar entry and test the board/Fleet page on the same host.

The install does not put plugin commands on PATH. Set `BOARD_INSTALL` to the path from `ls`, then use the generated launchers with the same home/data-root environment as the daemon:

```sh
node "$BOARD_INSTALL/bin/paseo-kanban.mjs" --help
node "$BOARD_INSTALL/bin/paseo-kanban.mjs" list --json
node "$BOARD_INSTALL/bin/roles.mjs" ls
```

No end-user build is needed after successful Git preparation. Authentication/roles/policy and the first-card walkthrough are in [README](../README.md#configure-and-finish-a-first-card). Do not paste supervisor tokens or provider credentials into commands or reports.

## Preview and update an explicit ref

Save current revision/path/enabled state, pause dispatch and other writers, and take consistent [data/settings backups](DATA.md#backup-and-data-restore). After publication confirmation, use the immutable RC tag or its full reviewed public SHA on **both** commands:

```sh
paseo plugin update paseo-kanban --check --ref v0.1.0-rc.2 --json
paseo plugin update paseo-kanban --ref v0.1.0-rc.2 --json
paseo plugin ls paseo-kanban --json
```

`--check` only previews. A branch can advance between a separate preview and apply command; use the full SHA from the preview/release record when those operations must target identical bytes. `--ref` applies without another approval prompt. Install/update selectors do not permanently pin later ordinary updates: an update without `--ref` checks the remote default HEAD. Avoid `--all` and unqualified updates for a controlled rollout.

Managed Git revisions may get different paths. Refresh `BOARD_INSTALL`, generated CLI references and any local command configuration after updating. Keep `PASEO_HOME` and `KANBAN_DATA_DIR` unchanged; do not point `KANBAN_HOME` at a discarded checkout. Never run `git checkout` or `npm ci` inside a managed installation to change its code. Verify revision, settings/data root, CLI/RPC and actual UI before resuming dispatch.

A failed download, preparation, compile or activation retains the previous managed installation. Still verify its revision/path/enabled state and a working action. `plugin reload` is different: failure does not automatically restore the previous bundle. See [recovery](RELEASE.md#updating-and-recovery) and [troubleshooting](COMPATIBILITY.md).

## Disable, remove and roll back code

```sh
paseo plugin disable paseo-kanban --json
paseo plugin enable paseo-kanban --json
paseo plugin remove paseo-kanban --json
```

Removal deletes managed Git files, keeps a directory source checkout, and may remove host plugin settings. The external data root is separate. In isolated 0.11.2 tests, installing after removing a disabled source set enabled=true and started immediately with the global switch on. Prevent scheduling separately before switching and restore the intended enabled state explicitly. Same-id `install` is rejected while the old installation exists. An explicit-ref update of a directory source is refused with `Plugin is a local directory: paseo-kanban`; a generic nonzero exit is not proof of that boundary.

For a Git code downgrade, preserve current data and use a full **previously verified** public commit:

```sh
paseo plugin update paseo-kanban --check --ref "$PREVIOUS_COMMIT" --json
paseo plugin update paseo-kanban --ref "$PREVIOUS_COMMIT" --json
paseo plugin ls paseo-kanban --json
```

For `0.1.0-rc.2`, `PREVIOUS_COMMIT=c106efb88a659931d01f40a236001823473561a8` is the previously verified public baseline, not a previous versioned release. Do not roll a GitHub install back to unpublished `v0.1.0-rc.1`. After code rollback or upgrade, exports can keep a removed checkout's command path for about 600 seconds. Use the current installed path and wait for both exports to match it. This candidate does not fix that delay. Otherwise take it from the saved release record, not from package version alone. Code downgrade does not undo data writes. Data restore needs a separate consistent, compatible backup and can discard newer writes. A directory-to-Git switch needs remove/install rather than Git update; see the [prepared runbook](RELEASE.md#directory-to-git-switch-runbook), which does not declare a production switch complete.

## Git preparation and local development

The manifest's `build` argv runs `node server/prepare.mjs` before compilation. Git preparation uses the committed lockfile with `npm ci --include=dev --ignore-scripts --no-audit --no-fund`, including under `NODE_ENV=production`, then builds all eight standalone command bundles. Compiler/type inputs are intentionally included. A missing bundle or failed command refuses the candidate. Fresh-cache isolated 0.11.2 local Git installs exercised this production preparation and installed commands. Repeat it for each final candidate and for its published GitHub source.

For a developer source directory only:

```sh
npm ci
npm run typecheck
npm run build
paseo plugin install "$PLUGIN_CHECKOUT" --json
# After edits and a successful typecheck on the same development directory:
paseo plugin reload paseo-kanban --json
```

`PLUGIN_CHECKOUT` is the absolute path to your clean clone, on a disposable development host with no existing same-id installation. Directory sources reference that directory; `plugin update` skips them. Reload source without restarting the daemon. Local `npm pack`/prepack checks verify generated bytes for release gates; they do not establish a supported npm distribution channel.

A disposable verification environment needs a separate home, private temp/cache/data roots, an unused loopback listener and explicit CLI host. Use a whitelist environment, no inherited agent identities/tokens, no personal provider configuration, disabled relay/providers, and explicit `false` optional adapters. Test a local Git source with `file://` and a full ref before remote replay. Keep failures local, stop test processes, and never use production databases or credentials.
