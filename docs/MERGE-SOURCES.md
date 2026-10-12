# Frozen public inputs and ownership

The later single-plugin implementation and its limits are recorded in [integration validation](INTEGRATION-VALIDATION.md). The frozen objects and original publication refusals below remain authoritative.

This is the first implementation stage of [the approved plan](MERGE-PLAN.md),
recorded on 2026-10-11. It establishes inputs and local checks; no Fleet modules,
runtime state, private development history or migration framework are imported.
The machine-readable [manifest](merge-inputs.json) includes exact tree and primary
blob objects. The authoritative delivery commit is recorded in the review handoff.

## Exact inputs

| Public repository | Commit | Tree | Tracked paths |
| --- | --- | --- | ---: |
| `jasonhnd/paseo-kanban` | `6ca7f562fb21938c16eec2991972a14995fd2d56` | `5ad320758f34637e18b985fd14bda3096321fb7f` | 576 |
| `jasonhnd/paseo-fleet` | `a383ec4a7406f221ed4ef3dea69a3e692008c1d6` | `8ead44922b954be7adc10eda6990bba74cb0eeff` | 384 |

Both commit and tree objects were re-resolved locally. Their combined 960 paths
are source inputs, not a claim of 960 files in the eventual combined plugin.
Only these approved objects and their reachable public ancestors were examined.
Isolated runs export a single tree without its ancestry; they never copy a
repository database or unrelated refs.

Fleet's hourly-sampling commit `31d9e0277401b158d42de717eced811f36518248`
is an ancestor of the selected Fleet input. That input also contains the provider
status and stopped-primary-window fixes in `server/provider-usage.ts`,
`shared/quota-companies.ts` and `server/test/provider-status.test.ts`.
These source objects replace older handoff evidence as integration inputs.
No earlier private evidence is used as final acceptance.

## Public module boundaries

| Domain | Approved public source | Owner and later integration boundary |
| --- | --- | --- |
| Plugin registration/lifecycle | Both `paseo-plugin.json`, `index.client.tsx`, `index.server.ts` | One Kanban registration root, screen entry and timer owner |
| Board, tasks, permissions, scheduler | Kanban `server/`, `client/`, `shared/` | Kanban remains authoritative for task and token lifecycle |
| Roles and reviewer policy | Fleet `server/dispatch.ts`, `server/pools-reviewer.ts`, `shared/roles-policy.ts`, `shared/review-model.ts` | Fleet policy service, called by Kanban admission |
| Quota adapters and sampling | Fleet `server/quota-sampling.ts`, `server/provider-usage.ts`, `server/pools-status.ts`, `shared/quota-time.ts`, `shared/quota-companies.ts` | One Fleet collector/publisher; preserve scheduling and freshness separately |
| Plans, decisions, leader and usage panels | Fleet `server/`, `client/`, `shared/` | Move into Kanban's Fleet namespace with one write coordinator |
| Existing filesystem transport | Both contract manifests, `server/contract/`, `shared/contract/` | Preserve validation, TTL and CLI/export compatibility before replacing the transport |
| Packaging and local gates | Both package/lock files, `scripts/`, `.githooks/` | One final lock and effective local verification set |
| Documentation and examples | Only public `docs/`, root docs, `examples/` | Public source/design instructions; examples remain synthetic |

The entries above identify source ownership, not authorization to copy every
file wholesale. Runtime `data`, databases, private handoffs, credentials, native
provider archives and `docs/validation/hourly-quota` are never source inputs.
No private branch or private repository ancestry is read or merged.

## Development semantics still missing from the Kanban baseline

The baseline still selects reviewer branches through `byExecutorFamily` in
`server/matrix.ts`, and `server/review-target.ts` rejects same-family review.
No approved public Kanban replacement object was supplied. Record the required
behavior and its public Fleet sources; do not recover private development hunks.

| Required behavior | Exact public Fleet input at the frozen commit | Remaining integration work |
| --- | --- | --- |
| Compare actual, nonempty model values after trim/lowercase | `shared/review-model.ts`, last source change `a2545d0b39ef84b920b5ab3be7c4ca7b101b31e2` | Use the same comparator at board admission and review revalidation |
| Different models in one family are allowed; one model across routes/settings is refused | `server/pools-reviewer.ts`, `server/dispatch.ts`, `shared/roles-policy.ts`, `server/test/model-review.test.ts`, `server/test/model-review-mount.test.ts` | Replace family exclusion without weakening pause, risk, role, quota or capacity gates |
| Missing model or unresolved profile stops selection | The comparator and policy tests above | Preserve conservative behavior in persisted and live candidates |
| Exact `byExecutorModel` branches and invalid-branch refusal | `shared/contract/schema.ts`, `server/contract/test/model-review.fixture.json`, `server/contract/test/schema.test.ts`, `server/contract/test/io.test.ts` | Import the contract semantics together; a union must not strip an invalid model branch into a legacy/direct success |
| Hourly sampling remains separate from heartbeat and safety TTL | `server/quota-sampling.ts`, `server/quota-timing.ts`, `shared/quota-time.ts`, `server/test/quota-sampling.test.ts` | Keep hourly collection, 60-second heartbeat, 62-minute display TTL and 7-minute live-reading safety TTL distinct |
| Provider unavailable/error/empty status and primary-window stop remain visible | `server/provider-usage.ts`, `shared/quota-companies.ts`, `server/test/provider-status.test.ts` | Preserve the frozen fixes during service and panel integration |

