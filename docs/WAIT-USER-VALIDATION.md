# Atomic user hold for a human block

A blocked `needs_human` card becomes ready with its decision hold in one transaction. The accepted public head's independent review-wait rules stay in place. This is local evidence only. It does not authorize a production reload or enablement.

## Fixed revisions

| Role | Revision |
| --- | --- |
| Accepted public head | `be6529a50f41d6a5ca13e56efbb177b8d5a4653d` |
| Review-wait runtime and tests inside that head | `e5bf81a45e9295f1e5e31770f76766e9fd05da13` |
| Review-wait twelve-gate tree inside that head | `fde6890f4cb5c304164cdd93b657d72f707d4ad8` |
| Cleanup-generation public base retained by that head | `dabc420f4c88e3a82269b737d974054945a4f05f` |
| Accepted wait-user source | `a247d4519a1d65f5fe834a06f966a77af2dcd7eb` |
| Integrated code tested below | `14aebcd1c22639f44f5a1b843c9fac8d27e981a6` |
| Pre-merge parent, historical evidence only | `cecaea4484e39ad98816af7edbb9b2bfc93840ca` |
| Fixed Fleet source and sibling | `cd9caf5b08b7f2bb5f2c661d5481736d516c75f6` (tree `cb99b4fbad5d2d2380c254622ba3434f8c6733c1`, 370 files) |

`server/wait-user.ts` is byte-identical to the accepted wait-user source. Its SHA-256 is `227ef55e896fd286069945fdd3864853d67b4277537f8b086d46e2b0c4ed1da5`. No public wait-user symbol was renamed. `dependencyMet`, `resumableAgentId`, `parentsBlockReason`, `cachedMergeState`, and `waitUser` keep their existing names.

## Both semantics kept

The merge parents are the pre-merge parent and the accepted public head. Git auto-merged the two catalogs. No production file was replaced as a whole.

These files match the accepted public head byte for byte: `server/dispatch.ts`, `server/schedule.ts`, `server/routing.ts`, `server/queue-hold.ts`, `server/acceptance-review-wait.ts`, `server/acceptance-watch.ts`, `server/board-cards.ts`, `server/dependency-attention.ts`, `server/leader-activity.ts`, the review-wait tests, and `docs/TOOLCHAIN-VALIDATION.md`.

The scheduler still returns before launch when `wait_decision` is set, and it restores the user-hold text. Review-wait behavior stays the accepted one: the current acceptance round, own-role run, structured quota and capacity queues, proven retry, ancestor facts, real blocked or rework precedence, a fresh 30-minute and two-hour episode, and due-only reminders.

The cleanup-generation appendix in the toolchain record is the 110-line addition from `dabc420f4c88e3a82269b737d974054945a4f05f`. Every added line is still present. That record already publishes the appendix SHA-256 `8dcc89b9fc999f3742b905182d134fecc3247f89d9d02d939ec287c91f192b45`. This report does not rewrite that file. Its statements describe the accepted public head, before the wait-user catalog lines below.

Each command-help file changes one sentence. The rest of each file stays the public wording. The sentence says a ready card or a `blocked(needs_human)` card is accepted, the human block converts to ready with the decision hold in one transaction, and a start claim, resumable agent, unresolved parent, other block, or active card stays put.

Each catalog keeps the eight accepted `acceptanceReviewWait` messages unchanged. The wait-user messages match the accepted wait-user source, including the widened `waitUser.onlyReady` text and `waitUser.activeStart`, `waitUser.alreadyWaiting`, and `waitUser.parentsWaiting`. Both catalogs have 2021 keys, the same key set, and sorted keys.

## Historical evidence, pre-merge parent only

These results describe the ready-only tree and then parent `cecaea4484e39ad98816af7edbb9b2bfc93840ca`. They do not describe the integrated head. That parent still exported a higher-priority projects root. The corrected harness used for the integrated results does not.

| Check on the pre-merge tree | Exit | Result |
| --- | ---: | --- |
| Anonymous wait-user file before the atomic hold | 1 | 33 tests: 19 passed, 14 failed, 0 skipped; 2146.341209 ms. The blocked card stayed blocked with `illegal_transition`. Two cases already matched the old ready path and passed. |
| Same file after the atomic hold | 0 | 33 passed, 0 failed, 0 skipped; 2082.449375 ms. Independent scheduler: 105 ticks, cold CLI pull-request cache, done pull-request parent, `blocked_from=ready`, autoStart true, `create=0`, no ready sample without the hold. |
| Typecheck on that hold, before the accepted-head merge | 0 | 442 files. |
| Concurrent CLI stress after accepting a lost unblock update | 0 | 20 runs, 0 failures, 1 lost-update conflict. The final ready state, one `wait_user` event, and `create=0` still held. |
| Targeted suites on the pre-merge parent | 0 | 505 passed, 0 failed, 0 skipped; 18470.141 ms. |

