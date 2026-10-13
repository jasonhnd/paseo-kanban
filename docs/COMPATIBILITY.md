# Compatibility and troubleshooting

The manifest declares Paseo **daemon and app** `>=0.11.0 <0.12.0`. A compatible daemon does not prove a compatible app. The fixed official command/compiler baseline is **0.11.2**, commit `75953250959979b8f088bbca8dbd6ee61d0151b1`. This declaration is not evidence that every 0.11 patch or client has been tested. Recompile and verify actual integrations before widening the range.

## Requirements and evidence

| Component | Requirement or evidence boundary |
|---|---|
| Paseo | Daemon and app in the declared range; global and individual plugin switches on. CLI `--version` reports only the CLI. |
| Node | >=24.21.0 with usable `node:sqlite` in the daemon host's actual Node environment. |
| npm / Git | Available on the daemon PATH for Git acquisition/preparation; Git is also needed for code cards/workspaces. Client-machine availability does not prove remote host readiness. |
| Providers | User-installed/authenticated local providers. Discovery is not proof of login, quota or a successful request. |
| Review | Two confirmed nonempty actual models, compared after trim/lower normalization. Different models in one family are allowed; identical models across provider/mode/effort are refused. |

| Platform or check | Current evidence boundary |
|---|---|
| Paseo minimum | Separately measured rc.4 on official daemon/Web app 0.11.0 with Node 24.21.0: installation/running, RPC and Board mounting, and 13/13 local gates. This does not certify the integrated rc.5 lifecycle. |
| macOS | Isolated arm64, Node 24.21.0/npm 12.1.0: local Git preparation, CLI/compiler, lifecycle/failure recovery and official 0.11.2 web app in Edge. This does not certify all macOS/tool versions or an authenticated first card. |
| Linux | Initial target; a complete native workflow has not been certified here. Keychain/screen features are unavailable. |
| WSL2 | Requires its own Linux-environment record. |
| Native Windows | Not initially supported; Node launchers alone do not validate Git/worktree/shell workflows. |
| Desktop and compact viewport | Actual official 0.11.2 web app/daemon in local Microsoft Edge: sidebar, Board/Fleet, language/theme, RPC and agent-free workspace filtering tested. Compact content/actions must be checked after closing the sidebar. Native Electron remains unverified. |
| Physical phone | Requires a real device/app connected to the tested host; a narrow viewport is insufficient. |
| Real provider first card | Requires user-controlled test login, actual different executor/reviewer models, completion/review/acceptance and cleanup. Mocks do not pass it. |
| Official CLI commands | Isolated 0.11.2 local Git installation, explicit-ref check/update/downgrade, failure retention, source conversion and anonymous data recovery tested. Final published GitHub replay remains required. |

These isolated observations do not certify a production switch or other platforms. Record exact commit/source/revision, OS, Node/npm, daemon/app/CLI, provider/model and each tested surface in the [release record](RELEASE.md). Optional macOS probes are not requirements for the core board workflow.

## Command Center and manifest icon

In official Paseo **0.11.2 Web**, ⌘K/Ctrl+K -> **Open project board** requires this installation's host context in the current page. An open plugin page or active workspace supplies that context; an empty homepage does not. Returning from a plugin page to that homepage removes the action. Open **Paseo Kanban** from the sidebar first. The command title follows the plugin's selected language. A selected Settings host is not a guarantee of command context on other pages.

The client catalog is loaded for connected hosts independently of plugin-page mounting. The host's [command registration](https://github.com/getpaseo/paseo/blob/v0.11.2/packages/app/src/plugins/command-center/registration.tsx#L18) chooses the active workspace host or `/h/<host>/...` route and filters plugin items by it. `context: global` removes workspace/agent prerequisites, not this host requirement. See the [official API reference](https://paseo.sh/docs/plugins/reference#command-center-items). Changing plugin registration timing cannot provide the missing homepage context.

