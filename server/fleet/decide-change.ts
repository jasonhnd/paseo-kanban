/// <reference types="node" />
// Change of answer: the user changes a letter they already picked. The old item is closed, and `roles decide overturn`
// only takes supervisor decisions, so the change opens a copy with the same question and closes it with
// the new letter. The old item gets a comment, the project's <leader> gets one message. `roles` and `send`
// are injected, so tests never touch a real session.
import { choiceExcerpt } from "../../shared/fleet/decision-choices";
import {
  canChangeChoice, changeNote, changePrompt, changeSuccess, letterFromNote, supersededNote,
} from "../../shared/fleet/decision-change";
import { supervisorIdFor } from "../../shared/fleet/decisions";
import { t } from "../../shared/fleet/i18n";
import { chooseSupervisor, type DecideDeps, noLeaderMessage, rolesCommentArgs, rolesDoneArgs } from "./decide-reply";
import { DECISIONS, type Json, readJson } from "./util";

export interface ClosedDecision {
  id: string;
  project: string;
  title: string;
  detail: string;
  note: string;
  doneAtMs: number | null;
  blocking: boolean;
  agentId: string | null;
  source: string;
}

export interface ChangeDeps extends DecideDeps {
  readClosed: (id: string) => Promise<ClosedDecision | null>;
  now: () => number;
}

export interface ChangeResult {
  ok: boolean;
  message: string;
  /** The item that now holds the answer. A second change must start from it, not from the first one. */
  newId: string | null;
}

const fail = (message: string): ChangeResult => ({ ok: false, message, newId: null });
const kept = (): string => t("decisions.change.kept");
const failed = (error: string): ChangeResult => fail(t("decisions.change.failed", { kept: kept(), error }));

export function rolesAddArgs(item: ClosedDecision): string[] {
  const args = ["decide", "add", "--project", item.project, "--title", item.title, "--detail", item.detail, "--source", item.source];
  // No --blocking: the copy is closed within moments, and a leftover open copy must not show up as blocking.
  if (item.agentId) args.push("--agent", item.agentId);
  return args;
}

export async function submitChange(
  input: { id: string; choice: string; text: string },
  deps: ChangeDeps,
): Promise<ChangeResult> {
  const id = input.id.trim();
  if (!/^[A-Za-z0-9._-]+$/.test(id)) return fail(t("decisions.change.badId"));
  const to = input.choice.trim();
  if (!/^[A-D]$/.test(to)) return fail(t("decisions.change.badChoice"));
  const text = input.text.replace(/\s+/g, " ").trim().slice(0, 500);
  const old = await deps.readClosed(id);
  if (!old) return fail(t("decisions.change.notFound", { kept: kept() }));
  if (!canChangeChoice(old.doneAtMs, deps.now())) return fail(t("decisions.change.tooOld", { kept: kept() }));
  const from = letterFromNote(old.note);
  if (!from) return fail(t("decisions.change.unreadable", { kept: kept() }));
  if (from === to) return fail(t("decisions.change.same", { from }));

  let newId: string;
  try {
    newId = /added\s+(\S+)/.exec(await deps.roles(rolesAddArgs(old)))?.[1] ?? "";
  } catch (error) {
    return failed(String(error).slice(0, 200));
  }
  if (!newId) return failed(t("decisions.change.noNewId"));

  const excerpt = choiceExcerpt(old.title, old.detail, to);
  try {
    await deps.roles(rolesDoneArgs(newId, changeNote(id, from, to, excerpt, text)));
  } catch (error) {
    await deps.roles(["decide", "done", newId, "--as", "shelved", "--note", t("decisions.change.unfinishedNote")]).catch(() => "");
    return failed(String(error).slice(0, 200));
  }
  await deps.roles(rolesCommentArgs(id, supersededNote(newId, from, to))).catch(() => "");

  const table = await deps.readTable();
  const target = chooseSupervisor({ project: old.project, table, agents: await deps.listAgents() });
  if (target.via === "missing" || !supervisorIdFor(old.project, table)) {
    return { ok: true, message: t("decisions.change.recordedNoLeader", { to, noLeader: noLeaderMessage() }), newId };
  }
  try {
    await deps.send(target.agentId, changePrompt(id, old.title, from, to, excerpt && text ? t("decisions.note.join", { a: excerpt, b: text }) : excerpt || text));
  } catch (error) {
    return { ok: true, message: t("decisions.change.recordedNotifyFailed", { to, error: String(error).slice(0, 200) }), newId };
  }
  return { ok: true, message: changeSuccess(to, target.title), newId };
}

export async function readClosedDecision(id: string): Promise<ClosedDecision | null> {
  const items = await readJson<Json[]>(DECISIONS, []);
  const item = items.find((row) => String(row.id) === id && row.status === "done");
  if (!item) return null;
  const doneAt = Date.parse(String(item.doneAt ?? ""));
  return {
    id: String(item.id),
    project: String(item.project ?? ""),
    title: String(item.title ?? ""),
    detail: String(item.detail ?? ""),
    note: String(item.note ?? ""),
    doneAtMs: Number.isNaN(doneAt) ? null : doneAt,
    blocking: item.blocking === true,
    agentId: typeof item.agentId === "string" && item.agentId ? item.agentId : null,
    source: typeof item.source === "string" && item.source ? item.source : t("decisions.source.default"),
  };
}
