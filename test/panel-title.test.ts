/// <reference types="node" />
import { zhCN } from "./helpers/locale";
// The workspace panel's title follows the board's language setting: registered in the language known at
// load, registered again when kanban.config.read answers with another one, remembered for the next load.
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { PluginClientContext, PluginWorkspacePanelContribution } from "@getpaseo/plugin/client";
import { getLanguage, setLanguage, t } from "../shared/i18n";
import { adoptPanelLanguage, registerBoardPanel, rememberedLanguage, resetBoardPanel } from "../client/panel-title";

const initial = getLanguage();
const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, value),
};

afterEach(() => {
  resetBoardPanel();
  store.clear();
  setLanguage(initial);
});

function recorder(): { client: PluginClientContext; events: string[] } {
  const events: string[] = [];
  const client = {
    addWorkspacePanel: (input: PluginWorkspacePanelContribution) => {
      events.push(`add ${input.title}`);
      return () => events.push(`remove ${input.title}`);
    },
  } as unknown as PluginClientContext;
  return { client, events };
}

const build = () => ({ id: "board", title: t("client.panel.title"), icon: "SquareKanban", context: "workspace" as const, Component: () => null });

describe("workspace panel title", () => {
  it("re-registers in the setting's language when it differs from the language used at load", () => {
    setLanguage("en");
    const { client, events } = recorder();
    registerBoardPanel(client, build);
    setLanguage("zh-CN");
    adoptPanelLanguage("zh-CN");
    assert.deepEqual(events, ["add Board", "remove Board", ("add " + zhCN("client.panel.title"))]);
    assert.equal(rememberedLanguage(), "zh-CN");
  });

  it("leaves the panel alone when the language is already right", () => {
    setLanguage("zh-CN");
    const { client, events } = recorder();
    registerBoardPanel(client, build);
    adoptPanelLanguage("zh-CN");
    assert.deepEqual(events, [("add " + zhCN("client.panel.title"))]);
  });

  it("remembers nothing until a setting has been read", () => {
    assert.equal(rememberedLanguage(), null);
    adoptPanelLanguage("en");
    assert.equal(rememberedLanguage(), "en");
  });
});
