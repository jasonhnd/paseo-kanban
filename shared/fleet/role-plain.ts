import { type MessageKey, t } from "./i18n";

export interface DutyState {
  dispatchable: boolean;
  reason: string;
}

export interface Serving {
  model: string;
  pool: string | null;
  status: "prefer" | "ready" | "paused";
  poolState: DutyState | null;
}

export interface RoleSource {
  key: string;
  lineup: Serving[];
}

export interface WorkGroup {
  role: string;
  count: number;
  recent: Array<{ project: string; title: string; at: string; code: string }>;
}

export interface RoleCard {
  name: string;
  who: string;
  status: string;
  tone: "green" | "yellow" | "red";
  weekCount: number;
  recent: Array<{ project: string; title: string; code: string }>;
  tokens: number | null;
}

const CARDS: Array<{ name: MessageKey; keys: string[]; token: string }> = [
  { name: "roles.cards.executor", keys: ["executor"], token: "executor" },
  { name: "roles.cards.reviewer", keys: ["reviewer"], token: "reviewer" },
  { name: "roles.cards.reader", keys: ["reader"], token: "reader" },
  { name: "roles.cards.decision", keys: ["decision"], token: "decision" },
  { name: "roles.cards.batch", keys: ["batch"], token: "batch" },
  { name: "roles.cards.ops", keys: ["ops_vercel", "ops_cloudflare", "ops_github", "ops_notion"], token: "ops" },
];

export function humanModel(model: string): string {
  const text = model.toLowerCase();
  if (text.includes("grok")) {
    const ver = /grok-([0-9.]+)/i.exec(model)?.[1];
    return ver ? `Grok ${ver}` : "Grok";
  }
  if (text.includes("sonnet")) return "Claude Sonnet";
  if (text.includes("opus")) return "Claude Opus";
  if (text.includes("haiku")) return "Claude Haiku";
  if (text.includes("fable")) return "Claude Fable";
  return t("roles.cards.currentModel");
}

/** `viaNames`: pool id → how the work is paid for (shared/quota-adapters.ts poolNames(catalog, "via")). */
export function whoLine(model: string, pool: string | null, viaNames: Readonly<Record<string, string>> = {}): string {
  const name = humanModel(model);
  const via = pool ? viaNames[pool] : undefined;
  return via ? t("roles.cards.who", { name, via }) : name;
}

export function dutyStatus(person: Serving | undefined): { text: string; tone: RoleCard["tone"] } {
  if (!person) return { text: t("roles.cards.stopped"), tone: "red" };
  const stopped = person.status === "paused" || person.poolState?.dispatchable === false;
  if (!stopped) return { text: t("roles.cards.ready"), tone: "green" };
  const when = person.poolState ? /(\d{1,2}\/\d{1,2}\s+\d{1,2}:\d{2})/.exec(person.poolState.reason) : null;
  if (when) return { text: t("roles.cards.pausedUntil", { when: when[1] }), tone: "red" };
  return { text: t("roles.cards.stopped"), tone: "red" };
}

export function buildRoleCards(roles: RoleSource[], work: WorkGroup[], tokens: Record<string, number> | null, viaNames: Readonly<Record<string, string>> = {}): RoleCard[] {
  const byKey = new Map(roles.map((role) => [role.key, role]));
  const byWork = new Map(work.map((row) => [row.role, row]));
  return CARDS.map((card) => {
    const people = card.keys.flatMap((key) => {
      const head = byKey.get(key)?.lineup[0];
      return head ? [head] : [];
    });
    const names = [...new Set(people.map((person) => whoLine(person.model, person.pool, viaNames)))];
    const duties = people.map(dutyStatus);
    const stopped = duties.find((duty) => duty.tone === "red");
    const tasks = card.keys.flatMap((key) => byWork.get(key)?.recent ?? []);
    tasks.sort((a, b) => b.at.localeCompare(a.at));
    const seen = new Set<string>();
    const recent: RoleCard["recent"] = [];
    for (const job of tasks) {
      const id = `${job.code}|${job.project}|${job.title}`;
      if (seen.has(id)) continue;
      seen.add(id);
      recent.push({ project: job.project, title: job.title, code: job.code });
      if (recent.length >= 3) break;
    }
    const weekCount = card.keys.reduce((sum, key) => sum + (byWork.get(key)?.count ?? 0), 0);
    return {
      name: t(card.name),
      who: names.length > 0 ? names.join(t("roles.cards.listJoin")) : t("roles.cards.nobody"),
      status: stopped?.text ?? t("roles.cards.ready"),
      tone: stopped?.tone ?? "green",
      weekCount,
      recent,
      tokens: tokens ? (tokens[card.token] ?? 0) : null,
    };
  });
}
