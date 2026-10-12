/// <reference types="node" />
import assert from "node:assert/strict";
import { request, type IncomingHttpHeaders } from "node:http";
import { afterEach, beforeEach, describe, it } from "node:test";
import { startMcpServer, type McpCaller, type McpTool } from "../server/mcp";

const TOOLS: McpTool[] = [{ name: "kanban_ping", description: "ping", inputSchema: { type: "object" } }];

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

function send(port: number, method: string, body?: string, headers: Record<string, string> = {}, path = "/"): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const rpc = (method: string, params?: unknown, id: number | null = 1) => JSON.stringify({ jsonrpc: "2.0", id, method, params });

describe("mcp http server", () => {
  const calls: { name: string; args: Record<string, unknown>; token: string | null }[] = [];
  let reply: Awaited<ReturnType<McpCaller>> = { text: "pong" };
  let server: Awaited<ReturnType<typeof startMcpServer>>;
  const originalLog = console.log;
  const originalError = console.error;
  const logged: string[] = [];

  beforeEach(async () => {
    calls.length = 0;
    reply = { text: "pong" };
    logged.length = 0;
    console.log = (...args: unknown[]) => { logged.push(args.join(" ")); };
    console.error = (...args: unknown[]) => { logged.push(args.join(" ")); };
    server = await startMcpServer(TOOLS, async (name, args, token) => {
      calls.push({ name, args, token });
      return reply;
    });
  });

  afterEach(async () => {
    console.log = originalLog;
    console.error = originalError;
    await server.close();
  });

  it("answers initialize with the requested protocol version and a session id", async () => {
    const res = await send(server.port, "POST", rpc("initialize", { protocolVersion: "2024-11-05" }));
    const parsed = JSON.parse(res.body);
    assert.equal(res.status, 200);
    assert.equal(res.headers["mcp-session-id"], "paseo-kanban");
    assert.equal(parsed.result.protocolVersion, "2024-11-05");
    assert.equal(parsed.result.serverInfo.name, "paseo-kanban");
  });

  it("falls back to the default protocol version", async () => {
    const res = await send(server.port, "POST", rpc("initialize"));
    assert.equal(JSON.parse(res.body).result.protocolVersion, "2025-03-26");
  });

  it("answers ping with an empty result and lists the tools", async () => {
    const ping = await send(server.port, "POST", rpc("ping"));
    const list = await send(server.port, "POST", rpc("tools/list"));
    assert.deepEqual(JSON.parse(ping.body).result, {});
    assert.deepEqual(JSON.parse(list.body).result.tools, TOOLS);
    assert.equal(list.headers["mcp-session-id"], undefined);
  });

  it("passes tool calls to the caller with the bearer token", async () => {
    reply = { text: "done" };
    const res = await send(server.port, "POST", rpc("tools/call", { name: "kanban_ping", arguments: { a: 1 } }), { authorization: "Bearer abc123" });
    const result = JSON.parse(res.body).result;
    assert.deepEqual(calls, [{ name: "kanban_ping", args: { a: 1 }, token: "abc123" }]);
    assert.deepEqual(result, { content: [{ type: "text", text: "done" }], isError: false });
  });

  it("reports an error result from the caller", async () => {
    reply = { text: "nope", isError: true };
    const res = await send(server.port, "POST", rpc("tools/call", { name: "x" }));
    assert.equal(JSON.parse(res.body).result.isError, true);
    assert.deepEqual(calls[0]?.args, {});
  });

  it("only reads the token from the Authorization: Bearer header, never from the URL or another header", async () => {
    await send(server.port, "POST", rpc("tools/call", { name: "a" }), { authorization: "Bearer  header-token " });
    await send(server.port, "POST", rpc("tools/call", { name: "b" }), {}, "/?token=query-token");
    await send(server.port, "POST", rpc("tools/call", { name: "c" }), { "x-kanban-token": "x-token" }, "/mcp?token=query-token");
    await send(server.port, "POST", rpc("tools/call", { name: "d" }));
    assert.deepEqual(calls.map((call) => call.token), ["header-token", null, null, null]);
  });

  it("acknowledges notifications without a body", async () => {
    const res = await send(server.port, "POST", rpc("notifications/initialized", undefined, null));
    assert.equal(res.status, 202);
    assert.equal(res.body, "");
  });

  it("replies in event-stream form when the client only accepts SSE", async () => {
    const res = await send(server.port, "POST", rpc("ping"), { accept: "text/event-stream" });
    assert.equal(res.headers["content-type"], "text/event-stream");
    assert.match(res.body, /^event: message\ndata: \{"jsonrpc":"2.0","id":1,"result":\{\}\}\n\n$/);
  });

  it("prefers JSON when the client accepts both", async () => {
    const res = await send(server.port, "POST", rpc("ping"), { accept: "application/json, text/event-stream" });
    assert.equal(res.headers["content-type"], "application/json");
  });

  it("returns a JSON-RPC error for an unknown method, as SSE when asked", async () => {
    const json = await send(server.port, "POST", rpc("nope"));
    const sse = await send(server.port, "POST", rpc("nope"), { accept: "text/event-stream" });
    assert.equal(JSON.parse(json.body).error.code, -32601);
    assert.match(sse.body, /unknown method nope/);
    assert.equal(sse.headers["content-type"], "text/event-stream");
  });

  it("rejects bodies that are not JSON", async () => {
    const res = await send(server.port, "POST", "{not json");
    assert.equal(res.status, 400);
    assert.equal(JSON.parse(res.body).error.code, -32700);
  });

  it("refuses GET, accepts DELETE, and rejects other methods", async () => {
    assert.equal((await send(server.port, "GET")).status, 405);
    assert.equal((await send(server.port, "DELETE")).status, 204);
    const put = await send(server.port, "PUT", "{}");
    assert.equal(put.status, 405);
    assert.equal(JSON.parse(put.body).error, "method");
  });

  it("answers 500 when the caller throws before any header is sent", async () => {
    server = await replaceServer(server, async () => { throw new Error("boom"); });
    const res = await send(server.port, "POST", rpc("tools/call", { name: "x" }));
    assert.equal(res.status, 500);
    assert.equal(JSON.parse(res.body).error.message, "internal");
    assert.equal(logged.some((line) => line.includes("mcp handler boom")), true);
  });

  it("rejects a body over one megabyte", async () => {
    const big = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", pad: "x".repeat(1_100_000) });
    await assert.rejects(send(server.port, "POST", big));
  });
});

async function replaceServer(old: Awaited<ReturnType<typeof startMcpServer>>, call: McpCaller) {
  await old.close();
  return startMcpServer(TOOLS, call);
}
