/// <reference types="node" />
import { zhCN, zhCNPart, localePattern } from "./helpers/locale";
import { UI_ACTOR } from "../shared/actors";
// TEST_0188: identity and project scope (TEST_0184 P1-1/2/3, P2-9/21).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { runKanban } from "./helpers/compat-cli";
import { loadConfig, saveConfig } from "../server/config";
import { closeDb, getDb } from "../server/db";
import { handleTool } from "../server/tools";
import { resolveCliIdentity, resolveCompactIdentity } from "../server/identity";
import { createTask, getTask } from "../server/store";

const root = mkdtempSync(join(tmpdir(), "TEST_0188-identity-"));
const agents = join(root, "agents");
mkdirSync(agents, { recursive: true });
process.env.KANBAN_DATA_DIR = join(root, "data");
process.env.KANBAN_AGENTS_DIR = agents;

const MINE = "mine_proj";
const OTHER = "other_proj";
const KANBAN = "kanban-leader";
const LEADER = "mine-leader";
const OTHER_LEADER = "other-leader";

after(() => {
  closeDb();
  rmSync(root, { recursive: true, force: true });
});

function writeAgent(id: string, record: { archivedAt?: string | null; lastStatus?: string; labels?: Record<string, string>; title?: string } = {}): void {
  const bucket = join(agents, "Users-test-repo");
  mkdirSync(bucket, { recursive: true });
  writeFileSync(
    join(bucket, `${id}.json`),
    JSON.stringify({ id, cwd: root, title: record.title ?? "<leader> · Demo", provider: "claude", labels: record.labels ?? {}, lastStatus: record.lastStatus ?? "idle", archivedAt: record.archivedAt ?? null, createdAt: "2026-10-03T00:00:00.000Z" }),
  );
}

function project(code: string) {
  return { code, defaultWorkspace: "dir" as const, baseBranch: "main", worktreeLanes: 1, lanesEnabled: false };
}

beforeEach(() => {
  rmSync(agents, { recursive: true, force: true });
  mkdirSync(agents, { recursive: true });
  const config = loadConfig();
  config.projects = { [MINE]: project("MINE"), [OTHER]: project("OTH") };
  config.supervisors = { [MINE]: LEADER, [OTHER]: OTHER_LEADER };
  config.supervisorAgentId = KANBAN;
  saveConfig(config);
  for (const id of [LEADER, OTHER_LEADER, KANBAN]) writeAgent(id);
  getDb().exec("DELETE FROM events; DELETE FROM tasks; DELETE FROM links; DELETE FROM runs; DELETE FROM tokens;");
  if (getDb().prepare("SELECT 1 FROM sqlite_master WHERE name = 'supervisor_events'").get()) getDb().exec("DELETE FROM supervisor_events");
});

function card(proj: string, by: string | null = null, status = "acceptance"): number {
  const task = createTask({ project: proj, title: `Task ${proj}`, role: "executor", workspacePath: root, createdByAgent: by });
  getDb().prepare("UPDATE tasks SET status = ? WHERE id = ?").run(status, task.id);
  return task.id;
}

function supervisorEvents(): Array<{ kind: string; project: string | null; actor: string | null; data: { from: string | null; to: string | null; via: string } }> {
  return (getDb().prepare("SELECT kind, project, actor, data_json FROM supervisor_events ORDER BY id").all() as Array<{ kind: string; project: string | null; actor: string | null; data_json: string }>).map(
    (row) => ({ kind: row.kind, project: row.project, actor: row.actor, data: JSON.parse(row.data_json) }),
  );
}

const env = (id: string) => ({ PASEO_AGENT_ID: id });

