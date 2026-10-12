// Manual coupon use. A person runs this after the user has agreed. Nothing in the plugin calls it.
// The command is bin/afc-use-coupon, which starts this file.
// It is not a schedule. Fake mode (AFC_COUPON_FAKE=1) never starts claude and never sends consume.
/**
 * Codex consume parameters, from the Codex CLI 0.159.2 darwin-arm64 binary
 * (the aarch64-apple-darwin vendor binary, not a live consume call):
 * - method string `account/rateLimitResetCredit/consume`
 * - `struct ConsumeAccountRateLimitResetCreditParams with 2 elements`
 * - validation text `creditId must not be empty` and `idempotencyKey must not be empty`
 * - response `struct ConsumeAccountRateLimitResetCreditResponse`, outcome variants
 *   concatenated in the binary as reset / nothingToReset / noCredit / alreadyRedeemed
 * creditId is credits[].id from account/rateLimits/read. The earliest available credit is used.
 * The id is not printed and not written into reset-coupons.json.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, realpathSync } from "node:fs";
import { mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { agentLaunchEnv, stripAnsi } from "./cursor-usage";
import { acquireCouponLock, runCouponUse, type CouponUseIo } from "./coupon-use";
import type { ResetCouponState } from "./reset-coupons";
import { chooseLimitReset, couponCliArgv, codexRateLimitsRequest, codexStderrLooksLoggedOut, screenAsksLogin } from "../../shared/fleet/reset-coupons";
import { t } from "../../shared/fleet/i18n";
import { initLanguage } from "./language";
import { findCommand } from "./commands";
import { commandPath } from "./platform";
import { readJson, STATE_DIR, writeJson } from "./util";

const CONFIRM_PHRASE = {
  accept: "Yes, use my reset",
  decline: "No, keep it",
} as const;

const CONSUME_METHOD = "account/rateLimitResetCredit/consume";
const SCREEN = "/usr/bin/screen";
const SESSION = "afc-coupon-claude";
const MARKER = /[❯›>●→]/;

/** A file in the cockpit's data directory (server/paths.ts decides which one). */
function underHome(name: string): string {
  return join(STATE_DIR, name);
}

function statePath(): string {
  if (process.env.AFC_COUPON_STATE) return process.env.AFC_COUPON_STATE;
  if (process.env.AFC_COUPON_FAKE === "1") return join(tmpdir(), "afc-use-coupon-fake-state.json");
  return underHome("reset-coupons.json");
}

function lockPath(): string {
  if (process.env.AFC_COUPON_LOCK) return process.env.AFC_COUPON_LOCK;
  if (process.env.AFC_COUPON_FAKE === "1") return join(tmpdir(), "afc-use-coupon-fake.lock");
  return underHome("coupon-use.lock");
}

function logPath(): string {
  if (process.env.AFC_COUPON_LOG) return process.env.AFC_COUPON_LOG;
  if (process.env.AFC_COUPON_FAKE === "1") return join(tmpdir(), "afc-use-coupon-fake.log");
  return underHome("coupon-use.log");
}

function say(line: string): void {
  const row = `${new Date().toISOString()} ${line}`;
  console.log(line);
  try {
    mkdirSync(dirname(logPath()), { recursive: true });
    appendFileSync(logPath(), `${row}\n`);
  } catch {
    // The screen summary is already on stdout. A log-file miss does not change the choice.
  }
}

function emptyState(): ResetCouponState {
  return {
    attemptedAt: null,
    companies: {},
    claudeUsedAt: null,
    lastWeeklyUsedPct: null,
    lastWeeklyResetsAt: null,
    lastClaudeCount: null,
    lastUseNotifyAt: null,
    announcedWeekStart: null,
    claudeBurnBaselinePct: null,
  };
}

function commandOutput(cmd: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], env: agentLaunchEnv() });
    let out = "";
    const take = (chunk: Buffer | string) => {
      if (out.length < 4_000) out += String(chunk).slice(0, 4_000 - out.length);
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(out);
    }, timeoutMs);
    child.on("error", () => {
      clearTimeout(timer);
      resolve(out);
    });
    child.on("exit", () => {
      clearTimeout(timer);
      resolve(out);
    });
  });
}

function runScreen(args: string[], timeoutMs: number, cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(SCREEN, args, { stdio: "ignore", cwd, env: agentLaunchEnv() });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(t("coupons.bin.screenTimeout")));
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(t("coupons.bin.screenExit")));
    });
  });
}

