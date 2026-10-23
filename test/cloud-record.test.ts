/// <reference types="node" />
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import { closeDb, getDb } from "../server/db";
import { parseConfig, saveConfig } from "../server/config";
import { createTask, appendEvent } from "../server/store";
import { cloudDelivery, cloudReceipt, isCloudDeliveryRun, localCloudReceipt, parseCloudReceipt, type LocalCloudReceipt } from "../server/cloud-record";

const root = realpathSync(mkdtempSync(join(tmpdir(), "cloud-record-")));
const repoRoot = join(root, "repo"); mkdirSync(repoRoot);
let id: number; let runId: number;
const hash = (n: number) => n.toString(16).repeat(40);
const receipt = (): LocalCloudReceipt => ({ kind: "local", project: "paseo-kanban", repoRoot, sourceBase: hash(1), snapshotCommit: hash(2),
  tree: hash(3), cloudHead: hash(4), localHead: hash(5), runId, generation: 1 });
const started = (patch = {}) => appendEvent(id, "cloud_run_started", null, null, "scheduler", { ...receipt(), source: "localMirror", ...patch });
const delivered = (data: unknown = receipt(), actor = "scheduler") => appendEvent(id, "cloud_delivery", null, null, actor, data as Record<string, unknown>);
beforeEach(() => {
  closeDb(); process.env.KANBAN_DATA_DIR = mkdtempSync(join(root, "db-"));
  saveConfig(parseConfig({ projects: { "paseo-kanban": { defaultWorkspace: "dir", workspacePath: repoRoot } } }));
  id = createTask({ project: "paseo-kanban", title: "Receipt fixture", role: "executor" }).id;
  runId = Number(getDb().prepare("INSERT INTO runs(task_id, role, started_at) VALUES (?, 'executor', ?)").run(id, new Date().toISOString()).lastInsertRowid);
});
after(() => { closeDb(); rmSync(root, { recursive: true, force: true }); });

test("local receipts serialize and bind the host delivery to the current executor generation", () => {
  const value = receipt();
  assert.deepEqual(parseCloudReceipt(JSON.parse(JSON.stringify(value))), value);
  started(); delivered();
  assert.deepEqual(cloudReceipt(id), value); assert.deepEqual(localCloudReceipt(id), value);
  assert.equal(cloudDelivery(id), null, "public callers cannot accidentally consume an anonymous cloud head");
  assert.equal(isCloudDeliveryRun(id, runId), true);
  assert.equal(isCloudDeliveryRun(id, runId + 1), false);
});

test("legacy public receipts retain their required PR URL and original event shape", () => {
  const value = { generation: 1, machine: "demo", branch: "kanban/demo", repo: "example/demo", base: "main", mirror: repoRoot,
    originalPath: null, originalKind: null, runId, head: hash(1), baseHead: hash(2), pr: "https://github.com/example/demo/pull/1", files: ["demo.txt"] };
  delivered(value);
  assert.deepEqual(cloudDelivery(id), value); assert.deepEqual(cloudReceipt(id), value);
  assert.equal(isCloudDeliveryRun(id, runId), true);
  assert.equal(localCloudReceipt(id), null);
  for (const patch of [{ pr: undefined }, { pr: "file:///demo" }, { kind: "local" }, { kind: "unknown" }]) {
    assert.equal(parseCloudReceipt({ ...value, ...patch }), null);
  }
});

test("malformed, mixed or forged local receipt payloads are refused", () => {
  for (const patch of [{ kind: "public" }, { project: "renamed" }, { repoRoot: "relative" }, { sourceBase: "HEAD" },
    { cloudHead: hash(2) }, { localHead: hash(4) }, { tree: "f".repeat(64) }, { runId: 0 }, { generation: 0 },
    { generation: 1.5 }, { pr: "https://github.com/example/demo/pull/1" }, { extra: "untrusted" }]) {
    assert.equal(parseCloudReceipt({ ...receipt(), ...patch }), null, JSON.stringify(patch));
  }
  assert.equal(parseCloudReceipt(null), null);
  assert.equal(parseCloudReceipt("invalid"), null);
  getDb().prepare("INSERT INTO events(task_id, at, kind, actor, data_json) VALUES (?, ?, 'cloud_delivery', 'scheduler', '{')").run(id, new Date().toISOString());
  assert.equal(cloudReceipt(id), null);
});

test("local bindings refuse unstamped, stale, wrong-project, wrong-root and wrong-source receipts", () => {
  delivered(); assert.equal(isCloudDeliveryRun(id, runId), false, "no started mapping");
  started(); delivered(receipt(), "executor"); assert.equal(isCloudDeliveryRun(id, runId), false);
  delivered(); assert.equal(isCloudDeliveryRun(id, runId), true);
  for (const patch of [{ generation: 2 }, { sourceBase: hash(6) }, { snapshotCommit: hash(6) }, { tree: hash(6) },
    { source: "publicGithub" }, { project: "other" }, { repoRoot: root }]) {
    started(patch); delivered(); assert.equal(isCloudDeliveryRun(id, runId), false, JSON.stringify(patch));
  }
  started(); delivered();
  saveConfig(parseConfig({ projects: { "paseo-kanban": { defaultWorkspace: "dir", workspacePath: root } } }));
  assert.equal(isCloudDeliveryRun(id, runId), false, "registered root changed");
  saveConfig(parseConfig({ projects: { "paseo-kanban": { defaultWorkspace: "dir", workspacePath: repoRoot } } }));
  assert.equal(isCloudDeliveryRun(id, runId), true);
  getDb().prepare("INSERT INTO runs(task_id, role, started_at) VALUES (?, 'executor', ?)").run(id, new Date().toISOString());
  assert.equal(isCloudDeliveryRun(id, runId), false, "superseded executor run");
});
