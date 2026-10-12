import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { sampleQuota } from "../quota-sampling";
import { QUOTA_SAMPLE_MS } from "../quota-timing";

const root = await mkdtemp(join(tmpdir(), "quota-sampling-"));
after(() => rm(root, { recursive: true, force: true }));
const now = Date.parse("2030-01-01T00:13:20Z");

test("all five AFC read paths have one fixed hourly slot despite concurrent panel/heartbeat requests", async () => {
  const statePath = join(root, "hourly.json");
  const calls = new Map<string, number>();
  const sources = ["paseo", "grok-screen", "cursor", "antigravity", "codex-coupons"];
  const visit = (at: number) => Promise.all(sources.flatMap(source => Array.from({ length: 4 }, () => sampleQuota(source, async () => {
    calls.set(source, (calls.get(source) ?? 0) + 1);
    return { observed: at };
  }, { now: at, statePath }))));
  await visit(now);
  for (let minute = 1; minute < 60; minute++) await visit(now + minute * 60_000);
  assert.deepEqual([...calls.values()], [1, 1, 1, 1, 1]);
  await visit(now + QUOTA_SAMPLE_MS);
  assert.deepEqual([...calls.values()], [2, 2, 2, 2, 2]);
  // Returning early within an hour or changing a plan does not move the anchor.
  await visit(now + QUOTA_SAMPLE_MS + 1000);
  assert.deepEqual([...calls.values()], [2, 2, 2, 2, 2]);
  const file = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(file.anchor, now);
});

test("failure retains original data/time, consumes its slot, and downtime skips missed slots", async () => {
  const statePath = join(root, "failure.json");
  let calls = 0;
  const read = async () => { if (++calls === 2) throw new Error("rate_limit"); return calls; };
  const first = await sampleQuota("paseo", read, { now, statePath });
  const failed = await sampleQuota("paseo", read, { now: now + QUOTA_SAMPLE_MS, statePath });
  assert.equal(failed.value, 1);
  assert.equal(failed.collectedAt, first.collectedAt);
  assert.match(failed.error!, /rate_limit/);
  for (let minute = 1; minute < 60; minute++) {
    const cached = await sampleQuota("paseo", read, { now: now + QUOTA_SAMPLE_MS + minute * 60_000, statePath });
    assert.equal(cached.attemptedAt, failed.attemptedAt);
    assert.equal(cached.error, failed.error);
  }
  assert.equal(calls, 2);
  await sampleQuota("paseo", read, { now: now + QUOTA_SAMPLE_MS * 7 + 500, statePath });
  assert.equal(calls, 3);
  await sampleQuota("paseo", read, { now: now + QUOTA_SAMPLE_MS * 8, statePath });
  assert.equal(calls, 4);
  await sampleQuota("paseo", read, { now: now - 1, statePath });
  assert.equal(calls, 4);
});

function child(statePath: string, at: number): Promise<void> {
  const url = new URL("../quota-sampling.ts", import.meta.url).href;
  const code = `import { sampleQuota } from ${JSON.stringify(url)};
    import { appendFile } from 'node:fs/promises';
    await sampleQuota('paseo', async () => { await appendFile(process.env.SAMPLE_COUNT, 'read\\n'); await new Promise(r => setTimeout(r, 100)); return 42; },
      { statePath: process.env.SAMPLE_STATE, now: Number(process.env.SAMPLE_TIME) });`;
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
      env: { ...process.env, SAMPLE_COUNT: join(root, "count.txt"), SAMPLE_STATE: statePath, SAMPLE_TIME: String(at) },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    proc.stderr.on("data", data => { stderr += String(data); });
    proc.on("error", reject);
    proc.on("exit", code => code === 0 ? resolve() : reject(new Error(`child exit ${code}: ${stderr}`)));
  });
}

test("same-host independent processes and restarts cannot duplicate a reserved slot", async () => {
  const statePath = join(root, "processes.json");
  await writeFile(join(root, "count.txt"), "");
  await Promise.all(Array.from({ length: 4 }, () => child(statePath, now)));
  await child(statePath, now + 30 * 60_000);
  assert.equal((await readFile(join(root, "count.txt"), "utf8")).trim().split("\n").length, 1);
  await Promise.all([child(statePath, now + 3 * QUOTA_SAMPLE_MS), child(statePath, now + 3 * QUOTA_SAMPLE_MS)]);
  assert.equal((await readFile(join(root, "count.txt"), "utf8")).trim().split("\n").length, 2);
});

test("an interrupted claim is not retried until the next slot; malformed state fails closed", async () => {
  const statePath = join(root, "crash.json");
  let calls = 0;
  await writeFile(statePath, JSON.stringify({ version: 1, anchor: now, sources: { paseo: {
    slot: 0, claim: "interrupted", attemptedAt: new Date(now).toISOString(), collectedAt: null, value: null, error: "Quota sample pending or interrupted",
  } } }));
  const read = async () => ++calls;
  assert.equal((await sampleQuota("paseo", read, { now: now + 1000, statePath })).value, null);
  assert.equal(calls, 0);
  await sampleQuota("paseo", read, { now: now + QUOTA_SAMPLE_MS, statePath });
  assert.equal(calls, 1);
  await writeFile(statePath, "bad schedule");
  await assert.rejects(sampleQuota("paseo", read, { now: now + 2 * QUOTA_SAMPLE_MS, statePath }));
  assert.equal(calls, 1);
  await appendFile(`${statePath}.lock`, "abandoned");
  await assert.rejects(sampleQuota("paseo", read, { now, statePath }), /lock/);
});