The official 0.11.2 [plugin list renderer](https://github.com/getpaseo/paseo/blob/v0.11.2/packages/app/src/screens/settings/plugins-page.tsx#L117) does not read manifest `icon`/`media`. `assets/icon.png` is metadata for possible future registry display; absence in Settings -> Plugins is expected for this host version. Sidebar and command contribution icons are separate. These limits do not establish native app or other host-version behavior.

## Troubleshooting

Start with the intended host's status and logs:

```sh
paseo plugin ls paseo-kanban --json
paseo plugin logs paseo-kanban --json
```

For a different daemon, add `--host "$PASEO_TARGET"` before `plugin` on every command; use a CLI endpoint such as `tcp://host:port`. Choose `--home` or `--host`, never both. Plugin/SDK `PASEO_URL` instead uses the WebSocket URL with `/ws`.

| Symptom | Next check |
|---|---|
| `TARGET_AMBIGUOUS` or malformed connection URL | Do not combine `--home` and `--host`. CLI endpoints use `tcp://host:port` or `host:port`; do not pass `ws://host:port/ws` as CLI `--host`. |
| Git source/tag/ref not found | Use `github:jasonhnd/paseo-kanban` with the real integration branch or full public reviewed SHA. A local unpublished SHA, invented tag, bare registry id or assumed npm release is not that source. |
| Same id already installed | Read source kind from `ls`. Update a managed Git source with explicit ref; a directory source needs the prepared remove/install switch. Repeated install does not replace it. |
| Dependency/preparation/compiler error | Check daemon-host Node/npm/Git and `node:sqlite`, registry/network access and preparation output. A managed update failure retains the prior install; verify its revision and action. Do not build in its managed checkout. |
| `disabled` | Check the global Enable plugins switch and the individual switch separately. Both must be on; global enable may start other plugins. |
| Enabled/running but no sidebar/page | Check selected host, Settings -> Sidebar visibility, app version and client errors. Open the actual entry; `running` is only server evidence. |
| RPC rejects or page error | Check logs and connection to the selected host; request validation or a server handler may fail. Test an error state as well as a successful request. |
| Host rejects the version | Compare both daemon and app to the manifest range. An offline/unknown result is not a pass. |
| No provider or model | Enable/install a local provider in Paseo and complete login yourself, then rediscover. Never send authentication files to an issue. |
| Provider discovered but requests fail | Check provider status/login/quota; catalog discovery does not prove these. |
| No roles | Fleet Settings previews only; manually configure Paseo profiles, preserving existing entries and explicit role/pool/actual model. |
| Leader cannot create/accept | Check protocol delivery and self-registration separately. Use the leader launch panel and `kanban_supervise` or CLI `supervise`; hand over a live prior registration. |
| Protocol missing | Use panel recovery controls; ordinary profile selection does not inject board protocol. |
| Empty/unknown quota or invalid policy | Configure your own pools, source timestamps and policy. Unknown is not zero; protected unknown or invalid immutable policy holds dispatch. Turning protection off removes that quota guard. |
| Retired storage override | Unset `AFC_DATA_DIR`, `ROLES_STATE_DIR`, `AFC_LEGACY_DATA_DIR`; use the canonical root. No legacy data is automatically read or imported. |
| Data/CLI root differs after update | Keep the same id/home/root, refresh `BOARD_INSTALL` from `ls` and remove references to discarded checkouts. Do not change the data root to match a new code path. |
| Missing command bundle | A Git install should prepare all eight bundles. Preserve errors and verify the exact candidate; only a developer source checkout uses `npm run build`. |
| Optional adapter runs unexpectedly | In `fleet/afc.config.json`, set explicit `false`; old Cursor/keychain markers can keep an unset switch on. Antigravity requires explicit `true` and a matching plan. |
| Directory source refuses/skips update | Directory sources use source edits, typecheck and `plugin reload`; switching to Git is remove/install, not an ordinary update. |
| Reload failed | Read `ls`/logs, fix the development source, typecheck and reload again. Reload failure does not restore the previous bundle. No daemon restart is needed for source reload. |

Set `BOARD_INSTALL` to the current installed path, use the same home/root as the plugin, and run diagnostics privately:

```sh
node "$BOARD_INSTALL/bin/afc.mjs" doctor --json
node "$BOARD_INSTALL/bin/paseo-kanban.mjs" doctor
```

Doctor output may contain private paths, projects and state. Share manually redacted excerpts only. Offline types/build/tests do not prove live authentication, migration or client mounting.

## Version changes

Read CHANGELOG Notes for host range, contract/schema changes, upgrade order and recovery limits. Preview and update using an explicit branch or reviewed full public SHA **every time**:

```sh
paseo plugin update paseo-kanban --check --ref integration/single-plugin-reviewed --json
paseo plugin update paseo-kanban --ref integration/single-plugin-reviewed --json
```

`--ref` does not permanently pin future ordinary updates. For repeatable rollout or code downgrade, replace the branch with the recorded full SHA on both commands. Back up [consistent data and host settings](DATA.md#backup-and-data-restore) first. Code rollback does not undo data writes; managed update recovery differs from failed reload. See [Git installation](GIT-INSTALL.md) and [release/recovery](RELEASE.md).
