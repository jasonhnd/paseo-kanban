/// <reference types="node" />
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { t, translate } from "../shared/i18n";
import { LEADER_LABEL } from "../shared/labels";
import type { LeaderStartState } from "../shared/leader-start";
import { isHermesLeaderProvider } from "./leader-provider";
import { BOARD_AGENT_ENV } from "./agent-env";
import { projectSupervisor, resolveConfiguredProject } from "./config";
import { assertProjectInPaseo } from "./paseo-projects";
import { withConfigLock } from "./config-lock";
import { getDb } from "./db";
import { KanbanError } from "./errors";
import { takeProtocolReceipt } from "./inject";
import { leaderPresence } from "./leader-registry";
import { stableLauncherPath } from "./stable-bin";
import { buildAgentConfig, readProfiles, type Profile } from "./profiles";
import { PROTOCOL_VERSION, protocolFor } from "./protocol";
import { bindTokenAgent, issueToken } from "./tokens";

export interface LeaderWorkspace {
  id: string;
  path: string;
}

export interface LeaderStartHost {
  workspaces(project: string): Promise<LeaderWorkspace[]>;
  create(input: {
    workspaceId: string;
    title: string;
    env: Record<string, string>;
    config: ReturnType<typeof buildAgentConfig>;
  }): Promise<{ id: string }>;
  find?(requestId: string): Promise<{ id: string } | null>;
  send(agentId: string, text: string, messageId?: string): Promise<void>;
}

const inFlight = new Set<string>();

interface Selection {
  project: string;
  profileId: string;
  workspaceId: string;
  language: "en" | "zh-CN";
}

function latest(project: string): { id: number; value: LeaderStartState } | null {
  const row = getDb().prepare("SELECT id, data_json FROM supervisor_events WHERE kind = 'leader_start' AND project = ? ORDER BY id DESC LIMIT 1").get(project) as
    | { id: number; data_json: string }
    | undefined;
  return row ? { id: row.id, value: JSON.parse(row.data_json) as LeaderStartState } : null;
}

function save(id: number, value: LeaderStartState): LeaderStartState {
  getDb().prepare("UPDATE supervisor_events SET data_json = ? WHERE id = ?").run(JSON.stringify(value), id);
  return value;
}

/** The registry is authoritative; a persisted registration can be revoked or replaced. */
function registrationState(value: LeaderStartState, registered: string | null): LeaderStartState {
  if (value.agentId && registered === value.agentId && value.state !== "protocol-missing") {
    return { ...value, state: "registered" };
  }
  if (registered && registered !== value.agentId) return { ...value, state: "conflict" };
  return value.state === "registered" ? { ...value, state: "ready" } : value;
}

function leaderProfiles(): Profile[] {
  return readProfiles().filter((profile) => Boolean(profile.model?.trim()) && (profile.role === "supervisor" || (profile.role === "candidate" && profile.candidateFor === "supervisor")));
}

function assertAvailable(project: string): void {
  const previous = projectSupervisor(project);
  if (previous && leaderPresence(previous) !== "gone") throw new KanbanError("conflict", t("leaderStart.error.present"));
}

async function selection(input: Selection, host: LeaderStartHost): Promise<{ project: string; profile: Profile; workspace: LeaderWorkspace }> {
  const project = resolveConfiguredProject(input.project, "Start leader");
  assertProjectInPaseo(project);
  const profile = leaderProfiles().find((item) => item.id === input.profileId);
  if (!profile) throw new KanbanError("invalid", translate(input.language, "leaderStart.error.chooseProfile"));
  const workspace = (await host.workspaces(project)).find((item) => item.id === input.workspaceId);
  if (!workspace) throw new KanbanError("invalid", translate(input.language, "leaderStart.error.chooseWorkspace"));
  return { project, profile, workspace };
}

