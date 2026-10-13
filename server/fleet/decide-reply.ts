/// <reference types="node" />
// Homepage decisions: a letter closes the item with `roles decide done`.
// A sentence, or a request to rewrite missing options, only tells the supervisor.
// `roles` and `paseo send` are injected so tests never touch a real session.
import { choiceExcerpt } from "../../shared/fleet/decision-choices";
import { REPLY_CHOICE, supervisorIdFor } from "../../shared/fleet/decisions";
import { t } from "../../shared/fleet/i18n";
import { rolesBin } from "./paths";
import { readKanbanSupervisors } from "./upgrade-check";
import { isLeaderTitle, readAgentRecords } from "./records";
import { BIN, DECISIONS, type Json, readJson, run, sendToAgent } from "./util";


export interface DecideAgent {
  id: string;
  title: string;
  cwd: string;
  archivedAt: string | null;
  labels?: Record<string, string>;
}

export interface OpenDecisionItem {
  id: string;
  project: string;
  title: string;
  detail?: string;
}

export type SupervisorVia = "registered" | "title";

export function noLeaderMessage(): string {
  return t("decisions.reply.noLeader");
}

/** Stored note when the user shelves an item of a project without a <leader>. Sent with `--as shelved`. */
export function userShelveNote(): string {
  return t("decisions.reply.userShelveNote");
}

/** Stored note when the user closes an item from the panel. Sent with `--as decided`. */
export function userDismissNote(): string {
  return t("decisions.reply.userDismissNote");
}

export type SupervisorPick =
  | { via: SupervisorVia; agentId: string; title: string }
  | { via: "missing" };

export interface DecideDeps {
  readOpen: (id: string) => Promise<OpenDecisionItem | null>;
  /** Any status, used to undo a panel close and to name the leader. Optional for older callers. */
  readRecord?: (id: string) => Promise<OpenDecisionItem | null>;
  roles: (args: string[]) => Promise<string>;
  send: (agentId: string, prompt: string) => Promise<void>;
  readTable: () => Promise<Record<string, string> | null>;
  listAgents: () => Promise<DecideAgent[]>;
}

/** Note stored when the user actually picks a letter. Excerpt is the option text; comment is optional. */
export function decisionNote(choice: string, excerpt: string, comment = ""): string {
  const phrase = excerpt.trim();
  const extra = comment.trim();
  const body = phrase && extra ? t("decisions.note.join", { a: phrase, b: extra }) : phrase || extra;
  const picked = t("decisions.note.picked", { choice });
  return body ? `${picked}${t("decisions.note.text", { text: body })}` : picked;
}

export function askOptionsPrompt(item: OpenDecisionItem): string {
  return t("decisions.prompt.askOptions", { id: item.id, title: item.title });
}

export function userCommentPrompt(item: OpenDecisionItem, text: string): string {
  return t("decisions.prompt.userComment", { id: item.id, title: item.title, text: text.trim() });
}

export function decisionPrompt(
  item: OpenDecisionItem,
  choice: string,
  text: string,
  via: SupervisorVia,
): string {
  const body = text.trim();
  const said = body ? t("decisions.prompt.said", { text: body }) : "";
  return t("decisions.prompt.decided", { id: item.id, title: item.title, choice, said });
}

export function successMessage(choice: string, via: SupervisorVia, title: string): string {
  return t("decisions.reply.recordedNotified", { choice, title });
}

export function rolesDoneArgs(id: string, note: string): string[] {
  return ["decide", "done", id, "--note", note];
}

export function rolesDismissArgs(id: string, note = userDismissNote()): string[] {
  return ["decide", "done", id, "--as", "decided", "--note", note];
}

export function rolesReopenArgs(id: string): string[] {
  return ["decide", "reopen", id];
}

export function dismissPrompt(item: OpenDecisionItem, note = userDismissNote()): string {
  return t("decisions.prompt.dismissed", { id: item.id, title: item.title, note });
}

export function restorePrompt(item: OpenDecisionItem): string {
  return t("decisions.prompt.restored", { id: item.id, title: item.title });
}

export function rolesCommentArgs(id: string, note: string): string[] {
  return ["decide", "comment", id, "--note", note];
}

