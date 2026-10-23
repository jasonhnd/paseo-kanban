import { parentIdsFromArgs } from "./argv";
import { cardMark, projectNameForCode, resolveTaskId } from "./card-ref";
import { changeReadGrant, hasProjectRead } from "./read-grants";
import { isOpsCleanupWorker } from "./ops-cleanup";
import { formatRelated, isRelatedView, projectReadView, relatedView } from "./related-view";
import { parseCardRef } from "../shared/card-code";
import { getDb } from "./db";
import type { McpTool } from "./mcp";
import { KanbanError } from "./errors";
import { acceptTask, approveTask, completeTask, linkTask, unlinkTask, leaderPassTask, leaderReworkTask, rejectTask, requestChanges } from "./flow";
import { assertSafeAgentId } from "./agent-id";
import { GUEST_ROLE, SCHEDULE_ROLE, resolveTokenIdentity, assertLeaderDecisionScope, assertNotLeaderAgent, assertProjectScope, assertSupervisorScope, assertUnlinkScope, assertWaitUserScope, guestForbidden, scheduleDenial } from "./identity";
import { superviseProject } from "./leader-registry";
import { livePresence } from "./live-presence";
import type { AgentPresence } from "./presence";
import { statusLabel } from "../shared/labels";
import { scheduledWaitLabel } from "../shared/blocked";
import { taskParents } from "./parents";
import { normalizeTags } from "./profile-rules";
import { parseEffort } from "./effort";
import { parseTier } from "./tier";
import { registerTask } from "./register";
import { assertReminderGuard, parseDecisionId, unwait, waitUser, waitUserHold } from "./wait-user";
import { getLanguage, t, type Language, type MessageKey } from "../shared/i18n";
import { toolText, type ToolTextKey } from "./tools-text";
import { addComment, appendEvent, archiveTask, blockTask, createTask, getDetail, getTask, listBoard, unblockTask } from "./store";
import type { Identity } from "./tokens";
import { assertProjectInPaseo } from "./paseo-projects";
import { doctorSettings, loadConfig, loadConfigForReport, resolveConfiguredProject } from "./config";
import { connectAndCollect } from "./doctor-live";
import { readLastDoctorReport, runDoctor } from "./doctor";
import { auditWrite, isWriteTool } from "./write-source";

function cardRef(language: Language): { description: string; anyOf: Array<{ type: string }> } {
  return { description: toolText("param.cardRef", language), anyOf: [{ type: "number" }, { type: "string" }] };
}

const ALL = ["supervisor", "executor", "reviewer", "reader", "decision", "batch"];
/** Read-only tools are also open to an unregistered session (guest) and a schedule agent. */
const READERS = [...ALL, GUEST_ROLE, SCHEDULE_ROLE];
const ACL: Record<string, readonly string[]> = {
  kanban_ping: ALL,
  kanban_supervise: ["supervisor", GUEST_ROLE],
  kanban_show: READERS,
  kanban_list: READERS,
  kanban_comment: ALL,
  kanban_complete: ["executor", "reader", "decision", "batch"],
  kanban_block: ALL,
  kanban_approve: ["reviewer"],
  kanban_request_changes: ["reviewer"],
  kanban_create: ["supervisor", SCHEDULE_ROLE],
  kanban_link: ["supervisor"],
  kanban_unlink: ["supervisor"],
  kanban_grant_read: ["supervisor"],
  kanban_revoke_read: ["supervisor"],
  kanban_unblock: ["supervisor"],
  kanban_wait_user: ["supervisor"],
  kanban_unwait: ["supervisor"],
  kanban_accept: ["supervisor"],
  kanban_reject: ["supervisor"],
  kanban_rework: ["supervisor"],
  kanban_pass: ["supervisor"],
  kanban_archive: ["supervisor"],
  kanban_register: ["supervisor"],
  kanban_doctor: ALL,
};

