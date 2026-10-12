# Explicit Gemini quota policy validation

The designated Antigravity entry can consume an explicitly unprotected, fresh
quota snapshot while unknown usage stays null. Protected readings still require
valid usage and an unexpired reading. This is a local public-source port;
independent high-risk review and lead acceptance remain required.

## Fixed revisions

| Input or output | Revision |
| --- | --- |
| Accepted public base | `a2c7dfedfd9ec9d6dd96161b5196b8adb4e9f78d` |
| Accepted implementation source base | `62516eeea6825caa0b9b3134f14574da775be540` |
| Accepted implementation source final head | `a019422b996144b8ff7d6bf1764a453b18950182` |
| Source minimum runtime change | `b317363d5e8bef8aaa2162c7132907448d30aa09` |
| Source reader-isolation correction | `4447c7a3e1080cfbdfb77d3f39cdbdf3db5f38f6` |
| Public red-test commit | `79438c3` |
| Public runtime and tested code head | `83c131f44ee9d652d6dac2dff1e8ec648a1d4b63` |
| Fixed public Fleet source and sibling | `cd9caf5b08b7f2bb5f2c661d5481736d516c75f6` |

The source received actual cross-family high-risk review and lead acceptance
before this port began. The public base retains accepted review-wait,
cleanup-generation and atomic user-hold behavior and all their English records.

## Exact scope and parity

Only four runtime files and one boundary test change before this report.
`googleDispatchBlock` matches the accepted source after substituting the existing
public `PAUSED_NOTE` constant for its pause-note regex. Removing that function
leaves `server/routing.ts` byte-identical to the public base. Public code-point
spelling and vendor-neutral rules stay intact.

`server/pools.ts` adds only optional `dispatchableExplicit` and its
`raw.dispatchable === true` consumer assignment; reversing those additions
restores the exact base. The field comment uses the public Fleet name.
Both catalogs change only `routing.google.quota` to the accepted source value:
key sets and every other value are unchanged. The boundary file matches the final
source with only its pause-note fixture translated to the existing `[Paused]`.

No defaults, star-tier precedence, operations gates, actual review target,
cleanup/current-generation, user hold, review wait, permissions, lifecycle hooks,
shared scripts, hooks, workflows, contracts, dependencies, lockfile or package
whitelist change. Private status documents, real identifiers, configuration,
credentials, databases and transcripts are not exported.

| Changed file | SHA-256 |
| --- | --- |
| `server/pools.ts` | `f04f41e2aeb278103043cd892b77dd5943b68bcf0f4a8e1aaf342851e3cc1525` |
| `server/routing.ts` | `75ba7a0a7bbd40ab3e4d8374ea4a13e48acb694335598470225a33f9db625916` |
| `shared/locales/en.json` | `68a4c51c0b1335ae6c02e714c1fb8f2b18ce4214e142a9f7f5022f0f06423d59` |
| `shared/locales/zh-CN.json` | `59ddc9d245e4b89a67a244a2f3e1b3c6a3060a5fcebe7185a72039c99752be16` |
| `test/antigravity-boundary.test.ts` | `ed0b2dca4046c4e83b82d4278e98caf1ca9f6223743da7139ceba18547c76d0c` |

## Policy and application evidence

The only admitted Google entry remains official Antigravity ACP 1.3.0,
`gemini-3.8-flash-medium`, default mode and `antigravity-gemini`.
Only executor, batch and reader at L1/L2 qualify. Omitted mode is normalized to
`default` by the existing production launcher adapter.

Both strategies require a fresh snapshot that actually lists the designated pool,
explicit true dispatch from the parsed export, eligible role/profile and all
ordinary bans/role limits. Explicit `none` also needs a current non-stale matrix
with the candidate listed and unpaused. Unknown/missing protection, missing or
nonboolean dispatch, false dispatch, absent/stale/unlisted snapshot, missing or
stale/paused/unlisted matrix, bans, personal/paused profiles, unknown tier,
L3/L4, decision/reviewer and other entry/model/mode/pool refuse. Automatic,
explicit, preselected and resumed work recheck the gate. `pause` retains finite
usage in [0,100) and a future reading expiry. Non-Google fallback behavior is
unchanged.

Null usage and expiry under `none` remain null when parsed, selected and recorded.
No fake zero or production reading is inserted. CLI usage is reference only:
it does not prove CLI and ACP share a quota pool. Explicit opt-out accepts
invisible-quota risk; it does not measure remaining capacity or override bans.

