# Paseo Kanban: single-plugin merge plan

Status: approved for implementation on 2026-10-11, with option B for fresh-install storage. Publication requires a separate user approval of exact refs and SHAs.

Stage-one execution freezes the public inputs and adds portable local checks;
it does not combine the plugins. See [source and ownership inventory](MERGE-SOURCES.md),
[immutable input objects](merge-inputs.json), and [validation and remaining release gates](FOUNDATION-VALIDATION.md).
Publication is stopped by forbidden metadata in the selected public histories
and privacy findings in the actual package; a clean source tip is insufficient.

Implementation is authorized only for this merger under the Kanban leader, with
Fleet's leader supplying domain handoff. Other projects remain stopped. Mac is
the development machine; the target is a fresh Linux Fly.io installation with
Node and no Python. Do not operate the VM or reload Mac's daily plugins. Mac usage
data remains local and is not migrated. Runtime data must never enter GitHub or
a plugin checkout. Before any push, report exact refs, SHAs and check results and
wait for explicit user approval. No force push or bypass of checks is allowed.

## Recommendation and source baseline

Keep `jasonhnd/paseo-kanban` as the public repository and `paseo-kanban` as the
only installed plugin id. Display name: **Paseo Kanban**. Incorporate AFC as the
roles, quota, dispatch-policy and decisions modules of that plugin. Do not run two
copies of the scheduler, quota publisher or decision maintenance loops.

Planning inspected these clean local public checkouts (not claims about the VM):

- Kanban: `6ca7f562fb21938c16eec2991972a14995fd2d56`.
- Fleet: `a383ec4a7406f221ed4ef3dea69a3e692008c1d6`.

There is already reviewed development outside the public Kanban baseline. Before
implementation, record an explicit source manifest of reviewed code to import;
copy public-safe development hunks and anonymous tests, not private Git ancestry,
private handoffs, runtime archives or databases. Unresolved security experiments
must not silently become the stable implementation. A prepared theme candidate
is not proof that the missing iPhone entry is fixed.

Evidence read for this plan: both package/manifest/entry files; Fleet
`server/paths.ts`, `server/util.ts`, `server/test/roles-language.test.ts`; Kanban
`server/afc-sources.ts`, contract paths, `scripts/check-private.mjs`, privacy rules,
`.githooks/pre-push`, and `scripts/verify.mjs`. No product tests or builds were run
in this planning round. A public Fleet open-issue listing returned no open items
at sampling time; the reported Python issue remains an implementation input, not
an invented issue number or a claim that the bug is resolved. AFC's leader has
been asked for a public-code/design handoff; owner confirmation of the complete
persistent-file inventory remains a step-one deliverable.

## 1. Repository and plugin architecture

Use one package, lockfile, build, plugin manifest and pair of entry points. Do not
create a second plugin inside a monorepo. Prefer incremental namespacing over a
wholesale move of existing Kanban files.

```text
paseo-kanban/
  index.client.tsx             # one registration/composition root
  index.server.ts              # one lifecycle owner and RPC registration root
  client/
    ...                       # existing board/workspace surfaces stay initially
    fleet/                    # AFC roles, usage, decisions and leader views
    common/                   # shared theme, primitives, language integration
  server/
    ...                       # existing card/scheduler/permission implementation
    fleet/                    # quota adapters, plans, usage, role management
    application/              # explicit services joining board and fleet
    storage/                  # unified directory resolver and write coordination
    compatibility/            # old CLI/export formats; isolated and time-bounded
  shared/
    ...                       # existing board schemas and domain types
    fleet/                    # AFC domain types/RPC schemas
    common/                   # one theme/i18n foundation
    contract/                 # compatibility schemas, not a second vendored copy
    locales/                  # board.*, fleet.*, common.* namespaces
  bin/                        # Node CLI entry points and compatibility aliases
  test/                       # board/fleet/integration/storage/platform fixtures
  scripts/                    # one portable quality-gate implementation
  docs/                       # public development, migration and operations guides
```

### Client

- One sidebar entry, **Paseo Kanban**. Preserve the existing `board` screen id and
  Kanban deep links. Add integrated tabs/routes for board, roles, quota and
  decisions; preserve workspace-scoped board behavior. Combine settings into
  sections rather than registering colliding `board`, `config` or `settings` ids.
- Move AFC components into `client/fleet`; initially keep their internal imports
  together. Consolidate palette, language state and repeated UI primitives only
  after matching behavior tests. Prefix translation keys rather than overwriting
  same-named dictionaries. Follow host theme props; no independent light/dark
  preference competing with Paseo.