A twelve-gate run started on that parent was stopped after one plugin assertion failed: patrol did not treat an archived agent fixture as inside the checkout root, because the projects-root override masked the fixture. That run did not finish. It is not a gate result for either head.

## Integrated harness and results

Every integrated command used `env -i`. Home, Paseo, transcripts, board data, roles, agents, worktrees, the project fallback, npm cache and config, XDG directories, and temporary directories were under one disposable task directory. `KANBAN_PROJECTS_ROOT` was unset so it could not mask fixtures. `KANBAN_AGENTIC_ROOT` pointed at that task's project directory. `KANBAN_HOME` and `KANBAN_PROJECT_ROOT` identified this checkout. Git global and system configuration were disabled. Author and committer were the placeholder identity. The task denylist and existing hooks stayed active. Loopback was the unused `127.0.0.1:1` endpoint, and relay was off. No daemon, provider, credential, production database, or production config was read or copied. Both Fleet variables pointed at the fixed 370-file archive above.

`npm ci --include=dev --ignore-scripts --no-audit --no-fund` exited 0 and installed 362 packages. The lockfile was unchanged. Existing audit findings were left as they are.

On 2026-10-11, Node v24.21.0 and npm 12.1.0 produced these results on `14aebcd1c22639f44f5a1b843c9fac8d27e981a6`:

| Command | Exit | Result |
| --- | ---: | --- |
| Joint wait-user, schedule, review-wait, cleanup, operations, readonly, and actual-target command | 0 | 764 passed, 0 failed, 0 cancelled, 0 skipped; 22900.625792 ms. |
| Independent scheduler inside that joint run | 0 | 100 ticks, cold CLI pull-request cache, done pull-request parent, `blocked_from=ready`, autoStart true, `create=0`, no ready sample without the hold. The `gh` sentinel log was absent. |
| `npm run verify` | 0 | All 12 gates passed. |
| Typecheck inside verify | 0 | 448 files. |
| Script tests inside verify | 0 | 115 passed, 0 failed, 0 skipped; 3850.147166 ms. |
| CLI build inside verify | 0 | 4 standalone Node bundles. |
| Strict Paseo build inside verify | 0 | Actual `@getpaseo/server` 0.11.2; client 566,568 bytes; server 10,890,383 bytes. Not skipped. |
| Plugin regression inside verify | 0 | 2,849 passed, 0 failed, 0 skipped; 124345.397625 ms. |
| Isolated performance phase inside verify | 0 | 54 passed, 0 failed, 0 skipped; 6254.581917 ms. |
| Privacy scan inside verify | 0 | 574 files, 0 hits. |
| Next-commit identity inside verify | 0 | 2 identities, 0 problems. |
| History identity inside verify | 0 | 88 commits, 176 identities, 0 problems. |
| History leak scan inside verify | 0 | 90 commits, no leaks. |
| Contract check inside verify | 0 | `contract in sync (fleet-quota/v1, 9 file(s), checked against the source)`. |
| Shared gates inside verify | 0 | 28 shared files identical. Not an empty sibling. |
| Package whitelist inside verify | 0 | 259 files, 0 problems. |

The joint command ran `test/wait-user.test.ts`, `test/schedule.test.ts`, the acceptance review-wait, retry, board, and watch files, `test/review-target-dispatch.test.ts`, `test/dispatch-matrix.test.ts`, `test/routing.test.ts`, `test/ops-roles-matrix.test.ts`, `test/antigravity-boundary.test.ts`, `test/fleet-rules.test.ts`, `test/readonly-boundary.test.ts`, `test/readonly-p2.test.ts`, `test/identity.test.ts`, `test/leader-identity.test.ts`, `test/cli-guard.test.ts`, `test/cli.test.ts`, `test/profile-rules.test.ts`, `test/quota-protection.test.ts`, `test/i18n.test.ts`, `test/event-noise.test.ts`, and the cleanup generation, gone, auto-retry, races, stop, and query files.

## Report commit and limits

The following commit adds only this document. The twelve gates above were not run again on that commit. Its commit hooks still run the privacy scan, identity check, and leak scan, and `git diff --check` must be clean.

No live provider, ACP session, daemon, or phone panel was exercised. The accepted source's earlier offline compatibility failure, and its three skipped live checks, stay unlocated. This port does not claim to have found their cause.

No remote operation, push, pull request, merge to the default branch, tag, or release was made. Auto-start settings, bans, profiles, pools, quota, and pause state were not changed. The deployment freeze remains in force.
