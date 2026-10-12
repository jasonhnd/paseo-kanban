/// <reference types="node" />
// The ChatGPT credits balance file and the plans.json credits window.
import { baseAdapterOf, CODEX_CLI, type PlanSource } from "../../shared/fleet/quota-adapters";
import { plansOf } from "./adapters/plans";
import {
  codexCreditsCardLine,
  codexWeeklyReading,
  creditsBalanceForDispatch,
  creditsReadDue,
  nextCodexCreditsState,
  parseCodexCreditsBalance,
  type CodexCreditsFile,
  type CodexCreditsInput,
} from "../../shared/fleet/reset-coupons";
import { readJson, writeJson } from "./util";
import { CODEX_CREDITS_FILE, PLANS } from "./reset-coupons-types";

function asCreditsFile(raw: unknown): CodexCreditsFile | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Partial<CodexCreditsFile>;
  const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
  return {
    balance: num(row.balance),
    readAt: typeof row.readAt === "string" ? row.readAt : null,
    weekBalance: num(row.weekBalance),
    weekResetsAt: typeof row.weekResetsAt === "string" ? row.weekResetsAt : null,
    readable: row.readable === true,
  };
}

export async function readCreditsFile(): Promise<CodexCreditsFile | null> {
  return asCreditsFile(await readJson<unknown>(CODEX_CREDITS_FILE, null));
}

/** Fold one read-only rate-limits payload into the credits file. A null payload is a failed read. */
export async function storeCodexCredits(raw: unknown | null, now: number, resetsAt: string | null): Promise<void> {
  try {
    const prev = await readCreditsFile();
    const balance = raw === null ? null : parseCodexCreditsBalance(raw);
    const fromPayload = raw === null ? null : codexWeeklyReading(raw).resetsAt;
    const next = nextCodexCreditsState(prev, { balance, at: now, resetsAt: resetsAt ?? fromPayload });
    await writeJson(CODEX_CREDITS_FILE, next);
  } catch (error) {
    console.error("[afc] codex credits:", String(error).slice(0, 160));
  }
}

/** `creditsStartAt` / `creditsExpireAt` of the Codex plan (codex-cli) in plans.json. */
export async function readCodexCreditDates(): Promise<{ startAt: string; expireAt: string } | null> {
  const plans = plansOf(await readJson<unknown>(PLANS, null)) as Array<PlanSource & { creditsStartAt?: unknown; creditsExpireAt?: unknown }>;
  const plan = plans.find((row) => baseAdapterOf(row) === CODEX_CLI);
  const startAt = plan?.creditsStartAt;
  const expireAt = plan?.creditsExpireAt;
  if (typeof startAt !== "string" || startAt.length === 0) return null;
  if (typeof expireAt !== "string" || expireAt.length === 0) return null;
  return { startAt, expireAt };
}

/** Dates plus the balance dispatch may use. Null when plans.json has no credits window. */
export async function readCodexCreditsForDispatch(now = Date.now()): Promise<CodexCreditsInput | null> {
  const dates = await readCodexCreditDates();
  if (!dates) return null;
  const live = creditsBalanceForDispatch(await readCreditsFile(), now);
  return { ...dates, ...live };
}

/** Quota-card sentence. Null when plans.json has no credits window. */
export async function codexCreditsCardText(now = Date.now()): Promise<string | null> {
  const dates = await readCodexCreditDates();
  if (!dates) return null;
  const state = await readCreditsFile();
  const fresh = Boolean(state?.readable && !creditsReadDue(state.readAt, now));
  return codexCreditsCardLine({
    balance: state?.balance ?? null,
    fresh,
    startAt: dates.startAt,
    expireAt: dates.expireAt,
  });
}
