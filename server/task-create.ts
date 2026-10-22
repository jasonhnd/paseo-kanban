/// <reference types="node" />
import { getDb } from "./db";
import { assertReviewAvailable } from "./review-assignment";
import { readContract, writeContract } from "./pr";
import { parseWorkspace, resolveCreateWorkspace } from "./workspace";
import { mergeCardDependency, mergeCardWarnings, parentsBlockReason, type ParentRef } from "./parents";
import { parseEffort } from "./effort";
import { normalizeTags, parseTags } from "./profile-rules";
import { isTier, parseTier, type Tier } from "./tier";
import { takeCodeSeq } from "./card-ref";
import { lanesDisabledMessage, projectWorkspace } from "./config";
import { KanbanError } from "./errors";
import { type Status } from "../shared/labels";
import { t } from "../shared/i18n";
import { addEvent, now, taskById, type TaskRow } from "./task-record";

export interface CreateInput {
  project: string;
  title: string;
  brief?: string;
  role: string;
  workspacePath?: string;
  profileOverride?: string;
  parentIds?: number[];
  priority?: number;
  idempotencyKey?: string;
  contract?: string;
  workspaceBase?: string;
  actor?: string;
  createdByAgent?: string | null;
  initialStatus?: "triage";
  maxRetries?: number;
  /** Card tags that profile rules read, e.g. high-risk, complex-docs. */
  tags?: string[];
  /** Forced reasoning depth: low, medium, high, xhigh, or max. Omit to keep the profile default. */
  effort?: string | null;
  /** Difficulty L1–L4. Omit to leave it empty. L4 also adds the high-risk tag. */
  tier?: string | null;
  /** Card under review. Stored on tasks.review_of. */
  reviewOf?: number | null;
  /** Pending decision id this card cites. Recorded on the created event. */
  decision?: string | null;
}

function writeContractJson(input?: string): string {
  return writeContract(readContract(input && input.trim() ? input : "local-only"));
}

/** L4 cards are high-risk reviews even when the caller forgot the tag. */
function withHighRisk(tags: string[], tier: Tier | null): string[] {
  if (tier !== "L4" || tags.includes("high-risk")) return tags;
  return [...tags, "high-risk"];
}

function writeTags(tags: string[]): string | null {
  return tags.length > 0 ? JSON.stringify(tags) : null;
}

function createIdentity(input: CreateInput): { project: string; title: string; role: string } {
  const project = input.project.trim();
  const title = input.title.trim();
  if (!project || !title) throw new KanbanError("invalid", t("taskCreate.error.noProjectTitle"));
  const role = input.role.trim();
  if (!role) throw new KanbanError("invalid", t("taskCreate.error.noRole"));
  return { project, title, role };
}

function placedWorkspace(project: string, role: string, workspacePath: string | undefined, workspaceBase: string | undefined) {
  const resolved = resolveCreateWorkspace(project, role, workspacePath, workspaceBase);
  const workspace = parseWorkspace(resolved.path, resolved.base);
  if (workspace.kind === "lane" && !projectWorkspace(project).lanesEnabled) {
    throw new KanbanError("invalid", lanesDisabledMessage());
  }
  if (workspace.kind === "lane" && !workspace.root) {
    throw new KanbanError("invalid", t("taskCreate.error.laneRepo"));
  }
  return workspace;
}

function assertReviewTarget(reviewOf: number | null | undefined, role: string): void {
  if (reviewOf == null) return;
  if (!Number.isInteger(reviewOf) || reviewOf <= 0) throw new KanbanError("invalid", t("taskCreate.error.reviewsId"));
  if (role !== "reviewer") throw new KanbanError("invalid", t("taskCreate.error.reviewsRole"));
  taskById(reviewOf);
  assertReviewAvailable(reviewOf);
}

interface InsertedTask {
  project: string;
  title: string;
  brief: string;
  role: string;
  profileOverride: string | null;
  status: Status;
  priority: number;
  idempotencyKey: string | null;
  maxRetries: number;
  workspaceRoot: string | null;
  workspaceKind: string;
  workspaceBase: string | null;
  contractJson: string;
  actor: string;
  createdByAgent: string | null;
  tagsJson: string | null;
  effort: string | null;
  tier: Tier | null;
  reviewOf: number | null;
  codeSeq: number;
  ts: string;
}