/** The tool list in the current (or given) language. Built on demand, after the server has chosen its language. */
export function toolDefs(language: Language = getLanguage()): McpTool[] {
  const CARD_REF = cardRef(language);
  const text = (key: ToolTextKey): string => toolText(key, language);
  return [
  { name: "kanban_ping", description: text("kanban_ping.description"), inputSchema: { type: "object", properties: {} } },
  {
    name: "kanban_supervise",
    description: text("kanban_supervise.description"),
    inputSchema: {
      type: "object",
      properties: { project: { type: "string", description: text("kanban_supervise.param.project") } },
      required: ["project"],
      additionalProperties: false,
    },
  },
  { name: "kanban_show", description: text("kanban_show.description"), inputSchema: { type: "object", properties: { id: CARD_REF } } },
  { name: "kanban_grant_read", description: text("kanban_grant_read.description"), inputSchema: { type: "object", properties: { id: CARD_REF, scope: { type: "string", enum: ["project"] } }, required: ["id", "scope"] } },
  { name: "kanban_revoke_read", description: text("kanban_revoke_read.description"), inputSchema: { type: "object", properties: { id: CARD_REF }, required: ["id"] } },
  { name: "kanban_list", description: text("kanban_list.description"), inputSchema: { type: "object", properties: { project: { type: "string" }, includeRemoved: { type: "boolean", description: text("kanban_list.param.includeRemoved") } } } },
  {
    name: "kanban_doctor",
    description: text("kanban_doctor.description"),
    inputSchema: { type: "object", properties: { last: { type: "boolean" } } },
  },
  { name: "kanban_comment", description: text("kanban_comment.description"), inputSchema: { type: "object", properties: { id: CARD_REF, text: { type: "string" } }, required: ["text"] } },
  { name: "kanban_complete", description: text("kanban_complete.description"), inputSchema: { type: "object", properties: { id: CARD_REF, summary: { type: "string" }, handoff: { description: text("kanban_complete.param.handoff") }, onBehalf: { type: "boolean" } }, required: ["summary"] } },
  { name: "kanban_block", description: text("kanban_block.description"), inputSchema: { type: "object", properties: { id: CARD_REF, reason: { type: "string" }, kind: { type: "string" }, until: { type: "string", description: text("kanban_block.param.until") } }, required: ["reason", "kind"] } },
  { name: "kanban_approve", description: text("kanban_approve.description"), inputSchema: { type: "object", properties: { id: CARD_REF, summary: { type: "string" } }, required: ["summary"] } },
  { name: "kanban_request_changes", description: text("kanban_request_changes.description"), inputSchema: { type: "object", properties: { id: CARD_REF, reason: { type: "string" }, findings: { type: "string" } }, required: ["reason"] } },
  { name: "kanban_create", description: text("kanban_create.description"), inputSchema: { type: "object", properties: { project: { type: "string" }, title: { type: "string" }, brief: { type: "string" }, role: { type: "string" }, workspace: { type: "string" }, profile: { type: "string" }, parents: { type: "array", items: CARD_REF, description: text("kanban_create.param.parents") }, reviews: { ...CARD_REF, description: text("kanban_create.param.reviews") }, contract: { type: "string" }, maxRetries: { type: "number" }, noSplitHint: { type: "boolean", description: text("kanban_create.param.noSplitHint") }, tags: { type: "array", items: { type: "string" }, description: text("kanban_create.param.tags") }, effort: { type: "string", description: text("kanban_create.param.effort") }, tier: { type: "string", description: text("kanban_create.param.tier") }, decision: { type: "string", description: text("kanban_create.param.decision") } }, required: ["project", "title", "role"] } },
  { name: "kanban_link", description: text("kanban_link.description"), inputSchema: { type: "object", properties: { id: CARD_REF, parent: CARD_REF }, required: ["id", "parent"] } },
  { name: "kanban_unlink", description: text("kanban_unlink.description"), inputSchema: { type: "object", properties: { id: CARD_REF, parent: CARD_REF, parents: { type: "array", items: CARD_REF } }, required: ["id"], anyOf: [{ required: ["parent"] }, { required: ["parents"] }] } },
  { name: "kanban_unblock", description: text("kanban_unblock.description"), inputSchema: { type: "object", properties: { id: CARD_REF, runBudget: { type: "object", properties: Object.fromEntries(["maxDurationMs", "maxTurns", "maxTokens", "maxConsecutiveWaits"].map(key => [key, { type: "integer", minimum: 1 }])), additionalProperties: false }, reason: { type: "string" } }, required: ["id"] } },
  { name: "kanban_wait_user", description: text("kanban_wait_user.description"), inputSchema: { type: "object", properties: { id: CARD_REF, decision: { type: "string", description: text("kanban_wait_user.param.decision") } }, required: ["id", "decision"] } },
  { name: "kanban_unwait", description: text("kanban_unwait.description"), inputSchema: { type: "object", properties: { id: CARD_REF }, required: ["id"] } },
  { name: "kanban_rework", description: text("kanban_rework.description"), inputSchema: { type: "object", properties: { id: CARD_REF, reason: { type: "string" }, agent: { type: "string" }, countRound: { type: "boolean" } }, required: ["id", "reason"] } },
  { name: "kanban_pass", description: text("kanban_pass.description"), inputSchema: { type: "object", properties: { id: CARD_REF, note: { type: "string" } }, required: ["id", "note"] } },
  { name: "kanban_accept", description: text("kanban_accept.description"), inputSchema: { type: "object", properties: { id: CARD_REF, artifact: { type: "string", description: text("kanban_accept.param.artifact") }, reason: { type: "string", description: text("kanban_accept.param.reason") } }, required: ["id"] } },
  { name: "kanban_reject", description: text("kanban_reject.description"), inputSchema: { type: "object", properties: { id: CARD_REF, reason: { type: "string" } }, required: ["id", "reason"] } },
  {
    name: "kanban_register",
    description: text("kanban_register.description"),
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string" },
        title: { type: "string" },
        brief: { type: "string" },
        role: { type: "string" },
        profile: { type: "string" },
        provider: { type: "string" },
        model: { type: "string" },
        thinking: { type: "string" },
        agent: { type: "string" },
        family: { type: "string" },
        workspace: { type: "string" },
        idempotency: { type: "string" },
      },
      required: ["project", "title", "role", "profile", "provider", "model", "agent"],
    },
  },
];
}

