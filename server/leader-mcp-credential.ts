/// <reference types="node" />
import { closeSync, fchmodSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { envAgentId } from "./agent-id";
import { withConfigLock } from "./config-lock";
import { getDb } from "./db";
import { KanbanError } from "./errors";
import { registeredLeaderMcpIdentity } from "./identity";
import { readSavedMcpPort } from "./mcp-port";
import { deleteToken, issueToken, LEADER_MCP_ROLE, type Identity } from "./tokens";

export const LEADER_MCP_TOKEN_TTL_MS = 8 * 60 * 60_000;

/** Local CLI bootstrap only. Neither an HTTP request nor a caller-supplied agent argument can mint a credential. */
export function exportLeaderMcpCredential(identity: Identity, env: NodeJS.ProcessEnv, output: string): unknown {
  return withConfigLock(() => {
    const agentId = envAgentId(env);
    if (!agentId || identity.agentId !== agentId || identity.role !== "supervisor" || identity.taskId !== null
      || !registeredLeaderMcpIdentity(agentId)) {
      throw new KanbanError("forbidden", "Only the calling registered leader session can export an MCP credential.");
    }
    if (!isAbsolute(output)) throw new KanbanError("invalid", "Use --out with a new absolute file path in an existing private directory.");
    const port = readSavedMcpPort();
    if (!port) throw new KanbanError("conflict", "No saved MCP endpoint is available. Start the plugin before exporting a credential.");
    const expiresAt = new Date(Date.now() + LEADER_MCP_TOKEN_TTL_MS).toISOString();
    let fd: number | undefined;
    let created = false;
    let token: string | undefined;
    try {
      // Exclusive creation refuses existing files and symlinks, including a dangling symlink.
      fd = openSync(output, "wx", 0o600);
      created = true;
      fchmodSync(fd, 0o600);
      token = issueToken(LEADER_MCP_ROLE, null, agentId);
      getDb().prepare("UPDATE tokens SET expires_at = ? WHERE token = ?").run(expiresAt, token);
      writeFileSync(fd, `${JSON.stringify({ type: "http", url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: `Bearer ${token}` } }, null, 2)}\n`);
      closeSync(fd);
      fd = undefined;
      // Rotate only after the new private file is complete; a failed export keeps the previous credential usable.
      getDb().prepare("DELETE FROM tokens WHERE role = ? AND agent_id = ? AND token != ?").run(LEADER_MCP_ROLE, agentId, token);
    } catch {
      if (fd !== undefined) { try { closeSync(fd); } catch { /* Already closed. */ } }
      if (token) deleteToken(token);
      if (created) { try { unlinkSync(output); } catch { /* No usable credential was returned. */ } }
      throw new KanbanError("invalid", "Could not create the private MCP credential file. Use a new absolute file path in an existing private directory.");
    }
    // Do not return the bearer in CLI output, tool results, hints or write audits.
    return { ok: true, agentId, path: output, expiresAt,
      text: `Private MCP configuration written to ${output}; expires at ${expiresAt}. Load it through the host's supported session MCP configuration and reconnect.` };
  });
}
