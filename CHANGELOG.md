# Changelog

The single plugin has one version and CHANGELOG. Distribution is through Git.
Twelve release candidates are recorded here. `0.1.0-rc.12` is the current unpublished candidate, pending independent review. Public prerelease rc.11 was published on 2026-10-15 and its GitHub Release exists, frozen at `09963b85e0d7c9c5d881aa39e3c65ebbb719b7a0` (annotated object `042413d64aeee4f41c34120b4b3af4003c685741`). Public prerelease rc.10 was published on 2026-10-15 and its GitHub Release exists, frozen at `e4e070e8bdc8a41a8f8bc61e66ded8e1950b0129` (annotated object `48c4c9feab7d0f02c0010d5754e00ed2a1ddf7aa`). Public prerelease rc.9 was published on 2026-10-15 and its GitHub Release exists, frozen at `701594d452f24dcbf115aabcedd4e9be9f5f6bcb` (annotated object `dda2f0044ec08e25979f35787b42a08f4687104e`). Public prerelease rc.8 was published on 2026-10-14 and its GitHub Release exists. It remains frozen at `0af33ec7e49891bf3dba2549cb8b6b83487bba4c` (annotated object `303e4c27dd65f829743bc44c7242c1abd452c176`). Public prerelease rc.7 was published on 2026-10-14 and its GitHub Release exists. It remains frozen at `2d6942643edb977072f8818b3d0c764b2ce1a057` (annotated object `be783dd6a6efcaeff7be6e4401fc23a026d43a76`). Public prerelease rc.6 was published on 2026-10-13 and remains frozen at `c70df59d8516b7ecc9350ce5833fb177bafc335b` (annotated object `e9a630ffa6a3e1d71935305e6e1c9e05445b8364`). Public rc.5 remains frozen at `db1ef026c2f528ac952e95d2bb7170f87fa3800b`; its earlier preparation notes are retained below. rc.4 retains its original commit and tag. rc.3 remains rejected for publication; rc.1 and rc.2 remain local and unpublished. There is no npm publication or official registry listing.

## Unreleased

- Leader reminders recognise a project's current open decision through its full normalized title, or through at least two distinctive option bodies with the same recommendation letter. Options need at least six Han characters or three English content words after generic answer words are removed; a built-in stop list excludes generic answers and rollout templates. This recognises an older options-only retelling without a title or id while still reminding for a new subject that reuses generic rollout options. Closed decisions and unrelated recent decisions do not suppress new questions. User-facing reminders, panel labels, health notices and command/tool help now say Kanban and identify the board as the automatic reminder source; legacy identifiers and reminder inputs remain compatible. Fixes [issue #6](https://github.com/jasonhnd/paseo-kanban/issues/6).

## 0.1.0-rc.12 — pending review and publication

Local candidate tag: `v0.1.0-rc.12`. This candidate is prepared only. Install it from GitHub only after its matching prerelease and exact reviewed commit/tag are independently verified. Frozen rc.1 through rc.11 tags are never moved.

### Fixed

