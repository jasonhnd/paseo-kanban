# Toolchain validation

The plugin source, English and Simplified Chinese catalogs, settings UI and regression suite are imported. The public defaults contain no vendor bans, model-generation limits, named-profile routing rules or quota-pool order. Restrictions remain available through explicit settings.

Public Fleet contract-source acceptance passed on 2026-10-09 against paseo-fleet `530d0020f099da0e8f977618fef2d5fd92d81031`. `npm run verify` with `FLEET_CONTRACT_SOURCE` and `PASEO_FLEET_SIBLING` set to that checkout passed all 12 gates. The fixture-based run below is historical and is not the acceptance method.

## Import provenance

The restored source revision is `d4442df17efb9775c64672cb84f1319c4bdc418e`.

| Source changes | Commits |
| --- | --- |
| Standalone esbuild commands and entry-guard fixes | `99ae33d`, `9fd0641`, `5df661f0b5218c11f97892935a839841b2cb6236` |
| English demo fixtures and catalog-based assertions | `e1cdbb5`, `e6849d7`, `6765667112bb1be1f3ccf286c0873438d21997d7` |
| Temporary source integration | `25be9392c500117ffda22b7e3e6e8537f017c75c`, then `43dd9a1def5118d9ce23742382bc627a4f3b4b5b` |

The CLI integration had no conflicts. The test integration conflicted only in `test/inject.test.ts`: the restored version's CLI-path normalization was retained with the English and catalog-based test assertions. The exported copy uses a generic installation placeholder for that budget. Old revisions of private documentation were not exported.

The exporter and shared gates were not changed. The source installation stayed clean at `56ef78a493b2edfe483866b94b61073462ad99a5`. The temporary source checkout was removed after export; its integration branch was retained.

## Changes to the imported acceptance tests

- Brief-file rejection tests use an injected temporary boundary, so negative fixtures remain isolated when HOME is under the system temp root. Production callers retain the existing temporary-directory policy. Data-directory tests accept disposable checkouts under temporary roots while still rejecting production paths and symlink bypasses.
- Union-merge tests supply their own `.gitattributes` fixture rather than relying on an unexported private root file.
- The archived desktop sync tool is outside the public plugin. Its test files now exercise the supported board reconciliation APIs, including idempotence, ambiguous archives and unchanged desktop-card, catalog and native-index bytes. No legacy desktop mutation tool was imported or published.
- Workflow metrics use the current production waiting-time query and the public query in `docs/WORKFLOW-METRICS.md`, instead of private design notes.
- Conformance tests follow the public bundling model: SDK inputs are development dependencies, generated commands require Node alone, and the manifest contains only supported fields. The installed host's actual manifest parser was checked independently.
- Former personal model, mode, pool and named-profile defaults were removed from production code and the example configuration. Explicit demo policies retain filter coverage; fresh-board tests prove vendor-neutral dispatch. English and Chinese descriptions now explain configured restrictions and external CI waits.

## Reproduction

Use supplied source paths and one disposable task directory. For public-source acceptance, set `FLEET_SOURCE` to the public Fleet checkout. It must contain a nonempty, self-consistent `fleet-quota/v1` contract manifest; an empty skeleton is insufficient. The historical fixture used for the local results below cannot satisfy public-source acceptance.

```sh
node "$EXPORT_TOOL" --plugin kanban --from "$LEGACY_KANBAN" --to "$PUBLIC_KANBAN" --contract-source "$FLEET_SOURCE"
cd "$PUBLIC_KANBAN"
npm ci --cache "$TASK_TMP/npm-cache"
export HOME="$TASK_TMP/home" TMPDIR="$TASK_TMP"
export PASEO_HOME="$TASK_TMP/paseo-home" KANBAN_DATA_DIR="$TASK_TMP/board-data"
export AFC_DATA_DIR="$TASK_TMP/fleet-data" ROLES_STATE_DIR="$TASK_TMP/roles-state"
export FLEET_PRIVATE_DENYLIST="$DENYLIST"
export PASEO_FLEET_SIBLING="$PUBLIC_FLEET" FLEET_CONTRACT_SOURCE="$FLEET_SOURCE"
export GIT_AUTHOR_NAME='paseo-fleet contributors' GIT_COMMITTER_NAME='paseo-fleet contributors'
export GIT_AUTHOR_EMAIL=noreply@example.invalid GIT_COMMITTER_EMAIL=noreply@example.invalid
npm run verify
npm test
npx tsc --noEmit
npm run build:check
```

The nine imported contract files came from a disposable copy of Fleet's original contract at source revision `40c0ff5286304d72862a8f26827c7d72a633fa50`. A manifest was written with the unchanged public sync tool, then Kanban synchronized from that fixture. The legacy Kanban vendored contract was not used. File hashes are recorded in `contract.manifest.json`.

## Local results

Validated on 2026-10-09 with Node 24.21.0 and npm 12.1.0.

| Command or check | Exit | Evidence |
| --- | ---: | --- |
| `npm ci` | 0 | 362 packages installed. |
| `npm run verify` with the nonempty contract fixture | 0 | All 12 gates passed: typecheck, script tests, CLI build, Paseo build, plugin tests, privacy, next identity, history identity, history leak scan, contract, shared gates and package whitelist. |
| `npm test` | 0 | 113 script tests passed, no failures or skips. |
| `npx tsc --noEmit` | 0 | No diagnostics; the verify typecheck covers 394 TypeScript files. |
| `npm run build:check` | 0 | Actual Paseo server compiler 0.11.1; client 530,672 bytes, server 10,761,514 bytes. |
| Plugin regression phase | 0 | 2,213 tests passed; no failures or skips. |
| Isolated performance phase | 0 | All 54 required tests passed; no skips. |
| `node scripts/check-private.mjs --all --quiet` | 0 | 491 files, zero private or generic-rule hits. |
| Identity and history leak checks | 0 | Placeholder identities; no history leaks. |
| Contract fixture check | 0 | Nine files match the Fleet fixture and its manifest. |
| Shared gates | 0 | 28 files byte-identical to public Fleet; unchanged from the delivery base. |
| Package whitelist | 0 | 241 files, zero problems; only six command files under `bin/`. |
| `npm pack --pack-destination "$TASK_TMP/artifacts" --json` | 0 | 2,262,395 packed bytes; 16,805,312 unpacked bytes. |
| Unpacked Node command smoke checks | 0 | Kanban, decisions, migration and missing-cwd help succeed without node_modules; `list --json` returns an empty disposable board. Unsupported missing-cwd arguments exit 2. |
| Installed host manifest parser | 0 | Reads and validates the public plugin manifest without loading the plugin. |
| Source installation status | 0 | Empty working-tree status; main remains at the source installation revision listed above. |

The fixture-based full verification completed after the example configuration and standalone dispatch assertions were corrected. The report-only follow-up was checked by the privacy, identity, leak and whitespace gates. All logs, packaged files and generated artifacts are kept in the disposable task directory; the board handoff retains the command results.

## Review follow-up

Revision `f14df6d44cdaa2cf04c4c0e45c2eb1be3c8aaf05` changes the English and Simplified Chinese compact-events help to reference `EXPIRING_EVENT_KINDS` in `server/compact-events.ts`, which is the public implementation's retention allow list. No private design document was imported. Two obsolete documentation paths were also removed from comments in routing and plugin conformance tests.

With the isolated environment above, the following checks were rerun on 2026-10-09:

| Command or check | Exit | Evidence |
| --- | ---: | --- |
| `KANBAN_LANGUAGE=zh-CN node --import tsx --import ./test/helpers/i18n-preload.ts --test test/i18n-protocol.test.ts test/cli-guard.test.ts test/inject.test.ts test/plugin-conformance.test.ts` | 0 | 38 tests passed, no failures or skips; includes protocol construction and help behavior. |
| Rendered `kanbanHelp()` in `en` and `zh-CN` | 0 | Both outputs reference the existing public file and exported constant, with no private design-document path. |
| `node scripts/check-private.mjs --all --quiet` | 0 | 491 files, zero hits. |
| `node scripts/compare-scripts.mjs` | 0 | All 28 shared files remain byte-identical. |
| `git diff --check` | 0 | No whitespace errors. |
| `FLEET_CONTRACT_SOURCE="$PUBLIC_FLEET" npm run contract:check` | 1 | The public Fleet manifest is still empty; all nine imported files are reported as extra. |

The full plugin suite and build checks were not rerun for this help and comment update. The unchanged nine contract files remain in place, and the public Fleet checkout, exporter and shared gates were not modified.

## Public Fleet contract source

Accepted on 2026-10-09 with Node v22.22.3 and npm 12.1.0. `FLEET_CONTRACT_SOURCE` and `PASEO_FLEET_SIBLING` both pointed at the public Fleet checkout `530d0020f099da0e8f977618fef2d5fd92d81031`. The other isolation variables still pointed at one disposable task directory. No contract file in this repository was edited for that run, and the Fleet checkout was not modified.

| Command or check | Exit | Evidence |
| --- | ---: | --- |
| `npm run verify` | 0 | All 12 gates passed: typecheck (405 files), script tests (113), CLI build, Paseo build, plugin tests, privacy, next identity, history identity, history leak scan, contract, shared gates and package whitelist. |
| Contract gate | 0 | `contract in sync (fleet-quota/v1, 9 file(s), checked against the source)`. |
| Plugin tests | 0 | 2,229 tests passed, then the isolated performance phase passed all 54 required tests. |
| `npm run build:check` | 0 | Paseo server compiler 0.11.1; client 552,466 bytes, server 10,792,575 bytes. |
| `node scripts/check-private.mjs --all --quiet` | 0 | 503 files, zero hits. |
| `node scripts/compare-scripts.mjs` | 0 | 28 shared files byte-identical. |
| Package whitelist | 0 | 246 files, zero problems. |
| `git diff --check` | 0 | No whitespace errors. |
| Source installation status | 0 | The legacy board working tree stayed empty. |

`zod` is a runtime dependency (`^4.4.3`), matching the public Fleet package. It is not listed in `devDependencies`. `npm pack` ran `prepack` (`npm run build`) and wrote `jasonhnd-paseo-kanban-0.1.0.tgz` (2,282,533 bytes, sha256 `fc6e8083c66a49ab751cdd3850b198efba4c903fe93656101d826ca3a9f28de6`). The packed `package.json` lists `zod` under `dependencies`. Installing that tarball with `npm install --omit=dev` added zod, and both `shared/leader-start.ts` and `shared/rpc.ts` resolved the same `node_modules/zod`. `z.string().parse("ok")` returned `ok`.

## Ported board behavior

Three reviewed behaviors were reimplemented on the public layout. Each commit names its source revision.

| Behavior | Commit | Source revision | What landed |
| --- | --- | --- | --- |
| Leader startup and session registration | `2e1d258` | `0a9ea89` | An environment marker selects the work-rules protocol. `kanban_supervise` registers the calling session before it can create cards. Supervisor permission approval stays with the host. |
| Role and review preview | `8848b2e` | `aadf0ae` | Settings shows a read-only preview. Profile projection reads only the top-level `agentProfiles` array. Same-family review still fails routing. |
| Node command launch | `9d6356b` | `1354954` | `.mjs` commands run under the current Node executable. Launchers forward SIGINT and SIGTERM. See `docs/COMMAND-LAUNCHERS.md`. |