Positive tests execute production `runTick`, `startTask` and `launcherFrom`
with synthetic endpoints, all three roles, both tiers, explicit/omitted mode and
both auto-accept settings. Actual local run rows store Google provider/model/family
despite misleading mutable labels. Executor and batch enter review, reject a
Google reviewer disguised as another family, and record a non-Google review run.
These are real application paths and DB facts, not real provider sessions.

Reader create forces auto-accept false without mutating the input profile.
With both original auto-accept settings, production `permissionContext`,
`decidePermission` and lifecycle hook use live local DB roots instead of untrusted
file labels. Workspace/approved-root reads allow; external read, edit, mode switch
and shell deny. Test agents roots are local constants; fake records are removed
in `finally`. Sentinel bytes remain unchanged.

The existing permission probes additionally exercise safe local read/search/Git
history/help handlers behind the production hook. Replies are synthetic; denied
commands never reach a handler. File lists, modes, times and hashes are unchanged.
Existing [Antigravity evidence](ANTIGRAVITY-AUTHORIZATION.md) and
[readonly evidence](READONLY-VALIDATION.md) remain historical records; only their
old protected-quota prerequisite is superseded by this explicit policy option.
This does not establish live ACP enforcement.

## Historical source isolation correction

The source's first review found two reader-hook tests depended on an inherited
agents-root variable. Without it they threw an undefined-path TypeError; with a
real inherited root they could write fake records there and leave them after a
failed assertion. Initial boundary/full-suite success was conditional on an
external harness variable, not evidence for the default test entry.

The accepted final source initializes its own agents root and uses `try/finally`.
Its independent re-review reported 213 boundary and 2,933 full-suite tests passing
with the variable unset, and an unchanged artificial inherited sentinel. These
are source-reported historical results, not tests rerun here. This public port
independently checks its own unset-variable and inherited-sentinel cases below.
No private source report is copied and no earlier unverified live ACP result is
promoted to success.

## Isolation and reproduction

Every install, experiment, build, test, scan and commit uses a clean `env -i`
whitelist from the first experiment. No provider/session/token or real agent
identity is inherited. Endpoints are unused `127.0.0.1:1` (connection refused
confirmed), relay is disabled and offline compatibility is set.
No daemon/provider, production DB/config, conversation or credential is read,
copied or started. The installed compiler is imported without starting the app.

All mutable roots below are under the operator's one disposable task directory:

| Purpose | Variables |
| --- | --- |
| Home/Paseo/transcripts/config | `HOME`, `PASEO_HOME`, `PASEO_TRANSCRIPTS_DIR`, `KANBAN_PASEO_CONFIG` |
| Board/Fleet/roles | `KANBAN_DATA_DIR`, `KANBAN_DB`, `AFC_DATA_DIR`, `ROLES_STATE_DIR`, `KANBAN_POOL_STATUS`, `KANBAN_DISPATCH_MATRIX` |
| Worktrees/project fallback | `KANBAN_WORKTREES_DIR`, `KANBAN_AGENTIC_ROOT` |
| npm/XDG/temp | `npm_config_cache`, `npm_config_userconfig`, `npm_config_globalconfig`, `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`, `XDG_DATA_HOME`, `TMPDIR`, `TMP`, `TEMP`, `KANBAN_TMP`, `KANBAN_TMP_ROOT` |

`KANBAN_PROJECTS_ROOT` stays unset so it cannot mask fixtures. `KANBAN_HOME` and
`KANBAN_PROJECT_ROOT` identify the tested checkout. The boundary suite supplies
its own agents directory; `KANBAN_AGENTS_DIR` is unset except for the artificial
sentinel probe. Disable Git global/system config (`GIT_CONFIG_GLOBAL=/dev/null`,
`GIT_CONFIG_NOSYSTEM=1`), use documented placeholder author/committer identities in both the environment
and local repository config (`git config user.name "paseo-fleet contributors"`
and `git config user.email noreply@example.invalid`),
a task-local nonempty private denylist, and the existing hooks. Set
`PASEO_URL=http://127.0.0.1:1`, `PASEO_ENDPOINT=ws://127.0.0.1:1`,
`PASEO_RELAY_ENABLED=0`, `KANBAN_COMPAT_OFFLINE=1`. Supply only tool PATH,
locale/timezone, and the explicit compiler/source paths in addition to this list.

