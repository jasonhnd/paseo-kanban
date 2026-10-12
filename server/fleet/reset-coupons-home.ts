/// <reference types="node" />
// Home-page text from the saved state and the pool snapshot. Reads only.
import { chatgptBurnBanner, couponInHand, type CouponAlert } from "../../shared/fleet/reset-coupons";
import { CLAUDE_CLI, CODEX_CLI, poolOfAdapter } from "../../shared/fleet/quota-adapters";
import { readPoolCatalog } from "./adapters/plans";
import { POOL_STATUS } from "./pools";
import { readJson } from "./util";
import { readPlans, readState } from "./reset-coupons-state";
import { tAll } from "../../shared/fleet/i18n";
import { claudeView, modeAlerts, shownOf } from "./reset-coupons-view";

interface PoolRow {
  usedPct?: unknown;
  resetsAt?: unknown;
  reason?: unknown;
}

const HOME_NOTE_TTL_MS = 2 * 24 * 60 * 60 * 1000;

/** The stored pool reason says the burn week hit the cap (in any language a previous run wrote). */
function atCapReason(reason: string): boolean {
  return tAll("coupons.core.burnCapReason").some((text) => reason.includes(text));
}

/** The Claude main pool and the Codex pool of plans.json (their coupons are the ones the rounds watch). */
async function couponPoolIds(): Promise<{ claude: string | null; codex: string | null }> {
  const catalog = await readPoolCatalog();
  return { claude: poolOfAdapter(catalog, CLAUDE_CLI)?.id ?? null, codex: poolOfAdapter(catalog, CODEX_CLI)?.id ?? null };
}

/** The Claude main week from the snapshot. */
export async function weeklyFromSnapshot(): Promise<{ usedPct: number | null; resetsAt: string | null }> {
  const [file, ids] = await Promise.all([readJson<{ pools?: Record<string, { usedPct?: unknown; resetsAt?: unknown }> }>(POOL_STATUS, {}), couponPoolIds()]);
  const row = ids.claude ? file.pools?.[ids.claude] : undefined;
  return {
    usedPct: typeof row?.usedPct === "number" ? row.usedPct : null,
    resetsAt: typeof row?.resetsAt === "string" ? row.resetsAt : null,
  };
}

/** Home-page sentences: Claude's named burn week, and ChatGPT while an unexpired coupon is in hand. */
export async function couponHomeBanner(now = Date.now()): Promise<string | null> {
  const plans = await readPlans();
  const state = await readState();
  const claude = claudeView(plans.seeds.claude, state.companies.claude, state, now, plans.cliRead.claude);
  const chat = shownOf("chatgpt", plans.seeds.chatgpt, state.companies.chatgpt, false, now, plans.cliRead.chatgpt);
  const parts: string[] = [];
  if (claude.mode.banner) parts.push(claude.mode.banner);
  if (chat.expiresAt && couponInHand(chat.count, chat.expiresAt, now)) parts.push(chatgptBurnBanner(chat.count, chat.expiresAt));
  return parts.length > 0 ? parts.join("\n") : null;
}

export async function couponHomeAlerts(now = Date.now()): Promise<Pick<CouponAlert, "level" | "kind" | "text">[]> {
  const plans = await readPlans();
  const state = await readState();
  const weekly = await weeklyFromSnapshot();
  const [pools, ids] = await Promise.all([readJson<{ pools?: Record<string, PoolRow> }>(POOL_STATUS, {}), couponPoolIds()]);
  const claudePool = ids.claude ? pools.pools?.[ids.claude] : undefined;
  const codexPool = ids.codex ? pools.pools?.[ids.codex] : undefined;
  const claude = claudeView(plans.seeds.claude, state.companies.claude, state, now, plans.cliRead.claude);
  const codex = shownOf("chatgpt", plans.seeds.chatgpt, state.companies.chatgpt, false, now, plans.cliRead.chatgpt);
  const alerts = modeAlerts(claude, codex, {
    now,
    usedPct: weekly.usedPct,
    resetsAt: weekly.resetsAt,
    lastUseNotifyAt: state.lastUseNotifyAt,
    codexUsedPct: typeof codexPool?.usedPct === "number" ? codexPool.usedPct : null,
    codexResetsAt: typeof codexPool?.resetsAt === "string" ? codexPool.resetsAt : null,
    atCap: typeof claudePool?.reason === "string" && atCapReason(claudePool.reason),
  }).map(({ level, kind, text }) => ({ level, kind, text }));
  const notes = (state.homeNotes ?? []).filter((note) => {
    const at = Date.parse(note.at);
    return !Number.isNaN(at) && now - at < HOME_NOTE_TTL_MS;
  }).map((note) => ({
    level: tAll("coupons.signals.suspectedKind").includes(note.kind) ? "yellow" as const : "red" as const,
    kind: note.kind,
    text: note.text,
  }));
  return [...alerts, ...notes];
}
