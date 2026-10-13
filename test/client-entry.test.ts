/// <reference types="node" />
import { zhCN } from "./helpers/locale";
// One host sidebar-kit row and both entry actions reuse the existing board screen.
import assert from "node:assert/strict";
import { register } from "node:module";
import { describe, it } from "node:test";
import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { getLanguage, setLanguage, t } from "../shared/i18n";

register(new URL("./rn-hooks.mjs", import.meta.url));
const { default: contribute } = await import("../index.client");
const { adoptPanelLanguage } = await import("../client/panel-title");
const { Application } = await import("../client/application");

type Registration = { method: string; input: Record<string, unknown> };

function recordingClient(): { client: PluginClientContext; calls: Registration[]; removed: string[] } {
  const calls: Registration[] = [];
  const removed: string[] = [];
  const record = (method: string) => (input: Record<string, unknown>) => {
    calls.push({ method, input });
    return () => { removed.push(method); };
  };
  // Omit the deprecated API: calling it must fail this test.
  const client = {
    addScreen: record("addScreen"),
    addSidebarHeaderItem: record("addSidebarHeaderItem"),
    addCommandCenterItem: record("addCommandCenterItem"),
    addWorkspacePanel: record("addWorkspacePanel"),
    addSettingsScreen: record("addSettingsScreen"),
  } as unknown as PluginClientContext;
  return { client, calls, removed };
}

describe("client entry", () => {
  it("registers one sidebar-kit item and one global command for the existing board screen", () => {
    const { client, calls, removed } = recordingClient();
    const cleanup = contribute(client);
    assert.equal(typeof cleanup, "function");
    assert.deepEqual(calls.map((call) => [call.method, call.input.id]), [
      ["addScreen", "board"],
      ["addSidebarHeaderItem", "board"],
      ["addWorkspacePanel", "board"],
      ["addCommandCenterItem", "open-board"],
      ["addSettingsScreen", "config"],
    ]);
    assert.equal(calls[0]!.input.title, "Paseo Kanban");
    assert.equal(calls[0]!.input.Component, Application);
    assert.deepEqual(
      [calls[1]!.input.title, typeof calls[1]!.input.Component],
      ["Paseo Kanban", "function"],
    );
    assert.equal("surface" in calls[1]!.input, false);
    assert.deepEqual(
      [calls[2]!.input.title, calls[2]!.input.icon, calls[2]!.input.context],
      [zhCN("client.panel.title"), "SquareKanban", "workspace"],
    );
    assert.equal(calls[4]!.input.title, t("settings.screen.title"));
    assert.equal(calls[4]!.input.icon, "Settings");
    assert.equal(calls[3]!.input.context, "global");
    const opened: unknown[] = [];
    (calls[3]!.input.onSelect as (ctx: object) => void)({ openScreen: (input: unknown) => opened.push(input) });
    assert.deepEqual(opened, [{ screenId: "board" }]);
    cleanup();
    assert.deepEqual(removed, ["addWorkspacePanel", "addCommandCenterItem", "addSidebarHeaderItem", "addScreen", "addSettingsScreen"]);
  });
  it("uses the host row for every layout and host, with active state and the same screen action", () => {
    const { client, calls } = recordingClient();
    const cleanup = contribute(client);
    try {
      const Component = calls[1]!.input.Component as (props: PluginSidebarItemProps) => { props: { icon: string; active: boolean; onPress: () => void } };
      for (const compact of [false, true]) for (const host of ["local", "remote"]) for (const screen of [null, "board", "other"]) {
        const opened: unknown[] = [];
        const row = Component({ host: { id: host, label: host }, layout: { compact, platform: "web" }, currentScreen: screen ? { screenId: screen, params: {} } : null, openScreen: (input: unknown) => opened.push(input) } as unknown as PluginSidebarItemProps);
        assert.equal(row.props.icon, "SquareKanban");
        assert.equal(row.props.active, screen === "board");
        row.props.onPress();
        assert.deepEqual(opened, [{ screenId: "board" }]);
      }
    } finally { cleanup(); }
  });

  it("updates the command title with the panel language without leaving duplicate actions", () => {
    const original = getLanguage();
    const { client, calls, removed } = recordingClient();
    setLanguage("en");
    const cleanup = contribute(client);
    try {
      assert.equal(calls.find(call => call.method === "addCommandCenterItem")!.input.title, "Open Project Board");
      setLanguage("zh-CN"); adoptPanelLanguage("zh-CN");
      const commands = calls.filter(call => call.method === "addCommandCenterItem");
      assert.equal(commands.length, 2);
      assert.equal(commands[1]!.input.title, zhCN("cardDrawer.runs.open") + zhCN("board.intake.projectPlaceholder") + zhCN("client.panel.title"));
      assert.equal(removed.filter(method => method === "addCommandCenterItem").length, 1);
      adoptPanelLanguage("zh-CN");
      assert.equal(calls.filter(call => call.method === "addCommandCenterItem").length, 2);
    } finally { cleanup(); setLanguage(original); }
    assert.equal(removed.filter(method => method === "addCommandCenterItem").length, 2);
  });
});