describe("P1-1 unknown PASEO_AGENT_ID is read-only", () => {
  it("resolves an unregistered, hand-opened agent as a read-only guest, not a leader", () => {
    writeAgent("stranger");
    assert.deepEqual(resolveCliIdentity(env("stranger")), { role: "guest", taskId: null, agentId: "stranger" });
    assert.equal(resolveCompactIdentity(env("stranger"), getDb()).role, "guest");
    assert.deepEqual(resolveCliIdentity(env(LEADER)), { role: "supervisor", taskId: null, agentId: LEADER });
    assert.deepEqual(resolveCliIdentity(env(KANBAN)), { role: "supervisor", taskId: null, agentId: KANBAN });
  });

  it("lets a guest list and show but refuses every write with a supervise hint", async () => {
    const id = card(MINE, LEADER);
    const listed = (await runKanban(["list"], env("stranger"))) as { tasks: unknown[] };
    assert.ok(Array.isArray(listed.tasks));
    const shown = (await runKanban(["show", String(id)], env("stranger"))) as { task: { id: number } };
    assert.equal(shown.task.id, id);
    const writes: string[][] = [
      ["create", "--project", MINE, "--title", "Unauthorized creation", "--role", "executor"],
      ["accept", String(id)],
      ["comment", String(id), "--text", "Steering message"],
      ["archive", String(id)],
      ["start", String(id)],
      ["tag", String(id), "--tag", "high-risk"],
      ["project", "--project", MINE, "--parallel", "off"],
      ["rework", String(id), "--reason", zhCNPart("cardParts.event.tierChanged", 0, 1)],
      ["link", String(id), "--parent", String(card(MINE, LEADER))],
    ];
    for (const argv of writes) {
      await assert.rejects(() => runKanban(argv, env("stranger")), new RegExp(localePattern(zhCNPart("identity.guestDenial", 4, 18)) + ".*supervise", "s"), argv[0]);
    }
    assert.equal(getTask(id).status, "acceptance");
    await assert.rejects(() => runKanban(["compact-events", "--apply"], env("stranger")), new RegExp(localePattern(zhCNPart("cli.onlyLeader.rebind", 0, 10))));
  });

  it("a guest can still register for a project with no leader, then act as its leader", async () => {
    const config = loadConfig();
    delete config.supervisors[MINE];
    saveConfig(config);
    writeAgent("new-session");
    await runKanban(["supervise", "--project", MINE], env("new-session"));
    assert.equal(loadConfig().supervisors[MINE], "new-session");
    const created = (await runKanban(["create", "--project", MINE, "--title", (zhCNPart("cardParts.event.registered", 1, 3) + zhCNPart("routing.priorityHint", 28, 30) + zhCNPart("cardParts.event.blocked", 0, 1)), "--role", "executor"], env("new-session"))) as { created_by_agent: string };
    assert.equal(created.created_by_agent, "new-session");
  });

  it("a Paseo schedule agent may only read and create cards", async () => {
    writeAgent("sched-run", { labels: { "paseo.schedule-id": "c8217272", "paseo.schedule-run": "run-1" }, title: ("【" + zhCN("labels.role.batch") + "】Weekly retrospective") });
    assert.equal(resolveCliIdentity(env("sched-run")).role, "schedule");
    // TEST_0255: a schedule agent's cards must cite a resolved decision (a temp decisions.json, never the real one).
    const rolesDir = join(join(root, "data"), "fleet");
    mkdirSync(rolesDir, { recursive: true });
    writeFileSync(join(rolesDir, "decisions.json"), JSON.stringify([{ id: "d1005-000000-1", status: "done" }]));
    const previousRoles = process.env.ROLES_STATE_DIR;

    after(() => { delete process.env.ROLES_STATE_DIR; });
    await assert.rejects(() => runKanban(["create", "--project", OTHER, "--title", "No number", "--role", "reader"], env("sched-run")), /--decision/);
    const created = (await runKanban(["create", "--project", OTHER, "--title", "Weekly dispatch retrospective", "--role", "reader", "--decision", "d1005-000000-1"], env("sched-run"))) as { id: number; created_by_agent: string };
    assert.equal(created.created_by_agent, "sched-run");
    // TEST_0184 P2-24 keeps --brief-file for leaders; the weekly schedule passes --brief "$(cat …)" instead.
    const briefPath = join(root, "brief.md");
    writeFileSync(briefPath, zhCN("cardDrawer.brief.title"));
    await assert.rejects(() => runKanban(["create", "--project", OTHER, "--title", "Brief file", "--role", "reader", "--brief-file", briefPath], env("sched-run")), new RegExp(localePattern(zhCNPart("briefFile.error.forbidden", 0, 25))));
    const withBrief = (await runKanban(["create", "--project", OTHER, "--title", "With brief", "--role", "reader", "--brief", zhCN("cardDrawer.brief.title"), "--decision", "d1005-000000-1"], env("sched-run"))) as { brief: string };
    assert.match(withBrief.brief, new RegExp(zhCN("cardDrawer.brief.title")));
    const id = card(OTHER, OTHER_LEADER);
    await assert.rejects(() => runKanban(["accept", String(id)], env("sched-run")), new RegExp(localePattern(zhCNPart("leaderRegistry.error.schedule", 0, 4))));
    await assert.rejects(() => runKanban(["supervise", "--project", OTHER], env("sched-run")), new RegExp(localePattern(zhCNPart("leaderRegistry.error.schedule", 0, 4))));
    await assert.rejects(() => runKanban(["create", "--project", OTHER, "--title", "Review another card", "--role", "reviewer", "--reviews", String(id)], env("sched-run")), new RegExp(localePattern(zhCNPart("leaderRegistry.error.schedule", 0, 4))));
    assert.equal(loadConfig().supervisors[OTHER], OTHER_LEADER);
  });
});

