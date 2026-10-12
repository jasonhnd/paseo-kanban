# Git history helpers and read-scope identities

Git history is admitted only with effective external-diff, textconv and signature
protections plus an explicit safe format. Read scopes compare real filesystem
identities instead of treating different path spellings as different objects.
A separated short value equal to `--` is refused before it can consume the
option separator. This is a local source synchronization, with independent
high-risk review and deployment acceptance still required.

## Fixed revisions and parity

The public base is `5692a5ff7bdc00835854a318b6b768997d26a1c2`.
The accepted source revision is `2dabe4d59c5f98ac055469f9e0af8a499d6d1b89`,
which contains the accepted helper/identity integration
`adadaec15c107c9f1d317f9ee43a0f5bdfb1b074` and the final short-value correction.
The public code tested below is `4ade5196f5fd914b322dc56db3780b0332903092`:
regressions `60c4f3f`, production repair `3717a87`, and output assertions
`4ade519`. The later report commit only adds documentation.

| File | Parity and public adaptation |
| --- | --- |
| `server/readonly.ts` | Byte-identical to the fixed accepted source. Every log needs pre-subcommand `--no-pager -c core.fsmonitor=false`, effective `--no-ext-diff --no-textconv --no-show-signature`, and an explicit safe format such as `--oneline`. Unknown options, helper enablement, signature placeholders, named/default formats, consumed guards, and separator ambiguity deny. Only the accepted short-value check was imported; attached `-S--` and `-G--` remain pattern data. |
| `server/read-scope.ts` | Byte-identical to the fixed accepted source. Real bigint device/inode values compare the object and its ancestors for workspace, grants, HOME, temporary roots and exclusions. Missing stat/identity denies. No case folding, guessed volume behavior or identity cache was introduced. |
| `shared/locales/en.json`, `shared/locales/zh-CN.json` | Exactly the accepted `readonly.gitGuard` key changed in each language; every other key is unchanged from the public base. |
| `test/readonly-boundary.test.ts`, `test/read-scope-boundary.test.ts`, `test/cursor-permission.test.ts` | Added/removed lines exactly match the accepted source delta. Existing anonymous public fixture/import differences were retained. |
| `test/readonly-p2.test.ts` | Accepted production-hook regression; import adapted to the dedicated public test probe. |
| `test/readonly-permissions-probe.ts` | The accepted probe was moved from private shared scripts to the test tree. Removed its private path and obsolete marker-execution reproduction. Uses the operator's temporary root or system temporary directory; synthetic replies and actual safe handlers remain explicit. Adds history content/hash and patch-content assertions. No dangerous input is dispatched. |

The two production SHA-256 values are respectively
`0ec2ea2b6fbf74ae394f3f376f10d57a1b0359e0f35f863292d088c187766cba` and
`4fea2fd65126c18f4a06564c6d6b4743197507c60ba97d1cff5ac9883da7b8eb`.
Every other tracked code file is byte-unchanged from the public base, including
actual linked-review target/run/own-role binding, create/resume rechecks,
family-only wait, permanent human failures, four ops-role gates and ordinary
`starTiers` precedence. Public `DEFAULT_FAMILIES`, `DEFAULT_BANNED`, supervisor
ignore policy, permission context and hooks, fetch, hardlink, recursive search
limit, path race boundary, shared scripts/hooks/workflows, contracts,
dependencies, runtime, production client and package whitelist remain unchanged.

## Isolated execution and reconstruction

Every repository experiment, install, test, scan and commit ran in a subprocess
with a clean environment whitelist from the first experiment. HOME, Paseo,
transcripts, board/cockpit/roles/legacy state, agents, worktrees, project fallback,
XDG, npm config/cache and temporary files belonged to the disposable task root.
`KANBAN_PROJECTS_ROOT` was empty for existing fixture compatibility. Git global
and system configuration were disabled; author/committer and local Git settings
used the documented placeholder identity. The task-local denylist and existing
hooks remained active. No inherited provider/session/token variables, real
credentials, production databases or conversations were read or copied.
Loopback endpoints were unused `127.0.0.1:1`; relay was disabled and no daemon
or provider was started.

To reconstruct, choose a fresh disposable task root and a tool PATH containing
Node, npm, Git and gitleaks. Use `env -i` for every command, including installation,
with the isolation variables above, `GIT_CONFIG_NOSYSTEM=1`,
`GIT_CONFIG_GLOBAL=/dev/null`, placeholder Git identities,
`FLEET_PRIVATE_DENYLIST` pointing at your task-local denylist,
`KANBAN_COMPAT_OFFLINE=1`, `PASEO_URL=http://127.0.0.1:1`,
`PASEO_ENDPOINT=ws://127.0.0.1:1`, and `PASEO_RELAY_ENABLED=0`.
Install with `npm ci --include=dev --ignore-scripts --no-audit --no-fund`.
The lockfile must remain unchanged. Temporary fixture paths must be fresh and
under the operator's own `KANBAN_TMP`; never reuse a personal HOME or daemon.

