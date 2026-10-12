import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, it } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "leader-start-"));
process.env.KANBAN_DATA_DIR = join(dir, "data");
process.env.KANBAN_AGENTS_DIR = join(dir, "agents");
process.env.KANBAN_PASEO_CONFIG = join(dir, "config.json");
mkdirSync(join(dir, "agents", "bucket"), { recursive: true });
writeFileSync(join(dir, "config.json"), JSON.stringify({ daemon: { agentProfiles: [
  ...["claude", "codex", "grok"].map((provider) => ({ id: provider, name: `Demo ${provider} leader`, provider, role: "supervisor", model: "demo-model" })),
  { id: "worker", name: "Worker", provider: "codex", role: "executor" },
  { id: "incomplete", name: "Incomplete leader", provider: "codex", role: "supervisor" },
] } }));

const { BOARD_AGENT_ENV } = await import("../server/agent-env");
const { previewLeader, recoverLeader, startLeader, leaderStatus, leaderOptions } = await import("../server/leader-start");
const { boundedCreateHook, resetCliEnv } = await import("../server/inject");
const { closeDb } = await import("../server/db");
const { handleTool } = await import("../server/tools");
const { setProjectCode, setProjectSupervisor } = await import("../server/config");
type LeaderStartHost = import("../server/leader-start").LeaderStartHost;

resetCliEnv();
after(() => { closeDb(); rmSync(dir, { recursive: true, force: true }); });

let sequence = 0;
function fixture(project: string, hooks: { missing?: boolean; sendFail?: boolean; createFail?: boolean } = {}) {
  setProjectCode(project, `EX${++sequence}`);
  const sent: string[] = [];
  const creates: Array<Parameters<LeaderStartHost["create"]>[0]> = [];
  const agentId = `demo-${project}-leader`;
  let token = "";
  const host: LeaderStartHost = {
    workspaces: async () => [{ id: "demo-main", path: dir }],
    async create(input) {
      creates.push(input);
      if (hooks.createFail) throw new Error("lost response");
      const next = await boundedCreateHook({ config: { ...input.config, cwd: dir }, env: input.env }, {
        baseUrl: "http://127.0.0.1:9",
        supervisorToken: null,
        ...(hooks.missing ? { optional: () => Promise.reject(new Error("protocol failed")) } : {}),
      });
      token = next!.env!.KANBAN_TOKEN!;
      assert.equal(next?.env?.[BOARD_AGENT_ENV], "1");
      assert.equal(next?.env?.KANBAN_ROLE, "supervisor");
      assert.match(next!.env!.KANBAN_TMP!, /kanban-leaders/);
      writeFileSync(join(dir, "agents", "bucket", `${agentId}.json`), JSON.stringify({ id: agentId, cwd: dir, labels: { kanban: "leader", role: "supervisor" }, lastStatus: "idle" }));
      return { id: agentId };
    },
    async send(_id, text) {
      if (hooks.sendFail) throw new Error("delivery failed");
      sent.push(text);
    },
  };
  return { host, hooks, sent, creates, token: () => token, agentId };
}

it("creates all three provider configs through the actual hook and requires self-registration", async () => {
  for (const provider of ["claude", "codex", "grok"]) {
    const project = `demo-${provider}`;
    const box = fixture(project);
    const input = { project, profileId: provider, workspaceId: "demo-main", language: "en" as const };
    const preview = await previewLeader(input, box.host);
    assert.match(preview.protocol, /kanban_supervise/);
    const result = await startLeader({ ...input, requestId: preview.requestId }, box.host);
    assert.equal(result.state, "ready");
    assert.equal(box.creates[0]!.config.provider, `${provider}/demo-model`);
    assert.equal(box.sent.length, 1);
    await assert.rejects(handleTool("kanban_create", { project, title: "Premature", role: "executor" }, box.token()), { code: "forbidden" });
    await handleTool("kanban_supervise", { project }, box.token());
    assert.equal((await leaderStatus(project, box.host))?.state, "registered");
    const card = await handleTool("kanban_create", { project, title: "Hello", role: "executor" }, box.token()) as { created_by_agent: string };
    assert.equal(card.created_by_agent, box.agentId);
  }
});

it("reuses pending and successful starts on duplicate clicks and refuses a live registration", async () => {
  const box = fixture("duplicates");
  const input = { project: "duplicates", profileId: "codex", workspaceId: "demo-main", language: "en" as const };
  const preview = await previewLeader(input, box.host);
  const [first, second] = await Promise.all([
    startLeader({ ...input, requestId: preview.requestId }, box.host),
    startLeader({ ...input, requestId: preview.requestId }, box.host),
  ]);
  assert.equal(box.creates.length, 1);
  assert.equal(first.requestId, second.requestId);
  assert.equal((await startLeader({ ...input, requestId: preview.requestId }, box.host)).agentId, box.agentId);
  await handleTool("kanban_supervise", { project: "duplicates" }, box.token());
  await assert.rejects(previewLeader(input, box.host), { code: "conflict" });
});

