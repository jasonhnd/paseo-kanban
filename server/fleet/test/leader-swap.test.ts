import assert from "node:assert/strict";
import { BOARD_AGENT_ENV } from "../../agent-env";
import { after, test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSupervisorShift, handoverDoneReply, takenOverReply, PARENT_LABEL, type ShiftAgent, type ShiftPorts, type ShiftCreateInput } from "../../../shared/fleet/supervisor-shift";
import { leaderSwapRpc } from "../../../shared/fleet/leader-command";
import { setLanguage, t } from "../../../shared/fleet/i18n";

const root = mkdtempSync(join(tmpdir(), "leader-swap-"));
process.env.PASEO_HOME = join(root, "home");
process.env.KANBAN_PASEO_CONFIG = join(process.env.PASEO_HOME!, "config.json");
process.env.KANBAN_DATA_DIR = join(root, "afc");


const { leaderSwap, readLeaderUsage } = await import("../leader-command");
const { setShiftStatePathForTests, resetShiftClaimsForTests, inspectSupervisorShift } = await import("../supervisor-shift");
const { runLeaderCli } = await import("../leader-cli");
after(() => rmSync(root, { recursive: true, force: true }));
setLanguage("en");

function fixture() {
  resetShiftClaimsForTests();
  const dir = mkdtempSync(join(root, "case-"));
  const config = join(dir, "kanban.config.json");
  const state = join(dir, "state.json");
  const log = join(dir, "handoffs.log");
  writeFileSync(config, JSON.stringify({ supervisors: { demo: "old" }, projects: { demo: { code: "DEMO" } } }));
  const exports = join(process.env.KANBAN_DATA_DIR!, "exports");
  mkdirSync(exports, { recursive: true });
  const envelope = { schema: "fleet-quota/v1", producer: "paseo-kanban", producerVersion: "0.0.0-demo", generatedAt: new Date().toISOString(), ttlSeconds: 1800 };
  writeFileSync(join(exports, "kanban.json"), JSON.stringify({ ...envelope, dataDir: process.env.KANBAN_DATA_DIR, cli: null, features: ["board-summary"] }));
  writeFileSync(join(exports, "board-summary.json"), JSON.stringify({ ...envelope, projects: [], cards: [], dbPath: null }));
  setShiftStatePathForTests(state, { config, log });
  const old: ShiftAgent = { id: "old", status: "idle", title: "Demo leader", workspaceId: "demo-workspace", cwd: dir, provider: "demo-provider", model: "demo-model", modeId: "demo-mode", thinkingOptionId: "demo-effort", featureValues: { demo: true }, labels: { role: "supervisor", [PARENT_LABEL]: "former-parent" }, contextTokens: 750001 };
  const calls: string[] = [];
  const creates: ShiftCreateInput[] = [];
  const agents = new Map([["old", old]]);
  const keys = new Map<string, string>();
  let fail = "";
  let registered = "old";
  let clock = 0;
  let archiveCount = 0;
  const ports: ShiftPorts = {
    now: () => clock,
    getAgent: async id => { calls.push(`get:${id}`); return agents.get(id) ?? null; },
    sendAndWait: async () => { calls.push("handover"); if (fail === "handover") throw new Error("demo handover error"); return { timedOut: false, reply: handoverDoneReply(), error: null }; },
    readHandover: async () => ({ path: "HANDOVER.md", preview: "Demo", summary: "Demo work" }),
    readAcceptanceCards: async () => ["DEMO_0001"],
    createAgent: async input => {
      calls.push("open"); creates.push(input);
      assert.ok(!existsSync(state) || JSON.parse(readFileSync(state, "utf8"))[0].progress.phase === "opening");
      let id = keys.get(input.idempotencyKey!);
      if (!id) { id = `new-${keys.size + 1}`; keys.set(input.idempotencyKey!, id); agents.set(id, { ...old, id, labels: { [PARENT_LABEL]: "old" } }); }
      if (fail === "open") throw new Error("demo lost creation response");
      return { id, workspaceId: old.workspaceId!, labels: { [PARENT_LABEL]: "old" } };
    },
    detach: async id => { calls.push("detach"); if (fail === "detach") throw new Error("demo detach error"); agents.get(id)!.labels = {}; },
    latestReply: async () => { calls.push("reply"); if (fail === "wait") throw new Error("demo reply error"); return takenOverReply(); },
    registeredSupervisor: async () => { calls.push("registration"); if (fail === "registration") return "old"; registered = [...keys.values()].at(-1) ?? registered; return registered; },
    archive: async id => {
      calls.push("archive"); if (fail === "archive") throw new Error("demo archive error");
      assert.equal(id, "old"); assert.notEqual(registered, "old"); archiveCount++;
      // Match the real registry's atomic updates while inspections read concurrently.
      const replacement = `${config}.tmp`;
      writeFileSync(replacement, JSON.stringify({ supervisors: { demo: registered }, projects: { demo: { code: "DEMO" } } }));
      renameSync(replacement, config);
    },
    sleep: async ms => { clock += ms; if (clock > 2000000) throw new Error("demo queue timeout"); },
  };
  return { dir, config, state, log, old, calls, creates, ports, agents, keys, fail: (step: string) => { fail = step; }, archiveCount: () => archiveCount };
}
const input = (extra = {}) => leaderSwapRpc.input.parse({ project: "demo", ...extra });
async function settled() {
  for (let i = 0; i < 200; i++) { const state = await inspectSupervisorShift("demo"); if (!state.running) return state; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error("Demo swap did not settle");
}

test("fake host runs every stage, keeps settings, and archives only after reply plus registration", async () => {
  const f = fixture();
  const outcome = await runSupervisorShift({ clicked: true, project: "demo", code: "DEMO", agentId: "old", resume: "start", existingNewId: null }, f.ports);
  assert.deepEqual(outcome.steps, ["handover", "open", "detach", "wait", "archive"]);
  assert.equal(outcome.archived, true);
  assert.deepEqual(f.creates[0], { ...Object.fromEntries(["workspaceId", "cwd", "title", "provider", "model", "modeId", "thinkingOptionId", "featureValues"].map(key => [key, f.old[key as keyof ShiftAgent]])), oldAgentId: "old", idempotencyKey: "afc-leader-swap:demo:old", labels: { role: "supervisor" }, prompt: f.creates[0].prompt });
  assert.ok(f.creates[0].prompt.includes("DEMO_0001"));
  assert.ok(f.creates[0].prompt.includes("supervise"));
});

for (const stage of ["handover", "open", "detach", "wait", "archive"]) test(`RPC resumes ${stage} failure after process state is reloaded without duplicating a session`, async () => {
  const f = fixture(); f.fail(stage);
  await leaderSwap({} as never, input(), f.ports);
  let state = await settled();
  assert.equal(state.job?.phase, "failed");
  assert.equal(state.job?.step, stage);
  assert.equal(f.archiveCount(), 0);
  assert.ok(existsSync(f.state));
  f.fail(""); resetShiftClaimsForTests();
  await leaderSwap({} as never, input(), f.ports);
  state = await settled();
  assert.equal(state.job?.phase, "done");
  assert.equal(f.archiveCount(), 1);
  assert.equal(f.keys.size, 1);
  if (["detach", "wait", "archive"].includes(stage)) assert.equal(f.creates.length, 1);
  resetShiftClaimsForTests();
  const repeated = await leaderSwap({} as never, input(), f.ports);
  assert.equal(repeated.job?.phase, "done");
  assert.equal(f.archiveCount(), 1);
  assert.equal(f.keys.size, 1);
});

for (const unavailable of ["session", "workspace-missing", "workspace-null", "workspace-empty", "old-workspace-missing"]) test(`RPC preserves the new session across reloads while ${unavailable} is unreadable`, async () => {
  const f = fixture(); f.fail("wait");
  await leaderSwap({} as never, input(), f.ports); await settled();
  f.fail("");
  const newId = [...f.keys.values()][0];
  const fresh = f.agents.get(newId)!;
  const getAgent = f.ports.getAgent;
  f.ports.getAgent = async id => {
    const agent = await getAgent(id);
    if (id === newId && unavailable === "session") return null;
    if (id === newId && unavailable === "workspace-missing") {
      const snapshot = { ...fresh };
      Reflect.deleteProperty(snapshot, "workspaceId");
      return snapshot;
    }
    if (id === newId && unavailable === "workspace-null") return { ...fresh, workspaceId: null };
    if (id === newId && unavailable === "workspace-empty") return { ...fresh, workspaceId: "" };
    if (id === "old" && unavailable === "old-workspace-missing") return { ...f.old, workspaceId: null };
    return agent;
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    resetShiftClaimsForTests();
    await leaderSwap({} as never, input(), f.ports);
    const state = await settled();
    assert.equal(state.job?.phase, "failed");
    assert.equal(state.job?.step, "wait");
    assert.equal(state.job?.canContinue, true);
    assert.equal(state.job?.newId, newId);
    assert.equal(state.job?.detail, t(unavailable === "session" ? "shift.detail.sessionUnreadable" : "shift.detail.workspaceUnreadable", { newId }));
    const saved = JSON.parse(readFileSync(f.state, "utf8"))[0];
    assert.equal(saved.resume, "wait");
    assert.equal(saved.progress.newId, newId);
    assert.equal(f.creates.length, 1);
    assert.equal(f.archiveCount(), 0);
    assert.equal(JSON.parse(readFileSync(f.config, "utf8")).supervisors.demo, "old");
  }
  f.ports.getAgent = getAgent;
  resetShiftClaimsForTests();
  await leaderSwap({} as never, input(), f.ports);
  const completed = await settled();
  assert.equal(completed.job?.phase, "done");
  assert.equal(completed.job?.newId, newId);
  assert.equal(f.creates.length, 1);
  assert.equal(f.archiveCount(), 1);
});

test("a confirmed different workspace remains terminal across reloads without opening or archiving", async () => {
  const f = fixture(); f.fail("wait");
  await leaderSwap({} as never, input(), f.ports); await settled();
  f.fail(""); f.agents.get("new-1")!.workspaceId = "other-demo-workspace";
  resetShiftClaimsForTests();
  await leaderSwap({} as never, input(), f.ports);
  const state = await settled();
  assert.equal(state.job?.canContinue, false);
  assert.equal(state.job?.step, "wait");
  assert.equal(state.job?.detail, t("shift.detail.wrongWorkspace", { workspace: "other-demo-workspace" }));
  const calls = [...f.calls];
  resetShiftClaimsForTests();
  const repeated = await leaderSwap({} as never, input(), f.ports);
  assert.equal(repeated.ok, false);
  assert.deepEqual(f.calls, calls);
  assert.equal(f.creates.length, 1);
  assert.equal(f.archiveCount(), 0);
});

test("unexpected failure after creation logs the saved new id and resumes without another session", async () => {
  const f = fixture();
  f.ports.checkpoint = async row => { if (row.newId) throw new Error("Demo interruption after creation"); };
  await leaderSwap({} as never, input(), f.ports);
  const stopped = await settled();
  assert.equal(stopped.job?.phase, "failed");
  assert.equal(stopped.job?.newId, "new-1");
  const handoff = JSON.parse(readFileSync(f.log, "utf8").trim());
  assert.equal(handoff.newId, stopped.job?.newId);
  assert.equal(f.archiveCount(), 0);
  f.ports.checkpoint = undefined;
  resetShiftClaimsForTests();
  await leaderSwap({} as never, input(), f.ports);
  assert.equal((await settled()).job?.phase, "done");
  assert.equal(f.creates.length, 1);
  assert.equal(f.archiveCount(), 1);
});

test("completed swaps remain visible live but never reappear on the homepage after reload", async () => {
  const f = fixture();
  await leaderSwap({} as never, input(), f.ports);
  const completed = await settled();
  assert.equal(completed.job?.phase, "done");
  assert.equal(existsSync(f.state), false, "Completed swaps must leave the durable active state");
  resetShiftClaimsForTests();
  assert.equal((await inspectSupervisorShift("demo")).job, null);
  // Old versions persisted completed rows; ignore them without renewing the display window.
  writeFileSync(f.state, JSON.stringify([{ progress: completed.job, resume: "wait", queuedAt: null }]));
  resetShiftClaimsForTests();
  assert.equal((await inspectSupervisorShift("demo")).job, null);
  const calls = [...f.calls];
  const repeated = await leaderSwap({} as never, input(), f.ports);
  assert.equal(repeated.job?.phase, "done", "Completed command idempotency must use the handoff log");
  assert.deepEqual(f.calls, calls);
  assert.equal(f.archiveCount(), 1);
});

test("dry-run reads a plan without prompts, host mutations, state writes or logs", async () => {
  const f = fixture();
  const before = readFileSync(f.config, "utf8");
  const result = await leaderSwap({} as never, input({ dryRun: true }), f.ports);
  assert.equal(result.ok, true);
  assert.equal(result.plan?.title, f.old.title);
  assert.deepEqual(f.calls, ["get:old"]);
  assert.equal(readFileSync(f.config, "utf8"), before);
  assert.equal(existsSync(f.state), false);
  assert.equal(existsSync(f.log), false);
});

test("takeover reply without registration does not archive; a queue waits for idle", async () => {
  const f = fixture(); f.fail("registration");
  const failed = await runSupervisorShift({ clicked: true, project: "demo", code: "DEMO", agentId: "old", resume: "start", existingNewId: null, maxPolls: 1 }, f.ports);
  assert.equal(failed.progress.phase, "failed"); assert.equal(f.archiveCount(), 0);
  f.fail(""); f.old.status = "running";
  f.ports.sleep = async () => { f.old.status = "idle"; };
  const done = await runSupervisorShift({ clicked: true, project: "demo", code: "DEMO", agentId: "old", resume: "start", existingNewId: null }, f.ports);
  assert.equal(done.progress.phase, "done"); assert.equal(done.steps[0], "queued");
});

test("CLI prints all stages and JSON reports; dry-run and usage perform only read RPCs", async () => {
  const f = fixture(); const output: string[] = [], progress: string[] = [];
  const ports = { call: async (method: string, raw: unknown) => { assert.equal(method, "leader.swap"); return leaderSwap({} as never, leaderSwapRpc.input.parse(raw), f.ports); }, write: (value: string) => output.push(value), progress: (value: string) => progress.push(value), sleep: async () => { await new Promise(resolve => setTimeout(resolve, 5)); } };
  assert.equal(await runLeaderCli(["swap", "demo", "--dry-run", "--json"], ports), 0);
  assert.equal(JSON.parse(output.pop()!).dryRun, true); assert.deepEqual(f.calls, ["get:old"]);
  f.calls.length = 0; progress.length = 0;
  assert.equal(await runLeaderCli(["swap", "demo", "--json"], ports), 0);
  assert.equal(JSON.parse(output.pop()!).job.phase, "done");
  for (const step of ["handover", "open", "detach", "wait", "archive"]) assert.ok(progress.some(line => line.startsWith(`${step}:`)), step);
  const calls: string[] = [];
  const report = await readLeaderUsage({} as never, f.config, async id => f.agents.get(id) ?? null);
  assert.equal(report.rows[0].level, "warning");
  assert.equal(await runLeaderCli(["usage", "--json"], { ...ports, call: async method => { calls.push(method); return report; } }), 0);
  assert.deepEqual(calls, ["leader.usage"]);
  assert.equal(JSON.parse(output.pop()!).thresholds.warningTokens, 750000);
});

test("CLI failures name the step, both sessions, state and continuation command", async () => {
  const f = fixture(); f.fail("detach"); const lines: string[] = [];
  const code = await runLeaderCli(["swap", "demo"], { call: async (_, raw) => leaderSwap({} as never, leaderSwapRpc.input.parse(raw), f.ports), write: value => lines.push(value), progress: value => lines.push(value), sleep: async () => { await new Promise(resolve => setTimeout(resolve, 5)); } });
  assert.equal(code, 1);
  assert.ok(lines.some(line => line.includes("Swap stopped at detach") && line.includes("old=old, new=new-1") && line.includes("afc leader swap demo")));
  assert.equal(f.archiveCount(), 0);
});

test("Paseo adapter opens in the existing workspace with the original config and idempotency key", async () => {
  const f = fixture();
  const { supervisorShiftPorts } = await import("../supervisor-shift");
  const calls: string[] = [];
  let creation: any;
  let timelineReads = 0;
  const snapshot = { status: "idle", title: f.old.title, workspaceId: f.old.workspaceId, cwd: f.old.cwd, provider: f.old.provider, model: f.old.model, currentModeId: f.old.modeId, thinkingOptionId: f.old.thinkingOptionId, labels: f.old.labels, lastUsage: { contextWindowUsedTokens: 800000 } };
  const host = {
    agents: { ref: (id: string) => ({
      refresh: async () => ({ agent: snapshot }), current: () => snapshot,
      timeline: { refetch: async () => ({ epoch: "demo", window: { maxSeq: 0 }, error: null, entries: timelineReads++ === 0 ? [] : [{ seqStart: 1, item: { type: "assistant_message", text: handoverDoneReply() } }] }) },
      run: async () => { calls.push("handover"); return { status: "idle", lastMessage: handoverDoneReply() }; },
      detach: async () => { calls.push(`detach:${id}`); }, archive: async () => { calls.push(`archive:${id}`); },
      waitForFinish: async () => ({ lastMessage: takenOverReply() }),
    }) },
    workspaces: { ref: (id: string) => ({ agents: { create: async (input: unknown) => {
      assert.equal(id, f.old.workspaceId); creation = input; calls.push("open");
      return { id: "new-host", workspaceId: id, refresh: async () => null, current: () => ({ labels: { [PARENT_LABEL]: "old" } }) };
    } } }) },
  };
  const ports = supervisorShiftPorts(host as never, "demo", async () => false);
  const request = { ...f.old, workspaceId: f.old.workspaceId!, prompt: "Demo takeover", idempotencyKey: "demo-key" };
  await ports.getAgent("old");
  await ports.sendAndWait("old", "Demo handover", 100);
  const created = await ports.createAgent(request);
  await ports.detach(created.id); await ports.archive("old");
  assert.equal(creation.idempotencyKey, "demo-key");
  assert.deepEqual(creation.config, { provider: "demo-provider/demo-model", modeId: "demo-mode", thinkingOptionId: "demo-effort", featureValues: { demo: true } });
  assert.equal(creation.title, "Demo leader");
  assert.deepEqual(calls, ["handover", "open", "detach:new-host", "archive:old"]);
});

test("Paseo adapter keeps a permission receipt inside the handover wait", async () => {
  fixture();
  const { supervisorShiftPorts } = await import("../supervisor-shift");
  let sends = 0;
  let waits = 0;
  let timelineReads = 0;
  const host = { agents: { ref: () => ({
    timeline: { refetch: async () => ({ epoch: "demo", window: { maxSeq: 0 }, error: null, entries: timelineReads++ === 0 ? [] : [{ seqStart: 1, item: { type: "assistant_message", text: handoverDoneReply() } }] }) },
    run: async () => { sends++; return { status: "permission", final: null, lastMessage: "Earlier answer", error: null }; },
    waitForFinish: async () => { waits++; return { status: "idle", final: null, lastMessage: handoverDoneReply(), error: null }; },
  }) } };
  const done = await supervisorShiftPorts(host as never, "demo").sendAndWait("old", "Write handover", 5_000);
  assert.deepEqual(done, { timedOut: false, reply: handoverDoneReply(), error: null });
  assert.equal(sends, 1);
  assert.equal(waits, 1);
});

for (const provider of ["hermes", "hermes-leader"]) test(`${provider} handover binds its new identity before sending the full protocol`, async () => {
  const { supervisorShiftPorts } = await import("../supervisor-shift");
  const { identityFromToken } = await import("../../tokens");
  const { protocolFor } = await import("../../protocol");
  const { stableLauncherPath } = await import("../../stable-bin");
  let creation: any;
  let sent = false;
  let transferWaits = 0;
  const transferBudgets: number[] = [];
  const order: string[] = [];
  const host = { agents: { ref: (id: string) => ({
    refresh: async () => null, current: () => ({ status: "idle" }),
    send: async (text: string, options: any) => {
      assert.equal(id, "old");
      assert.ok(text.includes('"--project","demo","--from","old","--to","hermes-new"'));
      assert.ok(text.includes(stableLauncherPath()));
      assert.match(text, /The first item is the stable board command/);
      assert.doesNotMatch(text, /paseo-kanban\.mjs/);
      assert.equal(options.messageId, "hermes-transfer:hermes-test-key");
      assert.equal(options.activeTurnBehavior, "steer");
      assert.equal(identityFromToken(creation.env.KANBAN_TOKEN).agentId, "hermes-new");
      order.push("transfer");
    },
    waitForFinish: async (timeout: number) => {
      transferBudgets.push(timeout);
      if (++transferWaits === 1) return { status: "permission", final: null, lastMessage: "Earlier answer", error: null };
      writeFileSync(f.config, JSON.stringify({ supervisors: { demo: "hermes-new" } }));
      order.push("registered");
      return { status: "idle", final: null, lastMessage: "Transferred", error: null };
    },
  }) }, workspaces: { ref: () => ({ agents: { create: async (input: any) => {
    creation = input;
    assert.equal(input.prompt, undefined);
    assert.equal(input.env[BOARD_AGENT_ENV], "1");
    assert.equal(input.env.KANBAN_PROJECT, "demo");
    return { id: "hermes-new", refresh: async () => null, current: () => ({}),
      send: async (text: string, options: any) => {
        const identity = identityFromToken(input.env.KANBAN_TOKEN);
        assert.equal(identity.agentId, "hermes-new");
        assert.ok(text.includes(protocolFor("supervisor")));
        assert.ok(text.includes("Demo takeover"));
        assert.equal(options.messageId, "hermes-handover:hermes-test-key");
        order.push("successor-prompt");
        sent = true;
      },
    };
  } } }) } };
  const f = fixture();
  await supervisorShiftPorts(host as never, "demo", async () => false).createAgent({
    ...f.old, oldAgentId: "old", provider, workspaceId: f.old.workspaceId!,
    prompt: "Demo takeover", idempotencyKey: "hermes-test-key",
  });
  assert.equal(creation.env.KANBAN_CLI, stableLauncherPath());
  assert.equal(creation.config.provider, `${provider}/demo-model`);
  assert.equal(sent, true);
  assert.equal(transferWaits, 2);
  // Approving a tool call can take minutes; the transfer wait must not end at the old two-minute limit.
  assert.ok(transferBudgets[0] > 14 * 60_000 && transferBudgets[1] < transferBudgets[0]);
  assert.deepEqual(order, ["transfer", "registered", "successor-prompt"]);
});

test("lost Hermes create response reuses the token already held by the new session", async () => {
  const { supervisorShiftPorts } = await import("../supervisor-shift");
  const { identityFromToken } = await import("../../tokens");
  let firstToken = "";
  let attempts = 0;
  const host = { agents: { ref: () => ({
    refresh: async () => null, current: () => ({ status: "idle" }),
    send: async () => { writeFileSync(f.config, JSON.stringify({ supervisors: { demo: "hermes-recovered" } })); },
    waitForFinish: async () => ({ status: "idle", final: null, lastMessage: "Transferred", error: null }),
  }) }, workspaces: { ref: () => ({ agents: { create: async (input: any) => {
    if (++attempts === 1) { firstToken = input.env.KANBAN_TOKEN; throw new Error("response lost"); }
    assert.equal(input.env.KANBAN_TOKEN, firstToken);
    return { id: "hermes-recovered", refresh: async () => null, current: () => ({}), send: async () => {
      assert.equal(identityFromToken(firstToken).agentId, "hermes-recovered");
    } };
  } } }) } };
  const f = fixture();
  const request = { ...f.old, oldAgentId: "old", provider: "hermes", workspaceId: f.old.workspaceId!, prompt: "takeover", idempotencyKey: "hermes-lost-create" };
  await assert.rejects(supervisorShiftPorts(host as never, "demo", async () => false).createAgent(request), /response lost/);
  assert.equal(identityFromToken(firstToken).agentId, null);
  await supervisorShiftPorts(host as never, "demo", async () => false).createAgent(request);
  assert.equal(attempts, 2);
});

test("A leader-provider transfer that registered the successor proceeds even if the old turn then ends badly", async () => {
  const { supervisorShiftPorts } = await import("../supervisor-shift");
  const f = fixture();
  writeFileSync(f.config, JSON.stringify({ supervisors: { demo: "old" } }));
  let starts = 0;
  const host = {
    agents: { ref: () => ({ refresh: async () => null, current: () => ({ status: "idle" }), send: async () => undefined, waitForFinish: async () => {
      writeFileSync(f.config, JSON.stringify({ supervisors: { demo: "successor-after-error" } }));
      return { status: "error", final: null, lastMessage: null, error: "Provider failed after the command" };
    } }) },
    workspaces: { ref: () => ({ agents: { create: async () => ({
      id: "successor-after-error", refresh: async () => null, current: () => ({}), send: async () => { starts++; },
    }) } }) },
  };
  const request = { ...f.old, oldAgentId: "old", provider: "hermes", workspaceId: f.old.workspaceId!, prompt: "takeover", idempotencyKey: "successor-after-error-key" };
  await supervisorShiftPorts(host as never, "demo", async () => false).createAgent(request);
  assert.equal(starts, 1, "the registry, not the turn status, proves the transfer");
});

test("Hermes transfer fails closed and retries a lost acknowledgement without repeating the transfer", async () => {
  const { supervisorShiftPorts } = await import("../supervisor-shift");
  const f = fixture();
  let owner = "old";
  const setOwner = (id: string) => { owner = id; writeFileSync(f.config, JSON.stringify({ supervisors: { demo: id } })); };
  let transfers = 0;
  let starts = 0;
  let finishMode = "refuse";
  let status = "idle";
  let loseStartAck = false;
  const startMessageIds: string[] = [];
  const host = {
    agents: { ref: () => ({ refresh: async () => null, current: () => ({ status }), send: async () => { transfers++; }, waitForFinish: async () => {
      if (finishMode === "lost-ack") { setOwner("hermes-transfer-retry"); throw new Error("ack lost"); }
      return { status: "idle", final: null, lastMessage: "Refused", error: null };
    } }) },
    workspaces: { ref: () => ({ agents: { create: async () => ({
      id: "hermes-transfer-retry", refresh: async () => null, current: () => ({}),
      send: async (_text: string, options: any) => {
        assert.equal(owner, "hermes-transfer-retry"); starts++; startMessageIds.push(options.messageId);
        if (loseStartAck) { loseStartAck = false; throw new Error("start ack lost"); }
      },
    }) } }) },
  };
  const request = { ...f.old, oldAgentId: "old", provider: "hermes", workspaceId: f.old.workspaceId!, prompt: "takeover", idempotencyKey: "hermes-transfer-retry-key" };
  const ports = supervisorShiftPorts(host as never, "demo", async () => false);
  status = "running";
  await assert.rejects(ports.createAgent(request), /busy or awaiting permission/);
  assert.equal(transfers, 0);
  status = "idle";
  await assert.rejects(supervisorShiftPorts(host as never, "demo", async () => true).createAgent(request), /busy or awaiting permission/);
  assert.equal(transfers, 0);
  await assert.rejects(ports.createAgent(request), /not transferred/);
  assert.equal(starts, 0);
  setOwner("someone-else");
  await assert.rejects(ports.createAgent(request), /registration changed/);
  assert.equal(transfers, 1);
  setOwner("old"); finishMode = "lost-ack";
  await assert.rejects(ports.createAgent(request), /ack lost/);
  assert.equal(starts, 0);
  loseStartAck = true;
  await assert.rejects(ports.createAgent(request), /start ack lost/);
  await ports.createAgent(request);
  assert.equal(transfers, 2);
  assert.equal(starts, 2);
  assert.deepEqual(startMessageIds, ["hermes-handover:hermes-transfer-retry-key", "hermes-handover:hermes-transfer-retry-key"]);
});

test("Hermes fallback leader transfer uses its own registry and refuses a shared old identity", async () => {
  const { supervisorShiftPorts } = await import("../supervisor-shift");
  const { kanbanProjectName } = await import("../paths");
  const f = fixture();
  const project = kanbanProjectName();
  writeFileSync(f.config, JSON.stringify({ supervisorAgentId: "old" }));
  let creates = 0;
  let starts = 0;
  const host = {
    agents: { ref: () => ({ refresh: async () => null, current: () => ({ status: "idle" }),
      send: async (text: string) => { assert.ok(text.includes('"--kanban-leader"')); assert.ok(!text.includes('"--project"')); },
      waitForFinish: async () => { writeFileSync(f.config, JSON.stringify({ supervisorAgentId: "hermes-fallback" })); return { status: "idle", final: null, lastMessage: "Transferred", error: null }; },
    }) },
    workspaces: { ref: () => ({ agents: { create: async () => {
      creates++; return { id: "hermes-fallback", refresh: async () => null, current: () => ({}), send: async () => { starts++; } };
    } } }) },
  };
  const request = { ...f.old, oldAgentId: "old", provider: "hermes", workspaceId: f.old.workspaceId!, prompt: "takeover", idempotencyKey: "hermes-fallback-key" };
  await supervisorShiftPorts(host as never, project, async () => false).createAgent(request);
  assert.equal(starts, 1);
  for (const config of [
    { supervisorAgentId: "old", supervisors: { [project]: "old" } },
    { supervisors: { demo: "old", another: "old" } },
    { supervisors: { demo: "old", another: " old " } },
    { supervisorAgentId: "old", supervisors: { another: " old " } },
  ]) {
    writeFileSync(f.config, JSON.stringify(config));
    await assert.rejects(supervisorShiftPorts(host as never, "supervisorAgentId" in config ? project : "demo", async () => false).createAgent(request), /multiple registrations/);
  }
  assert.equal(creates, 1);
});

test("standalone bundled CLI exchanges Paseo 0.11 RPC frames with an isolated fake socket host", async () => {
  const { createRequire } = await import("node:module");
  const { spawn } = await import("node:child_process");
  const { copyFileSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  const { WebSocketServer } = createRequire(import.meta.url)("ws");
  const f = fixture();
  const commands = join(f.dir, "bin"); mkdirSync(commands);
  const { symlinkSync } = await import("node:fs");
  symlinkSync(resolve(import.meta.dirname, "../../../node_modules"), join(f.dir, "node_modules"), "dir");
  const source = resolve(import.meta.dirname, "../../../bin");
  for (const file of ["afc.mjs", "fleet-leader.bundle.mjs"]) copyFileSync(join(source, file), join(commands, file));
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>(resolve => server.on("listening", resolve));
  const endpoint = `127.0.0.1:${server.address().port}`;
  const methods: string[] = [];
  let rejectRpc = false;
  server.on("connection", (socket: any) => socket.on("message", async (raw: Buffer) => {
    const frame = JSON.parse(raw.toString());
    if (frame.type === "hello") {
      assert.equal(frame.protocolVersion, 1); assert.equal(frame.clientType, "cli"); assert.equal(frame.auth, undefined);
      socket.send(JSON.stringify({ type: "session", message: { type: "status", payload: { status: "server_info", serverId: "demo-server" } } })); return;
    }
    assert.equal(frame.type, "session"); const message = frame.message;
    assert.equal(message.type, "plugin.rpc.invoke.request"); assert.equal(message.pluginId, "paseo-kanban");
    methods.push(message.method);
    if (rejectRpc) { socket.send(JSON.stringify({ type: "session", message: { type: "rpc_error", payload: { requestId: message.requestId, error: "Demo unavailable RPC" } } })); return; }
    const output = message.method === "leader.swap" ? await leaderSwap({} as never, leaderSwapRpc.input.parse(message.input), f.ports) : await readLeaderUsage({} as never, f.config, async id => f.agents.get(id) ?? null);
    socket.send(JSON.stringify({ type: "session", message: { type: "plugin.rpc.invoke.response", payload: { requestId: message.requestId, output } } }));
  }));
  const run = (args: string[]) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [join(commands, "afc.mjs"), "leader", ...args, "--host", endpoint], { cwd: f.dir, env: { ...process.env, AFC_LANGUAGE: "en" } });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("Demo CLI exceeded deadline")); }, 15000);
    child.stdout.on("data", data => { stdout += data; }); child.stderr.on("data", data => { stderr += data; });
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("exit", code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
  try {
    const before = readFileSync(f.config, "utf8");
    const dry = await run(["swap", "demo", "--dry-run", "--json"]);
    assert.equal(dry.code, 0, dry.stderr); assert.equal(JSON.parse(dry.stdout).dryRun, true);
    assert.deepEqual(f.calls, ["get:old"]); assert.equal(existsSync(f.state), false); assert.equal(existsSync(f.log), false); assert.equal(readFileSync(f.config, "utf8"), before);
    const report = await run(["usage", "--json"]);
    assert.equal(report.code, 0, report.stderr); assert.equal(JSON.parse(report.stdout).rows[0].level, "warning");
    const swap = await run(["swap", "demo", "--json"]);
    assert.equal(swap.code, 0, swap.stderr); assert.equal(JSON.parse(swap.stdout).job.phase, "done");
    for (const step of ["handover", "open", "detach", "wait", "archive"]) assert.ok(swap.stderr.includes(`${step}:`));
    assert.equal(f.archiveCount(), 1);
    const repeated = await run(["swap", "demo", "--json"]); assert.equal(repeated.code, 0); assert.equal(f.archiveCount(), 1);
    rejectRpc = true;
    const failed = await run(["status", "demo", "--json"]); assert.equal(failed.code, 1); assert.ok(failed.stderr.includes("Demo unavailable RPC")); assert.ok(failed.stderr.includes("afc leader status demo"));
    assert.ok(methods.every(method => ["leader.swap", "leader.usage"].includes(method)));
  } finally {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("cancel refuses active swaps and clears stopped tracking without changing either session or registration", async () => {
  const f = fixture(); f.fail("detach");
  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const original = f.ports.sendAndWait;
  f.ports.sendAndWait = async (...args) => { await gate; return original(...args); };
  await leaderSwap({} as never, input(), f.ports);
  assert.equal((await leaderSwap({} as never, input({ action: "cancel" }), f.ports)).ok, false);
  release(); await settled();
  const state = readFileSync(f.state, "utf8"), config = readFileSync(f.config, "utf8"), calls = [...f.calls];
  assert.equal((await leaderSwap({} as never, input({ action: "cancel", dryRun: true }), f.ports)).ok, true);
  assert.equal(readFileSync(f.state, "utf8"), state); assert.deepEqual(f.calls, calls);
  const output: string[] = [];
  assert.equal(await runLeaderCli(["cancel", "demo", "--json"], { call: async (_, raw) => leaderSwap({} as never, leaderSwapRpc.input.parse(raw), f.ports), write: value => output.push(value), progress: () => {}, sleep: async () => {} }), 0);
  assert.equal(JSON.parse(output[0]).job, null);
  assert.equal(existsSync(f.state), false);
  assert.equal(readFileSync(f.config, "utf8"), config);
  assert.deepEqual(f.calls, calls); assert.equal(f.archiveCount(), 0);
  f.fail("");
  await leaderSwap({} as never, input(), f.ports); await settled();
  assert.equal(f.keys.size, 2, "A fresh swap after cancellation must not reuse the cancelled operation key");
});
