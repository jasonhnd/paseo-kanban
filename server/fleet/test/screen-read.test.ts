/// <reference types="node" />
import assert from "node:assert/strict";
import childProcess, { spawn } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { alive, pidFile, temporary, terminal, until } from "./screen-fixture";
import { createScreenSession, finishScreenSession, SCREEN_BIN, screenSessionPids, sleep } from "../screen-read";

const native = (process.platform === "darwin" || process.platform === "linux") && existsSync(SCREEN_BIN);
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

test("cleanup retries transient session lookup failures without leaving a terminal", { skip: !native, timeout: 25_000 }, async (t) => {
  const f = terminal(t, "timeout");
  const state = join(f.dir, "failures");
  const bin = fakeScreen(t, `
    const fs = require("node:fs");
    const {spawnSync} = require("node:child_process");
    const args = process.argv.slice(2);
    if (args[0] === "-ls" && fs.existsSync(${JSON.stringify(state)})) {
      const remaining = Number(fs.readFileSync(${JSON.stringify(state)}, "utf8"));
      if (remaining > 0) { fs.writeFileSync(${JSON.stringify(state)}, String(remaining - 1)); process.exit(2); }
    }
    process.exit(spawnSync(${JSON.stringify(SCREEN_BIN)}, args, {stdio: "inherit"}).status ?? 1);
  `);
  await f.open();
  writeFileSync(state, "2");
  await createScreenSession({ ...f.options, bin }).close();
  assert.equal(readFileSync(state, "utf8"), "0");
  await f.clean();
});

test("cleanup retries a timed-out process snapshot before quitting the terminal", { skip: !native, timeout: 25_000 }, async (t) => {
  const original = childProcess.execFile;
  let failures = 0;
  const mocked = t.mock.method(childProcess, "execFile", (...args: Parameters<typeof original>) => {
    if (args[0] === "/bin/ps" && failures > 0) {
      failures--;
      const callback = args.at(-1) as (error: Error, stdout: string, stderr: string) => void;
      queueMicrotask(() => callback(Object.assign(new Error("Synthetic process snapshot timeout"), { killed: true }), "", ""));
      return undefined as unknown as childProcess.ChildProcess;
    }
    return original(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
  const f = terminal(t, "timeout");
  await f.open();
  failures = 2;
  await f.session.close();
  assert.equal(failures, 0);
  await f.clean();
});

test("close waits for an in-flight launch before removing its process tree", { skip: !native, timeout: 25_000 }, async (t) => {
  const f = terminal(t, "timeout");
  const ready = join(f.dir, "launching");
  const bin = fakeScreen(t, `
    const fs = require("node:fs");
    const {spawnSync} = require("node:child_process");
    const args = process.argv.slice(2);
    if (args.includes("-dmS")) {
      fs.writeFileSync(${JSON.stringify(ready)}, "yes");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 800);
    }
    process.exit(spawnSync(${JSON.stringify(SCREEN_BIN)}, args, {stdio: "inherit"}).status ?? 1);
  `);
  const session = createScreenSession({ ...f.options, bin });
  const opening = session.open();
  await until(() => existsSync(ready), "launch is in flight");
  await session.close();
  await opening;
  assert.deepEqual(await screenSessionPids(f.sessionName, SCREEN_BIN, f.env), []);
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

for (const mode of ["failure", "timeout", "cancel", "killed"] as const) {
  test(`fixture cleanup survives test ${mode} during startup`, { skip: !native, timeout: 45_000 }, async (t) => {
    const dir = temporary(t, false);
    const record = join(dir, "owner.json");
    let owned: { dir: string; sockets: string; session: string } | undefined;
    t.after(async () => {
      if (owned) {
        await finishScreenSession(pidFile(`${record}.pids`));
        if (existsSync(owned.sockets)) await createScreenSession({ session: owned.session, dir: join(owned.dir, "frames"), cwd: owned.dir,
          launch: "unused", bin: SCREEN_BIN, env: { ...process.env, SCREENDIR: owned.sockets } }).close();
        rmSync(owned.dir, { recursive: true, force: true });
      }
      rmSync(dir, { recursive: true, force: true });
    });
    const fixture = fileURLToPath(new URL("./fixtures/screen-lifecycle.ts", import.meta.url));
    const { NODE_TEST_CONTEXT: _parent, ...baseEnv } = process.env;
    const env = { ...baseEnv, DEMO_LIFECYCLE: mode, DEMO_LIFECYCLE_RECORD: record };
    const child = spawn(process.execPath, ["--import", "tsx", "--test", "--test-reporter=tap", fixture], { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += String(chunk); });
    child.stderr.on("data", (chunk) => { output += String(chunk); });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
    const exit = await new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
    assert.ok(existsSync(record), output);
    owned = JSON.parse(readFileSync(record, "utf8"));
    assert.notEqual(exit, 0, "the inner interruption actually fails the test worker");
    if (mode === "failure") assert.match(output, /Synthetic assertion failure/);
    if (mode === "timeout") assert.match(output, /timed out/);
    if (mode === "cancel") assert.match(output, /Synthetic test cancellation/);
    if (mode === "killed") assert.match(output, /SIGKILL/);
    await until(() => pidFile(`${record}.pids`).every((pid) => !alive(pid)), "all interrupted fixture processes exit");
    const listing = childProcess.spawnSync(SCREEN_BIN, ["-ls"], { env: { ...process.env, SCREENDIR: owned!.sockets }, encoding: "utf8", timeout: 5_000 });
    if (listing.error) throw listing.error;
    assert.ok(!/^\s*\d+\.\S+\s+\(/m.test(listing.stdout), "the interrupted owner's socket directory is empty");
    if (mode !== "killed") assert.equal(existsSync(owned!.dir), false, "hooks remove the fixture directory after cleanup");
  });
}
