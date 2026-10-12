# Antigravity authorization boundary

This note records the temporary dispatch and read-only boundary for one verified provider entry. It is a local source and test record. It does not enable a profile, open a pool, change a ban, reload a host, or claim that a live provider session was tested here.

## What is authorized

Automatic and explicit routing may select a Google profile only when all of the following hold:

- The provider id is `antigravity`, the model is `gemini-3.8-flash-medium`, and the mode is omitted or `default`.
- Host configuration shows the official ACP entry: `agents.providers.antigravity` extends `acp`, is not disabled, and its command is exactly one path ending in `/agy-acp-server/1.3.0/agy_acp_server.par`.
- The role is `executor`, `batch`, or `reader`, and the card tier is L1 or L2.
- The profile pool is `antigravity-gemini`, the profile is not paused or personal, its notes do not carry a pause mark, and its role matches the work (including a candidate aimed at that role).
- The quota snapshot is fresh, the pool is known, `usedPct` is a finite number from 0 inclusive to 100 exclusive, protection is `pause`, and the reading has not expired.
- When a dispatch matrix is present, that profile is listed for the role and tier and is not paused there.

A failure of the quota reading is reported as a snapshot problem. Any other Google failure is reported as a rule. L3, L4, `decision`, `reviewer`, a wrong model or provider, an alias, a closed or unknown pool, a personal or paused profile, and a stale, missing, exhausted, or unprotected reading are refused. An explicit profile name does not skip an empty or paused matrix.

Google execution and Google batch work reserve a reviewer whose actual family is not Google. The actual family comes from the provider and model, so a hand-edited family label does not choose a same-family reviewer or avoid a configured family ban. A stored run keeps that factual family and the policy id `antigravity-acp-1.3.0-medium-L1L2-v1`. Resume refuses a Google run that does not carry that policy id.

Non-Google profiles keep this repository's existing route, including higher tiers where those routes already allowed them. Public defaults stay empty: `DEFAULT_FAMILIES` is `{}`, and `DEFAULT_BANNED` has empty provider, family, pool, and model lists. A ban that is actually configured still applies.

## Read-only roles

`reader`, `decision`, and `reviewer` are decided before `auto_accept`. At create time those roles force `auto_accept` off. A Google profile also forces mode `default`. The stored profile is not rewritten. A supervisor request still returns `ignore`, leaving approval to the host.

`reader` and `decision` may read or search only with a live task binding, an approved absolute root, and a path that stays inside that root. Writes, shell writes, mode switches, title-only paths, and symlink escapes are denied. `auto_accept` does not override that deny. Reviewer shell reads stay on the existing narrow command list. `file` is no longer a simple command: only explicit classification options are accepted, and compile, decompress, or unknown arguments are denied. `gh api` is denied, including method and field flags; `gh pr`, `gh issue`, `gh repo`, and `gh run` reads remain. `tree` short options `L`, `P`, and `I` must be the last character of their token and consume the next argument. Attached ambiguous forms are denied. Safe reads such as `file -i`, `file -m`, `tree -aL 2`, and `tree -I pattern` remain allowed by the gate.

Google batch work enters review on completion and on quiet handoff. Batch work that is not Google still goes straight to acceptance. Only work that enters review commits its worktree on quiet handoff.

## Source comparison

The behavior above follows the accepted private security revision. Theme and panel-preference edits from that private branch were not part of the accepted security result and were not copied. Private fleet defaults, private reports, and private fixtures were not copied.

Public adaptations:

- Routing keeps this tree's names (`familyDispatchBlock`, `poolUnseenReason`, `modelNotAllowed`, `fastNotAllowed`, `depthNotAllowed`, `profileBannedReason`, `isDispatchBanned`). Google checks call `listForRole`, so `starTiers` still falls back to `star`.
- The pause mark is built from code points. The same words exist only in `shared/locales/zh-CN.json`.
- `index.server.ts` imports `permissionContext` and still loads panel preferences for the font step only. Leader-start host handlers stay.
- `profilesFromRpcConfig` and the public brief-file isolation tests stay.
- The permission probe is `test/antigravity-permissions-probe.ts`. It is not under `scripts/`, because `scripts/`, `.githooks/`, and `.github/workflows/` must stay byte-identical with the public Fleet checkout. No dependency was added.

`git diff 7ae3575 -- scripts .githooks .github` is empty.

## Local evidence

Isolated home, Paseo home, transcripts, data, roles, agents, worktrees, loopback, npm cache, and temporary directories were set before the checks. Project root override was empty. Tokens and `PASEO_URL` were unset. No daemon, provider, relay, or session was started. No credential or history was copied.

