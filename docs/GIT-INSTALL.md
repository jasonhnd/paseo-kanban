# Git installation and updates

[README](../README.md) is the user quickstart. This guide separates managed Git installation from a developer's directory source. Command syntax is based on the public Paseo **0.11.2** CLI help and [fixed reference](https://github.com/getpaseo/paseo/blob/75953250959979b8f088bbca8dbd6ee61d0151b1/public-docs/plugins/reference.md#cli-reference). Local Git lifecycle and official web-app checks also ran on an isolated macOS host; their scope and remaining GitHub/provider/device checks are in the [replay checklist](RELEASE.md#command-replay-checklist). Help alone does not prove runtime behavior.

## Select the host and source

Install to the intended daemon. **RC `0.1.0-rc.12` is unpublished until the GitHub Release record for `v0.1.0-rc.12` exists, is a prerelease, and its target commit equals the reviewed full commit. While that record is absent, do not run the tag commands as a GitHub install.** Public prerelease rc.11 was published on 2026-10-15 and its GitHub Release exists, frozen at `09963b85e0d7c9c5d881aa39e3c65ebbb719b7a0` (annotated object `042413d64aeee4f41c34120b4b3af4003c685741`). The earlier public rc.8 remains frozen at `0af33ec7e49891bf3dba2549cb8b6b83487bba4c` (annotated object `303e4c27dd65f829743bc44c7242c1abd452c176`). `v0.1.0-rc.1` remains the unpublished local preparation and is not moved. `v0.1.0-rc.2` remains frozen at `8be11b6144b6cc7b81bcf741a360acf18111001f` (annotated object `0e16a0c43de421db583a31b3dee7b6e6b67e6b82`), unpublished. `v0.1.0-rc.3` remains frozen at `61cce0d8ba07e8bf01fe7239ddf0ceeaf5983df4` (tree `633c99456b05cdbf7156f5c3ab1149451a767738`, annotated object `7e288e22f42598a651edef407dcdb82871c3d9de`), unpublished and rejected for publication because stale default policy could reopen a stopped pool or ignore a matrix pause. This candidate retains the prior fixes and corrects those default admission paths; explicit legacy compatibility behavior is unchanged. With the default local home, after the Release record matches:

```sh
paseo --version
node --version
git --version
npm --version
paseo plugin install github:jasonhnd/paseo-kanban --ref v0.1.0-rc.12 --json
paseo plugin ls paseo-kanban --json
```

The current public source is `https://github.com/jasonhnd/paseo-kanban`, branch `integration/single-plugin-reviewed`, at preparation baseline `c106efb88a659931d01f40a236001823473561a8`. That pre-RC source has metadata `0.1.0` and passed the prior isolated official 0.11.2 GitHub replay. It can be installed now with `--ref c106efb88a659931d01f40a236001823473561a8`. A branch can move; the planned RC tag must never move. For an exact repeatable RC install, choose the reviewed full SHA once available remotely:

```sh
paseo plugin install github:jasonhnd/paseo-kanban --ref "$REVIEWED_COMMIT" --json
```

`REVIEWED_COMMIT` must be the full public RC commit from the release record. Do not copy a local unpublished candidate SHA into a GitHub install. The RC plan requires an immutable tag and GitHub prerelease, aligned with package/lock/CHANGELOG; it does not include npm publication. The bare `jasonhnd/paseo-kanban` identifier means the official registry, which is a separate review process; it is not this direct Git source.

For another daemon, select its endpoint explicitly for **every** operation:

```sh
paseo --host "$PASEO_TARGET" plugin install github:jasonhnd/paseo-kanban --ref v0.1.0-rc.12 --json
paseo --host "$PASEO_TARGET" plugin ls paseo-kanban --json
```

`PASEO_TARGET` is a CLI endpoint such as `tcp://host:port` (or `host:port`), not an agent identity or credential. Do not pass the SDK WebSocket URL to CLI `--host`. A nondefault local home instead uses `--home "$PASEO_TEST_HOME"`. **Choose either `--home` or `--host`, never both in one command**; 0.11.2 rejects both with `TARGET_AMBIGUOUS`. In isolated tests, keep child `HOME`/`PASEO_HOME` on the test home, use only `--host` on connection commands, and set plugin/SDK `PASEO_URL` to `ws://host:port/ws` (or the corresponding TLS URL). Acquisition, npm preparation and execution happen on that daemon host; the client device does not install dependencies. Do not infer remote Node/Git/npm availability from versions on the client machine. CLI `--version` does not certify the daemon/app version pair.