export async function leaderOptions(projectArg: string, host: LeaderStartHost) {
  const project = resolveConfiguredProject(projectArg, "Start leader");
  const current = latest(project);
  const hidden = current?.value.agentId && leaderPresence(current.value.agentId) === "gone";
  const supervisorId = projectSupervisor(project);
  return {
    project,
    version: PROTOCOL_VERSION,
    cli: stableLauncherPath(),
    profiles: leaderProfiles().map(({ id, name, provider, model }) => ({ id, name, provider, model: model ?? null })),
    workspaces: await host.workspaces(project),
    existingAgentId: supervisorId && leaderPresence(supervisorId) !== "gone" ? supervisorId : null,
    start: hidden || !current ? null : registrationState(current.value, supervisorId),
  };
}

export async function previewLeader(input: Selection, host: LeaderStartHost) {
  const { project, workspace } = await selection(input, host);
  assertAvailable(project);
  return {
    requestId: randomUUID(),
    directory: workspace.path,
    version: PROTOCOL_VERSION,
    protocol: protocolFor("supervisor", { language: input.language }),
  };
}

function introduction(value: LeaderStartState): string {
  const intro = translate(value.language, "leaderStart.intro", {
    project: JSON.stringify(value.project),
    version: value.version,
    cli: JSON.stringify(stableLauncherPath()),
  });
  // ACP does not transport Paseo's creation-only systemPrompt. A visible first
  // message is the portable delivery path, including after a failed send.
  return value.deliveryMode === "session-message"
    ? `${protocolFor("supervisor", { language: value.language })}\n\nProtocol ${value.version}\n\n${intro}`
    : intro;
}

function rememberToken(project: string, requestId: string, token: string): void {
  const tokenRow = getDb().prepare("SELECT rowid AS id FROM tokens WHERE token = ?").get(token) as { id: number } | undefined;
  if (!tokenRow) return;
  getDb()
    .prepare("INSERT INTO supervisor_events (at, kind, project, actor, data_json) VALUES (?, 'leader_start_identity', ?, ?, ?)")
    .run(new Date().toISOString(), project, requestId, JSON.stringify({ tokenRowId: tokenRow.id }));
}

/** Persist the claim before calling the host. A failed or timed-out create stays pending and is not retried blindly. */
export async function startLeader(input: Selection & { requestId: string }, host: LeaderStartHost): Promise<LeaderStartState> {
  const project = resolveConfiguredProject(input.project, "Start leader");
  const existing = latest(project);
  if (existing && (existing.value.state === "pending" || !existing.value.agentId || leaderPresence(existing.value.agentId) !== "gone")) return existing.value;
  const picked = await selection(input, host);
  const claimed = withConfigLock(() => {
    const race = latest(project);
    if (race && (race.value.state === "pending" || !race.value.agentId || leaderPresence(race.value.agentId) !== "gone")) return { id: race.id, value: race.value, owned: false as const };
    assertAvailable(project);
    const value: LeaderStartState = {
      ...input,
      project,
      directory: picked.workspace.path,
      state: "pending",
      agentId: null,
      version: PROTOCOL_VERSION,
      deliveryMode: null,
    };
    const inserted = getDb()
      .prepare("INSERT INTO supervisor_events (at, kind, project, actor, data_json) VALUES (?, 'leader_start', ?, 'ui', ?)")
      .run(new Date().toISOString(), project, JSON.stringify(value));
    return { id: Number(inserted.lastInsertRowid), value, owned: true as const };
  });
  if (!claimed.owned) return claimed.value;
  inFlight.add(input.requestId);
  const token = issueToken("guest", null, null);
  rememberToken(project, input.requestId, token);
  const temporaryDirectory = join(tmpdir(), "kanban-leaders", input.requestId);
  mkdirSync(temporaryDirectory, { recursive: true });
  try {
    const agent = await host.create({
      workspaceId: picked.workspace.id,
      title: `${LEADER_LABEL} · ${project}`,
      config: buildAgentConfig(picked.profile),
      env: {
        [BOARD_AGENT_ENV]: "1",
        KANBAN_ROLE: "supervisor",
        KANBAN_PROJECT: project,
        KANBAN_LANGUAGE: input.language,
        KANBAN_LEADER_START: input.requestId,
        KANBAN_TOKEN: token,
        KANBAN_CLI: stableLauncherPath(),
        TMPDIR: temporaryDirectory,
        KANBAN_TMP: temporaryDirectory,
      },
    });
    bindTokenAgent(token, agent.id);
    const receipt = takeProtocolReceipt(input.requestId);
    const verified = receipt?.version === PROTOCOL_VERSION && receipt.role === "supervisor" && receipt.mcp;
    const value = save(claimed.id, {
      ...claimed.value,
      agentId: agent.id,
      state: verified ? "ready" : "protocol-missing",
      deliveryMode: verified ? (isHermesLeaderProvider(picked.profile.provider) ? "session-message" : "systemPrompt") : null,
    });
    if (!verified) return value;
    try {
      await host.send(agent.id, introduction(value), `leader-start:${value.requestId}`);
    } catch {
      return save(claimed.id, { ...value, state: "delivery-failed" });
    }
    return value;
  } catch {
    return claimed.value;
  } finally {
    inFlight.delete(input.requestId);
  }
}