The public protocol files and the existing thirty-minute and read-only database sentences stayed. Protocol files were not renamed, and no private validation note was imported. Catalog text uses the public `t` and `translate` functions, with the same keys in English and Simplified Chinese (1,974 keys). The compatibility file probe already honored an isolated home; the executable probe now searches `PATH`, `~/.local/bin` and the Node directory, using the `HOME` of the environment it was given. Bundling was not redone: `npm run build` still writes the four bundles, and the package engine remains Node `>=22.5`.

`4f747dd` moves zod into `dependencies`. `180b014` sorts the catalogs and updates the package check so zod is expected there.

No remote was added, no push or PR merge was performed, and no plugin was loaded or daemon restarted or contacted. Host compilation and manifest parsing ran locally without a daemon. Live plugin installation and panel behavior remain unverified. The dependency installation still reports 20 existing development-tool vulnerabilities (5 moderate, 15 high); no forced dependency upgrade or install-script policy change was made.

## Contract 1.2.0 and explicit dispatch order

Validated on 2026-10-10 with Node v24.21.0 and npm 12.1.0. Public Fleet main was `29b0ba6c21623bc5ac0dd64219b31beaa2fd9e66`. Commit `3dc3eee` synchronized the nine contract files and manifest with `node scripts/sync-contract.mjs --source "$PUBLIC_FLEET"`. The schema's `CONTRACT_VERSION` is `1.2.0`; the source manifest records `contract` and file hashes, without a separate `contractVersion` field. Neither the synchronized schema nor the shared sync script was edited by hand.

Commit `8516b73` ports the board changes from `26035ad`, `f30fac2` and `43fb299`. An item's integer `order` (1 through 1000) precedes candidates without that field and quota preferences; equal positions retain list order. Lists without explicit positions retain quota ranking. Pauses, dispatchable pools, role limits, different-family review, missing profiles, concurrency and supported effort checks still apply. Existing difficulty lists for reader, decision and batch retain precedence over wildcard lists, including empty difficulty lists.

The port retains the public board's explicit matrix-list semantics and vendor-neutral defaults. Fable appears only in a demo L4 review fixture, with no named-profile default added. The source's inherited ultra-depth test was adapted to the public board's generic `supportsEffort` guard. New parser errors use `t()` and matching English and Simplified Chinese catalog keys. The tests parse the contract before the board matrix so they also check that `order` survives the file boundary.

For reproduction, supply the public Fleet checkout as `PUBLIC_FLEET` and a new disposable directory as `TASK_TMP`. Keep `HOME` unchanged:

```sh
mkdir -p "$TASK_TMP" "$TASK_TMP/paseo-home" "$TASK_TMP/kanban-data" "$TASK_TMP/fleet-data" "$TASK_TMP/roles-state"
export TMPDIR="$TASK_TMP" KANBAN_TMP="$TASK_TMP"
export PASEO_HOME="$TASK_TMP/paseo-home" KANBAN_DATA_DIR="$TASK_TMP/kanban-data"
export AFC_DATA_DIR="$TASK_TMP/fleet-data" ROLES_STATE_DIR="$TASK_TMP/roles-state"
export FLEET_CONTRACT_SOURCE="$PUBLIC_FLEET" PASEO_FLEET_SIBLING="$PUBLIC_FLEET"
npm install --cache "$TASK_TMP/npm-cache"
node scripts/sync-contract.mjs --source "$PUBLIC_FLEET"
npm run contract:check
node --import tsx --input-type=module -e 'import assert from "node:assert/strict"; import { CONTRACT_VERSION } from "./shared/contract/schema.ts"; assert.equal(CONTRACT_VERSION, "1.2.0"); console.log(CONTRACT_VERSION);'
node --import tsx --test test/dispatch-order.test.ts
node --import tsx --import ./test/helpers/i18n-preload.ts --test test/dispatch-order.test.ts test/dispatch-tier-overrides.test.ts
npm test
npx tsc --noEmit
npm run build:check
node scripts/check-private.mjs --all --quiet
npm run verify
```

| Command or check | Exit | Evidence |
| --- | ---: | --- |
| `npm install` | 0 | 362 packages installed; dependency and lock files unchanged. |
| `node scripts/sync-contract.mjs --source "$PUBLIC_FLEET"` | 0 | Schema and contract I/O test updated; manifest regenerated by the sync script. |
| `npm run contract:check` with the public source | 0 | Nine files match both manifests and the source. |
| `CONTRACT_VERSION` assertion | 0 | `1.2.0`. |
| English dispatch-order tests | 0 | 9 passed, no failures or skips. |
| Simplified Chinese dispatch-order and difficulty-list tests | 0 | 26 passed, no failures or skips. |
| `npm test` | 0 | 113 script tests passed, no failures or skips. |
| `npx tsc --noEmit` | 0 | No diagnostics. |
| `npm run build:check` | 0 | Local Paseo compiler 0.11.2; client 552,634 bytes, server 10,794,018 bytes. |
| `node scripts/check-private.mjs --all --quiet` | 0 | 505 files, zero hits. |
| `npm run verify` with both public Fleet variables | 0 | All 12 gates passed; typecheck covered 407 files. |
| Plugin regression and isolated performance phases | 0 | 2,256 regression tests and 54 performance tests passed, no failures or skips. |
| Shared gates | 0 | All 28 files byte-identical to public Fleet; scripts, hooks and workflows unchanged. |
| Package whitelist | 0 | 246 files, zero problems. |

The public Fleet checkout and the running legacy board checkout were not modified. No push, remote addition, merge, daemon connection, reload or restart occurred. Live panel behavior remains unverified because this acceptance uses isolated tests and local compilation. Installation reported the same 20 development-tool vulnerabilities (5 moderate, 15 high); dependency upgrades were outside this port's scope. Logs and generated build artifacts are held in the disposable task directory; command results are retained in the board handoff.

## Read grants, conditional launcher and write provenance

Validated on 2026-10-10 against public Fleet `29b0ba6c21623bc5ac0dd64219b31beaa2fd9e66`. Four independent commits preserve the public layout and bilingual text:

| Commit | Source revisions | Behavior |
| --- | --- | --- |
| `9d4d00b` | `3bde540..6794c2a` | Registered leaders grant/revoke project reads; whitelisted card and event views stay read-only. The schema upgrades idempotently, and submission, completion and archive expire grants. |
| `2b8428d` | `f9b9592`, `68e22eb` | Quiet completion also clears grants. Registration and file checks run before the write lock; changed cards cause a conflict. |
| `132c0ca` | `ebee4a3`, `92326d5` | The conditional Codex shell launcher preserves arguments and rejects recursive aliases. `docs/CODEX-WRAPPER.md` gives generic installed-package configuration paths. |
| `5449974` | `d59eb8c..63ec5ff` | Identity-only write audits cover MCP and CLI calls, preserve token-free native-session identity, and expire after 30 days. Completion adds no provenance or format comments/events. See `docs/WRITE-PROVENANCE.md`. |

The existing inject test already normalizes installation paths and was retained. The public compatibility probe respected isolated homes; its missing explicit offline mode was added with translated output and tests that forbid live dependencies. The public native-session implementation already used read-only identity resolution, so that implementation was retained while the CLI audit entry was adapted. Final source behavior was imported directly; intermediate completion reminders were excluded. An invalid JSON handoff string can leave only the source's optional stored note, without changing the summary or emitting a board comment/event.

The public `BOARD_AGENT_ENV` wire name equals a legacy repository name in the private denylist. The wrapper preserves the exact runtime variable via shell line continuation, matching the public code's existing name-assembly convention; tests use the exported constant. No scan rule or denylist was weakened. The only root manifest change adds `bin/codex-kanban-launch` to the explicit npm `files` whitelist, as required for installed use. No shared gate, hook, workflow or contract file changed.

Reproduce with `HOME` unchanged, `TASK_TMP` pointing at a new disposable directory, and `PUBLIC_FLEET` pointing at the public Fleet source. Set `TMPDIR`, `KANBAN_TMP`, `PASEO_HOME`, `KANBAN_DATA_DIR`, `AFC_DATA_DIR` and `ROLES_STATE_DIR` under that directory, and set `FLEET_CONTRACT_SOURCE` and `PASEO_FLEET_SIBLING` to `PUBLIC_FLEET`. `KANBAN_COMPAT_OFFLINE=1` selects offline compatibility checks. Install dependencies with `npm install --cache "$TASK_TMP/npm-cache"`, then build commands with `npm run build` before tests that invoke `bin/kanban`.

The following results apply to code revision `5449974`. Each command exited 0; all test totals have zero failures and zero skips.

| Command or check | Exit | Evidence |
| --- | ---: | --- |
| `npm install --cache "$TASK_TMP/npm-cache"` | 0 | 362 packages installed; dependency and lock contents unchanged. |
| `node --import tsx --import ./test/helpers/i18n-preload.ts --test test/read-grants.test.ts test/compat-offline.test.ts test/db-migration.test.ts test/compat.test.ts test/inject.test.ts` at the first port | 0 | 50 tests passed. |
| `node --import tsx --import ./test/helpers/i18n-preload.ts --test test/read-grants.test.ts test/db-migration.test.ts` after the second port | 0 | 22 tests passed, including lock and quiet-handoff races. |
| `node --import tsx --test test/codex-kanban-launch.test.ts` | 0 | 9 tests passed using a fake executable. |
| `node --import tsx --import ./test/helpers/i18n-preload.ts --test test/write-source.test.ts test/compact-events.test.ts test/compact-retention.test.ts test/read-grants.test.ts test/db-migration.test.ts` | 0 | 75 tests passed, including loopback HTTP, CLI subprocesses, synthetic credential preservation, audit retention and old schemas. |
| `node --import tsx --import ./test/helpers/i18n-preload.ts --test test/ported-features-i18n.test.ts` | 0 | Both languages render new help, tool descriptions, errors and retention text. |
| `npm test` | 0 | 113 script tests passed. |
| `npx tsc --noEmit` | 0 | No diagnostics. |
| `npm run build:check` | 0 | Local Paseo compiler 0.11.2; client 556,865 bytes, server 10,808,487 bytes. |
| `node scripts/check-private.mjs --all --quiet` | 0 | 515 files, zero hits before this documentation update. |
| `npm run verify` | 0 | All 12 gates passed; typecheck covered 414 files. Plugin regressions: 2,317 passed. Isolated performance phase: 54 passed. |
| Locale key-set comparison | 0 | Main catalogs: 1,993 keys each. Tool catalogs: 33 keys each. Identical key sets. |
| Contract and shared gates | 0 | Nine contract files match public Fleet; all 28 gate files remain identical. |
| Package whitelist | 0 | 249 package files, zero problems. |
| `npm pack --pack-destination "$TASK_TMP/artifacts" --json` | 0 | 2,299,342 packed bytes. The wrapper is present with mode 0755. |
| Unpacked wrapper smoke checks | 0 | A fake Codex receives exact original argv when unmarked and both memory overrides when marked. |
| `git diff --check` and both board checkout statuses | 0 | No whitespace errors; working-tree status empty after commits. |