function requirePgrep(path = commandPath()): string {
  const pgrep = findCommand("pgrep", path);
  if (!pgrep) throw new Error(t("coupons.bin.commandMissing", { command: "pgrep" }));
  return pgrep;
}

export async function sessionTree(path = commandPath(), output = commandOutput): Promise<number[]> {
  const pgrep = requirePgrep(path);
  const listed = await output(SCREEN, ["-ls"], 5_000);
  const leader = listed.match(new RegExp(`(\\d+)\\.${SESSION}(?:\\s|$)`));
  if (!leader) return [];
  const root = Number(leader[1]);
  const seen = new Set<number>([root]);
  let frontier = [root];
  for (let depth = 0; depth < 5 && frontier.length > 0; depth += 1) {
    const next: number[] = [];
    for (const pid of frontier) {
      const kids = (await output(pgrep, ["-P", String(pid)], 5_000))
        .split("\n")
        .map((line) => Number(line.trim()))
        .filter((n) => n > 1 && !seen.has(n));
      for (const kid of kids) {
        seen.add(kid);
        next.push(kid);
      }
    }
    frontier = next;
  }
  return [...seen];
}

async function finishTree(pids: number[]): Promise<void> {
  const self = process.pid;
  const mine = [...new Set(pids)].filter((pid) => pid > 1 && pid !== self);
  for (const pid of mine) {
    try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
  }
  await new Promise((resolve) => setTimeout(resolve, 400));
  for (const pid of mine) {
    try {
      process.kill(pid, 0);
      process.kill(pid, "SIGKILL");
    } catch { /* already gone */ }
  }
}

export function resolveClaude(path = commandPath()): string | null {
  return findCommand("claude", path);
}

interface RpcResult {
  result?: unknown;
  error?: unknown;
}

function codexCall(method: string, params: Record<string, unknown>): Promise<unknown> {
  const argv = couponCliArgv("chatgpt", true);
  const bin = argv[0];
  const args = argv.slice(1);
  if (bin !== "codex" || args.join(" ") !== "app-server --listen stdio://") return Promise.reject(new Error(t("coupons.codexRead.refused")));
  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(bin, args, { env: agentLaunchEnv(), stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    let settled = false;
    let buffer = "";
    let stderrTail = "";
    const waiters = new Map<number, (message: RpcResult) => void>();
    const timer = setTimeout(() => finish(new Error(t("coupons.bin.codexTimeout"))), 20_000);
    function finish(error: Error | null, value?: unknown): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.stdin.destroy(); } catch { /* already closed */ }
      try { child.kill("SIGKILL"); } catch { /* already exited */ }
      if (error) reject(error);
      else resolve(value);
    }
    const send = (message: unknown) => {
      if (!child.stdin.writable) return;
      try { child.stdin.write(`${JSON.stringify(message)}\n`); } catch { /* pipe closed */ }
    };
    child.stdin.on("error", () => {});
    child.stdout.on("error", () => {});
    child.stderr.on("error", () => {});
    child.stdout.on("data", (chunk: Buffer | string) => {
      buffer += String(chunk);
      if (buffer.length > 512 * 1024) {
        buffer = "";
        finish(new Error(t("coupons.bin.codexTooLong")));
        return;
      }
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (!line) continue;
        try {
          const message = JSON.parse(line) as RpcResult & { id?: unknown };
          if (typeof message.id === "number") waiters.get(message.id)?.(message);
        } catch { /* not a json line */ }
      }
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderrTail = (stderrTail + String(chunk)).slice(-500);
      if (codexStderrLooksLoggedOut(stderrTail)) finish(new Error(t("coupons.codexRead.loggedOut")));
    });
    child.on("error", (error) => finish(error));
    child.on("exit", () => {
      setImmediate(() => {
        if (!settled) finish(new Error(t("coupons.bin.codexInterrupted")));
      });
    });
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "afc-use-coupon", version: "0" }, capabilities: {} } });
    waiters.set(1, (message) => {
      if (message.error) {
        finish(new Error(t("coupons.codexRead.initFailed")));
        return;
      }
      send({ jsonrpc: "2.0", method: "initialized", params: {} });
      const request = method === "account/rateLimits/read"
        ? codexRateLimitsRequest(2)
        : { jsonrpc: "2.0", id: 2, method, params };
      send(request);
    });
    waiters.set(2, (message) => {
      if (message.error) finish(new Error(t("coupons.bin.codexRequestFailed")));
      else finish(null, message.result);
    });
  });
}