/** Registration is read from the registry. Creation and a prompt do not count as registration. */
export async function leaderStatus(projectArg: string, host: LeaderStartHost): Promise<LeaderStartState | null> {
  const project = resolveConfiguredProject(projectArg, "Check leader");
  const row = latest(project);
  if (!row) return null;
  if (row.value.agentId && leaderPresence(row.value.agentId) === "gone") return null;
  if (row.value.state === "pending" && !inFlight.has(row.value.requestId) && host.find) {
    const found = await host.find(row.value.requestId);
    if (found) {
      const link = getDb().prepare("SELECT data_json FROM supervisor_events WHERE kind = 'leader_start_identity' AND actor = ? ORDER BY id DESC LIMIT 1").get(row.value.requestId) as
        | { data_json: string }
        | undefined;
      const tokenRowId = link ? (JSON.parse(link.data_json) as { tokenRowId?: number }).tokenRowId : null;
      const token = tokenRowId
        ? getDb().prepare("SELECT token FROM tokens WHERE rowid = ? AND role = 'guest'").get(tokenRowId) as { token: string } | undefined
        : undefined;
      if (token) bindTokenAgent(token.token, found.id);
      const receipt = takeProtocolReceipt(row.value.requestId);
      const verified = receipt?.version === PROTOCOL_VERSION && receipt.role === "supervisor" && receipt.mcp;
      row.value = save(row.id, {
        ...row.value,
        agentId: found.id,
        state: verified ? "delivery-failed" : "protocol-missing",
        // The recovered provider may use ACP. Re-deliver the complete protocol
        // visibly instead of assuming a creation-only system prompt arrived.
        deliveryMode: verified ? "session-message" : null,
      });
    }
  }
  const projected = registrationState(row.value, projectSupervisor(project));
  if (projected.state === "conflict") return projected;
  if (projected.state !== row.value.state) row.value = save(row.id, projected);
  if (row.value.state === "registered") return row.value;
  if (row.value.state === "delivery-failed" && row.value.agentId) {
    try {
      await host.send(row.value.agentId, introduction(row.value), `leader-start:${row.value.requestId}`);
      return save(row.id, { ...row.value, state: "ready" });
    } catch {
      return row.value;
    }
  }
  return row.value;
}

/** Visible recovery. It cannot change the system prompt of a session that already exists. */
export async function recoverLeader(projectArg: string, host: LeaderStartHost): Promise<LeaderStartState> {
  const project = resolveConfiguredProject(projectArg, "Recover leader");
  const row = latest(project);
  if (!row?.value.agentId || row.value.state !== "protocol-missing") {
    throw new KanbanError("invalid", translate(row?.value.language ?? "en", "leaderStart.error.recoverNeedsSession"));
  }
  const protocol = protocolFor("supervisor", { language: row.value.language });
  await host.send(row.value.agentId, `${translate(row.value.language, "leaderStart.recovery")}\n\n${protocol}\n\n${introduction(row.value)}`, `leader-recovery:${row.value.requestId}`);
  return save(row.id, { ...row.value, state: "ready", deliveryMode: "session-message" });
}
