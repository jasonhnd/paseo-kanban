/// <reference types="node" />
import { supervisorSlots, type SupervisorConfig } from "../../shared/fleet/supervisor-shift";
import { kanbanProjectName } from "./paths";
import { userMessagePrefix, validateLeaderReply } from "../../shared/fleet/leader-panel";
import { t } from "../../shared/fleet/i18n";
import { KANBAN_CONFIG } from "./decisions-maint";
import { BIN, readJson, run, sendToAgent } from "./util";

export interface LeaderReplyDeps {
  config(): Promise<SupervisorConfig>;
  run(cmd: string, args: string[], timeoutMs: number): Promise<string>;
  now(): number;
}
export async function submitLeaderReply(input: { project: string; text: string }, deps: LeaderReplyDeps) {
  const failed = (message: string) => ({ ok: false, message, sentAt: null as string | null });
  const error = validateLeaderReply(input);
  if (error) return failed(error);
  try {
    // Re-read registration on each send: a shift may have completed since the last snapshot.
    const slot = supervisorSlots(await deps.config(), kanbanProjectName()).find((s) => s.project.toLowerCase() === input.project.trim().toLowerCase());
    if (!slot) return failed(t("leader.server.notRegistered"));
    await sendToAgent(slot.agentId, `${userMessagePrefix()}\n${input.text.trim()}`, { runner: deps.run });
    const sentAt = new Date(deps.now()).toISOString();
    return { ok: true, message: t("leader.server.sent"), sentAt };
  } catch (error) { return failed(t("leader.server.sendFailed", { error: String(error).slice(0, 200) })); }
}
export function productionLeaderReplyDeps(): LeaderReplyDeps {
  return { config: () => readJson<SupervisorConfig>(KANBAN_CONFIG, {}), run, now: Date.now };
}
