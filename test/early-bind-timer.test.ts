/// <reference types="node" />
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EARLY_BIND_DELAYS_MS, EARLY_BIND_STEADY_MS, earlyBindDelayMs, startEarlyBind } from "../server/early-bind";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("early bind delays", () => {
  it("steps through the delay table and then holds the steady delay", () => {
    const delays = [0, 1, 2, 3, 4, 20].map((failures) => earlyBindDelayMs(failures));
    assert.deepEqual(delays, [...EARLY_BIND_DELAYS_MS, EARLY_BIND_STEADY_MS, EARLY_BIND_STEADY_MS]);
  });
});

describe("early bind with the built-in timer", () => {
  it("retries after the first delay, then binds and stops scheduling", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const logs: string[] = [];
    const bound: string[] = [];
    let attempts = 0;
    let isBound = false;
    startEarlyBind({
      connect: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("daemon not up");
        return "client";
      },
      alreadyBound: () => isBound,
      onBound: (client) => { isBound = true; bound.push(client); },
      log: (message) => logs.push(message),
    });
    await flush();
    assert.deepEqual(logs, ["daemon not up"]);
    t.mock.timers.tick(EARLY_BIND_DELAYS_MS[0]!);
    await flush();
    assert.deepEqual(bound, ["client"]);
    assert.equal(attempts, 2);
    t.mock.timers.tick(EARLY_BIND_STEADY_MS * 2);
    await flush();
    assert.equal(attempts, 2);
  });

  it("clears the pending retry when stopped", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let attempts = 0;
    const early = startEarlyBind({
      connect: async () => { attempts += 1; throw new Error("down"); },
      alreadyBound: () => false,
      onBound: () => assert.fail("must not bind after stop"),
      log: () => undefined,
    });
    await flush();
    early.stop();
    t.mock.timers.tick(EARLY_BIND_STEADY_MS);
    await flush();
    assert.equal(attempts, 1);
  });
});

describe("early bind losing the race", () => {
  it("discards a client that connected after something else bound first", async () => {
    let isBound = false;
    const discarded: string[] = [];
    let release: (client: string) => void = () => undefined;
    startEarlyBind({
      connect: () => new Promise<string>((resolve) => { release = resolve; }),
      alreadyBound: () => isBound,
      onBound: () => assert.fail("must not bind a second client"),
      discard: (client) => discarded.push(client),
      log: () => undefined,
    });
    isBound = true;
    release("late-client");
    await flush();
    assert.deepEqual(discarded, ["late-client"]);
  });

  it("does not log or retry a failure that arrives after stop", async () => {
    const logs: string[] = [];
    let fail: (err: Error) => void = () => undefined;
    const early = startEarlyBind({
      connect: () => new Promise<string>((_, reject) => { fail = reject; }),
      alreadyBound: () => false,
      onBound: () => undefined,
      log: (message) => logs.push(message),
      setTimer: () => assert.fail("must not schedule after stop"),
    });
    early.stop();
    fail(new Error("too late"));
    await flush();
    assert.deepEqual(logs, []);
  });
});
