# Single-plugin implementation and verification

This report covers implementation, not final release acceptance. The delivery
handoff fixes the final commit, tree, full diff and command exits. Original
reachable-history publication refusals remain in force. No source repository
ancestry was merged, shared history rewritten or remote ref changed.

## Frozen inputs and scope

The reviewed Kanban foundation is
`4ae9e02ca9d549fbd3346d638102ec13bbfadd4e`. Its approved public inputs and
original failures remain recorded in [MERGE-SOURCES](MERGE-SOURCES.md) and
[FOUNDATION-VALIDATION](FOUNDATION-VALIDATION.md). Historical statements in
those reports describe that earlier stage, not the integrated runtime.

Fleet content comes only from commit
`a383ec4a7406f221ed4ef3dea69a3e692008c1d6`, tree
`8ead44922b954be7adc10eda6990bba74cb0eeff`. The
[import map](merge-imports.json) records 294 selected public blobs and their
destination paths. Every selected blob and the fixed tree were rechecked.
Review corrections remove trailing whitespace and excess final blank lines from
selected destination files; the recorded source objects remain unchanged.
Private evidence, usage data, databases, credentials, unrelated branches and
permission experiments are excluded. The donor checkout was not modified.

Implementation slices are `21c5665e69389f31f4454168773f89a041a562a4`
(content import and fresh root), `bcc76de77083b7c5935b8e35779fd412deadcf82`
(application and service integration), `c2fdea23d78a75fef94c004de05b28aa1edba71c`
(actual mounting and effective gates), and
`784b064ffdd335eca9a9a7fd8a93ecef97f0cb9b` (strict default admission).
The later creation-boundary correction is recorded in the fixed-SHA delivery
handoff and the negative tests described below.

## Resulting boundaries

| Domain | Implemented behavior |
| --- | --- |
| Identity and package | One package/lock, `id=paseo-kanban`, display name Paseo Kanban, client/server entry and sidebar. Eight standalone Node command bundles. |
| UI | Board and workspace behavior retained; Fleet panels live under `client/fleet`. Combined settings, host theme and subscribed shared language. Cached Fleet language cannot override the application language. |
| Lifecycle | Fleet collectors and maintenance use a single start/dispose owner and Kanban's current host binding. Kanban owns dispatch. No second plugin or independent background CLI writer is started. |
| Policy | A deeply frozen, digest-validated `paseo-policy/v1` snapshot is injected in the server and atomically persisted for independent commands. Publication rechecks policy inputs under the admission lock; live revisions reject regression. |
| Default admission | Scheduler and CLI use immutable policy even with old explicit quota/matrix environment paths. Absent, invalid, changed or expired protected readings refuse new work. Revision/digest and protected quota are rechecked under the publication lock immediately before sending create, after async model/workspace operations. Refusal sends no provider request and produces no provider-failure alarm. Legacy transport is exercised only through explicit compatibility interfaces. |
| Review | Nonempty actual models compare after trim/lower normalization. Different models in one family are allowed; the same model across providers/families/settings is refused. Exact model branches cannot fall through to a family branch. |
| Existing restrictions | Pause, role restrictions, high-risk roster, capacity, pool protection and role-state read roots remain enforced. Hourly sampling, 62-minute display and 7-minute protection remain separate. |
| Storage | Server and commands share `KANBAN_DATA_DIR`, otherwise `PASEO_HOME/plugin-data/paseo-kanban`; Fleet owns `fleet/`. Nonempty retired storage overrides produce configuration errors. Compatibility metadata never expands the root. |
| Platform | Linux keychain/screen features explicitly report unavailable. Test markers prevent actual Mac probes. The known lack of a global failure stream has not been repaired or presented as repaired. |

The [manual transfer guide](MANUAL-MIGRATION.md) covers source identification,
stopping writers, user backups, individual file allowlists, conflicts and
user-run credential setup. Only anonymous fresh roots were tested. There is no
automatic migration, crash/rollback migration matrix or real-user migration proof.

## Environment and commands

Local checks used Darwin arm64, Node `v24.21.0`, npm `12.1.0`, the committed
lock and real gitleaks `8.30.1`. Dependencies were installed with `npm ci`.
The compiler/runtime was the separately installed public
`@getpaseo/server@0.11.0`, selected through `PASEO_SERVER_DIR`; compilation
did not use an application-bundle fallback. No local daily plugin was reloaded.

