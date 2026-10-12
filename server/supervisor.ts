/// <reference types="node" />
import type { AgentFile, AgentLiveness } from "./open";
import { displayCliPath } from "./fallback";
import { protocolText } from "./protocol-text";
import { t } from "../shared/i18n";

/**
 * Legacy titles are still recognised: "\u3010\u603b\u7ba1\u3011<project>" and "\u603b\u7ba1Kanban" (the old Chinese word for leader).
 * New titles: "<leader> · <project>" and "<leader> · Kanban".
 * The role key stays supervisor; the stored value is never inferred from a title.
 */
const LEGACY_LEADER_PREFIX = "\u3010\u603b\u7ba1\u3011";
const LEGACY_KANBAN_TITLE = "\u603b\u7ba1Kanban";
const LEADER_TITLE_PREFIX = "<leader> · ";

export function isLeaderSessionTitle(title: string): boolean {
  const name = title.trim();
  if (name.startsWith(LEGACY_LEADER_PREFIX)) return true;
  if (name === LEGACY_KANBAN_TITLE || name.startsWith(LEGACY_KANBAN_TITLE)) return true;
  return name.startsWith(LEADER_TITLE_PREFIX);
}

/**
 * Paseo 0.9.2 cannot attach mcpServers to an agent that already exists.
 * Checked against the 0.9.2 daemon:
 * - `before("agent.create")` can set mcpServers, but only while the agent is being created,
 *   and the hook receives `{ config, env }` with no labels. Registration happens later.
 * - `before("agent.session_open")` may change `env` only. Anything else throws.
 * - `agent.config.apply` updates model, mode, thinking, and features. It has no mcpServers field.
 * - `paseo agent update` only accepts name, thinking, and labels.
 * - `paseo agent reload` restarts the process from the stored config.
 * So registration sends a CLI note. The supervisor token is the default for `bin/kanban`
 * and must not be copied into this note, a log line, an event, or the board.
 */
export function kanbanFallbackNote(): string {
  return protocolText("kanban-fallback-note", { cli: displayCliPath() });
}

export function supervisorCliNote(): string {
  return protocolText("supervisor-cli-note", { cli: displayCliPath() });
}

export function supervisorRegisterBlock(state: AgentLiveness): string | null {
  if (state === "missing") return t("supervisor.register.missing");
  if (state === "archived") return t("supervisor.register.archived");
  if (state === "closed") return t("supervisor.register.closed");
  return null;
}

export interface SupervisorView {
  title: string | null;
  headline: string;
  prompt: string | null;
}

export function supervisorView(agentId: string | null, file: AgentFile | null): SupervisorView {
  if (!agentId) return { title: null, headline: t("supervisor.view.unregistered"), prompt: null };
  if (!file) return { title: null, headline: t("supervisor.view.unregistered"), prompt: t("supervisor.view.notFound") };
  const title = file.title.trim() || agentId.slice(0, 8);
  const headline = t("supervisor.view.headline", { title });
  if (file.archivedAt) return { title, headline, prompt: t("supervisor.view.archived") };
  if (file.lastStatus === "closed") return { title, headline, prompt: t("supervisor.view.closed") };
  if (file.lastStatus === "error") return { title, headline, prompt: t("supervisor.view.error") };
  return { title, headline, prompt: null };
}

export async function notifySupervisorRegistered(
  agentId: string,
  send: (agentId: string, text: string) => Promise<void>,
): Promise<{ delivered: "cli"; agentId: string; message: string }> {
  const message = supervisorCliNote();
  await send(agentId, message);
  return { delivered: "cli", agentId, message };
}
