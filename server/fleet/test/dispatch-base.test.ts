// The base dispatch matrix ships with the plugin: it is read from the install directory, never from the
// data directory, and a missing file is an error rather than an empty matrix. Temp dirs only.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";

const PLUGIN_DIR = resolve(import.meta.dirname, "..", "..", "..");
const shipped = JSON.parse(readFileSync(join(PLUGIN_DIR, "shared/fleet/default-dispatch.example.json"), "utf8")) as { roles: Record<string, unknown> };
const home = mkdtempSync(join(tmpdir(), "afc-dispatch-base-"));
const dataDir = join(join(home, "data"), "fleet");
const saved = { ...process.env };

let dispatch: typeof import("../dispatch");
before(async () => {
  mkdirSync(dataDir, { recursive: true });
  Object.assign(process.env, { HOME: home, PASEO_HOME: join(home, ".paseo"), KANBAN_PASEO_CONFIG: join(home, ".paseo", "config.json"), KANBAN_DATA_DIR: join(dataDir, ".."),  });
  delete process.env.AFC_HOME;

  dispatch = await import("../dispatch");
});
after(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
  rmSync(home, { recursive: true, force: true });
});

describe("base dispatch matrix", () => {
  test("AFC_DATA_DIR without the file still loads the shipped roles from the install dir (AFC_HOME)", async () => {
    process.env.AFC_HOME = PLUGIN_DIR;
    try {
      assert.equal(dispatch.baseMatrixPath(), join(PLUGIN_DIR, "shared/fleet/default-dispatch.example.json"));
      const matrix = await dispatch.loadBaseMatrix();
      assert.deepEqual(Object.keys(matrix.roles).sort(), Object.keys(shipped.roles).sort());
      assert.ok(Object.keys(matrix.roles).length > 0);
    } finally {
      delete process.env.AFC_HOME;
    }
  });

  test("the running source package wins over another directory in host config", async () => {
    mkdirSync(join(home, ".paseo"), { recursive: true });
    writeFileSync(join(home, ".paseo", "config.json"), JSON.stringify({ plugins: { "agent-fleet-cockpit": { source: "directory", path: join(home, "old-plugin") } } }));
    try {
      assert.equal(dispatch.baseMatrixPath(), join(PLUGIN_DIR, "shared/fleet/default-dispatch.example.json"));
      assert.ok(Object.keys((await dispatch.loadBaseMatrix()).roles).length > 0);
    } finally {
      rmSync(join(home, ".paseo", "config.json"));
    }
  });

  test("ESM knows its package without config; unknown, missing or empty explicit paths still fail", async () => {
    assert.equal(dispatch.baseMatrixPath(), join(PLUGIN_DIR, "shared/fleet/default-dispatch.example.json"));
    await assert.rejects(dispatch.loadBaseMatrix(null), /install directory unknown/);
    await assert.rejects(dispatch.loadBaseMatrix(join(dataDir, "shared/fleet/default-dispatch.example.json")), /unreadable/);
    const empty = join(home, "empty.json");
    writeFileSync(empty, JSON.stringify({ version: 1, defaultTier: "L2", roles: {}, downgradeWhenTight: [] }));
    await assert.rejects(dispatch.loadBaseMatrix(empty), /has no roles/);
  });
});
