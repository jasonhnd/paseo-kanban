import assert from "node:assert/strict";
import "./helpers/window-stub";
import { register } from "node:module";
import { it } from "node:test";
import React, { act } from "react";
import TestRenderer from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PluginRpcProvider } from "../node_modules/@getpaseo/plugin/dist/client/rpc-context.js";
import { boardCard, boardSnapshot } from "./helpers/board-fixture";
import { DEFAULT_PANEL_PREFS } from "../shared/panel-prefs";
import { DARK_THEME } from "./helpers/theme-fixture";
import { setLanguage } from "../shared/i18n";
register(new URL("./rn-hooks.mjs", import.meta.url));
const { KanbanBoard } = await import("../client/board");
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const wait = (ms: number) => act(async () => { await new Promise(r => setTimeout(r, ms)); });
const unavailable = () => new Error("Request failed: Plugin is not available: paseo-kanban");
function text(node: unknown): string { if (typeof node === "string") return node; if (!node || typeof node !== "object") return ""; return ((node as { children?: unknown[] }).children ?? []).map(text).join(" "); }
async function mount(failing: string | null) {
  setLanguage("en");
  let outage = failing, revision = "Before update";
  const calls: string[] = [];
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invoke = async (method: string) => {
    calls.push(method);
    if (method === outage) throw unavailable();
    if (method === "kanban.board") return boardSnapshot([boardCard({ title: revision })]);
    if (method === "kanban.panel-prefs") return { ...DEFAULT_PANEL_PREFS, notice: null };
    if (method === "kanban.board-tab") return { tab: "overview" };
    if (method === "kanban.config.read") return { language: "en" };
    throw new Error("unexpected " + method);
  };
  let renderer!: { toJSON(): unknown; unmount(): void };
  await act(async () => { renderer = TestRenderer.create(React.createElement(QueryClientProvider, { client },
    React.createElement(PluginRpcProvider, { invoke, children: React.createElement(KanbanBoard, { theme: DARK_THEME, layout: { compact: true, platform: "web" }, host: { id: "t", label: "T" }, refresh: { boardMs: 60_000, decisionsMs: 60_000 } }) }))) as unknown as typeof renderer;
  });
  return { client, calls, renderer, body: () => text(renderer.toJSON()), recover: () => { outage = null; revision = "After update"; }, fail: (method: string) => { outage = method; }, close: async () => { outage = null; await wait(2200); await act(async () => renderer.unmount()); client.clear(); } };
}
for (const method of ["kanban.board", "kanban.panel-prefs", "kanban.board-tab"]) {
  it(`retries ${method} during a plugin update, shows a gentle hint, then recovers`, async () => {
    const m = await mount(method);
    try {
      await wait(30);
      assert.match(m.body(), /Plugin is updating/);
      assert.doesNotMatch(m.body(), /Plugin is not available|Request failed/);
      m.recover();
      await wait(1200);
      assert.match(m.body(), method === "kanban.board" ? /After update/ : /Before update/);
      assert.equal(m.client.getQueryState(["kanban", method === "kanban.board" ? "board" : method === "kanban.panel-prefs" ? "prefs" : "board-tab", ...(method === "kanban.board" ? [""] : [])])?.status, "success");
      assert.doesNotMatch(m.body(), /Plugin is updating/);
      assert.ok(m.calls.filter(x => x === method).length >= 2);
    } finally { await m.close(); }
  });
}
it("keeps mounted board data throughout a failing refetch", async () => {
  const m = await mount(null);
  try {
    await wait(30); assert.match(m.body(), /Before update/);
    m.fail("kanban.board");
    void m.client.invalidateQueries({ queryKey: ["kanban", "board"] });
    await wait(30);
    assert.match(m.body(), /Before update/);
    assert.match(m.body(), /Plugin is updating/);
    assert.doesNotMatch(m.body(), /Plugin is not available|Request failed/);
    m.recover(); await wait(1200);
    assert.match(m.body(), /After update/);
    assert.doesNotMatch(m.body(), /Before update|Plugin is updating/);
  } finally { await m.close(); }
});
it("does not let React Query restart an exhausted RPC retry window", async () => {
  const { useQuery } = await import("../client/query");
  const { PluginUpdateError } = await import("../client/rpc-policy");
  let calls = 0;
  const client = new QueryClient({ defaultOptions: { queries: { retry: true, retryDelay: 0 } } });
  function Probe() { useQuery({ queryKey: ["exhausted"], queryFn: async () => { calls++; throw new PluginUpdateError(true, unavailable()); } }); return null; }
  let renderer!: { unmount(): void };
  try {
    await act(async () => { renderer = TestRenderer.create(React.createElement(QueryClientProvider, { client }, React.createElement(Probe))) as unknown as typeof renderer; });
    await wait(50);
    assert.equal(calls, 1); assert.equal(client.getQueryState(["exhausted"])?.status, "error");
  } finally { await act(async () => renderer.unmount()); client.clear(); }
});
it("shows a clear single-call failure for a prefs save during updating", async () => {
  const { useRpc, RpcUpdateNotice } = await import("../client/rpc");
  const { panelPrefsRpc } = await import("../shared/panel-prefs");
  let calls = 0, action: (() => Promise<unknown>) | undefined;
  function Probe() { const save = useRpc(panelPrefsRpc); action = () => save({ fontStep: "lg" }); return React.createElement(RpcUpdateNotice); }
  let renderer!: { toJSON(): unknown; unmount(): void };
  try {
    await act(async () => { renderer = TestRenderer.create(React.createElement(PluginRpcProvider, { invoke: async () => { calls++; throw unavailable(); }, children: React.createElement(Probe) })) as unknown as typeof renderer; });
    await assert.rejects(action!(), /not retried/);
    assert.equal(calls, 1); assert.doesNotMatch(text(renderer.toJSON()), /Plugin is updating/);
  } finally { await act(async () => renderer.unmount()); }
});
