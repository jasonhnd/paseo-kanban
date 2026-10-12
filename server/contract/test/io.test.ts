import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import {
  classifyFreshness,
  envelopeFor,
  onceLogger,
  parseContract,
  readContractFile,
  readExport,
  STALE_FACTOR,
  writeContractFile,
  writeExport,
} from "../io";
import { exportPath } from "../paths";
import { EXPORTS, type ExportKind } from "../../../shared/contract/schema";
import { INVALID, NOW, VALID } from "./fixtures";

const KINDS = Object.keys(EXPORTS) as ExportKind[];
let root: string;
let env: Record<string, string>;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "fleet-contract-"));
  env = { KANBAN_DATA_DIR: join(root, "kanban") };
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

function secondsAfter(seconds: number): Date {
  return new Date(NOW.getTime() + seconds * 1000);
}

describe("freshness", () => {
  const envelope = { generatedAt: NOW.toISOString(), ttlSeconds: 100 };

  test("fresh up to and including ttl * 3, stale after", () => {
    assert.equal(STALE_FACTOR, 3);
    assert.equal(classifyFreshness(envelope, secondsAfter(0)), "fresh");
    assert.equal(classifyFreshness(envelope, secondsAfter(150)), "fresh");
    assert.equal(classifyFreshness(envelope, secondsAfter(300)), "fresh");
    assert.equal(classifyFreshness(envelope, secondsAfter(301)), "stale");
  });

  test("a timestamp in the future counts as fresh", () => {
    assert.equal(classifyFreshness(envelope, secondsAfter(-3600)), "fresh");
  });
});

describe("parseContract states", () => {
  const schema = EXPORTS.poolStatus.schema;
  const text = JSON.stringify(VALID.poolStatus);

  test("fresh returns the parsed value and its age", () => {
    const result = parseContract(text, schema, secondsAfter(60));
    assert.equal(result.state, "fresh");
    assert.ok(result.state === "fresh" && result.ageSeconds === 60 && result.value.pools["demo-pool-a"].prefer);
  });

  test("stale still returns the value", () => {
    const result = parseContract(text, schema, secondsAfter(900 * 3 + 1));
    assert.equal(result.state, "stale");
    assert.ok(result.state === "stale" && result.value.priority?.mode === "user");
  });

  test("bad JSON is invalid", () => {
    const result = parseContract("{not json", schema, NOW);
    assert.equal(result.state, "invalid");
    assert.match(result.state === "invalid" ? result.reason : "", /bad JSON/);
  });

  test("another schema version is invalid", () => {
    const result = parseContract(JSON.stringify({ ...VALID.poolStatus, schema: "fleet-quota/v2" }), schema, NOW);
    assert.equal(result.state, "invalid");
    assert.match(result.state === "invalid" ? result.reason : "", /fleet-quota\/v2/);
  });

  test("a non-object document is invalid", () => {
    assert.equal(parseContract("[]", schema, NOW).state, "invalid");
    assert.equal(parseContract("null", schema, NOW).state, "invalid");
  });

  for (const kind of KINDS) {
    test(`${kind}: payload error is invalid (${INVALID[kind].label})`, () => {
      const result = parseContract(JSON.stringify(INVALID[kind].value), EXPORTS[kind].schema, NOW);
      assert.equal(result.state, "invalid");
    });
  }
});

describe("reading files", () => {
  test("a missing file is absent and is not reported", async () => {
    const reports: string[] = [];
    const result = await readContractFile(join(root, "nope", "pool-status.json"), EXPORTS.poolStatus.schema, {
      onInvalid: (_file, reason) => reports.push(reason),
    });
    assert.deepEqual(result, { state: "absent" });
    assert.deepEqual(reports, []);
  });

  test("an invalid file is reported through onInvalid", async () => {
    const file = join(root, "broken.json");
    await writeFile(file, "{", "utf8");
    const reports: string[] = [];
    const result = await readContractFile(file, EXPORTS.cockpit.schema, {
      onInvalid: (reportedFile, reason) => reports.push(`${reportedFile}: ${reason}`),
    });
    assert.equal(result.state, "invalid");
    assert.equal(reports.length, 1);
    assert.ok(reports[0].startsWith(file));
  });

  test("a directory in place of the file is invalid, not a crash", async () => {
    const file = join(root, "dir-instead.json");
    await mkdir(file);
    const result = await readContractFile(file, EXPORTS.cockpit.schema);
    assert.equal(result.state, "invalid");
  });

  test("onceLogger reports each problem once", () => {
    const lines: string[] = [];
    const report = onceLogger((line) => lines.push(line));
    report("/demo/a.json", "bad JSON");
    report("/demo/a.json", "bad JSON");
    report("/demo/a.json", "other");
    report("/demo/b.json", "bad JSON");
    assert.equal(lines.length, 3);
    assert.match(lines[0], /fleet-quota: ignoring invalid \/demo\/a\.json: bad JSON/);
  });
});

