# Changelog

The single plugin has one version and CHANGELOG. Distribution is through Git.
Five release candidates are recorded here. `0.1.0-rc.5` is the current candidate, pending independent review. rc.4 retains its original commit and tag. `0.1.0-rc.3` remains frozen, unpublished and rejected for publication. `0.1.0-rc.2` remains frozen and unpublished. `0.1.0-rc.1` was local preparation only and was not published. No GitHub Release is declared by this document. There is no npm publication or official registry listing.

## 0.1.0-rc.5 — pending review and publication

Local candidate tag: `v0.1.0-rc.5`. This candidate is prepared only; install it from GitHub only after its matching prerelease targets the independently reviewed full commit in the [release record](docs/RELEASE.md). Frozen rc.1 through rc.4 tags are never moved.

### Fixed

- Successful new executor/reviewer runs, resumes and lost-create adoption clear obsolete current blocked/cooldown fields left by quota or rate-limit failures. Historical events and runs remain; failed creation or sending retains the previous reason.
- Default stale-policy diagnostics correctly describe retained pool stops and matrix pauses. The existing `preserveStops`/`matrixPaused` behavior and explicit legacy compatibility path are unchanged.

### Changed

- The board sidebar uses the supported header contribution and host `SidebarRow`, keeping the existing board screen and sidebar preference identity. A Command Center action registered with `context: global` opens the same screen on pages with the installation's host context; its dedicated English/Chinese translation updates with the selected language. In official 0.11.2 Web, an empty homepage has no such context and does not show the action, including after leaving a plugin page. Use the sidebar to open the board first.
- English/Chinese README entry guidance is shorter, and OVERVIEW distinguishes measured Web UI evidence from unverified native/provider flows. Anonymous installed Board and quota screenshots and an original board icon are included with manifest media metadata; their capture scope remains in [media details](docs/MEDIA.md).
- The Node minimum rises from **22.13.0 to 24.21.0**. The separate rc.4 minimum-version measurement on Node 22.13.0 passed only **12/13 gates**, and a SQLite experimental warning contaminated CLI JSON error output. The same frozen source passed 13/13 gates on Node 24.21.0. This does not certify intermediate Node versions. Package/root-lock engines and current English/Chinese requirements now agree on `>=24.21.0`.

### Known host limitations

- The rc.5 description of the Command Center action as globally available was too broad. In official 0.11.2 Web it requires the installation's host context; an empty homepage does not expose plugin actions. Registration changes cannot bypass the host's filter. This documentation correction does not fix the host behavior.
- The official 0.11.2 Settings -> Plugins list does not consume manifest `icon`/`media`. The packaged PNG remains metadata for possible future registry display, separate from contribution icons; no registry listing is claimed.

### Notes

- Package and lock metadata are `0.1.0-rc.5`. Paseo daemon/app requirements remain `>=0.11.0 <0.12.0`; official 0.11.0 with Node 24.21.0 was measured separately on rc.4. Dependencies, schemas and contract versions are unchanged.
- Exact rc.5 verification and outgoing annotated-tag gates require new receipts. Earlier component or rc.4 results do not pass this integrated candidate. GitHub tag/full-SHA installs, lifecycle replay, native app, physical phones, authenticated provider cycles, Linux/WSL2 and production recovery remain separate unverified work. Existing dependency alerts remain unresolved.

## 0.1.0-rc.4 — pending review and publication

Local candidate tag: `v0.1.0-rc.4`. Install from GitHub only after its matching prerelease targets the reviewed full commit in the [release record](docs/RELEASE.md). This preparation does not publish it. Frozen rc.1, rc.2 and rc.3 tags are never moved.

### Fixed

- Default immutable policy consumption no longer reopens a producer's `dispatchable=false` when the snapshot expires, including quota-unprotected and older low-usage entries. Default routing retains matrix pauses across expiry. An originally open `quotaProtection=none` pool without a matrix pause remains eligible; explicit legacy compatibility behavior is unchanged.
- Anonymous regression exercises the real pool producer, contract projection, immutable publication and default reader/routing/start path with a fake launcher. It covers freshness/TTL boundaries, protected expiry, missing/invalid policy, digest changes, local disabled pools, stale 99-percent legacy readings and producer safety stops.

### Notes

