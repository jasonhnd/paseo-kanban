/// <reference types="node" />
import { randomBytes } from "node:crypto";
import { t } from "../shared/i18n";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "./perf-fs";
import { join } from "node:path";
import { getDb } from "./db";
import { KanbanError } from "./errors";
import { dataDir } from "./paths";

export interface Identity {
  role: string;
  taskId: number | null;
  agentId: string | null;
}

// Server-local proof of bearer validation. A copied identity object, header or agent-id env label
// cannot acquire it. Keep the credential out of serialized identities and audit payloads.
const cardCredentials = new WeakMap<Identity, string>();

/** Recheck a validated card bearer, including revocation/expiry during an asynchronous operation. */
export function hasLiveCardCredential(identity: Identity): boolean {
  const token = cardCredentials.get(identity);
  if (!token) return false;
  const row = getDb().prepare("SELECT role, task_id, agent_id, expires_at FROM tokens WHERE token = ?").get(token) as
    | { role: string; task_id: number | null; agent_id: string | null; expires_at: string | null }
    | undefined;
  return Boolean(row && !tokenExpired(row.expires_at) && row.task_id != null && row.agent_id &&
    row.role === identity.role && row.task_id === identity.taskId && row.agent_id === identity.agentId);
}

/** An agent identity credential, never an unrestricted supervisor or a card-worker token. */
export const LEADER_MCP_ROLE = "leader-mcp";

function tokenPath(): string {
  return join(dataDir(), "supervisor.token");
}

/** The token file is missing (null) or holds a token. An empty or unreadable file is an error: it is never replaced. */
function readTokenFile(path: string): string | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const token = text.trim();
  if (!token) throw new KanbanError("invalid", t("tokens.emptyFile", { path }));
  return token;
}

function hasSupervisorRow(token: string): boolean {
  return Boolean(getDb().prepare("SELECT 1 AS n FROM tokens WHERE token = ? AND role = 'supervisor' AND task_id IS NULL").get(token));
}

/** Write through a temp file in the same directory, so a reader sees the old file or the whole new one, never half. */
function writeTokenFile(path: string, token: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${token}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // never created, or the rename already moved it
    }
    throw err;
  }
}

/**
 * The supervisor token is the one in supervisor.token, with exactly one matching row in the database.
 * Anything that has to change runs inside BEGIN IMMEDIATE, so two processes starting at once take turns:
 * the second sees the first's file and row and returns that token instead of making another.
 * The row is written first and the file second; if the file write fails, the row is rolled back.
 */
export function ensureSupervisorToken(): string {
  mkdirSync(dataDir(), { recursive: true });
  const path = tokenPath();
  const db = getDb();
  const settled = readTokenFile(path);
  if (settled && hasSupervisorRow(settled)) return settled;
  db.exec("BEGIN IMMEDIATE");
  try {
    const existing = readTokenFile(path);
    if (existing && hasSupervisorRow(existing)) {
      db.exec("COMMIT");
      return existing;
    }
    const token = existing ?? randomBytes(32).toString("hex");
    db.prepare("DELETE FROM tokens WHERE role = 'supervisor' AND task_id IS NULL").run();
    db.prepare("INSERT OR REPLACE INTO tokens (token, task_id, role, agent_id, created_at) VALUES (?, NULL, 'supervisor', NULL, ?)").run(token, new Date().toISOString());
    if (!existing) writeTokenFile(path, token);
    else chmodSync(path, 0o600);
    db.exec("COMMIT");
    return token;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // the transaction already ended
    }
    throw err;
  }
}

export function issueToken(role: string, taskId: number | null, agentId: string | null): string {
  const token = randomBytes(32).toString("hex");
  getDb()
    .prepare("INSERT INTO tokens (token, task_id, role, agent_id, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(token, taskId, role, agentId, new Date().toISOString());
  return token;
}

export function bindTokenAgent(token: string, agentId: string): void {
  getDb().prepare("UPDATE tokens SET agent_id = ? WHERE token = ?").run(agentId, token);
}

/**
 * How long a worker token outlives its card entering done. A closing call can still be in flight and
 * the <leader> can reopen the card within the hour; auto-archive (a day later) and the migration revoke
 * it for good. One hour bounds what a token copied from a log is worth after the card is over.
 */
export const WORKER_TOKEN_GRACE_MS = 60 * 60_000;

/** A token with no expiry (supervisor, live worker) never expires. A bad stamp counts as expired. */
export function tokenExpired(expiresAt: string | null, nowMs = Date.now()): boolean {
  if (expiresAt === null) return false;
  const stamp = Date.parse(expiresAt);
  return !(stamp > nowMs);
}

export function identityFromToken(token: string): Identity {
  const row = getDb().prepare("SELECT role, task_id, agent_id, expires_at FROM tokens WHERE token = ?").get(token) as
    | { role: string; task_id: number | null; agent_id: string | null; expires_at: string | null }
    | undefined;
  if (!row || tokenExpired(row.expires_at)) throw new Error(t("tokens.invalid"));
  const identity = { role: row.role, taskId: row.task_id, agentId: row.agent_id };
  if (row.task_id != null && row.agent_id) cardCredentials.set(identity, token);
  return identity;
}

export function deleteToken(token: string): void {
  getDb().prepare("DELETE FROM tokens WHERE token = ?").run(token);
}

/** Registration changes invalidate exported credentials even if the agent still leads another project. */
export function revokeLeaderMcpTokens(agentId: string | null): void {
  // Configuring a fresh board must not create a database merely to revoke credentials that cannot exist yet.
  if (!agentId || !existsSync(join(dataDir(), "kanban.db"))) return;
  getDb().prepare("DELETE FROM tokens WHERE role = ? AND agent_id = ?").run(LEADER_MCP_ROLE, agentId);
}

/** Drop a worker token. The supervisor token has no agent id and is left alone. */
export function revokeAgentToken(agentId: string | null): void {
  if (!agentId) return;
  getDb().prepare("DELETE FROM tokens WHERE agent_id = ? AND role != 'supervisor'").run(agentId);
}

export function revokeTaskWorkerTokens(taskId: number): void {
  getDb().prepare("DELETE FROM tokens WHERE task_id = ? AND role != 'supervisor'").run(taskId);
}

/** The card is over: its worker tokens stop working after the grace period unless they already expire sooner. */
export function expireTaskWorkerTokens(taskId: number, graceMs = WORKER_TOKEN_GRACE_MS): void {
  const at = new Date(Date.now() + graceMs).toISOString();
  getDb()
    .prepare("UPDATE tokens SET expires_at = ? WHERE task_id = ? AND role != 'supervisor' AND (expires_at IS NULL OR expires_at > ?)")
    .run(at, taskId, at);
}

/** When a new agent of this role starts, older tokens for that role on the card die. */
export function revokeOtherRoleTokens(taskId: number, role: string, keepAgentId: string): void {
  getDb()
    .prepare("DELETE FROM tokens WHERE task_id = ? AND role = ? AND (agent_id IS NULL OR agent_id != ?)")
    .run(taskId, role, keepAgentId);
}

export function readSupervisorTokenFile(): string | null {
  try {
    const token = readFileSync(tokenPath(), "utf8").trim();
    return token || null;
  } catch {
    return null;
  }
}
