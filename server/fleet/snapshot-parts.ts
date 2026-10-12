/// <reference types="node" />
import { providerBanned } from "../../shared/fleet/provider-policy";
import { readBannedProviders } from "./adapters/config";
// Pieces of the board snapshot that need no Paseo call: change log, pool state, the role table,
// the per-agent pass over the live list, and the decision list. `buildSnapshot` only wires them.
import { readFile } from "node:fs/promises";
import { type BoardAgent, type BoardSnapshot, ROLE_ORDER } from "../../shared/fleet/board";
import { buildLineup, countRunsToday, type DispatchProfile, tokyoDayStart } from "../../shared/fleet/dispatch";
import { decisionOwner } from "../../shared/fleet/decisions";
import { t, tAll } from "../../shared/fleet/i18n";
import { isPausedProject, withoutPaused } from "../../shared/fleet/paused";
import { poolFlagsFromJson } from "./dispatch";
import { readRunsSince } from "./kanban";
import { type Profile, roleOf } from "./records";
import { CHANGES, type Json, minutesSince, projectOf, tilde } from "./util";

type Alert = BoardSnapshot["alerts"][number];
type Decision = BoardSnapshot["decisions"][number];
type Role = BoardSnapshot["roles"][number];

export const RECENT_MS = 24 * 60 * 60 * 1000;
export const STUCK_MINUTES = 20;

export interface LiveAgent {
  id: string;
  title: string;
  labels: Record<string, string>;
  status: string;
  cwd: string;
  updatedAt: string | null;
  lastActivityAt: string | null;
  requiresAttention: boolean;
  attentionReason: string | null;
  lastError: string | null;
  archivedAt: string | null;
  createdAt: string | null;
  contextTokens: number | null;
}

export async function readChanges(): Promise<BoardSnapshot["changes"]> {
  const text = await readFile(CHANGES, "utf8").catch(() => "");
  return text.trim().split("\n").filter(Boolean).slice(-8).reverse().flatMap((line) => {
    try {
      const c = JSON.parse(line);
      const from = String(c.from);
      const to = String(c.to);
      if (providerBanned(`${from} ${to}`, readBannedProviders())) return [];
      return [{ at: String(c.at), role: String(c.role), from, to }];
    } catch {
      return [];
    }
  });
}

export function poolStateOf(ps: Json | undefined): BoardSnapshot["roles"][number]["poolState"] {
  if (!ps) return null;
  return {
    dispatchable: Boolean(ps.dispatchable),
    deprioritize: Boolean(ps.deprioritize),
    prefer: Boolean(ps.prefer),
    reason: String(ps.reason ?? ""),
    usedPct: typeof ps.usedPct === "number" ? ps.usedPct : null,
    pacePct: typeof ps.pacePct === "number" ? ps.pacePct : null,
    daysLeft: typeof ps.daysLeft === "number" ? ps.daysLeft : null,
    dailyPct: typeof ps.dailyPct === "number" ? ps.dailyPct : null,
    paceState: typeof ps.paceState === "string" ? ps.paceState : undefined,
  };
}

export function describeRole(p: Profile): { model: string; detail: string; modelId: string } {
  const parts = [
    p.thinkingOptionId ? t("snapshot.role.thinking", { value: p.thinkingOptionId }) : null,
    p.modeId ? t("snapshot.role.mode", { value: p.modeId }) : null,
    ...Object.entries(p.featureValues ?? {}).map(([k, v]) => `${k}=${String(v)}`),
  ].filter(Boolean);
  return { model: `${p.provider} / ${p.model ?? "?"}`, detail: parts.join(" · "), modelId: p.model ?? "?" };
}

/** The old list wrote the source as the old supervisor name. The board shows <leader>; decisions.json keeps the original text. */
export function leaderSource(raw: unknown): string {
  const text = String(raw ?? "<leader>");
  return tAll("snapshot.legacyLeaderName").includes(text) ? "<leader>" : text;
}