function insertCreatedTask(db: ReturnType<typeof getDb>, row: InsertedTask): number {
  const info = db
    .prepare(
      `INSERT INTO tasks (
        project, title, brief, role, profile_override, status, priority, idempotency_key, max_retries,
        workspace_path, workspace_kind, workspace_base, contract_json, created_by, created_by_agent, tags, effort, tier, review_of, code_seq, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.project,
      row.title,
      row.brief,
      row.role,
      row.profileOverride,
      row.status,
      row.priority,
      row.idempotencyKey,
      row.maxRetries,
      row.workspaceRoot,
      row.workspaceKind,
      row.workspaceBase,
      row.contractJson,
      row.actor,
      row.createdByAgent,
      row.tagsJson,
      row.effort,
      row.tier,
      row.reviewOf,
      row.codeSeq,
      row.ts,
      row.ts,
    );
  return Number(info.lastInsertRowid);
}

function createdRow(
  input: CreateInput,
  project: string,
  title: string,
  role: string,
  status: Status,
  tier: Tier | null,
  tags: string[],
  effort: string | null,
  contractJson: string,
  workspace: { root: string | null; kind: string; base: string | null },
): InsertedTask {
  const ts = now();
  const codeSeq = takeCodeSeq(project);
  return {
    project,
    title,
    brief: input.brief ?? "",
    role,
    profileOverride: input.profileOverride ?? null,
    status,
    priority: input.priority ?? 0,
    idempotencyKey: input.idempotencyKey ?? null,
    maxRetries: input.maxRetries ?? 2,
    workspaceRoot: workspace.root,
    workspaceKind: workspace.kind,
    workspaceBase: workspace.base,
    contractJson,
    actor: input.actor ?? "supervisor",
    createdByAgent: input.createdByAgent ?? null,
    tagsJson: tags.length > 0 ? JSON.stringify(tags) : null,
    effort,
    tier,
    reviewOf: input.reviewOf ?? null,
    codeSeq,
    ts,
  };
}

export function createTask(input: CreateInput): TaskRow & { warnings?: string[]; profileHint?: ProfilePriorityHint } {
  const db = getDb();
  if (db.isTransaction) return createTaskInTransaction(input);
  db.exec("BEGIN IMMEDIATE");
  try {
    const task = createTaskInTransaction(input);
    db.exec("COMMIT");
    return task;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

function createTaskInTransaction(input: CreateInput): TaskRow & { warnings?: string[]; profileHint?: ProfilePriorityHint } {
  const { project, title, role } = createIdentity(input);
  const parents = input.parentIds ?? [];
  const parentRows = parents.map((id) => taskById(id));
  const db = getDb();
  if (input.idempotencyKey) {
    const existing = db.prepare("SELECT * FROM tasks WHERE idempotency_key = ?").get(input.idempotencyKey) as TaskRow | undefined;
    if (existing) return existing;
  }
  const workspace = placedWorkspace(project, role, input.workspacePath, input.workspaceBase);
  const tier = parseTier(input.tier);
  const tags = withHighRisk(normalizeTags(input.tags), tier);
  const effort = parseEffort(input.effort);
  assertReviewTarget(input.reviewOf, role);
  const contractJson = writeContractJson(input.contract);
  const actor = input.actor ?? "supervisor";
  const child = { role, title, brief: input.brief ?? "", project, contract_json: contractJson };
  const blockedByParents = parentsBlockReason(parentRows, Date.now(), child);
  const status: Status = input.initialStatus === "triage" ? "triage" : blockedByParents ? "waiting" : "ready";
  const id = insertCreatedTask(db, createdRow(input, project, title, role, status, tier, tags, effort, contractJson, workspace));
  for (const parentId of parents) {
    db.prepare(`INSERT INTO links (task_id, parent_id) VALUES (?, ?)`).run(id, parentId);
  }
  addEvent(id, "created", null, status, actor, input.decision ? { parents, decision: input.decision } : { parents });
  const task = taskById(id);
  recordMergeCardDependencies(task, parentRows, actor);
  const hint = profilePriorityHint(task);
  if (hint) {
    const { message, ...data } = hint;
    addEvent(id, "profile_priority_hint", null, null, actor, { ...data, reason: message });
  }
  const result = withMergeCardWarnings(task, parentRows);
  if (!hint) return result;
  return { ...result, profileHint: hint, warnings: [...(result.warnings ?? []), hint.message] };
}

export interface ProfilePriorityHint {
  profile: string;
  pool: string | null;
  suggested: string;
  suggestedPool: string | null;
  role: string;
  tier: Tier;
  message: string;
}

export type ProfileHintSource = (task: TaskRow) => ProfilePriorityHint | null;

let hintSource: ProfileHintSource | null = null;

/**
 * routing.ts registers the matrix lookup here. Importing routing from this file would
 * pull flow → store → task-create into a cycle, so the dependency points the other way.
 */
export function setProfileHintSource(source: ProfileHintSource | null): void {
  hintSource = source;
}

/** Never blocks card creation: any failure means no hint. */
function profilePriorityHint(task: TaskRow): ProfilePriorityHint | null {
  if (!task.profile_override || !hintSource) return null;
  try {
    return hintSource(task);
  } catch (err) {
    console.error("[paseo-kanban] profile priority hint", err instanceof Error ? err.message : String(err));
    return null;
  }
}

/** Record once per child/parent/PR, including cards created before recognition existed. */
export function recordMergeCardDependencies(task: TaskRow, parents: ParentRef[], actor: string): void {
  for (const parent of parents) {
    const pr = mergeCardDependency(task, parent);
    if (!pr) continue;
    const seen = getDb().prepare(`SELECT 1 FROM events WHERE task_id = ? AND kind = 'merge_card_dependency' AND json_extract(data_json, '$.parent') = ? AND json_extract(data_json, '$.pr') = ?`).get(task.id, parent.id, pr);
    if (!seen) addEvent(task.id, "merge_card_dependency", null, null, actor, { parent: parent.id, pr });
  }
}

export function withMergeCardWarnings(task: TaskRow, parents: ParentRef[]): TaskRow & { warnings?: string[] } {
  const warnings = mergeCardWarnings(task, parents);
  return warnings.length ? { ...task, warnings } : task;
}

/** Change the stored tier. Takes effect the next time an agent is opened. L4 adds high-risk. */
export function setTaskTier(id: number, tier: Tier | null, actor: string): TaskRow {
  const task = taskById(id);
  const previous = task.tier && isTier(task.tier) ? task.tier : null;
  if (previous === tier && !(tier === "L4" && !parseTags(task.tags).includes("high-risk"))) return task;
  const tags = withHighRisk(parseTags(task.tags), tier);
  const added = tags.filter((tag) => !parseTags(task.tags).includes(tag));
  getDb()
    .prepare("UPDATE tasks SET tier = ?, tags = ?, updated_at = ? WHERE id = ?")
    .run(tier, writeTags(tags), now(), id);
  if (previous !== tier) {
    addEvent(id, "tier_changed", null, task.status, actor, {
      from: previous,
      to: tier,
      reason: `${previous ?? t("taskCreate.tier.unset")} → ${tier ?? t("taskCreate.tier.unset")}`,
    });
  }
  if (added.length > 0) addEvent(id, "tagged", null, task.status, actor, { added, tags, reason: tagsAddedReason(added) });
  return taskById(id);
}

/** Add tags to an existing card. Does not remove tags. Records a tagged event. */
export function addTaskTags(id: number, input: unknown, actor: string): TaskRow {
  const adding = normalizeTags(input);
  if (adding.length === 0) throw new KanbanError("invalid", t("taskCreate.error.noTag"));
  const task = taskById(id);
  const current = parseTags(task.tags);
  const added = adding.filter((tag) => !current.includes(tag));
  if (added.length === 0) return task;
  const tags = [...current, ...added];
  getDb().prepare("UPDATE tasks SET tags = ?, updated_at = ? WHERE id = ?").run(writeTags(tags), now(), id);
  addEvent(id, "tagged", null, task.status, actor, { added, tags, reason: tagsAddedReason(added) });
  return taskById(id);
}

function tagsAddedReason(added: string[]): string {
  return t("taskCreate.tags.added", { tags: added.join(t("common.listSep")) });
}

export function bindPaseoWorkspace(id: number, workspaceId: string, name: string, actor: string): void {
  const task = taskById(id);
  if (task.paseo_workspace_id === workspaceId && task.paseo_workspace_name === name) return;
  getDb().prepare("UPDATE tasks SET paseo_workspace_id = ?, paseo_workspace_name = ?, updated_at = ? WHERE id = ?").run(workspaceId, name, now(), id);
  addEvent(id, "workspace_bound", null, null, actor, { workspaceId, name });
}