Anonymous test exports use the allowlisted environment and tools documented
in the foundation report. HOME, Paseo home, database, profiles, projects,
caches, builds and temporary files belong to the disposable test root. Python,
provider commands, a personal daemon and real platform probes are absent.
Release checks explicitly add gitleaks, the external local privacy policy and
the supported public compiler. No credentials or actual usage data are copied.

| Command | Recorded implementation result |
| --- | --- |
| `node scripts/typecheck.mjs` | Exit 0; 743 source files. |
| `npm test` | Exit 0; 154/154 script checks, no skipped/cancelled tests. |
| `npm run build` | Exit 0; eight standalone Node bundles. |
| `npm run test:plugin` | Pre-review candidate: exit 0, 3275/3275 regressions and separate 54/54 performance gates. The offline CLI positive and retired-override negative add two tests; final candidate exits/counts are in the handoff. No skipped/cancelled tests. |
| `KANBAN_LANGUAGE=zh-CN node --import tsx --import ./test/helpers/i18n-preload.ts --test test/compat-offline.test.ts test/compat.test.ts test/compat-timeout.test.ts test/compat-cli.test.ts` | Exit 0; 28/28 focused checks, zero skipped/cancelled tests. Real anonymous CLI ping/list succeed; both commands reject each of the three explicitly supplied retired overrides. |
| `KANBAN_COMPAT_OFFLINE=1 node --import tsx server/compat-cli.ts` | Exit 0; actual typecheck, script tests and CLI ping/list. Live runtime/configuration/daemon checks explicitly remain unverified in offline mode. |
| `node --import tsx --test test/native/single-plugin.integration.ts` | Exit 0; 2/2 actual public-runtime/compiled-client checks, no skips. Requires explicit `PASEO_SERVER_DIR`. |
| `node scripts/paseo-build-check.mjs --strict` | Exit 0 with the actual public Node compiler; exact candidate rerun belongs to the fixed-SHA handoff. |
| `node scripts/check-single-source.mjs contract` | Canonical manifest, IO/schema/path/model and immutable admission checks; no sibling comparison. |
| `node scripts/check-single-source.mjs gates` | One identity/lock and thirteen independently specified local gate commands. Eleven negative fixtures reject corrupted/absent inputs and substituted commands. |
| `node scripts/check-package-files.mjs --secret-scan` | Actual extracted npm artifact, 499 files: zero privacy findings and real secret scan exit 0. |
| `sh .githooks/pre-push </dev/null` | Exact commit export, locked install and all thirteen gates are rerun locally. Original reachable-history refusal is retained; this is a manual check, not a push. Final counts/exits are in the delivery handoff. |

The imported language test uses `process.execPath` for its fake CLI. Unicode,
reload logging and command-error assertions are preserved. Interpreter mentions
in executable-absence tests and recognition regexes are not interpreter dependencies.

## Actual isolated mounting

Registration/lifecycle and client mounting are distinct tests. The public
`PluginRuntime` forks the real plugin worker against an anonymous loopback
protocol server on an allocated port. It registers one plugin, both RPC domains
and one turn hook, refuses a duplicate service owner, then disposes the worker.
Natural child exit is zero; the interval ledger is empty and its MCP listener
is closed. No production port or provider is used.

The actual compiled client runs with the public React/React Native Web/query
providers and a DOM fixture. Reads cross the actual host RPC transport with
input/output validation. It mounts board/workspace and Fleet panels, checks
the single sidebar/top navigation, settings, language changes, cached-language
resistance, host light/dark theme and registration cleanup. This proves an
anonymous compiled mount, not a physical desktop/phone or live-provider first card.

## First failures and fixes

Original logs and individual assertions are retained in the temporary delivery
evidence; they are not replaced with later green runs. No assertion was skipped,
privacy rule widened or gate replaced with a vacuous comparison.

