/// <reference types="node" />
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { agentLaunchEnv, createScreenSession, finishScreenSession, SCREEN_BIN, screenSessionPids, sleep } from "../screen-read";

const native = (process.platform === "darwin" || process.platform === "linux") && existsSync(SCREEN_BIN);
const fixtureCli = fileURLToPath(new URL("./fixtures/screen-cli.mjs", import.meta.url));
const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
let sequence = 0;
const terminalCleanup = new WeakMap<TestContext, { stops: Array<() => Promise<void>>; dirs: string[] }>();

function temporary(t: TestContext, remove = true): string {
  // A full-suite TMPDIR can be too long for a Unix screen socket. Stay inside the
  // card's temp root when one is supplied, including for direct isolated runs.
  const dir = mkdtempSync(join(process.env.KANBAN_TMP ?? tmpdir(), "sr-"));
  if (remove) t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function pidFile(path: string): number[] {
  try { return [...new Set(readFileSync(path, "utf8").trim().split("\n").map(Number).filter((pid) => pid > 1))]; }
  catch { return []; }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
}

async function until(check: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!check() && Date.now() < deadline) await sleep(25);
  assert.ok(check(), message);
}

function fakeScreen(t: TestContext, body: string): string {
  const file = join(temporary(t), "screen.cjs");
  writeFileSync(file, `#!${process.execPath}\n${body}\n`, { mode: 0o700 });
  return file;
}

test("screen teardown protects unrelated PIDs and escalates only TERM survivors", async () => {
  const live = new Set([50, 60]);
  const calls: Array<[number, NodeJS.Signals | 0]> = [];
  const waits: number[] = [];
  const logs: string[] = [];
  await finishScreenSession([0, 1, 42, 50, 60, 50, NaN, -50, 1.5], {
    self: 42, sleep: async (ms) => { waits.push(ms); }, log: (line) => logs.push(line),
    kill: (pid, signal) => {
      calls.push([pid, signal]);
      if (!live.has(pid)) throw Object.assign(new Error("gone"), { code: "ESRCH" });
      if (signal === "SIGKILL" || signal === "SIGTERM" && pid === 60) live.delete(pid);
    },
  });
  assert.deepEqual(calls.filter(([, signal]) => signal !== 0), [[60, "SIGTERM"], [50, "SIGTERM"], [50, "SIGKILL"]]);
  assert.deepEqual(waits, [400]);
  assert.match(logs.join("\n"), /Escalating 1 process target/);
  assert.equal(live.size, 0);
});

test("permission errors and the final SIGKILL wait have a bounded, English failure", async () => {
  let waited = 0;
  const logs: string[] = [];
  await assert.rejects(finishScreenSession([50], {
    self: 42, sleep: async (ms) => { waited += ms; }, log: (line) => logs.push(line),
    kill: (_pid, signal) => { if (signal) throw Object.assign(new Error("denied"), { code: "EPERM" }); },
  }), /SIGKILL deadline/);
  assert.equal(waited, 1_400);
  assert.match(logs.join("\n"), /Could not send SIGTERM.*EPERM/);
  assert.match(logs.join("\n"), /Could not send SIGKILL.*EPERM/);
});

test("session matching is literal and does not select a prefix or regex neighbor", async (t) => {
  const bin = fakeScreen(t, `console.log("  ${process.pid}.demoXquota (Detached)\\n  ${process.pid}.other-demo.quota (Detached)"); process.exit(1);`);
  assert.deepEqual(await screenSessionPids("demo.quota", bin), []);
});

test("a dead socket is wiped by full ID without signaling its recycled PID", async (t) => {
  const dir = temporary(t);
  const state = join(dir, "wiped");
  const args = join(dir, "args");
  const name = `${process.pid}.demo.quota`;
  const bin = fakeScreen(t, `
    const fs = require("node:fs");
    const args = process.argv.slice(2);
    if (args[0] === "-wipe") { fs.writeFileSync(${JSON.stringify(args)}, JSON.stringify(args)); fs.writeFileSync(${JSON.stringify(state)}, "yes"); console.log("No Sockets found"); }
    else if (!fs.existsSync(${JSON.stringify(state)})) console.log(${JSON.stringify(`  ${name} (Dead ???)`)});
    else console.log("No Sockets found");
    process.exit(1);
  `);
  const session = createScreenSession({ session: "demo.quota", dir, cwd: dir, launch: "unused", bin });
  await session.close();
  assert.deepEqual(JSON.parse(readFileSync(args, "utf8")), ["-wipe", name]);
});

