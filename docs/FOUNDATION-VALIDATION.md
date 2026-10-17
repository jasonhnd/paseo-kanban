# Foundation validation and release stop

Recorded during the first implementation stage, 2026-10-11 to 2026-10-12.
Inputs are fixed in [merge-inputs.json](merge-inputs.json). This report contains
approved source object ids, finding paths/types/counts and anonymous fixture results.
It omits personal paths, identities, private terms, card ids and historic message
contents. It does not certify a combined plugin, Linux host load or device panel.

## Environment and runnable entries

Local execution used Darwin, Node `v24.21.0`, npm `12.1.0`, the repository lock,
and real gitleaks `8.30.1` for release checks. The default isolated test entry
exports committed `HEAD`, initializes an anonymous Git fixture and keeps all
builds, state, HOME, Paseo home, roles, data, caches and temporary files outside
the checkout. It links installed locked dependencies after fixture initialization.
Uncommitted changes are not part of that run.

The child environment is an allowlist, not a copy of the user's environment.
The executable set is Node, npm and these declared POSIX fixture tools:
`git`, `env`, `sh`, `dirname`, `cat`, `uniq`, `find`, `file`, `true`, `du`, `tar`, `lsof`.
No Python interpreter, provider command, daemon, real `gh`, real `ps` or real
profiles are available on the default test PATH. Anonymous Node executables
model command protocols where needed. Release runs additionally require real
gitleaks and explicit read-only compiler, public contract, sibling and local
privacy-policy inputs. No provider authentication or routing environment is inherited.

Install dependencies first, then run the committed source tests:

```sh
npm ci
npm run test:node
```

`npm test` runs only the script suite. `npm run test:plugin` builds the four CLI
bundles and runs all plugin regression and existing separate performance phases.
`npm run pack:check` also builds first, and the package gate requires all four
bundles whenever the Kanban command wrapper is advertised.
`npx tsc --noEmit` is only TypeScript checking. These commands are not equivalent
to each other or to host compilation.

For a plain Node host compiler, install the public server in a disposable
toolchain directory and pass its package directory explicitly:

```sh
npm install --prefix "$COMPILER_HOME" --save-exact @getpaseo/server@0.11.0
PASEO_SERVER_DIR="$COMPILER_HOME/node_modules/@getpaseo/server" \
  npm run test:node -- --build-check
```

`COMPILER_HOME` must be outside the checkout. The explicit server lookup uses the
package's real `dist/server/server/plugins/compiler.js` with the running Node;
an invalid explicit directory fails rather than falling back to a Mac app.
Release compilation is strict. No system software was installed and no daily
host plugin was reloaded.

`npm run test:native` separately tests real `lsof` against a newly created SQLite
file and its own Node child, never a production database or provider process.
It fails when the native capability is absent. Default protocol tests and CLI
migration tests execute with anonymous Node fixtures; the native coverage is
preserved under `test/native/lsof.integration.ts`, not silently skipped.

For an exact local release target:

```sh
PASEO_SERVER_DIR="$COMPILER_HOME/node_modules/@getpaseo/server" \
FLEET_CONTRACT_SOURCE="$APPROVED_FLEET_EXPORT" \
PASEO_FLEET_SIBLING="$APPROVED_FLEET_EXPORT" \
FLEET_PRIVATE_DENYLIST="$LOCAL_POLICY" \
  node scripts/verify-ref.mjs "$TARGET_SHA" --keep
```

The public Fleet export must be the tree pinned in the manifest; the local policy
stays outside Git. Verification installs the exact target lock into a disposable
export, then runs that target's full gates. Its synthetic Git history supports
tests; it is never proof that the original outgoing ancestry is clean.
The real pre-push entry additionally scans that original ancestry, selected tags,
identities, ref names and every outgoing target. A local manual invocation with
empty stdin checks exact `HEAD`; no network push is performed.

## Preserved first failures

