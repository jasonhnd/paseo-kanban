/// <reference types="node" />
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import {
  cleanSessionDirs, flushSessionCleanup, isClaudeCli, listClaudeStarts, mayUseDefaultRoots, parseClaudeStarts,
  resetSessionCleanupForTests, scheduleSessionCleanup, uuidV7Time,
} from "../server/tmp-sessions";

const base = mkdtempSync(join(tmpdir(), "tmpsess-"));
process.env.KANBAN_DATA_DIR = base;
const DAY = 24 * 60 * 60_000;
let root = "";
let seq = 0;

after(() => rmSync(base, { recursive: true, force: true }));

beforeEach(() => {
  resetSessionCleanupForTests();
  root = join(base, `sessions-${++seq}`);
  mkdirSync(root, { recursive: true });
});

/** A UUIDv7 whose timestamp is `ms`. */
function v7(ms: number, tail = "7aaa-8bbb-000000000001"): string {
  const hex = Math.floor(ms).toString(16).padStart(12, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8)}-${tail}`;
}

function empty(name: string): string {
  const path = join(root, name);
  mkdirSync(path);
  return path;
}

// The directories are born now. Pretend it is three days later, so they are over a day old.
const later = () => new Date(Date.now() + 3 * DAY);
const noClaude = async () => [] as number[];

describe("empty /tmp/sessions/<uuid> cleanup", () => {
  it("reads the millisecond timestamp out of a UUIDv7 and nothing else", () => {
    assert.equal(uuidV7Time(v7(1_791_018_792_791)), 1_791_018_792_791);
    assert.equal(uuidV7Time("00000000-0000-4000-8000-000000000006"), null);
    assert.equal(uuidV7Time("not-a-uuid"), null);
  });

  it("removes empty UUID directories older than a day when no claude process is older", async () => {
    const a = empty(v7(Date.now()));
    const b = empty(v7(Date.now() + 1, "7aaa-8bbb-000000000002"));
    assert.equal(await cleanSessionDirs({ roots: [root], now: later(), claudeStarts: noClaude }), 2);
    assert.equal(existsSync(a), false);
    assert.equal(existsSync(b), false);
  });

  it("keeps directories that are not yet a day old", async () => {
    const fresh = empty(v7(Date.now()));
    assert.equal(await cleanSessionDirs({ roots: [root], now: new Date(Date.now() + DAY / 2), claudeStarts: noClaude }), 0);
    assert.equal(existsSync(fresh), true);
  });

  it("keeps directories born after the oldest running claude process", async () => {
    const dir = empty(v7(Date.now()));
    const olderProcess = async () => [Date.now() - 1000];
    assert.equal(await cleanSessionDirs({ roots: [root], now: later(), claudeStarts: olderProcess }), 0);
    assert.equal(existsSync(dir), true);
  });

  it("removes directories born before every running claude process", async () => {
    const dir = empty(v7(Date.now()));
    const newerProcess = async () => [Date.now() + 2 * DAY, Date.now() + 2.5 * DAY];
    assert.equal(await cleanSessionDirs({ roots: [root], now: later(), claudeStarts: newerProcess }), 1);
    assert.equal(existsSync(dir), false);
  });

  it("removes nothing when the process list cannot be read", async () => {
    const dir = empty(v7(Date.now()));
    assert.equal(await cleanSessionDirs({ roots: [root], now: later(), claudeStarts: async () => null }), 0);
    assert.equal(existsSync(dir), true);
  });

  it("never removes a directory that holds anything, a file, a link or a non-UUID name", async () => {
    const full = empty(v7(Date.now()));
    writeFileSync(join(full, "lock"), "x");
    const file = join(root, v7(Date.now(), "7aaa-8bbb-000000000003"));
    writeFileSync(file, "x");
    const target = join(base, `target-${seq}`);
    mkdirSync(target);
    const link = join(root, v7(Date.now(), "7aaa-8bbb-000000000004"));
    symlinkSync(target, link);
    const named = empty("keepme");
    const nested = empty(v7(Date.now(), "7aaa-8bbb-000000000005"));
    mkdirSync(join(nested, "inner"));
    assert.equal(await cleanSessionDirs({ roots: [root], now: later(), claudeStarts: noClaude }), 0);
    for (const path of [full, file, link, target, named, nested, join(nested, "inner")]) assert.equal(existsSync(path), true, path);
  });

  it("removes at most `limit` directories per round, oldest first, and drains the rest next round", async () => {
    const names = [1, 2, 3, 4, 5].map((n) => v7(Date.now() + n, `7aaa-8bbb-00000000000${n}`));
    for (const name of names) empty(name);
    assert.equal(await cleanSessionDirs({ roots: [root], now: later(), claudeStarts: noClaude, limit: 2 }), 2);
    assert.deepEqual([0, 1].map((i) => existsSync(join(root, names[i]!))), [false, false]);
    assert.equal(existsSync(join(root, names[2]!)), true);
    assert.equal(await cleanSessionDirs({ roots: [root], now: later(), claudeStarts: noClaude, limit: 10 }), 3);
  });

  it("does nothing when the sessions directory does not exist", async () => {
    assert.equal(await cleanSessionDirs({ roots: [join(base, "missing")], now: later(), claudeStarts: noClaude }), 0);
  });

  it("scheduleSessionCleanup runs once per throttle window", async () => {
    const dir = empty(v7(Date.now()));
    const now = later();
    scheduleSessionCleanup({ now, roots: [root], claudeStarts: noClaude });
    await flushSessionCleanup();
    assert.equal(existsSync(dir), false);
    const again = empty(v7(Date.now() + 5, "7aaa-8bbb-000000000009"));
    scheduleSessionCleanup({ now: new Date(now.getTime() + 60_000), roots: [root], claudeStarts: noClaude });
    await flushSessionCleanup();
    assert.equal(existsSync(again), true);
    scheduleSessionCleanup({ now: new Date(now.getTime() + 6 * 60_000), roots: [root], claudeStarts: noClaude });
    await flushSessionCleanup();
    assert.equal(existsSync(again), false);
  });

  it("reads anonymous ps output and fails closed on an unavailable process query", async () => {
    const tools = join(root, "tools"); mkdirSync(tools);
    const command = join(tools, "ps");
    const row = "Sat Oct  3 18:13:12 2026 node /opt/demo/claude-code/cli.js\n";
    writeFileSync(command, `#!${process.execPath}\nif (process.argv.slice(2).join(' ') !== '-axo lstart=,command=') process.exit(2);\nprocess.stdout.write(${JSON.stringify(row)});\n`, { mode: 0o755 });
    const oldPath = process.env.PATH;
    try {
      process.env.PATH = tools;
      assert.deepEqual(await listClaudeStarts(), [Date.parse(row.slice(0, 24))]);
      writeFileSync(command, `#!${process.execPath}\nprocess.exit(1);\n`, { mode: 0o755 });
      assert.equal(await listClaudeStarts(), null);
    } finally {
      if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    }
  });

  it("recognizes every Claude Code CLI launch form and nothing else", () => {
    const yes = [
      "/Users/example/.nvm/versions/node/v24/bin/claude --output-format stream-json",
      "claude.exe",
      "node /Users/example/lib/node_modules/@anthropic-ai/claude-code/cli.js --resume x",
      "/usr/local/bin/node /Users/example/.local/bin/claude -p hi",
      "node --no-warnings /Users/example/lib/node_modules/@anthropic-ai/claude-code/cli.js",
    ];
    const no = [
      // The browser-extension host stays up for days and is not a session.
      "/Users/example/.nvm/versions/node/v24/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe --chrome-native-host",
      "claude --chrome-native-host",
      "/Applications/Claude.app/Contents/MacOS/Claude",
      "/Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper --type=gpu-process",
      "node /Users/example/.claude/paseo-native-tools/sky-computer-use-mcp.js",
      "grep claude",
      "node server.js claude",
      "/bin/zsh -c echo claude",
    ];
    for (const command of yes) assert.equal(isClaudeCli(command), true, command);
    for (const command of no) assert.equal(isClaudeCli(command), false, command);
  });

  it("parses ps rows and refuses the whole round on a matching row it cannot read", () => {
    const rows = [
      "Thu Oct  1 11:58:18 2026     /n/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe --chrome-native-host",
      "Sat Oct  3 18:13:12 2026     /n/bin/claude --output-format stream-json",
      "Fri Oct  2 06:59:09 2026     /Applications/Claude.app/Contents/MacOS/Claude",
    ].join("\n");
    const starts = parseClaudeStarts(rows);
    assert.deepEqual(starts, [Date.parse("Sat Oct  3 18:13:12 2026")], "the chrome native host is not a session");
    assert.equal(parseClaudeStarts("garbage-date-here-xxxxxx  /n/bin/claude"), null);
  });

  it("an old claude session protects a directory born after it, a long-running chrome native host does not", async () => {
    const born = Date.now();
    const dir = empty(v7(born));
    const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const ps = (ms: number) => {
      const d = new Date(ms);
      return `${DAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${String(d.getDate()).padStart(2, " ")} ${d.toTimeString().slice(0, 8)} ${d.getFullYear()}`;
    };
    const host = `${ps(born - 2 * DAY)}     /n/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe --chrome-native-host`;
    const oldSession = `${ps(born - 2 * DAY)}     /n/bin/claude --output-format stream-json`;
    const newSession = `${ps(born + 2 * DAY)}     /n/bin/claude --output-format stream-json`;
    const startsOf = (...rows: string[]) => async () => parseClaudeStarts(rows.join("\n"));
    assert.equal(await cleanSessionDirs({ roots: [root], now: later(), claudeStarts: startsOf(oldSession, newSession) }), 0, "an old session protects it");
    assert.equal(existsSync(dir), true);
    assert.equal(await cleanSessionDirs({ roots: [root], now: later(), claudeStarts: startsOf(host, newSession) }), 1, "the old host does not");
    assert.equal(existsSync(dir), false);
  });

  it("never touches the real /tmp/sessions from tests, an isolated board or the scheduler", async () => {
    let looked = 0;
    const spy = async () => { looked += 1; return [] as number[]; };
    assert.equal(mayUseDefaultRoots(), false);
    assert.equal(await cleanSessionDirs({ now: later(), claudeStarts: spy }), 0);
    scheduleSessionCleanup({ now: later(), claudeStarts: spy, force: true });
    await flushSessionCleanup();
    // Not a node --test child any more, but the board is still an isolated data directory.
    const context = process.env.NODE_TEST_CONTEXT;
    delete process.env.NODE_TEST_CONTEXT;
    try {
      assert.equal(mayUseDefaultRoots(), false);
      assert.equal(await cleanSessionDirs({ now: later(), claudeStarts: spy }), 0);
    } finally {
      if (context !== undefined) process.env.NODE_TEST_CONTEXT = context;
    }
    assert.equal(looked, 0);
  });
});