export interface FrameShot {
  ok: boolean;
  frame: string;
}

export interface LimitResetScreen {
  capture: () => Promise<FrameShot>;
  stuff: (keys: string) => Promise<boolean>;
}

function markerOn(frame: string, phrase: string): boolean {
  const line = stripAnsi(frame).split("\n").find((row) => row.includes(phrase));
  return line !== undefined && MARKER.test(line);
}

function frameAllows(choice: "accept" | "decline", frame: string, confirmWeekly: boolean): { ok: true } | { ok: false; reason: string } {
  const decision = chooseLimitReset(frame, { confirmWeekly, timedOut: false });
  if (choice === "accept" && decision.choice !== "accept") return { ok: false, reason: t("coupons.bin.notWeeklyAnymore") };
  if (decision.choice === "abort") return { ok: false, reason: decision.reason };
  const text = stripAnsi(frame);
  if (!text.includes("Use your reset?") || !text.includes("Refills your")) return { ok: false, reason: t("coupons.bin.unreadable") };
  return { ok: true };
}

/**
 * Press only after a fresh capture from this call.
 * A failed capture is not replaced with an older screenshot. Accept is checked again on that capture.
 */
export async function pressLimitReset(
  choice: "accept" | "decline",
  screen: LimitResetScreen,
  confirmWeekly: boolean,
): Promise<{ ok: boolean; reason: string }> {
  const shot = await screen.capture();
  if (!shot.ok) return { ok: false, reason: t("coupons.bin.captureFailed") };
  const allowed = frameAllows(choice, shot.frame, confirmWeekly);
  if (!allowed.ok) return allowed;
  const aimed = await aimCursor(choice, screen, shot.frame, confirmWeekly);
  if (!aimed.ok) return aimed;
  const sent = await screen.stuff("\r");
  if (!sent) return { ok: false, reason: t("coupons.bin.keyFailed") };
  return { ok: true, reason: t("coupons.bin.chose", { phrase: CONFIRM_PHRASE[choice] }) };
}

async function aimCursor(
  choice: "accept" | "decline",
  screen: LimitResetScreen,
  frame: string,
  confirmWeekly: boolean,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const want = CONFIRM_PHRASE[choice];
  const other = CONFIRM_PHRASE[choice === "accept" ? "decline" : "accept"];
  if (markerOn(frame, want) && !markerOn(frame, other)) return { ok: true };
  if (!(markerOn(frame, other) && !markerOn(frame, want))) return { ok: false, reason: t("coupons.bin.cursorUnclear") };
  const moved = await screen.stuff(choice === "accept" ? "\x1b[A" : "\x1b[B");
  if (!moved) return { ok: false, reason: t("coupons.bin.keyFailed") };
  const again = await screen.capture();
  if (!again.ok) return { ok: false, reason: t("coupons.bin.recaptureFailed") };
  const allowed = frameAllows(choice, again.frame, confirmWeekly);
  if (!allowed.ok) return allowed;
  if (markerOn(again.frame, want) && !markerOn(again.frame, other)) return { ok: true };
  return { ok: false, reason: t("coupons.bin.cursorUnclear") };
}