- Package and lock metadata are `0.1.0-rc.4`. Prior artifact-acceptance, decision-panel and managed command-path fixes remain. Dependencies, schemas and contract versions are unchanged.
- The frozen rc.3 default stale-policy failure is retained. rc.3 at `61cce0d8ba07e8bf01fe7239ddf0ceeaf5983df4` (tree `633c99456b05cdbf7156f5c3ab1149451a767738`, annotated object `7e288e22f42598a651edef407dcdb82871c3d9de`) must not be published. Prior component or rc.3 gate results do not pass the new exact candidate.
- Required final local gates and installed default-policy/UI evidence belong in the new candidate record. GitHub tag/full-SHA installation, three-host upgrade, natural 600-second refresh and rollback replay remain separate post-publication work. The earlier hot-update failure, mounted-only Undo, uppercase-host refusal, unresolved dependency alerts and all unverified phone/native/provider/platform/production limits remain below.

## 0.1.0-rc.3 — frozen local candidate, rejected for publication

Immutable candidate tag: `v0.1.0-rc.3`. Install it from GitHub only when its Release exists, is a prerelease, and targets the full reviewed commit in the [release record](docs/RELEASE.md). Otherwise it remains unpublished. Frozen rc.1 and rc.2 tags are never moved. rc.2 remains at `8be11b6144b6cc7b81bcf741a360acf18111001f`, annotated object `0e16a0c43de421db583a31b3dee7b6e6b67e6b82`.

### Fixed

- Decision replies, role changes and decision maintenance resolve the roles command at invocation time. A managed Git update starts candidate code before changing the host path; a module-level command path could therefore retain a deleted previous checkout even after exports refreshed. The new regression keeps the production dependencies loaded, switches the configured installation and deletes the old checkout before exercising all three command paths.
- Includes both reviewed artifact-acceptance and decision-panel fixes listed for rc.2. Package and lock metadata are `0.1.0-rc.3`; schema, contracts and dependency selections remain unchanged.

### Notes

- The previous hot-update decision-write failure is retained. Export agreement alone is insufficient: upgrades and code rollbacks require current CLI and real decision close/Undo/count/state checks. Downgrades to older c106/rc.1/rc.2 code also require an official single-plugin reload before those checks; see [recovery](docs/RELEASE.md#updating-and-recovery).
- The approximately 600-second export period, mounted-panel-only Undo and rejection of uppercase `https://GITHUB.COM/` remain. Dependency alerts are unresolved. Phones, native app, authenticated provider cycles, Linux/WSL2 and production recovery remain unverified.
- Exact rc.2 results or component results do not establish the final rc.3 pass. Final local candidate gates and actual installed-product checks belong in its evidence record. GitHub tag/full-SHA cold installation is pending until publication and must not be inferred from local Git tests.

## 0.1.0-rc.2 — frozen local candidate, unpublished

Planned immutable tag: `v0.1.0-rc.2`. This is an experimental prerelease, not a stable release. Local tag `v0.1.0-rc.1` already names `22958ff54c955c1a90683f786d3ebb8b9ae88470` and is not moved. When this candidate was prepared, the remote tag list and GitHub Releases did not include `v0.1.0-rc.1` or `v0.1.0-rc.2`; the publishing owner checks the GitHub Release record again before any install. The public code baseline remains [c106efb88a659931d01f40a236001823473561a8](https://github.com/jasonhnd/paseo-kanban/commit/c106efb88a659931d01f40a236001823473561a8). Install `--ref v0.1.0-rc.2` only when the GitHub Release for that tag exists, is a prerelease, and its target commit equals the reviewed commit in the release record. While that Release record is absent, this candidate is unpublished and the tag is not a GitHub install target. This heading does not claim that the Release exists. A UTC publication date belongs in the release record.

### Changed

- Package and lock metadata agree on `0.1.0-rc.2`. English and Chinese setup, Git installation and recovery name that tag only inside the GitHub Release condition above. `v0.1.0-rc.1` remains the unpublished local preparation in the next section.

### Fixed

- Artifact acceptance records a detached HEAD and the card pull request without landing the local branch. A pull-request artifact must use lowercase `https://github.com/`. An uppercase host such as `https://GITHUB.COM/` is rejected. Owner and repository comparison stays case-insensitive.
- Decision panels share one close cache. A newer omission drops a restored row, and a newer close omission advances the close watermark, so region counts stay aligned after undo and a close from another region.
- Undo still exists only while its panel stays mounted. Leaving the panel or reloading removes Undo. The stored done state and the zero count remain. That limit is unchanged.

### Notes

- This candidate contains both reviewed fixes. It is not a metadata-only change from c106. Schema, contract versions and dependency selections are unchanged. Dependencies were not upgraded and `npm audit fix` was not applied. Existing dependency deprecation and audit warnings remain unresolved. Passing build or privacy gates does not clear them.
- Board and Fleet information exports can keep command paths from a removed checkout for about 600 seconds, their existing export period. Use the current installed path; export agreement alone did not prevent the retained rc.2 hot-update write failure. Current recovery instructions additionally require real write checks and reload when returning to this older code. The export delay remains unchanged.
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
