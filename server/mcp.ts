/// <reference types="node" />
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { withWriteTransport } from "./write-source";

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpCallResult {
  text: string;
  isError?: boolean;
}

export type McpCaller = (name: string, args: Record<string, unknown>, token: string | null) => Promise<McpCallResult>;

interface JsonRpc {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: { name?: string; arguments?: Record<string, unknown> };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** The token rides only in `Authorization: Bearer`. URLs end up in logs and process listings, so a query string is not read. */
function tokenFrom(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== "string" || !/^bearer\s+/i.test(header)) return null;
  return header.replace(/^bearer\s+/i, "").trim() || null;
}

function sendJson(res: ServerResponse, status: number, body: unknown, session: boolean): void {
  const raw = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(raw),
    ...(session ? { "Mcp-Session-Id": "paseo-kanban" } : {}),
  });
  res.end(raw);
}

function sendSse(res: ServerResponse, body: unknown): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "close",
    "Mcp-Session-Id": "paseo-kanban",
  });
  res.end(`event: message\ndata: ${JSON.stringify(body)}\n\n`);
}

function wantsSse(req: IncomingMessage): boolean {
  const accept = String(req.headers.accept ?? "");
  return accept.includes("text/event-stream") && !accept.includes("application/json");
}

function listenOn(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.off("error", onError);
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("mcp listen failed"));
        return;
      }
      resolve(addr.port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

function release(server: Server): Promise<void> {
  return new Promise((done, reject) => {
    if (typeof server.closeAllConnections === "function") server.closeAllConnections();
    server.close((err) => (err ? reject(err) : done()));
  });
}

export function startMcpServer(
  tools: McpTool[],
  call: McpCaller,
  options?: { preferredPort?: number | null },
): Promise<{ url: string; port: number; replaced: boolean; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    void handle(req, res, tools, call).catch((err) => {
      console.error("[paseo-kanban] mcp handler", err instanceof Error ? err.message : err);
      if (!res.headersSent) sendJson(res, 500, { jsonrpc: "2.0", id: null, error: { code: -32603, message: "internal" } }, false);
    });
  });
  const preferred = options?.preferredPort && options.preferredPort > 0 ? options.preferredPort : 0;
  const finish = (port: number, replaced: boolean) => {
    const url = `http://127.0.0.1:${port}`;
    console.log(`[paseo-kanban] mcp listening ${url}`);
    return { url, port, replaced, close: () => release(server) };
  };
  if (!preferred) {
    return listenOn(server, 0).then((port) => finish(port, false));
  }
  return listenOn(server, preferred)
    .then((port) => finish(port, false))
    .catch((err: NodeJS.ErrnoException) => {
      if (err.code !== "EADDRINUSE") throw err;
      console.log(`[paseo-kanban] mcp port ${preferred} in use, binding a new port`);
      return listenOn(server, 0).then((port) => finish(port, true));
    });
}

async function handle(req: IncomingMessage, res: ServerResponse, tools: McpTool[], call: McpCaller): Promise<void> {
  const remote = req.socket.remoteAddress ?? "";
  if (remote !== "127.0.0.1" && remote !== "::ffff:127.0.0.1" && remote !== "::1") {
    sendJson(res, 403, { error: "loopback only" }, false);
    return;
  }
  if (req.method === "GET") {
    sendJson(res, 405, { jsonrpc: "2.0", id: null, error: { code: -32000, message: "sse stream not offered" } }, false);
    return;
  }
  if (req.method === "DELETE") {
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "method" }, false);
    return;
  }
  const raw = await readBody(req);
  let msg: JsonRpc;
  try {
    msg = JSON.parse(raw) as JsonRpc;
  } catch {
    sendJson(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }, false);
    return;
  }
  const method = msg.method ?? "";
  console.log(`[paseo-kanban] mcp ${method}`);
  if (method.startsWith("notifications/")) {
    res.writeHead(202);
    res.end();
    return;
  }
  const id = msg.id ?? null;
  let result: unknown;
  if (method === "initialize") {
    const params = msg.params as { protocolVersion?: string } | undefined;
    result = {
      protocolVersion: params?.protocolVersion || "2025-03-26",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "paseo-kanban", version: "0.1.0" },
      instructions: "Paseo Kanban tools. Call kanban_ping to check the connection.",
    };
  } else if (method === "ping" || method === "tools/list") {
    result = method === "ping" ? {} : { tools };
  } else if (method === "tools/call") {
    const name = msg.params?.name ?? "";
    const args = msg.params?.arguments ?? {};
    const token = tokenFrom(req);
    const out = await withWriteTransport("mcp", () => call(name, args, token));
    result = { content: [{ type: "text", text: out.text }], isError: Boolean(out.isError) };
  } else {
    const error = { jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method ${method}` } };
    if (wantsSse(req)) sendSse(res, error);
    else sendJson(res, 200, error, false);
    return;
  }
  const body = { jsonrpc: "2.0", id, result };
  if (wantsSse(req)) sendSse(res, body);
  else sendJson(res, 200, body, method === "initialize");
}
