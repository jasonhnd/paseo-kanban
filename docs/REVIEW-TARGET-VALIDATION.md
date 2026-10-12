# Actual-family constraints for linked reviews

This local change makes a reviewer created with `--reviews` use the reviewed
card's actual work run. A batch delivery executed by OpenAI cannot receive an
OpenAI reviewer when the different-family pool is full. It remains queued and
starts the different-family reviewer after that pool becomes available.
The review card's own executor columns, editable profile labels, and later inline
reviewer runs on the target do not establish the target's execution family.

The tested integrated code is `e05fa797a95d7a6e96f65d4e8cd852bdb9c8efb1`, based on
accepted public main `3dd653bb8ed97658e84b9ad12dbf0bfdaa43677d`. The subsequent
report commit changes documentation only. The earlier pre-integration result
for `6bcc6b47edd044141263d1153c3fcbc749fee1fa` is recorded separately below and
does not establish the ops integration result.

## Source comparison and behavior

The additions and removals in all six production files below were compared
line by line with the accepted source review-routing diff. Every changed line
matched. Existing public differences were preserved rather than replacing
whole source files. Private reports, status documents and operational evidence
were not imported; the regression fixtures use anonymous cards and agents.

| File | Accepted behavior retained |
| --- | --- |
| `server/execution-family.ts` | Provider/model facts precede editable family labels; contradictory facts return unknown; Google aliases retain Google identity. |
| `server/review-target.ts` | Resolve the target's latest own-role delivery run, including batch, executor and other roles; reject missing work runs, unknown family or agent binding, and stale takeover bindings. |
| `server/profiles.ts` | Share Google fact detection with the target resolver; preserve public RPC profile bootstrap and existing Google admission. |
| `server/routing.ts` | Apply the target constraint to matrix, roster, explicit picks, L4/high-risk rosters, priority hints and downgrade; wait for a compliant automatic reviewer instead of falling back to the target family or an unlisted roster. |
| `server/schedule.ts` | Resolve actual target evidence for automatic linked reviews and ordinary inline reviews. |
| `server/dispatch.ts` | Recheck preselected/cached routes, resolve again after awaited placement before create, and validate the actual resumed reviewer run; persist target/run evidence in dispatch events. |

Linked reviews require actual target run evidence. Legacy inline reviews alone
retain their existing nonblank persisted family fallback. An independent reviewer
without `review_of` retains standalone routing; a title mentioning another card
does not create a review association. Missing login, missing profiles and hard
configured dispatch restrictions remain permanent failures. A family-only
automatic queue remains queued without selecting a same-family reviewer.

The public ops integration retains all four `ops_*` wildcard lists, their
parser, automatic-only missing-quota and paused/personal-profile gates, and
ordinary reader/decision/batch `starTiers` precedence. The only textual conflict
was at `listForRole`: the ops helper/body was kept with the new `MatrixList`
return type. `server/matrix.ts`, `test/ops-roles-matrix.test.ts` and the existing
`docs/TOOLCHAIN-VALIDATION.md` were byte-unchanged from accepted public main.
Their earlier tested revisions and evidence sections were not rewritten.

Existing Google authorization, read scope, permission hooks, read-only helper
boundaries, unrestricted public family/ban defaults, shared gates, contracts,
dependencies and package rules were retained. Later independent read-only helper
repairs are outside this diff.

## Isolated local evidence

Every installation and validation subprocess began with a clean environment
whitelist. HOME, Paseo/config, transcripts, board/roles/cockpit state, legacy
state, agents, worktrees, project fallback roots, npm configuration/cache and
temporary files used the disposable task directory. `KANBAN_PROJECTS_ROOT` was
empty so it could not mask test fixtures. Git global/system configuration was
disabled and placeholder author/committer identities were used. No inherited
provider identity, token, session, production database or credentials were copied.

Full verification used an exact disposable snapshot containing the tested HEAD
and its reachable public Git history, with no remote. Installed locked development
dependencies were reused from the task checkout; generated bundles stayed in the
disposable snapshot. The real accepted public Fleet source and sibling was
`cd9caf5b08b7f2bb5f2c661d5481736d516c75f6`, with an empty working tree. Both
`FLEET_CONTRACT_SOURCE` and `PASEO_FLEET_SIBLING` named that source; the shared-gate
check did not use an empty-comparison fallback. The actual installed Paseo
compiler ran without a daemon.

