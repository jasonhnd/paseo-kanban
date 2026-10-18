# Hermes Leader integration

A Paseo leader profile may use the existing `hermes` ACP provider. Setting its
Paseo role to `supervisor` makes it available in the project's Leader creation
panel; it does not create another Hermes profile. Creation delivers the complete
board protocol as a visible first message and verifies self-registration separately.
Hermes handover reuses the provider/model and workspace and binds a scoped guest
identity. Before the successor's first turn, it asks the current leader to run the
project's registration handover and verifies that the registry points to the new
session. It does not bypass the existing leader-ownership check. Creation and
message delivery are idempotent across retries; a changed owner stops the transfer.
The old session must be idle and have no pending permission request. A fallback
leader transfers its fallback registration. One identity shared by multiple
registrations is refused so a single-project shift cannot archive another
project's leader.

## Curated-memory refresh

Hermes' built-in memory tool remains the writer. `memory_bridge.py` is an optional
stdlib-only ACP JSONL transport wrapper. It reads the selected profile's existing
`memories/MEMORY.md` and `memories/USER.md` before each ordinary prompt. A changed
snapshot is appended as reference data, without changing the system prompt or
creating another memory store. A successful `end_turn` acknowledges the revision;
cancelled or failed turns retry it. Slash commands are unchanged. Missing files
are deletion snapshots; a missing root, unreadable file or oversized file stops
the prompt with an error instead of silently using stale memory.

Example provider command argv (replace each placeholder with an absolute path):

```json
["python3", "/path/to/memory_bridge.py", "--memory-dir", "/path/to/existing-profile/memories", "--", "hermes", "-p", "existing-profile", "acp"]
```

Configure this on the **test daemon first**, using the normal `hermes` provider id.
The wrapper must point at the same profile as the child command. It does not read,
copy or change authentication configuration. Permissions and tools remain the
existing Hermes profile's; board registration is a separate project authority.

This bridge updates the two built-in curated-memory files between user turns. It
does not merge conflicting semantic edits, refresh arbitrary skill files, or
replace authoritative project documents. Hermes retains its own atomic memory
writes and durable session leases. Project-specific entries must name their scope.
A production rollout needs separate approval and must not replace existing leaders
as part of a pilot.

## Client navigation and model checks

Board and Fleet session buttons use the current client's host-qualified navigation.
Workspace validation reads the selected `PASEO_HOME`; it never falls back to the
default home. The legacy desktop-opening RPC returns an error instead of launching
the desktop app, including for an older client. Reopen the test page after updating
the plugin so it loads the current client bundle.

Before a pilot creates a session, wait for the provider's model list to finish
loading and check the selected model again. Verify the resulting session's runtime
model as well as the saved profile, and repeat that check for the handover successor.

Tests: `python3 -m unittest discover -s integrations/hermes -p 'test_*.py'` plus
`test/leader-start.test.ts` and `server/fleet/test/leader-swap.test.ts` after building.

## Installing without replacing active sessions

To keep an existing provider command unchanged, add a dedicated Paseo provider
with id `hermes-leader`, `extends: "acp"`, and the wrapper command above. Point it
at the same existing profile and memories. This is a Paseo launch alias, not a
new Hermes profile or a second knowledge store. Both `hermes` and `hermes-leader`
use the visible leader protocol and registration handover. Other ACP providers
do not gain that behavior by name similarity.

Create a new Paseo profile for that alias with `role: "supervisor"` and an explicit
model. Keep existing profile IDs, leader registrations and session models intact.
The successor keeps the original model. For an Opus-only deployment, select the
exact Opus model in this new supervisor profile and verify it after the catalog
finishes loading. An active session is never switched as part of installation.

Update only this plugin using the host's plugin source update. That briefly
restarts its plugin worker and RPC tools, not the daemon or provider sessions.
Schedule the switch while no board RPC or lifecycle operation is in progress,
retain the prior plugin source for rollback, and compare leader registrations,
provider-session identities and daemon process IDs before and after. Do not use
a daemon restart to apply this integration.
