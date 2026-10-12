import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { realDeps, runCompat, runCompatCommand, smokeDatabase, type CompatDeps } from "../server/compat";
import { kanbanCliPath, projectRoot } from "../server/paths";
import { fleetDataRoot } from "../server/storage/root";
import { t } from "../shared/i18n";

it("isolates every profile and data lookup while retaining HOME", () => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    KANBAN_DATA_DIR: "/must-not-open/board", PASEO_HOME: "/must-not-open/paseo",
    AFC_DATA_DIR: "/must-not-open/fleet", ROLES_STATE_DIR: "/must-not-open/roles",
    AFC_LEGACY_DATA_DIR: "/must-not-open/legacy",
  };
  const smoke = smokeDatabase(env, true);
  try {
    assert.notEqual(smoke.env.KANBAN_DATA_DIR, env.KANBAN_DATA_DIR);
    assert.equal(smoke.env.HOME, env.HOME);
    assert.ok(existsSync(smoke.env.KANBAN_AGENTS_DIR!));
    for (const key of ["PASEO_HOME", "KANBAN_AGENTS_DIR", "KANBAN_PASEO_CONFIG"]) {
      assert.ok(smoke.env[key]!.startsWith(smoke.env.KANBAN_DATA_DIR!));
    }
    for (const key of ["AFC_DATA_DIR", "ROLES_STATE_DIR", "AFC_LEGACY_DATA_DIR"]) {
      assert.equal(smoke.env[key], undefined);
      assert.ok(env[key]!.startsWith("/must-not-open/"));
    }
    assert.equal(fleetDataRoot(smoke.env), join(smoke.env.KANBAN_DATA_DIR!, "fleet"));
  } finally { smoke.cleanup(); }
});

it("runs real offline ping and list against an anonymous unified root", async () => {
  const deps = realDeps({ ...process.env, KANBAN_COMPAT_OFFLINE: "1" });
  try {
    assert.equal(deps.offline, true);
    const ping = await deps.ping();
    assert.equal(ping.code, 0, ping.stderr);
    assert.equal(ping.stdout.trim(), "kanban-pong");
    const list = await deps.list();
    assert.equal(list.code, 0, list.stderr);
    const board = JSON.parse(list.stdout);
    assert.deepEqual(board.projects, []);
    assert.deepEqual(board.tasks, []);
  } finally { deps.cleanup?.(); }
});

it("still refuses each user-supplied retired override in the real CLI", async () => {
  const smoke = smokeDatabase(process.env, true);
  try {
    const retired = join(smoke.env.KANBAN_DATA_DIR!, "must-not-open");
    for (const key of ["AFC_DATA_DIR", "ROLES_STATE_DIR", "AFC_LEGACY_DATA_DIR"]) {
      for (const args of [["ping"], ["list", "--json"]]) {
        const output = await runCompatCommand(kanbanCliPath(projectRoot()), args, 20_000, {
          ...smoke.env, [key]: retired,
        });
        assert.equal(output.code, 1, `${key}: ${output.stdout}`);
        assert.ok(output.stderr.includes(`Retired storage override: ${key}.`), output.stderr);
        assert.equal(existsSync(retired), false);
      }
    }
  } finally { smoke.cleanup(); }
});

it("offline compatibility checks never call live dependencies and still reject regressions", async () => {
  const called: string[] = [];
  const forbidden = () => { throw new Error("live dependency called"); };
  const deps: CompatDeps = {
    offline: true,
    typecheck: async () => { called.push("typecheck"); return { ok: true, detail: "" }; },
    offlineTest: async () => { called.push("tests"); return { ok: true, detail: "" }; },
    ping: async () => { called.push("ping"); return { code: 0, stdout: "kanban-pong", stderr: "" }; },
    list: async () => { called.push("list"); return { code: 0, stdout: '{"projects":[],"tasks":[]}', stderr: "" }; },
    pluginTable: forbidden, pluginJson: forbidden, files: forbidden,
    daemon: forbidden, version: forbidden, openHelp: forbidden, deleteHelp: forbidden,
  };
  const result = await runCompat(deps);
  assert.equal(result.code, 0, result.lines.join("\n"));
  assert.deepEqual(called, ["typecheck", "tests", "ping", "list"]);
  assert.equal(result.lines.at(-1), t("compat.offline.passed"));
  assert.ok(result.lines.some(line => line.includes(t("compat.offline.skipped"))));
  const failure = await runCompat({ ...deps, offlineTest: async () => ({ ok: false, detail: "regression" }) });
  assert.equal(failure.code, 1);
  assert.throws(() => realDeps({ KANBAN_COMPAT_OFFLINE: "invalid" }));
  const actual = realDeps({ ...process.env, KANBAN_COMPAT_OFFLINE: "1" });
  try { assert.equal(actual.offline, true); } finally { actual.cleanup?.(); }
});