Paseo plugins are trusted, unsandboxed code. Inspect the selected source and [access description](DATA.md). The manifest declares `>=0.11.0 <0.12.0`; daemon and app must both match. Node >=24.21.0 with working `node:sqlite`, Git and npm are needed on the daemon PATH. Platform evidence and remaining experimental limits are in [COMPATIBILITY](COMPATIBILITY.md).

## Enable and confirm the installed version

Turn on **Settings -> Plugins -> Enable plugins** on the intended host, and enable `paseo-kanban` individually. Turning on the global switch also activates other individually enabled plugins.

```sh
paseo plugin enable paseo-kanban --json
paseo plugin ls paseo-kanban --json
paseo plugin logs paseo-kanban --json
```

Require `running` without a load error. Record the returned source kind, full installed revision, enabled state and actual path. Confirm the managed package/lock version is `0.1.0-rc.12` and the installed full revision matches the RC release record; version metadata alone cannot distinguish source commits. Official 0.11.2's Git identity is the revision, not a manifest version field. Do not guess the managed cache path. Open the real sidebar entry and test the board/Fleet page on the same host.

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
paseo plugin update paseo-kanban --check --ref v0.1.0-rc.12 --json
paseo plugin update paseo-kanban --ref v0.1.0-rc.12 --json
paseo plugin ls paseo-kanban --json
```

`--check` only previews. A branch can advance between a separate preview and apply command; use the full SHA from the preview/release record when those operations must target identical bytes. `--ref` applies without another approval prompt. Install/update selectors do not permanently pin later ordinary updates: an update without `--ref` checks the remote default HEAD. Avoid `--all` and unqualified updates for a controlled rollout.

Managed Git revisions may get different paths. Refresh `BOARD_INSTALL`, generated CLI references and any local command configuration after updating. Keep `PASEO_HOME` and `KANBAN_DATA_DIR` unchanged; do not point `KANBAN_HOME` at a discarded checkout. Never run `git checkout` or `npm ci` inside a managed installation to change its code. 

After every upgrade or code rollback, keep dispatch paused until the same host reports the intended full revision, current installed path, enabled/running state and unchanged data root/settings. Refresh `BOARD_INSTALL`; run the installed Node CLI from that path. Wait for both exports to name it, then use an approved disposable decision in the real panel: close it, verify both counts and stored done state, Undo while mounted, and verify it is open again. An export match or `running` alone does not prove a write works. If an action fails, preserve the error and keep dispatch paused.

When downgrading to c106 or the unchanged local rc.1/rc.2 code, **run `paseo plugin reload paseo-kanban --json` on that same host after the update and require `running` before the checks above**. Those older versions cache command paths at module load. Use the same `--host` or local `--home` selector on reload and all plugin commands; never both. Do not use an unpublished tag for a GitHub rollback. Reload failure stays failed until repaired/reloaded; it is not automatic rollback. A daemon restart is not required solely for this code change.

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
# Required when returning to c106 or unchanged rc.1/rc.2 code:
paseo plugin reload paseo-kanban --json
paseo plugin ls paseo-kanban --json
```

For `0.1.0-rc.12`, the previous public prerelease is `v0.1.0-rc.11` at `09963b85e0d7c9c5d881aa39e3c65ebbb719b7a0`. `PREVIOUS_COMMIT=c106efb88a659931d01f40a236001823473561a8` remains the older verified public code baseline, not a versioned release. Do not roll a GitHub install back to unpublished `v0.1.0-rc.1`. After code rollback or upgrade, exports can keep a removed checkout's command path for about 600 seconds. Use the current installed path and wait for both exports to match it, then complete the required reload (for older code) and real write/Undo checks above before resuming dispatch. The export delay is unchanged. Otherwise take it from the saved release record, not from package version alone. Code downgrade does not undo data writes. Data restore needs a separate consistent, compatible backup and can discard newer writes. A directory-to-Git switch needs remove/install rather than Git update; see the [prepared runbook](RELEASE.md#directory-to-git-switch-runbook), which does not declare a production switch complete.

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