| Run on the frozen Kanban source | Exit / result | Classification and action |
| --- | --- | --- |
| `npx tsc --noEmit` | 0 | TypeScript baseline clean |
| `npm test` | 0; 115 script tests | Script baseline only |
| `npm run test:plugin`, no prior build and incomplete declared tool set | 1; 2,918 cases, 24 failed, 2 previously skipped | 13 missing generated CLI bundles; 6 missing `dirname`; one each for `true`, `tar`, `cat`, `du` and process-time lookup |
| Same plugin suite after CLI build and necessary shell prerequisites | 1; 2,918 cases, 3 failed, 2 previously skipped | Missing `uniq`, `du` and a nondeterministic real-process fixture; retain assertions and fix prerequisites/protocol fixture |
| Anonymous local-binding exception regression before implementation | 1 | Scanner rejected a genuine resolved local identifier; add only function/file/binding-scoped exclusion |
| Public tip scan with the actual local policy | 1; 5 hits in `server/cleanup-state.ts` | All five uses resolve to one local binding in `trackCleanupWork`; no string/path/private-project allowance |
| Database inspection error regression before product fix | 1 | Product treated inspection failure as no holders; change to refuse uncertain inspection before data changes |
| Initial stricter parser on native Darwin SQLite | 1 | It rejected valid file-marker records; select `pcf` explicitly and parse process/command/file records |
| Packaged command with generated bundles absent | 1 after the required-artifact fix; first regression was red | A release check must not scan an incomplete command package and pass |
| Ignored-extension forbidden-path regressions before the review fix | 1; 82 tests, 8 failed, zero skipped | PNG, MP4 and WOFF2 deleted-history/pre-push negatives and path unit coverage exposed the early content-ignore return |
| Anonymous history reporting regression before the review fix | 1; finding diagnostics exposed metadata object locators | Group public diagnostics by finding path/type/count; keep all objects internally scanned |
| Contract check against the frozen public Fleet export | 1; 4 differences | Real model-contract drift, retained for later integration |
| Shared-script equality against that same export | 1 | Foundation changes differ from Fleet; gate remains substantive |
| Actual built npm package with the real policy | 1; 112 privacy findings | Generated dependency content contains identifier and string matches; publication stays stopped |

First-red logs and final exits are retained in local task evidence and the review
handoff. No assertion, timing threshold or denied string/path was relaxed.
The original native test and migration test skips were replaced with executable
default protocol coverage plus an explicit native gate. Existing timing-sensitive
performance tests still run in their original separate process phase.

