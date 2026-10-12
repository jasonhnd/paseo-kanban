/// <reference types="node" />
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { EXPORTS, readContractFile } from "../server/contract";
import { closeDb, getDb } from "../server/db";
import { buildBoardSummary, buildKanbanInfo, startExports, writeBoardSummary, writeKanbanInfo } from "../server/exports";
import { kanbanCliPath } from "../server/paths";
import { createTask } from "../server/store";

const dir = mkdtempSync(join(tmpdir(), "board-exports-"));
const exportsDir = join(dir, "exports");
const saved = { data: process.env.KANBAN_DATA_DIR, config: process.env.KANBAN_PASEO_CONFIG };

before(() => {
  process.env.KANBAN_DATA_DIR = dir;
  process.env.KANBAN_PASEO_CONFIG = join(dir, "no-paseo-config.json");
  getDb();
});

after(() => {
  closeDb();
  if (saved.data === undefined) delete process.env.KANBAN_DATA_DIR;
  else process.env.KANBAN_DATA_DIR = saved.data;
  if (saved.config === undefined) delete process.env.KANBAN_PASEO_CONFIG;
  else process.env.KANBAN_PASEO_CONFIG = saved.config;
  rmSync(dir, { recursive: true, force: true });
});

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll until `check` holds; the suite runs under heavy parallel load, so fixed sleeps are flaky. */
async function waitFor(check: () => boolean | Promise<boolean>, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) assert.fail(`timed out waiting: ${what}`);
    await wait(20);
  }
}

describe("board exports", () => {
  it("kanban.json names the data directory and the command line", async () => {
    const info = buildKanbanInfo(new Date("2026-01-01T00:00:00Z"));
    assert.equal(info.dataDir, dir);
    assert.equal(info.cli, kanbanCliPath());
    assert.equal(info.ttlSeconds, EXPORTS.kanban.ttlSeconds);
    await writeKanbanInfo();
    const read = await readContractFile(join(exportsDir, "kanban.json"), EXPORTS.kanban.schema);
    assert.equal(read.state, "fresh");
  });

  it("board-summary.json lists open cards with their numbers and validates against the contract", async () => {
    const task = createTask({ project: "demo", title: "Example card", role: "executor", createdByAgent: "creator" });
    const summary = buildBoardSummary();
    const card = summary.cards.find((item) => item.project === "demo");
    assert.ok(card, "the open card is listed");
    assert.equal(card.status, task.status);
    assert.equal(card.finishedAt, null);
    assert.equal(summary.dbPath, join(dir, "kanban.db"));
    await writeBoardSummary();
    const read = await readContractFile(join(exportsDir, "board-summary.json"), EXPORTS.boardSummary.schema);
    assert.equal(read.state, "fresh");
    assert.deepEqual(readdirSync(exportsDir).filter((name) => name.endsWith(".tmp")), [], "atomic writes leave no temp file");
  });

  it("rewrites the summary once the board has been quiet for the debounce interval", async () => {
    rmSync(exportsDir, { recursive: true, force: true });
    const stop = startExports({ debounceMs: 40, infoMs: 60_000, summaryMs: 60_000, log: () => undefined });
    try {
      const summaryFile = join(exportsDir, "board-summary.json");
      await waitFor(() => existsSync(join(exportsDir, "kanban.json")) && existsSync(summaryFile), "both written at start");
      rmSync(summaryFile, { force: true });
      createTask({ project: "demo", title: "Second card", role: "executor", createdByAgent: "creator" });
      await waitFor(() => existsSync(summaryFile), "summary rewritten after the change");
      const read = await readContractFile(summaryFile, EXPORTS.boardSummary.schema);
      assert.equal(read.state, "fresh");
      assert.equal(read.state === "fresh" && read.value.cards.some((item) => item.project === "demo"), true);
    } finally {
      stop();
    }
  });
});
