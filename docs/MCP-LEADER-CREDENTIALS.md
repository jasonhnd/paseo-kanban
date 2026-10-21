# MCP credentials for existing leader sessions

[Simplified Chinese](zh-CN/MCP-LEADER-CREDENTIALS.md)

A hand-opened or incoming leader can register through the local CLI without a `KANBAN_TOKEN`. Registration alone cannot change an existing session's HTTP MCP headers. An unauthenticated `kanban_ping` confirms connectivity; business tools still require a Bearer credential.

## Export from the registered session

Run the installed CLI from the leader session, retaining its inherited `PASEO_AGENT_ID`:

```sh
paseo-kanban supervise --project demo
paseo-kanban mcp-credential --out "$KANBAN_TMP/leader-mcp.json"
```

For an incoming leader, complete the supported `handover` flow first. `KANBAN_TMP` must name an existing absolute private directory. Use a new filename for every export. The command refuses relative paths, existing files and symlinks. It writes an HTTP MCP server configuration with the saved loopback endpoint and its Authorization header, with file permissions `0600`. Standard output contains only the path, agent id and expiry; write audits contain no credential.

Load that private file as the session's Kanban HTTP MCP server entry through the host's supported configuration mechanism, then reconnect MCP. The command does not edit host configuration or update a running session. If the host cannot update an existing session, continue using the local CLI with the inherited agent identity. Keep the file and header out of conversations, reports, source control and shared configuration.

The exported credential expires after eight hours. Exporting again rotates the agent's earlier exported credentials; reconnect with the new file. A failed export leaves the previous credential usable. Leaders started by the board retain their existing injected guest-token/self-registration path.

## Identity and revocation

The new credential stores role `leader-mcp`, no card id, a specific agent id and an expiry. It never contains the global supervisor token. Every MCP call validates the opaque token, then resolves current registration and the real agent role. Worker and scheduled sessions cannot export or use this credential. Unregistered, unbound, expired and revoked credentials are rejected even for `list` and `show`.

Project and board leader setters revoke the outgoing agent's exported credentials before changing registration. This covers `supervise`, `handover` and the leader settings UI. Losing any registration revokes all that agent's exported credentials, even if it still leads another project. Re-registering does not revive them. Idempotent registration preserves a current credential. The remaining leader can export again with its current authority.

Removing a project through Settings also revokes the outgoing agent's exports before saving, under the same configuration lock as credential export. Unchanged registrations and settings edits rejected by revision or document validation preserve their credentials.

The credential grants the current leader identity under existing project and card scope checks. It does not grant unrestricted terminal-supervisor authority. Live resolution also rejects an agent that becomes a worker or a scheduled session, or whose registration cannot be read. The tokenless terminal identity branch is unchanged.

## Trust boundary

Bootstrap uses the existing trusted local CLI environment, not identity supplied by an MCP client. There is no HTTP issuance endpoint. An `X-Paseo-Agent-Id` header, a request-body agent id, a token in the URL or the fixed `Mcp-Session-Id` cannot authenticate a request. Changing a Bearer value without knowing a valid random credential fails validation.

Only the local account creating the file can read it through its file permissions, unless the account deliberately shares it. A holder of a copied Bearer can act as that bound agent until rotation, revocation or expiry; the server cannot distinguish copies. Already authorized in-flight calls are not cancelled. Processes running as the same OS user remain trusted: they can already change the CLI environment and read the board database or supervisor token. This feature does not isolate hostile processes sharing that account.

## Early-reset diagnostics

Early-reset notices route only through the configured AFC `opsProject` entry in `kanban.config.json`'s `supervisors` table, with case-insensitive project matching and exact keys taking priority. `supervisorAgentId` is not a fallback for this route.

When registration is missing, the diagnostic names the AFC project and the registration field. One process logs it once per continuous missing-project state; case-only project changes do not repeat it. Recovery or changing the project allows a new diagnostic. Notices remain pending, retry on later rounds and are marked only after a successful send. The existing seven-day delivery window remains in effect.
