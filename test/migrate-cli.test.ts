/// <reference types="node" />
// `paseo-kanban migrate` through bin/paseo-kanban.mjs, with a fake `paseo` command on PATH.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, describe, it } from "node:test";
import { closeDb } from "../server/db";
import { KanbanError } from "../server/errors";
import type { MigrationRecord } from "../server/doctor-migration";
import { formatStamp, paseoPluginControl, runMigrateCli, type MigrateResult } from "../server/migrate";
import { countRows, migrateFixture, tree } from "./helpers/migrate-fixture";
import { lsofFixture } from "./helpers/lsof-fixture";

const root = realpathSync(mkdtempSync(join(tmpdir(), "migrate-cli-")));
process.env.KANBAN_DATA_DIR = join(root, "unused-board");
after(() => {
  closeDb();
  rmSync(root, { recursive: true, force: true });
});

const BIN = join(import.meta.dirname, "..", "bin", "paseo-kanban.mjs");

/** A `paseo` that logs its arguments and fails the action named in PASEO_FAKE_FAIL. */
function fakePaseo(): { dir: string; log: string; command: string } {
  const dir = join(root, `fake-bin-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir);
  const log = join(dir, "calls.log");
  const command = join(dir, "paseo");
  writeFileSync(command, [
    "#!/bin/sh",
    "echo \"$*\" >> \"$PASEO_FAKE_LOG\"",
    "if [ -n \"$PASEO_FAKE_FAIL\" ] && [ \"$2\" = \"$PASEO_FAKE_FAIL\" ]; then echo \"daemon not reachable\" >&2; exit 1; fi",
    "exit 0",
    "",
  ].join("\n"));
  chmodSync(command, 0o755);
  return { dir, log, command };
}

function calls(log: string): string[] {
  return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
}

function cli(args: string[], env: NodeJS.ProcessEnv): { status: number | null; stdout: string; stderr: string } {
  const out = spawnSync(process.execPath, [BIN, "migrate", ...args], { encoding: "utf8", env: { ...process.env, ...env }, timeout: 60_000 });
  return { status: out.status, stdout: out.stdout, stderr: out.stderr };
}

/**
 * Environment for a CLI run. Inside tests the data-path guard treats $PASEO_HOME/plugin-data as live
 * data, so PASEO_HOME points at a separate demo home and the target is always given with --to.
 */
function cliEnv(fake: { dir: string; log: string }, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { PATH: `${fake.dir}${delimiter}${process.env.PATH}`, PASEO_FAKE_LOG: fake.log, PASEO_HOME: join(root, "demo-paseo-home"), KANBAN_DATA_DIR: join(root, "unused-board"), ...extra };
}

/** The CLI stamps with the clock; a second migration needs a later second than the first. */
function nextSecond(after: string): void {
  const pause = new Int32Array(new SharedArrayBuffer(4));
  while (formatStamp(new Date()) <= after) Atomics.wait(pause, 0, 0, 50);
}

describe("paseo plugin control", () => {
  it("passes PASEO_HOME as --home", () => {
    const fake = fakePaseo();
    const control = paseoPluginControl({ ...process.env, PASEO_FAKE_LOG: fake.log, PASEO_HOME: join(root, "demo-home") }, fake.command);
    control.disable();
    control.enable();
    assert.deepEqual(calls(fake.log), [`plugin disable paseo-kanban --home ${join(root, "demo-home")}`, `plugin enable paseo-kanban --home ${join(root, "demo-home")}`]);
  });

  it("says when paseo is missing or fails", () => {
    assert.throws(() => paseoPluginControl({}, join(root, "no-such-dir", "paseo")).disable(), (err: unknown) =>
      err instanceof KanbanError && err.code === "paseo_missing" && /paseo command was not found on PATH, so the plugin could not be disabled/.test(err.message));
    const fake = fakePaseo();
    const env: NodeJS.ProcessEnv = { ...process.env, PASEO_FAKE_LOG: fake.log, PASEO_FAKE_FAIL: "enable" };
    delete env.PASEO_HOME;
    assert.throws(() => paseoPluginControl(env, fake.command).enable(), /plugin enable paseo-kanban exited with 1: daemon not reachable/);
    assert.deepEqual(calls(fake.log), ["plugin enable paseo-kanban"]);
  });
});

describe("paseo-kanban migrate (command line)", () => {
  it("prints usage and refuses unclear arguments", () => {
    const env = { KANBAN_DATA_DIR: join(root, "unused-board") };
    const help = cli(["--help"], env);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /paseo-kanban migrate --from <old data directory>/);
    assert.match(cli([], env).stderr, /Give exactly one of --from, --rollback, --finish/);
    assert.match(cli(["--rollback", "20261008T070000Z", "--dry-run"], env).stderr, /--dry-run only goes with --from/);
    assert.match(cli(["--finish", "yesterday"], env).stderr, /Not a migration timestamp: yesterday/);
    // There is no way past a failed observation check.
    assert.match(cli(["--finish", "20261008T070000Z", "--force"], env).stderr, /Unknown option '--force'/);
    assert.equal(cli(["--from", root, "--bogus"], env).status, 1);
  });

  it("defaults --to to PASEO_HOME's plugin-data directory", () => {
    const f = migrateFixture(root);
    const failing = { disable: () => assert.fail("a dry run must not disable the plugin"), enable: () => assert.fail("a dry run must not enable the plugin") };
    const out = runMigrateCli(["--from", f.legacy, "--dry-run"], f.env, { plugin: failing, listHolders: () => [], now: () => new Date(), sleep: () => undefined });
    assert.equal((out.result as MigrateResult).plan.to, f.target);
    assert.match(out.text, /plugin-data\/paseo-kanban\n/);
  });

  it("dry-runs without writing or calling paseo", () => {
    const f = migrateFixture(root);
    const fake = fakePaseo();
    const before = { legacy: tree(f.legacy), target: tree(f.target) };
    const out = cli(["--from", f.legacy, "--to", f.target, "--dry-run"], cliEnv(fake));
    assert.equal(out.status, 0, out.stderr);
    assert.ok(out.stdout.includes(`To:   ${f.target}\n`), out.stdout);
    assert.match(out.stdout, /Conflicts: none/);
    assert.deepEqual(calls(fake.log), []);
    assert.deepEqual({ legacy: tree(f.legacy), target: tree(f.target) }, before);
  });

  it("runs migrate → rollback → migrate → finish through anonymous executable fixtures", () => {
    const f = migrateFixture(root);
    const fake = fakePaseo();
    // Accept the exact existing database files for either anonymous fixture
    // directory, including its WAL/SHM when those files exist.
    const groups = [f.legacy, f.target].map(dir => ["kanban.db", "kanban.db-wal", "kanban.db-shm"].map(name => join(dir, name)));
    lsofFixture(fake.dir, { groups, status: 1 });
    const original = tree(f.legacy);
    const env = cliEnv(fake);
    const home = `--home ${env.PASEO_HOME}`;
    const to = ["--to", f.target];
    const migrated = cli(["--from", f.legacy, ...to, "--json"], env);
    assert.equal(migrated.status, 0, migrated.stderr);
    const first = (JSON.parse(migrated.stdout) as { record: MigrationRecord }).record;
    assert.equal(countRows(join(f.target, "kanban.db"), "tasks"), first.rows.tasks?.count);
    assert.equal(countRows(join(f.target, "kanban.db"), "events"), first.rows.events?.count);
    const rolled = cli(["--rollback", first.timestamp, ...to], env);
    assert.equal(rolled.status, 0, rolled.stderr);
    assert.match(rolled.stdout, /Rolled back migration .* The plugin uses .* again\./);
    nextSecond(first.timestamp);
    const again = cli(["--from", f.legacy, ...to, "--json"], env);
    assert.equal(again.status, 0, again.stderr);
    const second = (JSON.parse(again.stdout) as { record: MigrationRecord }).record;
    assert.deepEqual(tree(f.legacy), original);
    const finished = cli(["--finish", second.timestamp, ...to], env);
    assert.equal(finished.status, 0, finished.stderr);
    assert.match(finished.stdout, /Finished migration .* Old directory archived to .*legacy-\d{8}T\d{6}Z\.tar/);
    assert.deepEqual(calls(fake.log), [
      `plugin disable paseo-kanban ${home}`, `plugin enable paseo-kanban ${home}`,
      `plugin disable paseo-kanban ${home}`, `plugin enable paseo-kanban ${home}`,
      `plugin disable paseo-kanban ${home}`, `plugin enable paseo-kanban ${home}`,
    ]);
  });

  it("leaves both data trees untouched when the inspection executable fails", () => {
    for (const response of [
      { status: 2, stderr: "anonymous inspection failure\n" },
      { status: 0, stdout: "malformed process records\n" },
    ]) {
      const f = migrateFixture(root);
      const fake = fakePaseo();
      const files = ["kanban.db", "kanban.db-wal", "kanban.db-shm"].map(name => join(f.legacy, name));
      lsofFixture(fake.dir, { files, ...response });
      const before = { legacy: tree(f.legacy), target: tree(f.target) };
      const out = cli(["--from", f.legacy, "--to", f.target], cliEnv(fake));
      assert.equal(out.status, 1, out.stdout);
      assert.match(out.stderr, /lsof could not run/);
      assert.match(out.stderr, /The old directory was not changed/);
      assert.deepEqual({ legacy: tree(f.legacy), target: tree(f.target) }, before);
    }
  });

  it("stops with the reason when paseo cannot disable the plugin", () => {
    const f = migrateFixture(root);
    const fake = fakePaseo();
    const before = tree(f.target);
    const out = cli(["--from", f.legacy, "--to", f.target], cliEnv(fake, { PASEO_FAKE_FAIL: "disable" }));
    assert.equal(out.status, 1);
    assert.match(out.stderr, /exited with 1: daemon not reachable Stopped before changing any data\./);
    assert.deepEqual(calls(fake.log).map(line => line.split(" ").slice(0, 2).join(" ")), ["plugin disable", "plugin enable"]);
    assert.deepEqual(tree(f.target), before);
  });
});
