// Shared by bin/test.mjs and coverage-phases.mjs: every whole-suite run gets its
// own home, host, state and TMPDIR under the invoking temporary directory, so tests
// that forget to clean up stay inside the invoking TMPDIR. The directory is
// removed when the run ends, including on errors and SIGINT/SIGTERM/SIGHUP.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateTestEnvironment } from "./test-environment.mjs";
import { assertTestEnvironment } from "../../server/storage/test-safety.ts";
import { defaultCardDirectories, newCardDirectories } from "./card-root-audit.mjs";

const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];
const SIGNAL_EXIT_BASE = 128;
const SIGNAL_NUMBERS = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 };
const I18N_PRELOAD = import.meta.resolve("./i18n-preload.ts");
// A copied runner (test/test-runner.test.ts fixtures) may not carry the preload; it then runs without it.
const PRELOAD_ARGS = existsSync(fileURLToPath(I18N_PRELOAD)) ? ["--import", I18N_PRELOAD] : [];
const CARD_PRELOAD = import.meta.resolve("./card-work-preload.ts");
const CARD_PRELOAD_ARGS = existsSync(fileURLToPath(CARD_PRELOAD)) ? ["--import", CARD_PRELOAD] : [];

export function createTestTmp() {
  return realpathSync(mkdtempSync(join(tmpdir(), `kanban-test-${process.pid}-`)));
}

export function removeTestTmp(dir) {
  rmSync(dir, { recursive: true, force: true });
}

/**
 * Runs `phases` ([label, ...nodeArgs]) one after another with a private TMPDIR.
 * Returns the exit code; the caller passes it to process.exit.
 */
// Keep real Git/filesystem fixtures from exhausting their operation budgets merely because
// unrelated test files start on every available CPU. This changes file scheduling only.
// Coverage supplies its own explicit concurrency argument and retains that override.
function workerArgs(extraTestArgs) {
  if (extraTestArgs.some(arg => arg === "--test-concurrency" || arg.startsWith("--test-concurrency="))) return extraTestArgs;
  const value = process.env.KANBAN_TEST_CONCURRENCY ?? "4";
  const limit = Number(value);
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(limit) || limit > 64) {
    throw new Error("KANBAN_TEST_CONCURRENCY must be an integer from 1 to 64");
  }
  return [`--test-concurrency=${limit}`, ...extraTestArgs];
}

export async function runPhasesInPrivateTmp(phases, { cwd, logPrefix, extraTestArgs = [] }) {
  assertTestEnvironment(process.env);
  const testArgs = workerArgs(extraTestArgs);
  const before = defaultCardDirectories(cwd);
  const testTmp = createTestTmp();
  let child = null;
  let interruptedBy = null;
  const onSignal = signal => { interruptedBy = signal; child?.kill(signal); };
  for (const signal of FORWARDED_SIGNALS) process.on(signal, onSignal);
  try {
    const env = { ...privateTestEnvironment(testTmp), KANBAN_LANGUAGE: "zh-CN" };
    for (const [name, ...args] of phases) {
      if (interruptedBy) break;
      console.log(`\n[${logPrefix}] ${name}`);
      const outcome = await new Promise(resolve => {
        child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), ...CARD_PRELOAD_ARGS, ...PRELOAD_ARGS, "--test", ...testArgs, ...args], { stdio: "inherit", cwd, env });
        child.on("error", error => resolve({ error }));
        child.on("close", (status, signal) => resolve({ status, signal }));
      });
      if (outcome.error) { console.error(outcome.error.message); return 1; }
      const added = newCardDirectories(before, defaultCardDirectories(cwd));
      if (added.length) {
        console.error(`[${logPrefix}] card-root isolation failed: ${added.length} real default directories added`);
        return 1;
      }
      if (interruptedBy) break;
      if (outcome.signal || outcome.status !== 0) return outcome.status ?? 1;
    }
    return interruptedBy ? SIGNAL_EXIT_BASE + SIGNAL_NUMBERS[interruptedBy] : 0;
  } finally {
    for (const signal of FORWARDED_SIGNALS) process.off(signal, onSignal);
    removeTestTmp(testTmp);
    if (newCardDirectories(before, defaultCardDirectories(cwd)).length) throw new Error("test run added card directories outside its private root");
  }
}
