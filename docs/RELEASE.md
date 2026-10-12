# Git release and recovery checklist

This batch distributes the single plugin through **Git only**. The public repository is `https://github.com/jasonhnd/paseo-kanban`, branch `integration/single-plugin-reviewed`. Package version `0.1.0` is experimental metadata, not evidence of an npm release, published tag or official registry listing. Repeat this checklist for each candidate; the table below records measured local scope and it does not declare publication, production switching or external submission complete, and does not authorize those operations.

## Version and evidence policy

The combined plugin has one package/version/CHANGELOG and runtime id `paseo-kanban`. In 0.x, use patches for compatible fixes and minors for new features or breaking configuration/behavior. From 1.x, use SemVer. Contract/schema versions are separate; compatible additions retain their version, while breaking changes need an explicit migration/recovery plan.

A Git branch is mutable. Every release record must save a full reviewed public commit, regardless of whether a tag exists. A tag is optional for this channel; do not document one as an install target before it exists. If a tag is later used, align it with package/CHANGELOG version, review its metadata, and never move, overwrite or reuse it. Preserve the previous verified public commit for rollback.

Keep Added, Changed, Fixed, Security and Notes under Unreleased until publication is verified. Notes must state host range, data/contract changes and real test limits. Do not turn source-only checks into app/provider certification.

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

Syntax was checked against public **Paseo CLI 0.11.2 help and fixed docs**, then exercised with actual isolated local Git installations and the official 0.11.2 web app on macOS arm64, Node 24.21.0/npm 12.1.0. The isolated-validation and final-integration owners must fill this table with exact candidate/host, command, exit and before/after observations; the publishing owner repeats applicable rows from GitHub after the final ref is public. Keep logs private and summaries anonymous.

Use a new test home in the child environment and an explicit CLI endpoint on **every** connection command, for example `paseo --host "$PASEO_TEST_HOST" plugin ...`, where the endpoint is `tcp://host:port`. Use `--home "$PASEO_TEST_HOME"` for local daemon startup; **never combine `--home` and `--host`**. The 0.11.2 target guard rejects that combination. Plugin/SDK `PASEO_URL` is a separate WebSocket URL with `/ws`, not the CLI `--host` value. Use a whitelist environment, no inherited agent identity/tokens, disabled relay/providers and explicit `false` optional adapters. A real provider test uses only a user-established isolated login, not copied production authentication.

| Replay | Required result; current document status |
|---|---|
| `paseo --version`, top-level/plugin/install/update help | 0.11.2 CLI and live isolated daemon recorded; help checked. |
| `install github:jasonhnd/paseo-kanban --ref integration/single-plugin-reviewed --json` | Final published GitHub revision/path/preparation must be replayed by the publication owner; local `file://` evidence does not pass this row. |
| Install full final public SHA; local `file://` full SHA first | Isolated full-SHA local Git preparation passed with fresh cache, NODE_ENV=production and eight working bundles; repeat from GitHub once the reviewed SHA is public. |
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

The local evidence distinguishes successful RPC outputs, the expected stale-save conflict and unexpected errors. A response count alone does not establish zero RPC errors. The assembled one-command lab bootstrap was syntax checked only; component commands and final-candidate key replays were executed separately. Keep the exact tested source SHA/tree, installed revision, versioned logs and images in the release record; rerun required gates on each final candidate. Production switching, GitHub publication/replay and registry submission are still separate operations.

`REVIEWED_COMMIT` and `PREVIOUS_COMMIT` are full public SHAs from the release record. An unpublished candidate uses a local `file://` source, never an invented remote SHA. Branch refs can move between separate preview/apply operations; use the exact preview SHA for a controlled rollout. Never push deliberately broken failure-test refs.

Official sources: [0.11.2 reference](https://github.com/getpaseo/paseo/blob/75953250959979b8f088bbca8dbd6ee61d0151b1/public-docs/plugins/reference.md#cli-reference), [publishing](https://github.com/getpaseo/paseo/blob/75953250959979b8f088bbca8dbd6ee61d0151b1/public-docs/plugins/publishing.md), and [current registry review snapshot](https://github.com/getpaseo/plugins/blob/06c64d182a3b0e0d879992231d1cf3c9a6bbf809/REVIEW.md). Syntax/document review does not certify runtime behavior.

## Updating and recovery

Record current/target full commits, source kind, actual paths, root and enabled state. Pause dispatch/writers, take [consistent data and separate host settings backups](DATA.md#backup-and-data-restore), then preview/apply an explicit SHA:

```sh
paseo plugin update paseo-kanban --check --ref "$REVIEWED_COMMIT" --json
paseo plugin update paseo-kanban --ref "$REVIEWED_COMMIT" --json
paseo plugin ls paseo-kanban --json
```

Before resuming, verify revision, actual server/CLI/Fleet root, settings/language, policy/matrix, counts, exports/CLI paths, real page and an approved demo cycle. A managed update failure retains the prior installation; inspect its revision/path/enabled state and working action. A failed reload stays failed until repaired/reloaded; it does not restore an old bundle automatically. Loading code changes does not require restarting the daemon.

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
| Media | At least one anonymous image of the actual installed visual interface, preferably PNG with an HTTPS asset URL; still to be supplied/verified. |
| Artifact review inputs | Root manifest and both entries, dependency lock/origins, preparation and eight CLI purposes, exact public commit/hash, MIT attribution and access description. |

The current form requires Source and offers categories. Visual interfaces need a suitable image under registry review policy; this is a listing requirement, not a Git install parser requirement. Account login/2FA and author authorization remain under the user's control. No agent submits the draft, publishes private data or guarantees official approval/date. Registry Git updates require another reviewed pin; this direct-Git update guide does not update that listing.

Project readiness policy schedules a registry request after successful daily use and a separate decision. Before claiming stability, observe at least **14 days and 20 real requested complete cards**, covering worker roles, independent review, restart, supported patch updates and demo-data recovery, with no unresolved P0/P1. Do not invent tasks to reach a count. This project policy is not an official prerequisite for direct Git installation. Longer evidence and a separate decision are needed for 1.0.

Track each evidence-backed item once as landed, broken, unverified, pending or abandoned; move it as status changes. The [offline operations rehearsal](OPERATIONS-DEMO.md) tests issue-to-draft flow without contacting GitHub or a live daemon and does not replace real installation/provider checks.
