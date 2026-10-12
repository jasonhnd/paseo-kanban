# Write-call provenance

The board authenticates a card's agent identity. It cannot reliably bind an MCP
or CLI write to the provider's foreground thread or current turn. A background
thread with the same credentials remains indistinguishable from the foreground
thread. This implementation audits writes; it does not claim to reject
background memory consolidation.

## Recorded evidence

`server/write-source.ts` uses AsyncLocalStorage to isolate each invocation. Host
entry points choose `mcp` or `cli`; direct tool calls use `in-process`. The server
generates a request ID. Arguments, headers, JSON-RPC IDs and inherited thread
environment variables cannot supply trusted provenance.

`write_audits` stores the timestamp, operation, authenticated identity's task ID
and role, source JSON, outcome and error code. The source contains the agent ID
and its latest observed board run ID. That run describes the identity; it does
not prove which run made the call. Provider `threadId`, `turnId` and `toolCallId`
remain null, and `provenance` is always `identity_only`.

The task ID belongs to the caller's card, not a target card named in arguments.
Terminal and leader identities have no caller task ID. Known write attempts that
fail authentication are recorded with null agent and run IDs. Tokens, raw
headers, arguments, summaries and full error messages are not retained.

An audit starts with `started`, becomes `returned` when the entry returns, or
`threw` with an error code. `returned` does not mean review or final acceptance
passed. An interrupted call may leave `started`. CLI/tool nesting records one
attempt. Read commands and dry-runs do not add audit rows. Native-session write
commands resolve identity through an already-open read-only database before
auditing; they do not create or rotate supervisor credentials. Maintenance
commands record their own audit after the backup and operation so old-schema
backups remain untouched by migration.

## Completion behavior

Completion adds no provenance or handoff-format board comments or events. Normal,
missing and arbitrarily structured handoffs retain their existing routing,
summary, PR contract and external-wait behavior. The fields `files`,
`verification` and `risks` have no newly imposed types.

An invalid JSON string may leave a stored note in the top-level
`handoff_json.submissionWarnings`. The original string is retained. That note is
not added to the summary, does not create a comment or event, does not block
completion, and provides no provenance evidence. Successfully parsed JSON of any
shape and non-string handoffs produce no such note. Internal flow calls do not
pretend to be provider calls.

## Retention and migration

The table and index are created idempotently by the existing database migration.
`compact-events` expires audit rows where `at < now - N days`, with a default of
30 days and the existing `--days N` override. Rows exactly at the boundary stay.
Unlike workflow events, audit expiry includes unfinished cards, orphan calls,
authentication failures and interrupted `started` calls.

Dry-run opens the database read-only. A legacy database without the table reports
zero audit rows without migration or token creation. Apply makes and checks a
consistent backup first, selects audit IDs from that snapshot, and deletes them
in the same transaction as expired events. Calls appended after the backup stay
until a later run, even with an old timestamp. Cards, comments and handoffs are
outside this deletion set.

`writeAuditsBefore`, `expiredWriteAudits` and `writeAuditsAfter` are separate from
the event counters. A CLI maintenance call's own audit is appended afterwards
and is outside its returned counts. Existing backup retention keeps the newest
two backups, which contain the deleted rows. SQLite audit write failures can
fail the call. The audit shares the board database's local trust boundary and is
not an independent tamper-resistant log.

## What trusted binding would require

Paseo would need a broker at the actual provider tool-execution boundary that
binds the agent, run, provider thread, turn, tool call and trigger type. Its proof
must reach the plugin over an authenticated channel that the model cannot forge,
and bind the operation, argument digest, single-use nonce and expiry. CLI calls
need the same boundary. Static headers, inheritable environment variables,
foreground busy state and persisted session IDs cannot establish per-call proof.

Such a broker also needs replay protection and lifecycle handling for resume,
rework and rebinding. Until it exists, a same-identity background call with a
valid handoff can still write.

## Regression coverage

```sh
node --import tsx --import ./test/helpers/i18n-preload.ts --test \
  test/write-source.test.ts test/compact-events.test.ts \
  test/compact-retention.test.ts test/db-migration.test.ts
```

Tests use a loopback HTTP MCP server, separate bundled CLI processes and
synthetic credential fixtures. They cover forged headers/arguments/environment,
concurrent identities, nested audit deduplication, accepted handoff shapes,
credential preservation, rejected writes, retention boundaries, old schemas
and snapshot races. They simulate indistinguishable foreground/background calls;
they do not launch a real provider background task or connect to a real daemon.
