# Git release and recovery checklist

This batch prepares the single plugin for **Git-only prerelease `0.1.0-rc.9`**. Its immutable tag `v0.1.0-rc.9` and GitHub prerelease are **unpublished until the GitHub Release record exists**. The public repository is `https://github.com/jasonhnd/paseo-kanban`, branch `integration/single-plugin-reviewed`; the verified public code baseline is `c106efb88a659931d01f40a236001823473561a8`, tree `581ff56cbd944b6d4244129c80a8aeb3bd8c01e2`. `v0.1.0-rc.1` is the local preparation tag for `22958ff54c955c1a90683f786d3ebb8b9ae88470` and is not moved; that preparation was metadata and docs only and was not published. `v0.1.0-rc.2` remains frozen at `8be11b6144b6cc7b81bcf741a360acf18111001f` (annotated object `0e16a0c43de421db583a31b3dee7b6e6b67e6b82`), unpublished. `v0.1.0-rc.3` remains frozen at `61cce0d8ba07e8bf01fe7239ddf0ceeaf5983df4` (tree `633c99456b05cdbf7156f5c3ab1149451a767738`, annotated object `7e288e22f42598a651edef407dcdb82871c3d9de`), unpublished and rejected for publication because stale default policy could reopen a stopped pool or ignore a matrix pause. This candidate retains rc.4's reviewed default-policy, artifact-acceptance, decision-panel and managed-command-path fixes. rc.5 clears obsolete current blocked/cooldown state after successful new runs, corrects stale-policy diagnostics, updates client entries and media, and raises the Node minimum. The old rc.4 commit `a3c03fcc8dcc14237df0ea8ca3df29a19cceed7c` and annotated tag object `d2f0eaea4bfe3cdd747602329abbbf4892b187f5` remain unchanged; explicit legacy compatibility behavior is unchanged. No stable release, npm publication, official registry listing or production switch is declared or authorized here.

rc.6 adds bounded transient read retries and corrects host-qualified Board links, homepage Command Center scope and manifest-icon documentation. Public rc.5 remains frozen at `db1ef026c2f528ac952e95d2bb7170f87fa3800b`, annotated object `44f501a2a6cda150b92d9fa9b5dfa48d03e7af5e`. Its observations do not certify rc.6. The 20 retained dev/build dependency alerts (5 moderate, 15 high) are installed by Git preparation; the recorded audit found no upstream patched versions for the two root advisories and non-force audit fix made no change. See the current [changelog](../CHANGELOG.md).

rc.7 moves per-card scratch from the system temporary directory into the configured project's `.kanban-work/<card code>/` and keeps tests from writing card directories on the real default root. Explicit `KANBAN_TMP_ROOT` remains only an override. Adopting the new default requires removing an old `KANBAN_TMP_ROOT` and recreating workers that still hold the old environment. Public prerelease rc.6 was published on 2026-10-13 and its GitHub Release exists. It remains frozen at `c70df59d8516b7ecc9350ce5833fb177bafc335b`, annotated object `e9a630ffa6a3e1d71935305e6e1c9e05445b8364`. Its observations do not certify rc.7. The 20 retained dev/build dependency alerts (5 moderate, 15 high) are unchanged. See the current [changelog](../CHANGELOG.md).

rc.8 skips thinking-catalog warnings when a provider is disabled or unknown, and stops the host server bundle from reading `fs.F_OK` (DEP0176). Saved MCP port reuse is unchanged from rc.7: a free saved port is reused, and an occupied saved port still switches ports and marks running MCP addresses stale. A new integration test records that official reload reuse. Public prerelease rc.7 was published on 2026-10-14 and its GitHub Release exists. It remains frozen at `2d6942643edb977072f8818b3d0c764b2ce1a057`, annotated object `be783dd6a6efcaeff7be6e4401fc23a026d43a76`. Its observations do not certify rc.8. The 20 retained dev/build dependency alerts (5 moderate, 15 high) are unchanged. See the current [changelog](../CHANGELOG.md).