function lineupOf(key: string, profiles: DispatchProfile[], pools: Record<string, Json>, todayRuns: Record<string, number>, labels: Readonly<Record<string, string>>): Role["lineup"] {
  return buildLineup(key, profiles, poolFlagsFromJson(pools), todayRuns, labels).map((item) => ({
    name: item.name,
    family: item.family,
    model: item.model,
    effort: item.effort,
    pool: item.pool,
    poolLabel: item.poolLabel,
    status: item.status,
    statusText: item.statusText,
    todayRuns: item.todayRuns,
    poolState: item.pool ? poolStateOf(pools[item.pool]) : null,
  }));
}

/** One role row, or null when the role has neither a profile nor any lineup entry. */
function roleRow(key: (typeof ROLE_ORDER)[number], profiles: DispatchProfile[], pools: Record<string, Json>, todayRuns: Record<string, number>, labels: Readonly<Record<string, string>>): Role | null {
  const lineup = lineupOf(key, profiles, pools, todayRuns, labels);
  const p = profiles.find((x) => x.role === key);
  if (!p && lineup.length === 0) return null;
  const head = p ?? {
    name: lineup[0]?.name ?? key,
    family: lineup[0]?.family ?? null,
    provider: "",
    model: lineup[0]?.model ?? "?",
    thinkingOptionId: lineup[0]?.effort ?? undefined,
    pool: lineup[0]?.pool ?? null,
  };
  const described = describeRole({
    id: head.name,
    name: head.name,
    role: key,
    family: head.family ?? undefined,
    provider: head.provider ?? "",
    model: head.model ?? undefined,
    thinkingOptionId: "thinkingOptionId" in head ? head.thinkingOptionId ?? undefined : undefined,
    pool: head.pool ?? undefined,
  });
  return {
    key,
    name: p?.name ?? head.name,
    family: head.family ?? null,
    provider: head.provider ?? "",
    modelId: described.modelId,
    model: described.model,
    detail: described.detail,
    pool: head.pool ?? null,
    poolState: head.pool ? poolStateOf(pools[head.pool]) : null,
    lineup,
  };
}

/** The role table, plus a warning for every role that has no profile at all. */
/** `labels`: pool id → display name (shared/quota-adapters.ts poolNames(catalog, "label")). */
export function buildRoles(profiles: DispatchProfile[], pools: Record<string, Json>, now: number, labels: Readonly<Record<string, string>> = {}): { roles: Role[]; warnings: string[] } {
  profiles = profiles.filter((profile) => !providerBanned(profile, readBannedProviders()));
  const todayRuns = countRunsToday(readRunsSince(new Date(tokyoDayStart(now)).toISOString()), now);
  const roles: Role[] = [];
  const warnings: string[] = [];
  for (const key of ROLE_ORDER) {
    const row = roleRow(key, profiles, pools, todayRuns, labels);
    if (row) roles.push(row);
    else warnings.push(t("snapshot.roleProfileMissing", { role: key }));
  }
  return { roles, warnings };
}

/** The one alert a live agent can raise: an error, a permission wait, or a quiet running agent. */
export function liveAlert(a: LiveAgent): Alert | null {
  if (a.lastError || a.attentionReason === "error") {
    const error = a.lastError ? t("snapshot.errorSuffix", { error: a.lastError.slice(0, 120) }) : "";
    return { level: "red", kind: t("snapshot.alertKind.error"), text: `${a.title}${error}`, agentId: a.id };
  }
  if (a.attentionReason === "permission") return { level: "yellow", kind: t("snapshot.alertKind.awaitingApproval"), text: a.title, agentId: a.id };
  if (a.status !== "running") return null;
  const idle = minutesSince(a.lastActivityAt);
  if (idle === null || idle <= STUCK_MINUTES) return null;
  return { level: "yellow", kind: t("snapshot.alertKind.maybeStuck"), text: t("snapshot.quietFor", { title: a.title, minutes: Math.round(idle) }), agentId: a.id };
}