The cross-repository contract check is deliberately still effective. Against the
approved Fleet tree it refuses four differences: `server/contract/test/io.test.ts`,
`server/contract/test/model-review.fixture.json`, `server/contract/test/schema.test.ts`
and `shared/contract/schema.ts`. This stage does not sync away those differences.
After integration, replace equality with meaningful internal schema, negative
policy and compatibility invariants, including the anonymous model fixture.
The shared-script check also remains red for the intentional foundation changes;
a missing sibling is now a setup failure, not success.

The baseline's family-based package description and expectations must be updated
with the admission implementation. No prepared theme/mobile candidate has an
approved public object in these inputs; registration and device behavior need
new evidence rather than private candidate ancestry.

## Source-derived data inventory

This inventory comes from approved source literals and resolvers. No live files,
database, user configuration, profiles, credentials or provider archives were
opened to construct it. Names describe ownership, not files to commit or migrate.
Under option B, a new installation starts with a fresh root. The integrated root is Kanban's plugin-data directory with a `fleet/` child.
`server/storage/root.ts` implements the same fresh root for the server and command
entries; `docs/MANUAL-MIGRATION.md` describes user-controlled transfer separately.

| Owner/class | Source-defined names or families | Fresh-install handling |
| --- | --- | --- |
| Kanban durable state | `kanban.db` and its WAL/SHM/journal, `kanban.config.json`, `kanban-decisions.json` | Initialize under the new root; no Mac-state import |
| Kanban local backups/audit | Configuration `.prev` and backup variants, database backups, `backups/`, `readonly-leftovers/` | Stay local; no recursive source import |
| Kanban operational state | `config.lock.db`, `kanban-decisions.lock.db`, `mcp.port`, `board-wake-marks.json`, `daemon-restart.json`, `scheduler-tick.json`, `doctor-report.json`, `perf-summary.json`, `missing-cwd-registered.json`, `missing-cwd-list.md`, `exports/` | One runtime owner; initialize/rebuild rather than copying active control files |
| Kanban credential | `supervisor.token` | Local protected credential; never read or copy for this stage |
| Fleet durable user policy | `plans.json`, `afc.config.json`, `decisions.json`, `paused-projects.json`, `panel-prefs.json`, `access-map.json` | Fleet service owns new `fleet/` state; configure afresh |
| Fleet local audit/history | `usage-ledger.json`, `quota-history.json`, `roles-history.json`, `leader-activity.jsonl`, `seen-models.json`, `changes.log`, `doctor-history.jsonl`, `decisions-maint.log` | Local-only records; no Mac history transfer |
| Fleet persisted operational control | `quota-sampling.json`, `reset-coupons.json`, `early-resets.json`, `supervisor-shift-state.json`, `decisions-maint-state.json`, `decisions-check-state.json`, `afc-leader-nudge.json`, `sweep-state.json`, `daemon-crash-state.json`, `doctor-state.json` | One owner/lock protocol; sampling claims and anchors are control state, not disposable display cache |
| Fleet generated readings/exports/cache | `quota-companies.json`, `policy-snapshot.json`, `pool-status.json`, `dispatch-matrix.json`, `dispatch-stats.json`, `usage-scan-cache.json`, `board-log-cache.json`, `prices-cache.json`, `cursor-usage.json`, `grok-usage.json`, `codex-credits.json`, `cursor-login-state.json`, `keychain-probe-state.json`, `compat-state.json`, `access-status.json`, `exports/` | Recompute with preserved freshness/unknown semantics; never assume a copied reading is current |
| Fleet secrets | `secrets/cursor-token.json`, legacy `state/cursor-token.json` | Never imported, printed or repurposed; new authorization is separate |
| Host state | Host `config.json`, profiles, provider sessions/native archives | Paseo owns it; do not relocate through Fleet/Kanban data migration |
| Both domains' temporary coordination | Atomic-write temp files, locks, migration records and backups | Remain runtime-local; exclude from public inputs and package |

Inventory sources include Kanban `server/paths.ts`, `server/migrate.ts`,
`server/local-decisions.ts`, and Fleet `server/paths.ts`, `server/settings.ts`,
policy, sampling and maintenance modules. The integration diagnoses retired
storage overrides and never selects an old data directory. Broad old-directory discovery or automatic migration
would exceed the approved fresh-install scope.

## Next-stage inputs and gates

Use the exact two trees in the manifest and the reviewed foundation delivery
commit. Never merge their source ancestry into a future export without clearing
the [historical publication stop](FOUNDATION-VALIDATION.md#publication-stop).
Keep excluded private evidence and runtime archives out of the source manifest.

Fleet `server/test/roles-language.test.ts` still contains its Python fixture.
When that public file is moved into the combined plugin, use a Node executable
driven by `process.execPath`, filesystem/JSON APIs and explicit UTF-8. Preserve
the reload log, argv contract, multilingual output and failure assertions;
remove `PYTHONIOENCODING` only with equivalent verified behavior. Fleet is not
modified here, and this test is not claimed fixed.

Still required: actual-model admission integration, one canonical contract and
lock, internal gate replacements, fresh-root ownership tests, single lifecycle
and timer registration, client registration/theme/mobile checks, actual Linux
host load and independent high-risk review. A source or simulated rendering
test is not evidence of a working device panel. No push, deployment, host reload,
remote modification or publication is performed by this stage.