The local probe calls the production permission hook with a simulated provider and then, only after an allow, a local read or an allow-listed local command (`cat`, `uniq`, `find`, guarded `git grep`, `file -i`, `file -m`, `gh pr view --help` with empty tokens and `GH_HOST` set to an unused loopback address). `tree` and the denied forms are gate-only: the dangerous command is not executed. Sentinel text is synthetic.

| Check | Exit | Result |
| --- | ---: | --- |
| `node --import tsx test/antigravity-permissions-probe.ts --fixture <new temp directory>` | 0 | 126 cases: 30 allow, 96 deny. 30 local handlers ran. `realProviderEvent` false. `realAcpLifecycle` false. Directory fingerprint unchanged. |
| `node --import tsx test/antigravity-permissions-probe.ts --replay <anonymous events>` | 0 | 6 supplied reader requests. Read allowed with `autoAccept` false and true. Edit and mode-switch denied with `autoAccept` true. `realProviderEvent` false. The scope was supplied by the operator, not by a live task. |
| `file --version` | 0 | file 5.41 |
| `gh --version` | 0 | gh 2.101.0 |
| `command -v tree` | 1 | `tree` is not installed. No `tree` command was executed. |
| `lsof -nP -iTCP:18829 -sTCP:LISTEN` | 1 | No listener. |
| `npm run verify` with `FLEET_CONTRACT_SOURCE` set to public Fleet `9ca083f6561a6062f028cac85f7a26437de2abf0` and `PASEO_FLEET_SIBLING` unset | 0 | All 12 gates passed. Shared-gate step reported that no sibling was given. |
| Same verify with `PASEO_FLEET_SIBLING` set to that Fleet checkout | 1 | Eleven gates passed. `compare-scripts` reported one difference: Fleet alone has `scripts/check-antigravity-isolation.mjs`. |

The eleven passing gates in the sibling run were: typecheck (431 files), script tests (115), CLI build, Paseo build (`@getpaseo/server` 0.11.2, client 560885 bytes, server 10843616 bytes), plugin tests (2544 regression and 54 performance, 0 failed, 0 skipped), privacy scan (554 files, 0 hits), next-commit identity, history identity (59 commits), gitleaks (62 commits, no leaks), contract (9 files), and package whitelist (254 files). The plugin regression includes the new authorization tests. Those history counts are from that run, before this note was committed. A later privacy scan of the tree, including this note, scanned 555 files and found 0 hits.

That Fleet script imports Fleet quota modules this repository does not have. Copying it would change the shared gate set and would not run here. It was not copied. Both maintainers still need to decide whether that file stays in the shared `scripts/` directory. This card does not make that change.

## Inherited provider evidence

The accepted private revision reported a permission-hook probe with a simulated provider, `realProviderEvent` false, and no real ACP permission events. This public tree did not open an official ACP connection and did not repeat that probe against a live provider. The local results above are the public run. They are not a live ACP test, a live quota reading, or a live cross-family review. Unit tests are not proof of a real read or a real deny.

## Still open

- No live official ACP permission event, quota reading, model task, structured board identity, full card lifecycle, or live cross-family review was produced here.
- `git log` still does not reject `-u`, `--cc`, `-c`, or `--raw`. Those forms may invoke a textconv helper. This was left for a later reviewed change.
- Reviewer `fetch` of an arbitrary `http:` or `https:` URL remains allowed by the shell gate.
- When an isolated home directory sits inside the task temporary root, case-variant spellings of that home are not an extra proven exclusion.
- A search directory with more than 50,000 entries, or a file whose `nlink` is not 1, is denied as a whole. Callers need a smaller directory that the gate can check.
- The path gate is not an atomic open and is not an OS sandbox. It does not prove safety against a path that changes after the check.
- Real bans, pauses, pool flags, and dispatch flags were not changed. Nothing was pushed, merged, tagged, released, or reloaded.

## Subsequent local helper and identity repair

The history above records its own tested revision. The later accepted source
repair is now synchronized locally: effective Git log helper/signature guards
and a safe explicit format, real device/inode scope ancestry, and refusal of a
short-value option consuming an independent separator.
[The integrated validation report](READONLY-VALIDATION.md) fixes the source and
public code revisions and records fresh joint regressions, both real volume
types, simulated-provider production-hook probes and the complete twelve local
gates with the real fixed Fleet sibling. It supersedes the two earlier local
code gaps about Git log and isolated HOME aliases; the other evidence limits
and existing historical results remain as recorded above. This is local source
validation. Official ACP, real quota/model tasks, the full live lifecycle,
independent high-risk acceptance and deployment remain separate gates. Freeze,
pauses and explicit different-family mitigation remain in force.
