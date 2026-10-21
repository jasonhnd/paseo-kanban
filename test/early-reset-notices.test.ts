import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, it } from "node:test";

const root = await mkdtemp(join(tmpdir(), "early-reset-notices-"));
process.env.KANBAN_DATA_DIR = join(root, "data");
process.env.PASEO_HOME = join(root, "paseo");
process.env.KANBAN_PASEO_CONFIG = join(root, "paseo", "config.json");
const { EARLY_RESET_FILE, deliverEarlyResetNotices, setEarlyResetNotify } = await import("../server/fleet/early-reset");
const { kanbanConfigPath } = await import("../server/fleet/paths");
const now = Date.parse("2030-01-02T01:00:00Z");
const afcConfig = join(process.env.KANBAN_DATA_DIR, "fleet", "afc.config.json");
const write = (path: string, value: unknown) => writeFile(path, JSON.stringify(value));
const pending = (at = now) => ({ last: {}, events: [{ pool: "demo", at: new Date(at).toISOString(),
  detectedAt: new Date(at).toISOString(), beforePct: 80, afterPct: 0, beforeResetsAt: "2030-01-05T01:00:00Z",
  afterResetsAt: "2030-01-09T01:00:00Z", couponCount: null, notifiedAt: null }] });
await mkdir(join(process.env.KANBAN_DATA_DIR, "fleet"), { recursive: true });
beforeEach(async () => {
  setEarlyResetNotify(null);
  await write(afcConfig, { opsProject: "Demo operations" });
  await write(EARLY_RESET_FILE, pending());
});
after(async () => { setEarlyResetNotify(null); await rm(root, { recursive: true, force: true }); });

it("names the unregistered AFC project despite a board supervisor and deduplicates the same missing registration", async t => {
  const logs: string[] = [], sent: string[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { logs.push(args.join(" ")); });
  setEarlyResetNotify(async id => { sent.push(id); });
  await write(kanbanConfigPath(), { supervisorAgentId: "board-leader", supervisors: { elsewhere: "other-leader" } });
  for (let round = 0; round < 3; round++) assert.equal(await deliverEarlyResetNotices(now + round * 120_000), 0);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /AFC project "Demo operations" has no registered leader/);
  assert.match(logs[0], /kanban\.config\.json.*supervisors/);
  assert.doesNotMatch(logs[0], /no Kanban leader|no AFC <leader>/);
  await write(afcConfig, { opsProject: "DEMO OPERATIONS" });
  await deliverEarlyResetNotices(now);
  assert.equal(logs.length, 1, "case-only changes are the same missing registration");
  await write(afcConfig, { opsProject: "Different operations" });
  await deliverEarlyResetNotices(now);
  assert.equal(logs.length, 2);
  assert.deepEqual(sent, []);
  assert.equal(JSON.parse(await readFile(EARLY_RESET_FILE, "utf8")).events[0].notifiedAt, null);
});

it("case-insensitive registration recovers, retries failed delivery and warns again only after a new missing state", async t => {
  const logs: string[] = [], sent: string[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { logs.push(args.join(" ")); });
  let fail = true;
  setEarlyResetNotify(async id => { if (fail) throw new Error("demo send failure"); sent.push(id); });
  await write(kanbanConfigPath(), { supervisorAgentId: "board-leader", supervisors: {} });
  assert.equal(await deliverEarlyResetNotices(now), 0);
  await write(kanbanConfigPath(), { supervisorAgentId: "board-leader", supervisors: { "DEMO OPERATIONS": "operations-leader" } });
  assert.equal(await deliverEarlyResetNotices(now), 0);
  assert.equal(JSON.parse(await readFile(EARLY_RESET_FILE, "utf8")).events[0].notifiedAt, null);
  fail = false;
  assert.equal(await deliverEarlyResetNotices(now), 1);
  assert.equal(await deliverEarlyResetNotices(now), 0);
  assert.deepEqual(sent, ["operations-leader"]);
  assert.equal(JSON.parse(await readFile(EARLY_RESET_FILE, "utf8")).events[0].notifiedAt, new Date(now).toISOString());
  await write(EARLY_RESET_FILE, pending());
  await write(kanbanConfigPath(), { supervisorAgentId: "board-leader", supervisors: {} });
  await deliverEarlyResetNotices(now);
  await deliverEarlyResetNotices(now + 120_000);
  assert.equal(logs.filter(line => line.includes("has no registered leader")).length, 2);
});

it("expired notices do not send or emit missing-registration warnings", async t => {
  const logs: string[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { logs.push(args.join(" ")); });
  await write(EARLY_RESET_FILE, pending(now - 8 * 24 * 60 * 60_000));
  await write(kanbanConfigPath(), { supervisorAgentId: "board-leader", supervisors: {} });
  setEarlyResetNotify(async () => { assert.fail("expired notice must not send"); });
  assert.equal(await deliverEarlyResetNotices(now), 0);
  assert.deepEqual(logs, []);
});
