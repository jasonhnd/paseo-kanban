/// <reference types="node" />
import { zhCNPart, localePattern, complexDocsProfileName } from "./helpers/locale";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it, mock } from "node:test";
import { runKanban } from "../server/cli";
import { loadConfig } from "../server/config";
import { configPath } from "../server/config-file";
import { closeDb, getDb } from "../server/db";
import { formatResult } from "../server/tools";
import { policySnapshotPath } from "../server/application/policy-snapshot";
import { publishAnonymousPolicy } from "./helpers/anonymous-policy";

// TEST_0287: an explicit --profile in another pool than the matrix's first pick gets a hint, never a refusal.
const dir = mkdtempSync(join(tmpdir(), "profile-hint-"));
process.env.KANBAN_DATA_DIR = dir;
const poolFile = join(dir, "pool-status.json");
process.env.KANBAN_POOL_STATUS = poolFile;
const work = join(dir, "work");
mkdirSync(work, { recursive: true });
const paseoConfig = join(dir, "paseo-config.json");
const matrixFile = join(dir, "dispatch-matrix.json");
process.env.KANBAN_PASEO_CONFIG = paseoConfig;
process.env.KANBAN_DISPATCH_MATRIX = matrixFile;

const PROFILES = [
  { id: "codex", name: "Executor · GPT", role: "executor", family: "openai", provider: "codex", model: "gpt-6-astra", pool: "codex-pro", thinkingOptionId: "medium" },
  { id: "sonnet", name: "Executor · SonnetSample textClaudeSample text", role: "candidate", candidateFor: "executor", family: "anthropic", provider: "claude", model: "claude-sonnet-5-5", pool: "claude-max", thinkingOptionId: "medium" },
  { id: "opus", name: complexDocsProfileName, role: "candidate", candidateFor: "executor", family: "anthropic", provider: "claude", model: "claude-opus-5-5", pool: "claude-max", thinkingOptionId: "high" },
  { id: "grok", name: "Executor · Grok", role: "candidate", candidateFor: "executor", family: "xai", provider: "grok", model: "grok-4.7", pool: "supergrok", thinkingOptionId: "high" },
  { id: "rev-x", name: "Reviewer · Grok", role: "reviewer", family: "xai", provider: "grok", model: "grok-4.7", pool: "supergrok", thinkingOptionId: "high" },
  { id: "rev-a", name: "Reviewer · Sonnet", role: "candidate", candidateFor: "reviewer", family: "anthropic", provider: "claude", model: "claude-sonnet-5-5", pool: "claude-max", thinkingOptionId: "high" },
];

const item = (profile: string, effort: string) => ({ profile, effort });
const reviewersBy = (name: string) => ({ L1: [item(name, "low")], L2: [item(name, "medium")], L3: [item(name, "high")], L4: [item(name, "xhigh")] });
const MATRIX = {
  version: 1,
  generatedAt: "2026-10-07T00:00:00.000Z",
  defaultTier: "L2",
  downgradeWhenTight: ["L1", "L2"],
  roles: {
    executor: {
      L2: [item("Executor · SonnetSample textClaudeSample text", "medium"), item("Executor · Grok", "medium")],
      L3: [item(complexDocsProfileName, "high"), item("Executor · Grok", "high")],
    },
    reviewer: { byExecutorFamily: { anthropic: reviewersBy("Reviewer · Grok"), xai: reviewersBy("Reviewer · Sonnet") } },
  },
};

interface Created {
  id: number;
  warnings?: string[];
  profileHint?: { profile: string; pool: string | null; suggested: string; suggestedPool: string | null; role: string; tier: string; message: string };
}

async function create(title: string, extra: string[]): Promise<Created> {
  if (existsSync(matrixFile)) {
    const pools = existsSync(poolFile) ? JSON.parse(readFileSync(poolFile, "utf8")).pools : {};
    const defaults = Object.fromEntries(PROFILES.map(profile => [profile.pool, {}]));
    publishAnonymousPolicy(JSON.parse(readFileSync(matrixFile, "utf8")), { ...defaults, ...pools });
  } else rmSync(policySnapshotPath(), { force: true });
  return (await runKanban(["create", "--project", "hint", "--title", title, "--role", "executor", "--workspace", work, ...extra, "--json"], {})) as Created;
}

