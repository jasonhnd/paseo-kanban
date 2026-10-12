// Kanban presence from its contract files: absent, stale and fresh. Demo payloads and temp dirs only.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, test } from "node:test";
import { NOW, VALID } from "../../contract/test/fixtures";
import {
  ABSENT_SOURCE,
  clearKanbanSourceMemo,
  kanbanSource,
  resolveKanbanSource,
  staleNote,
} from "../kanban-source";

const root = mkdtempSync(join(tmpdir(), "afc-kanban-source-"));
const kanbanDir = join(root, "kanban");
const exportsDir = join(kanbanDir, "exports");
const env = { KANBAN_DATA_DIR: kanbanDir, PASEO_HOME: join(root, ".paseo") };
const demoDb = join(kanbanDir, "kanban.db");

function write(name: string, value: unknown): void {
  mkdirSync(exportsDir, { recursive: true });
  writeFileSync(join(exportsDir, name), typeof value === "string" ? value : JSON.stringify(value));
}

function read(now: Date = NOW) {
  return kanbanSource({ env, home: root, now });
}

const minutesLater = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

beforeEach(() => {
  rmSync(kanbanDir, { recursive: true, force: true });
  clearKanbanSourceMemo();
});
after(() => rmSync(root, { recursive: true, force: true }));

describe("kanbanSource", () => {
  test("no kanban.json: absent, even when a board summary and a database exist", () => {
    write("board-summary.json", { ...VALID.boardSummary, dbPath: demoDb });
    writeFileSync(demoDb, "");
    assert.deepEqual(read(), ABSENT_SOURCE);
  });

  test("invalid kanban.json (bad JSON or wrong schema) counts as absent", () => {
    write("kanban.json", "{not json");
    assert.equal(read().presence, "absent");
    clearKanbanSourceMemo();
    write("kanban.json", { ...VALID.kanban, schema: "fleet-quota/v0" });
    assert.equal(read().presence, "absent");
  });

  test("both files fresh: fresh, with the summary and the database it names", () => {
    mkdirSync(kanbanDir, { recursive: true });
    writeFileSync(demoDb, "");
    write("kanban.json", VALID.kanban);
    write("board-summary.json", { ...VALID.boardSummary, dbPath: demoDb });
    const source = read(minutesLater(5));
    assert.equal(source.presence, "fresh");
    assert.equal(source.summary?.cards[0]?.code, "DEMO_0001");
    assert.equal(source.dbPath, demoDb);
    assert.equal(source.staleSeconds, null);
    assert.equal(staleNote(source), null);
  });

  test("a summary past three TTLs makes the source stale and keeps its data", () => {
    write("kanban.json", VALID.kanban);
    write("board-summary.json", VALID.boardSummary);
    // board summary TTL is 900 s: stale after 45 min; kanban.json (1800 s) is still fresh at 50 min.
    const source = read(minutesLater(50));
    assert.equal(source.presence, "stale");
    assert.equal(source.summary?.cards.length, 1);
    assert.equal(source.staleSeconds, 50 * 60);
    assert.equal(staleNote(source), "Kanban data is stale (last update 50 min ago)");
  });

  test("a stale kanban.json is still present (stale), not absent", () => {
    write("kanban.json", VALID.kanban);
    write("board-summary.json", VALID.boardSummary);
    assert.equal(read(minutesLater(24 * 60)).presence, "stale");
  });

  test("summary missing: stale, and no deep queries even though Kanban's default database exists", () => {
    mkdirSync(kanbanDir, { recursive: true });
    writeFileSync(demoDb, "");
    write("kanban.json", VALID.kanban);
    const source = read();
    assert.equal(source.presence, "stale");
    assert.equal(source.summary, null);
    assert.equal(source.dbPath, null);
    assert.equal(staleNote(source), "Kanban board summary is unavailable");
  });

  test("summary invalid: same as missing, the default database is never guessed", () => {
    mkdirSync(kanbanDir, { recursive: true });
    writeFileSync(demoDb, "");
    write("kanban.json", VALID.kanban);
    write("board-summary.json", "{broken");
    const source = read();
    assert.equal(source.presence, "stale");
    assert.equal(source.dbPath, null);
  });

  test("summary with dbPath null: no deep queries, even when the default database exists", () => {
    mkdirSync(kanbanDir, { recursive: true });
    writeFileSync(demoDb, "");
    write("kanban.json", VALID.kanban);
    write("board-summary.json", { ...VALID.boardSummary, dbPath: null });
    assert.equal(read().dbPath, null);
  });

  test("a dbPath that does not exist is not handed out", () => {
    write("kanban.json", VALID.kanban);
    write("board-summary.json", { ...VALID.boardSummary, dbPath: join(root, "missing", "kanban.db") });
    assert.equal(read().dbPath, null);
  });

  test("a rewritten file is picked up (memo keyed on mtime and size)", () => {
    write("kanban.json", VALID.kanban);
    write("board-summary.json", VALID.boardSummary);
    assert.equal(read().summary?.cards.length, 1);
    write("board-summary.json", { ...VALID.boardSummary, cards: [] });
    assert.equal(read().summary?.cards.length, 0);
  });
});

describe("resolveKanbanSource (pure)", () => {
  const fresh = <T>(value: T) => ({ state: "fresh" as const, value, ageSeconds: 10 });
  const never = () => false;

  test("info absent or invalid wins over everything else", () => {
    assert.deepEqual(resolveKanbanSource({ state: "absent" }, fresh({ ...VALID.boardSummary, dbPath: "/demo.db" }), () => true), ABSENT_SOURCE);
    assert.deepEqual(resolveKanbanSource({ state: "invalid", reason: "x" }, fresh({ ...VALID.boardSummary, dbPath: "/demo.db" }), () => true), ABSENT_SOURCE);
  });

  test("invalid or missing summary: stale, no database", () => {
    for (const summary of [{ state: "invalid" as const, reason: "x" }, { state: "absent" as const }]) {
      const source = resolveKanbanSource(fresh(VALID.kanban), summary, () => true);
      assert.equal(source.presence, "stale");
      assert.equal(source.summary, null);
      assert.equal(source.dbPath, null);
    }
  });

  test("the summary's dbPath is used only when the file exists", () => {
    const summary = fresh({ ...VALID.boardSummary, dbPath: "/demo.db" });
    assert.equal(resolveKanbanSource(fresh(VALID.kanban), summary, (p) => p === "/demo.db").dbPath, "/demo.db");
    assert.equal(resolveKanbanSource(fresh(VALID.kanban), summary, never).dbPath, null);
  });
});