function realIo(): CouponUseIo {
  const dir = join(tmpdir(), "afc-use-coupon");
  const rc = join(dir, "screenrc");
  let opened = false;
  let shotSeq = 0;
  const capture = async (): Promise<FrameShot> => {
    if (!opened) return { ok: false, frame: "" };
    const file = join(dir, `shot-${shotSeq += 1}.txt`);
    try {
      await runScreen(["-S", SESSION, "-p", "0", "-X", "hardcopy", file], 5_000);
    } catch {
      await unlink(file).catch(() => {});
      return { ok: false, frame: "" };
    }
    try {
      return { ok: true, frame: await readFile(file, "utf8") };
    } catch {
      return { ok: false, frame: "" };
    }
  };
  const readFrame = async (): Promise<string> => {
    const shot = await capture();
    return shot.ok ? shot.frame : "";
  };
  const screen: LimitResetScreen = {
    capture,
    stuff: async (keys) => {
      try {
        await runScreen(["-S", SESSION, "-p", "0", "-X", "stuff", keys], 5_000);
        return true;
      } catch {
        return false;
      }
    },
  };
  return {
    now: () => Date.now(),
    log: (line) => say(line),
    lock: () => acquireCouponLock(lockPath()),
    readState: async () => (await readJson<ResetCouponState | null>(statePath(), null)) ?? emptyState(),
    writeState: (state) => writeJson(statePath(), state),
    readCodex: () => codexCall("account/rateLimits/read", {}),
    redeem: async (input) => {
      say(t("coupons.bin.redeemSent"));
      return codexCall(CONSUME_METHOD, { creditId: input.creditId, idempotencyKey: input.idempotencyKey });
    },
    newIdempotencyKey: () => randomUUID(),
    claudeWaitMs: 20_000,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    claude: {
      open: async () => {
        const bin = await resolveClaude();
        if (!bin) throw new Error(t("coupons.bin.claudeMissing"));
        requirePgrep();
        await rm(dir, { recursive: true, force: true }).catch(() => {});
        await mkdir(dir, { recursive: true });
        shotSeq = 0;
        await writeFile(rc, ["startup_message off", "height 50", "width 160", ""].join("\n"), "utf8");
        await runScreen(["-S", SESSION, "-X", "quit"], 5_000).catch(() => {});
        await runScreen(["-c", rc, "-dmS", SESSION, bin], 15_000, tmpdir());
        opened = true;
        say(t("coupons.bin.claudeOpened"));
      },
      typeCommand: async () => {
        const frame = await readFrame();
        if (screenAsksLogin(stripAnsi(frame))) return;
        await runScreen(["-S", SESSION, "-p", "0", "-X", "stuff", "/limit-reset\r"], 5_000);
      },
      readFrame,
      press: (choice, confirmWeekly) => pressLimitReset(choice, screen, confirmWeekly),
      close: async () => {
        let tree: number[];
        try { tree = await sessionTree(); }
        finally {
          await runScreen(["-S", SESSION, "-X", "quit"], 5_000).catch(() => {});
          opened = false;
        }
        await finishTree(tree);
      },
    },
  };
}

async function fakeIo(): Promise<CouponUseIo> {
  const file = process.env.AFC_COUPON_FAKE_FILE;
  if (!file) throw new Error(t("coupons.bin.fakeFileMissing"));
  const fixture = JSON.parse(await readFile(file, "utf8")) as {
    frames?: string[];
    waitMs?: number;
    now?: number;
    reads?: unknown[];
    redeem?: unknown;
    captureOk?: boolean;
    stuffOk?: boolean;
  };
  const frames = fixture.frames ?? [];
  let frameAt = 0;
  let clock = fixture.now ?? 1_700_000_000_000;
  const reads = [...(fixture.reads ?? [])];
  return {
    now: () => clock,
    log: (line) => say(line),
    lock: () => acquireCouponLock(lockPath()),
    readState: async () => (await readJson<ResetCouponState | null>(statePath(), null)) ?? emptyState(),
    writeState: (state) => writeJson(statePath(), state),
    readCodex: async () => {
      if (reads.length === 0) throw new Error(t("coupons.bin.noNextRead"));
      return reads.shift();
    },
    redeem: async (input) => {
      if (!input.creditId || !input.idempotencyKey) throw new Error(t("coupons.bin.redeemArgsEmpty"));
      say(t("coupons.bin.redeemSent"));
      return fixture.redeem ?? { outcome: "reset" };
    },
    newIdempotencyKey: () => randomUUID(),
    claudeWaitMs: fixture.waitMs ?? 0,
    sleep: async (ms) => { clock += ms; },
    claude: {
      open: async () => { say(t("coupons.bin.claudeOpened")); },
      typeCommand: async () => { say(t("coupons.bin.typed")); },
      readFrame: async () => frames[Math.min(frameAt++, Math.max(frames.length - 1, 0))] ?? "",
      press: (choice, confirmWeekly) => pressLimitReset(choice, {
        capture: async () => (fixture.captureOk === false ? { ok: false, frame: "" } : { ok: true, frame: frames[frames.length - 1] ?? "" }),
        stuff: async () => fixture.stuffOk !== false,
      }, confirmWeekly),
      close: async () => { say(t("coupons.bin.claudeClosed")); },
    },
  };
}

export function mainCoupon(): void {
  initLanguage();
  if (process.argv.slice(2).some(arg => arg === "--help" || arg === "-h")) {
    console.log("usage: afc coupon claude [--confirm-weekly] | codex");
    return;
  }
  const ioPromise = process.env.AFC_COUPON_FAKE === "1" ? fakeIo() : Promise.resolve(realIo());
  ioPromise
    .then((io) => runCouponUse(process.argv.slice(2), io))
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(message);
      process.exit(1);
    });
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) mainCoupon();