Install with `npm ci --include=dev --ignore-scripts --no-audit --no-fund`.
Both `FLEET_CONTRACT_SOURCE` and `PASEO_FLEET_SIBLING` point at a complete archive
of the fixed public Fleet head above: tree
`cb99b4fbad5d2d2380c254622ba3434f8c6733c1`, 370 files. It supplies a real nine-file
source contract and 28 shared files, never an empty fixture or unset comparison.

Archive the exact public code head into the task directory and import only its
reachable public Git objects into a fresh local repository, setting its index to
that head. Copy the installed locked dependencies; do not copy remotes, repository
config or state. Build artifacts stay in this temporary snapshot. The card checkout
remains clean. `PASEO_PLUGIN_COMPILER` identifies the actual installed compiler;
this run used `@getpaseo/server` 0.11.2.

Run the following in that snapshot with the clean whitelist:

```sh
npm run build
node --import tsx --import ./test/helpers/i18n-preload.ts --test --test-reporter=tap \
  test/wait-user.test.ts \
  test/schedule.test.ts \
  test/acceptance-review-wait.test.ts \
  test/acceptance-review-retry.test.ts \
  test/acceptance-review-board.test.ts \
  test/acceptance-watch.test.ts \
  test/review-target-dispatch.test.ts \
  test/dispatch-matrix.test.ts \
  test/routing.test.ts \
  test/ops-roles-matrix.test.ts \
  test/antigravity-boundary.test.ts \
  test/fleet-rules.test.ts \
  test/read-scope-boundary.test.ts \
  test/readonly-boundary.test.ts \
  test/readonly-p2.test.ts \
  test/cursor-permission.test.ts \
  test/lifecycle-hooks-flow.test.ts \
  test/hook-registration.test.ts \
  test/identity.test.ts \
  test/leader-identity.test.ts \
  test/cli-guard.test.ts \
  test/node-cli.test.ts \
  test/profile-rules.test.ts \
  test/quota-protection.test.ts \
  test/pools.test.ts \
  test/disabled-pools.test.ts \
  test/i18n.test.ts \
  test/event-noise.test.ts \
  test/brief-file.test.ts \
  test/cleanup-rework-generation.test.ts \
  test/cleanup-gone.test.ts \
  test/cleanup-auto-retry.test.ts \
  test/cleanup-races.test.ts \
  test/cleanup-stop.test.ts \
  test/cleanup-queries.test.ts
npm run verify
```

Run the independent safe-handler probes in fresh task-owned directories:

```sh
node --import tsx test/antigravity-permissions-probe.ts --fixture "$TASK_TEMP/old-hook"
node --import tsx test/readonly-permissions-probe.ts --fixture "$TASK_TEMP/readonly-hook"
```

For inherited-root isolation, fingerprint the relative file list and bytes of an
artificial sentinel directory, set `KANBAN_AGENTS_DIR` to it, run the whole
boundary file, and compare again. Never use a real agents root.

## Local results and failures

Validated on 2026-10-11 with Node v24.21.0 and npm 12.1.0 at the code head above.

| Command/layer | Exit | Result |
| --- | ---: | --- |
| First clean environment probe | 0 | All state roots task-owned; identity/token/agents variable absent. |
| Locked install | 0 | 362 packages; lockfile unchanged; existing deprecation notices retained. |
| Fixed boundary before runtime port | 1 | Expected red: 176/213 pass, 37 fail, 0 skip/cancel; 4.438 s. Old gate refused 24 none/null starts, two reader hooks and three compliant resumes; four undeclared-dispatch and four unknown-tier rejection assertions exposed old fallback. |
| First test commit hook | 1 | Chinese pause fixture triggered two privacy hits; only that fixture translated to English. Same hook then passed. |
| Direct source patch | 1 | Existing public comments/pause spelling/catalog positions differed; nothing applied. Only authorized delta ported and parity checked. |
| Boundary, agents unset | 0 | 213/213, 0 fail/skip/cancel; 4.813 s. |
| Boundary, inherited artificial root | 0 | 213/213, 0 fail/skip/cancel; 5.819 s; list and sentinel hash unchanged. |
| Permission hook + safe local handlers | 0 | 126 requests, 30 local handlers; all fingerprints unchanged. |
| Readonly hook + safe local handlers | 0 | 204 requests, 88 allow/116 deny, 88 local handlers; natural filesystem actually case-insensitive; fingerprints unchanged. No new case-sensitive-volume claim. |
| Initial joint setup | 2 | Three guessed filenames absent; assertion stopped setup before tests. Corrected to actual public names. |
| First joint before CLI build | 1 | 905/914, nine missing-bundle failures; 0 skip/cancel. Runtime stayed unchanged. |
| CLI build, then same joint | 0 | Four Node bundles; 914/914, 0 fail/skip/cancel; 22.120 s. Permissions/readonly/Google/actual target/family/ops/review wait/user hold/cleanup run together. |
| Temporary archive/snapshot setup | 1/2 | System Python lacked tar filter support; members checked before extraction. Missing setup script and later untracked dependency symlink corrected; copied locked dependencies produced clean public snapshot. No production data copied. |
| Typecheck | 0 | 448 files. |
| Actual strict retained build | 0 | Compiler 0.11.2; client 566,713 bytes, server 10,890,960 bytes; not skipped. |
| Fixed delta/baseline parity | 0 | Function/fields/quota keys/corrected test match accepted source with documented adaptations; all other public files unchanged. |
| Real contract source | 0 | `fleet-quota/v1`, nine files checked against source. |
| Real sibling | 0 | 28 shared files identical. |
| First full `npm run verify` | 1 | Eleven gates passed, including 115 script tests, 2,918 regression + 54 performance tests with 0 fail/skip/cancel. Next-commit identity failed because the fresh snapshot lacked local user.name/user.email, despite correct environment identities; explicit local placeholder config added without copying real config. 152.531 s. |
| Final full `npm run verify` | 0 | All 12 gates passed; 115 script tests, 2,918 regression + 54 isolated performance tests, all with 0 fail/skip/cancel; 149.903 s. |

