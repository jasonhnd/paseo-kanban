/// <reference types="node" />
import { zhCN, zhCNPart, localePattern } from "./helpers/locale";
// TEST_0273: on 2026-10-06 a `git reset --hard` deleted data/kanban.config.json while the plugin ran.
// The next database open wrote a fresh file with regenerated project codes, and the next `supervise`
// wrote the defaults back over everything else. A board that has had a config must never do that.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { resetWakeSender, setWakeSender } from "../server/bus";
import { cardMark, resolveTaskId } from "../server/card-ref";
import { runKanban } from "../server/cli";
import { ConfigFileError, DEFAULT_CONCURRENCY, loadConfig, logRetiredDefaultWorktrees, saveConfig, setProjectSupervisor } from "../server/config";
import { closeDb, getDb } from "../server/db";
import type { DoctorReport } from "../server/doctor";
import { bindScheduler, resetSchedulerForTests } from "../server/loop";
import { startMissingCwdPatrol } from "../server/missing-cwd";
import { preferredMcpPort } from "../server/mcp-port";
import type { PoolSnapshot } from "../server/pools";
import type { Profile } from "../server/profiles";
import { createTask, getTask } from "../server/store";
import { resetAgentAliveCheck, resetBoardWakeForTests, setAgentAliveCheck } from "../server/wake";

const tmp = tmpdir();
mkdirSync(tmp, { recursive: true });
const dirs: string[] = [mkdtempSync(join(tmp, "config-failsafe-base-"))];
process.env.KANBAN_DATA_DIR = dirs[0];
const sent: Array<{ id: string; text: string }> = [];

const profiles: Profile[] = [
  { id: "ex", name: zhCN("labels.role.executor"), role: "executor", family: "xai", provider: "cursor", model: "grok-4.7", pool: "cursor" },
  { id: "rv", name: zhCN("labels.role.reviewer"), role: "reviewer", family: "anthropic", provider: "claude", model: "sonnet", pool: "claude-max" },
];
const pools: PoolSnapshot = {
  state: "fresh",
  message: (zhCNPart("compat.name.offlineTest", 2, 4) + zhCNPart("profiles.testSnapshot", 5, 7)),
  generatedAt: new Date().toISOString(),
  dispatchable: () => true,
  entry: () => ({ dispatchable: true, deprioritize: false, prefer: false, resetsAt: null, reason: null, onlyRoles: null }),
};

/** What the production file looked like before the incident, trimmed to the parts that were lost. */
const LIVE_CONFIG = {
  autoStart: { xyz_site: false },
  disabledPools: ["cursor"],
  supervisorAgentId: "kanban-boss",
  supervisors: { xyz_site: "leader-demo" },
  concurrency: { global: 2, pools: { cursor: 0 }, roles: { executor: 1 } },
  projects: {
    xyz_site: { defaultWorkspace: "dir", baseBranch: "main", worktreeLanes: 1, lanesEnabled: false, code: "DEMO" },
  },
};

function useDir(name: string): string {
  closeDb();
  const next = mkdtempSync(join(tmp, `config-failsafe-${name}-`));
  dirs.push(next);
  process.env.KANBAN_DATA_DIR = next;
  resetBoardWakeForTests();
  return next;
}

function configPath(dir: string): string {
  return join(dir, "kanban.config.json");
}

function writeLive(dir: string): string {
  const body = `${JSON.stringify(LIVE_CONFIG, null, 2)}\n`;
  writeFileSync(configPath(dir), body);
  return body;
}

function captureErrors<T>(run: () => Promise<T>): Promise<{ value: T; logs: string[] }> {
  const logs: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => {
    logs.push(args.map((item) => String(item)).join(" "));
  };
  return run().then(
    (value) => {
      console.error = orig;
      return { value, logs };
    },
    (err: unknown) => {
      console.error = orig;
      throw err;
    },
  );
}

/** The plugin's scheduler loop with a fake launcher. The round reads the config itself, as in production. */
function plugin(now?: () => Date): { kick: () => Promise<void>; release: () => void; created: () => number } {
  let created = 0;
  const bound = bindScheduler({
    ready: () => ({
      launcher: {
        async create() {
          created += 1;
          return { id: `failsafe-agent-${created}` };
        },
        async send() {},
      },
      profiles,
      pools,
      agentState: () => "alive" as const,
      ...(now ? { now: now() } : {}),
    }),
    intervalMs: 3_600_000,
    minRerunMs: 1,
  });
  return { kick: bound.kick, release: bound.release, created: () => created };
}

async function doctor(): Promise<DoctorReport> {
  return await runKanban(["doctor", "--json"], {}, { doctorSources: {} }) as DoctorReport;
}