describe("P1-2 supervise cannot take over a live leader", () => {
  it("refuses while the registered leader is still there and points at handover or the Kanban leader", async () => {
    writeAgent("usurper");
    await assert.rejects(() => runKanban(["supervise", "--project", MINE], env("usurper")), (error: Error) => {
      assert.match(error.message, /bin\/kanban handover/);
      assert.match(error.message, /Kanban <leader>/);
      return true;
    });
    // A leader of another project cannot grab it either.
    await assert.rejects(() => runKanban(["supervise", "--project", MINE], env(OTHER_LEADER)), /handover/);
    // An errored session still exists: not gone.
    writeAgent(LEADER, { lastStatus: "error" });
    await assert.rejects(() => runKanban(["supervise", "--project", MINE], env("usurper")), /handover/);
    assert.equal(loadConfig().supervisors[MINE], LEADER);
    assert.deepEqual(supervisorEvents(), []);
  });

  for (const [label, setup] of [
    ["archived", () => writeAgent(LEADER, { archivedAt: "2026-10-03T01:00:00.000Z" })],
    ["closed", () => writeAgent(LEADER, { lastStatus: "closed" })],
    ["missing", () => rmSync(join(agents, "Users-test-repo", `${LEADER}.json`))],
  ] as const) {
    it(`lets a new session take over in one step when the old leader is ${label}`, async () => {
      setup();
      writeAgent("restarted");
      const result = (await runKanban(["supervise", "--project", "MINE"], env("restarted"))) as { project: string };
      assert.equal(result.project, MINE);
      assert.equal(loadConfig().supervisors[MINE], "restarted");
      assert.deepEqual(supervisorEvents(), [{ kind: "supervisor_changed", project: MINE, actor: "restarted", data: { from: LEADER, to: "restarted", via: "supervise" } }]);
      // Same-id re-registration is not a change.
      await runKanban(["supervise", "--project", MINE], env("restarted"));
      assert.equal(supervisorEvents().length, 1);
    });
  }

  it("lets the Kanban leader re-register a project even when its leader is alive", async () => {
    await runKanban(["supervise", "--project", MINE], env(KANBAN));
    assert.equal(loadConfig().supervisors[MINE], KANBAN);
    assert.deepEqual(supervisorEvents(), [{ kind: "supervisor_changed", project: MINE, actor: KANBAN, data: { from: LEADER, to: KANBAN, via: "supervise" } }]);
  });

  it("records a supervisor_changed event for the settings UI path too", async () => {
    const { changeProjectLeader, changeKanbanLeader } = await import("../server/leader-registry");
    writeAgent("picked");
    changeProjectLeader(MINE, "picked", { actor: UI_ACTOR, via: "ui" });
    changeKanbanLeader("picked", { actor: UI_ACTOR, via: "ui" });
    assert.equal(loadConfig().supervisors[MINE], "picked");
    assert.equal(loadConfig().supervisorAgentId, "picked");
    assert.deepEqual(supervisorEvents(), [
      { kind: "supervisor_changed", project: MINE, actor: UI_ACTOR, data: { from: LEADER, to: "picked", via: "ui" } },
      { kind: "supervisor_changed", project: null, actor: UI_ACTOR, data: { from: KANBAN, to: "picked", via: "ui" } },
    ]);
  });
});