This report update is checked by the privacy, identity, leak and whitespace gates. Generated bundles, package archives and logs are kept in the disposable task directory. No push, remote addition, merge, live daemon connection, reload or restart occurred, and no credential or provider configuration was read or changed. The source board and public Fleet checkouts stayed untouched. Live panel and provider-memory behavior remain unverified. Identity-only audits cannot distinguish same-identity foreground/background calls and are not tamper-resistant. Installation reported the existing 20 development-tool vulnerabilities (5 moderate, 15 high); dependency upgrades were outside scope.


## Quota protection consumer port

Validated on 2026-10-10 with Node v24.21.0 and npm 12.1.0. The unchanged sync script copied the contract from public Fleet revision `a97ad65933f11987143ed6c6105841ef2cbffc11`: only three optional schema fields and the manifest hash changed. The consumption behavior comes from `9ddf47b`, using the contract represented by `920ab2e`. The default-Chinese override in `e0ff33e` was replaced by the public board's existing `t()` and server language settings. No separate quota translation helper or TypeScript configuration change was needed.

Protected stale pools stop even without a usage reading; explicitly unprotected stale pools stay open. Legacy snapshots retain the existing stop lines. Fresh pools follow `dispatchable`, except protected readings with missing or reached expiry stop. A configured quota export closes named pools absent from that export; profiles without pools stay usable. Tests also exercise selection of a healthy alternative through the actual router. English and Simplified Chinese quota messages share the existing catalog keys and follow the board setting; the existing system-locale fallback is retained.

`HOME` was unchanged. `PASEO_HOME`, `KANBAN_DATA_DIR`, `AFC_DATA_DIR`, `ROLES_STATE_DIR` and `TMPDIR` were set to newly created disposable directories. `FLEET_CONTRACT_SOURCE` and `PASEO_FLEET_SIBLING` pointed at the public Fleet checkout. No real daemon was connected, reloaded or restarted, and neither source repository was modified.

| Command or check | Exit | Evidence |
| --- | ---: | --- |
| `npm ci --cache "$TASK_TMP/npm-cache"` | 0 | 362 packages installed. |
| `node scripts/sync-contract.mjs --source "$PUBLIC_FLEET"` | 0 | Nine contract files synchronized; only `shared/contract/schema.ts` and the manifest changed. |
| `npm run contract:check` | 0 | `contract in sync (fleet-quota/v1, 9 file(s), checked against the source)`. |
| `node --import tsx --import ./test/helpers/i18n-preload.ts --test test/quota-protection.test.ts test/pools.test.ts test/i18n.test.ts` | 0 | 38 tests passed, including nine quota tests, both board languages, catalog key and placeholder parity. |
| `npm test` | 0 | All 113 script tests passed, no skips. |
| `npx tsc --noEmit` | 0 | No diagnostics. |
| `npm run build:check` | 0 | Actual Paseo compiler 0.11.2: client 557,474 bytes, server 10,810,318 bytes. |
| `node scripts/check-private.mjs --all --quiet` | 0 | 516 files scanned, zero hits. |
| `npm run verify` | 0 | All 12 gates passed; typecheck covered 415 files. Plugin regression: 2,326 passed; isolated performance: all 54 passed; no failures or skips. |
| Shared gates and package whitelist (within verify) | 0 | 28 gate files byte-identical to public Fleet; 249 package files, zero problems. |
| `git diff --check` | 0 | No whitespace errors. |
| Working-tree checks | 0 | Kanban delivery tree and public Fleet were clean; the legacy source tree was also clean. |

The standalone command guide now links to `bin/codex-kanban-launch` and `docs/CODEX-WRAPPER.md`. Full verification ran after the code and launcher-guide commits. The validation-record update was subsequently checked by the privacy, identity, leak and whitespace gates. Generated command bundles were moved into the disposable task directory after verification; logs also stay there. The shared gates were not changed. This port has no pending implementation work; independent review remains required.

## Managed Git tag installation and update

Validated on 2026-10-10 with Paseo 0.11.2, Node v24.21.0 and npm 12.1.0.
The code revisions are `090d85a` (source preparation), `9840d2b` (installation
guide) and `349dc5d` (symlink-safe executable entry). Public Fleet was
`4078ba8fea152e809e9bc7444b788637345d1d5a`.

An isolated daemon used an unused loopback port, a separate home and separate
board, Fleet, roles and temporary directories. Its relay and providers were
disabled. The final clean home enabled plugins and declared an empty
`daemon.agentProfiles` array. All test tags were created only in a disposable
clone. The original `e77632f` tag failed installation with exit 1:

```text
Request failed: Build failed with 1 error:
error: Could not resolve type dependency "@getpaseo/client" imported by <candidate>/checkout/server/reclaim-note.ts
```

