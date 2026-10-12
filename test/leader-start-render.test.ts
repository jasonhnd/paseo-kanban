import assert from "node:assert/strict";
import { register } from "node:module";
import { it } from "node:test";
import React, { act } from "react";
import TestRenderer from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PluginRpcProvider } from "../node_modules/@getpaseo/plugin/dist/client/rpc-context.js";
import { t } from "../shared/i18n";
import { settle } from "./helpers/settle";
import type { Layout, Theme } from "../client/ui";
import type { LeaderStartState } from "../shared/leader-start";

register(new URL("./rn-hooks.mjs", import.meta.url));
const { LeaderStartPanel } = await import("../client/leader-start");
const { useStyles } = await import("../client/ui");
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Node = { props?: Record<string, unknown>; children?: (Node | string | null)[] | null };
function nodes(node: Node | string | null): Node[] {
  return !node || typeof node === "string" ? [] : [node, ...(node.children ?? []).flatMap(nodes)];
}
function text(node: Node | string | null): string {
  return !node ? "" : typeof node === "string" ? node : (node.children ?? []).map(text).join(" ");
}

const state: LeaderStartState = {
  requestId: "00000000-0000-4000-8000-000000000001",
  project: "demo",
  profileId: "demo-profile",
  workspaceId: "demo-main",
  directory: "/tmp/demo",
  language: "en",
  state: "ready",
  agentId: "demo-leader",
  version: "kanban/v1",
  deliveryMode: "systemPrompt",
};

async function mount(initial: LeaderStartState | null = null, profiles = true) {
  const calls: string[] = [];
  const opened: string[] = [];
  let status = initial;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const invoke = async (method: string) => {
    calls.push(method);
    if (method === "kanban.leader-options") {
      return {
        project: "demo",
        version: "kanban/v1",
        cli: "/tmp/demo/bin/paseo-kanban.mjs",
        profiles: profiles ? [{ id: "demo-profile", name: "Demo leader", provider: "codex", model: "demo" }] : [],
        workspaces: [{ id: "demo-main", path: "/tmp/demo" }],
        existingAgentId: null,
        start: status,
      };
    }
    if (method === "kanban.leader-preview") {
      return { requestId: "00000000-0000-4000-8000-000000000001", protocol: "Preview of leader protocol", directory: "/tmp/demo", version: "kanban/v1" };
    }
    if (method === "kanban.leader-start") {
      status = state;
      return status;
    }
    if (method === "kanban.leader-status") {
      status = { ...state, state: "registered" as const };
      return status;
    }
    if (method === "kanban.leader-recover") {
      status = { ...state, deliveryMode: "session-message" as const };
      return status;
    }
    throw new Error(`Unexpected RPC ${method}`);
  };
  function Surface() {
    const s = useStyles({ colors: { surface0: "#fff" } } as unknown as Theme, { compact: false, platform: "web" } as Layout);
    return React.createElement(LeaderStartPanel, { project: "demo", s, onOpen: (id: string) => opened.push(id) });
  }
  const renderer = await act(async () => TestRenderer.create(React.createElement(QueryClientProvider, { client }, React.createElement(PluginRpcProvider, { invoke, children: React.createElement(Surface) })))) as unknown as { toJSON(): Node | null; unmount(): void };
  await settle();
  async function press(label: string) {
    const node = nodes(renderer.toJSON()).find((item) => item.props?.accessibilityLabel === label && typeof item.props?.onPress === "function");
    assert.ok(node, `Missing enabled action ${label}`);
    await act(async () => (node.props!.onPress as () => void)());
    await settle();
  }
  return { renderer, calls, opened, press, done: async () => { await act(async () => renderer.unmount()); client.clear(); } };
}

it("preview can be canceled without creating a session; successful creation stays unregistered until status confirms", async () => {
  const box = await mount();
  try {
    await box.press(t("leaderStart.preview"));
    assert.match(text(box.renderer.toJSON()), /Preview of leader protocol/);
    await box.press(t("leaderStart.cancel"));
    assert.equal(box.calls.includes("kanban.leader-start"), false);
    await box.press(t("leaderStart.preview"));
    await box.press(t("leaderStart.start"));
    assert.match(text(box.renderer.toJSON()), new RegExp(t("leaderStart.ready").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(text(box.renderer.toJSON()).includes(t("leaderStart.registered")), false);
    await box.press(t("leaderStart.open"));
    assert.deepEqual(box.opened, ["demo-leader"]);
    await box.press(t("leaderStart.refresh"));
    assert.equal(text(box.renderer.toJSON()).includes(t("leaderStart.registered")), true);
    assert.equal(box.calls.filter((method) => method === "kanban.leader-start").length, 1);
  } finally {
    await box.done();
  }
});

it("protocol failure offers explicit visible-message recovery and keeps the existing session", async () => {
  const box = await mount({ ...state, state: "protocol-missing", deliveryMode: null });
  try {
    assert.equal(text(box.renderer.toJSON()).includes(t("leaderStart.missing")), true);
    await box.press(t("leaderStart.recover"));
    assert.equal(text(box.renderer.toJSON()).includes(t("leaderStart.messageMode")), true);
    assert.equal(box.calls.includes("kanban.leader-start"), false);
  } finally {
    await box.done();
  }
});

it("missing profiles explain the prerequisite and disable preview", async () => {
  const box = await mount(null, false);
  try {
    assert.equal(text(box.renderer.toJSON()).includes(t("leaderStart.none")), true);
    const button = nodes(box.renderer.toJSON()).find((item) => item.props?.accessibilityLabel === t("leaderStart.preview"));
    assert.equal(button?.props?.accessibilityState && (button.props.accessibilityState as { disabled?: boolean }).disabled, true);
  } finally {
    await box.done();
  }
});
