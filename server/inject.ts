/// <reference types="node" />
import { BOARD_AGENT_ENV } from "./agent-env";
import type { AgentSessionConfig, McpHttpServerConfig, McpServerConfig } from "@getpaseo/protocol/agent-types";
import { cockpitCli } from "./afc-sources";
import { stableLauncherPath } from "./stable-bin";
import { isLanguage } from "../shared/i18n";
import { PROTOCOL_VERSION, protocolFor } from "./protocol";
import { readSupervisorTokenFile } from "./tokens";

/** Command lines handed to every board agent. Read once at plugin startup; lifecycle callbacks never read files. */
let cliEnvAtStartup: Record<string, string> = {};

/** KANBAN_CLI, and AFC_CLI when the cockpit exports its command line. Call once when the plugin loads. */
export function primeCliEnv(): Record<string, string> {
  const afc = cockpitCli();
  cliEnvAtStartup = { KANBAN_CLI: stableLauncherPath(), ...(afc ? { AFC_CLI: afc } : {}) };
  return { ...cliEnvAtStartup };
}

/** Test hook: forget the primed command lines. */
export function resetCliEnv(): void {
  cliEnvAtStartup = {};
}

/** What `before("agent.create")` is documented to receive. Labels are checked if a future daemon adds them. */
export interface CreateHookRequest {
  config: AgentSessionConfig;
  env?: Record<string, string>;
  labels?: Record<string, string | undefined>;
}

/**
 * Paseo 0.11 passes `{ config, env }` into agent.create. Labels stay on the create options and on
 * later lifecycle events; they do not select the protocol. The board marker environment variable does.
 */
export function shouldInjectMcp(request: Pick<CreateHookRequest, "labels" | "env">): boolean {
  return request.env?.[BOARD_AGENT_ENV] === "1";
}

/** Default role is executor. KANBAN_ROLE=supervisor selects the leader protocol. */
export function roleFromRequest(request: CreateHookRequest): string {
  const role = request.env?.KANBAN_ROLE?.trim();
  return role || "executor";
}

const receipts = new Map<string, { version: string; role: string; mcp: boolean }>();

/** Read and forget the hook receipt for one leader-start request. */
export function takeProtocolReceipt(requestId: string): { version: string; role: string; mcp: boolean } | null {
  const receipt = receipts.get(requestId) ?? null;
  receipts.delete(requestId);
  return receipt;
}

function recordProtocolReceipt(request: CreateHookRequest): void {
  const requestId = request.env?.KANBAN_LEADER_START;
  if (!requestId || request.env?.KANBAN_PROTOCOL_VERSION !== PROTOCOL_VERSION) return;
  if (!request.config.systemPrompt?.includes(PROTOCOL_VERSION)) return;
  if (receipts.size >= 128) {
    const oldest = receipts.keys().next().value;
    if (oldest) receipts.delete(oldest);
  }
  const server = request.config.mcpServers?.kanban;
  receipts.set(requestId, { version: PROTOCOL_VERSION, role: roleFromRequest(request), mcp: server?.type === "http" });
}

export function appendProtocol(request: CreateHookRequest): CreateHookRequest {
  const role = roleFromRequest(request);
  const language = isLanguage(request.env?.KANBAN_LANGUAGE) ? request.env.KANBAN_LANGUAGE : undefined;
  const text = protocolFor(role, { qa: request.env?.KANBAN_QA === "1", worktree: role === "executor" && request.env?.KANBAN_WORKTREE === "1", language });
  const prev = request.config.systemPrompt?.trim() ?? "";
  const body = prev ? `${prev}\n\n${text}` : text;
  const marked = request.env?.KANBAN_LEADER_START ? `${body}\n\nProtocol ${PROTOCOL_VERSION}` : body;
  return {
    ...request,
    env: { ...request.env, KANBAN_PROTOCOL_VERSION: PROTOCOL_VERSION },
    config: {
      ...request.config,
      systemPrompt: marked,
    },
  };
}

/** Hook failures must not block agent creation. A throw means the original request goes through unchanged. */
export function guardCreateHook(request: CreateHookRequest, baseUrl: string): CreateHookRequest | undefined {
  try {
    if (!shouldInjectMcp(request)) return undefined;
    const next = appendProtocol(injectMcp(request, baseUrl) ?? request);
    recordProtocolReceipt(next);
    return next;
  } catch {
    return undefined;
  }
}