- Old `agent-fleet-cockpit` URLs cannot automatically resolve once that plugin is
  gone. Document new routes and offer a link conversion helper; do not promise
  a host-level redirect without an actual supported API.
- Test registration and cleanup separately from panel rendering. The existing
  phone-entry failure has no proven root cause. A larger combined bundle must
  pass real host registration and device checks; adding global catch-and-ignore
  is not an acceptable fix. Do not add unverified dynamic imports to work around
  bundle size. Compare bundle size and startup against the frozen baseline.

### Server and shared code

- Keep one authoritative Kanban scheduler and permission/token/task lifecycle.
  Extract AFC startup into an explicit fleet service with `start`/`dispose`;
  register hooks once and dispose every timer on unload/reload.
- Fleet owns quota collection and policy computation; Kanban owns task dispatch.
  Use injected service interfaces for snapshots, review-candidate selection and
  decision updates. Avoid circular imports between schedulers and quota modules.
- Preserve actual-model review exclusion, freshness/unknown semantics, pause,
  capacity, high-risk gates, role limits and read-only permissions. Merging must
  not widen provider or user authorization. Keep snapshot generation/revision
  checks and serialize policy writes with dispatch admission where necessary.
- Maintain one canonical schema implementation. Resolve dependency versions from
  both lockfiles and verify the host's external-module contract. Package-lock
  versions alone do not establish the React/Zod version injected by the host.

### Can `fleet-quota/v1` disappear?

**The cross-plugin transport can disappear from the internal hot path; its
validation and compatibility obligations cannot disappear at once.**

Replace board-to-fleet filesystem discovery/polling with in-process immutable,
validated snapshots and service calls. Retain TTL, generated time, revision and
fail-closed behavior when collection fails. Retain a persisted snapshot for
restart recovery, clearly distinguished from current fresh data.

Keep old `fleet-quota/v1` exports and the `afc`/`roles` CLI entry points as thin
adapters for a documented transition release. Standalone CLI processes still
need a supported RPC or atomic persisted interface; they cannot access another
process's memory. Inventory consumers before removing old exports. Stop writing
to the old AFC data directory after cutover; compatibility output lives under
the new root, with consumers explicitly redirected.

Replace two-repository sync/shared-script equality checks with single-source
schema, compatibility-fixture and dependency-boundary checks. Do not leave the
old commands reporting a vacuous success because the sibling repository is absent.

## 2. Fresh-install data directories and manual migration guide

The user selected option B: the VM is a fresh installation with no old data,
Mac usage data stays on Mac, and neither plugin has an external released user
base. Implement one fresh-install root; do not build an automatic migration
system, a migration CLI, dry-run, journals or a crash/rollback migration matrix.

```text
$KANBAN_DATA_DIR/              # or $PASEO_HOME/plugin-data/paseo-kanban
  kanban.db
  kanban.config.json
  fleet/                      # Fleet-owned persistent state
    plans.json
    decisions.json
    usage-ledger.json
    ...                       # source-inventoried persistent files
  exports/                    # temporary CLI/format compatibility exports
```

Keep board and Fleet filenames separate. Classify file ownership from public
source, not by reading actual private data. Regenerate caches and exports;
never recursively import an old plugin directory during startup or installation.

### Environment-variable contract

| Variable | Merged behavior |
| --- | --- |
| `KANBAN_DATA_DIR` | Canonical unified root for server and CLI. Fleet state is its `fleet/` child. |
| `PASEO_HOME` | Default root is `plugin-data/paseo-kanban` below this directory; otherwise the supported Paseo home fallback. |
| `AFC_DATA_DIR` | Retired as an active merged-plugin storage override. An existing setting produces an actionable configuration diagnostic; no silent alternate writer/root. The manual guide identifies it only as an old source location. |
| `ROLES_STATE_DIR` and legacy roles root | Legacy source locations documented for manual use, not automatically searched or imported by the merged plugin. CLI adapters resolve the unified root. |
| `AFC_HOME` / `KANBAN_HOME` | Installation-discovery compatibility only if still needed; never durable data roots. |

Verify fresh startup and CLI/server agreement with anonymous fixtures: explicit
root, Paseo-home default, spaces/Unicode, missing directories, directory errors,
and stale legacy overrides. Do not replace an existing populated root or follow
an old installation's state implicitly. These are normal storage tests, not a
migration framework.

### Manual migration documentation only

Write a public guide for anyone choosing to reuse standalone AFC data later:
identify their actual old root (including an explicit AFC override), stop old
writers themselves, make their own local backup, and copy only listed persistent
Fleet files into the new root's `fleet/` directory. Explain schema/version
prerequisites, filenames that must not be flattened, conflict handling without
silent overwrite, and which generated files should be regenerated. Keep source
files until the user has checked the new installation. Do not copy a running
SQLite database without a supported consistent backup procedure.

