# Changelog

The single plugin has one version and CHANGELOG. Distribution is through Git.
Two release candidates are recorded here. `0.1.0-rc.2` is the integrated candidate. `0.1.0-rc.1` was local preparation only and was not published. Neither GitHub Release is declared by this document. There is no npm publication or official registry listing.

## 0.1.0-rc.2 — pending publication

Planned immutable tag: `v0.1.0-rc.2`. This is an experimental prerelease, not a stable release. Local tag `v0.1.0-rc.1` already names `22958ff54c955c1a90683f786d3ebb8b9ae88470` and is not moved. When this candidate was prepared, the remote tag list and GitHub Releases did not include `v0.1.0-rc.1` or `v0.1.0-rc.2`; the publishing owner checks the GitHub Release record again before any install. The public code baseline remains [c106efb88a659931d01f40a236001823473561a8](https://github.com/jasonhnd/paseo-kanban/commit/c106efb88a659931d01f40a236001823473561a8). Install `--ref v0.1.0-rc.2` only when the GitHub Release for that tag exists, is a prerelease, and its target commit equals the reviewed commit in the release record. While that Release record is absent, this candidate is unpublished and the tag is not a GitHub install target. This heading does not claim that the Release exists. A UTC publication date belongs in the release record.

### Changed

- Package and lock metadata agree on `0.1.0-rc.2`. English and Chinese setup, Git installation and recovery name that tag only inside the GitHub Release condition above. `v0.1.0-rc.1` remains the unpublished local preparation in the next section.

### Fixed

- Artifact acceptance records a detached HEAD and the card pull request without landing the local branch. A pull-request artifact must use lowercase `https://github.com/`. An uppercase host such as `https://GITHUB.COM/` is rejected. Owner and repository comparison stays case-insensitive.
- Decision panels share one close cache. A newer omission drops a restored row, and a newer close omission advances the close watermark, so region counts stay aligned after undo and a close from another region.
- Undo still exists only while its panel stays mounted. Leaving the panel or reloading removes Undo. The stored done state and the zero count remain. That limit is unchanged.

### Notes

- This candidate contains both reviewed fixes. It is not a metadata-only change from c106. Schema, contract versions and dependency selections are unchanged. Dependencies were not upgraded and `npm audit fix` was not applied. Existing dependency deprecation and audit warnings remain unresolved. Passing build or privacy gates does not clear them.
- Board and Fleet information exports can keep command paths from a removed checkout for about 600 seconds, their existing export period. Use the current installed path, and wait until both exports match it before resuming dispatch. This candidate does not certify or fix immediate export freshness.
- Physical phones, the native app, and an authenticated provider first-card, review, acceptance and cleanup cycle remain unverified. A compact browser viewport is not a phone test. Linux, WSL2 and production recovery remain unverified.
- A GitHub tag or full-SHA cold install of this RC is not claimed. Repeat that check only after the GitHub Release record exists. A local `file://` check does not pass that row.
- The final pass is the gate record for this integrated commit. Exact results from `0.1.0-rc.1`, or from either fix by itself, are not that pass.

## 0.1.0-rc.1 — pending publication

Planned immutable tag: `v0.1.0-rc.1`. This is an experimental prerelease, not a stable release. The public preparation baseline is [c106efb88a659931d01f40a236001823473561a8](https://github.com/jasonhnd/paseo-kanban/commit/c106efb88a659931d01f40a236001823473561a8). The final reviewed RC commit and publication date belong in the release record after publication; this heading does not claim that the tag exists.

### Added

- Default review dispatch includes an independent Codex `gpt-6-sol` slot at `xhigh` on L1 through L4. It matches that exact model and does not use the GPT-6.1 slot.
- Experimental plugin sources, standalone Node commands and English/Simplified Chinese interfaces.
- Public setup, workflow, data, compatibility and manual release documentation.
- Bug, feature and compatibility report templates and private disclosure guidance.

### Changed

- Package and lock metadata agree on `0.1.0-rc.1`; English and Chinese setup documents the planned tag, explicit-ref check/update and exact public-SHA rollback. Tag installation remains pending until remote publication is confirmed.
- User Git installation is separate from developer directory flow; access/adapter inheritance, canonical-root backups and code versus data recovery are documented.
- Command replay checklist, usage-side directory-to-Git runbook and registry draft are prepared, without claiming production switching, installed-product acceptance or external submission is complete.
- The public [fcf-to-c106 changes](https://github.com/jasonhnd/paseo-kanban/compare/fcf1b97c9db2c610b376ea792c50428fbc8f07f8...c106efb88a659931d01f40a236001823473561a8) document locked Git preparation, daemon/SDK target selectors, canonical-root backups and separate source/code/data recovery. Their isolated official 0.11.2 Git lifecycle and web-app validation is recorded separately from new RC verification.

### Fixed

- The sidebar registers one standard item (`id`, `title`, `icon`, `surface`) that shares `board` with the screen. Desktop and compact sidebars open that same panel: nine tabs, settings, the shared language control, and the workspace panel registered on `board`. A physical phone is still unverified.
- Between fcf and c106, remembered language and panel titles now use browser-only storage helpers: native clients do not read the `localStorage` getter; blocked browser storage does not prevent in-memory language changes. Native/device behavior has source regression coverage, not physical-device validation.

### Security

- Local privacy, identity, history leak and package-content gates are required.
- Private vulnerability reporting must be enabled by the owner before release.

### Notes

- The RC changes only package/lock metadata and documentation relative to c106; runtime code, manifest, dependency selections, schema and contract versions are unchanged. Official 0.11.2 uses Git revision/selector identity, not a manifest `version` field.
- Paseo daemon/app range: >=0.11.0 <0.12.0; official command/compiler baseline: 0.11.2. Help/docs syntax checks are not installed-product validation; full platform/app/phone/provider first-card evidence remains separate.
- Admission uses immutable paseo-policy/v1; fleet-quota/v1 and contractVersion 1.2.0 remain same-root compatibility interfaces. These documentation changes introduce no contract or data migration.
- Canonical root: KANBAN_DATA_DIR or PASEO_HOME/plugin-data/paseo-kanban. Old Fleet data is not automatically imported.
- The published c106 source passed isolated official 0.11.2 GitHub branch/full-SHA installation, explicit preview/update/downgrade/re-upgrade, removal/reinstallation, directory-source conversion, installed Node commands/RPC and desktop/compact Web UI in Edge on macOS arm64. These prior results do not verify the unpublished RC tag; repeat the exact RC gates and post-publication GitHub replay in [the release checklist](docs/RELEASE.md).
- Physical iOS/Android, native Electron, authenticated different-model provider first-card/review/acceptance/cleanup, Linux/WSL2 and production scheduling/data recovery remain unverified. A compact browser viewport is not a phone test.
- Existing dependency deprecation/audit warnings remain unresolved. No dependency upgrade or `npm audit fix` is included; the preparation installs development/build dependencies. Keep the exact plugin and official-host audit observations in the release record; passing build/privacy gates does not clear those alerts.
- Code downgrade does not undo data writes; a separate compatible backup restore can discard newer writes. New installs set enabled=true and can start immediately when global plugins are enabled. No automatic legacy data import or production migration is included.
