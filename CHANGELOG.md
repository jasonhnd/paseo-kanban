# Changelog

The single plugin has one version and CHANGELOG. Distribution is through Git.
`0.1.0-rc.22` is a local candidate built on public rc.21 (`2740f8bed023637d1f5c15ebd19fb1fadee82d5b`), pending independent review and publication. Public prerelease rc.20 was published on 2026-10-18, frozen at `bec4af0626d7f75e94dfdef9a577a5caa2cbd65e` (annotated object `e0e9cc3ae464c2200318f85042c982c3076d8aa7`). Public prerelease rc.19 was published on 2026-10-17 and its GitHub Release exists, frozen at `d63cdc419f6f99300342bda5716d68e37a3e4c97` (annotated object `65df87c70bb68bb5630f7cb5705ad33dc3b3a916`). Public prerelease rc.18 was published on 2026-10-17 and its GitHub Release exists, frozen at `d4ca860e01fb3256c2cc787d383b5de25bd396e5` (annotated object `9943de9e2b538a60368de7ab12641357a959d084`). Public prerelease rc.17 was published on 2026-10-16 and its GitHub Release exists, frozen at `d7eec4188a108eb660c77f806b6ce91f85e5c26f` (annotated object `077ca0f5a83d2f827b1169c82ccfb0ece9307c8c`). Public prerelease rc.16 was published on 2026-10-16 and its GitHub Release exists, frozen at `6ed3be48e5e002351668a2d2d8765c2cca67413a` (annotated object `9747d649314d270b581d95ba5aebb37c0e4276b7`). Public prerelease rc.12 was published on 2026-10-16 and its GitHub Release exists, frozen at `4162cbca1acb2aa70ad1d5fb77c0c78f25c68ab2` (annotated object `a5d68644e9d02206e2cf07ee7d32005f59801ee9`). Public prerelease rc.11 was published on 2026-10-15 and its GitHub Release exists, frozen at `09963b85e0d7c9c5d881aa39e3c65ebbb719b7a0` (annotated object `042413d64aeee4f41c34120b4b3af4003c685741`). Public prerelease rc.10 was published on 2026-10-15 and its GitHub Release exists, frozen at `e4e070e8bdc8a41a8f8bc61e66ded8e1950b0129` (annotated object `48c4c9feab7d0f02c0010d5754e00ed2a1ddf7aa`). Public prerelease rc.9 was published on 2026-10-15 and its GitHub Release exists, frozen at `701594d452f24dcbf115aabcedd4e9be9f5f6bcb` (annotated object `dda2f0044ec08e25979f35787b42a08f4687104e`). Public prerelease rc.8 was published on 2026-10-14 and its GitHub Release exists. It remains frozen at `0af33ec7e49891bf3dba2549cb8b6b83487bba4c` (annotated object `303e4c27dd65f829743bc44c7242c1abd452c176`). Public prerelease rc.7 was published on 2026-10-14 and its GitHub Release exists. It remains frozen at `2d6942643edb977072f8818b3d0c764b2ce1a057` (annotated object `be783dd6a6efcaeff7be6e4401fc23a026d43a76`). Public prerelease rc.6 was published on 2026-10-13 and remains frozen at `c70df59d8516b7ecc9350ce5833fb177bafc335b` (annotated object `e9a630ffa6a3e1d71935305e6e1c9e05445b8364`). Public rc.5 remains frozen at `db1ef026c2f528ac952e95d2bb7170f87fa3800b`; its earlier preparation notes are retained below. rc.4 retains its original commit and tag. rc.3 remains rejected for publication; rc.1 and rc.2 remain local and unpublished. There is no npm publication or official registry listing.

## Unreleased

## 0.1.0-rc.22 — pending review and publication

Local candidate only. No tag, publication or production installation is performed.

### Fixed

