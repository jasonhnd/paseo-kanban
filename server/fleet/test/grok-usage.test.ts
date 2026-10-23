import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { interpretGrokScreen, liveGrokScreenIo, readGrokScreenVia, settleSuperGrokChoice, type GrokStored } from "../grok-usage";
import { temporary } from "./screen-fixture";
import { join } from "node:path";

const trust = "Do you trust the contents of this directory?\nYes, proceed y\nNo, quit n\nGrok Build 1.0.67";

test("Grok trust gate is reported immediately without typing or approving it", async () => {
  const keys: string[] = [];
  let closed = false;
  const result = await readGrokScreenVia({ login: async () => "in", open: async () => {},
    readFrame: async () => trust, stuff: async key => { keys.push(key); }, close: async () => { closed = true; },
  }, 100, async () => {});
  assert.equal(result.ok, false);
  assert.equal(result.usedPct, null);
  assert.match(result.error!, /grok_folder_trust/);
  assert.deepEqual(keys, []);
  assert.equal(closed, true);
});

test("quota terminal launches in the inherently trusted home, without granting folder trust", async t => {
  const dir = temporary(t);
  const record = join(dir, "launch.json");
  const bin = join(dir, "screen.cjs");
  writeFileSync(bin, `#!${process.execPath}\nconst fs=require('node:fs'); const args=process.argv.slice(2); if(args.includes('-dmS')) fs.writeFileSync(${JSON.stringify(record)},JSON.stringify({cwd:process.cwd(),args})); else console.log('No Sockets found');\n`, { mode: 0o700 });
  const io = liveGrokScreenIo(bin);
  await io.open();
  await io.close();
  const launch = JSON.parse(readFileSync(record, "utf8"));
  assert.equal(launch.cwd, homedir());
  assert.equal(launch.args.at(-1).endsWith("/bin/grok"), true);
  assert.equal(launch.args.some((arg: string) => /trust|approve/.test(arg)), false);
});

for (const prompt of ["Awaiting your input", "│ ❯\nGrok Build 1.0.44", "Awaiting input\nGrok Build 1.0.67"]) {
  test(`old/new Grok composer reads the weekly panel: ${prompt}`, async () => {
    const keys: string[] = [];
    let closed = false;
    const result = await readGrokScreenVia({ login: async () => "in", open: async () => {},
      readFrame: async () => keys.length ? "Weekly limit\n16% used\nResets: October 24, 21:14\nMonthly limit\n90% used" : prompt,
      stuff: async key => { keys.push(key); }, close: async () => { closed = true; },
    }, 100, async () => {});
    assert.equal(result.ok, true, result.error ?? "");
    assert.equal(result.usedPct, 16);
    assert.deepEqual(keys, ["/usage show\r"]);
    assert.equal(closed, true);
  });
}

for (const [frame, reason] of [["Starting Grok…", "grok_prompt_timeout"], ["Awaiting your input", "grok_usage_timeout"]]) {
  test(`timeout identifies the failed stage: ${reason}`, async () => {
    const result = await readGrokScreenVia({ login: async () => "in", open: async () => {},
      readFrame: async () => frame, stuff: async () => {}, close: async () => {},
    }, 5, async () => {});
    assert.equal(result.ok, false);
    assert.match(result.error!, new RegExp(reason));
  });
}

test("trust dialog cannot be mistaken for a composer", () => {
  assert.equal(interpretGrokScreen(trust), "trust");
});

for (const thrown of [false, true]) test(`a ${thrown ? "thrown" : "returned"} failure stays failed with lastKnown separate`, async t => {
  const now = Date.now();
  const previous: GrokStored = { ok: true, usedPct: 16, readAt: new Date(now - 60_000).toISOString(),
    resetsAt: null, error: null, loggedOut: false, loginLost: false, homeAlarm: null,
    lastAttemptAt: null, unreadSince: null, providerSeen: null, diffLogged: null };
  let stored: GrokStored | undefined;
  await settleSuperGrokChoice({ providerWindows: [], manual: null, capture: true, hooks: {
    now, statePath: join(temporary(t), "failed-sample.json"),
    previous: async () => previous, history: async () => [],
    capture: async () => {
      if (thrown) throw new Error("[grok_folder_trust] directory trust required");
      return { ...previous, ok: false, usedPct: null, error: "[grok_folder_trust] directory trust required" };
    },
    persist: async value => { stored = value; },
  } });
  assert.equal(stored?.ok, false);
  assert.equal(stored?.usedPct, null);
  assert.match(stored?.error ?? "", /grok_folder_trust/);
  assert.equal(stored?.lastKnown?.usedPct, 16);
});