test("a failed process lookup is not treated as an empty session", async (t) => {
  const bin = fakeScreen(t, "process.exit(2);");
  await assert.rejects(screenSessionPids("demo", bin), /failed \(2\)/);
});

test("all accumulated Dead sockets of the exact name are wiped independently", async (t) => {
  const dir = temporary(t);
  const state = join(dir, "wiped");
  const names = [`${process.pid}.demo.quota`, `${process.pid + 1}.demo.quota`];
  const bin = fakeScreen(t, `
    const fs = require("node:fs");
    const names = ${JSON.stringify(names)};
    const wiped = fs.existsSync(${JSON.stringify(state)}) ? JSON.parse(fs.readFileSync(${JSON.stringify(state)}, "utf8")) : [];
    if (process.argv[2] === "-wipe") { wiped.push(process.argv[3]); fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify(wiped)); }
    const remaining = names.filter(name => !wiped.includes(name));
    console.log(remaining.length ? remaining.map(name => "  " + name + " (Dead ???)").join("\\n") : "No Sockets found");
    process.exit(1);
  `);
  await createScreenSession({ session: "demo.quota", dir, cwd: dir, launch: "unused", bin }).close();
  assert.deepEqual(JSON.parse(readFileSync(state, "utf8")), names);
});

test("a stuck screen lookup is killed at the command deadline", { timeout: 9_000 }, async (t) => {
  const bin = fakeScreen(t, "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);");
  await assert.rejects(screenSessionPids("demo", bin), /timeout/);
});

