import { randomUUID } from "node:crypto";
import { t } from "../../shared/fleet/i18n";

/** Minimal local Paseo 0.11 plugin RPC transport; no agent or provider actions live here. */
export class LeaderRpcClient {
  private socket: InstanceType<typeof globalThis.WebSocket> | null = null;
  private ready = false;
  private rejectConnect: ((error: Error) => void) | null = null;
  private pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  constructor(private readonly url: string, private readonly timeoutMs = 10000) {}

  async connect(): Promise<void> {
    const socket = new WebSocket(this.url);
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error(t("leader.cli.timeout"))), this.timeoutMs);
      this.rejectConnect = error => { clearTimeout(timer); reject(error); };
      socket.addEventListener("open", () => socket.send(JSON.stringify({ type: "hello", clientId: "afc-leader-cli", clientType: "cli", protocolVersion: 1, capabilities: { hello_rejection: true } })));
      socket.addEventListener("message", event => {
        if (typeof event.data !== "string") return;
        let envelope;
        try { envelope = JSON.parse(event.data); } catch { return; }
        if (envelope?.type === "hello.rejected") { this.fail(new Error(t("leader.cli.rejected", { reason: String(envelope.reason) }))); return; }
        const message = envelope?.type === "session" ? envelope.message : null;
        if (!message) return;
        if (message.type === "status" && message.payload?.status === "server_info" && typeof message.payload.serverId === "string") {
          clearTimeout(timer); this.rejectConnect = null; this.ready = true; resolve(); return;
        }
        const entry = this.pending.get(message.payload?.requestId);
        if (!entry || !["rpc_error", "plugin.rpc.invoke.response"].includes(message.type)) return;
        clearTimeout(entry.timer); this.pending.delete(message.payload.requestId);
        if (message.type === "rpc_error") entry.reject(new Error(String(message.payload.error)));
        else entry.resolve(message.payload.output);
      });
      socket.addEventListener("error", () => this.fail(new Error(t("leader.cli.transportError"))));
      socket.addEventListener("close", () => this.fail(new Error(t("leader.cli.transportClosed"))));
    });
  }

  call(method: string, input: unknown): Promise<unknown> {
    if (!this.socket || !this.ready) return Promise.reject(new Error(t("leader.cli.transportClosed")));
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error(t("leader.cli.timeout"))); }, this.timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      try { this.socket!.send(JSON.stringify({ type: "session", message: { type: "plugin.rpc.invoke.request", requestId, pluginId: "paseo-kanban", method, input } })); }
      catch (error) { clearTimeout(timer); this.pending.delete(requestId); reject(error); }
    });
  }

  private fail(error: Error): void {
    this.ready = false;
    this.rejectConnect?.(error); this.rejectConnect = null;
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    this.pending.clear();
  }
  close(): void {
    this.fail(new Error(t("leader.cli.transportClosed")));
    this.socket?.close(); this.socket = null;
  }
}
