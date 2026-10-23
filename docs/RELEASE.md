# Git release and recovery checklist

This batch prepares Git-only candidate **0.12.0.1** on public v0.1.0-rc.23 commit `c6e740bedfd64691bd20270244efb1f803109b0f`. It remains unpublished until independent review and separate authorization. No new tag or Release is created by preparation.

rc.6 adds bounded transient read retries and corrects host-qualified Board links, homepage Command Center scope and manifest-icon documentation. Public rc.5 remains frozen at `db1ef026c2f528ac952e95d2bb7170f87fa3800b`, annotated object `44f501a2a6cda150b92d9fa9b5dfa48d03e7af5e`. Its observations do not certify rc.6. The 20 retained dev/build dependency alerts (5 moderate, 15 high) are installed by Git preparation; the recorded audit found no upstream patched versions for the two root advisories and non-force audit fix made no change. See the current [changelog](../CHANGELOG.md).

rc.7 moves per-card scratch from the system temporary directory into the configured project's `.kanban-work/<card code>/` and keeps tests from writing card directories on the real default root. Explicit `KANBAN_TMP_ROOT` remains only an override. Adopting the new default requires removing an old `KANBAN_TMP_ROOT` and recreating workers that still hold the old environment. Public prerelease rc.6 was published on 2026-10-13 and its GitHub Release exists. It remains frozen at `c70df59d8516b7ecc9350ce5833fb177bafc335b`, annotated object `e9a630ffa6a3e1d71935305e6e1c9e05445b8364`. Its observations do not certify rc.7. The 20 retained dev/build dependency alerts (5 moderate, 15 high) are unchanged. See the current [changelog](../CHANGELOG.md).

rc.8 skips thinking-catalog warnings when a provider is disabled or unknown, and stops the host server bundle from reading `fs.F_OK` (DEP0176). Saved MCP port reuse is unchanged from rc.7: a free saved port is reused, and an occupied saved port still switches ports and marks running MCP addresses stale. A new integration test records that official reload reuse. Public prerelease rc.7 was published on 2026-10-14 and its GitHub Release exists. It remains frozen at `2d6942643edb977072f8818b3d0c764b2ce1a057`, annotated object `be783dd6a6efcaeff7be6e4401fc23a026d43a76`. Its observations do not certify rc.8. The 20 retained dev/build dependency alerts (5 moderate, 15 high) are unchanged. See the current [changelog](../CHANGELOG.md).

