/// <reference types="node" />
import { zhCN } from "./helpers/locale";
// The workspace panel's title follows the board's language setting: registered in the language known at
// load, registered again when kanban.config.read answers with another one, remembered for the next load.
import assert from "node:assert/strict";
import { register } from "node:module";
import { afterEach, describe, it } from "node:test";
import type { PluginClientContext, PluginWorkspacePanelContribution } from "@getpaseo/plugin/client";
import { getLanguage, setLanguage, t } from "../shared/i18n";
register(new URL("./rn-hooks.mjs", import.meta.url));
const { adoptPanelLanguage, registerBoardPanel, rememberedLanguage, resetBoardPanel } = await import("../client/panel-title");
const { Platform } = (await import("react-native")) as unknown as { Platform: { OS: string } };

const initial = getLanguage();
const store = new Map<string, string>();
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const storage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, value),
};
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });

afterEach(() => {
  resetBoardPanel();
  store.clear();
  setLanguage(initial);
  Platform.OS = "web";
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
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

  it("validates cached languages and keeps the original key for both languages", () => {
    store.set("paseo-kanban.language", "invalid");
    assert.equal(rememberedLanguage(), null);
    for (const language of ["en", "zh-CN"] as const) {
      adoptPanelLanguage(language);
      assert.equal(store.get("paseo-kanban.language"), language);
      assert.equal(rememberedLanguage(), language);
    }
  });

  it("uses the resolved native language and cleans up without accessing browser storage", () => {
    let reads = 0;
    Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { reads++; throw new Error("native getter"); } });
    Platform.OS = "ios";
    assert.equal(rememberedLanguage(), null);
    const { client, events } = recorder();
    setLanguage("en"); registerBoardPanel(client, build);
    setLanguage("zh-CN"); adoptPanelLanguage("zh-CN");
    registerBoardPanel(client, build);
    resetBoardPanel(); resetBoardPanel();
    assert.equal(reads, 0);
    assert.deepEqual(events, ["add Board", "remove Board", "add " + zhCN("client.panel.title"),
      "remove " + zhCN("client.panel.title"), "add " + zhCN("client.panel.title"), "remove " + zhCN("client.panel.title")]);
  });

  it("still re-registers and unloads when web storage operations throw", () => {
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
      getItem() { throw new Error("blocked read"); }, setItem() { throw new Error("full storage"); },
    } });
    assert.equal(rememberedLanguage(), null);
    const { client, events } = recorder();
    setLanguage("en"); registerBoardPanel(client, build);
    setLanguage("zh-CN"); adoptPanelLanguage("zh-CN"); resetBoardPanel();
    assert.deepEqual(events, ["add Board", "remove Board", "add " + zhCN("client.panel.title"), "remove " + zhCN("client.panel.title")]);
  });
});

import { after } from "node:test";
after(() => {
  if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
  else Reflect.deleteProperty(globalThis, "localStorage");
});