/** Why a role may not call a supervisor tool. Keys of the messages, looked up when refused. */
const DENIAL: Record<string, MessageKey> = {
  kanban_create: "tools.denial.create",
  kanban_supervise: "tools.denial.supervise",
  kanban_accept: "tools.denial.accept",
  kanban_reject: "tools.denial.reject",
  kanban_rework: "tools.denial.rework",
  kanban_pass: "tools.denial.pass",
  kanban_unblock: "tools.denial.unblock",
  kanban_wait_user: "tools.denial.waitUser",
  kanban_unwait: "tools.denial.unwait",
  kanban_archive: "tools.denial.archive",
};

function assertRole(identity: Identity, tool: string): void {
  const allowed = ACL[tool];
  if (!allowed) throw new KanbanError("unknown_tool", t("tools.unknownTool", { tool }));
  if (!allowed.includes(identity.role)) {
    if (identity.role === GUEST_ROLE) throw guestForbidden(identity.agentId);
    const denial = DENIAL[tool];
    const message = identity.role === SCHEDULE_ROLE ? scheduleDenial(tool) : denial ? t(denial) : undefined;
    throw new KanbanError("forbidden", message ?? t("tools.roleCannotCall", { role: identity.role, tool }), { role: identity.role, tool });
  }
}

function parseReviewOf(value: unknown): number | undefined {
  if (value == null || value === "") return undefined;
  const parsed = resolveTaskId(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new KanbanError("invalid", t("tools.reviewsNotCard"));
  return parsed;
}

/**
 * The project a new card goes into must be configured (any caller), and an agent-bound <leader> may only
 * create there, or review a card, inside its own scope. A schedule agent cannot point a review at another card.
 */
function createTarget(identity: Identity, args: Record<string, unknown>): { project: string; reviewOf: number | undefined } {
  const raw = String(args.project ?? "");
  const project = raw.trim() ? resolveConfiguredProject(raw, t("tools.action.create")) : raw;
  if (project) assertProjectInPaseo(project);
  const reviewOf = parseReviewOf(args.reviews);
  if (identity.role === SCHEDULE_ROLE && reviewOf !== undefined) throw new KanbanError("forbidden", scheduleDenial(t("tools.action.pointReview")));
  if (project) assertProjectScope(identity, project, t("tools.action.create"));
  if (reviewOf !== undefined) assertSupervisorScope(identity, getTask(reviewOf), t("tools.action.createReview"));
  return { project, reviewOf };
}

/** Binding an existing agent to a card: the id must be well-formed and must not be a registered <leader>. */
function assertBindableAgent(agentId: string, label: string): void {
  if (!agentId) return;
  assertSafeAgentId(agentId, label);
  assertNotLeaderAgent(agentId);
}

function parseMaxRetries(value: unknown): number | undefined {
  if (value == null || value === "") return undefined;
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < 0) throw new KanbanError("invalid", t("tools.badMaxRetries"));
  return parsed;
}