describe("P1-3 handover authority", () => {
  it("refuses a new session claiming a project whose leader is still alive", async () => {
    const open = card(MINE, LEADER, "running");
    writeAgent("claimer");
    await assert.rejects(() => runKanban(["handover", "--project", MINE, "--to", "claimer"], env("claimer")), new RegExp(localePattern(zhCNPart("nativeSessions.kept.running", 6, 8)) + ".*handover|handover.*" + localePattern(zhCNPart("nativeSessions.kept.running", 6, 8)), "s"));
    assert.equal(getTask(open).created_by_agent, LEADER);
    assert.equal(loadConfig().supervisors[MINE], LEADER);
    assert.deepEqual(supervisorEvents(), []);
  });

  it("lets a new session claim in one step once the old leader is gone", async () => {
    const open = card(MINE, LEADER, "running");
    writeAgent(LEADER, { archivedAt: "2026-10-03T01:00:00.000Z" });
    writeAgent("claimer");
    const result = (await runKanban(["handover", "--project", MINE, "--to", "claimer"], env("claimer"))) as { taskIds: number[] };
    assert.deepEqual(result.taskIds, [open]);
    assert.equal(getTask(open).created_by_agent, "claimer");
    assert.equal(loadConfig().supervisors[MINE], "claimer");
    assert.deepEqual(supervisorEvents(), [{ kind: "supervisor_changed", project: MINE, actor: "claimer", data: { from: LEADER, to: "claimer", via: "handover" } }]);
  });

  it("refuses self-claim when --from names a live agent even if the registry is empty", async () => {
    const config = loadConfig();
    delete config.supervisors[MINE];
    saveConfig(config);
    const open = card(MINE, "alive-old", "running");
    writeAgent("alive-old");
    writeAgent("claimer");
    await assert.rejects(() => runKanban(["handover", "--project", MINE, "--from", "alive-old", "--to", "claimer"], env("claimer")), new RegExp(localePattern(zhCNPart("nativeSessions.kept.running", 6, 8))));
    assert.equal(getTask(open).created_by_agent, "alive-old");
  });

  it("lets the current leader hand over to a new session that is not registered yet", async () => {
    const open = card(MINE, LEADER, "running");
    await runKanban(["handover", "--project", MINE, "--to", "successor"], env(LEADER));
    assert.equal(getTask(open).created_by_agent, "successor");
    assert.equal(loadConfig().supervisors[MINE], "successor");
    assert.equal(resolveCliIdentity(env("successor")).role, "supervisor");
    assert.equal(resolveCliIdentity(env(LEADER)).role, "guest");
  });

  it("lets the Kanban leader reassign a live project, and refuses third parties and other leaders", async () => {
    const open = card(MINE, LEADER, "running");
    writeAgent("third");
    await assert.rejects(() => runKanban(["handover", "--project", MINE, "--to", "successor"], env("third")), new RegExp(localePattern(zhCNPart("handover.error.authority", 5, 15))));
    await assert.rejects(() => runKanban(["handover", "--project", MINE, "--to", "successor"], env(OTHER_LEADER)), new RegExp(localePattern(zhCNPart("handover.error.authority", 5, 15))));
    assert.equal(getTask(open).created_by_agent, LEADER);
    await runKanban(["handover", "--project", MINE, "--to", "successor"], env(KANBAN));
    assert.equal(getTask(open).created_by_agent, "successor");
    assert.deepEqual(supervisorEvents(), [{ kind: "supervisor_changed", project: MINE, actor: KANBAN, data: { from: LEADER, to: "successor", via: "handover" } }]);
  });

  it("refuses to hand a project to an agent Kanban launched", async () => {
    const worker = card(MINE, LEADER, "running");
    getDb().prepare("UPDATE tasks SET agent_id = 'worker-a' WHERE id = ?").run(worker);
    await assert.rejects(() => runKanban(["handover", "--project", MINE, "--to", "worker-a"], env(LEADER)), new RegExp(localePattern(zhCNPart("leaderRegistry.error.notLeader", 16, 27))));
    assert.equal(loadConfig().supervisors[MINE], LEADER);
  });

  it("--kanban-leader self-claim needs the old Kanban leader to be gone", async () => {
    writeAgent("kanban-new");
    await assert.rejects(() => runKanban(["handover", "--kanban-leader", "--to", "kanban-new"], env("kanban-new")), new RegExp(localePattern(zhCNPart("nativeSessions.kept.running", 6, 8))));
    writeAgent(KANBAN, { lastStatus: "closed" });
    await runKanban(["handover", "--kanban-leader", "--to", "kanban-new"], env("kanban-new"));
    assert.equal(loadConfig().supervisorAgentId, "kanban-new");
    assert.deepEqual(supervisorEvents(), [{ kind: "supervisor_changed", project: null, actor: "kanban-new", data: { from: KANBAN, to: "kanban-new", via: "handover" } }]);
  });
});