describe("writing files", () => {
  for (const kind of KINDS) {
    test(`${kind}: round-trips through its producer's exports directory`, async () => {
      await writeExport(kind, VALID[kind], { env });
      const result = await readExport(kind, { env, now: NOW });
      assert.equal(result.state, "fresh");
      assert.deepEqual(result.state === "fresh" ? result.value : null, VALID[kind]);
    });
  }

  test("writes land in the overridden data directories", async () => {
    assert.equal(exportPath("boardSummary", env), join(root, "kanban", "exports", "board-summary.json"));
    const files = await readdir(join(root, "kanban", "exports", "fleet"));
    assert.deepEqual(files.sort(), ["cockpit.json", "decisions-open.json", "decisions.json", "dispatch-matrix.json", "paused-projects.json", "pool-status.json"]);
  });

  test("an invalid value throws and leaves the previous file untouched", async () => {
    const file = exportPath("cockpit", env);
    const before = await readFile(file, "utf8");
    await assert.rejects(writeExport("cockpit", INVALID.cockpit.value as never, { env }));
    assert.equal(await readFile(file, "utf8"), before);
    const leftovers = (await readdir(join(root, "kanban", "exports", "fleet"))).filter((name) => name.endsWith(".tmp"));
    assert.deepEqual(leftovers, []);
  });

  test("a failed rename removes the temp file and keeps the old content", async () => {
    const dir = join(root, "rename-fail");
    const file = join(dir, "cockpit.json");
    await writeContractFile(file, EXPORTS.cockpit.schema, VALID.cockpit);
    const before = await readFile(file, "utf8");
    await mkdir(join(dir, "target-is-dir.json"));
    await assert.rejects(writeContractFile(join(dir, "target-is-dir.json"), EXPORTS.cockpit.schema, VALID.cockpit));
    assert.deepEqual((await readdir(dir)).filter((name) => name.endsWith(".tmp")), []);
    assert.equal(await readFile(file, "utf8"), before);
  });

  test("concurrent writers never leave a torn file", async () => {
    const file = join(root, "race", "pool-status.json");
    const writes = Array.from({ length: 20 }, (_, index) =>
      writeContractFile(file, EXPORTS.poolStatus.schema, { ...VALID.poolStatus, producerVersion: `0.0.${index}` }),
    );
    const reads = Array.from({ length: 20 }, () => readContractFile(file, EXPORTS.poolStatus.schema, { now: NOW }));
    await Promise.all(writes);
    for (const result of await Promise.all(reads)) assert.notEqual(result.state, "invalid");
    const final = await readContractFile(file, EXPORTS.poolStatus.schema, { now: NOW });
    assert.equal(final.state, "fresh");
    assert.deepEqual((await readdir(join(root, "race"))).filter((name) => name.endsWith(".tmp")), []);
  });

  test("an unwritable directory rejects without leaving a temp file", { skip: process.getuid?.() === 0 }, async () => {
    const dir = join(root, "locked");
    await mkdir(dir);
    await chmod(dir, 0o500);
    try {
      await assert.rejects(writeContractFile(join(dir, "cockpit.json"), EXPORTS.cockpit.schema, VALID.cockpit));
    } finally {
      await chmod(dir, 0o700);
    }
    assert.deepEqual(await readdir(dir), []);
  });

  test("envelopeFor fills the default TTL and producer", () => {
    const envelope = envelopeFor("boardSummary", "1.2.3", NOW);
    assert.deepEqual(envelope, {
      schema: "fleet-quota/v1",
      contractVersion: "1.3.0",
      producer: "paseo-kanban",
      producerVersion: "1.2.3",
      generatedAt: NOW.toISOString(),
      ttlSeconds: 900,
    });
  });
});