The path above is redacted; the daemon reported compiler plugin
`paseo-plugin-server-runtime-boundary`. The installed manifest parser and the
[official reference](https://paseo.sh/docs/plugins/reference#cli-reference)
confirm that `build` is the preparation field. `server/prepare.mjs` explicitly
installs compiler inputs with lifecycle scripts disabled, builds commands from
Git sources and validates prepacked npm commands when repository scripts are
absent. `@getpaseo/client` remains a development dependency, and zod remains a
production dependency. Type-only imports still require dependency resolution.
See [Git installation](GIT-INSTALL.md) for repeatable installation commands.

The parallel Fleet fix `cf60786` also uses manifest `build` and disables npm
lifecycle scripts, but installs production dependencies and prebundles its
daemon client to remove server SDK imports. This board retains its existing SDK
imports and installs development compiler inputs as well. It therefore requires
more dependencies during preparation. This avoids changing root entries or
shared build gates; neither source Fleet checkout was edited.

Reproduce with a disposable `TASK_TMP`, a temporary Git clone at `TEST_REPOSITORY`
and the public Fleet checkout at `PUBLIC_FLEET`. Write the isolated config before
starting its daemon. Set `PASEO_URL` to its selected WebSocket endpoint and keep
the board, Fleet, roles and temporary directories under `TASK_TMP`.

```sh
npm install --cache "$TASK_TMP/npm-cache"
paseo --home "$TASK_TMP/paseo" daemon run
# In a second terminal with the same isolated environment:
paseo --home "$TASK_TMP/paseo" plugin install "file://$TEST_REPOSITORY" --ref "$INSTALL_TAG" --json
paseo --home "$TASK_TMP/paseo" plugin ls paseo-kanban --json
paseo --home "$TASK_TMP/paseo" plugin logs paseo-kanban --json
node "$INSTALLED_PLUGIN/bin/paseo-kanban.mjs" --help
node "$INSTALLED_PLUGIN/bin/paseo-kanban.mjs" list --json
paseo --home "$TASK_TMP/paseo" plugin update paseo-kanban --ref "$UPDATE_TAG" --json
FLEET_CONTRACT_SOURCE="$PUBLIC_FLEET" PASEO_FLEET_SIBLING="$PUBLIC_FLEET" npm run verify
paseo --home "$TASK_TMP/paseo" daemon stop
```

| Command or check | Exit | Evidence |
| --- | ---: | --- |
| Original tag install | 1 | Exact dependency-resolution failure above. |
| Final code tag install (`349dc5d`) | 0 | Source `git`; installed revision matches tag; status `running`. |
| Installed `--help` and `list --json` | 0 | Help printed; list returned `{"projects":[],"tasks":[]}`. |
| Explicit tag update | 0 | `outcome: updated`, status `running`, revision changed. |
| Final activation logs | 0 | Plugin ready, MCP listening and scheduler bound; no plugin errors. Only the host Node `DEP0176` deprecation warning remains. |
| Actual unpacked npm preparation | 0 | No repository scripts present; dependencies installed and all prepacked commands retained. |
| Unpacked npm host compile and CLI smoke | 0 | Paseo compiler passed; help and empty list both passed. |
| `npm run verify` at `349dc5d` | 0 | All 12 gates passed; typecheck covered 416 files. |
| Script, plugin and isolated performance suites | 0 | 115, 2,332 and 54 passed respectively; zero failures or skips. |
| Contract and shared gates | 0 | Nine contract files match public Fleet; 28 shared gate files identical. |
| Privacy and package whitelist | 0 | 519 files scanned, zero hits; 250 packed files, zero problems. |

The first isolated startup lacked the profile array and logged the existing
configuration-shape error; the final clean installation explicitly used an
empty array and had no plugin errors. This validation does not exercise card
dispatch, provider logins or the client panel. No production daemon connection,
reload or restart, credential read, public tag, push, remote addition or merge
occurred. The isolated daemon was stopped and its data removed. Generated
bundles were moved out of the delivery checkout after verification. The final
documentation update was checked by the privacy, identity, leak and whitespace
gates, and the delivery checkout was clean.

## Live host theme port

Validated on 2026-10-10 with Node v24.21.0, npm 12.1.0 and Paseo 0.11.2.
Commit `2b687b9` ports the theme adapter, preference retirement and regression
tests from source revisions `4e0bd2a`, `28963fa` and `bebae95`. The live verification
method follows `29a1d29`. Public Fleet was
`25b86d4dad609d8a3ccbfea5365292d8131394f2`; both `FLEET_CONTRACT_SOURCE` and
`PASEO_FLEET_SIBLING` pointed to that public checkout. No shared gate, contract
file, workflow, dependency or lockfile was changed.

The public English fixtures, catalog assertions and existing board/settings
structure were retained. New test text is English, and English/Simplified Chinese
catalogs have the same 1,992 keys. The theme guide is English with a translation
under `docs/zh-CN/`. Private validation notes and preference-storage inventories
were not imported; preference migration is explained in [THEME](THEME.md).

For reproduction, use a disposable `TASK_TMP`, keep HOME unchanged and set the
isolation variables before running commands:

```sh
export TMPDIR="$TASK_TMP" KANBAN_TMP="$TASK_TMP"
export PASEO_HOME="$TASK_TMP/paseo" KANBAN_PASEO_HOME="$TASK_TMP/paseo"
export KANBAN_PASEO_CONFIG="$PASEO_HOME/config.json"
export KANBAN_DATA_DIR="$TASK_TMP/kanban" AFC_DATA_DIR="$TASK_TMP/afc"
export AFC_LEGACY_DATA_DIR="$TASK_TMP/afc-legacy" ROLES_STATE_DIR="$TASK_TMP/roles"
export PASEO_LISTEN=127.0.0.1:16825 PASEO_URL=ws://127.0.0.1:16825/ws
export PASEO_RELAY_ENABLED=false PASEO_WEB_UI_ENABLED=true
export PASEO_WEB_UI_DIST_DIR="$WEB_UI_DIST"
export KANBAN_COMPAT_OFFLINE=1
export FLEET_CONTRACT_SOURCE="$PUBLIC_FLEET" PASEO_FLEET_SIBLING="$PUBLIC_FLEET"
unset PASEO_AGENT_ID KANBAN_TOKEN PASEO_TOKEN PASEO_HOST PASEO_PASSWORD
npm ci --cache "$TASK_TMP/npm-cache"
npm test
npx tsc --noEmit
npm run build:check
node scripts/check-private.mjs --all --quiet
npm run verify
```

Before daemon startup, write a disposable v1 config with `pluginsEnabled: true`,
an empty **`daemon.agentProfiles`** array, disabled `daemon.relay` and the isolated
listener. Profiles and relay are nested under `daemon`, not at the root; an
initial root-level attempt was rejected by the strict host parser. The board demo
config has auto-start disabled and global concurrency zero. Register a disposable
project and local workspace, install the candidate directory with
`paseo --home "$PASEO_HOME" plugin install "$CANDIDATE"`, and use only its Web UI.
No coding agent is started. Browser profile, sockets, configuration, logs and
screenshots also stay under `TASK_TMP`.

| Command or check | Exit | Evidence |
| --- | ---: | --- |
| `npm ci` | 0 | Locked dependencies installed; no dependency change. |
| Targeted theme, mounted UI and preference tests | 0 | 60 passed, zero failures or skips. |
| `npm test` | 0 | 115 script tests passed, zero failures or skips. |
| `npx tsc --noEmit` | 0 | No diagnostics. |
| `npm run build:check` | 0 | Actual host compiler 0.11.2; client 558,910 bytes, server 10,810,363 bytes. |
| `node scripts/check-private.mjs --all --quiet` | 0 | 546 files, zero hits. |
| `npm run verify` | 0 | All 12 gates passed; typecheck covered 423 files. |
| Plugin regression and isolated performance phases | 0 | 2,359 and 54 passed respectively; zero failures or skips. |
| Public Fleet contract and shared gates | 0 | Nine contract files match the source; all 28 shared files identical. |
| Package whitelist | 0 | 251 files, zero problems. |
| English/Simplified Chinese key comparison | 0 | 1,992 matching keys. |
| Browser runtime errors | 0 | Error collection empty. |
| Disposable daemon shutdown | 0 | Stop completed; foreground process exited 0; isolated port no longer listening. |

The real Web UI used an independent browser profile at 1600 by 1100. All ten final
screenshots were opened and checked. The project views are actual workspace Board
panels, not global-page filters. The demo's missing-leader notices reflect its
intentional lack of agents and registered leaders.

| Screenshot | Observation |
| --- | --- |
| `light-global.png` | Light page, cards, columns, green accent and semantic badges; main and secondary text readable. |
| `light-project.png` | Actual project panel follows Light; column borders and leader notice visible. |
| `light-drawer.png` | Brief, handling guide, command text and status messages readable; covered background intentionally faded. |
| `light-settings.png` | Raised settings card and descriptions readable; font controls remain, color-mode control absent. |
| `dark-global.png` | Midnight blue-purple surfaces and blue accent follow the host; text and status badges readable. |
| `dark-project.png` | Project panel follows Midnight; cards, borders and leader notice visible. |
| `dark-drawer.png` | Commands, copy links and warning/danger text readable on Midnight. |
| `dark-settings.png` | Midnight settings surface and descriptions readable; no color-mode control. |
| `switch-before-light.png` | Open project panel with System resolving light; four visible cards. |
| `switch-after-dark.png` | Same route and document, System resolving dark; four cards immediately recolored without reopening. |

The live-switch proof records `sameUrl: true`, `sameDocument: true`,
`panelVisible: true`, four visible cards and `sameCardNode: false`. The sampled card
background changed from `rgb(250, 250, 250)` to `rgb(30, 33, 32)`. A separate switch
confirmed the host closes an open drawer. Mounted prop-update tests retain the
drawer only when the same plugin instance survives; they do not claim host state
preservation. This is visual verification, not a complete accessibility audit.

Screenshots and full logs remain in the disposable task directory, with hashes
and observations retained in the work handoff. The browser and disposable daemon
were stopped; generated CLI bundles were moved into the task artifact directory.
No production daemon connection, credential read, HOME change, push, remote
addition, merge or publication was performed. Physical native devices and the
production desktop session remain untested. Unknown host color syntax retains a
host endpoint, with no guaranteed mixing/opacity adjustment.

## Periodic cleanup absence reconciliation

The reviewed source revision `5f9ecee9e5006fa2a0cd5427220ee91397dde134`
contains `2cf8ef1` (periodic reconciliation), `e5514ae` (resource safety
regressions) and `abc28f3` (bounded active ownership checks). All four ported
server files are byte-identical to that final source revision. The public
regression uses nine generated `DEMO` cards and synthetic workspace IDs;
the only test differences are this fixture replacement and its test title.
No private validation/status documents were imported.

| Source behavior | Public location | Port adaptation |
| --- | --- | --- |
| Read-only absence checks for owned workspaces, agents, directories and branches | `server/cleanup-gone.ts` | None; uses existing public ownership/path helpers. Directory and branch obligations remain separate, or both required for a composite worktree step. |
| Historical finished/stopped/backoff records still receive absence checks | `server/cleanup.ts` | None; checks run inside the card lock, before finished/retry filtering, through the existing startup and periodic sweep. |
| Bounded work and late-read protection | `server/cleanup.ts`, `server/cleanup-gone.ts` | None; one lazy complete workspace inventory per round, at most 32 resource targets per card, rotating targets, existing 100-card sweep chunks and 30-second round budget. |
| Immutable failure history with traceable success | `server/archive-book.ts` | None; append `ok: true`, `reason: "gone"`, `reconciled` and `failureRowId`. A later agent gone success also clears its restore-stop alert. |
| Complete workspace inventory, including valid pagination termination | `server/paseo.ts` | None; missing/invalid pages, undefined/empty cursors and repeated cursors remain unknown. Only explicit null ends the inventory. |
| Thirteen absence, unknown, ownership, mixed-resource, race and idempotence regressions | `test/cleanup-gone.test.ts` | Anonymous generated fixtures; existing public test runner discovers the file without changes. |
| Public compilation and local gates | Existing `scripts/verify.mjs` | Retain the public CLI bundling and strict Paseo build gate. No shared scripts, hooks, workflows, dependencies or contract files changed. No new user-facing strings or locale keys are needed. |

Confirmed absence resolves only that resource's failure. Present resources retain
their original retry/stop rules. Timeouts, disconnected clients, unreadable
directories/repositories and incomplete ownership reads do not establish
absence. The new checks do not delete or archive resources, resume cards, clear
unrelated card errors or wake leaders. A restart does not duplicate a resolved
failure's gone event.

For a large history, the initial sweep advances by at most 100 finished cards
per scheduler round; each card checks at most 32 targets. Later targets rotate
on subsequent sweeps. Defaults remain a 60-second scheduler tick and a ten-minute
interval between sweeps. Unknown reads, an occupied card lock or incomplete
ownership can delay convergence.

Validation used Node v24.21.0, npm 12.1.0 and the actual Paseo 0.11.2 compiler.
Before installation or tests, `TMPDIR`, `KANBAN_DATA_DIR`, `AFC_DATA_DIR`,
`AFC_LEGACY_DATA_DIR`, `ROLES_STATE_DIR`, `PASEO_HOME`, `KANBAN_AGENTS_DIR`
and `KANBAN_WORKTREES_ROOT` pointed into one disposable task directory.
`KANBAN_HOME` and `KANBAN_PROJECT_ROOT` must identify the candidate source
checkout for source probes; use `KANBAN_AGENTIC_ROOT` for isolated project
fixtures, allowing individual tests to replace that legacy override. Do not
set a higher-priority `KANBAN_PROJECTS_ROOT` that masks those fixtures.
Direct regression runs also need `KANBAN_LANGUAGE=zh-CN` for child commands;
the full public runner already sets it. Both `FLEET_CONTRACT_SOURCE` and
`PASEO_FLEET_SIBLING` identified the public Fleet checkout.

The implementation is in `0a06389`, the anonymous full regression in `ed71832`,
and the earlier reproduction in `c22678b`. The final local gate run on
2026-10-10 checked `ed71832`; the following report-only commit changes no
runtime or test code.

| Command/check | Exit | Result |
| --- | ---: | --- |
| `npm ci` | 0 | 362 locked packages installed; no dependency or lockfile changes. |
| New nine-card regression before the fix | 1 | Reproduced the stale audit failures; ordinary reconciliation read zero inventories instead of one. |
| `node --import tsx --import ./test/helpers/i18n-preload.ts --test test/cleanup-gone.test.ts test/cleanup-queries.test.ts test/cleanup-stop.test.ts test/cleanup-races.test.ts test/cleanup-auto-retry.test.ts test/paseo-api.test.ts test/paseo-shape.test.ts` | 0 | 79 passed, zero failed/skipped. |
| `KANBAN_LANGUAGE=en node --import tsx --test test/cleanup-gone.test.ts` | 0 | All 13 new regressions passed in English. |
| `npm run verify` | 0 | All 12 gates passed; typecheck covered 425 files, script tests 115, plugin regressions 2,372 and isolated performance tests 54; zero failures/skips. |
| Strict Paseo build within verify | 0 | Actual server compiler 0.11.2; client 558,910 bytes and server 10,819,523 bytes. |
| Public contract/shared gates within verify | 0 | Nine contract files match public Fleet; all 28 shared gate files identical. |
| Privacy/identity/history/pack gates within verify | 0 | 548 files scanned with zero hits; placeholder identities and no history leaks; 252 package files, zero problems. |
| Source parity | 0 | Four server files byte-identical; test differences limited to fixture anonymization and title. |
| Disposable daemon RPC, CLI audit and timer observation | 0 | Nine failures resolved, original failure history retained, no cleanup alerts or repeated events/wakes. |

The first full run passed 11 gates but failed ten plugin tests because its
source-root overrides identified empty fixture directories and its modern
project-root override masked legacy test overrides. Correcting the environment
required no source changes. A direct follow-up also exposed the missing child
language override; its affected 24 tests then passed.

An independent loopback daemon used an isolated home, empty profiles, disabled
auto-start and zero concurrency. It loaded the candidate at startup and resolved
all nine demo workspace failures without resume. Actual `kanban.board`,
`kanban.history` and `kanban.task` RPCs reported nine archived cards, nine gone
events and no cleanup alerts. CLI audit reported `ok: true` and zero cards.
Only read-only SQLite and scheduler timestamp reads observed the following
timer tick, from 10:43:20 to 10:44:20 UTC on 2026-10-10: event count 54, gone
count 9, original failure count 9 and wake count 0 all stayed unchanged.
The disposable daemon was stopped, its foreground process exited 0 and its
listener closed. This checks the server/RPC data consumed by the panel;
the native/browser panel was not mounted for this change.

Known source-review limits remain: a prior directory-wide purge may cause one
additional bounded agent gone event; deliberately retained branches continue
to receive read-only checks on later sweeps. Empty workspace cursors are now
rejected by the shared workspace parser. No production resources were queried
or modified, and no push, merge, publication or production reload occurred.
Installation reported the existing 20 development-tool vulnerabilities
(5 moderate, 15 high); dependencies and install-script policy were not changed.

## Fixed-revision Fleet and Kanban joint verification

Validated on 2026-10-10 with Node v24.21.0, npm 12.1.0 and gitleaks 8.30.1.
The tested Kanban code revision was
`c4a56f55a5b33f686452559c293ed53ee0c139fc`; the actual public Fleet source and
sibling revision was `cd9caf5b08b7f2bb5f2c661d5481736d516c75f6`.
Both disposable checkouts retained the real history reachable from those
revisions using local Git objects only. Their initial working-tree status was
empty, and neither checkout had a remote. Repository configuration,
credentials, private directories and production data were not copied.
This result describes those fixed code snapshots; the subsequent documentation
commit is report-only and is not the tested code revision.

Before dependency installation or tests, a fresh environment isolated `HOME`,
`PASEO_HOME`, `AFC_TRANSCRIPT_HOME`, `KANBAN_DATA_DIR`, `AFC_DATA_DIR`,
`AFC_LEGACY_DATA_DIR`, `ROLES_STATE_DIR`, `KANBAN_AGENTS_DIR`,
`KANBAN_WORKTREES_ROOT`, `KANBAN_AGENTIC_ROOT`, temporary files and npm cache
under one disposable task directory. `KANBAN_HOME` and `KANBAN_PROJECT_ROOT`
identified the fixed Kanban checkout. `KANBAN_PROJECTS_ROOT` was empty so it
could not mask test fixtures. Git global/system configuration and npm user
configuration were isolated; the local Git identity used placeholder values.
The disposable privacy denylist contained the local account identifier only.
`PASEO_LISTEN` was `127.0.0.1:18839`, relay was disabled and
`KANBAN_COMPAT_OFFLINE=1`. No `GH_TOKEN`, `GITHUB_TOKEN`, `NPM_TOKEN` or
`PASEO_URL` was supplied. No real provider or daemon was started or contacted.

With `FIXED_KANBAN` and `FIXED_FLEET` identifying those checkouts and the
isolation above already in place, the commands were:

```sh
(cd "$FIXED_KANBAN" && npm ci --cache "$TASK_TMP/npm-cache")
(cd "$FIXED_FLEET" && npm ci --cache "$TASK_TMP/npm-cache")
export FLEET_CONTRACT_SOURCE="$FIXED_FLEET"
export PASEO_FLEET_SIBLING="$FIXED_FLEET"
(cd "$FIXED_KANBAN" && npm run verify)
```

Both locked installs exited 0: Kanban installed 362 packages and Fleet 420.
The existing npm install-script policy blocked esbuild and fsevents scripts;
it was not changed. No lockfile changed and no audit fix ran. The actual
installed Paseo 0.11.2 compiler was used without a daemon. `npm run verify`
exited 0 after executing all twelve existing gates once:

| Gate command | Exit | Evidence |
| --- | ---: | --- |
| `node scripts/typecheck.mjs` | 0 | 431 TypeScript files; no diagnostics. |
| `node --test scripts/*.test.mjs` (all 11 sorted test files) | 0 | 115 passed; 0 failed, skipped, cancelled or todo. |
| `node scripts/build-cli.mjs` | 0 | Four actual standalone Node bundles: cli 10,187,651 bytes; local-decisions 695,293; migrate 615,604; check-missing-cwd 684,574. |
| `node scripts/paseo-build-check.mjs --strict` | 0 | Actual server compiler 0.11.2: client 560,885 bytes, server 10,843,616 bytes; no skipped compilation. |
| `node scripts/test-plugin.mjs` | 0 | Regression phase: 2,544 passed; isolated performance phase: 54 passed. Each phase had 0 failed, skipped, cancelled or todo. |
| `node scripts/check-private.mjs --all --quiet` | 0 | 555 files, 0 hits. |
| `node scripts/check-identity.mjs` | 0 | Two next-commit identities, 0 problems. |
| `node scripts/check-identity.mjs --history` | 0 | 60 commits / 120 identities, 0 problems. |
| `gitleaks git --redact --no-banner .` | 0 | Real history: 60 commits, no leaks. |
| `node scripts/sync-contract.mjs --check` | 0 | Nine `fleet-quota/v1` files checked against the real fixed Fleet source. |
| `node scripts/compare-scripts.mjs` | 0 | 28 actual shared files byte-identical to the real fixed Fleet sibling; no empty-comparison fallback. |
| `node scripts/check-package-files.mjs` | 0 | Original package whitelist: 254 files, 0 problems. |

The fixed snapshots remained clean after validation. Full logs, exact expanded
commands and artifact hashes remain in the disposable evidence directory for
review. The dedicated port had no listener; no persistent daemon or background
validation process remained. Shared scripts, hooks, workflows, contracts,
dependencies and package rules were unchanged. No push, remote operation,
PR, merge, tag, release, production reload or enablement occurred.

This verifies shared gates and local compilation, not real ACP quota, model,
permission events, lifecycle or enablement. Existing freezes and cross-family
review requirements remain. Fleet's source-only Antigravity checks require a
complete source checkout and development dependencies; the npm tarball is not
supported for those checks. The earlier unpacked `MODULE_NOT_FOUND` evidence
remains applicable. The previously accepted Fleet probes were not repeated,
and the reviewed concurrent-quota behavior was not changed.

## Operations wildcard matrix routing

This local port fixes automatic dispatch for `ops_vercel`, `ops_cloudflare`,
`ops_github` and `ops_notion`. A valid matrix previously ignored these known
role keys, leaving the consumer with no candidates. The parser and router now
use each role's `roles.<role>["*"]` list, including its order, effort and
paused flag. Synthetic scheduler runs select the corresponding profile and
record matrix effort `medium` rather than profile default `high`, with
`auto_accept` disabled.

The reviewed source is `61279c7da739f041e509f4150bd6249e5b856137`, relative to
`8c26535ca678a3c3951c66dfa1a59607e169ed3b`. The public base is
`c4a56f55a5b33f686452559c293ed53ee0c139fc`; the public Fleet companion used
for contract and shared-gate checks is
`cd9caf5b08b7f2bb5f2c661d5481736d516c75f6`. Only the fixed reviewed source
was read for the port; newer source changes and private status, handoff,
configuration and operational data were not imported.

| File | Reviewed source comparison and public adaptation |
| --- | --- |
| `server/matrix.ts` | Wildcard role constants, type guards, widened `star` type and ops parsing match the reviewed source. Removing the existing public ordinary-role `starTiers` support and localized `parseItem` formatting makes the file byte-identical to that source. Those public differences remain: ordinary roles may use explicit difficulty lists; ops consume only `*`. |
| `server/routing.ts` | The new automatic ops profile-pause check and missing-quota check are byte-identical source blocks. Wildcard consumption retains ordinary public tier precedence. Existing review/actual-family checks, Google boundaries, reservation, quota, stale rules and explicit-profile routing are unchanged from the public base. The source's separate review-target infrastructure is outside this port; no unrelated routing design was copied. |
| `shared/locales/en.json`, `shared/locales/zh-CN.json` | Three new ops routing messages in each catalog match the source. |
| `test/dispatch-matrix.test.ts` | The unknown-role fixture now uses `custodian`, with an explicit exclusion assertion, matching the source test change. |
| `test/ops-roles-matrix.test.ts` | Eleven source regressions use generated English demo names, synthetic pool identifiers, an arbitrary timestamp and disposable local paths. Three public regressions additionally cover all four roles' negative conditions, preserved ordinary tier lists and the source's explicit-profile exception. Provider interfaces are mocked. |
| `docs/TOOLCHAIN-VALIDATION.md` | This English anonymous evidence was written independently; source operational documents were not copied. |

A missing or empty `*` stays inside the matrix and waits; an ops difficulty
list is not a fallback. Unknown role keys remain ignored. Malformed known ops
objects, lists and items are rejected by parsing. Existing whole-file missing
or invalid-matrix fallback behavior remains unchanged. Matrix pause marks,
profile existence, usable quota readings, pool capacity, effort support and
existing family/permission checks are not relaxed. The original five ordinary
roles retain their existing lists and fallback rules, including the public
ordinary-role difficulty behavior.

Automatic ops matrix dispatch additionally waits when the quota snapshot is
`missing`, the named profile has `paused: true`, or a `personal` profile has
`pausedCandidateFor` equal to the ops role. These two new gates apply only to
automatic ops matrix selection. As in the reviewed source, explicit profile
selection uses the existing routing path and does not apply them. Ordinary
roles retain their existing missing-export fallback for non-GPT pools. Ops
agents still receive the existing executor protocol text. These are retained
source limitations, not evidence of a broader operational rollout.

Validation uses Node v24.21.0, npm 12.1.0 and the actual Paseo 0.11.2 compiler.
The disposable harness starts with `env -i`. Before installing dependencies or
running checks, `HOME`, `PASEO_HOME`, `AFC_TRANSCRIPT_HOME`, `KANBAN_DATA_DIR`,
`AFC_DATA_DIR`, `AFC_LEGACY_DATA_DIR`, `ROLES_STATE_DIR`, `KANBAN_AGENTS_DIR`,
`KANBAN_WORKTREES_ROOT`, `KANBAN_AGENTIC_ROOT`, `TMPDIR`, XDG directories and
the npm cache point into one task directory. `PASEO_URL` points to an unused
loopback endpoint. `KANBAN_HOME` and `KANBAN_PROJECT_ROOT` identify the
candidate source checkout for existing source probes; no higher-priority
`KANBAN_PROJECTS_ROOT` overrides the suites' generated project fixtures.
The existing runner retains its private per-run temporary directory, locale
preload and separate regression/performance phases. The new ops file selects
English for its assertions. The private denylist stays outside the repository,
with hooks enabled and placeholder author/committer identity. No credential,
production profile, project, card, database or provider service was queried.

Within that clean harness, the commands are:

```sh
npm ci
node --import tsx --import ./test/helpers/i18n-preload.ts --test \
  test/ops-roles-matrix.test.ts test/dispatch-matrix.test.ts \
  test/routing.test.ts test/antigravity-boundary.test.ts \
  test/readonly-boundary.test.ts test/i18n.test.ts test/i18n-load.test.ts \
  test/i18n-protocol.test.ts test/ported-features-i18n.test.ts
FLEET_CONTRACT_SOURCE="$PUBLIC_FLEET" PASEO_FLEET_SIBLING="$PUBLIC_FLEET" npm run verify
git diff --check
```

The anonymous counterexample is committed in `1b7d27a`, implementation in
`8071de7`, public boundary regressions in `47815f8`, and the final typed
assertion in `681415d`. The complete local gate run on 2026-10-11 checks
`681415d`; the later evidence-only commit changes no runtime or test code.

| Command/check | Exit | Result |
| --- | ---: | --- |
| `npm ci` | 0 | 362 locked packages installed; dependencies and lockfile unchanged. |
| New source regressions on the old public implementation | 1 | One ordinary-role regression passed and ten ops regressions failed, including absent parsed lists and automatic dispatch with no matrix candidates; zero skips. |
| Final targeted command above | 0 | 299 passed, zero failures or skips; includes all fourteen new ops regressions. |
| `npm run typecheck` | 0 | 432 files checked. |
| `npm run verify` | 0 | All twelve gates passed; 115 script tests, 2,558 plugin regressions and 54 isolated performance tests, zero failures or skips. |
| Strict Paseo build inside verify | 0 | Actual host compiler 0.11.2; client 561,534 bytes, server 10,845,546 bytes; no compiler skip. CLI build produced all four standalone bundles. |
| Contract/shared gates inside verify | 0 | Nine contract files match the public Fleet companion; all 28 shared gate files are identical. |
| Privacy/identity/history/pack gates inside verify | 0 | 556 files scanned with zero privacy hits, next/history placeholder identities accepted, no history leaks; 254 package files, zero problems. |
| File-by-file source and existing boundary comparison | 0 | New source blocks match; only existing ordinary-tier and localization differences remain in matrix parsing. Thirteen existing routing/boundary functions are unchanged from the public base. |
| `git diff --check` | 0 | No whitespace errors. |

The first complete run passed eleven gates, including all 115 script tests,
2,558 plugin regressions and 54 isolated performance tests, but failed the
new malformed-input assertion's TypeScript overload. The assertion now uses
an explicit expected-error pattern; runtime behavior was not changed. Final
verification results above refer to the complete rerun, not the failed run.
Installation retains the existing 20 development-tool audit findings
(5 moderate, 15 high); dependency and install-script policies were not changed.

This is local parser/router/mock-scheduler evidence. No actual provider
request, production lifecycle, authenticated operations, desktop mounting or
live dispatch recovery was validated. No daemon was started or reloaded,
and no production configuration, quota, profile or data was changed. No push,
remote operation, pull request, merge, tag, release or publication occurred.
Deployment and real lifecycle validation remain separate, unverified steps.

### Documentation conflict reconciliation

On 2026-10-11 the operations port was mechanically rebased onto
`d3dcdd4e2187f43a2c4e8b6830fb7fa36f51d595`. That main revision adds only the
73-line fixed-revision joint-verification appendix. The conflict resolution
preserves that appendix and the 106-line operations appendix above byte for
byte, including their separate dates, tested revisions, original failures
and unverified behavior. Their SHA-256 values, including the leading blank
line of each addition, are respectively
`285a4c3b49478052d0b59f07a8586edee5eddc7075b0efeced665c123d9b3e93` and
`4eacee82f84acb9670f175849b7eb0908a98d064bf4af58c108b41b0c36eaf1e`.

The tested rebased revision is
`e8b864e84ceffc094f1cbb67a6bdae19796626e1`. Every tracked file except this
document is byte-identical to the previously reviewed
`3916cabb27f7ff28030687f15f70057fad3c3742`. Git range comparison confirms
that all four implementation and test commits have identical patches; only
the documentation commit's context moved. No dependencies, lockfile, shared
scripts, hooks, workflows or contract files changed. The existing locked
installation and the same isolated `env -i` harness described above were used.
The actual public Fleet companion remains
`cd9caf5b08b7f2bb5f2c661d5481736d516c75f6`.

| Rebased local command/check | Exit | Result |
| --- | ---: | --- |
| Targeted command from the operations section above | 0 | 299 passed; zero failures, skips, cancellations or todo. |
| `npm run typecheck` | 0 | 432 files; no diagnostics. |
| `npm run build:check` | 0 | Actual Paseo 0.11.2 compiler: client 561,534 bytes, server 10,845,546 bytes; strict mode, no skip. |
| `npm run build` | 0 | All four standalone CLI bundles built locally. |
| `npm run contract:check` | 0 | Nine contract files match the actual public Fleet source. |
| `npm run shared:check` | 0 | All 28 actual shared files are byte-identical. |
| `npm run pack:check` after the CLI build | 0 | 254 package files, zero problems. |
| Fixed-source comparison and rebase equivalence | 0 | Reviewed operations source blocks and existing public boundaries match; both historical appendices remain intact. |
| `npm run scan`, `npm run identity`, `gitleaks git --redact --no-banner .` | 0 | No privacy hits, invalid identities or history leaks. |
| `git diff main HEAD --check` | 0 | No whitespace errors. |

This is a scoped rebase check. The earlier twelve-gate run still applies to
`681415d`; it was not repeated or represented as a complete gate run on the
rebased revision. This later report-only addition changes no code or tests;
privacy, identity, history and whitespace checks are repeated after recording
it. Generated bundles and logs remain in the disposable task directory.
Independent cross-family review and lead acceptance remain separate steps.
Real provider requests, production lifecycle and deployment remain unverified;
existing deployment freezes remain in force. No production data or
configuration changed, and no remote operation, push, PR, merge, tag, reload,
publication or enablement occurred.

## Cleanup generations after rebuilding a temporary workspace

This local port prevents an earlier `cleanup_finished` or successful cleanup
step from hiding a successfully rebuilt target. Ordinary periodic cleanup
retires the new workspace, directory, local branch and agents without a
manual recovery request. Old history is retained. Doctor reads current-generation
completion, branch retention and failures. An independent `resume-cleanup`
CLI records a target-bound durable request; `requested`, `requestId` and
`execution: "periodic"` describe that request and explicitly say cleanup has
not run. A `periodic_candidate` acknowledgement is not physical completion.
The existing stopped-step recovery entry, backoff and ownership checks remain.

The fixed reviewed source is `c0ad0651a504b758f4216d8cb0538a79cb439048`.
Generation implementation `ec2f541ddee9a66c033223d5e544e4187686d1c0` is relative
to `b4dd320d5c312e0c2c3c41f1b4eb001d9e166de3`; diagnostic/request implementation
`3911ab7ea99c3bfe14c8d86bda87046885bfc16b` is relative to
`093eb6b529ebdca426c304e3e7ef582a40fb3722`, with the final request fixes from
`781931401f5adc604f82d38910336eff8a5f4386`. Public base/main is
`50e70d418911eefc272bbfc9f8da22ce0318d81b`. The red reproduction is `421f719`,
implementation `8c5cfe8`, and final integrated runtime/test revision
`3e8384cb2538ac192252d4e27dbdb051e695466e`. Results below apply to that final
integration; this subsequent appendix changes only documentation.

Seven implementation files and both anonymous test files are byte-identical
to the fixed source. The three other implementation files retain only existing
public differences: CLI import order, doctor localization, and dispatch queue
holds from a waiting-rule change not yet landed publicly. Eight existing
public boundary files are byte-identical to the public base, including
readonly policy/worktree, review-target, profiles, routing/matrix and gone
reconciliation. No shared script, hook, workflow, contract, dependency,
package whitelist or scan rule changed. The new English and Chinese request
catalog entries are sorted and match the reviewed source.

Every experiment, including the locked install, ran in a disposable `env -i`
allowlist. HOME, Paseo, transcripts, board/Fleet/roles data, synthetic agents,
projects/worktrees, npm/XDG caches and TMP were isolated. Git identity and
configuration were synthetic; npm user configuration was isolated. The
privacy denylist remained outside the repository and included the local
account and private card/project terms. A temporary Node preload redirected
legacy hardcoded temporary-directory prefixes into the same task directory;
no assertions, thresholds or repository runner were changed. The unused
loopback endpoint was `127.0.0.1:1`; offline/relay-disabled settings were used.
No production tokens, credentials, history, database, provider, daemon or
relay were read, copied or contacted.

Both `FLEET_CONTRACT_SOURCE` and `PASEO_FLEET_SIBLING` pointed to the actual
clean public Fleet checkout `cd9caf5b08b7f2bb5f2c661d5481736d516c75f6`.
The twelve-gate command was `npm run verify` in the isolated environment;
contract and shared comparisons used that fixed checkout, without a fixture
or empty-comparison fallback.

On 2026-10-11, Node 24.21.0 / npm 12.1.0 produced these local results:

| Command/check | Exit | Result |
| --- | ---: | --- |
| `npm ci` | 0 | 362 locked packages; lockfile unchanged. Existing 20 development audit findings and blocked esbuild/fsevents install-script policy were retained. |
| Generation test on the old public implementation | 1 | 0 passed / 2 failed / 0 skipped: second-generation directory remained; actual recovery handler returned zero. The anonymous red fixture was committed first. |
| Same two tests after the implementation port | 0 | 2 passed / 0 failed or skipped. |
| Old CLI/doctor replay with the three diagnostic/request tests | 1 | 0 passed / 3 failed / 0 skipped: current failure hidden, old retained-branch severity reused, persistent request rows `0 != 1`. Both entry files were restored byte-for-byte in `finally`; baseline and restored CLI builds exited 0; the restoration harness exited 0. |
| `node --import tsx --import ./test/helpers/i18n-preload.ts --test test/cleanup-rework-generation.test.ts` | 0 | Final 19 passed, 0 failed/cancelled/skipped; 14.83 seconds. An earlier 19-case run before the final source-tail match also passed; it is not substituted for final validation. |
| Combined targeted command below | 0 | 806 passed, 0 failed/cancelled/skipped; 102.35 seconds. |
| `npm run typecheck` | 0 | Final 441 files, no diagnostics; also passed before the final request-tail port and inside final verify. |
| `npm run build:check` | 0 | Actual strict host compiler 0.11.2: client 564,403 / server 10,869,196 bytes; no compilation skip; repeated inside final verify. |
| `npm run verify` | 0 | All twelve gates on the final integrated runtime/test revision. 115 script tests; 2,627 plugin regressions (126.09 seconds), then 54 isolated performance tests (6.29 seconds). All have 0 failures/cancellations/skips. Four standalone CLI bundles built. |
| Privacy, next identity, history identity and gitleaks inside verify | 0 | 567 files, 0 privacy hits; 2 next identities and 77 commits / 154 history identities accepted; gitleaks scanned 80 commits, no leaks. |
| Contract and shared gates inside verify | 0 | Nine real-source contract files match; 28 actual shared files byte-identical. |
| Original package whitelist inside verify | 0 | 257 files, 0 problems. |
| Source/boundary comparison and `git diff --check` | 0 | Exact source blocks and unchanged public safety/gate files; no whitespace errors. |

```sh
node --import tsx --import ./test/helpers/i18n-preload.ts --test \
  test/cleanup*.test.ts test/archive-deadline.test.ts test/auto-archive.test.ts \
  test/rework-*.test.ts test/temp-workspace.test.ts test/workspace-recreate.test.ts \
  test/worktree-gc.test.ts test/doctor*.test.ts test/audit.test.ts \
  test/cli-guard.test.ts test/identity.test.ts test/leader-identity.test.ts \
  test/profile-rules.test.ts test/review-target-dispatch.test.ts \
  test/antigravity-boundary.test.ts test/readonly-boundary.test.ts \
  test/readonly-p2.test.ts test/ops-roles-matrix.test.ts \
  test/dispatch-matrix.test.ts test/routing.test.ts
```

The nineteen cases cover ordinary second/third-generation cleanup without
resume, SQLite reopening, actual accept/recreate handlers, unchanged history,
old late replies, timeout/rebuild fencing, suspended-create mutual exclusion,
failed/no rebuild, unknown inventory, shared/active targets, current stop/backoff,
readonly gone convergence, six batch queries for 401 cards, and 100+5 bounded
request observation. Real temporary fs/Git/SQLite and independent bundled CLI
processes are used; workspace inventory/archive and provider operations are
synthetic. Candidate acknowledgement, unknown-read retention and physical
cleanup are asserted separately. Cross-family, Google authorization and
readonly routing regressions exercise actual decision code with synthetic
profiles, not authenticated providers.

The reviewed source's first full run included one unknown-workspace guard
failure whose cause was not independently established; subsequent source
runs passed. Its offline report skipped live CLI/plugin state, user
configuration/history and daemon websocket fields. These historical failures
and skips are retained as limits, not presented as this port's results. This
port's final complete run had no failed or skipped gates.

Only this appendix is added after the full run. Post-document privacy,
identity, history leak and whitespace checks are repeated; full tests/builds
are not represented as rerun on the documentation commit. Generated bundles,
logs and replay backups are retained only in the disposable evidence directory.
Independent high-risk cross-family review and lead acceptance remain pending.
Live daemon/RPC mounting, provider/ACP lifecycle, crash recovery of a remote
archive after the existing claim TTL, clean-host operation and production
recovery remain unverified. Existing deployment freezes remain in force.
No remote operation, push, PR, merge, tag, release, reload or enablement occurred.

## Independent review waits and acceptance reminders

This section retains the original review-wait port's pre-integration evidence
on `50e70d418911eefc272bbfc9f8da22ce0318d81b` through
`e5c1d4c37c7e0ef744b18a7b5172534c9eac0992`. Those results do not cover the
cleanup-generation port above. The new integration base is
`dabc420f4c88e3a82269b737d974054945a4f05f`, including cleanup runtime
`3e8384cb2538ac192252d4e27dbdb051e695466e`. Joint results on the new
integrated revision are recorded separately below. The cleanup appendix is
preserved byte for byte; the initial isolation deviation below is retained.

This local port recognizes a current, structurally linked independent review
as handling an acceptance card. A normal quota or capacity queue, a live
reviewer run, or a proven scheduler retry suppresses the repeat acceptance
reminder, prerequisite absence reminder and false leader-unresponsive marker.
The existing initial delivery and real blocked-review notifications remain.
Board and detail handlers project the waiting badge and explanation through
the existing RPC fields, without writing wait events during reads.

The accepted source snapshot is
`1de23dcaa3320d983a3c656a6cf6b1c03f8b33fb`. The two source deliveries were
independently reviewed by a different model family with high-risk review and
accepted before this port: `63c7e34f6fd79b05588f04032d25357a8b73abf4` and
`5f2a95f0073fd7e1dbab97ef6088fa02e0b1de0b`. The latter's consumer and retry
handler tests match the accepted snapshot byte for byte. The public integration
base is `dabc420f4c88e3a82269b737d974054945a4f05f`; the tested joint public
revision is `fde6890f4cb5c304164cdd93b657d72f707d4ad8`, with runtime/tests
at `e5bf81a45e9295f1e5e31770f76766e9fd05da13`. The earlier base and tested
revision above describe only historical pre-integration results. The real public Fleet companion
is fixed to `cd9caf5b08b7f2bb5f2c661d5481736d516c75f6`, exported from that
Git object into the task's temporary directory. Both contract environment
variables select that snapshot; no local copy was weakened to pass comparison.

| Files | Fixed-source comparison and public adaptation |
| --- | --- |
| `server/acceptance-review-wait.ts`, `server/queue-hold.ts` | Byte-identical to the accepted source. Current acceptance round, project, role, review target, status-entry event, own-role run and producer facts are checked together. |
| `server/acceptance-watch.ts`, `server/dependency-attention.ts`, `server/leader-activity.ts`, `server/board-cards.ts` | Byte-identical to the accepted source. Persisted wait edges and fresh reminder episodes, due-only mixed batches, async rereads, scan guards and conditional tag updates are retained. |
| `server/schedule.ts` | Byte-identical after mapping source family-rule helper names to the existing public `familyDispatchBlock` and `poolUnseenReason` names. Structured capacity holds are added; ordinary routing policy is retained. |
| `server/routing.ts` | Only the `concurrencyWait` fact and its automatic/explicit capacity classifications are imported. Existing family rules, actual-target independent review, ordinary `starTiers`, operations routing, Google boundaries and public defaults remain. |
| `server/dispatch.ts` | Only the structured queue-hold import and hold recording block are imported from the waiting-rule source. The accepted public base supplies the intact cleanup-generation tracking and archive fencing. |
| `shared/locales/en.json`, `shared/locales/zh-CN.json` | Eight review-wait messages in each catalog match the source. All existing public messages, including cleanup request messages from the accepted base, are retained. |
| `test/acceptance-review-wait.test.ts`, `test/acceptance-review-retry.test.ts`, `test/acceptance-review-board.test.ts`, `test/acceptance-review-board-worker.ts` | Source lifecycle, producer, negative-evidence, SQL and registered-handler cases use anonymous fixtures. Private card labels are removed; English assertions and catalog-based Chinese assertions replace raw Chinese source literals. |
| `test/review-target-dispatch.test.ts`, `test/acceptance-watch.test.ts`, `test/event-noise.test.ts` | Necessary capacity, reopen, mixed-batch, due-only and one-hold-per-current-entry expectations are ported while retaining existing public fixtures and policy. |
| `docs/TOOLCHAIN-VALIDATION.md` | This English evidence was written independently. Private status and operational reports are not imported. |

A function-level comparison found 140 unchanged existing functions across
routing, dispatch, schedule, board projection and leader activity outside the
intended changed functions. Configuration, matrix parser, failure and login
producers, limits, counters, SDK schema, client and server entries, dependencies,
package whitelist, shared scripts, hooks, workflows and contract paths are
unchanged from the public base.

The consumer recognizes quota/rate-limit requeue transitions and counted
transient/other retries only when the current state, preceding started event,
closed own-role run, agent binding, kind, count, maximum and cooldown facts
match the producer. Login retry requires an integer attempt within the
existing two reopenings and the closed transient run's end time plus the
current retry interval to reproduce the cooldown exactly. A live current run
or proven healthy prerequisite is not invalidated by historical failure
counts. An actual blocked/rework/needs-human/decision state takes precedence
when multiple reviews exist. Bare comments, titles, wrong project/role/target,
old rounds, old holds and incomplete retry evidence do not permanently swallow
reminders. Review completion or invalidation starts a fresh durable 30-minute
and two-hour reminder episode; old exhausted repeat budgets do not consume it.

The corrected final harness uses an `env -i` whitelist.
`HOME`, `PASEO_HOME`, `AFC_TRANSCRIPT_HOME`, board/cockpit/legacy data, roles,
agents, worktrees, projects, npm cache and config, XDG directories and all
temporary paths, including the separate `KANBAN_TMP_ROOT`, point inside one task directory. Autostart is disabled and
`PASEO_URL` selects an unused loopback endpoint, checked by listen/close.
No production credentials, configuration, databases, quota snapshots or
conversation history are inherited or copied. The private denylist is external,
identities are placeholders and commit hooks run without changing shared gates.

The complete gate run uses an exact source snapshot and full public commit
objects in that same temporary directory, initialized without a remote.
It carries the tested HEAD and placeholder repository identity. The locked
installed development dependencies are reused; CLI bundles and strict compiler
artifacts are generated only in the temporary directory. The real shared-gate
and contract comparisons use the separately fixed Fleet snapshot. Node is
v24.21.0, npm is 12.1.0 and the actual Paseo compiler is 0.11.2. The existing
regression/performance phase separation, locale preload and private test
temporary directories are unchanged.

Within the clean harness, the principal commands are:

```sh
npm ci
node --import tsx --import ./test/helpers/i18n-preload.ts --test \
  test/acceptance-review-wait.test.ts test/acceptance-review-retry.test.ts
FLEET_CONTRACT_SOURCE="$PUBLIC_FLEET" PASEO_FLEET_SIBLING="$PUBLIC_FLEET" npm run verify
node --import tsx --import ./test/helpers/i18n-preload.ts --test \
  test/wake-*.test.ts test/board-*.test.ts test/i18n*.test.ts \
  test/acceptance-*.test.ts test/dependency-attention.test.ts \
  test/schedule.test.ts test/routing.test.ts test/event-noise.test.ts \
  test/antigravity-boundary.test.ts test/review-target-dispatch.test.ts \
  test/read*-*.test.ts test/plugin-conformance.test.ts \
  test/ops-roles-matrix.test.ts test/dispatch-matrix.test.ts
git diff --check
```

The anonymous red counterexamples are committed in `5511f28`, implementation
in `f301433`, complete lifecycle/public regressions in `fdf7a43`, and the
explicit fixture temporary-root correction in `769751e`.
The later evidence-only commit changes no code or tests.

| Historical command/check before cleanup integration | Exit | Result |
| --- | ---: | --- |
| `npm ci` | 0 | 362 locked development packages installed; lockfile unchanged. |
| Red command on fixed `5511f28` | 1 | Eleven actual counterexamples failed, zero passes/skips; original 1,104.762292 ms and corrected-isolation repeat 1,088.838 ms. Normal queues caused repeat/prerequisite wakes and false two-hour markers before the fix. |
| First green command after `f301433` | 0 | Eleven passed, zero failures/skips; 790.44125 ms. |
| Final targeted command above | 0 | 816 passed, zero failures/skips; 40,421.445792 ms. Includes original safety, read-only, actual-target/family, Google, operations and ordinary-tier cases. |
| `npm run verify` | 0 | All twelve gates passed: 115 script tests, 2,814 plugin regressions and 54 separate performance cases; zero failures, skips, cancellations or todo. Regression phase 142,160.0415 ms. |
| Strict Paseo build inside verify | 0 | Actual compiler 0.11.2; client 565,203 bytes and server 10,884,301 bytes; no compiler skip. All four standalone CLI bundles built. |
| Contract/shared gates inside verify | 0 | Nine contract files checked against the real fixed Fleet source; all 28 shared gate files identical in both repositories. |
| Type/privacy/identity/history/package gates inside verify | 0 | 444 typed files, 571 scanned files with zero privacy hits; next commit and all 78 public commits have permitted identities, history gitleaks passed; 258 package files, zero problems. |
| Fixed-source and existing-boundary comparison | 0 | Six production files exactly match source, schedule matches with existing public helper names, all intended added blocks match; 140 other existing functions and protected paths unchanged. |
| Query and registered-handler checks | 0 | Thirty dependency reviews use two SQL statements and 500 archived historical reviewers use one; registered board/detail RPC schemas convey both locales without writes or provider calls. |
| `git diff --check` | 0 | No whitespace errors. |

Final isolated performance measurements: 1,000 agents, 600 JSONL files and
three 50 MB files produce cached 21.9 ms, cold 83.4 ms, sweep 23.0 ms and CLI
489.0 ms. The existing I/O calibration is 1.06x, giving unchanged effective
cached/cold limits of 53.1/212.4 ms; measurements also stay below nominal
50/200 ms. Tick/cleanup steady scans are 19.9/19.2/18.3 ms and startup sweep
is 3,088.0 ms. At 292 cards, board projection is 17.3 ms and detail 0.8 ms.
CPU and I/O gates execute without skips; no threshold was changed.

The first core expansion returned exit 1: 295 tests, 294 passed, one failed,
zero skips (7,161.42425 ms). A batch text replacement had accidentally negated
a second `young` assertion whose card was already due; `fdf7a43` restores it.
No product behavior was changed for that fixture mistake. The first broader
run returned exit 1: 816 tests, 815 passed, one failed, zero skips
(30,346.066708 ms). The public bundled-CLI check had no generated bundles in
the source worktree. The final checks run in the temporary snapshot after
the required CLI build; neither the check nor its expectation is weakened.

Isolation deviation, retained explicitly: the initial clean whitelist omitted
the separate `KANBAN_TMP_ROOT`, although HOME, data and TMPDIR were isolated.
Synthetic launcher calls could therefore rewrite anonymous fixture generation
markers under the default shared temporary root. Read-only metadata inspection
observed 158 modified marker-only directories since harness creation, all of
which predated this task. Their original marker generations cannot be restored;
unknown prior fixture directories were not deleted or moved. No marker content,
production credentials, configuration, database or conversation was read.
The wrapper now sets the separate root inside the task, and `769751e` also
sets it directly in the new retry fixture. The initial complete gate run on
`fdf7a43` returned exit 0 with all twelve gates and 2,814 regressions plus 54
performance cases passing without skips, but it is retained only as an early
result, not complete isolation evidence. The fixed `5511f28` red snapshot was
rerun under the corrected whitelist: all eleven counterexamples still failed
(exit 1, zero passes/skips, 1,088.838 ms). Final results above use the corrected
whitelist and final code snapshot. Metadata comparison after correction found
no further changes to those external markers. This early deviation remains a
handoff risk; subsequent passes do not erase it.

Locked installation reported the existing twenty development-tool audit
findings (five moderate, fifteen high) and two blocked install scripts. No
dependency, lockfile or installation-script policy was changed.

The registered server contribution is mounted with external/background
bindings mocked. Actual board/detail handlers and original RPC schemas are
invoked in English and Chinese. Quota, concurrency, rate-limit, transient,
other and login queues, a live run with historical failure and an ended
review are covered. It observes six synthetic run rows, zero provider runs,
zero sends and zero review-wait writes on reads. This is server-handler
integration evidence, not a phone or desktop client mount. Current and
ancestor retries, repeated scans/restart, ended clocks, overlapping scans,
completion during send, wrong bindings, real blocks and mixed batches are
covered. Thirty linked dependency reviews use two SQL statements; 500 archived
historical reviewers leave the ordinary load at one statement. No per-card
SQL loop was added for these review facts.

Retained limitations: a review created before the current acceptance round
is conservatively not exempted. Due-only batches exclude cards that have used
their two extra reminders; a later valid wait ending opens a new episode.
Changing the login retry configuration, or using noninteger milliseconds
whose producer Date conversion truncates the fraction, can cause conservative
extra reminders. Already-sent messages cannot be withdrawn; strict exactly-once
across independent daemon processes is not provided. Genuine human blocks and
unknown evidence still notify. No failure history is cleared or deleted.

This is local-only evidence. No remote operation, push, PR, merge, tag, release,
publication, daemon start/reload or enablement occurred. No production quota,
ban, profile, pool, plan or cockpit setting changed. Existing deployment and
incident freezes remain in force. This port does not claim actual production
target recovery, a live provider cycle or the source's three skipped live
compatibility checks. Public-port independent review and lead acceptance are
separate required steps; the executor does not perform them.

### Joint validation with accepted cleanup generations

Independent high-risk review requested integration with the newer accepted
public cleanup generation port; the previous delivery did not include that
base. The original branch was locally rebased onto the fixed public main
`dabc420f4c88e3a82269b737d974054945a4f05f`, including cleanup runtime/tests
`3e8384cb2538ac192252d4e27dbdb051e695466e`. Only this document conflicted.
The entire original main document, including its 110-line cleanup appendix,
is preserved byte for byte. That appendix's SHA-256 is
`8dcc89b9fc999f3742b905182d134fecc3247f89d9d02d939ec287c91f192b45`.

`git range-diff` shows the four runtime/test patches unchanged by the rebase:
`5511f28` became `c06946c`, `f301433` became `dc1d03d`, `fdf7a43` became
`1554fa0`, and `769751e` became `e5bf81a`. The tested joint HEAD is
`fde6890f4cb5c304164cdd93b657d72f707d4ad8`; the subsequent joint-evidence
commit changes only this document. No whole production file was replaced to
resolve the integration.

Eleven cleanup production/test files remain byte-identical to the new public
base. Dispatch retains `archiveWithTimeout(taskId, agentId)`,
`trackCleanupWork` and the captured `cleanupGeneration` on archive outcomes,
alongside the wait port's `noteQueueHold`. The CLI still returns the durable
`requested` / `requestId` / `execution: "periodic"` acknowledgement, rather
than claiming physical cleanup. Both catalogs retain all baseline keys,
including cleanup request messages, and add only the eight reviewed wait
messages. The six wait consumer files still match the fixed accepted source.
The function/protected-path audit still preserves 140 other functions,
public safety/defaults and all shared gates. The fixed real Fleet revision
remains `cd9caf5b08b7f2bb5f2c661d5481736d516c75f6` for both comparisons.

All new experiments use the corrected clean whitelist and separate
`KANBAN_TMP_ROOT`. A temporary external Node preload redirects only the
three existing hardcoded mkdtemp prefixes `cleanup-retry-rows-`,
`cleanup-races-` and `cleanup-stop-` into the task's TMPDIR. Assertions,
thresholds, repository runners and shared gates are unchanged. The new source
snapshot has the exact public HEAD and history, no remote, and isolated
CLI/compiler artifacts. The initial isolation deviation above remains
unchanged; these new results do not make the first run fully isolated.

On 2026-10-11, Node 24.21.0 / npm 12.1.0 produced these joint results:

| Joint command/check at the tested HEAD | Exit | Result |
| --- | ---: | --- |
| `npm ci` | 0 | 362 locked packages; dependencies/lockfile unchanged. Existing 20 audit findings and two blocked install scripts retained. |
| Red wait/retry command on rebased `c06946c`, already including cleanup generation | 1 | 11 tests, 0 passed / 11 failed / 0 cancelled or skipped; 975.523042 ms. Normal quota/other/login queues still wrongly woke or marked the target. |
| Same wait/retry files at joint HEAD | 0 | 198 passed / 0 failed, cancelled or skipped; 5,087.117459 ms. All eleven original red case names pass, alongside expanded boundaries. |
| `node --import tsx --import ./test/helpers/i18n-preload.ts --test test/cleanup-rework-generation.test.ts` | 0 | 19 passed / 0 failed, cancelled or skipped; 14,866.016834 ms. |
| Deduplicated combined targeted command below | 0 | 62 files, 1,311 passed / 0 failed, cancelled or skipped; 104,762.733584 ms. Cleanup generation, review waits, readonly, operations, actual-target/family and Google boundaries run against the same code tree. |
| `npm run verify` | 0 | All twelve gates passed. 115 script tests (3,864.034917 ms), 2,833 plugin regressions (124,827.812709 ms), then 54 separate performance cases (6,478.080917 ms); all 0 failed/cancelled/skipped/todo. |
| Strict compiler and CLI gates inside verify | 0 | Actual `@getpaseo/server` 0.11.2; client 565,566 / server 10,894,768 bytes, no compilation skip; four standalone CLI bundles. |
| Type/privacy/identity/history/package gates inside verify | 0 | 447 typed files; 574 files scanned with zero hits; 2 next identities and 83 commits / 166 history identities accepted; gitleaks 83 commits, no leaks; 259 package files, zero problems. |
| Contract/shared gates inside verify | 0 | Nine contract files compared with the fixed real Fleet object; 28 shared files identical. No empty comparison or copied weakening. |
| Source/base/document comparison and `git diff --check` | 0 | Cleanup base files, both dispatch blocks, CLI return, fixed wait source and original cleanup appendix preserved; no whitespace errors. |

The combined command selects the union below, deduplicates filenames, then
calls the ordinary Node test runner with the unchanged locale preload:

```sh
node --import tsx --import ./test/helpers/i18n-preload.ts --test \
  test/cleanup*.test.ts test/archive-deadline.test.ts test/auto-archive.test.ts \
  test/rework-*.test.ts test/temp-workspace.test.ts test/workspace-recreate.test.ts \
  test/worktree-gc.test.ts test/doctor*.test.ts test/audit.test.ts \
  test/cli-guard.test.ts test/identity.test.ts test/leader-identity.test.ts \
  test/profile-rules.test.ts test/review-target-dispatch.test.ts \
  test/antigravity-boundary.test.ts test/readonly-boundary.test.ts \
  test/readonly-p2.test.ts test/ops-roles-matrix.test.ts \
  test/dispatch-matrix.test.ts test/routing.test.ts \
  test/wake-*.test.ts test/board-*.test.ts test/i18n*.test.ts \
  test/acceptance-*.test.ts test/dependency-attention.test.ts \
  test/schedule.test.ts test/event-noise.test.ts test/read*-*.test.ts \
  test/plugin-conformance.test.ts
```

The final performance phase measured cached 21.5 ms, cold 70.0 ms, sweep
19.7 ms and CLI 471.8 ms for 1,000 agents, 600 JSONL and three 50 MB files.
The unchanged I/O calibration was 1.00x, retaining 50/200 ms limits.
Tick/cleanup steady rounds measured 63.1/63.6/65.0 ms; startup was 2,950.0 ms.
At 292 cards, board/detail measured 30.2/0.9 ms. CPU and I/O gates ran without
skips. Registered-handler and bounded SQL cases described above also pass
in this joint suite; none of these results claims authenticated provider,
phone/client mounting or production recovery.

A stat-only follow-up found eight timestamps different from the historical
external-marker inventory, all at 21:35:15-19 UTC, before this rework began
at 21:37:15 UTC. Their provenance is not established here. Marker bodies
were not read and unknown external directories were not modified or removed.
The original 158-directory deviation and historical post-correction zero
change observation remain separate evidence; they are not overwritten by
this later observation. Post-document privacy, identity, history leak and
whitespace checks are repeated and recorded in the handoff.

| Evidence state | Current facts |
| --- | --- |
| Landed locally | `dc1d03d` / `1554fa0` / `e5bf81a` port on accepted `dabc420`, with joint tested HEAD `fde6890`; 11 red cases turn green, 19 cleanup and 1,311 joint cases plus all twelve gates pass. |
| Broken | No unresolved final local product/check failure. The earlier isolation metadata deviation cannot be undone; earlier product and fixture failures remain recorded. |
| Unverified | New different-family high-risk review and lead acceptance; actual client/phone mount, provider/ACP, live CLI/config/daemon and production recovery. |
| To do | Board-selected cross-family high-risk re-review and lead acceptance; deployment/live validation require a separately authorized task. |
| Abandoned | None; neither gates nor public policies were weakened for integration. |

Deployment and incident freezes remain. No remote operation, push, PR, merge,
tag, release, daemon reload or enablement occurred. This executor does not
approve or accept the public delivery. The cleanup appendix's historical
review-pending wording is retained verbatim from the accepted base; its
acceptance is a prerequisite, and the combined public delivery still needs
its own independent review and lead acceptance.
