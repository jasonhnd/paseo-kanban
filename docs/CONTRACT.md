# Policy and compatibility contracts

Kanban and Fleet are one plugin and share one canonical schema. Admission receives a deeply frozen `paseo-policy/v1` revision; a separate command process reads the same persisted `fleet/policy-snapshot.json`. Cross-process correctness does not depend on an in-memory singleton.

The policy holds a positive revision, a digest of the current public control inputs, quota and matrix projections with an identical source timestamp. Publication rechecks the captured digest under the admission lock and advances revisions monotonically. The live channel rejects revision/timestamp regression. Readers validate the positive revision, current digest, payload and future timestamp; a standalone reader does not retain an independent rollback ledger. Missing/invalid policy and unknown protected quota readings keep admission closed.

Review uses normalized, nonempty actual models. Same family with different models is allowed; the same model across provider, family, mode or effort is refused. An explicit `byExecutorModel` map requires an exact valid branch and never falls through to a family branch. Pause, role, high-risk qualification, capacity and pool protections still apply.

## fleet-quota/v1 compatibility

The legacy envelope and anonymous compatibility fixtures remain supported. They are projections for standalone interfaces, not the admission transport. Default scheduler and CLI reads use immutable policy even when legacy quota/matrix environment paths are present. Explicit compatibility readers remain separately testable. All paths below are relative to the canonical new root:

| File | Producer | Refresh / TTL |
| --- | --- | --- |
| `exports/fleet/cockpit.json` | Fleet compatibility | Start and every 10 minutes / 1800 seconds |
| `exports/fleet/pool-status.json` | Fleet compatibility | Quota refresh / 900 seconds |
| `exports/fleet/dispatch-matrix.json` | Fleet compatibility | Matrix rebuild / 900 seconds |
| `exports/fleet/decisions-open.json` | Fleet compatibility | Decision changes / 600 seconds |
| `exports/kanban.json` | Kanban | Start and every 10 minutes / 1800 seconds |
| `exports/board-summary.json` | Kanban | Changes with debounce and periodic refresh / 900 seconds |

The wire envelope retains `schema=fleet-quota/v1`, the legacy producer names, producer version, ISO source `generatedAt` and positive `ttlSeconds`. Compatibility readers distinguish absent, invalid, stale (three times TTL) and fresh. This compatibility fallback is explicitly separate from fail-closed production policy admission. A heartbeat cannot renew the original quota age.

A cockpit export still carries its CLI metadata, but its `dataDir` never expands Fleet state lookup beyond `fleet/`. Retired storage variables are diagnosed. `.mjs`/`.js` command paths run through the current Node runtime. Credentials are not transferred through this interface.

## One source and effective gates

`shared/contract/` contains client-safe schemas; `server/contract/` contains paths, atomic writes and state parsing. The nonempty `contract.manifest.json` freezes their file hashes. There is no second contract directory or package/lock.

`npm run contract:check` checks these hashes and runs schema, file IO, path, immutable revision and actual-model compatibility tests. `npm run shared:check` checks one plugin identity, package/lock equality and all thirteen local gate commands. Negative tests reject missing fixtures/gates, altered commands and duplicate registrations. Neither gate needs or compares a second checkout. Legacy comparison utilities remain available for explicit historical checks; they are not publication clearance.
