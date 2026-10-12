# Manual release checklist

The combined plugin has one package, version, tag and CHANGELOG. This checklist does not authorize a push, tag, publish, production update or external message. Local checks are required; GitHub Actions is not a prerequisite and must not be enabled merely to satisfy the checklist.

## Version policy

First release: `0.1.0`, **experimental**. In 0.x, a patch is a compatible fix; new features or breaking configuration/behavior changes increment the minor version. From 1.x, use SemVer: breaking changes increment major, compatible additions minor, fixes patch. Package version, release heading, npm version when published and `vX.Y.Z` tag agree for the same plugin.

Keep Added, Changed, Fixed, Security and Notes sections under Unreleased. Notes must state host range, schema/contract changes, tested standalone compatibility inputs, fresh-install storage and manual transfer/rollback limits. Contract versions are separate from package versions: compatible additions retain v1; breaking changes require a new schema version.

## Before a release

- [ ] Triage the intended changes, link issues to self-contained briefs, and assign an owner for shared issues. Verify actual fixes against reproduction steps.
- [ ] Install locked development dependencies with `npm ci` and build the combined commands with `npm run build`.
- [ ] Run `npm run verify` on the exact candidate in the single package. Retain commands, full commit ids, exits and summaries. All thirteen gates, including actual Paseo compilation, plugin tests, leak/privacy/identity checks and package whitelist, must pass locally.
- [ ] Check `npm pack --dry-run --json`, version metadata and CHANGELOG. Put any actual package artifacts outside the checkout. Test unpacked CLI commands with Node alone.
- [ ] Obtain independent review by a different actual model and lead acceptance. Keep the tree clean. Record the exact combined candidate and frozen source inputs.
- [ ] In a disposable home with isolated data, test actual candidate installations from npm artifacts and Git tags, desktop mounting, language persistence, roles, leader protocol/registration and a complete first card. Check one plugin/sidebar, board/workspace navigation and Fleet panels. Unverified phone behavior remains explicitly unverified.
- [ ] Record macOS and Linux evidence separately before claiming support; WSL2 is a separate record. Verify failure recovery, settings restoration, provider paths and affected upgrade/downgrade behavior. Pure mocks or a minimal sample plugin do not count as product validation.
- [ ] The single manifest runs `server/prepare.mjs`; see [Git installation](GIT-INSTALL.md). Generated `bin/*.bundle.mjs` are ignored by Git; npm artifacts include all eight prepacked bundles. Validate the actual clean-host installation. Do not release a Git tag whose installed commands need a development checkout.
- [ ] Confirm the owner has enabled GitHub private vulnerability reporting and checked the repository's Report a vulnerability entry. Publication must not invent an alternate email address.
- [ ] Obtain the owner's publication authorization. If history is rewritten before first publication, rerun checks and validate the final commit before making the immutable release tag.

## Release record template

Copy this into the release evidence; replace every placeholder before publishing:

| Field | Required value |
|---|---|
| Plugin/package/version/date | This plugin only; CHANGELOG release heading |
| Candidate and final commit | Full hashes; explain any difference and revalidation |
| Tag -> commit | `vX.Y.Z` -> full commit; verify with `git rev-parse vX.Y.Z^{commit}` |
| Compatibility inputs | Frozen source commits and explicitly tested legacy fixtures |
| Host/platform | Daemon/app/Node/npm/OS versions; provider/model/family |
| Contract | Schema, manifest hashes and interoperability evidence |
| Local verification | Commands, exits, test totals, CLI/Paseo build and scan results |
| Package | `npm pack` file list and unpacked command results |
| Review and desktop evidence | Review outcome, actual panel and first-card checks |
| Recovery | Consistent data/settings backups, disabled-state handling, rollback test |
| Release authorization | Owner approval and intended distribution channels |

Create a tag only on the clean, reviewed, verified commit. Never move, overwrite or reuse a published tag; correct mistakes with a new version. Preserve access to the previous tag and its commit for rollback.

## Experimental, stability and distribution

An experimental first release may precede the long stability observation, after clean-host release validation and authorization. Keep the experimental label. Before claiming stability, observe the newly installed code for at least **14 days and 20 real, complete requested cards**, covering all five worker roles, independent review, any implemented ordinary self-check mode, restart, supported patch updates and demo-data rollback, with no unresolved P0/P1 defects. Never invent tasks to reach a count. A seven-day data-migration observation does not replace this code observation. A 1.0 claim requires longer evidence and a separate decision.

Maintain one evidence-backed status per item: landed (card/commit), broken, unverified (implemented without independent real-world validation), pending (requested), or abandoned (attempt and reason). Move entries when evidence changes rather than duplicating them.

Registry submission follows a period of successful daily use and a separate readiness decision; it is not automatically triggered by the first tag or npm release. Evaluate accumulated changes regularly and release when justified; no fixed release or response schedule is promised.

## Updating and recovery

Record current/target tag, full commit, source, path and enabled state. Pause dispatch/writes, take consistent data backups and separately save plugin settings/language and enabled state. Preview the explicit target with `update --check --ref`, then apply `update --ref`. Check revision, actual data-directory logs, configuration, quota matrix, installed CLI paths, card counts, desktop panels and a demo card before resuming.

Changing source requires backup, remove/install and restoration of settings/enabled state; it is not an ordinary update. Removal can delete plugin settings and managed checkout files while preserving plugin-data. Reinstallation may briefly enable the plugin. Rehearse with disposable data first. A failed update may try to restore the previous installation; verify the result. A failed reload does not itself restore an old bundle. Explicitly return to the previous verified tag and repeat checks. Preserve new data before restoring a compatible consistent backup; code rollback alone does not reverse a data migration.

## Offline issue-to-release rehearsal

Use [the rehearsal fixture](OPERATIONS-DEMO.md) locally. It exercises issue intake, scope, card brief, review/acceptance criteria and an unpublished release draft without contacting GitHub or a live daemon. It does not replace the clean-host first-card gate.