rc.9 fixes [GitHub issue #1](https://github.com/jasonhnd/paseo-kanban/issues/1): a manual `--reviews` card can request changes while its target is still `in_review`. Approve explicitly errors in that case without promoting the target; later polling of the review card's own checks also leaves the target unchanged. Creating a review card does not claim the target. Public prerelease rc.8 was published on 2026-10-14 and its GitHub Release exists, frozen at `0af33ec7e49891bf3dba2549cb8b6b83487bba4c`, annotated object `303e4c27dd65f829743bc44c7242c1abd452c176`. Its observations do not certify rc.9; exact rc.9 gates need new receipts. Dependencies, schemas and contract versions are unchanged, and the 20 dev/build dependency alerts remain.

## Version and evidence policy

The combined plugin has one package/version/CHANGELOG and runtime id `paseo-kanban`. In 0.x, use patches for compatible fixes and minors for new features or breaking configuration/behavior. From 1.x, use SemVer. Contract/schema versions are separate; compatible additions retain their version, while breaking changes need an explicit migration/recovery plan.

A Git branch is mutable. This RC plan requires an immutable tag and GitHub prerelease, aligned with package/lock/CHANGELOG. Save the full reviewed commit and tree as well as the tag object/metadata; review and scan annotated tag identity/content. Never move, overwrite or reuse a tag, even to correct a release. Local `v0.1.0-rc.1` already names `22958ff54c955c1a90683f786d3ebb8b9ae88470` and is not moved. The next unused number chosen for this candidate is `0.1.0-rc.9`. Confirm rc.9 is unused both locally and remotely before creating its annotated tag; frozen rc.1 through rc.8 objects remain unchanged. Public prerelease rc.8 was published on 2026-10-14. The publishing owner must check the remote refs and GitHub Release record again. Preserve c106 as the previous verified public code baseline, not a previous versioned release.

Prepared RC notes may use a version heading marked **pending publication**; never add a release date or claim an available tag until verified. Notes must state host range, data/contract changes, existing dependency alerts and real test limits. Official 0.11.2 Git acquisition uses revision/`--ref`; its manifest schema has no consumed plugin version field. Keep package.json, package-lock.json's top level and root package version aligned; do not invent a manifest field. Do not turn source-only checks into app/provider certification.

## RC publication plan — pending

The release title is **Paseo Kanban v0.1.0-rc.9** and the GitHub Release must be a **prerelease**. Its body must identify the exact reviewed public RC commit/tree, link the English/Chinese changelogs, state compatibility/access/data risks and distinguish prior c106 evidence from RC verification. Prepare the body for review before publishing; never include private paths, identities, configuration, credentials or evidence repositories.

Only the separately authorized publishing owner may publish the approved commit/tag and create the prerelease after different-model review and leader acceptance. That owner must rerun the exact outgoing branch/tag privacy/history/identity gates, confirm the remote peeled tag equals the reviewed commit, and verify the GitHub Release uses that tag with prerelease=true. No force, tag replacement, npm publication or registry submission is part of this plan.

**These commands are planned for after that remote confirmation, not evidence that the pending tag exists:**

```sh
paseo plugin install github:jasonhnd/paseo-kanban --ref v0.1.0-rc.9 --json
paseo plugin ls paseo-kanban --json
paseo plugin update paseo-kanban --check --ref v0.1.0-rc.9 --json
paseo plugin update paseo-kanban --ref v0.1.0-rc.9 --json
paseo plugin ls paseo-kanban --json
```

Use separate fresh isolated homes/caches for cold tag and full-RC-SHA installs. On another fresh host install c106 first, then preview/update to the RC; assert preview leaves revision/path/settings/data unchanged, update matches exact RC revision/version, all eight installed bundles/Node commands work, and the data root/settings/RPC remain valid. Record the actual UI separately. Test code downgrade to the prior public c106 baseline, then repeat the explicit RC upgrade:

```sh
paseo plugin update paseo-kanban --check --ref c106efb88a659931d01f40a236001823473561a8 --json
paseo plugin update paseo-kanban --ref c106efb88a659931d01f40a236001823473561a8 --json
paseo plugin reload paseo-kanban --json
paseo plugin ls paseo-kanban --json
```

Record exact CLI/daemon/app versions, commands/exits, before/after source/revision/path/enabled/version, code versus data retention, cleanup and limits in the publication receipt. Tag installation and new RC GitHub/UI replay stay pending until those rows pass. Before publication, use a task-owned local `file://` Git source for exact candidate checks; it cannot certify the future GitHub tag. Both daemon and app must be in `>=0.11.0 <0.12.0`; official 0.11.2 on macOS arm64 is the measured baseline, Node >=24.21.0 is required. Other patches/platforms and authenticated providers are not certified by that range.

Relative to c106, this RC retains reviewed artifact acceptance, decision-panel behavior, managed-update command-path resolution and default stale-policy admission. rc.5 also fixes current blocked/cooldown state after successful runs and stale diagnostic wording, updates sidebar and Command Center entries, includes anonymous interface media, raises the Node minimum and updates package/lock metadata and docs. Schema, contract versions and dependency selections are unchanged, and there is no automatic data migration/import. Keep the same canonical root, pause dispatch/writers and back up consistent state plus host settings before changing code/source. Code rollback preserves current writes; a separate compatible data restore can discard newer writes. New install enabled=true can start immediately with global plugins enabled. Existing plugin development/preparation and official-host dependency audit/deprecation alerts are unresolved; keep exact observations in the receipt. Passing gates is not remediation or stable-release evidence.

## Retained limits

These limits stay in force for `0.1.0-rc.9`:

- Information exports can lag a removed checkout by about 600 seconds. Use the current installed path and wait for both exports. Their agreement is necessary but does not prove command writes work; the action checks in [updating and recovery](#updating-and-recovery) are mandatory.
- Undo for a closed decision exists only in the mounted panel. Navigation or reload removes Undo. The stored done state and zero count remain.
- A pull-request artifact accepts lowercase `https://github.com/` only. `https://GITHUB.COM/` is rejected.
- Dependency deprecation and audit warnings are unresolved. Do not treat a green build or privacy gate as an audit fix.
- Physical phones, the native app, and an authenticated provider cycle remain unverified.
- Exact results from `0.1.0-rc.1` or from either fix alone are not the final pass of this integrated commit.
- GitHub cold install of this RC waits until the GitHub Release record exists. Do not invent that result from a local `file://` probe.

## Release body substitution

Prepare the bilingual release body for review. Replace these tokens only as whole tokens:

| Token | Replacement |
|---|---|
| `{{RC_VERSION}}` | `0.1.0-rc.9` |
| `{{RC_TAG}}` | `v0.1.0-rc.9` |
| `{{RC_COMMIT}}` | full reviewed commit |
| `{{RC_TREE}}` | that commit's tree |
| `{{UTC_DATE}}` | UTC calendar date `YYYY-MM-DD` of the body being prepared |

`{{INSTALL_STATUS}}` is exactly one of these two paragraphs.

Published, only when the GitHub Release for `v0.1.0-rc.9` exists, is a prerelease, and its target commit equals `{{RC_COMMIT}}`:

`The GitHub Release record for v0.1.0-rc.9 on {{UTC_DATE}} targets {{RC_COMMIT}}. Install with --ref v0.1.0-rc.9.`

Unpublished, while that Release record is absent:

`No GitHub Release record for v0.1.0-rc.9 exists as of {{UTC_DATE}}. The candidate is unpublished. Do not install v0.1.0-rc.9 from GitHub. v0.1.0-rc.1 was local preparation only; rc.1 and rc.2 were not published.`

The prepared draft uses the unpublished paragraph. A later publisher replaces that whole paragraph with the published paragraph. The UTC date is the body preparation date until a published Release record supplies its own date. The body must not include private paths, identities, configuration, credentials or evidence repositories.

## Before publishing a candidate

- [ ] Work from the approved public ancestor in a clean clone, with only permitted changes. Do not merge unpublished development history. Save the base, full commit/tree, patch/bundle hashes and exact file list.
- [ ] Run locked `npm ci`, local build and `npm run verify` on the **combined final candidate**. All thirteen local gates, including real Paseo compilation, plugin tests, privacy/reachable-history/identity/leak checks, contracts and actual package bytes must pass. Separate component checks are not final-candidate evidence.
- [ ] Check `npm pack --dry-run --json` and actual packed bytes, all eight generated commands and Node-only CLI behavior. Put artifacts outside the checkout. Packing is an internal gate, not npm publication.
- [ ] Get independent review by a different actual model and leader acceptance of the exact diff. Require clean Git status; record the outcome before publishing.
- [ ] In isolated home/cache/data/ports with no production configuration or credentials, test exact-candidate local Git acquisition/preparation, explicit-ref updates/downgrades, failure preservation and same-id directory-to-Git conversion. Use `NODE_ENV=production` as a separate preparation case.
- [ ] Test the actual installed product's desktop and compact page, sidebar/deep link/workspace filter, board/Fleet tabs, language/theme, RPC success/error and cleanup. Record real phone and authenticated provider first-card evidence separately; mocks/anonymous DOM fixtures are not substitutes.
- [ ] Check default and explicit data roots, host settings/enabled restoration, current CLI paths, and separate code/data rollback. Record macOS, Linux and WSL2 individually; leave unsupported or untested environments explicit.
- [ ] Confirm owner publication authorization and private vulnerability reporting. Publish only the reviewed ref by an approved ordinary push; no force push, unrelated refs, npm publish or registry submission is implied.
- [ ] Resolve the final public full SHA again from GitHub, compare it to the reviewed artifact, and replay the GitHub README commands in a second clean home. Retain results before describing this remote candidate as validated.

Hosted CI is not enabled or required by this integration. All required tests/builds run locally before handoff or merge. External CI, publication or another card's completion can be recorded as waiting work; it is not a reason to claim a local check passed or to leave a prepared handoff unsubmitted.

## Release record template

Fill the draft with actual evidence before claiming publication:

| Field | Required evidence |
|---|---|
| Identity/version/status/date | Single plugin/package version; experimental or released status and verification date. |
| Public source | Repository, explicit branch or existing tag, and full remote commit. |
| Base/candidate/final | Full base, candidate/final commit and tree; explain changes and revalidation. |
| Artifacts | Bundle/patch/pack hashes and permitted file list. |
| Host/platform | Exact daemon/app/CLI/Node/npm/OS; provider and actual executor/reviewer models when used. |
| Contract/data | Schema/manifest hashes, stable data root, compatibility evidence, migration limits. |
| Local checks | Commands, exits, test totals, all thirteen gates and CLI/Paseo build. |
| Installation and UI | Local Git and fresh remote replay; real desktop/compact/phone separately. |
| First card | Completion, different-model review, leader acceptance and cleanup; mark missing conditions. |
| Recovery | Consistent data backup, host settings/enabled capture, failed-update and source/code/data recovery evidence. |
| Review/authorization | Exact reviewed artifact, review outcome, leader acceptance and authorized channel. |

## Command replay checklist

The following table records **prior c106 evidence**, not results for this unpublished RC. The c106 publication receipt confirms actual GitHub branch/full-SHA installation, preview/update/downgrade/re-upgrade, source conversion, installed CLI/RPC and official 0.11.2 Web UI in Edge on macOS arm64, Node 24.21.0/npm 12.1.0. Earlier local negative and data-restore probes are also marked below. The RC owner must record its own exact candidate/host, command, exit and before/after observations; the publishing owner repeats the new RC tag and full-SHA rows from GitHub after publication. Keep logs private and summaries anonymous.

Use a new test home in the child environment and an explicit CLI endpoint on **every** connection command, for example `paseo --host "$PASEO_TEST_HOST" plugin ...`, where the endpoint is `tcp://host:port`. Use `--home "$PASEO_TEST_HOME"` for local daemon startup; **never combine `--home` and `--host`**. The 0.11.2 target guard rejects that combination. Plugin/SDK `PASEO_URL` is a separate WebSocket URL with `/ws`, not the CLI `--host` value. Use a whitelist environment, no inherited agent identity/tokens, disabled relay/providers and explicit `false` optional adapters. A real provider test uses only a user-established isolated login, not copied production authentication.

| Replay | Required result; current document status |
|---|---|
| `paseo --version`, top-level/plugin/install/update help | 0.11.2 CLI and live isolated daemon recorded; help checked. |
| `install github:jasonhnd/paseo-kanban --ref integration/single-plugin-reviewed --json` | Prior c106 GitHub branch replay passed; the new RC tag remains pending. Local `file://` does not pass the remote RC row. |
| Install full final public SHA; local `file://` full SHA first | Prior c106 local and GitHub full-SHA installs passed with fresh cache, NODE_ENV=production and eight working bundles; repeat for the exact new RC and public tag. |
| `ls paseo-kanban --json`, `logs paseo-kanban --json` | Installed source/revision/path/enabled/load state and sanitized logs checked locally. |
| Repeat same-id install; nonexistent ref | Local refusals retained old path/revision/enabled/data and working RPC. |
| `update paseo-kanban --check --ref "$REVIEWED_COMMIT" --json` | Local preview left revision/path/state unchanged. |
| `update paseo-kanban --ref "$REVIEWED_COMMIT" --json` | Exact local revision, installed CLI/RPC/UI and stable data root checked. |
| Explicit `--ref "$PREVIOUS_COMMIT"` check/downgrade/re-upgrade | Local code downgrade and re-upgrade retained data; later writes survived code downgrade. |
| Local-only bad prepare/compile/activation refs | Real preparation failure, syntax compilation failure and activation exception retained old revision/path/enabled/running and RPC. Type-only errors do not exercise the host transpiler's failure path. |
| `disable`, `enable`, `remove`, reinstall same id | Local lifecycle and external-root retention checked. New install sets enabled=true; restore a previously disabled state explicitly. |
| Developer directory `install`/edit/typecheck/`reload` | Explicit-ref directory update returned `Plugin is a local directory: paseo-kanban`. An independent broken-directory reload stayed failed; repairing/reloading restored it, without a rollback. |
| Directory-to-Git and reverse conversion | Default/explicit anonymous roots, settings/language, CLI/exports and enabled restoration checked. Real provider/scheduler continuity remains unverified. |
| Consistent anonymous backup and data restore | Writers stopped and SQLite checkpoint busy=0; code downgrade retained later writes, separate compatible backup restore removed them. No production restore executed. |
| Installed `bin/paseo-kanban.mjs --help` / `list --json`; `roles.mjs ls`; doctors | Installed Node commands and matching roots checked. Doctor red/exit 2 with absent profiles/providers is expected; it is not authenticated setup success. |
| Real desktop/compact and physical phone | Official 0.11.2 web app in local Edge tested at desktop and compact sizes, with sidebar closed before compact content/actions. Physical phone and native Electron remain unverified. |
| Real provider first card | User-established isolated login and actual executor/reviewer/leader cycle remain unverified; anonymous continuity cards and agent-free workspaces do not pass this row. |

The prior c106 Web observation distinguished 99 successful plugin RPC replies, one expected stale-save conflict and zero unexpected errors; it does not establish that the new RC UI was tested. A response count alone does not establish zero RPC errors. The assembled earlier one-command lab bootstrap was syntax checked only; component commands and final-candidate key replays were executed separately. Keep the exact tested source SHA/tree, installed revision, versioned logs and images in the release record; rerun required gates on each final candidate. RC publication/GitHub replay, production switching and registry submission remain separate operations.

`REVIEWED_COMMIT` and `PREVIOUS_COMMIT` are full public SHAs from the release record. An unpublished candidate uses a local `file://` source, never an invented remote SHA. Branch refs can move between separate preview/apply operations; use the exact preview SHA for a controlled rollout. Never push deliberately broken failure-test refs.

Official sources: [0.11.2 reference](https://github.com/getpaseo/paseo/blob/75953250959979b8f088bbca8dbd6ee61d0151b1/public-docs/plugins/reference.md#cli-reference), [publishing](https://github.com/getpaseo/paseo/blob/75953250959979b8f088bbca8dbd6ee61d0151b1/public-docs/plugins/publishing.md), and [current registry review snapshot](https://github.com/getpaseo/plugins/blob/06c64d182a3b0e0d879992231d1cf3c9a6bbf809/REVIEW.md). Syntax/document review does not certify runtime behavior.

## Updating and recovery

Record current/target full commits, source kind, actual paths, root and enabled state. Pause dispatch/writers, take [consistent data and separate host settings backups](DATA.md#backup-and-data-restore), then preview/apply an explicit SHA:

```sh
paseo plugin update paseo-kanban --check --ref "$REVIEWED_COMMIT" --json
paseo plugin update paseo-kanban --ref "$REVIEWED_COMMIT" --json
paseo plugin ls paseo-kanban --json
```

Verify policy/matrix as well as the following checks.

After every upgrade or code rollback, keep dispatch paused until the same host reports the intended full revision, current installed path, enabled/running state and unchanged data root/settings. Refresh `BOARD_INSTALL`; run the installed Node CLI from that path. Wait for both exports to name it, then use an approved disposable decision in the real panel: close it, verify both counts and stored done state, Undo while mounted, and verify it is open again. An export match or `running` alone does not prove a write works. If an action fails, preserve the error and keep dispatch paused.

When downgrading to c106 or the unchanged local rc.1/rc.2 code, **run `paseo plugin reload paseo-kanban --json` on that same host after the update and require `running` before the checks above**. Those older versions cache command paths at module load. Use the same `--host` or local `--home` selector on reload and all plugin commands; never both. Do not use an unpublished tag for a GitHub rollback. Reload failure stays failed until repaired/reloaded; it is not automatic rollback. A daemon restart is not required solely for this code change.

Before resuming, require the approved demo cycle too. A managed update failure retains the prior installation; inspect its revision/path/enabled state and working action. A failed reload stays failed until repaired/reloaded; it does not restore an old bundle automatically. Loading code changes does not require restarting the daemon.

Git code rollback uses the recorded previously verified public SHA on `update --check --ref` and `update --ref`. Keep current data and verify schema compatibility. Data restoration is a separate, explicitly authorized action with all writers stopped and a consistent compatible backup; preserve current state first because restoring can lose later writes. Do not automatically recover data in response to an update error.

## Directory-to-Git switch runbook

**Prepared procedure, not executed production migration.** A usage-side operator needs authorization for the actual source/operating-mode switch, reviewed final remote SHA and successful isolated conversion/recovery evidence. This document does not give an agent permission to read production configuration, databases or credentials.

1. Identify the intended host, same runtime id `paseo-kanban`, current directory path/source/enabled state, and actual canonical data root. Keep `PASEO_HOME` and `KANBAN_DATA_DIR` unchanged. Save host plugin settings/language/enabled separately and a consistent private root backup; retain the unchanged old source directory. Do not import old Fleet data as part of this conversion.
2. Pause dispatch, scheduled helpers and every writer. Rehearse a pause mechanism that remains effective during install: 0.11.2 sets a new installation enabled=true, even after removing a disabled source, and starts it immediately when the global switch is on. Do not perform a live switch until that behavior is controlled. One warmed-cache isolated directory-to-Git rehearsal measured a 19.67-second gap between successful board RPC responses with 100 ms sampling. This is a planning observation, not a production duration or uptime promise; measure the intended environment separately.
3. On that same host, disable and remove the directory installation. Removal keeps the source directory, but may delete host plugin settings. A directory source cannot be converted by ordinary update, and same-id Git install is rejected until removal.

   ```sh
   paseo plugin disable paseo-kanban --json
   paseo plugin remove paseo-kanban --json
   paseo plugin install github:jasonhnd/paseo-kanban --ref "$REVIEWED_COMMIT" --json
   paseo plugin ls paseo-kanban --json
   ```

   Prefix every command with the intended `--host` endpoint or local `--home` selection when nondefault, never both. Do not hand-edit source entries or use config reload as a substitute for lifecycle commands.
4. Confirm Git source/full revision/new path, same external data root across server/board/Fleet/CLI/exports, and no discarded `KANBAN_HOME` reference. Restore saved settings and intended enabled state; refresh CLI launchers/exports. Confirm policy/matrix, roles, counts, running/error/tick state, actual desktop/phone surfaces and a permitted demo cycle before resuming dispatch. Leave missing phone/provider evidence explicitly unresolved.
5. On failure, keep writers paused and the old directory intact. If a Git entry exists, disable/remove it. Reinstall the unchanged directory with `paseo plugin install "$PREVIOUS_DIRECTORY" --json`, then restore saved host settings/enabled state and verify the same root/CLI/UI. `PREVIOUS_DIRECTORY` is the previously recorded absolute local source path. This code/source recovery is not data restore.

No daemon restart is needed solely to install/update/reload source. Changing startup environment, data root, relay or provider configuration is a separate operating change with its own authorization and restart plan; restarting can interrupt running agents. This conversion preserves those values and does not migrate/merge old databases. Production-specific paths and backups stay private with the usage-side operator.

## Registry submission draft

**Draft only; not submitted and not listed.** Direct Git installation through the official CLI is independent of official registry approval. Recheck the current registry policy before a future submission; the current reviewed snapshot is linked above. A submission normally produces a review PR pinned to one artifact; maintainers review it and merge approval. Pushing Git commits does not list the plugin or update an approved registry pin.

| Draft field | Proposed content / unresolved evidence |
|---|---|
| Route | [Official submission form](https://github.com/getpaseo/plugins/issues/new?template=submit-plugin.yml). |
| Name | Paseo Kanban. |
| Source | `https://github.com/jasonhnd/paseo-kanban/tree/<REVIEWED_PUBLIC_COMMIT>`; replace with the final full reviewed public SHA before sending. |
| Categories | Orchestration first, Sidebar second. |
| Description | Cross-project coding-agent cards with Fleet roles, quota policies, independent review and leader acceptance. |
| Setup/access/limits | [OVERVIEW](../OVERVIEW.md), host/platform limits, [DATA](DATA.md) and completed release evidence. |
| Media | Package-relative `assets/board.png` and `assets/quota.png` show actual installed 0.11.2 Web UI with synthetic data; `assets/icon.png` is manifest metadata for possible future registry display; the official 0.11.2 Web plugin list does not display it. See [capture details](MEDIA.md). Recheck the assets at the final pinned artifact; these images do not establish registry approval or provider/device validation. |
| Artifact review inputs | Root manifest and both entries, dependency lock/origins, preparation and eight CLI purposes, exact public commit/hash, MIT attribution and access description. |

The current form requires Source and offers categories. Visual interfaces need a suitable image under registry review policy; this is a listing requirement, not a Git install parser requirement. Account login/2FA and author authorization remain under the user's control. No agent submits the draft, publishes private data or guarantees official approval/date. Registry Git updates require another reviewed pin; this direct-Git update guide does not update that listing.

Project readiness policy schedules a registry request after successful daily use and a separate decision. Before claiming stability, observe at least **14 days and 20 real requested complete cards**, covering worker roles, independent review, restart, supported patch updates and demo-data recovery, with no unresolved P0/P1. Do not invent tasks to reach a count. This project policy is not an official prerequisite for direct Git installation. Longer evidence and a separate decision are needed for 1.0.

Track each evidence-backed item once as landed, broken, unverified, pending or abandoned; move it as status changes. The [offline operations rehearsal](OPERATIONS-DEMO.md) tests issue-to-draft flow without contacting GitHub or a live daemon and does not replace real installation/provider checks.

## Command Center host limitation

The official 0.11.2 Web empty homepage has no installation host context and does not show the Open project board action. Open Paseo Kanban from the sidebar first. See [compatibility](COMPATIBILITY.md#command-center-and-manifest-icon). This documentation correction does not fix the host behavior.