Secrets must never enter source control or agent reports. Document supported
user-run credential setup/re-authentication separately; agents do not read or
copy credentials. State clearly that the guide is not an automated migration or
proof of migration on real user data. No actual Mac data migration is in scope.

Document that Fly.io durable state belongs on an attached persistent volume
with a single active writer. The user arranges VM installation/updates after
publication; this project does not configure volumes or touch that VM.

## 3. Repair the GitHub publication gates, without bypasses

Target remains the existing public `https://github.com/jasonhnd/paseo-kanban`.
The private usage repository and its history are never a push source.

Confirmed code evidence: Kanban `server/cleanup-state.ts` uses a generic local task-list
identifier; `parseDenylist` currently converts literal terms to case-insensitive
substring matches across source and filenames. The actual private list was not
read in this planning round. The user's reported false positive is consistent
with this mechanism, not evidence that every privacy finding is harmless.

Implement a narrow, testable distinction between a generic code identifier and
a private identifier/path/string. Prefer explicit structured rules with scope
and exact identifier-context exceptions, backed by parser-aware fixtures; never
globally allow the word, exclude the source tree, or disable the private list.
Ordinary variable uses must pass while the same text in a real private path,
project name or user-data string remains checked. Use anonymous synthetic terms
in public rule tests; keep the real private list outside the repository.
Renaming a variable alone does not repair old reachable commits or the scanner.

Inventory every failing local test with its command, environment and assertion.
Reproduce on a clean Node/Linux checkout, distinguish product bugs from old
fixtures and missing prerequisites, and fix the underlying cause. Do not assume
all current failures are known historical failures. Keep first failures and
red/green evidence; no relaxed assertions, skips or rerun-until-green.

The current pre-push checks identity ranges and each pushed tip's tree, then runs
`verify` in the working checkout. Extend publication validation to every outgoing
ref's reachable trees/blobs and commit messages, and verify the actual target
commit rather than an unrelated working tree. Deduplicate blobs for cost. Include
annotated tags and package contents. Run secret scanning with redacted output.
If genuine private content exists in unpublished public history, stop publication
and propose an isolated sanitized public export/history repair; preserve the
original locally and do not force-push or conceal a finding. A clean gitleaks run
does not waive privacy rules.

Release acceptance: exact main and approved branch/tag SHAs; clean checkout;
all required gates green; package allowlist and full outgoing-history scans
clean; independent different-model review; normal explicit-ref push through
pre-push; remote SHA read-back. No `--no-verify`, `--force`, blanket allowlist,
ignored nonzero exits, or claiming upload success from local commits.

## 4. Node-only Linux tests and runtime portability

The inspected Fleet language test creates a fake `paseo` with a Python shebang
and uses `PYTHONIOENCODING`. When imported in step 3, replace it with a JavaScript fixture run by the same
`process.execPath` as the tests, preserving command behavior, reload logging,
Unicode output and failure assertions. Search generated fixtures, subprocess
calls, package scripts and migration/replay helpers, not just `.py` files.
Words such as `python3` in command-recognition regexes are not runtime dependencies.

Use Node `fs`, `crypto`, `child_process` and SQLite APIs for helpers. Remove test
requirements for macOS `security`, `osascript`, `lsof`, `sw_vers`, BSD-only flags,
absolute app paths and home layouts. Platform-specific provider integrations
remain capability-gated with explicit unsupported status on Linux; do not mock
them into claims of a working provider. Keep generic contract tests executable
on Linux and maintain separately identified Mac integration coverage.

Distinguish three dependency classes:

- Runtime/install: supported Node, npm dependencies, the actual Paseo host; no
  Python, macOS SDK path, developer denylist or sibling source checkout.
- Unit/integration tests: Node/npm and declared fixture tools; no Python. A Git
  executable is a real prerequisite for tests of Git behavior, not an undeclared
  interpreter requirement. Isolate such tests and document the image contract.
- Publication verification on a local release runner: Git, a pinned secret scanner and real host
  compiler are explicit prerequisites. Do not pretend a Node-only VM has these.
  If full release verification must also run there, provision the declared
  tools or a release job; missing tools must fail that job, not silently skip it.

Proposed baseline: Node 24 LTS on Linux, with the minimum supported Node version
chosen after SQLite/API compatibility checks. Both current package engine ranges
must be reconciled. Pin/reproduce npm dependencies. Run the default Node test
suite in an environment where `python` and `python3` are absent; test UTF-8,
case-sensitive paths, umask, tmp roots, child processes and SQLite concurrency.

