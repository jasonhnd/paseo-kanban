/// <reference types="node" />
import { zhCN } from "./helpers/locale";
// The entry registers one screen and one standard sidebar item that share the "board" id.
// The host paints that item in the desktop and compact sidebars. There is no custom header component.
import assert from "node:assert/strict";
import { register } from "node:module";
import { describe, it } from "node:test";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { t } from "../shared/i18n";

register(new URL("./rn-hooks.mjs", import.meta.url));
const { default: contribute } = await import("../index.client");
const { Application } = await import("../client/application");

type Registration = { method: string; input: Record<string, unknown> };

function recordingClient(): { client: PluginClientContext; calls: Registration[]; removed: string[] } {
  const calls: Registration[] = [];
  const removed: string[] = [];
  const record = (method: string) => (input: Record<string, unknown>) => {
    calls.push({ method, input });
    return () => { removed.push(method); };
  };
  // The entry must use the standard sidebar item. A custom header registration is not provided.
  const client = {
    addScreen: record("addScreen"),
    addSidebarItem: record("addSidebarItem"),
    addWorkspacePanel: record("addWorkspacePanel"),
    addSettingsScreen: record("addSettingsScreen"),
  } as unknown as PluginClientContext;
  return { client, calls, removed };
}

describe("client entry", () => {
  it("registers one standard sidebar item for the board screen, plus workspace and settings", () => {
    const { client, calls, removed } = recordingClient();
    const cleanup = contribute(client);
    assert.equal(typeof cleanup, "function");
    assert.deepEqual(calls.map((call) => [call.method, call.input.id]), [
      ["addScreen", "board"],
      ["addSidebarItem", "board"],
      ["addWorkspacePanel", "board"],
      ["addSettingsScreen", "config"],
    ]);
    assert.equal(calls[0]!.input.title, "Paseo Kanban");
    assert.equal(calls[0]!.input.Component, Application);
    assert.deepEqual(
      [calls[1]!.input.title, calls[1]!.input.icon, calls[1]!.input.surface],
      ["Paseo Kanban", "SquareKanban", "board"],
    );
    assert.equal("Component" in calls[1]!.input, false);
    assert.deepEqual(
      [calls[2]!.input.title, calls[2]!.input.icon, calls[2]!.input.context],
      [zhCN("client.panel.title"), "SquareKanban", "workspace"],
    );
    assert.equal(calls[3]!.input.title, t("settings.screen.title"));
    assert.equal(calls[3]!.input.icon, "Settings");
    cleanup();
    assert.deepEqual(removed, ["addWorkspacePanel", "addSidebarItem", "addScreen", "addSettingsScreen"]);
  });
});
