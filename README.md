# Paseo Kanban

A [Paseo](https://github.com/getpaseo/paseo) plugin that combines a cross-project coding-agent board with Fleet roles, quota, decisions and settings. Executors finish cards, a reviewer with a different actual model checks the work, and the project leader accepts it.

[Simplified Chinese](docs/zh-CN/README.md)

> **Experimental candidate `0.12.0.1`, unpublished.** The public baseline is v0.1.0-rc.23 (`c6e740bedfd64691bd20270244efb1f803109b0f`). Install the new tag only after its GitHub prerelease points to the independently reviewed commit. Native clients, physical phones and an authenticated provider first-card cycle still require separate validation. No stable release, npm publication or registry listing is declared.

One plugin id, `paseo-kanban`, opens Board, Fleet and Settings from one sidebar entry. The board uses host-qualified deep links and retains workspace project filtering.

## Interface

Actual plugin pages in an isolated official Paseo 0.11.2 host, captured with local Microsoft Edge. All cards, projects, profiles and quota values are synthetic. These images show Web UI mounting, not a real provider workflow or native-device certification. [Capture details](docs/MEDIA.md).

![Board with synthetic coding-agent cards](assets/board.png)

![Fleet quota page with synthetic usage plans](assets/quota.png)

## Command Center and icon in Paseo 0.11.2

On macOS, press **⌘K** (Ctrl+K on Windows/Linux) and search **Open project board**; the title follows the plugin's English/Chinese language setting. In the official **0.11.2 Web UI**, this action appears only when the current page has this installation's host context, such as an open plugin page or active workspace. An empty homepage has no host context and does **not** show the action, even after leaving an open plugin page. Open **Paseo Kanban** from the sidebar first. Selecting a host in Settings alone does not make every page carry that context. See [compatibility](docs/COMPATIBILITY.md#command-center-and-manifest-icon).

`assets/icon.png` is manifest metadata for possible future registry display. The official 0.11.2 **Settings -> Plugins** list does not display manifest icons; this is separate from the sidebar/command contribution icons. No current registry listing is claimed. [Media details](docs/MEDIA.md).

## Start here

1. **Prepare:** Paseo daemon and app `>=0.11.0 <0.13.0`, Node `>=24.21.0` with `node:sqlite`, Git and npm. Enable trusted plugins only on the intended host; read the access warning below. A real automatic card needs authenticated local profiles with two confirmed, different actual models. [Requirements](#requirements).
2. **Install:** follow [GitHub installation](#install-from-github) for the explicitly pinned public baseline. The RC tag is unavailable until its matching Release exists. To evaluate the unpublished candidate, use [directory setup](#developer-directory-setup) on an isolated development daemon.
3. **First visible success:** `paseo plugin ls paseo-kanban --json` reports `running` without a load error, and **Paseo Kanban** opens Board and Fleet on that same host. Then follow [first-card setup](#configure-and-finish-a-first-card) and require a commit, independent review and leader acceptance. The screenshots do not certify that provider cycle.

Prior RC commit/tag identities and rejection history are retained in the [changelog](CHANGELOG.md) and [release record](docs/RELEASE.md).

All dispatched profiles must use standard speed, across every family and role. Fast/priority settings are refused even for explicit profile selection or when `families` is empty. Admission recognizes `fast`, `fast_mode`, `fastMode`, `service_tier` and `serviceTier` at profile level and inside `featureValues`, as well as structured configuration and command-argument overrides. Disable those settings in the host profile before dispatch; Kanban rejects the profile instead of rewriting its launch configuration. The legacy `noFast` field cannot enable fast mode.

Disposable cloud execution is disabled by default. It requires the project switch and a `cloud` card tag, and supports public `paseo-clear-chat` executor cards using Codex or Grok. See [cloud execution](docs/CLOUD-RUNNER.md), [running-card limits](docs/RUN-BUDGET.md) and [background waits](docs/WORKFLOW.md).

## Requirements

- Paseo **daemon and app** in `>=0.11.0 <0.13.0`, with global plugins and this plugin enabled. **0.11.2 and 0.12.0** passed isolated plugin load, scheduler tick, MCP ping and CLI create/show checks for this candidate; the declared range does not certify every patch or client.
- Node **>=24.21.0** with working `node:sqlite`, plus Git and npm on the **daemon host's PATH**. Source acquisition and preparation run there, including when the CLI targets a remote host.
- User-installed, user-authenticated local providers. Automatic executor/reviewer flow needs **two confirmed, nonempty, different actual models**. Discovery is not proof of login or usable quota.
- macOS arm64 has isolated local Git, CLI/compiler and actual 0.11.2 web-app evidence with Node 24.21.0/npm 12.1.0. This does not certify other versions or a provider cycle. Linux and WSL2 still need separate real workflow validation; native Windows is not supported for the initial release. See [compatibility](docs/COMPATIBILITY.md).

Paseo plugins are **trusted, unsandboxed code**. Server and preparation code can use the daemon user's files, processes, credentials and network; client code runs in the app. This plugin persists board/Fleet state, operates configured workspaces and agents, and can run Git, Node and configured provider commands. Enabled usage adapters may contact services or invoke local tools. Read [access and data boundaries](docs/DATA.md) before enabling it.

## Install from GitHub

Check the CLI, daemon and app versions, and the daemon's Node environment first. `paseo --version` reports the CLI version, not proof of the app/daemon versions. **Run the following tag command only when the GitHub Release record for `v0.12.0.1` exists and its target commit equals the reviewed full SHA in the [release record](docs/RELEASE.md). While that record is absent, the candidate is unpublished and the tag is not a GitHub install target.**

```sh
paseo --version
node --version
paseo plugin install github:jasonhnd/paseo-kanban --ref v0.12.0.1
paseo plugin ls paseo-kanban --json
```

This uses the official Paseo CLI's GitHub acquisition path. The tag must never move or be reused. Compare the installed full revision with the final reviewed RC SHA; that SHA also works as `--ref` once public. These instructions do not mean the plugin has passed the official registry's review. Do not substitute the bare registry id `jasonhnd/paseo-kanban` or an npm source. While publication is pending, the already-public **pre-RC baseline** can be installed explicitly:

```sh
paseo plugin install github:jasonhnd/paseo-kanban --ref c106efb88a659931d01f40a236001823473561a8 --json
```

That baseline has package metadata `0.1.0`. It is not `0.1.0-rc.21`, and it is not the unpublished local `0.1.0-rc.1` preparation. See [the RC changelog](CHANGELOG.md) for source changes and unresolved dependency alerts.

1. In the intended host's **Settings -> Plugins**, turn on **Enable plugins** and the individual `paseo-kanban` switch. The global switch starts other individually enabled plugins too. You can enable this plugin with `paseo plugin enable paseo-kanban --json` once the global switch is on.
2. Repeat `paseo plugin ls paseo-kanban --json`; require `running` without a load error. Open **Paseo Kanban** from that host's sidebar. Board, Fleet and Settings should share that entry. Check the actual page; `running` alone does not prove client mounting. A compact viewport does not prove a physical phone.
3. Use the CLI's default daemon only if it is the intended one. For a different daemon, put `--host "$PASEO_TARGET"` before every `plugin` command, using a CLI endpoint such as `tcp://host:port`. Use either `--host` or a nondefault local `--home`, never both. [Git installation](docs/GIT-INSTALL.md) explains host selection, version confirmation and developer directory installs.

In the **0.11.2 Web UI**, open **Paseo Kanban** from the intended host's sidebar and copy the complete address-bar URL for a bookmark. The sidebar opens `<web-origin>/h/<host-id>/plugin/paseo-kanban/surface/board?pluginId=paseo-kanban&contributionKind=surface&contributionId=board`. Here `<web-origin>` is the Paseo Web UI origin and `<host-id>` is the host id generated by Paseo; use the values from your own URL. On that same connected host, `/h/<host-id>/plugin/paseo-kanban/surface/board` without the query string and `/h/<host-id>/plugin/paseo-kanban/sidebar/board` also open Board. The host-less short path `/plugin/paseo-kanban/board` shows **Unmatched Route** in this host version. These checks apply to 0.11.2 Web UI; native app links remain unverified.

Installation performs locked dependency preparation and generates the command bundles. End users do not need a development checkout or a separate `npm run build`. An existing plugin with the same id makes `install` fail; use [update](#update-disable-or-remove) for a Git source, or the [source-switch runbook](docs/RELEASE.md#directory-to-git-switch-runbook) for a directory source.

## Configure and finish a first card

1. Choose English or Simplified Chinese in the combined Settings page. Fleet role setup **previews** available profiles; manually configure suitable profiles in Paseo while preserving existing entries. Set roles, pools and explicit actual models for leader, executor and reviewer. Different models in one family are allowed; the same model after trim/lower normalization is refused even across providers, modes or effort. Missing model evidence holds review. Preview does not save profiles or verify login; complete provider login yourself.
2. Configure your own pool sources and policy. Fleet supplies an immutable `paseo-policy/v1` revision to Kanban admission. Missing/invalid policy or unknown protected quota keeps dispatch closed; an unknown reading is not zero. Old `fleet-quota/v1` files and `afc`/`roles` are compatibility interfaces below the same root. Do not register a separate old Fleet plugin.
3. New installs use `KANBAN_DATA_DIR`, or `PASEO_HOME/plugin-data/paseo-kanban` (Paseo home defaults to `~/.paseo`). Unset nonempty retired storage overrides. Existing data is not automatically imported. Read [data ownership](docs/DATA.md) and [manual transfer](docs/MANUAL-MIGRATION.md) before reusing old state.
4. Create a disposable Git repository/workspace named `demo` with an initial commit. In project settings, set its workspace, short code and protected branches. In the project's leader panel, choose a leader profile/workspace/language, preview and start the leader. Confirm protocol delivery. An ordinary conversation using the same profile does not perform this setup.
5. In that leader session, call `kanban_supervise` for project `demo`, or run the stable board command. When `KANBAN_DATA_DIR` is set:

   ```sh
   "$KANBAN_DATA_DIR/bin/paseo-kanban" supervise --project demo
   ```

   Otherwise:

   ```sh
   "${PASEO_HOME:-$HOME/.paseo}/plugin-data/paseo-kanban/bin/paseo-kanban" supervise --project demo
   ```

   The plugin rewrites that command on every start so it runs the current install. Do not point a long-lived session at the install directory's `bin/paseo-kanban.mjs`; that directory name changes on every update. Use the same Paseo home and data root as the plugin. The session uses its own injected identity; do not paste tokens. Confirm registration in the panel; hand over an existing live leader instead of replacing it.
6. Ask the leader: "Create an L1 card to add hello.md containing exactly Hello and a newline in the demo repository. Verify the file and content. Commit, review and accept locally; do not push or publish." Require an executor commit and handoff, review by a different actual model, leader acceptance, a finished card, correct file, clean Git status and managed agent/workspace cleanup. This is a validation walkthrough, not a report that the cycle has passed.

Use [workflow](docs/WORKFLOW.md) and [troubleshooting](docs/COMPATIBILITY.md) if dispatch is held. Never share authentication files, raw board databases, backups or unredacted doctor output in an issue.

Card scratch uses the project’s `.kanban-work/<card code>/`; see [card work directories](docs/CARD-WORK-DIRECTORIES.md) for configuration, fallback, cleanup and the capacity brake (a new card's first start pauses above 10 GiB of card work or below the automatic reserve min(50 GiB, max(3 GiB, 25% of disk capacity)); review, rework, and resume still start).

## Update, disable or remove

Back up state and record the current full revision, source, installed path and enabled state first. After RC publication is confirmed, preview and apply an **explicit ref each time**:

```sh
paseo plugin update paseo-kanban --check --ref v0.12.0.1 --json
paseo plugin update paseo-kanban --ref v0.12.0.1 --json
paseo plugin ls paseo-kanban --json
```

Use those two update commands only when the GitHub Release record authorizes `v0.12.0.1`, as in [Install from GitHub](#install-from-github). After a managed update, board and Fleet information exports can still name a removed checkout for about 600 seconds. That is their existing export period. The new command handlers resolve the current managed path when an action runs; the export delay remains unchanged.

During an update or reload, mounted panels keep their last data and show “Plugin is updating…” for temporary “Plugin not available” read failures. Audited reads retry up to five times with backoff (a 15-second retry window); other errors remain visible. Saves and actions are never automatically retried: check the result before trying again. If the plugin stays unavailable, the panel asks you to refresh later.

After every upgrade or code rollback, keep dispatch paused until the same host reports the intended full revision, current installed path, enabled/running state and unchanged data root/settings. Refresh `BOARD_INSTALL` and run the installed Node CLI from that path only to check the installed CLI yourself. Agent prompts and the stable command in the data directory's `bin/` already follow the current install after the plugin starts, so they do not need a new path. Wait for both exports to name the current install, then use an approved disposable decision in the real panel: close it, verify both counts and stored done state, Undo while mounted, and verify it is open again. An export match or `running` alone does not prove a write works. If an action fails, preserve the error and keep dispatch paused.

When downgrading to c106 or the unchanged local rc.1/rc.2 code, **run `paseo plugin reload paseo-kanban --json` on that same host after the update and require `running` before the checks above**. Those older versions cache command paths at module load. Use the same `--host` or local `--home` selector on reload and all plugin commands; never both. Do not use an unpublished tag for a GitHub rollback. Reload failure stays failed until repaired/reloaded; it is not automatic rollback. A daemon restart is not required solely for this code change.

`--check` previews without installing. `--ref` selects this operation only; a later update without it follows the remote's default HEAD. A full reviewed SHA provides an exact target. Check the installed revision/path and actual UI after the update. Refresh `BOARD_INSTALL` only to check the installed CLI; the stable command in the data directory does not change. Do not edit or build inside a managed checkout. See [release and recovery](docs/RELEASE.md) for backup, exact-SHA rollback and the pending verification checklist.

For code rollback to the previously verified public c106 baseline, keep the same data root and use its full SHA on both operations:

```sh
paseo plugin update paseo-kanban --check --ref c106efb88a659931d01f40a236001823473561a8 --json
paseo plugin update paseo-kanban --ref c106efb88a659931d01f40a236001823473561a8 --json
paseo plugin reload paseo-kanban --json
paseo plugin ls paseo-kanban --json
```

```sh
paseo plugin disable paseo-kanban --json
paseo plugin enable paseo-kanban --json
paseo plugin remove paseo-kanban --json
```

Disabling stops this plugin; enabling also needs the global switch. Removal deletes a managed Git checkout and may remove host plugin settings, while a directory source checkout is kept. The external data root is separate; removal is not a data reset. In 0.11.2 a new installation sets its individual enabled state to true, even after removing a disabled source; with the global switch on it starts immediately. Prevent scheduling before a source switch, then restore the intended enabled state explicitly. Reinstall with the same id/home/root and restore settings deliberately. **Code rollback does not restore data**; restoring a consistent backup is a separate operation that can lose writes made after that backup. Isolated 0.11.2 prepare, syntax-compile and activation failures retained the previous managed revision/path and working RPC; verify these after any failure. A failed `plugin reload` stays failed until repaired/reloaded and does not automatically restore the previous bundle.

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

## Specification based QA

Create an independent acceptance card with `create --role reviewer --reviews DEMO_0001 --tag qa --brief "Specification: docs/demo-spec.md#login"` (or MCP `kanban_create` with `role: "reviewer"`, `reviews`, `tags: ["qa"]` and `brief`). Replace the demo reference with the delivered card. QA cards are rejected unless the brief has a nonempty `Specification: <file/link/item>` line; `Spec source:` and the Chinese equivalent are also supported. The reviewer must verify that the source exists and contains the requirements. Ordinary reviews keep their code review rules and actual-model isolation still applies to QA.

QA checks each specification item read-only, using Google Chrome if a browser is needed. It records `Item | Verdict (Pass / Fail / Unable to verify) | Evidence | Notes`, quotes the original items, and puts the table in `kanban_approve.summary` (stored as the QA handoff) only if every item passes. Failures go to `kanban_request_changes` with the original failed items and evidence in `findings`; the executor receives them in card comments. Unable to verify does not pass. Evidence stays in handoffs/comments; screenshots must be deleted after use.

After a valid linked QA approval advances the reviewed card, the board asks its project's second-brain leader to obtain Product signoff. Optionally set the global `contactsFile` config key to an operator-owned JSON file outside the repository:

```json
{"projects":{"demo":{"sb_leader":{"paseoAgentId":"demo-second-brain-agent"}}}}
```

`contactsFile` is unset by default. The board reads its contents anew immediately before each notification, using the reviewed card's project. A missing/unreadable file, missing project or empty id falls back to that project's registered Paseo leader (`supervisors`), and a fallback note is written to both cards. No private path or session id is shipped. Configure the actual path locally during a normal authorized update; do not commit the file or its real values.

The notification contains project, reviewed card, QA card, specification source, verdict table summary and the Product signoff request. A durable claim prevents duplicate sends for an approval. Transport failures or a missing project leader are recorded on the QA card and require the leader to arrange signoff manually; uncertain sends are not automatically retried. Product signoff remains a separate human workflow; QA approval does not perform final lead acceptance.

## Privacy gates

Keep personal state out of this repository and distribution artifacts. These contributor checks apply to the Git source and locally packed artifacts; npm is not a release channel for this batch. Three gates enforce it from the first commit:

1. **pre-commit** (`.githooks/pre-commit`): `scripts/check-private.mjs` scans the staged files against the generic rules in `shared/privacy-rules.mjs` (home paths, e-mail addresses, ids, board card numbers, keys and tokens, CJK text outside the zh-CN files (`locales/zh-CN.json` or `locales/zh-CN/`, optionally under `shared/`; `server/protocol/zh-CN/`; `docs/zh-CN/`), real data files) **and** your private denylist; `scripts/check-identity.mjs` refuses any author or committer that is not the placeholder or a GitHub noreply address; `gitleaks` runs when installed.
2. **`npm run verify`**, run by **pre-push** (`.githooks/pre-push`): fourteen local gates covering types, script/plugin tests, CLI and actual Paseo compilation, source/history privacy, identities, secrets, single-source contract/gate invariants and actual package bytes. Pre-push scans each outgoing ref's complete reachable history and annotated tags, then exports and verifies its exact commit with locked dependencies. It refuses publication when any check fails. Hosted CI is not required or enabled by this integration.
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

The plugin regression runner defaults to four concurrent test files so real Git and filesystem fixtures do not compete with every other worker for their operation budgets. `KANBAN_TEST_CONCURRENCY` accepts an integer from 1 to 64 to override file concurrency. Every selected test, assertion and timeout remains enabled; coverage keeps its separate explicit concurrency setting.

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

## Development features restored from public rc.21

Disposable cloud execution defaults off: Codex/Grok executor cards can use draft PRs for projects in `cloud.allowedProjects` whose GitHub repositories are anonymously readable, or explicitly allowlisted `paseo-kanban` local mirror delivery; see [dual-mode configuration, privacy boundaries and trial prerequisites](docs/CLOUD-RUNNER.md).

Card scratch defaults to the project's `.kanban-work/<card code>/`, with a per-project plugin-data fallback and an explicit `KANBAN_TMP_ROOT` override. Preparation fails closed. Finished card directories become eligible for cleanup on the next scheduler round, with ownership, Git, generation and active-process guards. Preserve durable evidence before finishing. See [card work directories](docs/CARD-WORK-DIRECTORIES.md).

A new card's first start pauses above 10 GiB of card-work usage or below the automatic free-space reserve (50 GiB on disks at least 200 GiB; otherwise max(3 GiB, 25% of disk capacity)); review, rework and resume can continue. Configure `capacity.maxWorkGiB` and `capacity.minFreeGiB` to change those thresholds. Timed waits use `scheduled` plus a future offset-bearing `until` within seven days; see [workflow](docs/WORKFLOW.md). Paseo's project list controls active projects; two empty observations at least one minute apart confirm an empty list.

During reloads, audited reads retain the last data and retry transient unavailability for a bounded window. Saves and actions remain single-attempt. Cross-panel decision updates and recent-decision reminders share consistent state. Cursor monitoring is separate from dispatch eligibility, and dispatch statistics preserve unknown or incomplete provider usage.

Leader handover supports persistent sessions and complete visible protocol delivery. The optional [curated-memory integration](integrations/) is profile-wide; isolate profiles when project memory must stay separate. Server-side agent opening returns a compatibility response; the client navigates on its connected host. These source changes do not publish a release or certify a production installation.

Cloud execution and localMirror are disabled by default, with no project preconfigured enabled. Configure each project explicitly before opting a cloud-tagged card into the documented source mode.