function configReds(report: DoctorReport): DoctorReport["findings"] {
  return report.findings.filter((item) => item.severity === "red" && /kanban\.config\.json/.test(`${item.object}${item.symptom}${item.evidence}`));
}

function tmpLeftovers(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.endsWith(".tmp"));
}

beforeEach(() => {
  resetSchedulerForTests();
  resetBoardWakeForTests();
  sent.length = 0;
  setWakeSender((id, text) => {
    sent.push({ id, text });
    return true;
  });
  setAgentAliveCheck(() => true);
});

afterEach(() => {
  resetSchedulerForTests();
  resetWakeSender();
  resetAgentAliveCheck();
});

after(() => {
  closeDb();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("config file deleted under a running board (TEST_0273)", () => {
  it("one scheduler round neither writes defaults nor forgets the leaders, wakes the Kanban <leader>, and doctor reports red", async () => {
    const dir = useDir("deleted");
    writeLive(dir);
    const task = createTask({ project: "xyz_site", title: "Old sample", role: "executor", workspacePath: dir });
    assert.equal(cardMark(task.id), "DEMO_0001");
    const loop = plugin();
    await loop.kick();
    assert.equal(getTask(task.id).status, "ready", "autoStart off: the card waits");

    rmSync(configPath(dir));
    const first = await captureErrors(() => loop.kick());
    assert.equal(existsSync(configPath(dir)), false, "the round must not write a config file");
    const memory = loadConfig();
    assert.deepEqual(memory.supervisors, LIVE_CONFIG.supervisors);
    assert.equal(memory.supervisorAgentId, "kanban-boss");
    assert.deepEqual(memory.disabledPools, ["cursor"]);
    assert.equal(memory.concurrency.global, 2);
    assert.equal(memory.projects?.xyz_site?.code, "DEMO");
    assert.equal(getTask(task.id).status, "ready", "the in-memory copy still says autoStart off");
    assert.equal(loop.created(), 0);
    assert.equal(cardMark(task.id), "DEMO_0001", "card numbers keep the stored code");
    assert.ok(first.logs.some((line) => /kanban\.config\.json/.test(line)), `the round logs the problem: ${first.logs.join(" | ")}`);
    const wakes = sent.filter((item) => item.id === "kanban-boss" && /kanban\.config\.json/.test(item.text));
    assert.equal(wakes.length, 1, `Kanban <leader> woken once: ${JSON.stringify(sent)}`);
    assert.match(wakes[0]?.text ?? "", new RegExp(localePattern(zhCNPart("compat.workspaces.noArchivedAt", 11, 14)) + "|" + localePattern(zhCNPart("nativeSessions.restore.cardMissing", 4, 6))));

    // Every round alarms again in the log; the wake itself is not repeated inside the reminder window.
    const second = await captureErrors(() => loop.kick());
    assert.ok(second.logs.some((line) => /kanban\.config\.json/.test(line)));
    assert.equal(sent.filter((item) => /kanban\.config\.json/.test(item.text)).length, 1);

    // Reopening the database (another process, a reload) does not regenerate project codes into a new file.
    closeDb();
    getDb();
    assert.equal(existsSync(configPath(dir)), false, "opening the database must not create the file");

    const report = await doctor();
    const reds = configReds(report);
    assert.equal(reds.length, 1, JSON.stringify(report.findings));
    assert.match(reds[0]?.symptom ?? "", new RegExp(localePattern(zhCNPart("nativeSessions.restore.cardMissing", 4, 6))));
    assert.equal(existsSync(configPath(dir)), false);
    assert.deepEqual(tmpLeftovers(dir), []);
    loop.release();
  });

  it("the command line refuses instead of running on defaults, and supervise cannot recreate the file", async () => {
    const dir = useDir("cli");
    writeLive(dir);
    createTask({ project: "xyz_site", title: "Old sample", role: "executor", workspacePath: dir });
    rmSync(configPath(dir));
    for (const args of [["list"], ["show", "DEMO_0001"]]) {
      await assert.rejects(() => runKanban(args, {}), (err: unknown) => {
        assert.ok(err instanceof ConfigFileError, `${args.join(" ")}: ${String(err)}`);
        assert.match((err as Error).message, /kanban\.config\.json/);
        return true;
      });
    }
    await assert.rejects(() => runKanban(["supervise", "--project", "xyz_site"], { PASEO_AGENT_ID: "leader-new" }), ConfigFileError);
    assert.throws(() => setProjectSupervisor("xyz_site", "leader-new"), ConfigFileError);
    assert.throws(() => saveConfig(loadConfigOrDefaults()), ConfigFileError);
    assert.equal(existsSync(configPath(dir)), false);
    assert.deepEqual(tmpLeftovers(dir), []);
  });

  it("a plugin with no copy in memory stops dispatching and wakes the Kanban <leader> named in the previous file", async () => {
    const dir = useDir("reload");
    // A board whose config file was lost before this process ever read it: only the previous copy is left.
    writeFileSync(join(dir, "kanban.config.json.prev"), `${JSON.stringify(LIVE_CONFIG, null, 2)}\n`);
    getDb();
    assert.equal(existsSync(configPath(dir)), false, "the database open must not write a config");
    const inserted = getDb().prepare(("INSERT INTO tasks (project, title, role, status, workspace_path, created_at, updated_at, code_seq)\n      VALUES ('xyz_site', '" + zhCNPart("doctorConfig.code.evidence", 41, 43) + "', 'executor', 'ready', ?, datetime('now'), datetime('now'), 1)")).run(dir);
    const id = Number(inserted.lastInsertRowid);
    closeDb();
    getDb();
    assert.equal(existsSync(configPath(dir)), false, "reopening must not write a config either");
    assert.throws(() => loadConfig(), ConfigFileError);
    // Plugin startup reads the config before the scheduler binds: it must still load, to raise the alarm.
    assert.doesNotThrow(() => logRetiredDefaultWorktrees(() => {}));
    assert.doesNotThrow(() => preferredMcpPort());
    assert.doesNotThrow(() => startMissingCwdPatrol({ run: async () => {} })());
    // No stored code is known at all, so no derived code (DEM) is printed: it could be anyone's.
    assert.equal(cardMark(id), `#${id}`);
    const loop = plugin();
    await captureErrors(async () => {
      await loop.kick();
      await loop.kick();
    });
    assert.equal(loop.created(), 0, "nothing is dispatched on defaults");
    assert.equal(existsSync(configPath(dir)), false);
    assert.ok(sent.some((item) => item.id === "kanban-boss"), `woken from .prev: ${JSON.stringify(sent)}`);
    loop.release();
  });
});

describe("config file that is not valid JSON (TEST_0273)", () => {
  it("is left byte for byte, the round runs on the memory copy, and doctor reports red", async () => {
    const dir = useDir("broken");
    writeLive(dir);
    const task = createTask({ project: "xyz_site", title: "Old sample", role: "executor", workspacePath: dir });
    const loop = plugin();
    await loop.kick();
    const broken = '{"supervisors":{"xyz_site":"leader-demo"},"concurrency":';
    writeFileSync(configPath(dir), broken);
    const before = readFileSync(configPath(dir));
    const round = await captureErrors(() => loop.kick());
    assert.deepEqual(readFileSync(configPath(dir)), before);
    assert.deepEqual(loadConfig().supervisors, LIVE_CONFIG.supervisors);
    assert.equal(getTask(task.id).status, "ready");
    assert.ok(round.logs.some((line) => /kanban\.config\.json/.test(line)));
    const wakes = sent.filter((item) => item.id === "kanban-boss" && /kanban\.config\.json/.test(item.text));
    assert.equal(wakes.length, 1, JSON.stringify(sent));
    assert.match(wakes[0]?.text ?? "", new RegExp(localePattern(zhCNPart("settings.error.broken", 5, 7)) + "|" + zhCN("compat.workspaces.notJson")));
    closeDb();
    getDb();
    assert.deepEqual(readFileSync(configPath(dir)), before);
    await assert.rejects(() => runKanban(["list"], {}), ConfigFileError);
    const reds = configReds(await doctor());
    assert.equal(reds.length, 1);
    assert.match(reds[0]?.symptom ?? "", new RegExp(localePattern(zhCNPart("settings.error.broken", 5, 7))));
    assert.deepEqual(readFileSync(configPath(dir)), before);

    // Fixing the file clears the alarm and the next round reads it again.
    writeLive(dir);
    await loop.kick();
    assert.equal(loadConfig().supervisorAgentId, "kanban-boss");
    assert.equal(configReds(await doctor()).length, 0);
    loop.release();
  });
});

describe("fresh installation (TEST_0273)", () => {
  it("still generates the default config when there is no database, no card and no backup", () => {
    const dir = useDir("fresh");
    assert.equal(existsSync(configPath(dir)), false);
    getDb();
    assert.equal(existsSync(configPath(dir)), true);
    const config = loadConfig();
    assert.deepEqual(config.supervisors, {});
    assert.equal(config.supervisorAgentId, null);
    assert.equal(config.concurrency.global, DEFAULT_CONCURRENCY.global);
    assert.deepEqual(config.projects, {}, "a fresh board starts with no projects");
    const task = createTask({ project: "xyz_tasks", title: "First card", role: "executor", workspacePath: dir });
    assert.equal(cardMark(task.id), "XYZ_0001");
  });

  it("a backup next to a missing file is enough to refuse", async () => {
    const dir = useDir("backup-only");
    writeFileSync(join(dir, "kanban.config.json.bak-20261006-burnweek3"), `${JSON.stringify(LIVE_CONFIG)}\n`);
    await assert.rejects(() => runKanban(["list"], {}), ConfigFileError);
    assert.equal(existsSync(configPath(dir)), false);
    const legacy = useDir("backup-legacy");
    writeFileSync(join(legacy, "kanban.config.backup-2026-10-01.json"), `${JSON.stringify(LIVE_CONFIG)}\n`);
    await assert.rejects(() => runKanban(["list"], {}), ConfigFileError);
    assert.equal(existsSync(configPath(legacy)), false);
  });
});

describe("config writes (TEST_0273)", () => {
  it("replace the file atomically, owner-only, and keep the previous one as kanban.config.json.prev", () => {
    const dir = useDir("atomic");
    const first = writeLive(dir);
    getDb();
    setProjectSupervisor("xyz_site", "leader-2");
    assert.equal(readFileSync(join(dir, "kanban.config.json.prev"), "utf8"), first);
    const second = readFileSync(configPath(dir), "utf8");
    assert.equal((JSON.parse(second) as typeof LIVE_CONFIG).supervisors.xyz_site, "leader-2");
    setProjectSupervisor("xyz_site", "leader-3");
    assert.equal(readFileSync(join(dir, "kanban.config.json.prev"), "utf8"), second);
    assert.equal(statSync(configPath(dir)).mode & 0o777, 0o600);
    assert.equal(statSync(join(dir, "kanban.config.json.prev")).mode & 0o777, 0o600);
    assert.deepEqual(tmpLeftovers(dir), []);
  });
});

describe("project short codes (TEST_0273)", () => {
  it("a project without a stored code is shown with a derived code, or #id when that code is taken, and nothing is written back", async () => {
    const dir = useDir("codes");
    const withoutCode = {
      ...LIVE_CONFIG,
      autoStart: {},
      projects: {
        xyz_site: { defaultWorkspace: "dir", baseBranch: "main", worktreeLanes: 1, lanesEnabled: false },
        abc_owner: { defaultWorkspace: "dir", baseBranch: "main", worktreeLanes: 1, lanesEnabled: false, code: "ABC" },
      },
    };
    writeFileSync(configPath(dir), `${JSON.stringify(withoutCode, null, 2)}\n`);
    const before = readFileSync(configPath(dir));
    getDb();
    const task = createTask({ project: "xyz_site", title: "Old sample", role: "executor", workspacePath: dir });
    const other = createTask({ project: "abc_new", title: "Sample text", role: "executor", workspacePath: dir });
    closeDb();
    getDb();
    assert.deepEqual(readFileSync(configPath(dir)), before, "no code is generated into the file");
    assert.equal(cardMark(task.id), "XYZ_0001", "shown, not stored");
    assert.equal(resolveTaskId("xyz_1"), task.id);
    // ABC is abc_owner's stored code: abc_new must not show it, or `show ABC_0001` would reach abc_owner's card.
    assert.equal(cardMark(other.id), `#${other.id}`);
    assert.throws(() => resolveTaskId("ABC_0001"), new RegExp(zhCN("cardRef.error.noCard", {"card":"ABC_0001"})));
    const report = await doctor();
    const missing = report.findings.filter((item) => new RegExp(zhCN("settings.projects.code")).test(item.symptom));
    assert.deepEqual(missing.map((item) => [item.project, item.severity]), [["abc_new", "yellow"], ["xyz_site", "yellow"]]);
    assert.deepEqual(readFileSync(configPath(dir)), before);

    // XYZ_0001 is already in use as xyz_site's number: another project may not take DEM.
    await assert.rejects(() => runKanban(["project", "--project", "abc_owner", "--code", "XYZ", "--base", "develop"], {}), new RegExp(localePattern(zhCNPart("cardRef.error.codeShown", 10, 20)) + "xyz_site"));
    assert.deepEqual(readFileSync(configPath(dir)), before, "a refused code saves none of the other settings either");
    await runKanban(["project", "--project", "xyz_site", "--code", "DEMO"], {});
    assert.equal(cardMark(task.id), "DEMO_0001");
    assert.deepEqual(readFileSync(join(dir, "kanban.config.json.prev")), before);
  });
});

function loadConfigOrDefaults(): ReturnType<typeof loadConfig> {
  try {
    return loadConfig();
  } catch {
    return {
      autoStart: {},
      supervisorAgentId: null,
      supervisors: {},
      concurrency: { global: DEFAULT_CONCURRENCY.global, pools: { ...DEFAULT_CONCURRENCY.pools }, roles: { ...DEFAULT_CONCURRENCY.roles } },
    };
  }
}