rc.9 fixes [GitHub issue #1](https://github.com/jasonhnd/paseo-kanban/issues/1): a manual `--reviews` card can request changes while its target is still `in_review`. Approve explicitly errors in that case without promoting the target; later polling of the review card's own checks also leaves the target unchanged. Creating a review card does not claim the target. Public prerelease rc.8 was published on 2026-10-14 and its GitHub Release exists, frozen at `0af33ec7e49891bf3dba2549cb8b6b83487bba4c`, annotated object `303e4c27dd65f829743bc44c7242c1abd452c176`. Its observations do not certify rc.9; exact rc.9 gates need new receipts. Dependencies, schemas and contract versions are unchanged, and the 20 dev/build dependency alerts remain.

rc.10 combines the leader cleanup and audited unmerged-branch retirement fix for [issue #2](https://github.com/jasonhnd/paseo-kanban/issues/2), card-scoped agent cleanup, and lost-workspace recovery with generation-bound delegated handoffs for [issue #3](https://github.com/jasonhnd/paseo-kanban/issues/3). Public prerelease rc.9 was published on 2026-10-15 and its GitHub Release exists, frozen at `701594d452f24dcbf115aabcedd4e9be9f5f6bcb` (annotated object `dda2f0044ec08e25979f35787b42a08f4687104e`). Its observations do not certify rc.10; only new exact rc.10 verification receipts count. Dependencies, schemas and contract versions are unchanged.

rc.11 fixes [GitHub issue #4](https://github.com/jasonhnd/paseo-kanban/issues/4): Cursor cards retain an explicit monitoring-off warning, an opt-in action and a discoverable connection control after a fresh-root transfer. After authorization they wait for the next scheduled sample without advancing the quota timestamp. Monitoring remains separate from dispatch; optional readers stay off by default and credentials are not imported. Public prerelease rc.10 was published on 2026-10-15 and its GitHub Release exists, frozen at `e4e070e8bdc8a41a8f8bc61e66ded8e1950b0129` (annotated object `48c4c9feab7d0f02c0010d5754e00ed2a1ddf7aa`). Its observations do not certify rc.11; only new exact rc.11 receipts count. Dependencies, schemas and contract versions are unchanged.

rc.12 fixes [GitHub issue #5](https://github.com/jasonhnd/paseo-kanban/issues/5): persistent `block --kind scheduled --until` waits require an explicit ISO offset and a deadline within seven days. Before the deadline they avoid transient retries and early doctor alerts; a due tick resumes once using a durable wake ID/text and a delivery lease. Existing agent recovery and lead unblock remain in use. An unknown host delivery outcome retains the wait for investigation instead of creating a new message ID. The tasks table gains five nullable fields through the normal additive migration; dependency selections and contract versions are unchanged, with no credential or retired-storage import. Public prerelease rc.11 was published on 2026-10-15 and its GitHub Release exists, frozen at `09963b85e0d7c9c5d881aa39e3c65ebbb719b7a0` (annotated object `042413d64aeee4f41c34120b4b3af4003c685741`). Its observations do not certify rc.12; only new exact rc.12 receipts count. Upgrade/rollback with pending waits and authenticated-provider delivery remain unverified.

rc.13 combines the reviewed fixes for [issue #6](https://github.com/jasonhnd/paseo-kanban/issues/6) and [issue #7](https://github.com/jasonhnd/paseo-kanban/issues/7). An open decision is recognised by its full normalized title, or at least two distinctive complete option bodies with the same recommendation letter; reminders and user-facing help use Kanban branding. Discard audits count only commits absent from all other local branch, remote-tracking and tag refs, prefer the locally available comparison base and warn about a stale local base without fetching. Permissions, audited-tip deletion and retention safeguards remain. Public prerelease rc.12 was published on 2026-10-16 and its GitHub Release exists, frozen at `4162cbca1acb2aa70ad1d5fb77c0c78f25c68ab2` (annotated object `a5d68644e9d02206e2cf07ee7d32005f59801ee9`). Its observations do not certify rc.13; only new exact rc.13 receipts count. Dependency selections, schema and contract versions are unchanged relative to rc.12. Finite option classification, locally stale refs, pending-wait upgrade/rollback and authenticated-provider delivery remain limitations or unverified.

rc.14 fixes [issue #8](https://github.com/jasonhnd/paseo-kanban/issues/8): normal temporary-card cleanup accepts commit ancestry in either the configured local base or freshly fetched `origin/<base>`. Local-only merges no longer require a push or explicit discard when origin is stale or unavailable, and local containment also permits branch deletion. Matching local tree contents alone are insufficient. Successful cleanup removes orphan worktree/workspace doctor findings. Existing PR/squash proofs, discard permissions, audited-tip deletion, shared-copy, active-agent and revocation/retention safeguards remain. Public prerelease rc.13 was published on 2026-10-16 and its GitHub Release exists, frozen at `b9d7a19d7c9373105650fcbd59e330e849169dfa` (annotated object `498e84c4dd46de3724d036754627db0d268b63e7`). Its observations do not certify rc.14; only new exact rc.14 receipts count. Dependency selections, schema and contract versions are unchanged relative to rc.13. Pending-wait upgrade/rollback and authenticated-provider delivery remain unverified.

rc.15 fixes a shared temporary-directory cleanup race: when the directory-level agent purge failed because another card's agent still pointed at the directory, a reconcile sweep that ran before the retry time could record the purge as done after looking only at the finished card's own agents, and archive and directory removal then proceeded. The sweep now settles that failure only after its retry time, only when the agent list is readable and no agent of any card points at the directory, and a reconciled row no longer counts as a finished directory-level purge in the cleanup job. Another card's agent keeps the directory, as before. There is no corresponding GitHub issue. Public prerelease rc.14 was published on 2026-10-16 and its GitHub Release exists, frozen at `25dfc5f352b3577b4b9810eab652ae60bac53c55` (annotated object `292c50ae341db5ac43589e678c328da56470d5fa`). Its observations do not certify rc.15; only new exact rc.15 receipts count. Dependency selections, schema and contract versions are unchanged relative to rc.14. Pending-wait upgrade/rollback and authenticated-provider delivery remain unverified.

rc.16 makes the board follow Paseo's project list: a board project is matched to a Paseo project by directory (names are never compared), and a project whose directory is no longer a Paseo project is left out of the leader panel, paused area, home overview, by-project tab and board; it gets no reminder, wake or dispatch, and its cards and history are kept. When Paseo cannot be read, the last list that was read is kept; an empty list is believed only after two successful empty answers at least 60 seconds apart. Public docs and release notes are English-only, Chinese docs stay under `docs/zh-CN`, and a fresh installation follows the system language. Public prerelease rc.15 was published on 2026-10-16 and its GitHub Release exists, frozen at `0f64d2009fd7fefefbc41edff8a79144c6411548` (annotated object `8919725b05cef190395f2a9ddaaebae7490cc0fe`). Its observations do not certify rc.16; only new exact rc.16 receipts count. Dependency selections, schema and contract versions are unchanged relative to rc.15. A real-browser mount of the merged candidate, pending-wait upgrade/rollback and authenticated-provider delivery remain unverified.

rc.17 fixes [issue #9](https://github.com/jasonhnd/paseo-kanban/issues/9): doctor no longer builds a project's main directory from the plugin install directory. A configured project with no `workspacePath`, no directory known to Paseo and no card directory is treated as directory-unknown and skipped quietly, with no `worktree <path>` info line and no `repo:skipped` ENOENT finding. A relative `workspacePath` is reported once in the log and never resolved against the plugin directory or the process working directory, and relative card, event and Paseo directories are ignored in the same scan. Projects with an absolute directory behave as before, and a project that has left Paseo stays filtered. Public prerelease rc.16 was published on 2026-10-16 and its GitHub Release exists, frozen at `6ed3be48e5e002351668a2d2d8765c2cca67413a` (annotated object `9747d649314d270b581d95ba5aebb37c0e4276b7`). Its observations do not certify rc.17; only new exact rc.17 receipts count. Dependency selections, schema and contract versions are unchanged relative to rc.16. A real-browser mount of this candidate, pending-wait upgrade/rollback and authenticated-provider delivery remain unverified.

rc.18 changes board operations and release documents only. A finished card's work directory is deleted on the next cleanup round after the card is done or archived, with no 24-hour wait; a cleanup red clears once the directory is gone, and an inode, owner or generation mismatch keeps the directory with a specific reason. New cards pause their first start when card-work usage exceeds 10 GiB or the disk has under 50 GiB free, while review, rework and resume keep going. Test hosts keep voice and dictation off and share one read-only official runtime. GitHub Release bodies are English-only, with Chinese release documentation under `docs/zh-CN/`. Public prerelease rc.17 was published on 2026-10-16 and its GitHub Release exists, frozen at `d7eec4188a108eb660c77f806b6ce91f85e5c26f` (annotated object `077ca0f5a83d2f827b1169c82ccfb0ece9307c8c`). Its observations do not certify rc.18; only new exact rc.18 receipts count. Dependency selections, schema and contract versions are unchanged relative to rc.17. A real-browser mount of this candidate, a real cleanup or capacity brake on a live board, pending-wait upgrade/rollback and authenticated-provider delivery remain unverified.

rc.19 fixes [issue #10](https://github.com/jasonhnd/paseo-kanban/issues/10) and [issue #11](https://github.com/jasonhnd/paseo-kanban/issues/11). Doctor no longer raises a red for a git worktree inside a board-owned card temp directory when that card is unfinished, or done or archived and temp cleanup has not failed; a finished card waiting on cleanup is at most an info line that disappears once the worktree is gone. When a review card that borrowed another card's temporary workspace finishes, it releases that claim by deleting only its own agents and retrying the owner's cleanup at once, including a backoff that is still waiting. Public prerelease rc.18 was published on 2026-10-17 and its GitHub Release exists, frozen at `d4ca860e01fb3256c2cc787d383b5de25bd396e5` (annotated object `9943de9e2b538a60368de7ab12641357a959d084`). Its observations do not certify rc.19; only new exact rc.19 receipts count. Dependency selections, schema and contract versions are unchanged relative to rc.18. A real-browser mount of this candidate, a real cleanup on a live board, pending-wait upgrade/rollback and authenticated-provider delivery remain unverified.

rc.20 fixes the reminder window for recent decisions ([issue #6](https://github.com/jasonhnd/paseo-kanban/issues/6)) and cleans up worktree registrations when a finished card's directory is removed ([issue #10](https://github.com/jasonhnd/paseo-kanban/issues/10)): a leader reminder stays quiet while the project has a decision opened within the last 60 minutes, and cleanup unregisters a nested git worktree before it deletes the directory. It also adds an optional Hermes leader integration: leader creation, handover and registration transfer for the `hermes` provider, a curated-memory bridge whose scope is a whole Hermes profile rather than one project, and host-qualified in-client navigation. Other providers do not need Hermes or Python, and loading the plugin does not start Python. Changes that apply to every provider: session buttons use the current client's navigation (reload the page after updating; the old desktop-opening call now returns an error), and leader handover keeps waiting through tool-approval prompts. Public prerelease rc.19 was published on 2026-10-17 and its GitHub Release exists, frozen at `d63cdc419f6f99300342bda5716d68e37a3e4c97` (annotated object `65df87c70bb68bb5630f7cb5705ad33dc3b3a916`). Its observations do not certify rc.20; only new exact rc.20 receipts count. Dependency selections, schema and contract versions are unchanged relative to rc.19. A real Hermes leader session, a real-browser mount of this candidate, a real cleanup on a live board, pending-wait upgrade/rollback and authenticated-provider delivery remain unverified.

rc.22 adds existing-leader MCP credentials, current-installation compatibility evidence, integration-branch and recorded-placeholder cleanup, and Grok/Cursor quota-session process cleanup. It retains the rc.21 host range (`>=0.11.0 <0.13.0`), stable commands and card-work directories. Dependency selections, schema and contract versions are unchanged. Record exact candidate verification and disposable-host upgrade/rollback evidence; production switching and final acceptance are separate.

## Version and evidence policy

The combined plugin has one package/version/CHANGELOG and runtime id `paseo-kanban`. This Git-only candidate uses four-component package metadata `0.12.0.1`, matching Paseo 0.12.0 plus a plugin revision. Edit package and lock directly; do not use npm version. The plugin manifest has no version field. Contract/schema versions remain separate.

A Git branch is mutable. This RC plan requires an immutable tag and GitHub prerelease, aligned with package/lock/CHANGELOG. Save the full reviewed commit and tree as well as the tag object/metadata; review and scan annotated tag identity/content. Never move, overwrite or reuse a tag, even to correct a release. Local `v0.1.0-rc.1` already names `22958ff54c955c1a90683f786d3ebb8b9ae88470` and is not moved. The next unused number chosen for this candidate is `0.12.0.1`. Confirm rc.22 is unused both locally and remotely before creating its annotated tag; frozen rc.1 through rc.20 objects remain unchanged. Public prerelease rc.20 was published on 2026-10-18. The publishing owner must check the remote refs and GitHub Release record again. Preserve c106 as the previous verified public code baseline, not a previous versioned release.

Prepared RC notes may use a version heading marked **pending publication**; never add a release date or claim an available tag until verified. Notes must state host range, data/contract changes, existing dependency alerts and real test limits. Official 0.11.2 Git acquisition uses revision/`--ref`; its manifest schema has no consumed plugin version field. Keep package.json, package-lock.json's top level and root package version aligned; do not invent a manifest field. Do not turn source-only checks into app/provider certification.

## RC publication plan — pending

The release title is **Paseo Kanban v0.12.0.1** and the GitHub Release must be a **prerelease**. Its body must identify the exact reviewed public RC commit/tree, link the English/Chinese changelogs, state compatibility/access/data risks and distinguish prior c106 evidence from RC verification. Prepare the body for review before publishing; never include private paths, identities, configuration, credentials or evidence repositories.

Only the separately authorized publishing owner may publish the approved commit/tag and create the prerelease after different-model review and leader acceptance. That owner must rerun the exact outgoing branch/tag privacy/history/identity gates, confirm the remote peeled tag equals the reviewed commit, and verify the GitHub Release uses that tag with prerelease=true. No force, tag replacement, npm publication or registry submission is part of this plan.

**These commands are planned for after that remote confirmation, not evidence that the pending tag exists:**

```sh
paseo plugin install github:jasonhnd/paseo-kanban --ref v0.12.0.1 --json
paseo plugin ls paseo-kanban --json
paseo plugin update paseo-kanban --check --ref v0.12.0.1 --json
paseo plugin update paseo-kanban --ref v0.12.0.1 --json
paseo plugin ls paseo-kanban --json
```

Use separate fresh isolated homes/caches for cold tag and full-RC-SHA installs. On another fresh host install c106 first, then preview/update to the RC; assert preview leaves revision/path/settings/data unchanged, update matches exact RC revision/version, all eight installed bundles/Node commands work, and the data root/settings/RPC remain valid. Record the actual UI separately. Test code downgrade to the prior public c106 baseline, then repeat the explicit RC upgrade:

```sh
paseo plugin update paseo-kanban --check --ref c106efb88a659931d01f40a236001823473561a8 --json
paseo plugin update paseo-kanban --ref c106efb88a659931d01f40a236001823473561a8 --json
paseo plugin reload paseo-kanban --json
paseo plugin ls paseo-kanban --json
```

Record exact CLI/daemon/app versions, commands/exits, before/after source/revision/path/enabled/version, code versus data retention, cleanup and limits in the publication receipt. Tag installation and new RC GitHub/UI replay stay pending until those rows pass. Before publication, use a task-owned local `file://` Git source for exact candidate checks; it cannot certify the future GitHub tag. Both daemon and app must be in `>=0.11.0 <0.13.0`; official 0.11.2 on macOS arm64 is the measured baseline, Node >=24.21.0 is required. Other patches/platforms and authenticated providers are not certified by that range.

Relative to c106, this RC retains reviewed artifact acceptance, decision-panel behavior, managed-update command-path resolution and default stale-policy admission. rc.5 also fixes current blocked/cooldown state after successful runs and stale diagnostic wording, updates sidebar and Command Center entries, includes anonymous interface media, raises the Node minimum and updates package/lock metadata and docs. Contract versions and dependency selections are unchanged. rc.12 adds five nullable scheduled-wait task fields through the normal additive migration; no credential or retired-storage import is introduced. Keep the same canonical root, pause dispatch/writers and back up consistent state plus host settings before changing code/source. Code rollback preserves current writes; a separate compatible data restore can discard newer writes. New install enabled=true can start immediately with global plugins enabled. Existing plugin development/preparation and official-host dependency audit/deprecation alerts are unresolved; keep exact observations in the receipt. Passing gates is not remediation or stable-release evidence.

## Retained limits

These limits stay in force for `0.12.0.1`:

- Information exports can lag a removed checkout by about 600 seconds. Use the current installed path and wait for both exports. Their agreement is necessary but does not prove command writes work; the action checks in [updating and recovery](#updating-and-recovery) are mandatory.
- Undo for a closed decision exists only in the mounted panel. Navigation or reload removes Undo. The stored done state and zero count remain.
- A pull-request artifact accepts lowercase `https://github.com/` only. `https://GITHUB.COM/` is rejected.
- Dependency deprecation and audit warnings are unresolved. Do not treat a green build or privacy gate as an audit fix.
- Physical phones, the native app, and an authenticated provider cycle remain unverified.
- Exact results from `0.1.0-rc.1` or from either fix alone are not the final pass of this integrated commit.
- GitHub cold install of this RC waits until the GitHub Release record exists. Do not invent that result from a local `file://` probe.

## Release body substitution

Prepare the GitHub Release body in English only for review. Chinese release documentation stays under [`docs/zh-CN/`](zh-CN/RELEASE.md). Replace these tokens only as whole tokens:

| Token | Replacement |
|---|---|
| `{{RC_VERSION}}` | `0.12.0.1` |
| `{{RC_TAG}}` | `v0.12.0.1` |
| `{{RC_COMMIT}}` | full reviewed commit |
| `{{RC_TREE}}` | that commit's tree |
| `{{UTC_DATE}}` | UTC calendar date `YYYY-MM-DD` of the body being prepared |

`{{INSTALL_STATUS}}` is exactly one of these two paragraphs.

Published, only when the GitHub Release for `v0.12.0.1` exists, is a prerelease, and its target commit equals `{{RC_COMMIT}}`:

`The GitHub Release record for v0.12.0.1 on {{UTC_DATE}} targets {{RC_COMMIT}}. Install with --ref v0.12.0.1.`

Unpublished, while that Release record is absent:

`No GitHub Release record for v0.12.0.1 exists as of {{UTC_DATE}}. The candidate is unpublished. Do not install v0.12.0.1 from GitHub. v0.1.0-rc.1 was local preparation only; rc.1 and rc.2 were not published.`

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