The final twelve-gate run checked 448 TypeScript files, built four CLI bundles,
and actually compiled client/server with host compiler 0.11.2 (same byte counts
as the retained build). It scanned 575 code-snapshot files with no privacy hits,
checked next-commit identity and 91 public commits/182 identities with no problems,
found no history leaks, checked nine source-contract files and 28 sibling files,
and admitted 259 package files with no whitelist problems. Report additions are
outside that code snapshot; their existing commit hooks and final whole-tree
privacy/identity/diff checks run separately. No real live test was skipped or run.

| Evidence log | SHA-256 |
| --- | --- |
| `red` | `271d030f7643151c15f5ff08591a9f19b2c7f7687c3a045ac58e428e860c2d81` |
| `green` | `cdb5260bd7b4fbb0036022662350e2654c71805694c23a9d9315844a1d1bddc4` |
| `sentinel` | `33fcf34edfbf2027327d5f7424789f8706ef73983ac838da6f29800bfe1af1ad` |
| `joint-fixed` | `d84fe199ded0dd1e34ca383c3f79e3b4ccfa36e5b73518ef5baf8cbeb523c08c` |
| `joint-built` | `0acbf558097dc6209fdb28fe06ee76a17085f9ed0d442957fa9f1ded3493b76e` |
| `old-hook` | `350c4335756959aa4e41db5b4c3af388b6852431401024e978e0e0161b9b44e7` |
| `readonly-hook` | `cb1cf8c1317c2a3eb579fdacccde796320290db6d0087f1bbddedfcf386e8639` |
| `verify` | `20af964cea2920c5ccd6df4d6db85a2bc7e536924eeb103c7f146173ca04a120` |
| `verify-final` | `36c76f8c1d36f0397bc7b52359cf9b87587ca12c432b81ba24707f806cd81432` |
| `parity-final` | `e3b9f67621263fce4584af3a19baf0dd5a450405098a3ebe20defc545bc9a9d6` |

The inherited sentinel SHA-256 is
`2c7551d7c589c6a20853327258e6fc58e97e234ce9658ba257029926e448c03a`.
Retained strict bundle hashes are client
`3ed26c998dee7a6d4b1ad1ee83c33e22a2f08f8a54421aa1b7f5b8c2e3aea466`
and server
`de2d071a698f123c9ce02946660e4a1cbf242eefa7f7082623896d58969b0ee0`.

## Delivery limits

No real provider/ACP lifecycle, same-pool relationship, production in-memory
bundle, daemon reload, desktop mount or candidate enablement is verified.
Earlier unverified live observations remain unverified. Synthetic endpoints and
safe local handlers do not substitute for those checks. Deployment/live validation
belongs to separately authorized owners; invisible quota remains an opt-out risk.

The next commit adds only this report. Full verification belongs to the exact
code snapshot above; report hooks/scans are checked separately. No real profiles,
quota/pool policies, bans, dispatch priority, targets or pause state changed.
No push, remote operation, PR, merge, tag, release, demo or deployment occurred.
