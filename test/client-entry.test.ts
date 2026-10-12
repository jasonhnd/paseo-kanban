/// <reference types="node" />
import { zhCN } from "./helpers/locale";
// index.client.tsx registers through the 0.11 screen API: one screen and one sidebar header item that
// share the "board" id (so old saved links still open the board), plus the workspace panel.
import assert from "node:assert/strict";
import { register } from "node:module";
import { describe, it } from "node:test";
import React, { act } from "react";
import TestRenderer from "react-test-renderer";
import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { t } from "../shared/i18n";

register(new URL("./rn-hooks.mjs", import.meta.url));
const { default: contribute } = await import("../index.client");
const { Application } = await import("../client/application");

type Registration = { method: string; input: Record<string, unknown> };

function recordingClient(): { client: PluginClientContext; calls: Registration[] } {
  const calls: Registration[] = [];
  const record = (method: string) => (input: Record<string, unknown>) => {
    calls.push({ method, input });
    return () => {};
  };
  // Only the registrations the entry should use; a deprecated call would throw "is not a function".
  const client = {
    addScreen: record("addScreen"),
    addSidebarHeaderItem: record("addSidebarHeaderItem"),
    addWorkspacePanel: record("addWorkspacePanel"),
    addSettingsScreen: record("addSettingsScreen"),
  } as unknown as PluginClientContext;
  return { client, calls };
}

type RowProps = { icon: string; active: boolean; onPress(): void };

function sidebarRow(props: Partial<PluginSidebarItemProps>, Component: React.ComponentType<PluginSidebarItemProps>): RowProps {
  let rendered: ReturnType<typeof TestRenderer.create> | undefined;
  act(() => {
    rendered = TestRenderer.create(React.createElement(Component, props as PluginSidebarItemProps));
  });
  const row = rendered!.toJSON() as { type: string; props: Record<string, unknown> } | null;
  assert.equal(row?.type, "SidebarRow");
  return row!.props as unknown as RowProps;
}

describe("client entry", () => {
  it("registers the board screen, its sidebar item and the workspace panel, and returns cleanup", () => {
    const { client, calls } = recordingClient();
    const cleanup = contribute(client);
    assert.equal(typeof cleanup, "function");
    assert.deepEqual(calls.map((call) => [call.method, call.input.id]), [
      ["addScreen", "board"],
      ["addSidebarHeaderItem", "board"],
      ["addWorkspacePanel", "board"],
      ["addSettingsScreen", "config"],
    ]);
    assert.equal(calls[3]!.input.title, t("settings.screen.title"));
    assert.equal(calls[3]!.input.icon, "Settings");
    assert.equal(calls[0]!.input.title, "Paseo Kanban");
    assert.equal(calls[0]!.input.Component, Application);
    assert.equal(calls[1]!.input.title, "Paseo Kanban");
    assert.deepEqual([calls[2]!.input.title, calls[2]!.input.icon, calls[2]!.input.context], [zhCN("client.panel.title"), "SquareKanban", "workspace"]);
  });

  it("the sidebar row opens the board screen and lights up while it is open", () => {
    const { client, calls } = recordingClient();
    contribute(client);
    const Item = calls[1]!.input.Component as React.ComponentType<PluginSidebarItemProps>;
    const opened: unknown[] = [];
    const idle = sidebarRow({ currentScreen: null, openScreen: (input) => opened.push(input) }, Item);
    assert.equal(idle.icon, "SquareKanban");
    assert.equal(idle.active, false);
    act(() => idle.onPress());
    assert.deepEqual(opened, [{ screenId: "board" }]);
    const open = sidebarRow({ currentScreen: { screenId: "board", params: {} }, openScreen: () => {} }, Item);
    assert.equal(open.active, true);
  });
});