Full verification used an exact disposable public Git snapshot of the tested
code, including only its reachable public history. Git archive and reachable
object packing populated it without copying a remote, configuration or data.
Its installed locked dependencies were reused; generated bundles stayed in that
snapshot. The actual public Fleet checkout was clean at
`cd9caf5b08b7f2bb5f2c661d5481736d516c75f6`; an archive of that exact revision
provided both `FLEET_CONTRACT_SOURCE` and `PASEO_FLEET_SIBLING` for the full run.
This was a real nine-file source contract and 28-file sibling comparison, never
an empty fallback. Neither shared gates nor performance thresholds were changed.
Tools were Node 24.21.0, npm 12.1.0, Apple Git 2.54.0 and gitleaks 8.30.1.

The joint command was:

```sh
node --import tsx --import ./test/helpers/i18n-preload.ts --test --test-reporter=tap \
  test/review-target-dispatch.test.ts test/ops-roles-matrix.test.ts \
  test/antigravity-boundary.test.ts test/read-scope-boundary.test.ts \
  test/readonly-boundary.test.ts test/readonly-p2.test.ts \
  test/cursor-permission.test.ts test/lifecycle-hooks-flow.test.ts \
  test/hook-registration.test.ts test/routing.test.ts \
  test/dispatch-matrix.test.ts test/schedule.test.ts test/brief-file.test.ts
```

Run the actual local permission probes separately:

```sh
node --import tsx test/antigravity-permissions-probe.ts --fixture "$TASK_TEMP/old-hook"
node --import tsx test/readonly-permissions-probe.ts --fixture "$TASK_TEMP/new-hook"
node --import tsx test/readonly-permissions-probe.ts --short-values-after
hdiutil create -size 64m -fs HFSX -volname AnonymousValidation "$TASK_TEMP/case-sensitive.dmg"
hdiutil attach "$TASK_TEMP/case-sensitive.dmg" -nobrowse -mountpoint "$TASK_TEMP/case-volume"
node --import tsx test/readonly-permissions-probe.ts --case-sensitive "$TASK_TEMP/case-volume/fixture"
hdiutil detach "$TASK_TEMP/case-volume"
```

The operator must create the mountpoint under the task root and always detach in
cleanup, including after a failure. This run detached successfully; the image
was absent from `hdiutil info`. The natural task filesystem was actually case
insensitive (`insensitive=true`), and HFSX was actually case sensitive
(`insensitive=false`). Case-distinct permitted files remained readable/searchable
on HFSX, while the excluded HOME remained denied on both filesystems.

## Results and failures retained

| Command/layer | Exit | Actual result |
| --- | ---: | --- |
| Initial instruction file listing | 1 | Isolated tool PATH did not contain `rg`; PATH was corrected before installation. No repository change or isolation relaxation. |
| Locked `npm ci` above | 0 | 362 packages; lockfile unchanged. |
| Three new boundary/probe test files before repair | 1 | Expected red: 28/32 pass, four failures cover missing HOME identity, log helper guards, short-value separator, and production hook refusal. No dangerous handler ran. |
| Anonymous old gate counterexamples | 0 | Eight unguarded log variants, three separator forms and both HOME-alias auto-accept modes were incorrectly allowed by the old public base; handlers explicitly false. |
| `--short-values-before` on that old public base | 1 | The first separator was incorrectly allowed. Its missing-value assertion also failed because this base predates the log parser; this mode describes the intermediate source parser, not the older public base. The failure is retained rather than reported as a successful source reproduction. |
| First joint targeted run | 1 | 420/421; added content assertion wrongly expected `-W` or `--function-context` alone to produce a patch. Safe Git returned history only. Actual output was checked; only the assertion was corrected. Production policy remained byte-identical. |
| Final joint command above | 0 | 421/421; zero fail/skip/cancel. Review target, family, ops, Google, scoped read, read-only and lifecycle hook regressions pass together. All provider endpoints are simulated. |
| `--short-values-after` | 0 | All six isolated separator/missing-value examples deny; no handler. |
| Original permission probe | 0 | 126: 30 allow/96 deny; 30 actual safe local handlers; both auto-accept modes. |
| New probe, actual case-insensitive filesystem | 0 | 204: 88 allow/116 deny; 88 safe local handlers. |
| New probe, actual HFSX filesystem | 0 | 204: 96 allow/108 deny; 96 safe local handlers. |
| Volume create/attach/detach | 0/0/0 | 64 MiB disposable image; fully detached. |
| Exact source and preserved-public comparison | 0 | Production bytes, locale keys and test delta match; all out-of-scope code is unchanged. An initial whole-test-file equality check failed on pre-existing anonymous public fixture differences; comparison was corrected to exact additions/removals, without changing those fixtures. |
| `npm run verify` on the fixed code snapshot | 0 | All 12 gates passed in 139.850 seconds; 2,608 regression + 54 performance tests, zero fail/skip/cancel. |

