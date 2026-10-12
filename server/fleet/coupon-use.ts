/// <reference types="node" />
// Shared steps for bin/afc-use-coupon. This file never selects the yes phrase and never names the redeem method.
// The command in bin/ supplies both, and only after the user has already agreed.
import { readFileSync, unlinkSync } from "node:fs";
import { mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  chooseLimitReset,
  codexCompanyPatch,
  codexConsumeGate,
  codexConsumeOutcome,
  codexUsageBackDown,
  codexWeeklyReading,
  parseCodexRateLimits,
  screenAsksLogin,
  type LimitResetChoice,
} from "../../shared/fleet/reset-coupons";
import { t } from "../../shared/fleet/i18n";
import type { ResetCouponState } from "./reset-coupons";

export interface CreditPick {
  id: string;
  title: string;
  expiresAt: string | null;
}

export interface CouponUseIo {
  now: () => number;
  log: (line: string) => void;
  lock: () => Promise<() => Promise<void>>;
  readState: () => Promise<ResetCouponState>;
  writeState: (state: ResetCouponState) => Promise<void>;
  readCodex: () => Promise<unknown>;
  redeem: (input: { creditId: string; idempotencyKey: string }) => Promise<unknown>;
  newIdempotencyKey: () => string;
  claude: {
    open: () => Promise<void>;
    typeCommand: () => Promise<void>;
    readFrame: () => Promise<string>;
    /** Resolves only after the keystroke was sent. `ok: false` means nothing was confirmed. */
    press: (choice: Exclude<LimitResetChoice, "abort">, confirmWeekly: boolean) => Promise<{ ok: boolean; reason: string }>;
    close: () => Promise<void>;
  };
  sleep: (ms: number) => Promise<void>;
  /** How long to wait for the Claude confirmation box. Tests use a short wait. */
  claudeWaitMs?: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function unixMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value < 1e12 ? value * 1000 : value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

/**
 * One lock file. `open(..., "wx")` is the whole acquire: the file existing is enough to refuse.
 * Nothing inspects whether that pid is alive, and nothing renames or deletes a lock it did not write.
 * Release, including SIGINT and SIGTERM, unlinks the file only when the recorded pid is this process.
 */
export async function acquireCouponLock(path: string): Promise<() => Promise<void>> {
  await mkdir(dirname(path), { recursive: true });
  try {
    const fh = await open(path, "wx");
    try {
      await fh.writeFile(`${process.pid}\n${new Date().toISOString()}\n`);
    } finally {
      await fh.close();
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EEXIST") throw error;
    const text = await readFile(path, "utf8").catch(() => "");
    throw new Error(lockRefusal(path, text));
  }
  return armCouponLock(path);
}

function lockRefusal(path: string, text: string): string {
  const [pidRaw, startedRaw] = text.split("\n");
  const pid = pidRaw?.trim() || t("coupons.use.unknown");
  const started = startedRaw?.trim() || t("coupons.use.unknown");
  return t("coupons.use.lockRefusal", { path, pid, started });
}

function releaseIfOwn(path: string): void {
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return;
  }
  if (text.split("\n")[0]?.trim() !== String(process.pid)) return;
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function armCouponLock(path: string): () => Promise<void> {
  let done = false;
  const drop = () => {
    if (done) return;
    done = true;
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    releaseIfOwn(path);
  };
  const onSigint = () => stop("SIGINT");
  const onSigterm = () => stop("SIGTERM");
  const stop = (signal: "SIGINT" | "SIGTERM") => {
    try {
      drop();
    } catch (error) {
      // Still leave. A leftover file is removed by hand.
      console.error("[afc] coupon lock release failed:", String(error).slice(0, 200));
    }
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  return async () => {
    drop();
  };
}

/** Earliest available credit. The id is for the one redeem call and is not written to state or the log. */
export function earliestCredit(payload: unknown): CreditPick | null {
  const root = asRecord(payload);
  const result = asRecord(root?.result) ?? root;
  const bag = asRecord(result?.rateLimitResetCredits);
  const credits = Array.isArray(bag?.credits) ? bag.credits.map(asRecord).filter((row): row is Record<string, unknown> => row !== null) : [];
  const available = credits.filter((row) => row.status === "available" && typeof row.id === "string" && row.id.length > 0);
  if (available.length === 0) return null;
  available.sort((a, b) => (unixMs(a.expiresAt) ?? Number.MAX_SAFE_INTEGER) - (unixMs(b.expiresAt) ?? Number.MAX_SAFE_INTEGER));
  const row = available[0];
  const ms = unixMs(row.expiresAt);
  return {
    id: String(row.id),
    title: typeof row.title === "string" && row.title ? row.title : t("coupons.codex.defaultTitle"),
    expiresAt: ms === null ? null : new Date(ms).toISOString(),
  };
}

function oneLine(frame: string): string {
  return frame.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\s+/g, " ").trim().slice(0, 180);
}

function hasDialog(frame: string): boolean {
  return frame.includes("Use your reset?") && frame.includes("Refills your");
}

function looksLikeLogin(frame: string): boolean {
  return screenAsksLogin(frame);
}

function pctText(pct: number | null): string {
  return pct === null ? t("coupons.use.unknown") : t("coupons.use.pct", { pct: Math.round(pct) });
}

function logNotPressed(io: CouponUseIo): void {
  io.log(t("coupons.use.notPressed"));
  io.log(t("coupons.use.waitRefresh"));
}

async function runClaude(io: CouponUseIo, confirmWeekly: boolean): Promise<number> {
  const waitMs = io.claudeWaitMs ?? 20_000;
  io.log(confirmWeekly ? t("coupons.use.claudeConfirmWeekly") : t("coupons.use.claudeLookOnly"));
  await io.claude.open();
  try {
    io.log(t("coupons.use.typeLimitReset"));
    await io.claude.typeCommand();
    const deadline = io.now() + waitMs;
    let frame = "";
    let timedOut = false;
    for (;;) {
      frame = await io.claude.readFrame();
      io.log(t("coupons.use.frameSummary", { text: oneLine(frame) || t("coupons.use.frameEmpty") }));
      if (looksLikeLogin(frame) || hasDialog(frame)) break;
      if (io.now() >= deadline) {
        timedOut = !frame.trim();
        break;
      }
      await io.sleep(Math.min(400, Math.max(0, deadline - io.now())));
    }
    const decision = chooseLimitReset(frame, { confirmWeekly, timedOut });
    io.log(decision.reason);
    if (decision.refill) {
      io.log(t("coupons.use.refillText", { text: decision.refill }));
      const state = await io.readState();
      state.claudeRefillText = decision.refill;
      await io.writeState(state);
    }
    if (decision.choice === "abort") {
      logNotPressed(io);
      return 1;
    }
    const pressed = await io.claude.press(decision.choice, confirmWeekly);
    io.log(pressed.reason);
    if (!pressed.ok) {
      logNotPressed(io);
      return 1;
    }
    if (decision.choice === "accept") {
      const state = await io.readState();
      state.afcYesAt = { ...(state.afcYesAt ?? {}), claude: new Date(io.now()).toISOString() };
      await io.writeState(state);
    }
    io.log(t("coupons.use.waitRefresh"));
    return 0;
  } finally {
    await io.claude.close();
  }
}

async function runCodex(io: CouponUseIo): Promise<number> {
  io.log(t("coupons.use.codexReadFirst"));
  const before = await io.readCodex();
  const parsed = parseCodexRateLimits(before);
  const weekly = codexWeeklyReading(before);
  const count = parsed.status === "coupon" ? parsed.count : 0;
  io.log(t("coupons.use.readCount", { count, used: pctText(weekly.usedPct) }));
  const gate = codexConsumeGate({ count, usedPct: weekly.usedPct });
  if (!gate.ok) {
    io.log(gate.reason);
    return 1;
  }
  const credit = earliestCredit(before);
  if (!credit) {
    io.log(t("coupons.use.noCredit"));
    return 1;
  }
  io.log(t("coupons.use.pickEarliest", { title: credit.title }));
  const result = await io.redeem({ creditId: credit.id, idempotencyKey: io.newIdempotencyKey() });
  const outcome = codexConsumeOutcome(result);
  io.log(t("coupons.use.outcome", { outcome: outcome ?? t("coupons.use.noOutcome") }));
  const after = await io.readCodex();
  const parsedAfter = parseCodexRateLimits(after);
  const weeklyAfter = codexWeeklyReading(after);
  const afterCount = parsedAfter.status === "coupon" ? parsedAfter.count : parsedAfter.status === "none" ? 0 : null;
  io.log(t("coupons.use.readAfter", { count: afterCount === null ? t("coupons.use.unknown") : String(afterCount), used: pctText(weeklyAfter.usedPct) }));
  const countOk = afterCount !== null && afterCount === count - 1;
  const usageOk = weekly.usedPct !== null && codexUsageBackDown(weekly.usedPct, weeklyAfter.usedPct);
  if (countOk && usageOk) io.log(t("coupons.use.confirmed"));
  else io.log(t("coupons.use.notConfirmed"));
  const patch = codexCompanyPatch(after);
  if (patch || outcome === "reset" || countOk) {
    const state = await io.readState();
    if (patch) {
      state.companies = {
        ...state.companies,
        chatgpt: {
          count: patch.count,
          kind: patch.kind,
          expiresAt: patch.expiresAt,
          excerpt: patch.excerpt,
          confirmedAt: new Date(io.now()).toISOString(),
          via: "cli",
          status: "ok",
          items: patch.items,
        },
      };
    }
    if (outcome === "reset" || countOk) state.afcYesAt = { ...(state.afcYesAt ?? {}), codex: new Date(io.now()).toISOString() };
    await io.writeState(state);
  }
  return countOk && usageOk ? 0 : 1;
}

export async function runCouponUse(argv: string[], io: CouponUseIo): Promise<number> {
  const company = argv.find((arg) => arg === "claude" || arg === "codex");
  if (!company) {
    io.log(t("coupons.use.usage"));
    return 2;
  }
  let release: (() => Promise<void>) | null = null;
  try {
    release = await io.lock();
  } catch (error) {
    io.log(error instanceof Error ? error.message : String(error));
    return 1;
  }
  try {
    if (company === "claude") return await runClaude(io, argv.includes("--confirm-weekly"));
    return await runCodex(io);
  } finally {
    await release();
  }
}
