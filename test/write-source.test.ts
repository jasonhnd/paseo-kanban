import { runKanban } from "../server/cli";
/// <reference types="node" />
import { setLanguage } from "../shared/i18n";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { closeDb, getDb } from "../server/db";
import { startMcpServer } from "../server/mcp";
import { createTask, getTask } from "../server/store";
import { handleTool, toolDefs } from "../server/tools";
import { issueToken } from "../server/tokens";
import { auditWrite, completionHandoffWarnings, currentWriteSource, withWriteTransport } from "../server/write-source";

const dir = mkdtempSync(join(tmpdir(), "write-source-"));
const previous = { ...process.env };
for (const key of ["PASEO_HOME", "KANBAN_DATA_DIR"]) process.env[key] = dir;
process.env.KANBAN_AGENTS_DIR = join(dir, "agents");
mkdirSync(process.env.KANBAN_AGENTS_DIR, { recursive: true });
// A real CLI process must never bootstrap a connection to the user's daemon.
process.env.PASEO_URL = "ws://127.0.0.1:1/ws";
const handoff = { files: ["server/write-source.ts"], verification: "regressions passed", risks: [] };

function card(role = "executor") {
  const task = createTask({ project: "provenance", title: "Fix this card", role });
  const agentId = `worker-${task.id}`;
  getDb().prepare("UPDATE tasks SET status = 'running', agent_id = ? WHERE id = ?").run(agentId, task.id);
  const row = getDb().prepare("INSERT INTO runs (task_id, agent_id, role, started_at) VALUES (?, ?, ?, ?)")
    .run(task.id, agentId, role, new Date().toISOString());
  return { id: task.id, agentId, runId: Number(row.lastInsertRowid), token: issueToken(role, task.id, agentId) };
}

function audits(id: number) {
  return getDb().prepare("SELECT * FROM write_audits WHERE task_id = ? ORDER BY id").all(id) as Array<{
    operation: string; outcome: string; error_code: string | null; source_json: string;
  }>;
}

function assertCompletion(id: number, status = "in_review", invalidJson = false) {
  const task = getTask(id);
  assert.equal(task.status, status);
  const stored = JSON.parse(task.handoff_json!);
  assert.doesNotMatch(stored.summary, /thread\/turn provenance unverified/);
  assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND kind = 'completion_source_unverified'").get(id)?.n, 0);
  const events = getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'completion_handoff_invalid'").all(id);
  const comments = getDb().prepare("SELECT body FROM comments WHERE task_id = ? AND author = 'kanban'").all(id);
  assert.equal(events.length, 0, "handoff contents must not emit a format event");
  assert.equal(comments.length, 0, "handoff contents must not emit a kanban comment");
  if (invalidJson) assert.match(stored.submissionWarnings[0], /handoff.*JSON/);
  else assert.equal(stored.submissionWarnings, undefined);
  return stored;
}

let mcp: Awaited<ReturnType<typeof startMcpServer>>;
before(async () => {
  setLanguage("en"); process.env.KANBAN_LANGUAGE = "en";
  mcp = await startMcpServer(toolDefs(), async (name, args, token) => {
    try { return { text: JSON.stringify(await handleTool(name, args, token)) }; }
    catch { return { text: "rejected", isError: true }; }
  });
});
after(async () => {
  await mcp.close();
  closeDb();
  for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
  Object.assign(process.env, previous);
  rmSync(dir, { recursive: true, force: true });
});
afterEach(() => assert.equal(currentWriteSource(), null, "no call provenance may leak to the next request"));