| First red | Cause and correction |
| --- | --- |
| Imported script/type/plugin suites | Reconciled the single lock and import namespaces, root/CLI fixtures, Unicode protocol paths and source ownership. Preserved executable modes in the anonymous export harness. The unfinished first imported plugin run is not reported as a pass. |
| Intermediate plugin run: 3267 tests, 104 failures | Old storage variables/directories, family-based reviewer assumptions, unbound/missing actual execution evidence and language fixtures were inconsistent with the approved boundaries. Converted anonymous inputs while retaining refusal, role/risk/capacity and event assertions. |
| Policy timestamp regression | A fixture reused an older timestamp after a newer publication. It now supplies a coherent dated revision and proves unresolved policy does not overwrite the last immutable bytes. Monotonic publication was retained. |
| Native worker/client attempts | Resolved the public worker's actual path and supplied the host's DOM/React Native providers. A real mount exposed language subscription and cached-language ownership defects; these were fixed in the application. |
| Default-admission full run: 3272 tests, 9 failures | Removed old environment-path bypasses. Converted diagnostics/default-tier/hint fixtures to explicit immutable policy; kept legacy reader tests explicit. Added successful and refused real default tick/CLI cases. Invalid/unreadable policy now reports unknown quota. Focused 109/109 and full 3272/3272 then passed. |
| Final creation boundary: 7 tests, 3 failures | Added negatives that change policy inputs, publish a closed revision during model lookup, or expire protection during workspace lookup. All initially sent a create request. Revision/digest and quota revalidation now occurs immediately at create under the shared publication lock; refused requests cannot enter lost-response recovery and do not emit provider-failure alarms. The negatives then passed. |
| Later full regression: 3275 tests, 1 failure | The new localized message keys were not alphabetically placed. Sorted both locale maps without relaxing the existing locale-order test. Final validation belongs to the exact delivery commit. |
| Review offline fixture: real ping/list each exit 1; new four-test suite has three failures | The fixture itself supplied retired Fleet/role root variables. It now uses only the unified storage override, resolves Fleet under `fleet/`, clears all three retired overrides in the isolated fixture, and retains HOME plus isolated agent/config roots. The real CLI still rejects each explicitly supplied retired override; the production storage guard is unchanged. Original command/test logs are retained. |
| Focused compatibility harness: 28 tests, 1 failure | The temporary focused command omitted the language environment required by the existing CLI locale assertion. Reran with the repository suite's `KANBAN_LANGUAGE=zh-CN`; 28/28 passed without changing that assertion or product behavior. |
| Review full-range `git diff --check`: exit 2 | Removed 29 trailing-whitespace/final-blank-line findings in 25 files. The formatting commit has zero diff bytes with end-of-line whitespace and blank lines ignored. The entire foundation-to-candidate range now passes, in addition to the working-tree check. |
| Actual foundation npm package: 112 findings | All findings were attributed: five generic task-list uses, SDK schedule/browser/config/message occurrences (4/2/3/34) and 64 unused validator occurrences. Kept pinned public SDKs external, minified local identifiers and used real namespace imports for static tree shaking. No global identifier/string/path allowance. |
| First integrated npm package: 382 findings | Generated module comments disclosed source locations through linked test dependencies. Removed generated comments through whitespace minification and omitted legal/source-map comments. Rechecked the actual extracted artifact and secrets; zero findings. |
| Foundation contract/shared gates | Reconciled the four schema/model/IO inputs into one hashed, nonempty canonical contract. Internal lock/identity/command and compatibility negatives replace the genuine cross-repository divergence. Legacy comparison utilities remain historical tools. |

## Remaining release work

Original approved reachable histories contain genuine prohibited card metadata;
earlier report versions remain reachable. A clean synthetic source-export history
is test setup and never clears those ancestors. Publication stays prohibited
until a separately approved safe public-source/history plan and precise outgoing
refs pass the full history, package and secret gates. No finding object locators,
message excerpts or private identities are reproduced here.

No supported real Linux host was available. Darwin compilation, platform
simulation and anonymous mounting do not establish Linux host support, minimum
Node execution, physical app/phone behavior, authenticated providers or a complete
real first card. No Fly instance or populated Mac storage was touched.

Next steps require independent high-risk review by a different actual model,
both project leads' evidence review, separate final acceptance and an approved
publication ref list. The standalone donor's README/archive and real deployment
remain later authorized operations. This implementation performs none of them.