Provide an explicit portable compiler route using the supported installed Paseo
server/compiler on Linux. Strict compilation cannot depend solely on
`/Applications/Paseo.app`. Verify Node-built CLI bundles, actual plugin compilation
and a real Linux-host load. Preserve useful gates: replace cross-repo equality
with internal invariants, not deletion of coverage. Measure genuine CPU/I/O
regressions on an appropriate runner; do not turn timing failures into blanket
skips on the VM.

## 5. Fleet repository after the merge

Keep `paseo-fleet` read-only in practice during transition, with its existing
history and releases intact. After the unified release and fresh-install verification, add a public README notice pointing to Paseo Kanban, migration guidance,
last supported standalone version and the new issue tracker. Transfer or cross-link
open relevant issues with their history; do not close the reported Python problem
until the merged Node-only test is verified.

Recommend archiving Fleet only after the compatibility window and issue
handoff are complete, and ask the user again before archiving. Archiving immediately would obstruct transition fixes and
issue intake. Do not delete the repository or old tags. No repository settings,
README redirect, issue transfer or archive operation is performed by this plan.

## 6. Implementation stages and effort

These are approved implementation work packages. Estimates are provisional hands-on
engineering/review time, not promises based on test counts. Two public trees contain
960 tracked paths, including 576 Kanban and 384 Fleet paths; this is not
960 files requiring changes.

| Step | Deliverable and completion criterion | Estimate |
| --- | --- | --- |
| 1. Freeze inputs and failure inventory | Reviewed source manifest, AFC design/state-owner handoff, outgoing-history findings, actual failing-test list, no private ancestry | 0.5–1 day |
| 2. Linux and publication foundation | Kanban Node-only fixtures and isolated tests, narrow scanner fix with leak-negative tests, real compiler discovery and release-gate plan; record Fleet fixture replacement requirements without changing Fleet | 1–2 days |
| 3. Single plugin integration | Namespaced fleet code, replace the imported Fleet language fixture with equivalent Node behavior, one client/server composition, one timer owner, internal service interfaces, CLI/export compatibility, theme/i18n and route regression coverage | 2–3 days |
| 4. Fresh-install storage and manual guide | Unified root with fleet/ ownership, CLI/server agreement, anonymous fresh-install tests, manual migration and persistent-volume documentation; no automatic migration machinery | 0.5 day |
| 5. Acceptance and publication | Real Linux-host/client checks, independent high-risk review, outgoing refs scanned, normal push and remote SHA verification, operations handoff | 1–1.5 days |

Total: provisionally **5–8 focused person-days** (the row estimates span roughly
5–8 days), excluding user approval/device windows. This is not a delivery promise:
re-estimate after step one verifies source scope and actual failures. Host or
mobile compatibility discoveries may add work; report them rather than treating
the estimate as a commitment.

Step 2 and storage documentation can proceed in parallel after source freeze;
fresh-install storage implementation follows the integrated service interface. Keep changes in cohesive
reviewable slices. The Kanban leader owns the plan and final acceptance; the Fleet
leader supplies domain/adapter/data ownership and reviews preservation of policy.
Execution and review use different actual models, with high-risk qualification
for storage, permissions and publication. The local daily owner receives the
release/rollback guide; Mac development must not automatically reload the VM or
the local daily instance.

Final acceptance includes one plugin id/name/sidebar, intact board and fleet
features, Node-only Linux tests, no privacy/secret findings in outgoing history,
real isolated Linux host load, fresh-install root tests, explicit unresolved
mobile limits, and (only after user approval) successful normal GitHub push.
No actual user data migration is scheduled or performed by this merger.

## Approval boundary

The user has approved implementation with the fresh-install option above. The
stop-work order is lifted only for these two leaders' merger work; do not resume
other projects or old unrelated cards. Kanban's leader coordinates execution and
final acceptance; Fleet's leader supplies code, data ownership and review-policy
handoff without a duplicate execution line.

Do not reload Mac's active plugins, operate Fly.io, copy private usage repositories
or publish private history. In particular, exclude the Fleet private-evidence
branch and its ancestry from imports; freeze reviewed public objects explicitly.
Keep one set of background writers, actual nonempty model trim/lower exclusion,
exact model-branch selection, pause/onlyRoles/capacity/pool protections, and the
distinction between hourly sampling, 62-minute display and 7-minute protection.
Unsupported Mac integrations on Linux must report unavailable.

Before pushing, report proposed refs and full SHAs, privacy/secret/history scans,
all required test/build/pre-push results and independent review. Wait for explicit
user permission, then push only those approved refs normally; never force or
skip checks. Fleet's README redirect is in scope after the unified release;
repository archival needs a separate user decision. Report the published result
so the user can arrange the VM update.