- Existing registered leaders can export private, expiring, revocable agent-bound HTTP MCP credentials through `mcp-credential`; project removal revokes exports. Early-reset notices identify and deduplicate the missing project leader. Fixes [issue #15](https://github.com/jasonhnd/paseo-kanban/issues/15).
- Compatibility reports fingerprint the current installation and preserve failed evidence while metadata is unavailable or plugin ids change; missing checks remain explicitly unverified. Fixes [issue #16](https://github.com/jasonhnd/paseo-kanban/issues/16).
- Cleanup accepts configured integration branches as distinct containment proofs, including lane cards, and doctor rechecks stale merge findings. Fixes [issue #17](https://github.com/jasonhnd/paseo-kanban/issues/17).
- Temporary cleanup collects recorded placeholder attempts while retaining ownership and retry boundaries. Fixes [issue #18](https://github.com/jasonhnd/paseo-kanban/issues/18).
- Grok and Cursor quota readers stop the complete session process tree before terminal teardown and inspect screen session listings structurally.

### Notes

- Node remains `>=24.21.0`; Paseo daemon/app support remains `>=0.11.0 <0.13.0`. Dependency selections, schema and contract versions are unchanged from rc.21. Existing project card-work directories remain under `.kanban-work`.
- Review uses exact local verification and disposable-host upgrade/rollback receipts. Production switching, authenticated provider quota values, native clients and final acceptance require separate work.

## 0.1.0-rc.21 — pending review and publication

Local candidate tag: `v0.1.0-rc.21`. Prepared for independent review only; no GitHub prerelease or production installation is authorized here.

### Fixed

- Cloudflare account check uses the official cf CLI instead of Wrangler.
- Fix [issue #13](https://github.com/jasonhnd/paseo-kanban/issues/13): reconcile dispatch pool run totals with profile totals, estimate per-run quota costs from matching observation spans, and read Codex custom/archived sessions and Grok turn usage (including custom `GROK_HOME` directories). Missing usage or prices remain unknown and do not dilute averages; the usage panel shows missing usage explicitly.
- Allow Paseo daemon/app `>=0.11.0 <0.13.0`, restoring plugin loading, scheduler ticks and board MCP after a host upgrade to 0.12.x. Verified with isolated official 0.11.2 and 0.12.0 runtimes; the 0.11 SDK dependency pins preserve the older wire contract on both hosts. Fixes [issue #14](https://github.com/jasonhnd/paseo-kanban/issues/14).
- On every start the plugin refreshes a stable `bin` in its data directory: a board-command launcher and a copy of `integrations/hermes/memory_bridge.py`. Protocol text, new-leader prompts and handover messages name that launcher. Doctor reports yellow when the stable command is missing or does not match the current install. Point a provider command at the stable copy once; the plugin does not rewrite provider configuration, and an upgrade does not require editing that command. Fixes [issue #12](https://github.com/jasonhnd/paseo-kanban/issues/12).

### Notes

- Package and root lock versions agree on `0.1.0-rc.21`. Node remains `>=24.21.0`; Paseo daemon/app support is `>=0.11.0 <0.13.0`. Dependency pins, schema and contract versions are unchanged relative to rc.20. Isolated official 0.11.2 and 0.12.0 host checks cover plugin loading, scheduler ticks, board MCP and CLI create/show. Real authenticated provider delivery, browser/native clients, production installation and upgrade/rollback remain separate validation work. This candidate is prepared only; no publication or production switch is performed.

## 0.1.0-rc.20 — 2026-10-18 (public prerelease)

Published prerelease tag: `v0.1.0-rc.20`, commit `bec4af0626d7f75e94dfdef9a577a5caa2cbd65e`, annotated object `e0e9cc3ae464c2200318f85042c982c3076d8aa7`. This release supports Paseo `>=0.11.0 <0.12.0`; use the rc.21 candidate for 0.12.x only after its separate publication. Published tags are never moved.

### Added

- Optional Hermes leader integration. A Paseo leader profile that uses the existing `hermes` ACP provider (or a `hermes-leader` launch alias) can be created from the project's Leader creation panel. It receives the complete board protocol as a visible first message, and the board verifies its self-registration separately. Leader handover for these providers reuses the provider, model and workspace, binds a guest identity limited to the new session, asks the current leader to run the project's registration handover, and checks that the registry points to the new session before the old session is archived. It does not bypass the leader-ownership check; creation and message delivery are idempotent across retries. Other providers do not need Hermes or Python, and loading the plugin does not start Python. Changes that apply to every provider: session buttons use the current client's navigation (reload the page after updating; the old desktop-opening call now returns an error), and leader handover keeps waiting through tool-approval prompts.
- `integrations/hermes/memory_bridge.py`, an optional stdlib-only ACP wrapper that re-sends a Hermes profile's `MEMORY.md` and `USER.md` to its sessions when they change. Its scope is the whole Hermes profile, not a single project: every session behind the same bridge receives the same two files, which is also what Hermes does for each session at session start. Use a separate Hermes profile and `--memory-dir` for each project to keep projects apart. The bridge's Python tests run with the documented `python3 -m unittest` command; `npm run verify` does not need Python.

### Changed

- Handover and registration-transfer waits stay open across tool permission requests, with one 15-minute deadline per step, no automatic approval and no repeated prompt. An idle receipt while a turn is still active does not complete the step, and an acknowledgement must be a fresh timeline message.
- Board and Fleet session buttons use the current client's host-qualified navigation. The legacy desktop-opening RPC now returns an error instead of opening another host in the desktop app, including for an older cached client; reopen the page after updating the plugin.
- Reviewed public collisions with the `hermes` provider name are approved only at the exact path, line, match position and literal; a separate gate fails stale approvals, counting the working tree and history reachable from HEAD. The secret and private-denylist scans, and every general privacy rule, are unchanged.

### Fixed

- Leader reminders stay quiet when that project has an open decision created within the last 60 minutes (`RECENT_OPEN_DECISION_WINDOW_MS`), including a reply that paraphrases the options and phrases the title as a question. Outside that window, a retelling is still recognised only by the full normalized title or by at least two distinctive option bodies with the same recommendation letter. A new question is still reminded when no open decision was created in that window and neither path matches. Fixes [issue #6](https://github.com/jasonhnd/paseo-kanban/issues/6).
- Cleanup unregisters a nested git worktree with `git worktree remove --force` before it deletes a finished card directory, and runs `git worktree prune` only when that directory is already gone. A prunable registration whose path no longer exists is not reported as the card-temp info. A git failure stays the existing cleanup red with backoff. Fixes [issue #10](https://github.com/jasonhnd/paseo-kanban/issues/10).

### Notes

- Package and root lock versions agree on `0.1.0-rc.20`. Node remains `>=24.21.0`, and Paseo daemon/app requirements remain `>=0.11.0 <0.12.0`. Dependency selections, schema and contract versions are unchanged relative to rc.19, no new stored file is introduced, and no automatic data or credential import is added. The 20 dev/build dependency alerts remain.
- The product changes are the reminder window for recent decisions ([issue #6](https://github.com/jasonhnd/paseo-kanban/issues/6)), worktree cleanup after a finished card ([issue #10](https://github.com/jasonhnd/paseo-kanban/issues/10)) and the optional Hermes leader integration. Release documents record rc.19 as the published prerelease.
- Exact rc.20 verification uses only rc.20 receipts. Earlier rc.19 results and the separate results of the three inputs do not pass this candidate. A real Hermes leader session and approval round trip, GitHub cold installs, a real-browser mount of this candidate, installed-host lifecycle, upgrade/rollback with pending waits, native app, phones, authenticated provider cycles, other platforms and production recovery remain unverified. This preparation does not perform the production switch.

## 0.1.0-rc.19 — pending review and publication

Local candidate tag: `v0.1.0-rc.19`. This candidate is prepared only. Install it from GitHub only after its matching prerelease and exact reviewed commit/tag are independently verified. Frozen rc.1 through rc.18 tags are never moved.

### Fixed

- Doctor no longer raises a red for a git worktree inside a board-owned card temp directory (any project's `.kanban-work/<card>/`, or the root recorded by `card_tmp_prepared`) when that card is unfinished, or done or archived and temp cleanup has not failed. A finished card waiting on cleanup is at most an info line, and that line disappears once the worktree is gone. An open `tmp_cleanup_failed`, or a worktree that matches no card, still follows the existing red rules. Fixes [issue #10](https://github.com/jasonhnd/paseo-kanban/issues/10).
- When a review card that borrowed another card's temporary workspace finishes, it releases that claim by deleting only its own agents and retrying the owner's cleanup at once, including a backoff that is still waiting; archived or removed agents of a finished card no longer block cleanup, while an unfinished card, a still-live agent, or a process working directory inside the directory still does. Fixes [issue #11](https://github.com/jasonhnd/paseo-kanban/issues/11).

### Notes

- Package and root lock versions agree on `0.1.0-rc.19`. Node remains `>=24.21.0`, and Paseo daemon/app requirements remain `>=0.11.0 <0.12.0`. Dependency selections, schema and contract versions are unchanged relative to rc.18, no new stored file is introduced, and no automatic data or credential import is added. The 20 dev/build dependency alerts remain.
- The product changes are the doctor finding for a git worktree inside a card temp directory and cleanup of a workspace borrowed by a review card. Release documents record rc.18 as the published prerelease. Shared runtime, voice and dictation defaults, and the lsof lookup from rc.18 are unchanged.
- Exact rc.19 verification uses only rc.19 receipts. Earlier rc.18 results do not pass this candidate. GitHub cold installs, a real-browser mount of this candidate, installed-host lifecycle, upgrade/rollback with pending waits, native app, phones, authenticated provider cycles, other platforms and production recovery remain unverified. This preparation does not perform the production switch.

## 0.1.0-rc.18 — pending review and publication

Local candidate tag: `v0.1.0-rc.18`. This candidate is prepared only. Install it from GitHub only after its matching prerelease and exact reviewed commit/tag are independently verified. Frozen rc.1 through rc.17 tags are never moved.

### Changed

- A finished card's work directory is deleted on the next cleanup round after the card is done or archived, with no 24-hour wait and no file-count cap. A directory that cannot be removed stays a doctor red and is retried with backoff. The red clears as soon as the directory is gone, including when it was already removed, and an inode, owner or generation mismatch keeps the directory and states that specific reason once. Cleanup looks for `lsof` on PATH, then at `/usr/sbin/lsof` and `/usr/bin/lsof`; when there is none, it confirms from the agent list instead (no agent this card opened is still present, no live agent working directory is inside the directory), deletes, and logs an info line, and a live agent working directory inside the directory keeps the red.
- The capacity guard pauses a new card's first work start when card-work usage exceeds 10 GiB or the disk has under 50 GiB free. Review, rework and resume still start. Doctor reports red, the leader is reminded once, thresholds are configurable, and a completed card stores its temp-dir size once. Because a finished card's directory is now deleted on the next round and a successful test removes its card-root workspace immediately, usage falls back under both limits as soon as that removal succeeds, and the pause clears on the following round.
- Test hosts turn voice mode and dictation off, and reuse one read-only official runtime plus a shared npm cache outside the card root.
- Corrected the release checklist to require English-only GitHub Release bodies, with Chinese release documentation kept under `docs/zh-CN/`.

### Notes

- Package and root lock versions agree on `0.1.0-rc.18`. Node remains `>=24.21.0`, and Paseo daemon/app requirements remain `>=0.11.0 <0.12.0`. Dependency selections, schema and contract versions are unchanged relative to rc.17, no new stored file is introduced, and no automatic data or credential import is added. The 20 dev/build dependency alerts remain.
- Only board operations tooling and release documents change: card-directory cleanup, the capacity brake for new cards, test-host setup and the Release-body language rule. The doctor repository scan, the Paseo project-list filtering and product behaviour of cards are otherwise unchanged. The shared runtime is a test-environment cache; the product itself still downloads speech models on first start when voice is on. The isolated test environment, which the pre-push gate uses, now also links `lsof`, which the cleanup tests call through PATH; the cleanup itself no longer depends on PATH, so contributors need `lsof` installed only to run those tests.
- Exact rc.18 verification uses only rc.18 receipts. Earlier rc.17 results do not pass this candidate. GitHub cold installs, a real-browser mount of this candidate, installed-host lifecycle (including a real cleanup or capacity brake on a live board), upgrade/rollback with pending waits, native app, phones, authenticated provider cycles, other platforms and production recovery remain unverified. This preparation does not perform the production switch.

## 0.1.0-rc.17 — pending review and publication

Local candidate tag: `v0.1.0-rc.17`. This candidate is prepared only. Install it from GitHub only after its matching prerelease and exact reviewed commit/tag are independently verified. Frozen rc.1 through rc.16 tags are never moved.

### Fixed

- Doctor no longer builds a project's main directory from the plugin install directory (issue #9). A configured project with no `workspacePath`, no directory known to Paseo and no card directory is treated as "directory unknown" and skipped quietly: no `worktree <path>` info line and no `repo:skipped` ENOENT finding. A relative `workspacePath` is an invalid configuration; it is reported once in the log and never resolved against the plugin directory or the process cwd (the repository lookup that reads `workspacePath` ignores it too). Projects with an absolute directory behave as before, and a project that has left Paseo stays filtered.

### Notes

- Package and root lock versions agree on `0.1.0-rc.17`. Node remains `>=24.21.0`, and Paseo daemon/app requirements remain `>=0.11.0 <0.12.0`. Dependency selections, schema and contract versions are unchanged relative to rc.16, no new stored file is introduced, and no automatic data or credential import is added. The 20 dev/build dependency alerts remain.
- Only the doctor repository scan changes. Project filtering by the Paseo project list, the 30-second read and the roughly 60 to 90 second hiding delay from rc.16 are unchanged, and a project with no known directory is still treated as present in that list. One test was tightened so that a relative `workspacePath` is reported exactly once even when a same-named Paseo workspace exists.
- Exact rc.17 verification uses only rc.17 receipts. Earlier rc.16 results do not pass this candidate. GitHub cold installs, a real-browser mount of this candidate, installed-host lifecycle, upgrade/rollback with pending waits, native app, phones, authenticated provider cycles, other platforms and production recovery remain unverified. This preparation does not perform the production switch.

## 0.1.0-rc.16 — pending review and publication

Local candidate tag: `v0.1.0-rc.16`. This candidate is prepared only. Install it from GitHub only after its matching prerelease and exact reviewed commit/tag are independently verified. Frozen rc.1 through rc.15 tags are never moved.

### Changed

- The board's project and leader list now follows Paseo's project list. A board project is matched to a Paseo project by directory (a `dir:` prefix, trailing slashes and symbolic links are ignored; names are never compared). A project whose directory is no longer a Paseo project is left out of the leader panel, the paused area, the home overview, the by-project tab and the board; it gets no reminder, wake or dispatch; `create`, `register`, `start` and starting a leader for it are refused with a message that says so; and doctor reports no red or yellow for it, only one info line. Its cards and history are kept: `show` reads a card, and `list --include-removed` (or `includeRemoved` in the tool) lists them. When Paseo cannot be read, the last list that was read is kept in `paseo-projects.json`; an empty list is believed only after two successful empty answers at least 60 seconds apart; before the first successful read nothing is filtered. `paused-projects.json` now means projects that are in Paseo and paused for a while.

### Notes

- Public docs and release notes are English-only; Chinese docs remain under docs/zh-CN. A fresh installation follows the system language; an explicit language choice is unchanged (covered by a new test).
- Package and root lock versions agree on `0.1.0-rc.16`. Node remains `>=24.21.0`, and Paseo daemon/app requirements remain `>=0.11.0 <0.12.0`. Dependency selections, schema and contract versions are unchanged relative to rc.15. The only new stored file is `paseo-projects.json`, a small cache of the last Paseo project list; no automatic data or credential import is introduced. The 20 dev/build dependency alerts remain.
- The project list is read from the Paseo client every 30 seconds while the plugin is connected. After the last project leaves Paseo, hiding takes roughly 60 to 90 seconds because an empty list must be seen twice at least 60 seconds apart. A project with no known directory is always treated as present. Whether every project in a production configuration records a `workspacePath` is not verified.
- Exact rc.16 verification uses only rc.16 receipts. Earlier rc.15 and component results do not pass this candidate. GitHub cold installs, a real-browser mount of the merged candidate, installed-host lifecycle, upgrade/rollback with pending waits, native app, phones, authenticated provider cycles, other platforms and production recovery remain unverified. This preparation does not perform the production switch.

## 0.1.0-rc.15 — pending review and publication

Local candidate tag: `v0.1.0-rc.15`. This candidate is prepared only. Install it from GitHub only after its matching prerelease and exact reviewed commit/tag are independently verified. Frozen rc.1 through rc.14 tags are never moved.

### Fixed

- A shared temporary directory could be cleaned up while another card's agent still pointed at it. When the directory-level agent purge failed because such an agent was present, a reconcile sweep that ran before the retry time looked only at the finished card's own agents and recorded the purge as done; archive and directory removal then proceeded. The sweep now treats that failure as done only after the retry time and only when the agent list is readable and no agent of any card points at the directory, and a reconciled row no longer counts as a finished directory-level purge in the cleanup job. Another card's agent keeps the directory, as before.

### Notes

- Package and root lock versions agree on `0.1.0-rc.15`. Node remains `>=24.21.0`, and Paseo daemon/app requirements remain `>=0.11.0 <0.12.0`. Dependency selections, schema and contract versions are unchanged relative to rc.14; no automatic data or credential import is introduced. The 20 dev/build dependency alerts remain.
- Directory-level agent purge failures wait for their retry time before a reconcile sweep may settle them. An unreadable agent list leaves the failure for the normal retry. Rows already written by an earlier build no longer short-circuit the purge step; the next purge round inspects the directory once. Normal commit-ancestry cleanup, PR/squash proofs, explicit discard permissions, audited-tip deletion, shared-copy, active-agent and revocation/retention safeguards are unchanged.
- Exact rc.15 verification uses only rc.15 receipts. Earlier rc.14 and issue-specific results do not pass this candidate. GitHub cold installs, real-browser and installed-host lifecycle, upgrade/rollback with pending waits, native app, phones, authenticated provider cycles, other platforms and production recovery remain unverified for rc.15. This preparation does not perform the production switch.

## 0.1.0-rc.14 — pending review and publication

Local candidate tag: `v0.1.0-rc.14`. This candidate is prepared only. Install it from GitHub only after its matching prerelease and exact reviewed commit/tag are independently verified. Frozen rc.1 through rc.13 tags are never moved.

### Fixed

- Temporary card cleanup accepts the branch tip as merged when either the configured local base or freshly fetched `origin/<base>` contains it. Local-only merges no longer require a push or `--discard-unmerged`, including when origin is behind or unavailable. Local containment also permits branch deletion; a matching local tree alone is insufficient. Cleanup removes the orphan worktree/workspace findings from doctor. Existing PR/squash proofs and explicit discard safeguards remain. Fixes [issue #8](https://github.com/jasonhnd/paseo-kanban/issues/8).

### Notes

- Package and root lock versions agree on `0.1.0-rc.14`. Node remains `>=24.21.0`, and Paseo daemon/app requirements remain `>=0.11.0 <0.12.0`. Dependency selections, schema and contract versions are unchanged relative to rc.13; no automatic data or credential import is introduced. The 20 dev/build dependency alerts remain.
- Normal cleanup requires commit ancestry in the configured local base or freshly fetched remote base; matching tree contents alone are insufficient. Existing PR/squash proofs and explicit discard permissions, audited-tip deletion, shared-copy, active-agent and revocation/retention safeguards remain.
- Exact rc.14 verification uses only rc.14 receipts. Earlier rc.13 and issue-specific results do not pass this candidate. GitHub cold installs, real-browser and installed-host lifecycle, upgrade/rollback with pending waits, native app, phones, authenticated provider cycles, other platforms and production recovery remain unverified for rc.14. This preparation does not perform the production switch.

## 0.1.0-rc.13 — pending review and publication

Local candidate tag: `v0.1.0-rc.13`. This candidate is prepared only. Install it from GitHub only after its matching prerelease and exact reviewed commit/tag are independently verified. Frozen rc.1 through rc.12 tags are never moved.

### Fixed

- Leader reminders recognise a project's current open decision through its full normalized title, or through at least two distinctive option bodies with the same recommendation letter. Options need at least six Han characters or three English content words after generic answer words are removed; a built-in stop list excludes generic answers and rollout templates. This recognises an older options-only retelling without a title or id while still reminding for a new subject that reuses generic rollout options. Closed decisions and unrelated recent decisions do not suppress new questions. User-facing reminders, panel labels, health notices and command/tool help now say Kanban and identify the board as the automatic reminder source; legacy identifiers and reminder inputs remain compatible. Fixes [issue #6](https://github.com/jasonhnd/paseo-kanban/issues/6).

- `resume-cleanup --discard-unmerged` lists only commits reachable from the card tip and absent from every other local branch, remote-tracking branch and tag. It excludes the retiring card branch/worktree, prefers locally available `origin/<base>` (then the configured upstream, then the local base), and warns when the local base is behind. No fetch or network request is made for this audit. Authorization and completion events record the corrected list; leader permissions, audited-tip compare-and-delete and revocation/retention safeguards remain. Fixes [issue #7](https://github.com/jasonhnd/paseo-kanban/issues/7).

### Notes

- Package and root lock versions agree on `0.1.0-rc.13`. Node remains `>=24.21.0`, and Paseo daemon/app requirements remain `>=0.11.0 <0.12.0`. Dependency selections, schema and contract versions are unchanged relative to rc.12; no automatic data or credential import is introduced. The 20 dev/build dependency alerts remain.
- The option classifier uses a finite bilingual stop list and exact normalized bodies. Unlisted generic templates and fully reused business text remain limitations; paraphrases with different wording can still trigger a reminder. Discard auditing uses only the refs already present locally, which can be stale; it does not fetch.
- Exact rc.13 verification uses only rc.13 receipts. Earlier rc.12 and issue-specific results do not pass this integrated candidate. GitHub cold installs, real-browser and installed-host lifecycle, upgrade/rollback with pending waits, native app, phones, authenticated provider cycles, other platforms and production recovery remain unverified for rc.13. This preparation does not perform the production switch.

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