/** What a worker may see of the board: its own project, no agent ids, no brief or handoff text. */
function workerList(identity: Identity, args: Record<string, unknown>): { projects: string[]; tasks: Array<Record<string, unknown>> } {
  const own = identity.taskId != null ? getTask(identity.taskId) : null;
  const project = own?.project;
  if (!project) return { projects: [], tasks: [] };
  const opsCleanup = isOpsCleanupWorker(identity);
  if (!opsCleanup && own && hasProjectRead(own) && typeof args.project === "string" && args.project && args.project !== project && projectNameForCode(args.project) !== project) {
    throw new KanbanError("forbidden", t("readGrants.listOwnProject"));
  }
  const requestedProject = typeof args.project === "string" && args.project ? args.project : undefined;
  const board = listBoard(opsCleanup ? (requestedProject ? projectNameForCode(requestedProject) ?? requestedProject : undefined) : project, { includeRemoved: true });
  const tasks = board.tasks.map((card) => ({
    id: card.id,
    code: card.code,
    project: card.project,
    title: card.title,
    role: card.role,
    status: card.status,
    blockedKind: card.blockedKind,
    scheduledUntil: card.scheduledUntil,
    ...(card.reviewStatus ? { reviewStatus: card.reviewStatus } : {}),
    tier: card.tier,
  }));
  return { projects: opsCleanup ? board.projects : [project], tasks };
}

const AGENT_BOUND = new Set(["kanban_complete", "kanban_block", "kanban_approve", "kanban_request_changes"]);

function assertCurrentAgent(identity: Identity, taskId: number, tool: string): void {
  if (!AGENT_BOUND.has(tool)) return;
  if (identity.role === "supervisor" && identity.taskId == null) return;
  const task = getTask(taskId);
  if (identity.agentId && identity.agentId === task.agent_id) return;
  appendEvent(task.id, "token_rejected", null, task.status, identity.role, {
    tool,
    tokenAgent: identity.agentId,
    cardAgent: task.agent_id,
  });
  throw new KanbanError("forbidden", t("tools.tokenNotCardAgent"));
}

const NAMED_CARD = /#?[A-Za-z][A-Za-z0-9]*_\d+/g;

