import { DAY_MS, tokyoDayStart, TOKYO_OFFSET_MS } from "./dispatch";
import { CLAUDE_PROVIDER, CURSOR_PROVIDER, GROK_PROVIDER } from "./quota-adapters";
import { language, t, tAll, type MessageKey } from "./i18n";

export interface DayStack {
  label: string;
  today: boolean;
  claude: number;
  cursor: number;
  grok: number;
}

/** Token stacks on the home chart, one per adapter provider that runs agents (shared/quota-adapters.ts). */
export type PoolName = Exclude<keyof DayStack, "label" | "today">;

export function poolOfProvider(provider: string): PoolName | null {
  const name = provider.toLowerCase();
  if (name.includes(CLAUDE_PROVIDER) || name === "anthropic") return CLAUDE_PROVIDER;
  if (name.includes(CURSOR_PROVIDER)) return CURSOR_PROVIDER;
  if (name.includes(GROK_PROVIDER) || name === "xai") return GROK_PROVIDER;
  return null;
}

export function tokensOf(bucket: number[]): number {
  return (bucket[0] ?? 0) + (bucket[1] ?? 0) + (bucket[2] ?? 0) + (bucket[3] ?? 0) + (bucket[4] ?? 0);
}

function scaled(n: number, unit: number, key: MessageKey): string {
  const v = n / unit;
  const text = v >= 10 ? String(Math.round(v)) : String(Math.round(v * 10) / 10).replace(/\.0$/, "");
  return t(key, { n: text });
}

/**
 * A token count short enough for a bar: Chinese uses 10k / 100M steps (wan / yi), other languages K / M / B.
 * The name is kept for existing callers.
 */
export function fmtZhTokens(n: number): string {
  if (language() === "zh-CN") {
    if (n >= 1e8) return scaled(n, 1e8, "tokens.unit.yi");
    if (n >= 1e4) return scaled(n, 1e4, "tokens.unit.wan");
    return String(Math.round(n));
  }
  if (n >= 1e9) return scaled(n, 1e9, "tokens.unit.billion");
  if (n >= 1e6) return scaled(n, 1e6, "tokens.unit.million");
  if (n >= 1e3) return scaled(n, 1e3, "tokens.unit.thousand");
  return String(Math.round(n));
}

function dayLabel(start: number): string {
  const t = new Date(start + TOKYO_OFFSET_MS);
  return `${t.getUTCMonth() + 1}/${t.getUTCDate()}`;
}

/** Last 7 Tokyo days, today last. Providers outside the three dispatch pools are left out. */
export function stackDays(hits: Array<{ at: number; provider: string; tokens: number }>, now: number): DayStack[] {
  const today = tokyoDayStart(now);
  const starts: number[] = [];
  for (let i = 6; i >= 0; i--) starts.push(today - i * DAY_MS);
  const rows: DayStack[] = starts.map((start) => ({
    label: dayLabel(start),
    today: start === today,
    claude: 0,
    cursor: 0,
    grok: 0,
  }));
  const index = new Map(starts.map((start, i) => [start, i]));
  for (const hit of hits) {
    if (!Number.isFinite(hit.at) || hit.tokens <= 0) continue;
    const pool = poolOfProvider(hit.provider);
    if (!pool) continue;
    const slot = index.get(tokyoDayStart(hit.at));
    if (slot === undefined) continue;
    rows[slot][pool] += hit.tokens;
  }
  return rows;
}

// Older statistics may still carry an old role name; roleOf maps it to supervisor first, so it lands on <leader>.
/** Share rows on the home chart, in display order. Each role is a stable id; its label follows the language. */
export const SHARE_ROLES = ["leader", "reviewer", "executor", "reader", "decision", "batch", "ops", "personal", "outside"] as const;
export type ShareRole = (typeof SHARE_ROLES)[number];

const SHARE_LABEL: Record<ShareRole, MessageKey> = {
  leader: "tokens.share.leader",
  reviewer: "tokens.share.reviewer",
  executor: "tokens.share.executor",
  reader: "tokens.share.reader",
  decision: "tokens.share.decision",
  batch: "tokens.share.batch",
  ops: "tokens.share.ops",
  personal: "tokens.share.personal",
  outside: "tokens.share.outside",
};

/** The spend bucket label (shared/dispatch.ts claudeSpendLabel) each share row is fed from. */
const SPEND_LABEL: Record<ShareRole, MessageKey> = {
  leader: "dispatch.spend.supervisor",
  reviewer: "dispatch.spend.reviewer",
  executor: "dispatch.spend.executor",
  reader: "dispatch.spend.reader",
  decision: "dispatch.spend.decision",
  batch: "dispatch.spend.batch",
  ops: "dispatch.spend.ops",
  personal: "dispatch.spend.personal",
  outside: "dispatch.spend.outside",
};

/** A spend category (stable key, its spend label or its share label, in any language) to its share role; null when unknown. */
export function shareRoleOf(category: string): ShareRole | null {
  for (const role of SHARE_ROLES) {
    if (category === role || tAll(SHARE_LABEL[role]).includes(category) || tAll(SPEND_LABEL[role]).includes(category)) return role;
  }
  return null;
}

export interface RoleShare {
  name: string;
  pct: number;
  tokens: number;
}

export function shareByRole(hits: Array<{ category: string; tokens: number }>): RoleShare[] {
  const totals = new Map<ShareRole, number>();
  for (const hit of hits) {
    if (!(hit.tokens > 0)) continue;
    const role = shareRoleOf(hit.category);
    if (!role) continue;
    totals.set(role, (totals.get(role) ?? 0) + hit.tokens);
  }
  const sum = [...totals.values()].reduce((acc, n) => acc + n, 0);
  return SHARE_ROLES.flatMap((key) => {
    const tokens = totals.get(key) ?? 0;
    if (tokens <= 0) return [];
    return [{ name: t(SHARE_LABEL[key]), tokens, pct: sum > 0 ? Math.round((tokens / sum) * 1000) / 10 : 0 }];
  });
}

/** Tokens per share role key (`executor`, `reviewer`, ...); the row name is the label in any language. */
export function tokenMap(shares: readonly RoleShare[]): Record<string, number> {
  return Object.fromEntries(shares.map((row) => [shareRoleOf(row.name) ?? row.name, row.tokens]));
}
