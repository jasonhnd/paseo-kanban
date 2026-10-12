import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, it } from "node:test";
import { nativeSessionsCommand } from "../server/native-sessions";
import { nativeReconcileFixture } from "./helpers/native-reconcile-fixture";

let fixture: ReturnType<typeof nativeReconcileFixture>;
beforeEach(() => { fixture = nativeReconcileFixture(); });
afterEach(() => fixture.cleanup());

it("updates only board queue metadata and leaves the Codex thread index and desktop catalog unchanged", async () => {
  const { home, env, queue, status } = fixture;
  const archived = queue("codex", "archived-thread");
  const live = queue("codex", "live-thread");
  const codex = join(home, ".codex"); mkdirSync(codex);
  const threadsPath = join(codex, "state_5.sqlite");
  const threads = new DatabaseSync(threadsPath);
  threads.exec(`CREATE TABLE threads(id TEXT PRIMARY KEY, cwd TEXT, archived INTEGER);
    INSERT INTO threads VALUES ('archived-thread', '/work/demo', 1), ('live-thread', '/work/demo', 0);`);
  threads.close();
  const catalogPath = join(codex, "codex-dev.db");
  const catalog = new DatabaseSync(catalogPath);
  catalog.exec(`CREATE TABLE local_thread_catalog_sync_state(host_id TEXT, last_full_reconciled_at INTEGER);
    INSERT INTO local_thread_catalog_sync_state VALUES ('local', 42);`);
  catalog.close();
  const before = [readFileSync(threadsPath), readFileSync(catalogPath)];
  const dry = await nativeSessionsCommand({ reconcileCodex: true }, env, { home });
  assert.ok("lines" in dry); assert.equal(dry.lines.length, 1);
  assert.equal(status(archived), "pending");
  await nativeSessionsCommand({ reconcileCodex: true, apply: true }, env, { home });
  assert.equal(status(archived), "archived"); assert.equal(status(live), "pending");
  const again = await nativeSessionsCommand({ reconcileCodex: true, apply: true }, env, { home });
  assert.ok("lines" in again); assert.equal(again.lines.length, 0);
  assert.deepEqual([readFileSync(threadsPath), readFileSync(catalogPath)], before);
});

it("refuses an unregistered project leader before reading native indexes", async () => {
  const agent = fixture.queue("codex", "missing-thread");
  await assert.rejects(nativeSessionsCommand({ reconcileCodex: true, apply: true }, { PASEO_AGENT_ID: "foreign-leader" }, { home: fixture.home }));
  assert.equal(fixture.status(agent), "pending");
});