| Command (inside the isolated environment) | Exit | Result |
| --- | ---: | --- |
| `npm ci --ignore-scripts --no-audit --no-fund` | 0 | 362 locked packages installed; lockfile unchanged. |
| `node --import tsx --import ./test/helpers/i18n-preload.ts --test --test-reporter=tap test/review-target-dispatch.test.ts` before wiring the new constraint | 1 | Expected reproduction: 12 passed, 34 failed. Actual `runTick` plus `launcherFrom` with simulated endpoints created an OpenAI reviewer when the different-family pool was full. |
| Same focused command after the fix | 0 | 46/46; includes full-pool wait/release, explicit/preselected refusal, actual takeover evidence, unknown target refusal, resume, create-time recheck, normal inline review and independent standalone review. An intermediate run had 44/46 because two assertions still expected private-policy wording; those public message assertions were corrected. |
| Joint targeted tests after integration, expanded command below | 0 | 380/380, no failures, skips or cancellations; includes reviews, ops, Google authorization, permissions, routing, matrix, schedule and brief-file tests. |
| `node --import tsx test/antigravity-permissions-probe.ts --fixture <task-temp>/permission-probe` | 0 | 126 simulated-provider permission cases: 30 allow, 96 deny, 30 actual safe local handlers; fixture fingerprints unchanged. |
| `npm run verify` on the earlier pre-integration code | 0 | All 12 gates; 2,590 regression and 54 performance tests. This result applies to the earlier code revision only. |
| `npm run verify` on integrated code | 0 | All 12 gates passed in 157.481 seconds; 2,604 regression + 54 performance tests, zero failures/skips/cancellations. |
| Exact source additions/removals and accepted-public preservation comparison | 0 | All six production changes match the accepted source diff; ops/parser/test/docs/safety/shared gates/dependencies preserved. |
| Final `git diff --check`, privacy/identity/history scans, and `git status --short` | 0 | No whitespace, privacy or identity findings; empty working tree after the report commit. |

The joint targeted command was:

```sh
node --import tsx --import ./test/helpers/i18n-preload.ts --test --test-reporter=tap \
  test/review-target-dispatch.test.ts test/ops-roles-matrix.test.ts \
  test/antigravity-boundary.test.ts test/read-scope-boundary.test.ts \
  test/readonly-boundary.test.ts test/cursor-permission.test.ts \
  test/routing.test.ts test/dispatch-matrix.test.ts test/schedule.test.ts \
  test/brief-file.test.ts
```

The twelve integrated gates ran with these results (all exit 0):

| Gate command | Evidence at the tested code HEAD |
| --- | --- |
| `node scripts/typecheck.mjs` | 436 TypeScript files; no diagnostics. |
| `node --test scripts/*.test.mjs` (all 11 sorted files, expanded by verify) | 115 passed; zero failures/skips/cancellations. |
| `node scripts/build-cli.mjs` | Four actual standalone Node bundles. |
| `node scripts/paseo-build-check.mjs --strict` | Actual `@getpaseo/server` 0.11.2 compiler; client 563,823 bytes, server 10,863,116 bytes; no skipped compilation. |
| `node scripts/test-plugin.mjs` | 2,604 regression + 54 isolated performance tests passed; active performance gates, no threshold changes. |
| `node scripts/check-private.mjs --all --quiet` | 561 files, zero hits before the report commit. |
| `node scripts/check-identity.mjs` | Two next-commit identities, zero problems. |
| `node scripts/check-identity.mjs --history` | 69 reachable commits / 138 identities, zero problems before the report commit. |
| `gitleaks git --redact --no-banner .` | 69 real reachable commits, no leaks before the report commit. |
| `node scripts/sync-contract.mjs --check` | Nine contract files checked against the actual fixed public Fleet source. |
| `node scripts/compare-scripts.mjs` | 28 actual shared files byte-identical to the fixed public Fleet sibling. |
| `node scripts/check-package-files.mjs` | 256 package files, zero problems. |

The code validation subprocesses finished before delivery. Full logs, exact
expanded commands and the validation manifest remain in the disposable evidence
directory for review. The report received fresh privacy, identity/history and
whitespace checks after the code-only verification.

## Evidence limits

The review regressions exercise actual CLI, scheduler, start and launcher adapter
handlers with simulated provider endpoints. The permission probe uses the
production hook and real allowed local handlers, with `realProviderEvent=false`
and `realAcpLifecycle=false`. Neither establishes real model startup or a complete
live Kanban lifecycle. Official ACP permission events, protected real quota,
model tasks, deployed joint behavior and live different-family review remain
unverified. Local verification does not authorize publication, reload,
enablement, removing dispatch pauses or withdrawing the explicit different-family
mitigation. The deployment freeze remains.