/** Same-project cards named by display code in the card's title or brief. Bare numbers are not matched. */
function namedSameProjectIds(ownId: number): number[] {
  const own = getTask(ownId);
  const text = `${own.title}\n${own.brief ?? ""}`;
  const ids = new Set<number>();
  for (const match of text.match(NAMED_CARD) ?? []) {
    const ref = parseCardRef(match);
    if (ref?.kind !== "code") continue;
    try {
      if (projectNameForCode(ref.code) !== own.project) continue;
      const row = getDb().prepare("SELECT id FROM tasks WHERE project = ? AND code_seq = ?").get(own.project, ref.seq) as { id: number } | undefined;
      if (row) ids.add(row.id);
    } catch {
      // unresolvable code: not readable
    }
  }
  return [...ids];
}

/**
 * Read-only relatives of an agent token's own card.
 * One hop along links.parent (not the parent's parents), tasks.review_of,
 * and same-project cards named by display code in the title or brief.
 */
function canReadRelated(ownId: number, requested: number): boolean {
  if (taskParents(ownId).some((parent) => parent.id === requested)) return true;
  if (getTask(ownId).review_of === requested) return true;
  return namedSameProjectIds(ownId).includes(requested);
}

function taskId(identity: Identity, args: Record<string, unknown>, access: "read" | "write" = "write"): number {
  const requested = args.id == null || args.id === "" ? identity.taskId : resolveTaskId(args.id);
  if (!requested || Number.isNaN(requested)) throw new KanbanError("invalid", t("tools.needCard"));
  if (identity.taskId != null && identity.taskId !== requested) {
    if (access === "read") {
      if (isOpsCleanupWorker(identity)) return requested;
      const own = getTask(identity.taskId);
      if (hasProjectRead(own)) {
        if (getTask(requested).project === own.project) return requested;
        throw new KanbanError("forbidden", t("readGrants.readOwnProject"));
      }
      if (canReadRelated(identity.taskId, requested)) return requested;
    }
    throw new KanbanError(
      "forbidden",
      access === "read"
        ? t("tools.ownCardsRead")
        : t("tools.ownCardsOnly"),
    );
  }
  return requested;
}

export async function handleTool(name: string, args: Record<string, unknown>, token: string | null, preset?: Identity, hooks?: { agentPresence?: (agentId: string) => Promise<AgentPresence> | AgentPresence }): Promise<unknown> {
  if (name === "kanban_ping") return { text: "kanban-pong" };
  let identity = preset;
  if (!identity) {
    try {
      if (!token) throw new KanbanError("unauthorized", t("tools.missingToken"));
      identity = resolveTokenIdentity(token);
    } catch (err) {
      const error = new KanbanError("unauthorized", err instanceof Error ? err.message : String(err));
      if (ACL[name] && isWriteTool(name)) return auditWrite(name, { role: "unauthenticated", taskId: null, agentId: null }, () => { throw error; });
      throw error;
    }
  }
  const work = () => handleAuthenticatedTool(name, args, identity!, hooks);
  return ACL[name] && isWriteTool(name) ? auditWrite(name, identity, work) : work();
}

function onBehalfRequested(args: Record<string, unknown>): boolean {
  return args.onBehalf === true || args.onBehalf === "true";
}