function scrubServers(servers: Record<string, McpServerConfig> | undefined, secret: string): Record<string, McpServerConfig> | undefined {
  if (!servers) return servers;
  const next: Record<string, McpServerConfig> = {};
  for (const [name, server] of Object.entries(servers)) {
    if (!server || (server.type !== "http" && server.type !== "sse")) {
      next[name] = server;
      continue;
    }
    const url = server.url.includes(secret) ? server.url.split(secret).join("").replace(/([?&])token=?(&|$)/g, (_match, lead: string, tail: string) => (tail ? lead : "")) : server.url;
    const headers: Record<string, string> = {};
    for (const [key, header] of Object.entries(server.headers ?? {})) {
      if (!header.includes(secret)) headers[key] = header;
    }
    const cleaned = { ...server, url };
    if (Object.keys(headers).length > 0) cleaned.headers = headers;
    else delete cleaned.headers;
    next[name] = cleaned;
  }
  return next;
}

/** The supervisor token must never ride along in an agent's env or MCP config. */
export function stripSupervisorToken(request: CreateHookRequest, secret = readSupervisorTokenFile()): CreateHookRequest {
  if (!secret) return request;
  const env = { ...(request.env ?? {}) };
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string" && value.includes(secret)) delete env[key];
  }
  return {
    ...request,
    env,
    config: {
      ...request.config,
      mcpServers: scrubServers(request.config.mcpServers, secret),
    },
  };
}

export function injectMcp(request: CreateHookRequest, baseUrl: string, secret?: string | null): CreateHookRequest | undefined {
  if (!baseUrl) return undefined;
  if (!shouldInjectMcp(request)) return undefined;
  const snapshot = secret === undefined ? readSupervisorTokenFile() : secret;
  const clean = stripSupervisorToken(request, snapshot);
  const token = clean.env?.KANBAN_TOKEN?.trim() || "";
  // The token goes in the Authorization header only; a token in the URL would leak into logs and process listings.
  const kanban: McpHttpServerConfig = {
    type: "http",
    url: `${baseUrl}/mcp`,
    alwaysLoad: true,
    ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
  };
  return stripSupervisorToken({
    ...clean,
    env: Object.keys(cliEnvAtStartup).length > 0 ? { ...(clean.env ?? {}), ...cliEnvAtStartup } : clean.env,
    config: {
      ...clean.config,
      mcpServers: {
        ...clean.config.mcpServers,
        kanban,
      },
    },
  }, snapshot);
}

/** Local budget, well below Paseo's 30-second plugin RPC deadline. */
export const CREATE_HOOK_BUDGET_MS = 100;

interface BoundedHookOptions {
  baseUrl: string;
  // Captured at plugin startup. Never read a token file from a lifecycle callback.
  supervisorToken: string | null;
  budgetMs?: number;
  /** SDK hook.cancel must release creation without waiting for the local budget. */
  signal?: AbortSignal;
  optional?: (request: CreateHookRequest, signal: AbortSignal) => CreateHookRequest | Promise<CreateHookRequest>;
  log?: (message: string) => void;
}

/** Mandatory injection is pure and completed before any optional dependency is called. */
export function boundedCreateHook(request: CreateHookRequest, options: BoundedHookOptions): Promise<CreateHookRequest | undefined> | undefined {
  if (!shouldInjectMcp(request)) return undefined;
  const log = (message: string) => { try { options.log?.(message); } catch { /* logging must not reject a create */ } };
  let mandatory: CreateHookRequest;
  try {
    const clean = stripSupervisorToken(request, options.supervisorToken);
    mandatory = injectMcp(clean, options.baseUrl, options.supervisorToken) ?? clean;
  } catch {
    log("agent.create mandatory injection failed; preserving original request");
    return undefined;
  }
  if (options.signal?.aborted) return Promise.resolve(mandatory);
  const controller = new AbortController();
  const budgetMs = options.budgetMs ?? CREATE_HOOK_BUDGET_MS;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (next: CreateHookRequest, message?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      controller.abort();
      if (next !== mandatory) recordProtocolReceipt(next);
      resolve(next);
      if (message) log(message);
    };
    const onAbort = () => finish(mandatory);
    const timer = setTimeout(() => finish(mandatory, `agent.create optional work timed out after ${budgetMs}ms; mandatory injection retained`), budgetMs);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    // Optional work gets its own copy, so a late completion cannot mutate the fallback.
    // It must yield to the event loop and observe signal; timers cannot preempt sync CPU work.
    const optional = options.optional ?? ((next: CreateHookRequest) => appendProtocol(next));
    void Promise.resolve().then(() => settled ? mandatory : optional(structuredClone(mandatory), controller.signal))
      .then((next) => finish(next), () => finish(mandatory, "agent.create optional work failed; mandatory injection retained"));
  });
}