describe("P2-9 project scope for create, link, register and project", () => {
  it("create needs a configured project, for every caller", async () => {
    for (const caller of [{}, env(LEADER), env(KANBAN)]) {
      await assert.rejects(() => runKanban(["create", "--project", "typo_proj", "--title", "x", "--role", "executor"], caller), new RegExp(localePattern(zhCNPart("config.unconfiguredProject", 10, 15))));
    }
    assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM tasks WHERE project = 'typo_proj'").get()?.n, 0);
    assert.equal(loadConfig().projects?.typo_proj, undefined);
  });

  it("create resolves a short code to the configured project name", async () => {
    const created = (await runKanban(["create", "--project", "mine", "--title", (zhCN("settings.projects.code") + zhCN("tools.action.create")), "--role", "executor"], env(LEADER))) as { project: string };
    assert.equal(created.project, MINE);
  });

  it("a project leader cannot create, link, register or reconfigure in another project; the Kanban leader can", async () => {
    await assert.rejects(() => runKanban(["create", "--project", OTHER, "--title", zhCNPart("nativeSessions.path.outside", 6, 8), "--role", "executor"], env(LEADER)), new RegExp(localePattern(zhCNPart("doctorConfig.code.global", 14, 18))));
    const foreign = card(OTHER, OTHER_LEADER, "ready");
    const own = card(MINE, LEADER, "ready");
    await assert.rejects(() => runKanban(["link", String(foreign), "--parent", String(own)], env(LEADER)), new RegExp(localePattern(zhCNPart("doctorConfig.code.global", 14, 18))));
    assert.equal(getTask(foreign).status, "ready");
    await assert.rejects(
      () => runKanban(["create", "--project", MINE, "--title", "Review another card", "--role", "reviewer", "--reviews", String(foreign)], env(LEADER)),
      new RegExp(localePattern(zhCNPart("doctorConfig.code.global", 14, 18))),
    );
    writeAgent("backfill-agent");
    const register = ["register", "--project", OTHER, "--title", zhCN("cardParts.event.registered"), "--role", "executor", "--profile", "p", "--provider", "claude", "--model", "m", "--agent", "backfill-agent"];
    await assert.rejects(() => runKanban(register, env(LEADER)), new RegExp(localePattern(zhCNPart("doctorConfig.code.global", 14, 18))));
    await assert.rejects(() => runKanban(["project", "--project", OTHER, "--parallel", "off"], env(LEADER)), new RegExp(localePattern(zhCNPart("doctorConfig.code.global", 14, 18))));
    assert.notEqual(loadConfig().projects?.[OTHER]?.parallel, false);

    // Inside its own project everything still works.
    await runKanban(["link", String(own), "--parent", String(card(MINE, LEADER, "running"))], env(LEADER));
    await runKanban(["project", "--project", MINE, "--parallel", "off"], env(LEADER));
    assert.equal(loadConfig().projects?.[MINE]?.parallel, false);
    // Reading the settings is still fine.
    await runKanban(["project"], env(LEADER));

    // Kanban leader is global.
    const made = (await runKanban(["create", "--project", OTHER, "--title", (zhCNPart("settings.leaders.noFallback", 3, 5) + zhCN("tools.action.create")), "--role", "executor"], env(KANBAN))) as { project: string };
    assert.equal(made.project, OTHER);
    await runKanban(["project", "--project", OTHER, "--parallel", "off"], env(KANBAN));
    const registered = (await runKanban(register, env(KANBAN))) as { project: string };
    assert.equal(registered.project, OTHER);
  });

  it("only the Kanban leader or the terminal adds a brand-new project", async () => {
    await assert.rejects(() => runKanban(["project", "--project", "brand_new", "--code", "BNEW"], env(LEADER)), /Kanban <leader>/);
    await runKanban(["project", "--project", "brand_new", "--code", "BNEW"], env(KANBAN));
    assert.equal(loadConfig().projects?.brand_new?.code, "BNEW");
  });

  it("register refuses an agent id that is a registered leader", async () => {
    const base = ["register", "--project", MINE, "--title", zhCN("cardParts.event.registered"), "--role", "executor", "--profile", "p", "--provider", "claude", "--model", "m"];
    for (const id of [OTHER_LEADER, KANBAN, LEADER]) {
      await assert.rejects(() => runKanban([...base, "--agent", id], env(LEADER)), /<leader>/);
      await assert.rejects(() => runKanban([...base, "--agent", id], {}), /<leader>/);
    }
    assert.equal(resolveCliIdentity(env(OTHER_LEADER)).role, "supervisor");
    assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM tasks").get()?.n, 0);
  });

  it("the MCP tool path applies the same project scope", async () => {
    const identity = { role: "supervisor", taskId: null, agentId: LEADER };
    await assert.rejects(() => handleTool("kanban_create", { project: OTHER, title: "x", role: "executor" }, null, identity), new RegExp(localePattern(zhCNPart("doctorConfig.code.global", 14, 18))));
    await assert.rejects(() => handleTool("kanban_create", { project: "nowhere", title: "x", role: "executor" }, null, { role: "supervisor", taskId: null, agentId: null }), new RegExp(localePattern(zhCNPart("config.unconfiguredProject", 10, 15))));
  });
});

describe("P2-21 agent id format is checked at the identity entry", () => {
  it("rejects a malformed PASEO_AGENT_ID before any lookup", async () => {
    for (const bad of ["../../etc/passwd", "a/b", "has space", ".hidden", "x".repeat(200)]) {
      assert.throws(() => resolveCliIdentity(env(bad)), /PASEO_AGENT_ID/);
      assert.throws(() => resolveCompactIdentity(env(bad), getDb()), /PASEO_AGENT_ID/);
      await assert.rejects(() => runKanban(["list"], env(bad)), /PASEO_AGENT_ID/);
    }
  });

  it("rejects malformed agent ids passed to handover and register", async () => {
    await assert.rejects(() => runKanban(["handover", "--project", MINE, "--to", "../x"], env(LEADER)), /agentId/);
    await assert.rejects(() => runKanban(["handover", "--project", MINE, "--to", "ok-id", "--from", "a/b"], env(LEADER)), /agentId/);
    await assert.rejects(
      () => runKanban(["register", "--project", MINE, "--title", "t", "--role", "executor", "--profile", "p", "--provider", "c", "--model", "m", "--agent", "../x"], env(LEADER)),
      /agentId/,
    );
  });
});
