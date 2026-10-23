/// <reference types="node" />
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { addBoardWakeMark, forgetBoardWakeMarkCache, hasBoardWakeMark } from "../server/board-wake-marks";

const dir = mkdtempSync(join(tmpdir(), "board-wake-marks-"));
const previousDataDir = process.env.KANBAN_DATA_DIR;
process.env.KANBAN_DATA_DIR = dir;

after(() => {
  forgetBoardWakeMarkCache();
  rmSync(dir, { recursive: true, force: true });
  if (previousDataDir === undefined) delete process.env.KANBAN_DATA_DIR;
  else process.env.KANBAN_DATA_DIR = previousDataDir;
});

describe("skip marks do not push live alert marks out of the file", () => {
  it("keeps an older alert mark after 150 newer skip marks and a reload", () => {
    addBoardWakeMark("stall:alert-1", "2026-09-01T00:00:00.000Z");
    const now = Date.now();
    for (let i = 0; i < 150; i += 1) addBoardWakeMark(`skip:agent-${i}:wake`, new Date(now - (150 - i) * 1000).toISOString());
    forgetBoardWakeMarkCache();
    assert.ok(hasBoardWakeMark("stall:alert-1"), "the alert mark survived");
    assert.ok(hasBoardWakeMark("skip:agent-149:wake"), "the newest skip mark is there");
    assert.ok(!hasBoardWakeMark("skip:agent-0:wake"), "the oldest skip marks are what gets dropped");
  });

  it("drops a skip mark a week after it was written, and never an alert mark for age", () => {
    addBoardWakeMark("skip:old-agent:wake", new Date(Date.now() - 8 * 24 * 3600_000).toISOString());
    addBoardWakeMark("stall:old-alert", new Date(Date.now() - 30 * 24 * 3600_000).toISOString());
    forgetBoardWakeMarkCache();
    assert.ok(!hasBoardWakeMark("skip:old-agent:wake"));
    assert.ok(hasBoardWakeMark("stall:old-alert"));
  });
});