The two new volume runs total 408 production-hook cases: the original 280
helper/HOME matrix plus 128 short-value cases. Every request compared the entire
fixture's directory entries, file hashes, mtimes, modes and sizes with its
baseline. Denied handler count was zero; every allowed request had a real safe
local Git/read/search handler. The local search handler searched synthetic file
content; it is not a live provider search implementation. Guarded history output
was nonempty, actual patch-producing options retained old/new text, and their
stdout sizes/hashes were recorded. External-diff/textconv/fsmonitor/pager markers
never appeared. Sentinel SHA-256 was
`cba9765da419a45fa2d2ff6600be335b7b7417562691e2f971b0b016f1c29327`,
30 bytes, mode `0640`, unchanged after every request.
Both probes explicitly reported `realProviderEvent=false` and
`realAcpLifecycle=false`; the real ACP event list is empty.

The complete final code verification had these twelve gate results:

| Gate command | Exit | Evidence on the fixed tested code |
| --- | ---: | --- |
| `node scripts/typecheck.mjs` | 0 | 438 TypeScript files; no diagnostics. |
| `node --test scripts/*.test.mjs` (11 files expanded by verify) | 0 | 115 pass; zero fail/skip/cancel. |
| `node scripts/build-cli.mjs` | 0 | Four actual standalone Node bundles. |
| `node scripts/paseo-build-check.mjs --strict` | 0 | Actual installed `@getpaseo/server` 0.11.2 compiler; client 564,040 bytes, server 10,868,306 bytes; no skip. |
| `node scripts/test-plugin.mjs` | 0 | 2,608 regression + 54 performance pass; zero fail/skip/cancel. Active timing/CPU/I/O gates, no threshold changes. |
| `node scripts/check-private.mjs --all --quiet` | 0 | 564 files; zero hits in the build snapshot. |
| `node scripts/check-identity.mjs` | 0 | Two placeholder next-commit identities; zero problems. |
| `node scripts/check-identity.mjs --history` | 0 | 73 reachable public commits / 146 identities; zero problems. |
| `gitleaks git --redact --no-banner .` | 0 | 73 reachable public commits; no leaks. |
| `node scripts/sync-contract.mjs --check` | 0 | Nine files checked against the actual fixed public Fleet source. |
| `node scripts/compare-scripts.mjs` | 0 | 28 actual shared files byte-identical to the fixed Fleet sibling. |
| `node scripts/check-package-files.mjs` | 0 | 256 package files; zero problems, original whitelist retained. |

Full command/output logs, separate volume commands and an exit-code manifest
remain in the disposable task evidence directory. Anonymous copies and hashes
are attached to the operational handoff; they contain synthetic fixtures only.
The permanent report records failures as well as final passing results. A later
documentation-only commit received fresh privacy, next/history identity,
gitleaks, whitespace and clean-tree checks; it did not rerun unchanged code.

## Remaining evidence boundaries

Official ACP permission events, provider startup, real quota/model tasks,
structured board identity, a complete normal card lifecycle and live actual
cross-family review remain unverified here. Tests use production gate/hook/CLI
adapters with synthetic scope or provider endpoints and actual allowed local
handlers. Existing historical validation reports are preserved and do not stand
in for this integration run. The two earlier local code gaps are repaired at the
revision recorded here; arbitrary HTTP(S) fetch, the 50,000-entry recursive search
limit, hardlink denial and non-atomic path-check/TOCTOU boundary remain unchanged.
No general shell safety audit or OS sandbox is claimed.

This local synchronization does not authorize operational push, PR, merge, tag,
publication, reload, enablement, configuration changes, pause removal or model
activation. Deployment/mobile freeze, explicit different-family mitigation,
provider prohibitions and dispatch pauses remain in force. High-risk independent
review must use the actually eligible different family; unavailable capacity is
queued, not bypassed. All validation command sessions ended before delivery,
and the task volume was detached. Temporary evidence, image, caches, fixtures and
builds remain solely in the disposable task directory; the working tree is clean.