async function handleAuthenticatedTool(name: string, args: Record<string, unknown>, identity: Identity, hooks?: { agentPresence?: (agentId: string) => Promise<AgentPresence> | AgentPresence }): Promise<unknown> {
  // Checked before the completer ACL. A worker who passes the flag is refused
  // here, instead of completing as themselves. Leaders are not in that ACL.
  if (name === "kanban_complete" && onBehalfRequested(args)) {
    return completeTask(taskId(identity, args), identity.role, String(args.summary ?? ""), args.handoff, {
      onBehalf: true,
      actorAgentId: identity.agentId,
    });
  }
  assertRole(identity, name);
  if (AGENT_BOUND.has(name)) assertCurrentAgent(identity, taskId(identity, args), name);
  switch (name) {
    case "kanban_supervise": {
      if (Object.keys(args).some((key) => key !== "project")) throw new KanbanError("invalid", t("tools.supervise.onlyProject"));
      if (typeof args.project !== "string" || !args.project.trim()) throw new KanbanError("invalid", t("tools.supervise.needProject"));
      return superviseProject(identity, args.project.trim());
    }
    case "kanban_show":
    {
      const id = taskId(identity, args, "read");
      const detail = getDetail(id);
      if (identity.taskId != null && identity.taskId !== id) {
        const own = getTask(identity.taskId);
        return isOpsCleanupWorker(identity) || (hasProjectRead(own) && detail.task.project === own.project) ? projectReadView(detail) : relatedView(detail);
      }
      return detail;
    }
    case "kanban_list": {
      if (identity.role === "supervisor") {
        return listBoard(typeof args.project === "string" ? args.project : undefined, { includeRemoved: args.includeRemoved === true || args.includeRemoved === "true" });
      }
      return workerList(identity, args);
    }
    case "kanban_grant_read":
      return changeReadGrant(taskId(identity, args), args.scope, identity);
    case "kanban_revoke_read":
      return changeReadGrant(taskId(identity, args), undefined, identity, true);
    case "kanban_doctor": {
      // A card token never triggers live collection or writes a report: it can only read the last one.
      if (identity.role !== "supervisor" || args.last === true || args.last === "true") {
        const last = readLastDoctorReport();
        return last ?? { text: t("tools.noDoctorReport") };
      }
      // Doctor only reads; a lost config file is one of its red findings, not a reason to stop (DEMO_0001).
      const settings = doctorSettings(loadConfigForReport());
      const deadline = Date.now() + settings.totalTimeoutMs;
      const sources = await connectAndCollect(process.env, deadline);
      const left = Math.max(1, deadline - Date.now());
      return runDoctor({ sources, wake: false, persist: true, settings: { ...settings, totalTimeoutMs: left } });
    }
    case "kanban_comment": {
      const id = taskId(identity, args);
      const text = String(args.text ?? args.body ?? "");
      if (!text.trim()) throw new KanbanError("invalid", t("tools.emptyComment"));
      addComment(id, identity.role, text);
      const task = getTask(id);
      appendEvent(id, "comment", null, task.status, identity.agentId ?? identity.role, {
        agentId: identity.agentId,
      });
      return { ok: true, id, code: cardMark(id) };
    }
    case "kanban_complete":
      return completeTask(taskId(identity, args), identity.role, String(args.summary ?? ""), args.handoff);
    case "kanban_block":
      return blockTask(taskId(identity, args), String(args.kind ?? ""), String(args.reason ?? ""), identity.role, { until: args.until });
    case "kanban_approve":
      return approveTask(taskId(identity, args), String(args.summary ?? ""), identity.role, identity.agentId);
    case "kanban_request_changes":
      return requestChanges(taskId(identity, args), String(args.reason ?? ""), String(args.findings ?? ""), identity.role);
    case "kanban_create": {
      const target = createTarget(identity, args);
      const parents = parentIdsFromArgs(args.parents);
      const title = String(args.title ?? "");
      const brief = typeof args.brief === "string" ? args.brief : "";
      const decision = parseDecisionId(args.decision);
      assertReminderGuard({ isSchedule: identity.role === SCHEDULE_ROLE, title, brief, decision });
      return createTask({
        project: target.project,
        title,
        brief,
        decision,
        role: String(args.role ?? ""),
        workspacePath: typeof args.workspace === "string" ? args.workspace : undefined,
        profileOverride: typeof args.profile === "string" ? args.profile : undefined,
        parentIds: parents,
        contract: typeof args.contract === "string" ? args.contract : undefined,
        maxRetries: parseMaxRetries(args.maxRetries),
        noSplitHint: args.noSplitHint === true || args.noSplitHint === "true",
        tags: normalizeTags(args.tags ?? args.tag),
        effort: parseEffort(args.effort),
        tier: parseTier(args.tier),
        reviewOf: target.reviewOf,
        actor: identity.role,
        createdByAgent: identity.agentId,
      });
    }
    case "kanban_link": {
      const id = taskId(identity, args);
      assertSupervisorScope(identity, getTask(id), t("tools.action.link"));
      return linkTask(id, resolveTaskId(args.parent), identity.role);
    }
    case "kanban_unlink": {
      const id = taskId(identity, args);
      assertUnlinkScope(identity, getTask(id));
      return unlinkTask(id, [...parentIdsFromArgs(args.parent), ...parentIdsFromArgs(args.parents)], identity.agentId ?? identity.role);
    }
    case "kanban_unblock": {
      const id = taskId(identity, args);
      assertSupervisorScope(identity, getTask(id), t("tools.action.unblock"), { unblock: true });
      return unblockTask(id, identity.role, args.runBudget === undefined ? undefined : { runBudget: args.runBudget, reason: args.reason, grantedBy: identity.agentId });
    }
    case "kanban_wait_user": {
      const id = taskId(identity, args);
      assertWaitUserScope(identity, getTask(id), t("tools.action.waitUser"));
      return waitUser(id, parseDecisionId(args.decision, true)!, identity.role);
    }
    case "kanban_unwait": {
      const id = taskId(identity, args);
      assertWaitUserScope(identity, getTask(id), t("tools.action.unwait"));
      return unwait(id, identity.role);
    }
    case "kanban_accept": {
      const id = taskId(identity, args);
      assertSupervisorScope(identity, getTask(id), t("tools.action.accept"));
      if (typeof args.artifact === "string") {
        return acceptTask(id, identity.role, { artifact: args.artifact, reason: typeof args.reason === "string" ? args.reason : undefined });
      }
      return acceptTask(id, identity.role);
    }
    case "kanban_rework": {
      const id = taskId(identity, args);
      assertLeaderDecisionScope(identity, getTask(id));
      if (typeof args.agent === "string") assertBindableAgent(args.agent.trim(), "agent");
      return leaderReworkTask(id, String(args.reason ?? ""), {
        agentId: typeof args.agent === "string" ? args.agent : undefined,
        countRound: args.countRound === true,
        presence: hooks?.agentPresence ?? ((agentId) => livePresence(agentId, process.env)),
      }, identity.agentId ?? identity.role);
    }
    case "kanban_pass": {
      const id = taskId(identity, args);
      assertLeaderDecisionScope(identity, getTask(id));
      return leaderPassTask(id, String(args.note ?? ""), identity.agentId ?? identity.role);
    }
    case "kanban_reject": {
      const id = taskId(identity, args);
      assertSupervisorScope(identity, getTask(id), t("tools.action.reject"));
      return rejectTask(id, String(args.reason ?? ""), identity.role);
    }
    case "kanban_archive": {
      const id = taskId(identity, args);
      assertSupervisorScope(identity, getTask(id), t("tools.action.archive"));
      return archiveTask(id, identity.role);
    }
    case "kanban_register": {
      const raw = String(args.project ?? "");
      const project = raw.trim() ? resolveConfiguredProject(raw, t("tools.action.register")) : raw;
      if (project) assertProjectInPaseo(project);
      if (project) assertProjectScope(identity, project, t("tools.action.register"));
      assertBindableAgent(String(args.agent ?? "").trim(), "agent");
      return registerTask({
        project,
        title: String(args.title ?? ""),
        brief: typeof args.brief === "string" ? args.brief : "",
        role: String(args.role ?? ""),
        profileName: String(args.profile ?? ""),
        provider: String(args.provider ?? ""),
        model: String(args.model ?? ""),
        thinking: typeof args.thinking === "string" ? args.thinking : undefined,
        agentId: String(args.agent ?? ""),
        family: typeof args.family === "string" ? args.family : undefined,
        workspacePath: typeof args.workspace === "string" ? args.workspace : undefined,
        idempotencyKey: typeof args.idempotency === "string" ? args.idempotency : undefined,
        actor: identity.role,
        startedAt: typeof args.startedAt === "string" ? args.startedAt : undefined,
      });
    }
    default:
      throw new KanbanError("unknown_tool", t("tools.unknownTool", { tool: name }));
  }
}