- Add persistent `block --kind scheduled --until` waits with explicit ISO offsets and a seven-day limit. Timed waits avoid transient retries and early doctor alerts; the next due tick resumes once with a durable deduplication ID and existing agent recovery rules. Leads may unblock early. Board/list/detail, CLI/MCP help and executor protocols are synchronized in English and Simplified Chinese. Fixes [issue #5](https://github.com/jasonhnd/paseo-kanban/issues/5).

### Notes

- Package and root lock versions agree on `0.1.0-rc.12`. Node remains `>=24.21.0`, and Paseo daemon/app requirements remain `>=0.11.0 <0.12.0`. Dependency selections and contract versions are unchanged. The existing tasks table gains five nullable fields for the scheduled deadline, durable wake ID/text and delivery lease; existing databases receive these fields through the normal additive migration. No credential or retired-storage import is introduced. The 20 dev/build dependency alerts remain.
- Recovery occurs on the next due scheduler tick, not at a guaranteed second. An unknown host delivery outcome retains the wait for leader investigation rather than sending a new message ID; doctor alerts only after the deadline plus its normal threshold. Scheduled waits may be unblocked early.
- Exact rc.12 verification uses only rc.12 receipts. Earlier rc.11 installations and issue-specific results do not pass this candidate. GitHub cold installs, real-browser and installed-host lifecycle, upgrade/rollback of pending waits, native app, phones, authenticated provider cycles, other platforms and production recovery remain unverified for rc.12. This preparation does not perform the production switch.

## 0.1.0-rc.11 — pending review and publication

Local candidate tag: `v0.1.0-rc.11`. This candidate is prepared only. Install it from GitHub only after its matching prerelease and exact reviewed commit/tag are independently verified. Frozen rc.1 through rc.10 tags are never moved.

### Fixed

- Cursor cards retain an explicit monitoring-off warning and an opt-in action after a transfer to a fresh data root, including when their effective quota source is manual. Connect Cursor remains discoverable while monitoring is off, with guidance to enable the reader and authorize again in the browser. Optional readers still default to off, credentials are not imported, and dispatch eligibility stays separate from monitoring. After authorization, the card reports that it is waiting for the next scheduled sample without advancing the last quota timestamp. See [GitHub issue #4](https://github.com/jasonhnd/paseo-kanban/issues/4).

### Notes

- Package and root lock versions agree on `0.1.0-rc.11`. Node remains `>=24.21.0`, and Paseo daemon/app requirements remain `>=0.11.0 <0.12.0`. Dependency selections, schema and contract versions are unchanged; no automatic data migration or credential import is introduced. The 20 dev/build dependency alerts remain.
- Exact rc.11 verification uses only rc.11 receipts. Earlier rc.10 installations and issue-specific results do not pass this combined candidate. GitHub cold installs, integrated real-browser and installed-host lifecycle, native app, phones, authenticated provider cycles, other platforms and production recovery remain unverified for rc.11. This preparation does not perform the production switch.

## 0.1.0-rc.10 — pending review and publication

Local candidate tag: `v0.1.0-rc.10`. This candidate is prepared only. Install it from GitHub only after its matching prerelease and exact reviewed commit/tag are independently verified. Frozen rc.1 through rc.9 tags are never moved.

### Fixed

- The global Kanban leader (`supervisorAgentId`) can resume cleanup for cards in every project. Other project permissions stay scoped. `resume-cleanup <card> --discard-unmerged` lets only the registered project leader or Kanban leader abandon an owned temporary branch: it lists full commit SHAs/titles, audits the authorizing leader and discarded commits, and uses normal cleanup to remove the clean worktree/branch and archive the workspace. Card tokens and workers cannot use it. Changed tips, base or uncommitted work hold retirement while the copy exists. After removal, base movement does not block deletion of the approved tip; a changed tip or exhausted deletion retries keeps the branch, revokes the grant and notifies its leader so cleanup settles. Without the flag, `not_merged` behavior is unchanged. Fixes [GitHub issue #2](https://github.com/jasonhnd/paseo-kanban/issues/2).

- Cleaning a card now deletes only the agents that card recorded: runs, the task columns, tokens, and open events, plus a child spawned from one of those agents. Agents that only share the directory or workspace stay, including another finished card's executor and reviewer. An agent whose label names this card but whose record belongs to another card is not purged. The cleanup note says that other cards' agents still use the directory and does not name those agents. See [GitHub issue #3](https://github.com/jasonhnd/paseo-kanban/issues/3).

- A running or reviewing card whose bound Paseo workspace was archived by the host, or is missing from a successful workspace list, is blocked as needs_human instead of staying in progress with no live agent. Executor and batch rules say not to check out a PR head branch as the current branch in the card's temporary worktree: push from a separate local branch or ref, or run gh pr merge without checking out the head. The Kanban leader (supervisorAgentId) or that project's registered leader can hand in the disappeared agent's work with complete --on-behalf. The complete event records onBehalf. Every other identity is refused. doctor still changes no cards. See [GitHub issue #3](https://github.com/jasonhnd/paseo-kanban/issues/3).

- Workspace lookup results are discarded if the card status, agent or workspace binding changed during the lookup. Delegated handoffs retain the real leader identity across pending required checks and reloads. A leader-submitted blocked recovery enters acceptance when checks pass, without a second complete call; a newer block, failed checks and required review still stop it. Unblock or reassignment invalidates a pending delegated hand-in, including a new run on the same agent. Late check results cannot complete the replacement worker's run.

### Notes

- Package and root lock versions agree on `0.1.0-rc.10`. Node remains `>=24.21.0`, and Paseo daemon/app requirements remain `>=0.11.0 <0.12.0`. Dependency selections, schema and contract versions are unchanged; no automatic data migration or import is introduced. Existing dev/build dependency alerts remain unresolved.
- Exact rc.10 verification uses only rc.10 receipts. Earlier rc.9 or component results do not pass this combined candidate. GitHub cold installs, integrated real-browser and installed-host lifecycle, native app, phones, authenticated provider cycles, other platforms and production recovery remain unverified. This preparation does not perform the production switch.

## 0.1.0-rc.9 — pending review and publication

Local candidate tag: `v0.1.0-rc.9`. This candidate is prepared only. Install it from GitHub only after its matching prerelease and exact reviewed commit/tag are independently verified. Frozen rc.1 through rc.8 tags are never moved.

### Fixed

- A manual `--reviews` card can request changes while its target is still `in_review`. The target returns to rework and the review round counts once, the same as a rejection from `reviewing`. A second rejection still stops for a leader ruling, and the third still stops for a person. Creating the review card does not claim the target. Approving that review does not move an `in_review` target. The approval stops with an error so the project leader can rule a pass and then accept the card. A later poll of the review card's own checks also leaves that target in `in_review`. See [GitHub issue #1](https://github.com/jasonhnd/paseo-kanban/issues/1).

### Notes

- Package and root lock versions agree on `0.1.0-rc.9`. Node remains `>=24.21.0`, and Paseo daemon/app requirements remain `>=0.11.0 <0.12.0`. Dependency selections, schema and contract versions are unchanged; no automatic data migration or import is introduced. The 20 dev/build dependency alerts remain.
- Exact rc.9 verification requires rc.9 receipts. Earlier rc.8 results do not pass this candidate. GitHub cold installs, integrated real-browser and installed-host lifecycle, native app, phones, authenticated provider cycles, other platforms and production recovery remain unverified for rc.9. This preparation does not perform the production switch.

## 0.1.0-rc.8 — pending review and publication

Local candidate tag: `v0.1.0-rc.8`. This candidate is prepared only. Install it from GitHub only after its matching prerelease and exact reviewed commit/tag are independently verified. Frozen rc.1 through rc.7 tags are never moved.

### Fixed

- Disabled or unknown providers no longer emit a thinking-catalog warning. The warning is skipped only when the error text says that provider is disabled or unknown. Other failures, including a connection reset, still warn. The check does not hard-code a provider list and does not read banned providers.
- The host server bundle no longer reads `fs.F_OK` (Node DEP0176). Named imports and named re-exports replace star import and star export of `node:fs` in the filesystem helpers the server bundle includes. The test-data path guard uses those named functions, and its filesystem parameter lists only the methods it calls. This does not rewrite `fs.F_OK` as `fs.constants.F_OK`: a star import still touches those constants when the host packages the server.

### Verified without a listen-policy change

- Reusing a saved MCP port was already rc.7 behavior. The server prefers the port in `data/mcp.port`, binds it when it is free, and binds a different port only when the saved port is in use, then marks running MCP addresses stale. A new integration test on official Paseo 0.11.2 shows that a stop-then-start reload reuses the saved port and that the same host MCP client can read the board again. When the saved port is occupied, the server still switches ports. This candidate does not change that listen policy.

### Notes

- Package and root lock versions agree on `0.1.0-rc.8`. Node remains `>=24.21.0`, and Paseo daemon/app requirements remain `>=0.11.0 <0.12.0`. Schema and contract versions are unchanged, and no automatic data migration or import is introduced. Dependency selections are unchanged. The 20 dev/build dependency alerts remain.
- Exact rc.8 local verification requires rc.8 receipts. Earlier rc.7 results do not pass this candidate. New GitHub cold installs, real-browser update/reload recovery and installed-host lifecycle replay remain separate verification. Native app, phones, authenticated provider cycles, other platforms and production recovery remain unverified. This candidate does not perform the production switch.

## 0.1.0-rc.7 — pending review and publication

Local candidate tag: `v0.1.0-rc.7`. This candidate is prepared only. Install it from GitHub only after its matching prerelease and exact reviewed commit/tag are independently verified. Frozen rc.1 through rc.6 tags are never moved.

### Changed

- Per-card scratch moves from the system temporary directory to the configured project's `.kanban-work/<card code>/`, and Git locally excludes that directory. A missing, non-Git or unwritable project falls back to `<plugin-data-root>/work/<project>/<card code>/`. `<plugin-data-root>` is `KANBAN_DATA_DIR`, otherwise `$PASEO_HOME/plugin-data/paseo-kanban`, which is `~/.paseo/plugin-data/paseo-kanban` when `PASEO_HOME` is unset. There is no system-temporary-directory fallback. Recorded paths keep resume generations and delayed cleanup after a settings change.
- Supervisor brief-file boundaries and reader/decision card scope follow the new work roots. English/Chinese worker protocols and documentation put temporary artifacts in the card's injected directory.

### Fixed

- Project settings and short-code updates keep the configured work directory, including the legacy `workspace` alias. Chinese worker rules keep the reviewed-card and name restrictions and identify the board as the writer of the local exclude.
- Full test phases and workers isolate their scratch roots. Tests no longer write card directories on the real default root. The card-tmp guard still refuses a real system card root outside its own fixture, and allows paths inside that fixture when the fixture is nested under the invoking card's `.kanban-work/<card code>/` directory. Default-root name audits reject a phase that leaves a new card directory outside its owned roots.

### Switching an existing installation

- Remove or change an old explicit `KANBAN_TMP_ROOT` to adopt the new default. An explicit `KANBAN_TMP_ROOT` still wins, including a deliberately kept legacy location. New worker protocols use `KANBAN_TMP`.
- End and recreate an existing worker when its old environment must change. Saved briefs and protocols, and already running agent environments, are not rewritten. On the first new card, check `TMPDIR`, `KANBAN_TMP` and the `card_tmp_prepared` event.
- Legacy system-temporary roots that have no prepared-path record are not imported into default discovery. This candidate does not delete them.

### Notes

- Package and root lock versions agree on `0.1.0-rc.7`. Node remains `>=24.21.0`, and Paseo daemon/app requirements remain `>=0.11.0 <0.12.0`. Schema and contract versions are unchanged, and no automatic data migration or import is introduced. Dependency selections are unchanged. The 20 dev/build dependency alerts remain.
- Exact rc.7 local verification and the outgoing annotated-tag gate require rc.7 receipts. Earlier rc.6 or component results do not pass this integrated candidate. New GitHub cold installs, real-browser update/reload recovery and installed-host lifecycle replay remain separate verification. Native app, phones, authenticated provider cycles, other platforms and production recovery remain unverified. This candidate does not perform the production switch.

## 0.1.0-rc.6 — pending review and publication

Local candidate tag: `v0.1.0-rc.6`. This candidate is prepared only. Install it from GitHub only after its matching prerelease and exact reviewed commit/tag are independently verified. Frozen rc.1 through rc.5 tags are never moved.

### Fixed

- Correct the English/Chinese Board bookmark guidance and a client comment for the official 0.11.2 Web UI: copy the sidebar's host-qualified `/h/<host-id>/plugin/paseo-kanban/surface/board` URL. The old host-less `/plugin/paseo-kanban/board` path remains invalid; no route alias is added.
- Audited idempotent reads retry temporary “Plugin not available” failures during update/reload, with up to five backoff retries in a 15-second retry window. Mounted panels retain their last data and show “Plugin is updating…”. Exhaustion asks the user to refresh later. Saves, actions and unknown RPCs are never automatically retried; other errors remain visible.

### Documentation corrections and known limitations

- The official Paseo 0.11.2 Web UI Command Center action **Open project board** needs the current page's plugin-installation host context. It is absent on an empty homepage, including after leaving a plugin page; open **Paseo Kanban** from the sidebar first. `context: global` does not bypass host selection. This corrects the earlier “globally available” description and does not fix homepage behavior.
- Official 0.11.2 **Settings -> Plugins** does not display manifest icons. The bundled PNG remains metadata for possible future registry display; no registry listing is claimed.
- The recorded dependency audit retains **20 affected packages: 5 moderate and 15 high**, all in dev/build dependency chains. These are used during build preparation, and Git installation's `npm ci --include=dev` installs them on the daemon user's machine. The two root advisories (`braces` and `sprintf-js`) had no published upstream patched version in that audit; non-force `npm audit fix` changed nothing. Dependency selections are unchanged. Runtime exploitability was not tested; passing local gates is not a dependency fix.

### Notes

- Package and root lock versions agree on `0.1.0-rc.6`; Node remains `>=24.21.0`, and Paseo daemon/app requirements remain `>=0.11.0 <0.12.0`. Schema and contract versions are unchanged; no automatic data migration/import is introduced.
- Exact rc.6 local verification and outgoing annotated-tag gates require rc.6 receipts. Earlier rc.5 or component results do not pass this integrated candidate. New GitHub cold installs, real-browser update/reload recovery and installed-host lifecycle replay remain separate verification; native app, phones, authenticated provider cycles, other platforms and production recovery remain unverified.

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
