import type { AgentPermissionAction, AgentPermissionRequest } from "@getpaseo/protocol/agent-types";
import { judgeReadOnly } from "./readonly";
import { t, type MessageKey } from "../shared/i18n";
import { scopedReadAllowed, type TaskReadScope } from "./read-scope";

export type PermissionDecision =
  | { action: "ignore" }
  | { action: "allow"; selectedActionId?: string }
  | { action: "deny"; reason: string };

function allowActionId(actions: AgentPermissionAction[] | undefined): string | undefined {
  return actions?.find((action) => /allow|approve|once/i.test(`${action.id} ${JSON.stringify(action)}`) && !/always|reject|deny/i.test(action.id))?.id;
}

/** Tools a reviewer may call. Creating, accepting, and archiving are never on this list. */
const REVIEWER_TOOLS = new Set(["kanban_show", "kanban_list", "kanban_comment", "kanban_block", "kanban_approve", "kanban_request_changes", "kanban_doctor"]);
/** Tools a reader, decision, or batch agent may call. */
const READER_TOOLS = new Set(["kanban_show", "kanban_list", "kanban_comment", "kanban_block", "kanban_complete", "kanban_doctor"]);
const KNOWN_TOOLS = new Set([
  ...REVIEWER_TOOLS,
  ...READER_TOOLS,
  "kanban_ping",
  "kanban_create",
  "kanban_link",
  "kanban_unlink",
  "kanban_grant_read",
  "kanban_revoke_read",
  "kanban_unblock",
  "kanban_wait_user",
  "kanban_unwait",
  "kanban_accept",
  "kanban_reject",
  "kanban_rework",
  "kanban_pass",
  "kanban_archive",
  "kanban_register",
  "kanban_doctor",
]);

const ROLE_LABEL_KEYS: Record<string, MessageKey> = {
  reviewer: "permissions.role.reviewer",
  reader: "permissions.role.reader",
  decision: "permissions.role.decision",
  batch: "permissions.role.batch",
};

/**
 * Providers prefix the board's own tools differently.
 * `kanban_show`, `kanban_kanban_show`, `mcp__kanban__kanban_show`, `kanban/kanban_show`,
 * and Cursor's `kanban-kanban_show` are the same tool.
 */
export function canonicalKanbanTool(raw: string): string | null {
  let name = raw.trim();
  if (!name) return null;
  name = name.replace(/^mcp__kanban__/i, "");
  name = name.replace(/^kanban\//i, "");
  // Cursor MCP display name is `<server>-<tool>`, so the board's tools arrive as `kanban-kanban_show`.
  name = name.replace(/^kanban-/i, "");
  while (name.startsWith("kanban_kanban_")) name = name.slice("kanban_".length);
  if (!KNOWN_TOOLS.has(name)) return null;
  return name;
}

/** Names an adapter gives a request when it has no tool identity (Cursor MCP calls arrive as `other`). */
const GENERIC_NAMES = new Set(["other", "unknown", ""]);
/** Detail types that can carry a board tool call. shell, edit, write, read, search... never can. */
const BOARD_DETAIL_TYPES = new Set(["plain_text", "unknown"]);
/** Cursor's MCP display name for a board tool, `<server>-<tool>`. Only this left side is read. */

type ToolIdentity = { tool: string | null; conflict: boolean };

/**
 * Trusted identity: the adapter-written request.name
 * (Paseo's ToolCallDetail has no MCP server/tool fields, and request.input and
 * request.metadata are agent-controlled, so none of those count).
 * Invented identity fields or a shell/edit/write/read
 * detail makes the request a conflict, which is refused.
 *
 * Display titles, labels, input and metadata never establish identity. An adapter
 * that emits only a display title must supply structured identity before it can be allowed.
 */
function kanbanToolFrom(request: AgentPermissionRequest): ToolIdentity {
  const detail = request.detail as { type?: unknown; toolName?: unknown; name?: unknown; label?: unknown } | undefined;
  const detailType = typeof detail?.type === "string" ? detail.type : "unknown";
  const found = new Set<string>();
  let foreign = false;
  // ToolCallDetail only defines toolName for search. It has no trusted MCP name
  // field; accepting invented detail.name/toolName would promote payload text.
  for (const field of [request.name]) {
    if (typeof field !== "string" || GENERIC_NAMES.has(field)) continue;
    const tool = canonicalKanbanTool(field);
    if (tool) found.add(tool);
    else foreign = true;
  }
  if (found.size === 0 && foreign) return { tool: null, conflict: false };
  if (found.size === 0) {
    return { tool: null, conflict: false };
  }
  const badDetail = !BOARD_DETAIL_TYPES.has(detailType) || detail?.toolName !== undefined || detail?.name !== undefined;
  if (found.size === 1 && !foreign && !badDetail) return { tool: [...found][0] ?? null, conflict: false };
  return { tool: null, conflict: true };
}

function readonlyTools(role: string): Set<string> | null {
  if (role === "reviewer") return REVIEWER_TOOLS;
  if (role === "reader" || role === "decision" || role === "batch") return READER_TOOLS;
  return null;
}

/** Read-only roles are checked before auto_accept. A supervisor leaves approval to the host. */
export function decidePermission(input: {
  kanban: boolean;
  autoAccept: boolean;
  role: string | null;
  request: AgentPermissionRequest;
  readScope?: TaskReadScope;
}): PermissionDecision {
  if (!input.kanban || input.role === "supervisor") return { action: "ignore" };
  const readOnly = input.role === "reviewer" || input.role === "reader" || input.role === "decision";
  if (!readOnly && input.autoAccept) return { action: "allow", selectedActionId: allowActionId(input.request.actions) };
  if (readOnly && input.request.kind !== "tool") {
    return { action: "deny", reason: t("permissions.deny.conflict") };
  }
  const { tool, conflict } = kanbanToolFrom(input.request);
  if (conflict) return { action: "deny", reason: t("permissions.deny.conflict") };
  const allowed = input.role ? readonlyTools(input.role) : null;
  if (tool && allowed) {
    if (allowed.has(tool)) return { action: "allow", selectedActionId: allowActionId(input.request.actions) };
    const labelKey = ROLE_LABEL_KEYS[input.role ?? ""];
    const who = labelKey ? t(labelKey) : input.role;
    return { action: "deny", reason: t("permissions.deny.tool", { who: who ?? "", tool }) };
  }
  if (readOnly) {
    const detailType = input.request.detail?.type;
    if ((input.role === "reader" || input.role === "decision") && (detailType === "read" || detailType === "search") && !scopedReadAllowed(input.request, input.readScope)) {
      return { action: "deny", reason: t("readonly.readScopeRequired") };
    }
    const verdict = judgeReadOnly(input.request, { shell: input.role === "reviewer" });
    if (verdict.allow) return { action: "allow", selectedActionId: allowActionId(input.request.actions) };
    return { action: "deny", reason: verdict.reason };
  }
  return { action: "deny", reason: t("permissions.deny.noAutoAccept") };
}
