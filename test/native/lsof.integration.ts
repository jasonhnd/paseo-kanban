/// <reference types="node" />
// Explicit native integration: missing lsof is an error, never a skipped test.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { it } from "node:test";
import { lsofHolders } from "../../server/vacuum";

it("native lsof sees a child holding SQLite and excludes this process", async () => {
  const root = mkdtempSync(join(tmpdir(), "native-lsof-"));
  const file = join(root, "anonymous.db");
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE fixture(value INTEGER)");
  const child = spawn(process.execPath, ["-e", `const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(${JSON.stringify(file)});db.prepare('select 1').get();console.log('open');setInterval(()=>{},1000)`], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("native SQLite fixture did not open within 10 seconds")), 10_000);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("exit", () => { clearTimeout(timer); reject(new Error("native SQLite fixture exited before opening")); });
      child.stdout.once("data", () => { clearTimeout(timer); resolve(); });
    });
    const holders = lsofHolders([file]);
    assert.ok(holders.some(holder => holder.pid === child.pid), JSON.stringify(holders));
    assert.ok(!holders.some(holder => holder.pid === process.pid));
    assert.deepEqual(lsofHolders([join(root, "missing.db")]), []);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
