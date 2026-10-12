import { KanbanError } from "./errors";
import { t } from "../shared/i18n";

/** Paseo agent ids are UUIDs; tests use short slugs. No path separators, no leading dot, at most 128 characters. */
export const SAFE_AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;


/** Reject an agent id given on the command line or in a tool call before it reaches a lookup or a file path. */
export function assertSafeAgentId(agentId: string, label: string): void {
  if (!SAFE_AGENT_ID.test(agentId)) throw new KanbanError("invalid", t("agentId.invalid", { label, rule: t("agentId.rule") }));
}

/** PASEO_AGENT_ID from the environment. Empty means none; a malformed value is refused outright. */
export function envAgentId(env: NodeJS.ProcessEnv): string | null {
  const agentId = env.PASEO_AGENT_ID?.trim();
  if (!agentId) return null;
  if (!SAFE_AGENT_ID.test(agentId)) throw new KanbanError("unauthorized", t("agentId.envInvalid", { rule: t("agentId.rule") }));
  return agentId;
}