/** Only a registered project can receive messages; never delegate to AFC. */
export function chooseSupervisor(input: {
  project: string;
  table: Record<string, string> | null;
  agents: readonly DecideAgent[];
}): SupervisorPick {
  const registered = supervisorIdFor(input.project, input.table);
  if (registered) {
    const agent = input.agents.find((row) => row.id === registered);
    if (!agent || !agent.archivedAt) {
      return { via: "registered", agentId: registered, title: agent?.title || t("decisions.reply.projectLeader") };
    }
  }
  const needle = input.project.toLowerCase();
  const byTitle = registered && input.agents.find((row) =>
    !row.archivedAt
    && row.cwd.toLowerCase().includes(needle)
    && (row.labels?.role === "supervisor" || isLeaderTitle(row.title)),
  );
  if (byTitle) return { via: "title", agentId: byTitle.id, title: byTitle.title };
  return { via: "missing" };
}

function cleanChoice(raw: string): string | null {
  const choice = raw.trim();
  if (/^[A-D]$/.test(choice) || (Object.values(REPLY_CHOICE) as string[]).includes(choice)) return choice;
  return null;
}

/** Close from the panel. A second click, a missing leader, or a failed notice does not throw. */
async function dismissDecision(id: string, deps: DecideDeps): Promise<{ ok: boolean; message: string }> {
  const item = await deps.readOpen(id);
  if (!item) return { ok: true, message: t("decisions.reply.dismissedAlready") };
  try {
    await deps.roles(rolesDismissArgs(item.id));
  } catch (error) {
    return { ok: false, message: t("decisions.reply.notRecorded", { error: String(error).slice(0, 200) }) };
  }
  const target = await supervisorFor(item, deps);
  if (target.via === "missing") return { ok: true, message: t("decisions.reply.dismissedNoLeader") };
  try {
    await deps.send(target.agentId, dismissPrompt(item));
  } catch (error) {
    return { ok: true, message: t("decisions.reply.dismissedNotifyFailed", { error: String(error).slice(0, 200) }) };
  }
  return { ok: true, message: t("decisions.reply.dismissedNotified", { title: target.title }) };
}

/** Undo a panel close. Already open is a no-op. A missing leader or a failed notice still counts as reopened. */
async function restoreDecision(id: string, deps: DecideDeps): Promise<{ ok: boolean; message: string }> {
  const open = await deps.readOpen(id);
  if (open) return { ok: true, message: t("decisions.reply.restoredAlready") };
  const record = deps.readRecord ? await deps.readRecord(id) : null;
  if (deps.readRecord && !record) {
    return { ok: false, message: t("decisions.reply.restoreFailed", { error: t("cli.roles.noItem", { id }) }) };
  }
  try {
    await deps.roles(rolesReopenArgs(id));
  } catch (error) {
    return { ok: false, message: t("decisions.reply.restoreFailed", { error: String(error).slice(0, 200) }) };
  }
  if (!record) return { ok: true, message: t("decisions.reply.restored") };
  const target = await supervisorFor(record, deps);
  if (target.via === "missing") return { ok: true, message: t("decisions.reply.restored") };
  try {
    await deps.send(target.agentId, restorePrompt(record));
  } catch {
    return { ok: true, message: t("decisions.reply.restored") };
  }
  return { ok: true, message: t("decisions.reply.restoredNotified", { title: target.title }) };
}

async function supervisorFor(item: OpenDecisionItem, deps: DecideDeps): Promise<SupervisorPick> {
  const [table, agents] = await Promise.all([deps.readTable(), deps.listAgents()]);
  return chooseSupervisor({ project: item.project, table, agents });
}

