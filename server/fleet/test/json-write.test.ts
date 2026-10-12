import assert from "node:assert/strict";
import { fork } from "node:child_process";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { readJson, writeJson } from "../util";

const roots: string[] = [];
async function fresh() {
  const dir = await fs.mkdtemp(join(tmpdir(), "json-write-"));
  roots.push(dir);
  return dir;
}
after(async () => { for (const dir of roots) await fs.rm(dir, { recursive: true, force: true }); });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const payload = (label: string) => ({ label, payload: label.repeat(32_768) });

test("single writes preserve JSON formatting, fallback reads and overwrite behavior", async () => {
  const dir = await fresh();
  const file = join(dir, "nested", "snapshot.json");
  assert.deepEqual(await readJson(file, { absent: true }), { absent: true });
  await writeJson(file, payload("first"));
  assert.equal(await fs.readFile(file, "utf8"), JSON.stringify(payload("first"), null, 2));
  await writeJson(file, payload("second"));
  assert.deepEqual(await readJson(file, null), payload("second"));
  assert.deepEqual(await fs.readdir(join(dir, "nested")), ["snapshot.json"]);
});

test("same-process writers each commit their own complete payload at a controlled rename boundary", { timeout: 15_000 }, async (t) => {
  const dir = await fresh();
  const file = join(dir, "pool-status.json");
  const ready = [deferred<string>(), deferred<string>()];
  const release = [deferred<void>(), deferred<void>()];
  const rename = fs.rename;
  let index = 0;
  t.mock.method(fs, "rename", async (from: string, to: string) => {
    if (to === file) {
      const i = index++;
      ready[i].resolve(from);
      await release[i].promise;
    }
    await rename(from, to);
  });
  syncBuiltinESMExports();
  const a = writeJson(file, payload("A"));
  await ready[0].promise;
  const b = writeJson(file, payload("B"));
  await ready[1].promise;
  try {
    release[0].resolve();
    await a;
    assert.deepEqual(await readJson(file, null), payload("A"));
    release[1].resolve();
    await b;
    assert.deepEqual(await readJson(file, null), payload("B"));
    assert.deepEqual(await fs.readdir(dir), ["pool-status.json"]);
  } finally {
    release.forEach((gate) => gate.resolve());
    await Promise.allSettled([a, b]);
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test("separate processes sharing a target cannot consume each other's temporary file", { timeout: 20_000 }, async (t) => {
  const dir = await fresh();
  const file = join(dir, "pool-status.json");
  function writer(label: string) {
    const ready = deferred<string>();
    const done = deferred<{ ok: boolean; code?: string }>();
    const child = fork(fileURLToPath(new URL("./fixtures/json-writer.ts", import.meta.url)), [file, label], {
      execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "inherit", "ipc"],
    });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    child.on("message", (message: unknown) => {
      const row = message as { phase: string; temp: string; ok: boolean; code?: string };
      if (row.phase === "ready") ready.resolve(row.temp);
      if (row.phase === "done") done.resolve(row);
    });
    const exit = new Promise<number | null>((resolve) => child.once("exit", resolve));
    return { child, ready: ready.promise, done: done.promise, exit };
  }
  const a = writer("A");
  await a.ready;
  const b = writer("B");
  await b.ready;
  a.child.send("commit");
  assert.equal((await a.done).ok, true);
  assert.deepEqual(await readJson(file, null), payload("A"));
  b.child.send("commit");
  assert.equal((await b.done).ok, true);
  assert.deepEqual(await readJson(file, null), payload("B"));
  assert.deepEqual(await Promise.all([a.exit, b.exit]), [0, 0]);
  assert.deepEqual(await fs.readdir(dir), ["pool-status.json"]);
});

test("many writers and a concurrent reader observe only complete committed JSON", async () => {
  const dir = await fresh();
  const file = join(dir, "snapshot.json");
  await writeJson(file, payload("seed"));
  let reading = true;
  let observations = 0;
  const reader = (async () => {
    while (reading) {
      const row = JSON.parse(await fs.readFile(file, "utf8")) as ReturnType<typeof payload>;
      assert.deepEqual(row, payload(row.label));
      observations++;
    }
  })();
  try {
    await Promise.all(Array.from({ length: 32 }, (_, i) => writeJson(file, payload(String(i)))));
  } finally { reading = false; await reader; }
  assert.ok(observations > 0);
  const row = await readJson<ReturnType<typeof payload>>(file, payload("missing"));
  assert.deepEqual(row, payload(row.label));
  assert.deepEqual(await fs.readdir(dir), ["snapshot.json"]);
});

test("real mkdir and rename failures reject and preserve unrelated temporary files", async () => {
  const dir = await fresh();
  const blocker = join(dir, "blocker");
  await fs.writeFile(blocker, "not a directory");
  await assert.rejects(writeJson(join(blocker, "snapshot.json"), {}), { code: "EEXIST" });
  const target = join(dir, "target.json");
  await fs.mkdir(target);
  const other = join(dir, ".other-writer.tmp");
  await fs.writeFile(other, "owned elsewhere");
  await assert.rejects(writeJson(target, {}), (error: NodeJS.ErrnoException) => ["EISDIR", "EPERM", "ENOTEMPTY"].includes(error.code ?? ""));
  assert.equal(await fs.readFile(other, "utf8"), "owned elsewhere");
  assert.deepEqual((await fs.readdir(dir)).sort(), [".other-writer.tmp", "blocker", "target.json"]);
});

test("an exclusive-open collision rejects without deleting the other owner's file", async (t) => {
  const dir = await fresh();
  const file = join(dir, "snapshot.json");
  const open = fs.open;
  let occupied = "";
  t.mock.method(fs, "open", async (path: string, flags: string) => {
    occupied = path;
    await fs.writeFile(path, "owned elsewhere", { flag: "wx" });
    return open(path, flags);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(writeJson(file, {}), { code: "EEXIST" });
    assert.equal(await fs.readFile(occupied, "utf8"), "owned elsewhere");
    await assert.rejects(fs.stat(file), { code: "ENOENT" });
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test("a partial write failure rejects with the original error and cleans only its own temp", async (t) => {
  const dir = await fresh();
  const file = join(dir, "snapshot.json");
  await writeJson(file, { previous: true });
  const other = join(dir, ".other-writer.tmp");
  await fs.writeFile(other, "owned elsewhere");
  const failure = Object.assign(new Error("disk full"), { code: "ENOSPC" });
  const open = fs.open;
  t.mock.method(fs, "open", async (path: string, flags: string) => {
    const handle = await open(path, flags);
    const write = handle.writeFile.bind(handle);
    t.mock.method(handle, "writeFile", async () => { await write("partial"); throw failure; });
    return handle;
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(writeJson(file, {}), (error) => error === failure);
    assert.deepEqual(await readJson(file, null), { previous: true });
    assert.equal(await fs.readFile(other, "utf8"), "owned elsewhere");
    assert.deepEqual((await fs.readdir(dir)).sort(), [".other-writer.tmp", "snapshot.json"]);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test("a cleanup failure is logged without masking the failed write", async (t) => {
  const dir = await fresh();
  const file = join(dir, "snapshot.json");
  await fs.mkdir(file);
  const logs: unknown[][] = [];
  t.mock.method(fs, "rm", async () => { throw Object.assign(new Error("cleanup denied"), { code: "EACCES" }); });
  t.mock.method(console, "error", (...args: unknown[]) => { logs.push(args); });
  syncBuiltinESMExports();
  try {
    await assert.rejects(writeJson(file, {}), (error: NodeJS.ErrnoException) => ["EISDIR", "EPERM", "ENOTEMPTY"].includes(error.code ?? ""));
    assert.equal(logs.length, 1);
    assert.match(String(logs[0]), /JSON temp cleanup.*cleanup denied/);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});
