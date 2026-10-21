/// <reference types="node" />
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { agentLaunchEnv, createScreenSession, finishScreenSession, SCREEN_BIN, screenSessionPids, sleep } from "../screen-read";

const fixtureCli = fileURLToPath(new URL("./fixtures/screen-cli.mjs", import.meta.url));
const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
let sequence = 0;
const terminalCleanup = new Map<TestContext, { stops: Array<() => Promise<void>>; dirs: string[] }>();

async function dispose(t: TestContext): Promise<void> {
  const owned = terminalCleanup.get(t);
  if (!owned) return;
  const failures: unknown[] = [];
  // A failed stop must not skip the other owned sessions or destroy their evidence.
  for (const stop of [...owned.stops].reverse()) {
    try { await stop(); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, "Fixture teardown failed");
  for (const path of owned.dirs) rmSync(path, { recursive: true, force: true });
  terminalCleanup.delete(t);
}

async function disposeAll(): Promise<void> {
  const results = await Promise.allSettled([...terminalCleanup.keys()].map(dispose));
  const failed = results.filter((result) => result.status === "rejected");
  if (failed.length) throw new AggregateError(failed.map((result) => result.reason), "Fixture fallback teardown failed");
}

afterEach(disposeAll, { timeout: 90_000 });
after(disposeAll, { timeout: 90_000 });

export function temporary(t: TestContext, remove = true): string {
  // A full-suite TMPDIR can be too long for a Unix screen socket. Stay inside the
  // card's temp root when one is supplied, including for direct isolated runs.
  const dir = mkdtempSync(join(process.env.KANBAN_TMP ?? tmpdir(), "sr-"));
  if (remove) t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export function pidFile(path: string): number[] {
  try { return [...new Set(readFileSync(path, "utf8").trim().split("\n").map(Number).filter((pid) => pid > 1))]; }
  catch { return []; }
}

export function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
}

export async function until(check: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!check() && Date.now() < deadline) await sleep(25);
  assert.ok(check(), message);
}


export function terminal(t: TestContext, mode = "success", socketDir?: string, name?: string, overrides: NodeJS.ProcessEnv = {}) {
  const dir = temporary(t, false);
  const sockets = socketDir ?? join(dir, "s");
  mkdirSync(sockets, { recursive: true, mode: 0o700 });
  const pidsPath = overrides.DEMO_PID_FILE ?? join(dir, "pids");
  const termsPath = overrides.DEMO_TERM_FILE ?? join(dir, "terms");
  const sessionName = name ?? `q${process.pid}.${sequence++}`;
  const env: NodeJS.ProcessEnv = {
    ...agentLaunchEnv(), SCREENDIR: sockets, SYSSCREENRC: "/dev/null", SCREENRC: "/dev/null",
    DEMO_PID_FILE: pidsPath, DEMO_TERM_FILE: termsPath, DEMO_DEPTH: "7", DEMO_MODE: mode,
    DEMO_OWNER_PID: String(process.pid), ...overrides,
  };
  const launch = join(dir, "cli");
  writeFileSync(launch, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fixtureCli)}\n`, { mode: 0o700 });
  const options = { session: sessionName, dir: join(dir, "frames"), cwd: dir, launch, bin: SCREEN_BIN, env };
  const session = createScreenSession(options);
  let startedTree: number[] = [];
  let stopping = false;
  const pending = new Set<Promise<void>>();
  const pids = () => pidFile(pidsPath);
  const count = () => pids().filter(alive).length;
  const listing = () => {
    const result = spawnSync(SCREEN_BIN, ["-ls"], { env, encoding: "utf8", timeout: 5_000, killSignal: "SIGKILL" });
    if (result.error) throw result.error;
    return result.stdout;
  };
  const start = async () => {
    assert.ok(!stopping && !t.signal.aborted, "a finished test cannot start another terminal");
    assert.equal(count(), 0, "fixture starts without a leftover process");
    writeFileSync(pidsPath, "");
    writeFileSync(termsPath, "");
    await session.open();
    await until(() => pids().length === 8, "the eight-process fixture tree starts");
    startedTree = await screenSessionPids(sessionName, SCREEN_BIN, env);
    assert.ok(startedTree.length >= 9, "the screen server and complete CLI tree are tracked");
  };
  const open = () => {
    const operation = start();
    pending.add(operation);
    void operation.finally(() => pending.delete(operation)).catch(() => {});
    return operation;
  };
  const clean = async () => {
    await until(() => count() === 0, "the complete fake CLI tree exits");
    await until(() => startedTree.every((pid) => !alive(pid)), "the screen server and every captured descendant exit");
    assert.equal(await screenSessionPids(sessionName, SCREEN_BIN, env).then((all) => all.length), 0);
    assert.ok(!listing().split("\n").some((line) => line.trim().split(/\s+/)[0]?.endsWith(`.${sessionName}`)), "no live or Dead socket remains");
  };
  let cleanup = terminalCleanup.get(t);
  if (!cleanup) {
    cleanup = { stops: [], dirs: [] };
    terminalCleanup.set(t, cleanup);
    t.after(() => dispose(t), { timeout: 90_000 });
  }
  cleanup.stops.push(async () => {
    stopping = true;
    // Test cancellation does not cancel the asynchronous body or detached launcher.
    await Promise.allSettled([...pending]);
    try { await session.close(); }
    catch (error) { t.diagnostic(`Primary teardown failed; using owned fixture records: ${String(error)}`); }
    await finishScreenSession(pids());
    const refs = () => listing().split("\n").flatMap((line) => {
      const match = /^\s*(\d+)\.([^\s]+)\s+\(([^)]+)\)/.exec(line);
      return match?.[2] === sessionName ? [{ id: `${match[1]}.${match[2]}`, pid: Number(match[1]), dead: /dead/i.test(match[3]) }] : [];
    });
    // The fallback owns only this fixture's PID records and exact name/socket directory.
    for (const ref of refs()) {
      if (!ref.dead) await finishScreenSession([ref.pid]);
      const wiped = spawnSync(SCREEN_BIN, ["-wipe", ref.id], { env, encoding: "utf8", timeout: 5_000, killSignal: "SIGKILL" });
      if (wiped.error) throw wiped.error;
    }
    assert.equal(count(), 0, "teardown removes every recorded fixture process");
    assert.deepEqual(refs(), [], "teardown removes the exact live or Dead socket");
  });
  cleanup.dirs.push(dir);
  return { dir, env, sockets, sessionName, options, session, pids, count, listing, open, clean, termsPath };
}

