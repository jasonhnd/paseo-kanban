import type { PluginBeforeRequests, PluginHookContext, PluginLifecycleEvents } from "@getpaseo/plugin/server";
import type { PaseoApi } from "@getpaseo/client";
import type { AgentPermissionRequest } from "@getpaseo/protocol/agent-types";
import { boundedCreateHook, shouldInjectMcp, type CreateHookRequest } from "./inject";
import { cliFallback } from "./fallback";
import type { HookObjects } from "./hook-objects";
import type { getDb } from "./db";
import type { decidePermission } from "./permissions";
import type { PermissionContext } from "./permission-context";
import type { addComment, appendEvent, getTask } from "./store";
import type { planTurn, lastUserMessageAtOf } from "./nudge";
import { presenceIsGone, type readAgentPresence, type settleCanceledTurn } from "./presence";
import type { askPaseoAgent, readAgentEndNote } from "./paseo";
import type { settleOpeningLoginBlip } from "./login-blip";
import type { readProfiles } from "./profiles";
import type { applyFailure, classifyFailure, reclaimTask } from "./failures";
import { quietHandoffEligible, type applyNudge } from "./flow";
import { noWaitNudge } from "./protocol";
import type { mcpNoteFor } from "./mcp-port";
import type { readReclaimContext } from "./reclaim-note";
import { t } from "../shared/i18n";

export interface LifecycleHookDeps {
  hookObjects: Pick<HookObjects, "agent" | "workspace">;
  bind: (paseo: PaseoApi) => void;
  schedulerReady: () => boolean;
  bindMemory: (paseo: PaseoApi) => void;
  kick: () => Promise<void>;
  createOptions: () => Parameters<typeof boundedCreateHook>[1];
  permissionContext: (agentId: string) => PermissionContext;
  console: Pick<Console, "error">;
  getDb: typeof getDb;
  decidePermission: typeof decidePermission;
  addComment: typeof addComment;
  appendEvent: typeof appendEvent;
  getTask: typeof getTask;
  planTurn: typeof planTurn;
  lastUserMessageAtOf: typeof lastUserMessageAtOf;
  readAgentPresence: typeof readAgentPresence;
  settleCanceledTurn: typeof settleCanceledTurn;
  askPaseoAgent: typeof askPaseoAgent;
  readAgentEndNote: typeof readAgentEndNote;
  settleOpeningLoginBlip: typeof settleOpeningLoginBlip;
  readProfiles: typeof readProfiles;
  applyFailure: typeof applyFailure;
  classifyFailure: typeof classifyFailure;
  reclaimTask: typeof reclaimTask;
  applyNudge: typeof applyNudge;
  mcpNoteFor: typeof mcpNoteFor;
  readReclaimContext: typeof readReclaimContext;
}

/**
 * Paseo's own short cancel phrase ("agent closed"). Anything longer or odd is not stored. No ':' (DEMO_0001), so
 * `Authorization: Bearer …` and `user:secret` fail, and credential words are refused even without one.
 */
const PLAIN_REASON = /^[A-Za-z][A-Za-z0-9 _.-]{0,79}$/;
const CREDENTIAL_WORDS = /authorization|bearer|basic|(?:^|\s)-u|--user|token|password|passwd|secret|api[_ -]?key/i;

function cancelReasonOf(outcome: unknown): { cancelReason?: string } {
  const reason = outcome && typeof outcome === "object" ? (outcome as { reason?: unknown }).reason : undefined;
  const text = typeof reason === "string" ? reason.trim() : "";
  return PLAIN_REASON.test(text) && !CREDENTIAL_WORDS.test(text) ? { cancelReason: text } : {};
}

type LifecycleHandler<Name extends keyof PluginLifecycleEvents> = (event: PluginLifecycleEvents[Name], context: PluginHookContext) => void | Promise<void>;
type BeforeCreate = (input: { request: PluginBeforeRequests["agent.create"] }, context: PluginHookContext) => ReturnType<typeof boundedCreateHook>;