export function formatResult(data: unknown): string {
  if (isRelatedView(data)) return formatRelated(data);
  if (data && typeof data === "object" && "text" in data && typeof (data as { text: unknown }).text === "string") return (data as { text: string }).text;
  if (data && typeof data === "object" && "status" in data && "title" in data && "id" in data) {
    const task = data as { id: number; title: string; status: string; role?: string; project?: string; code?: string };
    const label = typeof task.code === "string" && task.code ? task.code : cardMark(task.id);
    const merged = (data as { merged?: unknown }).merged;
    const unmerged = (data as { unmerged?: unknown }).unmerged;
    const pending = (data as { pending?: unknown }).pending;
    const landed = Array.isArray(merged)
      ? `\n${merged.length ? merged.map((line) => t("tools.result.mergedCommit", { commit: String(line) })).join("\n") : t("tools.result.noNewCommits")}`
      : typeof pending === "string" && pending
        ? `\n${t("tools.result.landQueued", { pending })}`
        : typeof unmerged === "string" && unmerged
          ? `\n${t("tools.result.unmerged", { branch: unmerged })}`
          : "";
    const warnings = (data as { warnings?: string[] }).warnings ?? [];
    const warningText = warnings.map(warning => `\n${t("tools.result.warning", { warning })}`).join("");
    const waiting = (data as { wait_decision?: string | null }).wait_decision;
    const status = t("tools.result.status", { status: statusLabel(task.status) });
    const scheduled = data as { blocked_kind?: string | null; scheduled_until?: string | null };
    const wait = task.status === "blocked" && scheduled.blocked_kind === "background" ? t("common.paren", { text: t("background.label") }) : task.status === "blocked" && scheduled.blocked_kind === "scheduled" && scheduled.scheduled_until
      ? t("common.paren", { text: scheduledWaitLabel(scheduled.scheduled_until) }) : waiting ? t("common.paren", { text: waitUserHold(waiting) }) : "";
    const project = task.project ? `\n${t("tools.result.project", { project: task.project })}` : "";
    return `${label} ${task.title}\n${status}${wait}${project}${landed}${warningText}`;
  }
  if (data && typeof data === "object" && Array.isArray((data as { tasks?: unknown }).tasks)) {
    const tasks = (data as { tasks: Array<{ id: number; code?: string; title: string; status: string; project?: string; waitDecision?: string | null; blockedKind?: string | null; scheduledUntil?: string | null; reviewStatus?: string | null }> }).tasks;
    if (tasks.length === 0) return t("tools.result.noCards");
    return tasks
      .map((task) => {
        const label = task.code || cardMark(task.id);
        const state = task.status === "blocked" && task.blockedKind === "background" ? t("background.label") : task.status === "blocked" && task.blockedKind === "scheduled" && task.scheduledUntil
          ? scheduledWaitLabel(task.scheduledUntil) : task.waitDecision ? `${statusLabel(task.status)}${t("common.comma")}${waitUserHold(task.waitDecision)}` : statusLabel(task.status);
        return `${label} ${task.title}${t("common.paren", { text: state })}${task.project ? ` · ${task.project}` : ""}${task.reviewStatus ? ` · ${task.reviewStatus}` : ""}`;
      })
      .join("\n");
  }
  return JSON.stringify(data, null, 2);
}