export async function submitDecision(
  input: { id: string; choice: string; text: string },
  deps: DecideDeps,
): Promise<{ ok: boolean; message: string }> {
  const id = input.id.trim();
  if (!/^[A-Za-z0-9._-]+$/.test(id)) return { ok: false, message: t("decisions.reply.badId") };
  const choice = cleanChoice(input.choice);
  if (!choice) return { ok: false, message: t("decisions.reply.badChoice") };
  const text = input.text.replace(/\s+/g, " ").trim().slice(0, 500);
  if (choice === REPLY_CHOICE.comment && !text) return { ok: false, message: t("decisions.reply.needText") };
  if (choice === REPLY_CHOICE.dismiss) return dismissDecision(id, deps);
  if (choice === REPLY_CHOICE.restore) return restoreDecision(id, deps);
  const item = await deps.readOpen(id);
  if (!item) return { ok: false, message: t("decisions.reply.notOpen") };

  if (choice === REPLY_CHOICE.shelve) {
    // Recheck registration at submission time: a stale panel must not shelve a now-owned group.
    if (supervisorIdFor(item.project, await deps.readTable())) {
      return { ok: false, message: t("decisions.reply.nowOwned") };
    }
    try {
      await deps.roles(["decide", "done", item.id, "--as", "shelved", "--note", userShelveNote()]);
      return { ok: true, message: t("decisions.reply.shelved") };
    } catch (error) {
      return { ok: false, message: t("decisions.reply.shelveFailed", { error: String(error).slice(0, 200) }) };
    }
  }

  if (choice === REPLY_CHOICE.askOptions) {
    const target = await supervisorFor(item, deps);
    if (target.via === "missing") return { ok: false, message: noLeaderMessage() };
    try {
      await deps.send(target.agentId, askOptionsPrompt(item));
    } catch (error) {
      return { ok: false, message: t("decisions.reply.askFailed", { error: String(error).slice(0, 200) }) };
    }
    return { ok: true, message: t("decisions.reply.asked", { title: target.title }) };
  }

  if (choice === REPLY_CHOICE.comment) {
    let recorded = false;
    try {
      await deps.roles(rolesCommentArgs(item.id, text));
      recorded = true;
    } catch {
      recorded = false;
    }
    const target = await supervisorFor(item, deps);
    if (target.via === "missing") {
      return { ok: false, message: recorded ? t("decisions.reply.commentSavedNoLeader", { noLeader: noLeaderMessage() }) : noLeaderMessage() };
    }
    try {
      await deps.send(target.agentId, userCommentPrompt(item, text));
    } catch (error) {
      const why = String(error).slice(0, 200);
      return { ok: false, message: recorded ? t("decisions.reply.commentSavedNotifyFailed", { error: why }) : t("decisions.reply.notifyFailed", { error: why }) };
    }
    return { ok: true, message: t("decisions.reply.passedOn", { title: target.title }) };
  }

  const excerpt = choiceExcerpt(item.title, item.detail ?? "", choice);
  const note = decisionNote(choice, excerpt, text);
  try {
    await deps.roles(rolesDoneArgs(item.id, note));
  } catch (error) {
    return { ok: false, message: t("decisions.reply.notRecorded", { error: String(error).slice(0, 200) }) };
  }
  const target = await supervisorFor(item, deps);
  if (target.via === "missing") {
    return { ok: true, message: t("decisions.reply.recordedNoLeader", { choice, noLeader: noLeaderMessage() }) };
  }
  const spoken = excerpt && text ? t("decisions.note.join", { a: excerpt, b: text }) : excerpt || text;
  try {
    await deps.send(target.agentId, decisionPrompt(item, choice, spoken, target.via));
  } catch (error) {
    return { ok: false, message: t("decisions.reply.recordedNotifyFailed", { choice, error: String(error).slice(0, 200) }) };
  }
  return { ok: true, message: successMessage(choice, target.via, target.title) };
}

export function productionDecideDeps(): DecideDeps {
  return {
    readOpen: readOpenDecision,
    readRecord: readDecisionRecord,
    // Managed updates replace the configured checkout after loading this module.
    roles: (args) => run(rolesBin(), args, 20_000),
    send: async (agentId, prompt) => {
      await sendToAgent(agentId, prompt);
    },
    readTable: () => readKanbanSupervisors(),
    listAgents: async () => (await readAgentRecords()).map((row) => ({
      id: row.id,
      title: row.title,
      cwd: row.cwd,
      archivedAt: row.archivedAt,
      labels: row.labels,
    })),
  };
}

function asDecisionItem(row: Json | undefined): OpenDecisionItem | null {
  if (!row) return null;
  return {
    id: String(row.id),
    project: String(row.project ?? ""),
    title: String(row.title ?? ""),
    detail: String(row.detail ?? ""),
  };
}

async function readOpenDecision(id: string): Promise<OpenDecisionItem | null> {
  const items = await readJson<Json[]>(DECISIONS, []);
  return asDecisionItem(items.find((row) => String(row.id) === id && row.status === "open"));
}

async function readDecisionRecord(id: string): Promise<OpenDecisionItem | null> {
  const items = await readJson<Json[]>(DECISIONS, []);
  return asDecisionItem(items.find((row) => String(row.id) === id));
}