/** Registered handlers and tests share these callbacks; gates precede context and I/O. */
export function createLifecycleHooks(deps: LifecycleHookDeps) {
  const { hookObjects, bind, kick, createOptions, permissionContext, console, getDb, decidePermission, addComment, appendEvent, getTask, planTurn, lastUserMessageAtOf, readAgentPresence, settleCanceledTurn, askPaseoAgent, readAgentEndNote, settleOpeningLoginBlip, readProfiles, applyFailure, classifyFailure, reclaimTask, applyNudge, mcpNoteFor, readReclaimContext } = deps;
  const fallbackBind = (context: PluginHookContext) => {
    if (deps.schedulerReady()) return;
    // Never activate integrations, kick the scheduler or log from an unrelated event.
    // The existing periodic tick picks up the client and performs initialization.
    try {
      if (context?.paseo) deps.bindMemory(context.paseo);
    } catch { /* An unavailable context must not affect an unrelated lifecycle event. */ }
  };
  const before: BeforeCreate = ({ request }, context) => {
    if (!shouldInjectMcp(request as CreateHookRequest)) return undefined;
    try {
      return boundedCreateHook(request as CreateHookRequest, { ...createOptions(), signal: context?.signal });
    } catch (err) {
      console.error("[paseo-kanban] agent.create hook swallowed", err instanceof Error ? err.message : err);
      return undefined;
    }
  };

  const permission: LifecycleHandler<"agent.permission_requested"> = async ({ agent, request }, context) => {
    if (!hookObjects.agent(agent)) return;
    const { paseo } = context;
    bind(paseo);
    try {
      const ctx = permissionContext(agent.id);
      const decision = decidePermission({ kanban: ctx.kanban, autoAccept: ctx.autoAccept, role: ctx.role, readScope: ctx.readScope, request: request as AgentPermissionRequest });
      if (decision.action === "ignore") return;
      await paseo.agents.ref(agent.id).respondToPermission({
        requestId: request.id,
        response: decision.action === "allow"
          ? { behavior: "allow", ...(decision.selectedActionId ? { selectedActionId: decision.selectedActionId } : {}) }
          : { behavior: "deny", message: decision.reason },
      });
      if (decision.action === "deny" && ctx.taskId) {
        addComment(ctx.taskId, "kanban", t("lifecycleHooks.permission.denied", { reason: decision.reason }));
        appendEvent(ctx.taskId, "permission_denied", null, null, "kanban", { reason: decision.reason, agentId: agent.id, name: request.name });
      }
    } catch (err) {
      console.error("[paseo-kanban] permission", err instanceof Error ? err.message : err);
    }
  };

  const turn: LifecycleHandler<"agent.turn_ended"> = async ({ agent, outcome, timeline }, context) => {
    if (!hookObjects.agent(agent)) { fallbackBind(context); return; }
    const { paseo } = context;
    try {
      bind(paseo);
      const row = getDb().prepare("SELECT id, status FROM tasks WHERE agent_id = ?").get(agent.id) as { id: number; status: string } | undefined;
      if (!row || (row.status !== "running" && row.status !== "reviewing")) {
        await kick();
        return;
      }
      const plan = planTurn(outcome, timeline);
      if (plan.action === "canceled") {
        // A new prompt cancels the current turn and starts the next one. The agent is often still here.
        const presence = await readAgentPresence(agent.id, () => askPaseoAgent(paseo, agent.id));
        const evidence = presenceIsGone(presence)
          ? { ...(await readReclaimContext(paseo, agent.id, agent.workspaceId, { timeline })), ...cancelReasonOf(outcome) }
          : undefined;
        settleCanceledTurn(row.id, agent.id, presence, evidence);
        await kick();
        return;
      }
      const settled = await settleOpeningLoginBlip({
        taskId: row.id,
        agentId: agent.id,
        outcome,
        timeline,
        lastUserMessageAt: lastUserMessageAtOf(agent),
        readNote: () => readAgentEndNote(paseo, agent.id),
        archive: (agentId) => paseo.agents.ref(agentId).archive().then(() => undefined),
      });
      if (settled !== "ignore") {
        await kick();
        return;
      }
      if (plan.action === "skip") {
        console.error("[paseo-kanban] turn", plan.reason);
        await kick();
        return;
      }
      if (plan.action === "failed") {
        const run = getDb().prepare("SELECT profile_name FROM runs WHERE task_id = ? ORDER BY id DESC LIMIT 1").get(row.id) as
          | { profile_name: string | null }
          | undefined;
        let pool: string | null = null;
        try {
          pool = readProfiles().find((profile) => profile.name === run?.profile_name)?.pool ?? null;
        } catch (err) {
          console.error("[paseo-kanban] profiles", err instanceof Error ? err.message : err);
          pool = null;
        }
        applyFailure(row.id, plan.message, classifyFailure(plan.message, plan.code), new Date(), pool);
        await kick();
        return;
      }
      const lastUserMessageAt = lastUserMessageAtOf(agent);
      const decision = applyNudge(row.id, plan.finished, {
        ...(lastUserMessageAt === undefined ? {} : { lastUserMessageAt }),
        timeline,
      });
      if (decision.action === "remind") {
        const task = getTask(row.id);
        const stale = mcpNoteFor(task);
        const prefix = stale ? t("lifecycleHooks.nudge.stale", { stale }) : "";
        const next = task.role === "executor" ? t("lifecycleHooks.nudge.next.review") : t("lifecycleHooks.nudge.next.accept");
        const text = quietHandoffEligible(task)
          ? task.status === "reviewing"
            ? t("lifecycleHooks.nudge.review", { stale: prefix, noWait: noWaitNudge(), cli: cliFallback() })
            : t("lifecycleHooks.nudge.quiet", { stale: prefix, noWait: noWaitNudge(), cli: cliFallback(), next })
          : stale
            ? t("lifecycleHooks.nudge.countStale", { stale: prefix, count: decision.count, noWait: noWaitNudge() })
            : t("lifecycleHooks.nudge.count", { cli: cliFallback(), count: decision.count, noWait: noWaitNudge() });
        await paseo.agents.ref(agent.id).send(text);
      }
      await kick();
    } catch (err) {
      console.error("[paseo-kanban] turn", err instanceof Error ? err.message : err);
      await kick().catch(() => undefined);
    }
  };

  const holdsCard = (taskId: number, agentId: string): boolean => {
    const task = getTask(taskId);
    return task.agent_id === agentId && (task.status === "running" || task.status === "reviewing") && !quietHandoffEligible(task);
  };

  /**
   * agent.archived reclaims only cards the quiet hand-in does not cover (DEMO_0001); a running executor, batch or
   * reader card whose agent Paseo closes mid-turn (auto-archive-on-merge, DEMO_0001) is reclaimed by the canceled
   * turn instead. Before reclaiming, ask Paseo once more (an agent that is still live and unarchived keeps the card)
   * and record what the agent last ran and which PR Paseo saw merged; the next start quotes it.
   */
  const reclaimArchived = async (paseo: PaseoApi, agentId: string, workspaceId: string | null | undefined): Promise<void> => {
    const row = getDb().prepare("SELECT id, status FROM tasks WHERE agent_id = ?").get(agentId) as { id: number; status: string } | undefined;
    if (!row || (row.status !== "running" && row.status !== "reviewing") || !holdsCard(row.id, agentId)) return;
    const presence = await readAgentPresence(agentId, () => askPaseoAgent(paseo, agentId));
    if (presence === "running" || presence === "idle") {
      if (holdsCard(row.id, agentId)) appendEvent(row.id, "archive_event_kept", row.status, row.status, "kanban", { agentId, presence });
      return;
    }
    const found = await readReclaimContext(paseo, agentId, workspaceId);
    // Completion, unblock, or another start can change this card during the awaits.
    if (!holdsCard(row.id, agentId)) return;
    reclaimTask(row.id, new Date(), { source: "agent.archived", apiState: presence, ...found });
  };

  const archived: LifecycleHandler<"agent.archived"> = async (event, context) => {
    if (!hookObjects.agent(event?.agent)) return;
    try {
      if (!context?.paseo) {
        console.error("[paseo-kanban] archived", "the event has no paseo client; skipping this round");
        return;
      }
      bind(context.paseo);
      const agentId = event?.agent?.id;
      if (agentId) {
        await reclaimArchived(context.paseo, agentId, event.agent.workspaceId);
      } else {
        console.error("[paseo-kanban] archived", "the event has no agent.id; skipping this round");
      }
      await kick();
    } catch (err) {
      console.error("[paseo-kanban] archived", err instanceof Error ? err.message : err);
      await kick().catch(() => undefined);
    }
  };

  const created: LifecycleHandler<"agent.created"> = (event, context) => {
    if (!hookObjects.agent(event?.agent)) { fallbackBind(context); return; }
    try {
      if (!context?.paseo) return;
      bind(context.paseo);
      void kick();
    } catch (err) {
      console.error("[paseo-kanban] agent.created", err instanceof Error ? err.message : err);
    }
  };

  const workspace: LifecycleHandler<"workspace.created"> = (event, context) => {
    if (!hookObjects.workspace(event?.workspace)) { fallbackBind(context); return; }
    try {
      if (!context?.paseo) return;
      bind(context.paseo);
      void kick();
    } catch (err) {
      console.error("[paseo-kanban] workspace.created", err instanceof Error ? err.message : err);
    }
  };
  return { before, permission, turn, archived, created, workspace };
}
