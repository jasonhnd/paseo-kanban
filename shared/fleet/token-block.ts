import { CLAUDE_PROVIDER, CURSOR_PROVIDER, GROK_PROVIDER } from "./quota-adapters";
import { t } from "./i18n";

export const TOKEN_POOLS = [
  { key: CLAUDE_PROVIDER, label: "Claude" },
  { key: CURSOR_PROVIDER, label: "Cursor" },
  { key: GROK_PROVIDER, label: "SuperGrok" },
] as const;

export type TokenPoolKey = (typeof TOKEN_POOLS)[number]["key"];

export interface DayTokens {
  label: string;
  today: boolean;
  claude: number;
  cursor: number;
  grok: number;
}

export function daySum(day: Pick<DayTokens, TokenPoolKey>): number {
  return day.claude + day.cursor + day.grok;
}

export function weekSum(days: readonly Pick<DayTokens, TokenPoolKey>[]): number {
  return days.reduce((sum, day) => sum + daySum(day), 0);
}

export function poolSum(days: readonly Pick<DayTokens, TokenPoolKey>[], key: TokenPoolKey): number {
  return days.reduce((sum, day) => sum + day[key], 0);
}

export function chartMax(days: readonly Pick<DayTokens, TokenPoolKey>[]): number {
  return Math.max(1, ...days.map(daySum));
}

export function barPx(sum: number, max: number): number {
  return (sum / max) * 96;
}

export function stackPx(part: number, sum: number, bar: number): number {
  if (sum <= 0) return 0;
  return (part / sum) * bar;
}

export function shareFlex(pct: number): number {
  return Math.max(pct, 0.5);
}

export function shareCaption(shares: readonly { name: string; pct: number }[]): string {
  return shares.map((share) => `${share.name} ${share.pct}%`).join(" · ");
}

export function dayCaption(day: Pick<DayTokens, "today" | "label">): string {
  return day.today ? t("tokens.day.today") : day.label;
}