function terminal(t: TestContext, mode = "success", socketDir?: string, name?: string) {
  const dir = temporary(t, false);
  const sockets = socketDir ?? join(dir, "s");
  mkdirSync(sockets, { recursive: true, mode: 0o700 });
  const pidsPath = join(dir, "pids");
  const termsPath = join(dir, "terms");
  const sessionName = name ?? `q${process.pid}.${sequence++}`;
  const env: NodeJS.ProcessEnv = {
    ...agentLaunchEnv(), SCREENDIR: sockets, SYSSCREENRC: "/dev/null", SCREENRC: "/dev/null",
    DEMO_PID_FILE: pidsPath, DEMO_TERM_FILE: termsPath, DEMO_DEPTH: "7", DEMO_MODE: mode,
  };
  const launch = join(dir, "cli");
  writeFileSync(launch, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fixtureCli)}\n`, { mode: 0o700 });
  const options = { session: sessionName, dir: join(dir, "frames"), cwd: dir, launch, bin: SCREEN_BIN, env };
  const session = createScreenSession(options);
  let startedTree: number[] = [];
  const pids = () => pidFile(pidsPath);
  const count = () => pids().filter(alive).length;
  const listing = () => {
    const result = spawnSync(SCREEN_BIN, ["-ls"], { env, encoding: "utf8", timeout: 5_000, killSignal: "SIGKILL" });
    if (result.error) throw result.error;
    return result.stdout;
  };
  const open = async () => {
    assert.equal(count(), 0, "fixture starts without a leftover process");
    writeFileSync(pidsPath, "");
    writeFileSync(termsPath, "");
    await session.open();
    await until(() => pids().length === 8, "the eight-process fixture tree starts");
    startedTree = await screenSessionPids(sessionName, SCREEN_BIN, env);
    assert.ok(startedTree.length >= 9, "the screen server and complete CLI tree are tracked");
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
    const all = cleanup;
    t.after(async () => {
      // All sessions sharing this socket directory must stop before any parent is removed.
      for (const stop of all.stops.reverse()) await stop();
      for (const path of all.dirs) rmSync(path, { recursive: true, force: true });
    });
  }
  cleanup.stops.push(async () => {
    await session.close().catch(() => {});
    await finishScreenSession(pids()).catch(() => {});
  });
  cleanup.dirs.push(dir);
  return { dir, env, sockets, sessionName, options, session, pids, count, listing, open, clean, termsPath };
}

const fastSleep = (ms: number) => sleep(Math.min(ms, 25));

test("isolated Grok quota reads twice return every process and socket count to zero", { skip: !native, timeout: 35_000 }, async (t) => {
  const { readGrokScreenVia } = await import("../grok-usage");
  const f = terminal(t);
  for (let round = 1; round <= 2; round++) {
    let closed = false;
    const reading = await readGrokScreenVia({
      login: async () => "in", open: f.open, readFrame: () => f.session.readFrame(), stuff: (keys) => f.session.stuff(keys),
      close: async () => { await f.session.close(); closed = true; },
    }, 10_000, fastSleep);
    assert.equal(reading.ok, true, reading.error ?? "quota read succeeds");
    assert.equal(reading.usedPct, 42);
    assert.equal(closed, true);
    await f.clean();
    assert.equal(new Set(pidFile(f.termsPath)).size, 8, "every fake process received TERM before KILL");
    t.diagnostic(`round ${round}: before=0, running=8, after=${f.count()}, session/Dead entries=0, weekly used=${reading.usedPct}%`);
  }
});

for (const reader of ["grok", "cursor"] as const) {
  for (const mode of ["timeout", "login", "frame-error", "partial-open"] as const) {
    test(`${reader} ${mode} closes the real screen and its full fake process tree`, { skip: !native, timeout: 20_000 }, async (t) => {
      const f = terminal(t, mode);
      let closed = false;
      const io = {
        login: async () => "in" as const,
        open: async () => { await f.open(); if (mode === "partial-open") throw new Error("Synthetic open failure"); },
        readFrame: async () => { if (mode === "frame-error") throw new Error("Synthetic frame failure"); return f.session.readFrame(); },
        stuff: (keys: string) => f.session.stuff(keys),
        close: async () => { await f.session.close(); closed = true; },
        notifyLoginLost: async () => {},
      };
      const timeout = mode === "timeout" ? 120 : 8_000;
      const reading = reader === "grok"
        ? await (await import("../grok-usage")).readGrokScreenVia(io, timeout, fastSleep)
        : await (await import("../cursor-usage")).readCursorScreenVia(io, timeout, fastSleep);
      assert.equal(reading.ok, false);
      assert.ok(reading.error);
      if (mode === "frame-error") assert.match(reading.error, /Synthetic frame failure/);
      if (mode === "partial-open") assert.match(reading.error, /Synthetic open failure/);
      assert.equal(closed, true);
      await f.clean();
    });
  }
}

test("owned window groups catch a new child forked in a TERM handler", { skip: !native, timeout: 20_000 }, async (t) => {
  const f = terminal(t, "timeout");
  f.env.DEMO_FORK_ON_TERM = "1";
  // createScreenSession snapshots its supplied environment, so create after adding the flag.
  const session = createScreenSession(f.options);
  await session.open();
  await until(() => f.pids().length === 8, "initial process tree starts");
  await session.close();
  assert.ok(f.pids().length > 8, "TERM handler started an additional child");
  await f.clean();
});

test("a launch failure after daemon creation still cleans the process tree", { skip: !native, timeout: 20_000 }, async (t) => {
  const f = terminal(t, "timeout");
  const bin = fakeScreen(t, `
    const {spawnSync} = require("node:child_process");
    const {readFileSync} = require("node:fs");
    const args = process.argv.slice(2);
    const out = spawnSync(${JSON.stringify(SCREEN_BIN)}, args, {stdio:"inherit"});
    if (args.includes("-dmS")) {
      const end = Date.now() + 8000;
      while (Date.now() < end) {
        try { if (readFileSync(process.env.DEMO_PID_FILE,"utf8").trim().split("\\n").length === 8) break; } catch {}
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
      process.exit(7);
    }
    process.exit(out.status ?? 1);
  `);
  await assert.rejects(createScreenSession({ ...f.options, bin }).open());
  assert.ok(f.pids().length > 0, "the failed launch really created processes");
  await f.clean();
});

test("teardown preserves a different live session with a similar name", { skip: !native, timeout: 20_000 }, async (t) => {
  const target = terminal(t, "timeout");
  const neighbor = terminal(t, "timeout", target.sockets, `${target.sessionName}-keep`);
  await target.open();
  await neighbor.open();
  await target.session.close();
  await target.clean();
  assert.equal(neighbor.count(), 8, "unrelated fixture tree is untouched");
  assert.ok(neighbor.listing().includes(`.${neighbor.sessionName}\t(Detached)`));
  await neighbor.session.close();
  await neighbor.clean();
});

test("a Dead session is removed without wiping a different Dead session", { skip: !native, timeout: 20_000 }, async (t) => {
  const target = terminal(t, "timeout");
  const neighbor = terminal(t, "timeout", target.sockets, `${target.sessionName}-keep`);
  for (const f of [target, neighbor]) {
    await f.open();
    const tree = await screenSessionPids(f.sessionName, SCREEN_BIN, f.env);
    process.kill(tree[0], "SIGKILL");
    await finishScreenSession(tree.slice(1));
  }
  assert.match(target.listing(), /Dead/);
  await target.session.close();
  await target.clean();
  assert.ok(neighbor.listing().split("\n").some((line) => line.includes(`.${neighbor.sessionName}\t`) && /Dead/.test(line)));
  await neighbor.session.close();
  await neighbor.clean();
});