Database inspection accepts only a complete successful process/command/file
stream, or exit 1 with empty output and no diagnostics (no matches). Missing
tools, timeout, other exit codes, stderr, partial data and malformed fields refuse
the operation. The anonymous CLI test verifies both data trees remain unchanged.
Explicit file-field selection accounts for the change between older and newer
versions documented in the [official lsof manual](https://lsof.readthedocs.io/en/stable/manpage/#output-for-other-programs).
The corrected native Darwin check passes with an actual child holding SQLite.
This is not a Linux result.

## Final local gate results

The exact delivery ref and command exits are recorded in the review handoff.
Functional implementation is fixed at `7ee23d6907cf06eb6c8f158bcd449588f2b81a4c`;
the following documentation/comment commit is verified as an exact target too.
The full gate run produces the following outcomes; failures are retained as
release blockers rather than converted to success:

| Gate / command | Result |
| --- | --- |
| Exact target `npm ci` | 0 |
| TypeScript / `node scripts/typecheck.mjs` | 0 |
| `npm test` / all script tests | 0; 143 tests, no skips |
| CLI / `npm run build` | 0; four standalone Node bundles |
| Real host / `npm run build:check` | 0; actual public `@getpaseo/server@0.11.0`, plain Node, client and server compilation |
| Full plugin suite / `npm run test:plugin` | 0; 2,921 regression tests and 54 performance tests, zero skipped |
| Working source privacy scan in the export | 0, actual local policy |
| Anonymous export's synthetic history and identities | 0; only a test prerequisite, not source-ancestry clearance |
| Actual gitleaks on the export history and extracted npm package | 0 |
| Real gitleaks on an anonymous generated credential control | 1 as required; redacted output |
| Contract check against approved public Fleet | 1; four differences listed in the source report |
| Shared-script check against approved public Fleet | 1; real differences, no missing-source success |
| Actual built package privacy gate | 1; 112 private-rule findings in the main CLI bundle |
| Whole exact-target release verification | 1; contract, shared-script and package privacy gates fail |
| Original full reachable public-history privacy | 1; forbidden card metadata, detailed below |
| Manual pre-push check | 1; expected publication refusal, no push |
| Native gate with native executable excluded | 1; explicitly unavailable, zero skips |
| Native Darwin SQLite-holder gate with only Node/lsof on PATH | 0; own file/child only |

The baseline host compiler also ran against the frozen Kanban source: client
566,713 bytes and server 10,899,540 bytes. This establishes a compiler baseline,
not a runtime mount or mobile-entry acceptance result. The delivery compiler's
sizes are recorded in the local exact-ref evidence.

## Publication stop

Full-history scanning is broader than `--tree HEAD`: deleted blobs, earlier trees,
commit metadata/messages and selected annotated-tag chains are included. No
unrelated ref is enumerated. Paths are checked even when content is ignored,
and `docs/validation/hourly-quota` cannot be admitted by a broad docs exemption.
The path prohibition runs before content ignores, including binary images,
videos and fonts. Regression tests keep rejected evidence in deleted historical
trees and in a later proposed ref while still verifying both exact targets.
The focused review regressions pass 85/85 with zero skips. Rechecking the fixed
source objects, trees and manifest with the corrected path order preserves the
following finding counts; no new prohibited paths were found in those inputs.

| Frozen input | Reachable commits / trees | Unique blobs / path-blob versions | Forbidden findings |
| --- | --- | --- | --- |
| Kanban | 92 / 92 | 901 / 901 | 4 `card-code` matches in commit metadata/messages |
| Fleet | 113 / 112 | 942 / 948 | 1 `card-code` match in commit metadata/messages |

Forbidden findings are reported only by path, type and count. Commit/tag
metadata findings have no file path; their object identifiers and message
contents are omitted. Approved source commits, trees and manifest blobs remain
explicit because they define the permitted inputs.

These are real prohibited-history findings. Publication stops. No shared history
is rewritten and no ignore rule hides them. Removing finding object locators
from the current report does not remove earlier report versions from ancestry;
those versions require the same publication stop. The future public-source export and
permitted publication ancestry must be resolved separately before exact-ref user
approval. A single-tree export for local testing does not resolve this stop.

The actual npm artifact contains 258 files. At the reproduced target, its main
`bin/cli.bundle.mjs` has 112 private-rule matches: 48 in identifiers and 64 in
string nodes. The other three command bundles have none. These are AST context
counts, not proof of private ownership of a dependency's ordinary word. Strings
remain refused under the unchanged local policy; they receive no exception.
The one approved source binding exception does not apply broadly to generated
code, properties, comments, strings, paths or other functions. Release remains red.

The pre-push test harness uses anonymous temporary Git repositories/remotes and
fake gate executables solely for wiring tests. It tests deleted historical content,
forbidden paths with ignored binary extensions, finding-diagnostic redaction,
commit/tag messages, private ref names, multiple refs, a non-HEAD target failing
its own verification, missing/failing secret scanners and actual package privacy.
Poisoned fixture commits are manufactured with Git plumbing, without bypassing
real project hooks. Production gates use real gitleaks and the outside policy;
fixture success is not reported as real secret-scanner acceptance.

## Remaining integration and platform gates

No supported Linux runner was accessible in the isolated environment. The
installed Docker client could not connect to its default daemon socket. No daemon
was started, system package installed, VM operated or Fly resource changed.
Case-sensitive paths, Linux SQLite/process behavior, other Node versions,
actual Linux host mount and provider capability reporting remain unverified.

The integrated rc.5 package now requires Node `>=24.21.0` based on separate
minimum-version measurements. That measured point does not certify every higher
version or platform. Preserve platform capability refusal and run the real
Linux/default test entry before claiming platform support.

Next-stage gates include the public Fleet language fixture replacement, actual
model admission, one canonical schema and lock, equivalent internal gates after
the merge, fresh-install root ownership, a single service/timer lifecycle and
actual client/phone registration. Independent review must use a different actual
model and the high-risk lane. No review, leader acceptance, PR, merge, remote
change, deployment or user approval of publication is claimed here.