function unreadReply(a: LiveAgent, project: string): Decision {
  return { id: `reply-${a.id}`, project, title: t("snapshot.unread.title", { title: a.title }), detail: t("snapshot.unread.detail"), blocking: false, kind: "unread", source: t("snapshot.unread.source"), createdAt: a.updatedAt ?? "", agentId: a.id };
}

export interface LiveView {
  agents: BoardAgent[];
  supervisors: BoardSnapshot["supervisors"];
  alerts: Alert[];
  /** Unread leader replies. */
  decisions: Decision[];
}

/** One pass over the live agent list: who is on the board, who is a leader, what needs attention. */
export async function classifyLive(live: LiveAgent[], names: Map<string, string>, now: number): Promise<LiveView> {
  const view: LiveView = { agents: [], supervisors: [], alerts: [], decisions: [] };
  for (const a of live) {
    if (a.archivedAt) continue;
    const role = roleOf(a.title, a.labels, names);
    if (!role) continue;
    const project = await projectOf(a.cwd);
    if (role === "supervisor") {
      view.supervisors.push({ id: a.id, title: a.title, project, updatedAt: a.updatedAt });
      if (a.requiresAttention && a.attentionReason === "finished" && a.status !== "running") view.decisions.push(unreadReply(a, project));
    }
    const alert = liveAlert(a);
    if (alert) view.alerts.push(alert);
    const recent = a.updatedAt ? now - Date.parse(a.updatedAt) < RECENT_MS : false;
    if (a.status === "running" || recent) {
      view.agents.push({ id: a.id, role, title: a.title, status: a.status, where: tilde(a.cwd), project, updatedAt: a.updatedAt, source: "paseo" });
    }
  }
  return view;
}

/** Cards a person must unblock, as the Kanban part of the decision list. */
export function kanbanDecisions(blocked: Array<{ id: number; code: string; project: string; title: string; kind: string | null; reason: string; blockedAt: string | null; agentId: string | null }>): Decision[] {
  return blocked.map((k) => ({
    id: `kanban-${k.id}`,
    project: k.project,
    title: t("snapshot.kanbanBlocked.title", { code: k.code, title: k.title }),
    detail: t("snapshot.kanbanBlocked.detail", {
      why: k.kind ? t("snapshot.kanbanBlocked.reasonWithKind", { kind: k.kind }) : t("snapshot.kanbanBlocked.reason"),
      reason: k.reason || t("snapshot.kanbanBlocked.noReason"),
    }),
    blocking: true,
    kind: "decide" as const,
    source: "Kanban",
    createdAt: k.blockedAt ?? "",
    agentId: k.agentId,
  }));
}

/** Open entries of decisions.json, owned by the project's <leader> when one is registered. */
export function storedDecisions(stored: Json[], supervisorTable: Record<string, string> | null): Decision[] {
  return stored.filter((d) => d.status === "open").map((d) => ({
    id: String(d.id),
    project: String(d.project),
    title: String(d.title),
    detail: String(d.detail ?? ""),
    blocking: Boolean(d.blocking),
    kind: "decide" as const,
    source: leaderSource(d.source),
    createdAt: String(d.createdAt ?? ""),
    ...decisionOwner(String(d.project), supervisorTable),
    forceOpen: d.forceOpen === true,
  }));
}

/**
 * The counted decision list and the ones held back by paused projects.
 * Newest source first: Kanban cards, then stored decisions (each group reversed), then unread replies.
 * Blocking ones sort ahead; the sort is stable.
 */
export function assembleDecisions(
  unread: Decision[],
  stored: Decision[],
  kanban: Decision[],
  paused: readonly { project: string }[],
): { decisions: Decision[]; pausedDecisions: Decision[] } {
  const all = [...[...kanban].reverse(), ...[...stored].reverse(), ...unread].sort((a, b) => Number(b.blocking) - Number(a.blocking));
  return {
    decisions: withoutPaused(all, paused),
    pausedDecisions: all.filter((d) => isPausedProject(d.project, paused)),
  };
}
