/// <reference types="node" />
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, it } from "node:test";
import { KanbanError } from "../server/errors";
import { lsofHolders } from "../server/vacuum";
import { lsofFixture } from "./helpers/lsof-fixture";

const root = mkdtempSync(join(tmpdir(), "lsof-protocol-"));
const db = join(root, "anonymous.db");
const wal = `${db}-wal`;
writeFileSync(db, "fixture");
writeFileSync(wal, "fixture");
after(() => rmSync(root, { recursive: true, force: true }));

function query(response: { stdout?: string; stderr?: string; status: number }) {
  const previous = process.env.PATH;
  process.env.PATH = `${lsofFixture(join(root, "tools"), { files: [db, wal], ...response })}${delimiter}${previous}`;
  try { return lsofHolders([db, join(root, "absent.db"), wal]); }
  finally { process.env.PATH = previous; }
}

it("parses real subprocess protocol records, excluding this process and absent files", () => {
  assert.deepEqual(query({ status: 0, stdout: `p${process.pid}\ncself\nf9\np900000\ncanonymous holder\nf10\nfmem\n` }), [{ pid: 900000, command: "anonymous holder" }]);
  assert.deepEqual(query({ status: 1 }), []);
  assert.deepEqual(lsofHolders([join(root, "absent.db")]), []);
});

it("refuses failed, partial or malformed inspection instead of declaring the database unused", () => {
  for (const response of [
    { status: 2, stderr: "anonymous inspection failure\n" },
    { status: 1, stderr: "anonymous permission denied\n" },
    { status: 1, stdout: "p900000\ncanonymous holder\n" },
    { status: 0, stdout: "p900000\ncanonymous holder\n", stderr: "incomplete inspection\n" },
    { status: 0, stdout: "pNaN\ncanonymous holder\n" },
    { status: 0, stdout: "p0\ncanonymous holder\n" },
    { status: 0, stdout: "p900000\n" },
    { status: 0, stdout: "p900000\ncanonymous holder\n" },
    { status: 0, stdout: "p900000\ncanonymous holder\nf\n" },
    { status: 0, stdout: "canonymous holder\n" },
    { status: 0, stdout: "p900000\nc\n" },
    { status: 0, stdout: "unexpected field\n" },
    { status: 0 },
  ]) assert.throws(() => query(response), (error: unknown) => error instanceof KanbanError && error.code === "conflict", JSON.stringify(response));
});

it("refuses a missing inspection executable", () => {
  const previous = process.env.PATH;
  process.env.PATH = join(root, "unavailable");
  try { assert.throws(() => lsofHolders([db]), (error: unknown) => error instanceof KanbanError && error.code === "conflict"); }
  finally { process.env.PATH = previous; }
});