function send(name: string, args: Record<string, unknown>, token: string, claimedThread?: string): Promise<{ result: { isError: boolean } }> {
  return new Promise((resolveReply, reject) => {
    const req = request({ host: "127.0.0.1", port: mcp.port, method: "POST", headers: {
      authorization: `Bearer ${token}`,
      // These attacker-controlled fields must never become trusted or audited provenance.
      ...(claimedThread ? { "x-paseo-thread-id": claimedThread, "mcp-session-id": claimedThread } : {}),
    } }, res => {
      const chunks: Buffer[] = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => resolveReply(JSON.parse(Buffer.concat(chunks).toString())));
    });
    req.on("error", reject);
    req.end(JSON.stringify({ jsonrpc: "2.0", id: claimedThread ?? 1, method: "tools/call", params: { name, arguments: args } }));
  });
}

describe("identity-only provenance mitigation", () => {
  it("only audits indistinguishable same-identity background MCP completion with valid handoff and forged main-thread fields", async () => {
    const c = card();
    const result = await send("kanban_complete", {
      summary: "Unrelated memory consolidation", handoff,
      threadId: "claimed-main", turnId: "claimed-turn", toolCallId: "claimed-tool", source: { provenance: "verified" },
    }, c.token, "claimed-main");
    assert.equal(result.result.isError, false);
    assert.deepEqual(assertCompletion(c.id).handoff, handoff);
    const audit = audits(c.id)[0]!;
    assert.equal(audit.outcome, "returned");
    const source = JSON.parse(audit.source_json);
    assert.equal(source.agentId, c.agentId);
    assert.equal(source.runId, c.runId);
    assert.equal(source.transport, "mcp");
    assert.equal(source.threadId, null);
    assert.equal(source.turnId, null);
    assert.equal(source.toolCallId, null);
    assert.ok(!audit.source_json.includes("claimed"));
    assert.ok(!audit.source_json.includes(c.token));
    assert.ok(!audit.source_json.includes("memory"));
  });

  it("only audits indistinguishable background CLI completion; inherited thread env cannot assert provenance", () => {
    const c = card();
    const result = spawnSync(resolve("bin/kanban"), ["complete", String(c.id), "--summary", "Unrelated memory consolidation", "--handoff", JSON.stringify(handoff), "--json"], {
      env: { ...process.env, KANBAN_TOKEN: c.token, PASEO_AGENT_ID: c.agentId,
        CODEX_THREAD_ID: "claimed-main", PASEO_TURN_ID: "claimed-turn", PASEO_TOOL_CALL_ID: "claimed-tool" },
      encoding: "utf8", timeout: 20_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).status, "in_review");
    assert.deepEqual(JSON.parse(assertCompletion(c.id).handoff), handoff);
    const rows = audits(c.id);
    assert.equal(rows.length, 1, "CLI/tool nesting should record exactly one call");
    const source = JSON.parse(rows[0]!.source_json);
    assert.equal(source.transport, "cli");
    assert.equal(source.agentId, c.agentId);
    assert.equal(source.runId, c.runId);
    assert.equal(source.threadId, null);
    assert.ok(!rows[0]!.source_json.includes("claimed"));
  });

  for (const via of ["MCP", "CLI"]) {
    it(`${via} keeps normal main-thread completion routing and valid handoff intact`, async () => {
      const c = card("reader");
      if (via === "MCP") assert.equal((await send("kanban_complete", { summary: "Normal card handoff", handoff }, c.token)).result.isError, false);
      else await runKanban(["complete", String(c.id), "--summary", "Normal card handoff", "--handoff", JSON.stringify(handoff)], { PASEO_AGENT_ID: c.agentId });
      const stored = assertCompletion(c.id, "acceptance");
      assert.deepEqual(typeof stored.handoff === "string" ? JSON.parse(stored.handoff) : stored.handoff, handoff);
      assert.equal(stored.summary, "Normal card handoff");
      assert.equal(audits(c.id).length, 1);
    });

    for (const [shape, detailed] of [
      ["verification object", { ...handoff, verification: { dependencies: "installed", unit: { pass: 24, fail: 0 }, fullSuite: "passed" } }],
      ["verification command objects", { ...handoff, verification: [{ command: "npm test", exitCode: 0, output: "all passed" }] }],
      ["file change objects", { ...handoff, files: [{ path: "server/write-source.ts", change: "audit only" }] }],
    ] as const) {
      it(`${via} only audits normal handoff with ${shape}`, async () => {
        const c = card();
        if (via === "MCP") assert.equal((await send("kanban_complete", { summary: "Detailed handoff", handoff: detailed }, c.token)).result.isError, false);
        else {
          const result = spawnSync(resolve("bin/kanban"), ["complete", String(c.id), "--summary", "Detailed handoff", "--handoff", JSON.stringify(detailed), "--json"], {
            env: { ...process.env, KANBAN_TOKEN: c.token }, encoding: "utf8", timeout: 20_000,
          });
          assert.equal(result.status, 0, result.stderr);
          assert.equal(JSON.parse(result.stdout).status, "in_review");
        }
        const stored = assertCompletion(c.id);
        assert.equal(stored.summary, "Detailed handoff");
        assert.deepEqual(typeof stored.handoff === "string" ? JSON.parse(stored.handoff) : stored.handoff, detailed);
        const rows = audits(c.id);
        assert.equal(rows.length, 1);
        assert.equal(rows[0]!.outcome, "returned");
        assert.equal(JSON.parse(rows[0]!.source_json).transport, via.toLowerCase());
      });
    }

    it(`${via} only audits arbitrary handoff field types without inventing a schema`, async () => {
      const c = card();
      const arbitrary = { files: [7], verification: [], risks: {} };
      if (via === "MCP") await send("kanban_complete", { summary: "Delivery", handoff: arbitrary }, c.token);
      else await runKanban(["complete", String(c.id), "--summary", "Delivery", "--handoff", JSON.stringify(arbitrary)], { KANBAN_TOKEN: c.token });
      assert.equal(assertCompletion(c.id).summary, "Delivery");
      assert.equal(audits(c.id).length, 1);
    });

    it(`${via} quietly accepts legacy completion without handoff`, async () => {
      const c = card();
      if (via === "MCP") await send("kanban_complete", { summary: "Legacy handoff" }, c.token);
      else await runKanban(["complete", String(c.id), "--summary", "Legacy handoff"], { KANBAN_TOKEN: c.token });
      const stored = assertCompletion(c.id);
      assert.equal(stored.summary, "Legacy handoff");
      assert.equal(audits(c.id).length, 1);
    });

    it(`${via} keeps invalid JSON notes only in submissionWarnings on direct acceptance`, async () => {
      const c = card("reader");
      if (via === "MCP") await send("kanban_complete", { summary: "Delivery", handoff: "memory only" }, c.token);
      else await runKanban(["complete", String(c.id), "--summary", "Delivery", "--handoff", "memory only"], { KANBAN_TOKEN: c.token });
      const stored = assertCompletion(c.id, "acceptance", true);
      assert.equal(stored.summary, "Delivery");
      assert.equal(stored.handoff, "memory only");
      assert.equal(audits(c.id).length, 1);
    });

    it(`${via} keeps invalid JSON notes only in submissionWarnings on executor completion`, async () => {
      const c = card();
      if (via === "MCP") await send("kanban_complete", { summary: "Delivery", handoff: "not JSON" }, c.token);
      else await runKanban(["complete", String(c.id), "--summary", "Delivery", "--handoff", "not JSON"], { KANBAN_TOKEN: c.token });
      const stored = assertCompletion(c.id, "in_review", true);
      assert.equal(stored.summary, "Delivery");
      assert.equal(stored.handoff, "not JSON");
      assert.equal(audits(c.id).length, 1);
    });

    it(`${via} records comment, block and refused obsolete-agent writes without credential values`, async () => {
      const c = card();
      if (via === "MCP") {
        await send("kanban_comment", { text: "progress" }, c.token);
        await send("kanban_block", { kind: "needs_human", reason: "Permission needed" }, c.token);
      } else {
        await runKanban(["comment", String(c.id), "--text", "progress"], { KANBAN_TOKEN: c.token });
        await runKanban(["block", String(c.id), "--kind", "needs_human", "--reason", "Permission needed"], { KANBAN_TOKEN: c.token });
      }
      getDb().prepare("UPDATE tasks SET agent_id = 'replacement' WHERE id = ?").run(c.id);
      if (via === "MCP") assert.equal((await send("kanban_complete", { summary: "bad", handoff }, c.token)).result.isError, true);
      else await assert.rejects(() => runKanban(["complete", String(c.id), "--summary", "bad"], { KANBAN_TOKEN: c.token }), /current agent/);
      const rows = audits(c.id);
      assert.equal(rows.length, 3);
      assert.deepEqual(rows.map(row => row.outcome), ["returned", "returned", "threw"]);
      assert.equal(rows[2]!.error_code, "forbidden");
      assert.equal(getTask(c.id).status, "blocked");
      assert.ok(rows.every(row => !row.source_json.includes(c.token)));
    });
  }

  it("audits CLI commands handled outside handleTool, including forbidden project writes", async () => {
    const c = card();
    await assert.rejects(() => runKanban(["project", "--project", "provenance", "--parallel", "off"], { KANBAN_TOKEN: c.token }), /Only a <leader>/);
    assert.equal(audits(c.id)[0]!.operation, "project");
    assert.equal(audits(c.id)[0]!.outcome, "threw");
  });

  for (const flag of ["--reset-failed", "--restore"]) {
    for (const credentials of ["absent", "rows-without-file", "existing-file"]) {
      it(`failed native-sessions ${flag} with empty identity env preserves ${credentials} supervisor credentials`, async () => {
        const isolated = mkdtempSync(join(dir, "native-credentials-"));
        const previousData = process.env.KANBAN_DATA_DIR;
        closeDb();
        process.env.KANBAN_DATA_DIR = isolated;
        try {
          // An empty initialized board; every credential below is a synthetic fixture.
          const db = getDb();
          const file = join(isolated, "supervisor.token");
          const marker = "synthetic-native-file-only";
          if (credentials !== "absent") {
            for (const serial of [1, 2]) db.prepare(`INSERT INTO tokens
              (token, role, task_id, agent_id, created_at, expires_at) VALUES (?, 'supervisor', NULL, ?, ?, ?)`)
              .run(`synthetic-native-row-${serial}`, `fixture-leader-${serial}`, `fixture-created-${serial}`, "2000-01-01T00:00:00.000Z");
          }
          if (credentials === "existing-file") writeFileSync(file, marker, { mode: 0o400 });
          const beforeFile = existsSync(file) ? statSync(file) : null;
          // Compare only non-secret metadata; do not dump credential values on failure.
          const rows = () => db.prepare("SELECT rowid, role, task_id, agent_id, created_at, expires_at FROM tokens ORDER BY rowid").all();
          const beforeRows = rows();
          await assert.rejects(() => runKanban(["native-sessions", flag, "missing-agent"], {}), /native session queue|single archive record/);
          assert.equal(existsSync(file), beforeFile != null, "failed command must not create a supervisor credential file");
          if (beforeFile) {
            const afterFile = statSync(file);
            assert.equal(afterFile.ino, beforeFile.ino, "existing credential file must not be replaced");
            assert.equal(afterFile.mode, beforeFile.mode, "existing credential file permissions must not change");
            assert.equal(afterFile.mtimeMs, beforeFile.mtimeMs, "existing credential file must not be rewritten");
            assert.ok(readFileSync(file, "utf8") === marker, "synthetic file contents must remain unchanged");
          }
          assert.deepEqual(rows(), beforeRows, "failed command must not create or rotate credential rows");
          const audit = db.prepare("SELECT operation, outcome, error_code, source_json FROM write_audits").get()!;
          assert.equal(audit.operation, "native-sessions");
          assert.equal(audit.outcome, "threw");
          assert.equal(audit.error_code, flag === "--reset-failed" ? "not_found" : "invalid");
          assert.equal(JSON.parse(String(audit.source_json)).transport, "cli");
          assert.equal(JSON.parse(String(audit.source_json)).agentId, null);
        } finally {
          closeDb();
          process.env.KANBAN_DATA_DIR = previousData;
        }
      });
    }
  }

  it("keeps simultaneous HTTP callers' identity, run and request ids separate", async () => {
    const a = card(), b = card();
    await Promise.all([send("kanban_complete", { summary: "A", handoff }, a.token), send("kanban_complete", { summary: "B", handoff }, b.token)]);
    const left = JSON.parse(audits(a.id)[0]!.source_json), right = JSON.parse(audits(b.id)[0]!.source_json);
    assert.equal(left.agentId, a.agentId);
    assert.equal(right.agentId, b.agentId);
    assert.equal(left.runId, a.runId);
    assert.equal(right.runId, b.runId);
    assert.notEqual(left.requestId, right.requestId);
  });

  it("audits authentication failures in MCP and CLI without retaining supplied credentials", async () => {
    const invalid = "synthetic-invalid-credential";
    assert.equal((await send("kanban_comment", { text: "untrusted" }, invalid)).result.isError, true);
    await assert.rejects(() => runKanban(["complete", "1", "--summary", "untrusted"], { KANBAN_TOKEN: invalid }), /token/);
    const rows = getDb().prepare("SELECT role, source_json, outcome, error_code FROM write_audits WHERE role = 'unauthenticated'").all();
    assert.equal(rows.length, 2);
    assert.ok(!JSON.stringify(rows).includes(invalid));
    for (const row of rows) {
      assert.equal(row.error_code, "unauthorized");
      assert.equal(row.outcome, "threw");
      assert.equal(JSON.parse(String(row.source_json)).agentId, null);
    }
  });

  it("does not audit read tools or turn missing transport into trusted provenance", async () => {
    const c = card();
    await send("kanban_show", {}, c.token);
    assert.equal(audits(c.id).length, 0);
    await handleTool("kanban_comment", { text: "in-process" }, c.token);
    assert.equal(JSON.parse(audits(c.id)[0]!.source_json).transport, "in-process");
  });

  it("does not serialize thrown error messages or caller arguments into the audit", async () => {
    const c = card();
    const secret = "test-only-secret-should-not-be-stored";
    await assert.rejects(() => withWriteTransport("mcp", () => auditWrite("kanban_comment", { role: "executor", taskId: c.id, agentId: c.agentId }, () => { throw new Error(secret); })), /test-only-secret/);
    assert.equal(audits(c.id)[0]!.error_code, "internal");
    assert.ok(!JSON.stringify(audits(c.id)).includes(secret));
  });

  it("only notes invalid JSON strings without checking field types or trusting handoff.source", async () => {
    const c = card();
    await auditWrite("kanban_complete", { role: "executor", taskId: c.id, agentId: c.agentId }, () => {
      assert.equal(completionHandoffWarnings(JSON.stringify(handoff)).length, 0);
      for (const legacy of [undefined, null, {}, "null", { files: [] }, { source: "verified" }]) {
        assert.deepEqual(completionHandoffWarnings(legacy), [], "absent optional fields are not a suspicious signal");
      }
      for (const arbitrary of [[], 7, "[]", "7", '"text"', { files: [7], verification: [], risks: {}, source: "verified" }]) {
        assert.deepEqual(completionHandoffWarnings(arbitrary), []);
      }
      assert.match(completionHandoffWarnings("bad json")[0]!, /handoff.*JSON/);
      assert.equal(completionHandoffWarnings({ files: [], verification: ["passed"], risks: "none" }).length, 0);
    });
  });
});