it("projects registration consistently after revocation or replacement while the session remains alive", async () => {
  const project = "registration-changes";
  const box = fixture(project);
  const input = { project, profileId: "codex", workspaceId: "demo-main", language: "en" as const };
  await startLeader({ ...input, requestId: (await previewLeader(input, box.host)).requestId }, box.host);
  await handleTool("kanban_supervise", { project }, box.token());

  assert.equal((await leaderStatus(project, box.host))?.state, "registered");
  const registeredOptions = await leaderOptions(project, box.host);
  assert.equal(registeredOptions.start?.state, "registered");
  assert.equal(registeredOptions.existingAgentId, box.agentId);
  assert.deepEqual(registeredOptions.start, await leaderStatus(project, box.host));

  setProjectSupervisor(project, null);
  const revokedOptions = await leaderOptions(project, box.host);
  assert.equal(revokedOptions.start?.state, "ready");
  assert.equal(revokedOptions.start?.agentId, box.agentId);
  assert.equal(revokedOptions.existingAgentId, null);
  assert.deepEqual(revokedOptions.start, await leaderStatus(project, box.host));
  await assert.rejects(handleTool("kanban_create", { project, title: "Revoked", role: "executor" }, box.token()), { code: "forbidden" });

  await handleTool("kanban_supervise", { project }, box.token());
  // Options must reflect the registry even before status persists registration.
  assert.equal((await leaderOptions(project, box.host)).start?.state, "registered");
  assert.equal((await leaderStatus(project, box.host))?.state, "registered");
  const replacementId = "demo-replacement-leader";
  writeFileSync(join(dir, "agents", "bucket", `${replacementId}.json`), JSON.stringify({ id: replacementId, cwd: dir, lastStatus: "idle" }));
  setProjectSupervisor(project, replacementId);
  const replacedOptions = await leaderOptions(project, box.host);
  assert.equal(replacedOptions.start?.state, "conflict");
  assert.equal(replacedOptions.existingAgentId, replacementId);
  assert.deepEqual(replacedOptions.start, await leaderStatus(project, box.host));
  await assert.rejects(handleTool("kanban_create", { project, title: "Replaced", role: "executor" }, box.token()), { code: "forbidden" });

  setProjectSupervisor(project, null);
  assert.equal((await leaderStatus(project, box.host))?.state, "ready");
  assert.deepEqual((await leaderOptions(project, box.host)).start, await leaderStatus(project, box.host));
  assert.equal(box.creates.length, 1);
  assert.equal(box.sent.length, 1);
});

it("does not send or register when the optional protocol fails, and retries delivery in the same session", async () => {
  const missing = fixture("missing-protocol", { missing: true });
  const input = { project: "missing-protocol", profileId: "grok", workspaceId: "demo-main", language: "zh-CN" as const };
  const result = await startLeader({ ...input, requestId: (await previewLeader(input, missing.host)).requestId }, missing.host);
  assert.equal(result.state, "protocol-missing");
  assert.equal(missing.sent.length, 0);
  assert.equal((await leaderStatus(input.project, missing.host))?.state, "protocol-missing");
  const recovered = await recoverLeader(input.project, missing.host);
  assert.equal(recovered.deliveryMode, "session-message");
  assert.match(missing.sent[0]!, /not a systemPrompt update/);
  assert.equal(missing.creates.length, 1);
  const failed = fixture("delivery", { sendFail: true });
  const sendInput = { ...input, project: "delivery" };
  const fail = await startLeader({ ...sendInput, requestId: (await previewLeader(sendInput, failed.host)).requestId }, failed.host);
  assert.equal(fail.state, "delivery-failed");
  failed.hooks.sendFail = false;
  assert.equal((await leaderStatus("delivery", failed.host))?.state, "ready");
  assert.equal(failed.creates.length, 1);
});

it("retains uncertain create results without duplicate creation, and validates project, profile and workspace", async () => {
  const box = fixture("uncertain", { createFail: true });
  const input = { project: "uncertain", profileId: "claude", workspaceId: "demo-main", language: "en" as const };
  const requestId = (await previewLeader(input, box.host)).requestId;
  assert.equal((await startLeader({ ...input, requestId }, box.host)).state, "pending");
  assert.equal((await startLeader({ ...input, requestId }, box.host)).state, "pending");
  assert.equal(box.creates.length, 1);
  await assert.rejects(previewLeader({ ...input, project: "absent" }, box.host), { code: "invalid" });
  await assert.rejects(previewLeader({ ...input, profileId: "worker" }, box.host), { code: "invalid" });
  await assert.rejects(previewLeader({ ...input, profileId: "incomplete" }, box.host), { code: "invalid" });
  await assert.rejects(previewLeader({ ...input, workspaceId: "unrelated" }, box.host), { code: "invalid" });
  assert.equal((await leaderOptions("uncertain", box.host)).profiles.length, 3);
});
