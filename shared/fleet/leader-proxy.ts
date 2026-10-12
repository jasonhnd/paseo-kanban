import { catalogChars, lazy } from "./decision-parse";
import { t } from "./i18n";
import { isEndedProxy, type LeaderDetail, type PanelDecision } from "./leader-panel";

/** What names the session's own project: its title and the directory it runs in. */
export interface AgentHint { title: string; cwd: string }
export interface ProxyLine { project: string; code: string; ended: boolean }
interface ProxyRow { project: string; code: string; agentId: string; proxyOf?: string }

const norm = (text: string) => text.trim().toLowerCase();
/** Separators between "<leader>" and the project in a session title, in any language. */
const TITLE_SEPARATOR_RE = lazy(() => new RegExp(`[${catalogChars("decisions.proxy.titleSeparators")}]`));

/** 2 = title is "<leader> · project"; 1 = working directory belongs to the project; 0 = no sign. */
function ownScore(row: ProxyRow, hint: AgentHint | undefined): number {
  if (!hint) return 0;
  const tail = hint.title.split(TITLE_SEPARATOR_RE()).pop() ?? "";
  if ([row.project, row.code].some((name) => norm(tail) === norm(name))) return 2;
  const folders = hint.cwd.split("/").map(norm);
  return folders.some((f) => f === norm(row.project) || f.endsWith(`_${norm(row.project)}`)) ? 1 : 0;
}

/**
 * One agent id registered for several projects: the project it really belongs to keeps the row,
 * the others get `proxyOf`. Without any sign the first registered project keeps it.
 */
export function markProxies<T extends ProxyRow>(rows: readonly T[], hints: ReadonlyMap<string, AgentHint>): T[] {
  const primary = new Map<string, T>();
  for (const row of rows) {
    const best = primary.get(row.agentId);
    if (!best || ownScore(row, hints.get(row.agentId)) > ownScore(best, hints.get(row.agentId))) primary.set(row.agentId, row);
  }
  return rows.map((row) => {
    const owner = primary.get(row.agentId)!;
    return owner === row ? row : { ...row, proxyOf: owner.project };
  });
}

function mergeDetail(base: LeaderDetail | undefined, extra: readonly LeaderDetail[]): LeaderDetail | undefined {
  if (!base) return base;
  const seen = new Set(base.cards.map((c) => c.id));
  const cards = [...base.cards];
  for (const detail of extra) for (const card of detail.cards) if (!seen.has(card.id)) { seen.add(card.id); cards.push(card); }
  const wakes = Math.max(base.repeatWakes24h ?? 0, ...extra.map((d) => d.repeatWakes24h ?? 0));
  return { ...base, cards, repeatWakes24h: wakes };
}

/**
 * The Leader cards view: proxied projects leave the list, their cards and decisions count under the owner,
 * and each owner learns which projects it also covers (and which of them are finished).
 */
export function foldProxies<R extends ProxyRow, D extends PanelDecision>(
  rows: readonly R[], details: readonly LeaderDetail[], decisions: readonly D[],
): { rows: R[]; details: LeaderDetail[]; decisions: D[]; proxies: Map<string, ProxyLine[]> } {
  const present = new Set(rows.map((r) => r.project));
  // A proxied project whose owner is not in the list (paused) keeps its own card unless it has ended.
  const orphan = (r: R) => Boolean(r.proxyOf) && !present.has(r.proxyOf!);
  const owners = rows.filter((r) => !r.proxyOf || (orphan(r) && !isEndedProxy(r, details, decisions)));
  const proxied = rows.filter((r) => r.proxyOf && !owners.includes(r) && !orphan(r));
  const byProject = new Map(details.map((d) => [d.project, d]));
  const proxies = new Map<string, ProxyLine[]>();
  const moved = new Map<string, string>();
  for (const row of proxied) {
    const detail = byProject.get(row.project);
    const line = { project: row.project, code: row.code, ended: isEndedProxy(row, details, decisions) };
    proxies.set(row.proxyOf!, [...(proxies.get(row.proxyOf!) ?? []), line]);
    moved.set(row.project.toLowerCase(), row.proxyOf!);
  }
  const folded = owners.map((row) => mergeDetail(byProject.get(row.project), proxied.filter((p) => p.proxyOf === row.project).map((p) => byProject.get(p.project)).filter((d): d is LeaderDetail => Boolean(d))));
  return {
    rows: owners,
    details: folded.filter((d): d is LeaderDetail => Boolean(d)),
    decisions: decisions.map((d) => moved.has(d.project.toLowerCase()) ? { ...d, project: moved.get(d.project.toLowerCase())! } : d),
    proxies,
  };
}

export function proxyLine(lines: readonly ProxyLine[] | undefined): string | null {
  if (!lines?.length) return null;
  const items = lines.map((l) => t(l.ended ? "decisions.proxy.itemEnded" : "decisions.proxy.item", { project: l.project, code: l.code }));
  return t("decisions.proxy.line", { list: items.join(t("decisions.proxy.listSeparator")) });
}
