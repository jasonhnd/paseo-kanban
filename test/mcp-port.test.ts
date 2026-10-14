/// <reference types="node" />
import { zhCNPart, localePattern } from "./helpers/locale";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { closeDb, getDb } from "../server/db";
import { markRunningMcpStale, readSavedMcpPort, recordMcpListen, writeSavedMcpPort } from "../server/mcp-port";
import { startMcpServer } from "../server/mcp";
import { createTask, listBoard } from "../server/store";

const tmp = tmpdir();
mkdirSync(tmp, { recursive: true });
const dir = mkdtempSync(join(tmp, "mcp-port-"));
process.env.KANBAN_DATA_DIR = dir;

after(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe("stable mcp port", () => {
  it("binds the same port after a restart and switches when that port is taken", async () => {
    const first = await startMcpServer([], async () => ({ text: "ok" }));
    try {
    writeSavedMcpPort(first.port);
    assert.equal(readSavedMcpPort(), first.port);
    } finally { await first.close(); }

    const second = await startMcpServer([], async () => ({ text: "ok" }), { preferredPort: readSavedMcpPort() });
    try {
    assert.equal(second.port, first.port);
    assert.equal(second.replaced, false);
    } finally { await second.close(); }

    const hold = createServer();
    await new Promise<void>((resolve) => hold.listen(first.port, "127.0.0.1", () => resolve()));
    try {
    const moved = await startMcpServer([], async () => ({ text: "ok" }), { preferredPort: first.port, reclaimMs: 0 });
    try {
    assert.notEqual(moved.port, first.port);
    assert.equal(moved.replaced, true);
    } finally { await moved.close(); }
    } finally { await new Promise<void>((resolve, reject) => hold.close((err) => (err ? reject(err) : resolve()))); }
  });

  it("reclaims the saved port when the previous listener releases it", async () => {
    const hold = createServer();
    await new Promise<void>((resolve) => hold.listen(0, "127.0.0.1", () => resolve()));
    const address = hold.address();
    if (!address || typeof address === "string") throw new Error("hold listen failed");
    const port = address.port;
    const release = setTimeout(() => { hold.close(); }, 150);
    const started = Date.now();
    const options: { preferredPort: number; reclaimMs: number } = { preferredPort: port, reclaimMs: 1000 };
    const again = await startMcpServer([], async () => ({ text: "kanban-pong" }), options);
    try {
      assert.equal(again.replaced, false);
      assert.equal(again.port, port);
      assert.ok(Date.now() - started >= 100);
      assert.ok(Date.now() - started < 1000);
      const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "kanban_ping", arguments: {} } }),
      });
      const body = await response.json() as { result?: { content?: Array<{ text?: string }> } };
      assert.equal(body.result?.content?.[0]?.text, "kanban-pong");
    } finally {
      clearTimeout(release);
      await again.close();
      await new Promise<void>((resolve) => hold.close(() => resolve()));
    }
  });

  it("keeps the saved port file when a listen had to move", () => {
    writeSavedMcpPort(41234);
    recordMcpListen(41235, true);
    assert.equal(readSavedMcpPort(), 41234);
    recordMcpListen(41236, false);
    assert.equal(readSavedMcpPort(), 41236);
  });

  it("marks running agents when the port had to change", () => {
    const task = createTask({ project: "mcp", title: "still running", role: "executor", workspacePath: dir });
    getDb().prepare("UPDATE tasks SET status = 'running', agent_id = ? WHERE id = ?").run("agent-live", task.id);
    assert.equal(markRunningMcpStale(), 1);
    assert.equal(markRunningMcpStale(), 0);
    const card = listBoard("mcp").tasks.find((item) => item.id === task.id);
    assert.match(card?.mcpNote ?? "", new RegExp("MCP " + localePattern(zhCNPart("reclaimActions.tool.http", 14, 16)) + localePattern(zhCNPart("cleanup.wake.stepStopped", 14, 16)) + localePattern(zhCNPart("identity.tokenInvalid", 10, 11))));
    assert.match(card?.mcpNote ?? "", /bin\/paseo-kanban\.mjs complete/);
    assert.match(card?.mcpNote ?? "", /PASEO_AGENT_ID/);
    assert.doesNotMatch(card?.mcpNote ?? "", new RegExp(localePattern(zhCNPart("stall.nudge.quiet", 44, 46)) + localePattern(zhCNPart("compat.skip.kanbanEnv", 14, 16)) + localePattern(zhCNPart("tempWorkspace.drop.placeholderAgentsDeleted", 2, 5)) + "KANBAN_TOKEN"));
  });
});