function hintEvents(id: number): Array<Record<string, unknown>> {
  const rows = getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'profile_priority_hint'").all(id) as Array<{ data_json: string }>;
  return rows.map((row) => JSON.parse(row.data_json) as Record<string, unknown>);
}

before(async () => {
  writeFileSync(paseoConfig, JSON.stringify({ daemon: { agentProfiles: PROFILES } }));
  writeFileSync(matrixFile, JSON.stringify(MATRIX));
  await runKanban(["project", "--project", "hint", "--code", "HNT"], {});
});

after(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe("profile priority hint at create", () => {
  it("skips a full first pool, but hints again when that pool has capacity", async () => {
    const settings = loadConfig();
    writeFileSync(configPath(), JSON.stringify({ ...settings, concurrency: { ...settings.concurrency, pools: { ...settings.concurrency.pools, "claude-max": 1 } } }));
    const running = await create((zhCNPart("cardParts.event.laneBound", 0, 2) + "Demo text"), ["--profile", "Executor · SonnetSample textClaudeSample text", "--tier", "L2"]);
    const db = getDb();
    db.prepare("UPDATE tasks SET status = 'running' WHERE id = ?").run(running.id);
    db.prepare("INSERT INTO runs (task_id, role, profile_name, started_at) VALUES (?, 'executor', ?, ?)").run(running.id, "Executor · SonnetSample textClaudeSample text", new Date().toISOString());
    try {
      const full = await create("First pool full; choose second", ["--profile", "Executor · Grok", "--tier", "L2"]);
      assert.equal(full.profileHint, undefined);
      assert.equal(full.warnings, undefined);
      assert.deepEqual(hintEvents(full.id), []);

      db.prepare("UPDATE tasks SET status = 'ready' WHERE id = ?").run(running.id);
      const available = await create("First pool free; choose second", ["--profile", "Executor · Grok", "--tier", "L2"]);
      assert.equal(available.profileHint?.suggested, "Executor · SonnetSample textClaudeSample text");
      assert.ok(available.warnings?.includes(available.profileHint!.message));
      assert.equal(hintEvents(available.id).length, 1);
    } finally {
      db.prepare("UPDATE tasks SET status = 'ready' WHERE id = ?").run(running.id);
      writeFileSync(configPath(), JSON.stringify(settings));
    }
  });

  it("still creates and falls back to the original hint when reading occupancy fails", async () => {
    const db = getDb();
    const prepare = db.prepare.bind(db);
    const stub = mock.method(db, "prepare", (sql: string) => {
      if (sql.includes("SELECT t.workspace_path, t.workspace_kind, t.status")) throw new Error("occupancy unavailable");
      return prepare(sql);
    });
    let created: Created;
    try {
      created = await create((zhCNPart("cardParts.event.laneBound", 0, 2) + zhCNPart("cardDrawer.load.failed", 0, 4)), ["--profile", "Executor · Grok", "--tier", "L2"]);
    } finally {
      stub.mock.restore();
    }
    assert.ok(created.id > 0);
    assert.equal(created.profileHint?.suggested, "Executor · SonnetSample textClaudeSample text");
    assert.equal(hintEvents(created.id).length, 1);
  });

  it("hints when the pinned pool differs from the matrix's first dispatchable pick, and still creates the card", async () => {
    const created = await create((zhCNPart("compat.source.cwdOk", 0, 3) + "Grok"), ["--profile", "Executor · Grok", "--tier", "L2"]);
    const expected = (zhCNPart("routing.priorityHint", 0, 7) + "Executor · Grok" + zhCNPart("missingCwd.none", 0, 1) + "supergrok" + zhCNPart("routing.priorityHint", 23, 33) + "Executor · SonnetSample textClaudeSample text" + zhCNPart("missingCwd.none", 0, 1) + "claude-max" + zhCNPart("routing.priorityHint", 60, 77));
    assert.equal(created.profileHint?.message, expected);
    assert.ok(created.warnings?.includes(expected));
    assert.match(formatResult(created), new RegExp(`${zhCNPart("boardView.default.note", 0, 3)}${expected.replace(new RegExp("[()" + localePattern(zhCNPart("missingCwd.none", 0, 1)) + localePattern(zhCNPart("missingCwd.none", 3, 4)) + "·]", "g"), ".")}`));
    const row = getDb().prepare("SELECT status, profile_override FROM tasks WHERE id = ?").get(created.id) as { status: string; profile_override: string };
    assert.equal(row.status, "ready");
    assert.equal(row.profile_override, "Executor · Grok");
    assert.deepEqual(hintEvents(created.id), [
      { profile: "Executor · Grok", pool: "supergrok", suggested: "Executor · SonnetSample textClaudeSample text", suggestedPool: "claude-max", role: "executor", tier: "L2", reason: expected },
    ]);
  });

  it("does not hint when the pinned profile shares the first pick's pool", async () => {
    const created = await create((zhCNPart("compat.source.cwdOk", 0, 3) + "Opus"), ["--profile", complexDocsProfileName, "--tier", "L2"]);
    assert.equal(created.profileHint, undefined);
    assert.equal(created.warnings, undefined);
    assert.deepEqual(hintEvents(created.id), []);
  });

  it("does not hint without --profile", async () => {
    const created = await create("Unspecified", ["--tier", "L3"]);
    assert.equal(created.profileHint, undefined);
    assert.deepEqual(hintEvents(created.id), []);
  });

  it("ranks the suggestion the same way routing does: matrix order while priority is in force, prefer first after it expires", async () => {
    const l3 = { ...MATRIX.roles.executor, L3: [item("Executor · Grok", "high"), item(complexDocsProfileName, "high")] };
    const withPriority = (until: string) => ({ ...MATRIX, priority: { order: ["supergrok", "claude-max"], until }, roles: { ...MATRIX.roles, executor: l3 } });
    writeFileSync(poolFile, JSON.stringify({ generatedAt: new Date().toISOString(), pools: { "claude-max": { prefer: true }, supergrok: {} } }));
    try {
      writeFileSync(matrixFile, JSON.stringify(withPriority(new Date(Date.now() + 86_400_000).toISOString())));
      const active = await create(("priority " + zhCNPart("server.tierSet", 17, 19)), ["--profile", complexDocsProfileName, "--tier", "L3"]);
      assert.equal(active.profileHint?.suggested, "Executor · Grok");
      assert.equal(active.profileHint?.suggestedPool, "supergrok");
      assert.equal(hintEvents(active.id).length, 1);

      writeFileSync(matrixFile, JSON.stringify(withPriority(new Date(Date.now() - 86_400_000).toISOString())));
      const expired = await create(("priority " + zhCNPart("doctor.matrix.stale", 4, 6)), ["--profile", complexDocsProfileName, "--tier", "L3"]);
      assert.equal(expired.profileHint, undefined);
      assert.deepEqual(hintEvents(expired.id), []);
    } finally {
      rmSync(poolFile, { force: true });
      writeFileSync(matrixFile, JSON.stringify(MATRIX));
    }
  });

  it("creates the card without a hint when the matrix file is missing", async () => {
    rmSync(matrixFile, { force: true });
    try {
      const created = await create((zhCNPart("matrix.missingRoles", 2, 5) + zhCNPart("compat.run.failed", 0, 1)), ["--profile", "Executor · Grok", "--tier", "L2"]);
      assert.ok(created.id > 0);
      assert.equal(created.profileHint, undefined);
      assert.equal(created.warnings, undefined);
      assert.deepEqual(hintEvents(created.id), []);
    } finally {
      writeFileSync(matrixFile, JSON.stringify(MATRIX));
    }
  });
});
