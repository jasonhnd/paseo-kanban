/// <reference types="node" />
import { DARK_THEME } from "./helpers/theme-fixture";
// The settings screen asks before it writes a candidate, and it keeps the draft when a save is rejected.
import assert from "node:assert/strict";
import { register } from "node:module";
import { describe, it } from "node:test";
import React, { act } from "react";
import TestRenderer from "react-test-renderer";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { PluginRpcProvider } from "../node_modules/@getpaseo/plugin/dist/client/rpc-context.js";
import { t } from "../shared/i18n";
import { newProjectSettings, THRESHOLD_KEYS, type SettingsDocument, type SettingsRead, type SettingsWrite } from "../shared/settings";

register(new URL("./rn-hooks.mjs", import.meta.url));
const { SettingsScreen } = await import("../client/settings/screen");
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Node = { type?: string; props?: Record<string, unknown>; children?: Array<Node | string> | null };
function nodes(node: Node | string | null, match: (node: Node) => boolean): Node[] {
  if (!node || typeof node === "string") return [];
  return [...(match(node) ? [node] : []), ...(node.children ?? []).flatMap((child) => nodes(child, match))];
}
const byId = (renderer: { toJSON(): Node | null }, id: string) => nodes(renderer.toJSON(), (node) => node.props?.testID === id);

function document(): SettingsDocument {
  const thresholds = Object.fromEntries(THRESHOLD_KEYS.map((key) => [key, 10])) as SettingsDocument["thresholds"];
  return {
    language: "system",
    projects: {},
    concurrency: { global: 5, pools: { demo: 1 }, roles: { executor: 1 } },
    staleStopPct: {},
    thresholds,
    families: {},
    bannedProviders: { providers: [], families: [], pools: [], models: [] },
    disabledPools: [],
  };
}

function readBody(extra: Partial<SettingsRead> = {}): SettingsRead {
  return {
    language: "zh-CN",
    revision: "rev-1",
    needsSetup: true,
    problem: null,
    envOverride: false,
    candidatesNote: null,
    candidates: [{ name: "alpha", path: "/tmp/demo/alpha" }],
    leaders: [],
    fallbackLeader: null,
    document: document(),
    ...extra,
  };
}

const theme = DARK_THEME;
const layout = { compact: true, platform: "web" } as PluginSurfaceProps["layout"];

async function mount(invoke: (method: string, input: unknown) => Promise<unknown>) {
  const props = { theme, layout, host: { id: "settings-test", label: "Settings" } } as PluginSurfaceProps;
  const renderer = await act(async () => TestRenderer.create(
    React.createElement(PluginRpcProvider, { invoke, children: React.createElement(SettingsScreen, props) }),
  )) as unknown as { toJSON(): Node | null; unmount(): void };
  const started = Date.now();
  const settled = () => byId(renderer, "settings-setup").length > 0
    || byId(renderer, "settings-problem").length > 0
    || nodes(renderer.toJSON(), (node) => node.props?.accessibilityLabel === t("settings.save")).length > 0;
  while (!settled()) {
    if (Date.now() - started > 5_000) assert.fail("settings screen did not finish loading");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  }
  return renderer;
}

async function press(renderer: { toJSON(): Node | null }, label: string) {
  const button = nodes(renderer.toJSON(), (node) => node.props?.accessibilityLabel === label && typeof node.props?.onPress === "function")[0];
  assert.ok(button, `missing button ${label}`);
  await act(async () => { await (button.props!.onPress as () => void | Promise<void>)(); });
}

describe("settings screen", () => {
  it("shows the first-run guide and writes a candidate only after it is added and saved", async () => {
    const writes: Array<{ revision: string; document: SettingsDocument }> = [];
    const initial = readBody();
    const renderer = await mount(async (method, input) => {
      if (method === "kanban.config.read") return initial;
      if (method === "kanban.config.write") {
        const body = input as { revision: string; document: SettingsDocument };
        writes.push(body);
        const result: SettingsWrite = {
          ...initial,
          needsSetup: false,
          revision: "rev-2",
          document: body.document,
          ok: true,
          conflict: false,
          message: t("settings.saved"),
        };
        return result;
      }
      throw new Error(`unexpected RPC ${method}`);
    });
    assert.equal(byId(renderer, "settings-setup").length, 1);
    assert.equal(writes.length, 0);
    await press(renderer, t("settings.candidates.add", { name: "alpha" }));
    await press(renderer, t("settings.save"));
    assert.equal(writes.length, 1);
    assert.equal(writes[0]!.revision, "rev-1");
    assert.deepEqual(writes[0]!.document.projects.alpha, newProjectSettings("ALP"));
    await act(async () => renderer.unmount());
  });

  it("keeps the draft when the server rejects it, and shows a damaged file without a form", async () => {
    const initial = readBody({ needsSetup: false });
    let reject = true;
    const renderer = await mount(async (method, input) => {
      if (method === "kanban.config.read") return initial;
      if (method === "kanban.config.write") {
        const body = input as { document: SettingsDocument };
        if (reject) {
          const result: SettingsWrite = { ...initial, document: initial.document, ok: false, conflict: false, message: t("settings.error.global") };
          return result;
        }
        return { ...initial, document: body.document, ok: true, conflict: false, message: t("settings.saved") };
      }
      throw new Error(`unexpected RPC ${method}`);
    });
    await press(renderer, t("settings.candidates.add", { name: "alpha" }));
    await press(renderer, t("settings.save"));
    const tree = JSON.stringify(renderer.toJSON());
    assert.ok(tree.includes("alpha"));
    assert.ok(tree.includes(t("settings.error.global")));
    await act(async () => renderer.unmount());

    const broken = await mount(async (method) => {
      if (method === "kanban.config.read") {
        return readBody({ needsSetup: false, problem: t("settings.error.broken"), document: null, revision: "" });
      }
      throw new Error(`unexpected RPC ${method}`);
    });
    assert.equal(byId(broken, "settings-problem").length, 1);
    assert.equal(nodes(broken.toJSON(), (node) => node.props?.accessibilityLabel === t("settings.save")).length, 0);
    await act(async () => broken.unmount());
  });
});
